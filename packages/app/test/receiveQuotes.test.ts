import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ArkAddress } from "@arkade-os/sdk";
import {
    openDatabase,
    PolicyRepository,
    ReceiveQuoteRepository,
    ReservationRepository,
    SwapFillRepository,
    type Database,
} from "@arkade-taxi/db";
import { assetIdToWire, bytesToHex } from "@arkade-taxi/protocol";
import type { FarePricing } from "@arkade-taxi/core";
import {
    createReceiveQuote,
    getReceiveQuote,
    type ReceiveQuoteDeps,
} from "../src/receiveQuotes.js";
import {
    config,
    fundingCoin,
    MemoryAdvances,
    NOW,
    receiverKey,
    runtimeSafety,
    senderKey,
    serverKey,
} from "./fixtures.js";

const ASSET = { txid: new Uint8Array(32).fill(0x12), groupIndex: 7 };
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

describe("getReceiveQuote", () => {
    it("returns saved terms exactly and only changes current state on expiry", async () => {
        const d = deps();
        const created = await createReceiveQuote(d, body());
        clock = created.expiresAt;
        const read = getReceiveQuote(d, created.quoteId);
        expect(read).toEqual({ ...created, state: "expired" });
        expect(read.expiresAt).toBe(created.expiresAt);
    });
});
