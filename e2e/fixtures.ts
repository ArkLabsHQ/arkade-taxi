import { appendFileSync, readFileSync } from "node:fs";
import { expect } from "vitest";
import {
    ArkAddress,
    RestArkProvider,
    RestEmulatorProvider,
    RestIndexerProvider,
    Transaction,
    asset,
    assertValidServerUnrollScript,
    defaultCheckpointExitDelayPolicy,
    networks,
    scriptFromTapLeafScript,
    type ExtendedVirtualCoin,
    type SingleKey,
    type Wallet,
} from "@arkade-os/sdk";
import { TaxiClient, verifyQuote, type VerifyQuoteArgs } from "@arkade-taxi/client";
import { hexToBytes, type FundingInputValue } from "@arkade-taxi/protocol";
import { base64, hex } from "@scure/base";
import { createActorWallets, disposeActorWallets, expiryOf } from "../scripts/e2e-wallets.mjs";
import { routeProviderFetch } from "../scripts/lib/harness.mjs";
import { preEffectRequest, submitWithReadiness } from "./admission.js";
import { assertScenarioBoundary, ownCleanup, unwindAll } from "../scripts/lib/scenario-cleanup.mjs";

export async function control(action: string, rule?: unknown) {
    const response = await fetch(required("TAXI_E2E_CONTROL_URL"), {
        method: "POST",
        body: JSON.stringify({ action, rule }),
    });
    const body = await response.json();
    if (!response.ok) throw new Error(`harness ${action}: ${JSON.stringify(body)}`);
    return body;
}

export const health = async () =>
    fetch(`${required("TAXI_E2E_BASE_URL")}/health`).then((r) => r.json());

export async function ready() {
    return poll(
        "production readiness",
        async () => {
            try {
                const response = await fetch(`${required("TAXI_E2E_BASE_URL")}/ready`);
                return { status: response.status, body: await response.json() };
            } catch {
                return { status: 0, body: null };
            }
        },
        (value) => value.status === 200 && value.body.blockers.length === 0,
        120_000,
    );
}

export async function boundary(label: string) {
    const snapshot = {
        label,
        project: required("TAXI_E2E_PROJECT"),
        at: Date.now(),
        health: await health(),
    };
    appendFileSync("e2e-artifacts/boundary-diagnostics.jsonl", `${JSON.stringify(snapshot)}\n`);
    return snapshot.health;
}

export const required = (name: string): string => {
    const value = process.env[name];
    if (!value) throw new Error(`${name} is required by the isolated stack harness`);
    return value;
};

export async function poll<T>(
    label: string,
    read: () => Promise<T>,
    ready: (value: T) => boolean,
    timeout = 90_000,
): Promise<T> {
    const until = Date.now() + timeout;
    let latest: T | undefined;
    do {
        latest = await read();
        if (ready(latest)) return latest;
        await new Promise((resolve) => setTimeout(resolve, 100));
    } while (Date.now() < until);
    throw new Error(
        `${label} timed out: ${JSON.stringify(latest, (_, value) => (typeof value === "bigint" ? value.toString() : value))}`,
    );
}

export const admin = async (path: string, patch?: unknown) => {
    const response = await fetch(`${required("TAXI_E2E_BASE_URL")}/admin/api/${path}`, {
        ...(patch === undefined ? {} : { method: "PATCH", body: JSON.stringify(patch) }),
        headers: { "content-type": "application/json", "x-taxi-operator": "task13-e2e" },
    });
    const body = await response.json();
    if (!response.ok)
        throw new Error(`admin ${path}: HTTP ${response.status} ${JSON.stringify(body)}`);
    return body;
};

export const holdings = (coin: ExtendedVirtualCoin): Uint8Array | undefined => {
    const groups = [...(coin.assets ?? [])]
        .sort((a, b) => a.assetId.localeCompare(b.assetId))
        .map(({ assetId, amount }) =>
            asset.AssetGroup.create(
                asset.AssetId.fromString(assetId),
                null,
                [],
                [asset.AssetOutput.create(coin.vout, amount)],
                [],
            ),
        );
    return groups.length ? asset.Packet.create(groups).serialize() : undefined;
};

