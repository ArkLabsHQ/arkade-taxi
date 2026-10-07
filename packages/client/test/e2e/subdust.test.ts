import { execFileSync } from "node:child_process";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { hex } from "@scure/base";
import {
    EsploraProvider,
    InMemoryContractRepository,
    InMemoryWalletRepository,
    ArkAddress,
    REGTEST_EMULATOR_PUBKEY,
    RestIndexerProvider,
    RestArkProvider,
    SingleKey,
    toXOnlySignerHex,
    Wallet,
} from "@arkade-os/sdk";
import {
    arkadeContextOf,
    claimVerified,
    createClaimWatch,
    createTaxiSender,
    planReceiverClaim,
    taxiClient,
    watchReceiverClaims,
    type TaxiActivity,
    type VerifiedClaim,
} from "../../src/wallet/index.js";

const ARK_URL = process.env.ARK_URL ?? "http://localhost:7070";
const TAXI_URL = process.env.TAXI_URL ?? "http://127.0.0.1:7400";
const TAXI_ADMIN_URL = process.env.TAXI_ADMIN_URL ?? "http://127.0.0.1:7401";
const ESPLORA_URL = process.env.ESPLORA_URL ?? "http://127.0.0.1:3000/api";
const arkd = process.env.ARKD_CONTAINER ?? "arkd";
const seedSats = 1_000;
const paymentSats = 50n;

const wallet = () =>
    Wallet.create({
        identity: SingleKey.fromRandomBytes(),
        arkProvider: new RestArkProvider(ARK_URL),
        onchainProvider: new EsploraProvider(ESPLORA_URL, { forcePolling: true }),
        storage: {
            walletRepository: new InMemoryWalletRepository(),
            contractRepository: new InMemoryContractRepository(),
        },
        settlementConfig: false,
    });

const fund = (address: string) => {
    const output = execFileSync(
        "docker",
        [
            "exec",
            arkd,
            "ark",
            "send",
            "--to",
            address,
            "--amount",
            String(seedSats),
            "--password",
            "secret",
        ],
        { encoding: "utf8" },
    );
    if (output.trimStart().startsWith("error:")) throw new Error(output);
};

