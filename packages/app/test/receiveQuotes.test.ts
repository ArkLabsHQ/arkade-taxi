import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ArkAddress } from "@arkade-os/sdk";
import {
    AdvanceRepository,
    openDatabase,
    PolicyRepository,
    ReceiveQuoteRepository,
    ReservationRepository,
    SwapFillRepository,
    type Database,
} from "@arkade-taxi/db";
import { DustCovenantScript } from "@arkade-taxi/covenant";
import { assetIdToWire, bytesToHex } from "@arkade-taxi/protocol";
import type { FarePricing } from "@arkade-taxi/core";
import {
    createReceiveQuote,
    getReceiveQuote,
    type ReceiveQuoteDeps,
} from "../src/receiveQuotes.js";
import { assetRuleToWire } from "../src/rulesWire.js";
import { selectOperatorFunding } from "../src/arkade/inventory.js";
import {
    advance,
    config,
    fundingCoin,
    MemoryAdvances,
    NOW,
    receiverKey,
    runtimeSafety,
    senderKey,
    serverKey,
} from "./fixtures.js";
import { createBoundJointFill } from "./jointFillFixtures.js";
import type { ServiceError } from "../src/errors.js";

vi.mock("../src/arkade/inventory.js", async (importOriginal) => {
    const actual = await importOriginal<typeof import("../src/arkade/inventory.js")>();
    return { ...actual, selectOperatorFunding: vi.fn(actual.selectOperatorFunding) };
});

const ASSET = { txid: new Uint8Array(32).fill(0x12), groupIndex: 7 };
const TOKEN_ASSET = { txid: new Uint8Array(32).fill(0x77), groupIndex: 3 };
const receiverAddress = new ArkAddress(serverKey, receiverKey, "ark").encode();
const body = (over: Record<string, unknown> = {}) => ({
    receiverAddress,
    makerPublicKey: bytesToHex(senderKey),
    assetId: assetIdToWire(ASSET),
    ...over,
});

let db: Database;
let policy: PolicyRepository;
let quotes: ReceiveQuoteRepository;
let advances: MemoryAdvances;
let clock: number;
let ids: number;

const rule = (fare: FarePricing = { kind: "flat", units: 3n }) => ({
    assetId: ASSET,
    enabled: true,
    claim: "either" as const,
    maxTopupSats: null,
    fares: [{ id: "receive", currency: { kind: "sats" as const }, pricing: fare }],
});

const configure = (over: Record<string, unknown> = {}) =>
    policy.update(
        {
            paused: false,
            maxOutstandingSats: 100_000n,
            maxPerPaymentTopupSats: 1_000n,
            maxConcurrentAdvances: 10,
            locktimeMarginBlocks: 144,
            locktimeMarginSeconds: 86_400,
            quoteTtlSeconds: 60,
            assetRules: [rule()],
            ...over,
        },
        "test",
    );

const deps = (over: Partial<ReceiveQuoteDeps> = {}): ReceiveQuoteDeps => ({
    runtime: {
        assertAdmission: async () => {},
        withAdmission: async (work) => work(() => {}),
        safety: () => runtimeSafety(),
    },
    policy,
    advances,
    reservations: new ReservationRepository(db),
    swapFills: new SwapFillRepository(db),
    receiveQuotes: quotes,
    inventory: {
        getSpendableVtxos: async () => [
            fundingCoin({ expiresAtHeight: 900_000 }),
            fundingCoin({ vout: 1, expiresAtHeight: 900_001 }),
        ],
        getLockedVtxoOutpoints: async () => [],
    },
    config: config({ vtxoMinAmount: 1n }),
    now: () => clock,
    nowMs: () => clock * 1000,
    randomId: () => `receive-${++ids}`,
    ...over,
});

beforeEach(() => {
    db = openDatabase(":memory:");
    policy = new PolicyRepository(db);
    configure();
    quotes = new ReceiveQuoteRepository(db);
    advances = new MemoryAdvances();
    clock = NOW;
    ids = 0;
});
afterEach(() => db.close());

const sameAssetDeps = (pricing: FarePricing = { kind: "flat", units: 9n }) => {
    configure({
        assetRules: [
            { ...rule(), fares: [{ id: "asset", currency: { kind: "sameAsset" }, pricing }] },
        ],
    });
    return deps();
};
const tokenFareDeps = () => {
    configure({
        assetRules: [
            {
                ...rule(),
                fares: [
                    {
                        id: "token",
                        currency: { kind: "token", assetId: TOKEN_ASSET },
                        pricing: { kind: "flat", units: 1n },
                    },
                ],
            },
        ],
    });
    return deps();
};

