import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
    ArkAddress,
    Transaction,
    asset,
    type ExtendedVirtualCoin,
    type IWallet,
} from "@arkade-os/sdk";
import { base64, hex } from "@scure/base";
import {
    assetIdToWire,
    fundingInputFromWire,
    type QuoteRequestBody,
    type SponsoredQuoteRequestBody,
} from "@arkade-taxi/protocol";
import { decodeLockupEnvelope } from "../../../app/src/arkade/psbt.js";
import { taxiAssetId } from "../../src/index.js";
import {
    boundedFetch,
    createTaxiSender,
    PendingDirectTaxi,
    probeBitcoinTaxi,
    type ArkadeContext,
    type TaxiSenderDependencies,
} from "../../src/wallet/index.js";
import {
    HRP,
    NOW,
    VTXO_MIN,
    drive,
    emulatorKey,
    info as baseInfo,
    jsonResponse,
    params,
    quote,
    receiverKey,
    senderIdentity,
    senderTree,
    serverKey,
    sponsoredParams,
    sponsoredQuote,
    unroll,
} from "../fixtures.js";

let taxiUrl = "";
let taxis = 0;
let paused = false;
const receiverAddress = new ArkAddress(serverKey, receiverKey, HRP).encode();
const ASSET = asset.AssetId.create("12".repeat(32), 7).toString();
const FARE_UNITS = 1_000_000n;
const ctx: ArkadeContext = {
    serverKey,
    emulatorKey,
    hrp: HRP,
    dust: 330n,
    vtxoMinAmount: VTXO_MIN,
    locktimeDomain: "height",
    clock: async () => 700_000n,
};
const info = () => ({
    ...baseInfo(),
    paused,
    assetRules: [
        {
            assetId: null,
            enabled: true,
            claim: "either",
            maxTopupSats: null,
            fares: [{ id: "free", currency: "sats", pricing: { kind: "flat", units: "0" } }],
        },
        {
            assetId: assetIdToWire(taxiAssetId(ASSET)),
            enabled: true,
            claim: "either",
            maxTopupSats: null,
            fares: [
                {
                    id: "asset",
                    currency: "sameAsset",
                    pricing: { kind: "flat", units: FARE_UNITS.toString() },
                },
            ],
        },
    ],
});
const coin = (value: number, assets: ExtendedVirtualCoin["assets"] = []) =>
    ({
        txid: "aa".repeat(32),
        vout: 2,
        value,
        script: hex.encode(senderTree.pkScript),
        tapTree: senderTree.encode(),
        forfeitTapLeafScript: senderTree.findLeaf(hex.encode(senderTree.scripts[0])),
        intentTapLeafScript: senderTree.findLeaf(hex.encode(senderTree.scripts[0])),
        expiresAtHeight: 900_000,
        createdAt: new Date(NOW * 1000),
        status: { confirmed: false },
        isSpent: false,
        isSwept: false,
        isUnrolled: false,
        isPreconfirmed: true,
        spentBy: "",
        commitmentTxIds: [],
        assets,
    }) as unknown as ExtendedVirtualCoin;

/** A Taxi that refuses quotes until `readyAt` and locks a lockup `lockAfter` ms after it lands. */
const fakeTaxi = ({ readyAt = 0, lockAfter = 0 } = {}) => {
    const start = Date.now();
    const hits: { at: number; route: string }[] = [];
    let lockedAt: number | undefined;
    let outpoint: { txid: string; vout: number } | undefined;
    const refuse = () => jsonResponse(503, { error: "proceeds_output_pending", code: "not_ready" });
    const lockup = (body: string) => {
        const { arkTx } = decodeLockupEnvelope(JSON.parse(body).signedLockupTx);
        const txid = Transaction.fromPSBT(base64.decode(arkTx)).id;
        outpoint = { txid, vout: 0 };
        lockedAt ??= Date.now() - start + lockAfter;
        return jsonResponse(202, { txid, outpoint });
    };
    const status = () => {
        const locked = lockedAt !== undefined && Date.now() - start >= lockedAt;
        return jsonResponse(200, {
            transferId: "tr_01",
            state: locked ? "locked" : "locking",
            updatedAt: NOW,
            ...(locked ? { outpoint } : {}),
        });
    };
    const fetch = async (input: unknown, init: RequestInit = {}) => {
        const route = `${init.method ?? "GET"} ${new URL(String(input)).pathname}`;
        const at = Date.now() - start;
        hits.push({ at, route });
        const body = String(init.body);
        switch (route) {
            case "GET /v1/info":
                return jsonResponse(200, info());
            case "POST /v1/transfers": {
                if (at < readyAt) return refuse();
                const wire = JSON.parse(body) as QuoteRequestBody;
                return jsonResponse(
                    200,
                    quote(
                        {
                            ...params(),
                            paymentSats: BigInt(wire.paymentSats!),
                            claimMode: "recycle",
                        },
                        {
                            senderInputs: wire.senderInputs.map((i) => fundingInputFromWire(i)),
                            fare: { currency: "sats", units: 0n },
                        },
                    ),
                );
            }
            case "POST /v1/sponsored-transfers": {
                if (at < readyAt) return refuse();
                const wire = JSON.parse(body) as SponsoredQuoteRequestBody;
                const assetId = taxiAssetId(ASSET);
                return jsonResponse(
                    200,
                    sponsoredQuote(sponsoredParams(), {
                        senderInputs: wire.senderInputs.map((i) => fundingInputFromWire(i)),
                        assetUnits: BigInt(wire.assetUnits!),
                        assetId,
                        fare: { currency: "asset", assetId, units: FARE_UNITS },
                    }),
                );
            }
            case "POST /v1/transfers/tr_01/lockup":
            case "POST /v1/sponsored-transfers/tr_01/lockup":
                return lockup(body);
            case "GET /v1/transfers/tr_01":
            case "GET /v1/sponsored-transfers/tr_01":
                return status();
        }
        throw new Error(`unexpected ${route}`);
    };
    const count = () =>
        hits.reduce<Record<string, number>>(
            (counts, { route }) => ({ ...counts, [route]: (counts[route] ?? 0) + 1 }),
            {},
        );
    const times = (route: string) => hits.filter((hit) => hit.route === route).map((hit) => hit.at);
    return { fetch, count, times, lockedAt: () => lockedAt };
};