export const fundingOf = (coin: ExtendedVirtualCoin): FundingInputValue => {
    const expiry = expiryOf(coin);
    if (expiry.kind !== "time" && expiry.kind !== "height")
        throw new Error("unsupported expiry domain");
    const assetPacket = holdings(coin);
    return {
        txid: coin.txid,
        vout: coin.vout,
        value: BigInt(coin.value),
        tapTree: coin.tapTree,
        spendLeaf: scriptFromTapLeafScript(coin.forfeitTapLeafScript),
        expiry: { kind: expiry.kind, value: BigInt(expiry.value) },
        ...(assetPacket ? { assetPacket } : {}),
    };
};

export const walletBalance = async (actor: any, assetId: string) => {
    const coins = await actor.wallet.getSpendableVtxos({ withRecoverable: false });
    return {
        sats: coins.reduce(
            (sum: bigint, coin: ExtendedVirtualCoin) => sum + BigInt(coin.value),
            0n,
        ),
        units: coins.reduce(
            (sum: bigint, coin: ExtendedVirtualCoin) =>
                sum +
                (coin.assets ?? [])
                    .filter((item) => item.assetId === assetId)
                    .reduce((n, item) => n + item.amount, 0n),
            0n,
        ),
    };
};

export async function openLive() {
    assertScenarioBoundary((await admin("advances")).advances);
    const fixture = JSON.parse(readFileSync(required("TAXI_E2E_FIXTURE_FILE"), "utf8"));
    const secrets = JSON.parse(readFileSync(required("TAXI_E2E_SECRET_FILE"), "utf8"));
    const arkdUrl = required("TAXI_E2E_ARKD_URL");
    const emulatorUrl = required("TAXI_E2E_EMULATOR_URL");
    const actors = (await createActorWallets(secrets, {
        arkdUrl,
        esploraUrl: required("ARKADE_ESPLORA_URL"),
    })) as Record<string, { identity: SingleKey; wallet: Wallet }>;
    const client = new TaxiClient({ baseUrl: required("TAXI_E2E_BASE_URL") });
    const [info, arkInfo, emulatorInfo] = await Promise.all([
        client.info(),
        new RestArkProvider(arkdUrl).getInfo(),
        new RestEmulatorProvider(emulatorUrl).getInfo(),
    ]);
    const xOnly = (key: string) =>
        key.length === 66 ? key.slice(2).toLowerCase() : key.toLowerCase();
    expect(xOnly(arkInfo.signerPubkey)).toBe(info.serverKey);
    expect(xOnly(emulatorInfo.signerPubkey)).toBe(info.emulatorKey);
    const network = networks[arkInfo.network as keyof typeof networks];
    const unroll = assertValidServerUnrollScript(arkInfo.checkpointTapscript, {
        ...defaultCheckpointExitDelayPolicy(network),
        advertisedForfeitPubkey: hex.decode(xOnly(arkInfo.forfeitPubkey)),
    });
    const sdkAssetId = asset.AssetId.fromString(fixture.asset.assetId);
    const assetId = {
        txid: Uint8Array.from(sdkAssetId.txid).reverse(),
        groupIndex: sdkAssetId.groupIndex,
    };
    const originalFetch = globalThis.fetch;
    const owned = new Map<string, { offered?: any; locked?: any }>();
    const live = {
        fixture,
        actors,
        client,
        info,
        arkInfo,
        assetId,
        unroll,
        owned,
        indexer: new RestIndexerProvider(arkdUrl),
        config: {
            arkdUrl: info.arkdUrl,
            emulatorUrl: info.emulatorUrl,
            network: arkInfo.network,
            serverUnrollScript: hex.encode(unroll.script),
        },
        close: ownCleanup(async () => {
            try {
                await control("reset");
                await unwindAll(
                    owned,
                    async ([id, item]: [string, { offered?: any; locked?: any }]) => {
                        let state = await client.status(id);
                        if (state.state === "quoted") {
                            const row = (await admin("advances")).advances.find(
                                (value: any) => value.id === id,
                            );
                            state = await poll(
                                `owned quote ${id} expires`,
                                () => client.status(id),
                                (value) => value.state !== "quoted",
                                Math.max(90_000, row.expiresAt * 1000 - Date.now() + 10_000),
                            );
                        }
                        if (state.state === "locking") {
                            state = await poll(
                                `owned submission ${id} reconciles`,
                                () => client.status(id),
                                (value) => value.state !== "locking",
                            );
                        }
                        if (state.state === "locked" && item.offered) {
                            const tip = await actors.sender.wallet.onchainProvider.getChainTip();
                            if (BigInt(tip.time) >= BigInt(item.offered.quote.params.locktime)) {
                                await poll(
                                    `owned eligible recovery ${id}`,
                                    () => client.status(id),
                                    (value) => value.state === "recovered",
                                    120_000,
                                );
                                return;
                            }
                            const transfer =
                                item.locked?.transfer ??
                                (await client.verifyTransfer(
                                    item.offered.verified,
                                    { txid: state.outpoint!.txid, outpoint: state.outpoint! },
                                    {
                                        arkdUrl: info.arkdUrl,
                                        emulatorUrl: info.emulatorUrl,
                                        network: arkInfo.network,
                                        serverUnrollScript: hex.encode(unroll.script),
                                    },
                                ));
                            const txid = await client.refund(transfer, actors.sender.identity);
                            const final = await poll(
                                `owned refund ${id}`,
                                () => client.status(id),
                                (value) => value.state === "refunded",
                            );
                            expect(final.spentTxid).toBe(txid);
                        } else if (state.state === "recovering") {
                            await poll(
                                `owned recovery ${id} completes`,
                                () => client.status(id),
                                (value) => value.state === "recovered",
                            );
                        }
                    },
                );
                const rows = (await admin("advances")).advances.filter((item: any) =>
                    owned.has(item.id),
                );
                expect(
                    rows.filter((item: any) =>
                        ["quoted", "locking", "locked", "recovering"].includes(item.state),
                    ),
                ).toEqual([]);
            } finally {
                try {
                    await disposeActorWallets(actors);
                } finally {
                    globalThis.fetch = originalFetch;
                }
            }
        }),
    };
    await admin("policy", {
        paused: false,
        locktimeMarginSeconds: 86400,
        maxOutstandingSats: "10000000",
        maxConcurrentAdvances: 20,
        assetRules: [null, { txid: hex.encode(assetId.txid), groupIndex: assetId.groupIndex }].map(
            (id) => ({
                assetId: id,
                enabled: true,
                fares: [
                    {
                        id: "sats",
                        currency: { kind: "sats" },
                        pricing: { kind: "flat", units: "1" },
                    },
                ],
                claim: "either",
                maxTopupSats: null,
            }),
        ),
    });
    globalThis.fetch = routeProviderFetch(originalFetch, [
        [info.arkdUrl, arkdUrl],
        [info.emulatorUrl, emulatorUrl],
    ]);
    return live;
}
export type Live = Awaited<ReturnType<typeof openLive>>;