describe("createReceiveQuote", () => {
    it("issues and reserves an independently reconstructible 329+1 quote", async () => {
        const response = await createReceiveQuote(deps(), body());
        expect(response).toMatchObject({
            quoteId: "receive-1",
            state: "quoted",
            receiverAddress,
            makerPublicKey: bytesToHex(senderKey),
            params: {
                dust: "330",
                topup: "329",
                claimMode: "recycle",
                recoveryRecipient: "receiver",
            },
            fare: { currency: "sats", units: "3" },
            batchExpiry: { kind: "height", value: "900000" },
            inputExpiryFloor: { kind: "height", value: "900000" },
            recoveryLocktime: { kind: "height", value: "899856" },
            createdAt: NOW,
            expiresAt: NOW + 60,
        });
        expect(Object.keys(response).sort()).toEqual(
            [
                "batchExpiry",
                "covenantAddress",
                "createdAt",
                "expiresAt",
                "fare",
                "inputExpiryFloor",
                "makerPublicKey",
                "params",
                "quoteId",
                "receiverAddress",
                "recoveryLocktime",
                "state",
            ].sort(),
        );
        expect(quotes.get("receive-1")?.operatorInputs[0]).toMatchObject({
            txid: "bb".repeat(32),
            value: 20_000n,
            expiry: { kind: "height", value: 900_000n },
        });
        expect(advances.rows.size).toBe(0);
    });

    it("shortens only the input floor and recovery locktime for an older safe wallet ceiling", async () => {
        const response = await createReceiveQuote(
            deps(),
            body({ fundingExpiry: { kind: "height", value: "850000" } }),
        );
        expect(response.batchExpiry).toEqual({ kind: "height", value: "900000" });
        expect(response.inputExpiryFloor).toEqual({ kind: "height", value: "850000" });
        expect(response.recoveryLocktime).toEqual({ kind: "height", value: "849856" });
        expect(quotes.get(response.quoteId)).toMatchObject({
            batchExpiry: { kind: "height", value: 900_000n },
            inputExpiryFloor: { kind: "height", value: 850_000n },
            recoveryLocktime: { kind: "height", value: 849_856n },
        });
    });

    it.each([
        [{ kind: "time", value: String(NOW + 100_000) }, /domain/],
        [{ kind: "height", value: "700143" }, /headroom/],
    ])("refuses an unsafe funding expiry ceiling %#", async (fundingExpiry, error) => {
        await expect(createReceiveQuote(deps(), body({ fundingExpiry }))).rejects.toThrow(error);
        expect(quotes.get("receive-1")).toBeUndefined();
    });

    it("derives a positive split from non-default server limits", async () => {
        const response = await createReceiveQuote(
            deps({ config: config({ dust: 1_000n, vtxoMinAmount: 100n }) }),
            body(),
        );
        expect(response.params).toMatchObject({ dust: "1000", topup: "900" });
    });

    it("rejects an insufficient two-output split before inventory", async () => {
        const inventory = vi.fn(async () => [fundingCoin()]);
        await expect(
            createReceiveQuote(
                deps({
                    config: config({ dust: 10n, vtxoMinAmount: 6n }),
                    inventory: {
                        getSpendableVtxos: inventory,
                        getLockedVtxoOutpoints: async () => [],
                    },
                }),
                body(),
            ),
        ).rejects.toThrow(/split/);
        expect(inventory).not.toHaveBeenCalled();
    });

    it.each([
        [body({ extra: true }), /unexpected/],
        [body({ makerPublicKey: "FF".repeat(32) }), /makerPublicKey/],
        [body({ makerPublicKey: "ff".repeat(32) }), /makerPublicKey/],
        [
            body({ receiverAddress: new ArkAddress(serverKey, receiverKey, "tark").encode() }),
            /network/,
        ],
    ])("rejects malformed identity or fields before inventory %#", async (request, error) => {
        const inventory = vi.fn(async () => [fundingCoin()]);
        await expect(
            createReceiveQuote(
                deps({
                    inventory: {
                        getSpendableVtxos: inventory,
                        getLockedVtxoOutpoints: async () => [],
                    },
                }),
                request,
            ),
        ).rejects.toThrow(error);
        expect(inventory).not.toHaveBeenCalled();
    });

    it.each<[FarePricing, string]>([
        [{ kind: "flat", units: 0n }, "0"],
        [{ kind: "flat", units: 9n }, "9"],
        [{ kind: "proportional", bps: 1_000, minUnits: 0n, maxUnits: null }, "32"],
    ])("accepts sats fare pricing %#", async (pricing, units) => {
        configure({ assetRules: [rule(pricing)] });
        expect((await createReceiveQuote(deps(), body())).fare.units).toBe(units);
    });

    it("rejects a quote whose reserved input would leave subdust combined change", async () => {
        configure({ assetRules: [rule({ kind: "flat", units: 4n })] });
        await expect(
            createReceiveQuote(
                deps({
                    inventory: {
                        getSpendableVtxos: async () => [
                            fundingCoin({ value: 330, expiresAtHeight: 900_000 }),
                            fundingCoin({ vout: 1, expiresAtHeight: 900_000 }),
                        ],
                        getLockedVtxoOutpoints: async () => [],
                    },
                }),
                body(),
            ),
        ).rejects.toThrow(/inventory/);
        expect(quotes.get("receive-1")).toBeUndefined();
    });

    it("reserves a 1000 sat input for a 329 loan and 4 sat combined fare", async () => {
        configure({ assetRules: [rule({ kind: "flat", units: 4n })] });
        const response = await createReceiveQuote(
            deps({
                inventory: {
                    getSpendableVtxos: async () => [
                        fundingCoin({ value: 1_000, expiresAtHeight: 900_000 }),
                        fundingCoin({ vout: 1, expiresAtHeight: 900_000 }),
                    ],
                    getLockedVtxoOutpoints: async () => [],
                },
            }),
            body(),
        );
        expect(response.fare).toEqual({ currency: "sats", units: "4" });
        expect(quotes.get(response.quoteId)?.operatorInputs[0]?.value).toBe(1_000n);
    });

    it("does not add a fare already large enough to make change spendable", async () => {
        configure({ assetRules: [rule({ kind: "flat", units: 400n })] });
        const response = await createReceiveQuote(
            deps({
                inventory: {
                    getSpendableVtxos: async () => [
                        fundingCoin({ value: 330, expiresAtHeight: 900_000 }),
                        fundingCoin({ vout: 1, expiresAtHeight: 900_000 }),
                    ],
                    getLockedVtxoOutpoints: async () => [],
                },
            }),
            body(),
        );
        expect(response.fare.units).toBe("400");
        expect(quotes.get(response.quoteId)?.operatorInputs[0]?.value).toBe(330n);
    });

    it("rejects an asset-denominated fare without substituting zero", async () => {
        configure({
            assetRules: [
                {
                    ...rule(),
                    fares: [
                        {
                            id: "asset",
                            currency: { kind: "sameAsset" },
                            pricing: { kind: "flat", units: 1n },
                        },
                    ],
                },
            ],
        });
        await expect(createReceiveQuote(deps(), body({ fareId: "asset" }))).rejects.toThrow(/sats/);
        expect(quotes.get("receive-1")).toBeUndefined();
    });

    it("rejects policy, safety and intent-lock changes before insertion", async () => {
        let reads = 0;
        const changedPolicy = deps({
            inventory: {
                getSpendableVtxos: async () => {
                    reads++;
                    if (reads === 2) policy.update({ quoteTtlSeconds: 61 }, "test");
                    return [fundingCoin(), fundingCoin({ vout: 1 })];
                },
                getLockedVtxoOutpoints: async () => [],
            },
        });
        await expect(createReceiveQuote(changedPolicy, body())).rejects.toThrow(/policy/);

        let safetyReads = 0;
        const changedSafety = deps({
            runtime: {
                assertAdmission: async () => {},
                withAdmission: async (work) => work(() => {}),
                safety: () =>
                    runtimeSafety(
                        ++safetyReads > 2 ? { chainHeight: 899_900n } : { chainHeight: 700_000n },
                    ),
            },
        });
        await expect(createReceiveQuote(changedSafety, body())).rejects.toThrow();

        let lockReads = 0;
        const changedLocks = deps({
            inventory: {
                getSpendableVtxos: async () => [fundingCoin(), fundingCoin({ vout: 1 })],
                getLockedVtxoOutpoints: async () =>
                    ++lockReads === 1 ? [] : [{ txid: "cc".repeat(32), vout: 0 }],
            },
        });
        await expect(createReceiveQuote(changedLocks, body())).rejects.toThrow(/locks/);
        expect(quotes.get("receive-1")).toBeUndefined();
    });
});