const release = vi.fn();
const reserveInputs = vi.fn(async () => ({ release }));
const sender = (changes: Partial<TaxiSenderDependencies> = {}) => {
    const storage = new Map<string, string>();
    return createTaxiSender({
        storage: {
            getItem: (key) => storage.get(key) ?? null,
            setItem: (key, value) => void storage.set(key, value),
            removeItem: (key) => void storage.delete(key),
        },
        runExclusive: async (_key, run) => run(),
        getContext: async () => ctx,
        serverUnrollScript: unroll.script,
        unreservedCoins: async () => [current],
        reserveInputs,
        ...changes,
    });
};
let current: ExtendedVirtualCoin;
const wallet = { identity: senderIdentity } as unknown as IWallet;
const send = (mode: "recycle" | "sponsored", service = sender()) =>
    service.sendDirectTaxi({
        wallet,
        network: "regtest",
        taxi: { url: taxiUrl },
        receiverAddress,
        ...(mode === "sponsored" ? { assetId: ASSET, amount: 200_000_000n } : { amount: 50n }),
        mode,
        confirmPayment: async () => true,
    });

beforeEach(() => {
    taxiUrl = `https://taxi-${++taxis}.example`;
    paused = false;
    release.mockReset();
    reserveInputs.mockReset().mockResolvedValue({ release });
    vi.useFakeTimers({
        now: NOW * 1000,
        toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"],
    });
});
afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
});