export async function sizedSender(live: Live, withAsset = false) {
    const sender = live.actors.sender;
    const txid = await sender.wallet.send({
        address: await sender.wallet.getAddress(),
        amount: 1000,
        ...(withAsset ? { assets: [{ assetId: live.fixture.asset.assetId, amount: 100n }] } : {}),
    });
    return poll(
        "exact 1000-sat sender funding",
        async () => {
            const coins = await sender.wallet.getSpendableVtxos({ withRecoverable: false });
            return coins.filter(
                (coin: ExtendedVirtualCoin) =>
                    coin.txid === txid &&
                    coin.value === 1000 &&
                    (withAsset
                        ? coin.assets?.some(
                              (item) =>
                                  item.assetId === live.fixture.asset.assetId &&
                                  item.amount === 100n,
                          )
                        : !coin.assets?.length),
            );
        },
        (coins) => coins.length === 1,
    ).then((coins) => coins[0] as ExtendedVirtualCoin);
}

export async function quoteFor(
    live: Live,
    receiverName: string,
    coin: ExtendedVirtualCoin,
    withAsset = false,
    omitAssetUnits = false,
) {
    const senderInputs = [fundingOf(coin)];
    const receiver = live.actors[receiverName];
    const destination = ArkAddress.decode(await receiver.wallet.getAddress());
    const receiverKey = destination.vtxoTaprootKey;
    const senderKey = await live.actors.sender.identity.xOnlyPublicKey();
    const request = {
        senderInputs,
        senderKey,
        receiverKey,
        senderSats: 1000n,
        ...(withAsset ? { assetId: live.assetId } : {}),
        ...(withAsset && !omitAssetUnits ? { assetUnits: 100n } : {}),
    };
    const quote = await preEffectRequest(() => live.client.requestQuote(request), {
        readyUrl: `${required("TAXI_E2E_BASE_URL")}/ready`,
        expiresAt: Date.now() / 1000 + 10,
    }).catch(async (error) => {
        await boundary("quote-refusal").catch(() => undefined);
        throw error;
    });
    live.owned.set(quote.transferId, {});
    const args: VerifyQuoteArgs = {
        quote,
        info: live.info,
        expect: {
            receiverKey,
            senderKey,
            ...(withAsset ? { assetId: live.assetId } : {}),
            maxTopupSats: 1n,
            maxFare: { currency: "sats", units: 1n },
            minLocktime: 1n,
        },
        trustedServerKey: hexToBytes(live.info.serverKey, "serverKey"),
        trustedEmulatorKey: hexToBytes(live.info.emulatorKey, "emulatorKey"),
        vtxoMinAmount: BigInt(live.info.vtxoMinAmount),
        hrp: "tark",
        senderInputs,
        senderSats: 1000n,
        trustedServerUnrollScript: live.unroll.script,
        ...(withAsset && !omitAssetUnits ? { assetUnits: 100n } : {}),
    };
    expect(quote.params.dust).toBe("330");
    expect(quote.params.topup).toBe("1");
    expect(quote.fare).toEqual({ currency: "sats", units: "1" });
    const verified = verifyQuote(args);
    const offered = { quote, args, verified, destination: destination.pkScript, request };
    live.owned.get(quote.transferId)!.offered = offered;
    return offered;
}