const caught = async (fn: () => Promise<unknown>): Promise<ServiceError> => {
    try {
        await fn();
    } catch (e) {
        return e as ServiceError;
    }
    throw new Error("expected a rejection");
};

describe("createReceiveQuote: payer receiver", () => {
    it("refuses an unknown payer value", async () => {
        await expect(createReceiveQuote(deps(), { ...body(), payer: "nonsense" })).rejects.toThrow(
            /payer must be sender or receiver/,
        );
    });

    it("refuses an unknown fareId with 409, not 500", async () => {
        const error = await caught(() =>
            createReceiveQuote(deps(), { ...body(), payer: "receiver", fareId: "nonsense" }),
        );
        expect(error.code).toBe("fare_unavailable");
        expect(error.status).toBe(409);
    });

    it("fronts the whole dust and prices the fill at zero", async () => {
        configure({ assetRules: [rule({ kind: "flat", units: 5n })] });
        const quote = await createReceiveQuote(deps(), { ...body(), payer: "receiver" });
        expect(quote.params.topup).toBe("330");
        expect(quote.fare).toEqual({ currency: "sats", units: "0" });
        expect(quote.payer).toBe("receiver");
        expect(quote.unclaimedMode).toBe("reclaim");
        expect(quote.receiverFare).toEqual({ currency: "sats", units: "5" });
        expect(quotes.get(quote.quoteId)?.receiverFare).toEqual({ currency: "sats", units: 5n });
    });

    it("omits payer, receiverFare and unclaimedMode for a sender-paid request", async () => {
        const quote = await createReceiveQuote(deps(), body());
        expect(quote.params.topup).toBe("329");
        for (const k of ["payer", "receiverFare", "unclaimedMode"]) expect(k in quote).toBe(false);
    });

    it("emits assetId on a same-asset receiver fare", async () => {
        const quote = await createReceiveQuote(sameAssetDeps(), { ...body(), payer: "receiver" });
        expect(quote.receiverFare).toMatchObject({
            currency: "asset",
            units: "9",
            assetId: expect.any(Object),
        });
        expect(quote.params.receiverFare).toEqual({ currency: "asset", units: "9" });
    });

    it("refuses a proportional same-asset fare, which needs an amount this quote has not got", async () => {
        const d = sameAssetDeps({ kind: "proportional", bps: 100, minUnits: 0n, maxUnits: null });
        const error = await caught(() => createReceiveQuote(d, { ...body(), payer: "receiver" }));
        expect(error.code).toBe("fare_unavailable");
    });

    it("refuses a token fare: the covenant can only charge the delivered asset", async () => {
        const error = await caught(() =>
            createReceiveQuote(tokenFareDeps(), { ...body(), payer: "receiver" }),
        );
        expect(error.code).toBe("fare_unavailable");
    });

    it("reserves the contribution plus a spendable change floor", async () => {
        const selectSpy = vi.mocked(selectOperatorFunding);
        selectSpy.mockClear();
        await createReceiveQuote(deps(), { ...body(), payer: "receiver" });
        expect(selectSpy.mock.calls[0]![0].requiredSats).toBe(660n);
    });

    it("advertises unclaimedMode on every asset rule", () => {
        expect(assetRuleToWire(rule()).unclaimedMode).toBe("reclaim");
    });

    // The one that would catch a dropped column: without it, the re-derived
    // address differs, because the fare is part of the taptree.
    it("re-derives the same covenant address from a persisted receiver-paid advance", () => {
        const cfg = config();
        const built = advance({
            assetId: ASSET,
            claimMode: "recycle",
            recoveryRecipient: "receiver",
            receiverFare: { currency: "asset", units: 9n },
            assetUnits: 20n,
        });
        const scriptOpts = {
            serverKey: cfg.serverPubkey,
            emulatorKey: cfg.emulatorPubkey,
            vtxoMinAmount: cfg.vtxoMinAmount,
        };
        const covenantAddress = new DustCovenantScript({ ...scriptOpts, params: built })
            .address(cfg.addressHrp, cfg.serverPubkey)
            .encode();
        const repo = new AdvanceRepository(db);
        repo.insert({ ...built, covenantAddress });
        const stored = repo.get(built.id)!;
        const rederived = new DustCovenantScript({ ...scriptOpts, params: stored })
            .address(cfg.addressHrp, cfg.serverPubkey)
            .encode();
        expect(rederived).toBe(covenantAddress);
    });
});

describe("getReceiveQuote", () => {
    it("returns saved terms exactly and only changes current state on expiry", async () => {
        const d = deps();
        const created = await createReceiveQuote(d, body());
        clock = created.expiresAt;
        const read = getReceiveQuote(d, created.quoteId);
        expect(read).toEqual({ ...created, state: "expired" });
        expect(read.expiresAt).toBe(created.expiresAt);
    });

    it("exposes the bound fill id once a quote is bound, and omits it before", async () => {
        const d = deps();
        const created = await createReceiveQuote(d, body());
        expect(created.boundFillId).toBeUndefined();
        expect("boundFillId" in getReceiveQuote(d, created.quoteId)).toBe(false);

        const world = await createBoundJointFill();
        try {
            const read = getReceiveQuote(
                { receiveQuotes: world.receiveQuotes, now: () => NOW },
                "receive-1",
            );
            expect(read.state).toBe("bound");
            expect(read.boundFillId).toBe(world.fill.id);
        } finally {
            world.close();
        }
    });
});