// Quotes are refused until 2.5 s in; the lockup locks 1.5 s after it lands.
describe("sender round trips", () => {
    it("requires a wallet reservation adapter before authorizing a transfer", async () => {
        const taxi = fakeTaxi();
        vi.stubGlobal("fetch", taxi.fetch);
        current = coin(1_000);
        await expect(drive(send("recycle", sender({ reserveInputs: undefined })))).rejects.toThrow(
            "Wallet input reservation is required",
        );
        expect(taxi.count()["POST /v1/transfers/tr_01/lockup"]).toBeUndefined();
    });

    it("releases an unsent input if the signed payment cannot be journaled", async () => {
        const taxi = fakeTaxi();
        vi.stubGlobal("fetch", taxi.fetch);
        current = coin(1_000);
        const service = sender({
            storage: {
                getItem: () => null,
                setItem: () => {
                    throw new Error("journal unavailable");
                },
                removeItem: () => {},
            },
        });
        await expect(drive(send("recycle", service))).rejects.toThrow("journal unavailable");
        expect(release).toHaveBeenCalledWith();
        expect(taxi.count()["POST /v1/transfers/tr_01/lockup"]).toBeUndefined();
    });

    it("refuses signing when shared wallet inputs cannot be reserved", async () => {
        const taxi = fakeTaxi();
        vi.stubGlobal("fetch", taxi.fetch);
        current = coin(1_000);
        reserveInputs.mockRejectedValueOnce(new Error("coin is already being spent"));
        await expect(drive(send("recycle"))).rejects.toThrow("coin is already being spent");
        expect(taxi.count()["POST /v1/transfers/tr_01/lockup"]).toBeUndefined();
        expect(release).not.toHaveBeenCalled();
    });

    it("retains sender inputs when the submission response is lost", async () => {
        const taxi = fakeTaxi();
        vi.stubGlobal("fetch", async (input: unknown, init: RequestInit = {}) => {
            const response = await taxi.fetch(input, init);
            if (String(input).endsWith("/lockup")) throw new Error("reply lost");
            return response;
        });
        current = coin(1_000);
        await expect(drive(send("recycle"))).rejects.toMatchObject({ name: "PendingDirectTaxi" });
        expect(reserveInputs).toHaveBeenCalledOnce();
        expect(release).not.toHaveBeenCalled();
    });

    it.each(["recycle", "sponsored"] as const)(
        "resumes a lost %s reply with the same authorization and idempotent input hold",
        async (mode) => {
            const taxi = fakeTaxi();
            vi.stubGlobal("fetch", async (input: unknown, init: RequestInit = {}) => {
                const response = await taxi.fetch(input, init);
                if (String(input).endsWith("/lockup")) throw new Error("reply lost");
                return response;
            });
            current =
                mode === "sponsored"
                    ? coin(700, [{ assetId: ASSET, amount: 200_000_000n + FARE_UNITS }])
                    : coin(1_000);
            const records = new Map<string, string>();
            const storage = {
                getItem: (key: string) => records.get(key) ?? null,
                setItem: (key: string, value: string) => void records.set(key, value),
                removeItem: (key: string) => void records.delete(key),
            };
            const holds = new Map<string, string[]>();
            const release = vi.fn(async () => void holds.delete("tr_01"));
            let acquisitions = 0;
            const reserve = vi.fn(
                async (
                    _wallet: IWallet,
                    record: { transferId: string },
                    inputs: readonly { txid: string; vout: number }[],
                ) => {
                    const outpoints = inputs.map(({ txid, vout }) => `${txid}:${vout}`);
                    if (holds.has(record.transferId))
                        expect(outpoints).toEqual(holds.get(record.transferId));
                    else {
                        holds.set(record.transferId, outpoints);
                        acquisitions++;
                    }
                    return { release };
                },
            );
            const first = sender({ storage, reserveInputs: reserve });
            const pending = await drive(send(mode, first)).catch((error: unknown) => error);
            expect(pending).toBeInstanceOf(PendingDirectTaxi);
            if (!(pending instanceof PendingDirectTaxi)) throw pending;
            expect(holds.size).toBe(1);
            expect(release).not.toHaveBeenCalled();
            const restored = await sender({ storage, reserveInputs: reserve }).getPendingDirectTaxi(
                wallet,
                "regtest",
            );
            expect(restored?.record).toEqual(pending.record);
            await expect(drive(restored!.resume())).resolves.toBe(pending.record.expectedTxid);
            expect(reserve).toHaveBeenCalledTimes(2);
            expect(acquisitions).toBe(1);
            expect(holds.size).toBe(0);
            expect(release).toHaveBeenCalledExactlyOnceWith(pending.record.expectedTxid);
            expect(records.size).toBe(0);
            const prefix = mode === "sponsored" ? "/v1/sponsored-transfers" : "/v1/transfers";
            expect(taxi.count()[`POST ${prefix}`]).toBe(1);
            expect(taxi.count()[`POST ${prefix}/tr_01/lockup`]).toBe(1);
        },
    );

    it("preserves a pending transfer when recovery has no reservation adapter", async () => {
        const taxi = fakeTaxi();
        vi.stubGlobal("fetch", async (input: unknown, init: RequestInit = {}) => {
            const response = await taxi.fetch(input, init);
            if (String(input).endsWith("/lockup")) throw new Error("reply lost");
            return response;
        });
        current = coin(1_000);
        const records = new Map<string, string>();
        const storage = {
            getItem: (key: string) => records.get(key) ?? null,
            setItem: (key: string, value: string) => void records.set(key, value),
            removeItem: (key: string) => void records.delete(key),
        };
        await expect(drive(send("recycle", sender({ storage })))).rejects.toBeInstanceOf(
            PendingDirectTaxi,
        );
        const stored = [...records];
        const restored = await sender({ storage, reserveInputs: undefined }).getPendingDirectTaxi(
            wallet,
            "regtest",
        );
        expect(restored).toBeInstanceOf(PendingDirectTaxi);
        await expect(drive(restored!.resume())).rejects.toMatchObject({
            name: "PendingDirectTaxi",
            cause: expect.objectContaining({
                message: "Wallet input reservation is required to resume Taxi sends",
            }),
        });
        expect([...records]).toEqual(stored);
        expect(taxi.count()["POST /v1/transfers"]).toBe(1);
        expect(taxi.count()["POST /v1/transfers/tr_01/lockup"]).toBe(1);
        expect(taxi.count()["GET /v1/transfers/tr_01"]).toBeUndefined();
        expect(release).not.toHaveBeenCalled();
        const recovered = await sender({ storage }).getPendingDirectTaxi(wallet, "regtest");
        await expect(drive(recovered!.resume())).resolves.toBe(restored!.record.expectedTxid);
        expect(taxi.count()["POST /v1/transfers"]).toBe(1);
        expect(taxi.count()["POST /v1/transfers/tr_01/lockup"]).toBe(1);
        expect(records.size).toBe(0);
        expect(release).toHaveBeenCalledExactlyOnceWith(restored!.record.expectedTxid);
    });

    it.each([false, true])(
        "returns a confirmed payment when release fails (diagnostic throws: %s)",
        async (diagnosticThrows) => {
            const taxi = fakeTaxi();
            vi.stubGlobal("fetch", taxi.fetch);
            current = coin(1_000);
            const failure = new Error("reservation cleanup unavailable");
            release.mockRejectedValue(failure);
            const onHistoryError = vi.fn(() => {
                if (diagnosticThrows) throw new Error("diagnostic unavailable");
            });
            await expect(drive(send("recycle", sender({ onHistoryError })))).resolves.toMatch(
                /^[0-9a-f]{64}$/,
            );
            expect(onHistoryError).toHaveBeenCalledExactlyOnceWith(failure);
            expect(release).toHaveBeenCalledOnce();
            expect(taxi.count()["POST /v1/transfers/tr_01/lockup"]).toBe(1);
        },
    );

    it("probes twice, then quotes, locks up and waits for a sub-dust recycle", async () => {
        const taxi = fakeTaxi({ readyAt: 2_500, lockAfter: 1_500 });
        vi.stubGlobal("fetch", taxi.fetch);
        current = coin(1_000);
        const probe = { ...ctx, fetch: boundedFetch, pageProtocol: "https:" };
        for (const amount of [40n, 50n])
            expect(
                (await probeBitcoinTaxi({ url: taxiUrl }, probe, receiverAddress, amount)).ok,
            ).toBe(true);
        await expect(drive(send("recycle"))).resolves.toMatch(/^[0-9a-f]{64}$/);
        expect(taxi.count()).toEqual({
            "GET /v1/info": 2,
            "POST /v1/transfers": 6,
            "POST /v1/transfers/tr_01/lockup": 1,
            "GET /v1/transfers/tr_01": 4,
        });
        expect(taxi.times("POST /v1/transfers")).toEqual([0, 500, 1_000, 1_500, 2_000, 3_000]);
        expect(taxi.times("GET /v1/transfers/tr_01")).toEqual([3_000, 3_500, 4_000, 4_500]);
        expect(taxi.lockedAt()).toBe(4_500);
        expect(reserveInputs).toHaveBeenCalledWith(
            wallet,
            expect.objectContaining({ transferId: "tr_01" }),
            [expect.objectContaining({ txid: current.txid, vout: current.vout })],
        );
        expect(release).toHaveBeenCalledWith(expect.stringMatching(/^[0-9a-f]{64}$/));
    });

    it("quotes, locks up and waits for a sponsored asset send", async () => {
        const taxi = fakeTaxi({ readyAt: 2_500, lockAfter: 1_500 });
        vi.stubGlobal("fetch", taxi.fetch);
        current = coin(700, [{ assetId: ASSET, amount: 200_000_000n + FARE_UNITS }]);
        await expect(drive(send("sponsored"))).resolves.toMatch(/^[0-9a-f]{64}$/);
        expect(taxi.count()).toEqual({
            "GET /v1/info": 1,
            "POST /v1/sponsored-transfers": 6,
            "POST /v1/sponsored-transfers/tr_01/lockup": 1,
            "GET /v1/sponsored-transfers/tr_01": 4,
        });
        expect(taxi.times("POST /v1/sponsored-transfers")).toEqual([
            0, 500, 1_000, 1_500, 2_000, 3_000,
        ]);
        expect(taxi.times("GET /v1/sponsored-transfers/tr_01")).toEqual([
            3_000, 3_500, 4_000, 4_500,
        ]);
    });

    it("sends on a fresh /v1/info read after a probe saw the Taxi paused", async () => {
        const taxi = fakeTaxi();
        vi.stubGlobal("fetch", taxi.fetch);
        current = coin(1_000);
        paused = true;
        const probe = { ...ctx, fetch: boundedFetch, pageProtocol: "https:" };
        expect(await probeBitcoinTaxi({ url: taxiUrl }, probe, receiverAddress, 50n)).toEqual({
            ok: false,
            reason: "paused",
        });
        paused = false;
        await expect(drive(send("recycle"))).resolves.toMatch(/^[0-9a-f]{64}$/);
        expect(taxi.count()["GET /v1/info"]).toBe(2);
    });
});