export async function lock(live: Live, offered: Awaited<ReturnType<typeof quoteFor>>) {
    const result = await submitWithReadiness(
        live.client,
        offered.verified,
        live.actors.sender.identity,
        { readyUrl: `${required("TAXI_E2E_BASE_URL")}/ready` },
    ).catch(async (error) => {
        await boundary("lockup-refusal").catch(() => undefined);
        throw error;
    });
    return observeLock(live, offered, result);
}

export async function observeLock(
    live: Live,
    offered: Awaited<ReturnType<typeof quoteFor>>,
    result?: { txid: string; outpoint: { txid: string; vout: number } },
) {
    const status = await poll(
        "observed locked covenant",
        () => live.client.status(offered.quote.transferId),
        (value) => value.state === "locked",
    );
    const lockup = result ?? { txid: status.outpoint!.txid, outpoint: status.outpoint! };
    expect(status.outpoint).toEqual(lockup.outpoint);
    const transfer = await live.client.verifyTransfer(offered.verified, lockup, live.config);
    const ledger = await admin("status");
    expect(BigInt(ledger.exposure.outstandingSats)).toBeGreaterThanOrEqual(1n);
    const locked = { ...offered, lockup, transfer };
    live.owned.get(offered.quote.transferId)!.locked = locked;
    return locked;
}
export type Locked = Awaited<ReturnType<typeof lock>>;

export async function transaction(live: Live, txid: string) {
    return poll(
        "indexed transaction",
        async () => {
            const response = await live.indexer.getVirtualTxs([txid]);
            return response.txs.map((tx) => Transaction.fromPSBT(base64.decode(tx)));
        },
        (txs) => txs.length === 1 && txs[0].id === txid,
    ).then((txs) => txs[0]);
}

export async function terminal(live: Live, locked: Locked, state: string, txid: string) {
    const status = await poll(
        `observed ${state}`,
        () => live.client.status(locked.quote.transferId),
        (value) => value.state === state,
    );
    expect(status.spentTxid).toBe(txid);
    expect(status.outpoint).toEqual(locked.lockup.outpoint);
    const { vtxos } = await live.indexer.getVtxos({ outpoints: [locked.lockup.outpoint] });
    expect(vtxos).toHaveLength(1);
    expect(vtxos[0].isSpent).toBe(true);
    const tx = await transaction(live, txid);
    const checkpoint = await transaction(live, hex.encode(tx.getInput(0).txid!));
    expect(hex.encode(checkpoint.getInput(0).txid!)).toBe(locked.lockup.outpoint.txid);
    expect(checkpoint.getInput(0).index).toBe(locked.lockup.outpoint.vout);
    const ledger = await admin("advances");
    const row = ledger.advances.find((item: any) => item.id === locked.quote.transferId);
    expect(row.state).toBe(state);
    expect(row.spentTxid).toBe(txid);
    return { tx, checkpoint, row };
}

export const expectReceipt = (tx: Transaction, index: number, sats: bigint, ownerKey: string) => {
    const output = tx.getOutput(index);
    expect(output.amount).toBe(sats);
    expect(hex.encode(output.script!)).toBe(`${sats < 330n ? "6a20" : "5120"}${ownerKey}`);
};