describe("Taxi exact sub-dust payment on arkade-regtest", () => {
    let sender: Wallet;
    let receiver: Wallet;
    let network: string;
    let context: Awaited<ReturnType<typeof getContext>>;

    const getContext = async () => {
        const info = await sender.arkProvider.getInfo();
        return arkadeContextOf(
            info,
            async () => 0,
            hex.decode(toXOnlySignerHex(REGTEST_EMULATOR_PUBKEY)),
        );
    };

    beforeAll(async () => {
        [sender, receiver] = await Promise.all([wallet(), wallet()]);
        network = (await sender.arkProvider.getInfo()).network;
        context = await getContext();
        fund(await sender.getAddress());
        fund(await receiver.getAddress());
        await Promise.all([
            vi.waitFor(async () => expect(await sender.getSpendableVtxos()).toHaveLength(1), {
                timeout: 60_000,
                interval: 250,
            }),
            vi.waitFor(async () => expect(await receiver.getSpendableVtxos()).toHaveLength(1), {
                timeout: 60_000,
                interval: 250,
            }),
        ]);
    }, 120_000);

    it("retries refused quotes and lockups unchanged, sends 50 sats, and recycles into one spendable coin", async () => {
        const senderCoins = await sender.getSpendableVtxos();
        const receiverCoins = await receiver.getSpendableVtxos();
        expect(senderCoins.map((coin) => coin.value)).toEqual([seedSats]);
        expect(receiverCoins.map((coin) => coin.value)).toEqual([seedSats]);

        let activity: TaxiActivity | undefined;
        const storage = new Map<string, string>();
        const lockups: { url: string; body: string }[] = [];
        const quotes: string[] = [];
        let acceptedQuotes = 0;
        let authorizations = 0;
        const send = createTaxiSender({
            storage: {
                getItem: (key) => storage.get(key) ?? null,
                setItem: (key, value) => void storage.set(key, value),
                removeItem: (key) => void storage.delete(key),
            },
            runExclusive: async <T>(_key: string, run: () => Promise<T>) => run(),
            getContext,
            serverUnrollScript: sender.serverUnrollScript.script,
            unreservedCoins: (target) => target.getSpendableVtxos(),
            client: (url, fetchImpl = fetch) =>
                taxiClient(url, async (input, init) => {
                    const request = new Request(input, init);
                    const path = new URL(request.url).pathname;
                    if (request.method === "POST" && path === "/v1/transfers") {
                        quotes.push(await request.text());
                        if (quotes.length <= 2)
                            return Response.json(
                                { error: "proceeds_output_pending", code: "not_ready" },
                                { status: 503 },
                            );
                        const response = await fetchImpl(input, init);
                        if (response.ok) acceptedQuotes += 1;
                        return response;
                    }
                    if (
                        request.method === "POST" &&
                        /^\/v1\/transfers\/[^/]+\/lockup$/.test(path)
                    ) {
                        lockups.push({ url: request.url, body: await request.text() });
                        if (lockups.length <= 2)
                            return Response.json(
                                { error: "proceeds_output_pending", code: "not_ready" },
                                { status: 503 },
                            );
                    }
                    return fetchImpl(input, init);
                }),
            recordActivity: (record) => {
                activity = record;
            },
        });

        const taxi = taxiClient(TAXI_URL);
        const info = await taxi.info();
        const taxiIndex = new RestIndexerProvider(ARK_URL);
        const funding = await fetch(`${TAXI_ADMIN_URL}/admin/api/funding`).then((response) => {
            if (!response.ok) throw new Error(`Taxi funding endpoint returned ${response.status}`);
            return response.json() as Promise<{ arkAddress: string }>;
        });
        const taxiScript = hex.encode(ArkAddress.decode(funding.arkAddress).pkScript);
        const taxiBalance = async () =>
            (await taxiIndex.getVtxos({ scripts: [taxiScript], spendableOnly: true })).vtxos.reduce(
                (sum, coin) => sum + coin.value,
                0,
            );
        const taxiBalanceBefore = await taxiBalance();
        expect(taxiBalanceBefore).toBeGreaterThan(0);
        let offer: VerifiedClaim | undefined;
        let watchError: unknown;
        const stop = watchReceiverClaims(
            createClaimWatch({
                context,
                network,
                arkdUrl: ARK_URL,
                serverUnrollScript: hex.encode(sender.serverUnrollScript.script),
                taxis: [{ network, url: TAXI_URL, operatorKey: info.operatorKey }],
                receiverAddress: await receiver.getAddress(),
                onOffer: (verified) => {
                    offer = verified;
                },
                onGone: () => {},
                onError: (error) => {
                    watchError = error;
                },
            }),
        );

        try {
            const txid = await send.sendDirectTaxi({
                wallet: sender,
                network,
                taxi: { url: TAXI_URL, operatorKey: info.operatorKey },
                receiverAddress: await receiver.getAddress(),
                amount: paymentSats,
                mode: "recycle",
                confirmPayment: async (terms) => {
                    authorizations += 1;
                    expect(terms.assetAmount).toBe(paymentSats);
                    expect(terms.fareUnits).toBe(0n);
                    expect(terms.carrierSats).toBe(context.dust);
                    return true;
                },
            });
            expect(txid).toBe(activity?.lockupTxid);
            expect(activity?.units).toBe("50");
            expect(quotes.length).toBeGreaterThanOrEqual(3);
            for (const quote of quotes) expect(quote).toBe(quotes[0]);
            expect(acceptedQuotes).toBe(1);
            expect(authorizations).toBe(1);
            expect(lockups.length).toBeGreaterThanOrEqual(3);
            for (const lockup of lockups) expect(lockup).toEqual(lockups[0]);
            expect(lockups[0].url).toBe(`${TAXI_URL}/v1/transfers/${activity!.transferId}/lockup`);
            expect(storage.size).toBe(0);

            await vi.waitFor(
                () => {
                    if (watchError) throw watchError;
                    expect(offer).toBeDefined();
                },
                { timeout: 60_000, interval: 250 },
            );

            const claimPlan = planReceiverClaim(offer!.claim, await receiver.getSpendableVtxos());
            expect(claimPlan.kind).toBe("recycle");
            if (claimPlan.kind !== "recycle") throw new Error("expected a receiver-funded recycle");
            expect(claimPlan.mergedSats).toBe(BigInt(seedSats) + paymentSats);
            const claimTxid = await claimVerified(offer!, claimPlan, receiver.identity);
            expect(claimTxid).toMatch(/^[0-9a-f]{64}$/);

            await vi.waitFor(
                async () => {
                    expect(
                        (await sender.getSpendableVtxos()).reduce(
                            (sum, coin) => sum + coin.value,
                            0,
                        ),
                    ).toBe(seedSats - Number(paymentSats));
                    expect((await receiver.getSpendableVtxos()).map((coin) => coin.value)).toEqual([
                        seedSats + Number(paymentSats),
                    ]);
                    expect(await taxiBalance()).toBe(taxiBalanceBefore);
                    expect((await taxi.status(activity!.transferId)).state).toBe("recycled");
                },
                { timeout: 90_000, interval: 500 },
            );
        } finally {
            stop();
            await Promise.all([sender.dispose(), receiver.dispose()]);
        }
    }, 180_000);
});
