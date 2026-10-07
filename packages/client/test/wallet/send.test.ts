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
    probeBitcoinTaxi,
    type ArkadeContext,
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

const TAXI = "https://taxi.example";
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
        virtualStatus: { state: "preconfirmed" },
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

const sender = () => {
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
    });
};
let current: ExtendedVirtualCoin;
const wallet = { identity: senderIdentity } as unknown as IWallet;
const send = (mode: "recycle" | "sponsored") =>
    sender().sendDirectTaxi({
        wallet,
        network: "regtest",
        taxi: { url: TAXI },
        receiverAddress,
        ...(mode === "sponsored" ? { assetId: ASSET, amount: 200_000_000n } : { amount: 50n }),
        mode,
        confirmPayment: async () => true,
    });

beforeEach(() => {
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
    it("probes twice, then quotes, locks up and waits for a sub-dust recycle", async () => {
        const taxi = fakeTaxi({ readyAt: 2_500, lockAfter: 1_500 });
        vi.stubGlobal("fetch", taxi.fetch);
        current = coin(1_000);
        const probe = { ...ctx, fetch: boundedFetch, pageProtocol: "https:" };
        for (const amount of [40n, 50n])
            expect((await probeBitcoinTaxi({ url: TAXI }, probe, receiverAddress, amount)).ok).toBe(
                true,
            );
        await expect(drive(send("recycle"))).resolves.toMatch(/^[0-9a-f]{64}$/);
        expect(taxi.count()).toEqual({
            "GET /v1/info": 6,
            "POST /v1/transfers": 3,
            "POST /v1/transfers/tr_01/lockup": 1,
            "GET /v1/transfers/tr_01": 3,
        });
        expect(taxi.times("POST /v1/transfers")).toEqual([0, 1_000, 3_000]);
        expect(taxi.times("GET /v1/transfers/tr_01")).toEqual([3_000, 4_000, 5_000]);
        expect(taxi.lockedAt()).toBe(4_500);
    });

    it("quotes, locks up and waits for a sponsored asset send", async () => {
        const taxi = fakeTaxi({ readyAt: 2_500, lockAfter: 1_500 });
        vi.stubGlobal("fetch", taxi.fetch);
        current = coin(700, [{ assetId: ASSET, amount: 200_000_000n + FARE_UNITS }]);
        await expect(drive(send("sponsored"))).resolves.toMatch(/^[0-9a-f]{64}$/);
        expect(taxi.count()).toEqual({
            "GET /v1/info": 4,
            "POST /v1/sponsored-transfers": 3,
            "POST /v1/sponsored-transfers/tr_01/lockup": 1,
            "GET /v1/sponsored-transfers/tr_01": 3,
        });
        expect(taxi.times("POST /v1/sponsored-transfers")).toEqual([0, 1_000, 3_000]);
        expect(taxi.times("GET /v1/sponsored-transfers/tr_01")).toEqual([3_000, 4_000, 5_000]);
    });
});
