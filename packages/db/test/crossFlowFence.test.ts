import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Advance } from "@arkade-taxi/core";
import {
    AdvanceRepository,
    openDatabase,
    PolicyRepository,
    ProceedsRepository,
    ReceiveQuoteRepository,
    ReservationConflictError,
    ReservationRepository,
    SwapFillRepository,
    SwapFillReservationConflictError,
    type Database,
    type SwapFill,
    type ReceiveQuote,
} from "../src/index.js";

const COIN = { txid: "aa".repeat(32), vout: 0 };
const NOW = 1_757_000_000;
const ASSET = { txid: new Uint8Array(32).fill(0x12), groupIndex: 7 };

const GRAPH = {
    arkTx: "aGVsbG8=",
    checkpoints: ["d29ybGQ="],
    graphId: new Uint8Array(32).fill(0xab),
    inputOwners: ["sponsor"] as (string | null)[],
};

const fill = (over: Partial<SwapFill> = {}): SwapFill => ({
    id: "fill-1",
    operationId: "op-1",
    state: "quoted",
    offerHex: "deadbeef",
    solverInputs: [{ txid: "bb".repeat(32), vout: 1, value: 5000n }],
    solverProceedsScript: new Uint8Array([0x51]),
    solverKeys: ["ab".repeat(32)],
    taxiInputs: [{ ...COIN }],
    contributionSats: 330n,
    sponsorScript: new Uint8Array([0x51]),
    fare: { currency: "sats", units: 10n },
    maxFare: { currency: "sats", units: 50n },
    graph: structuredClone(GRAPH),
    graphId: new Uint8Array(32).fill(0xab),
    submitInvoked: false,
    attempts: 0,
    createdAt: NOW,
    updatedAt: NOW,
    expiresAt: NOW + 60,
    ...over,
});

const quote = (overrides: Partial<Advance> = {}): Advance => {
    const result: Advance = {
        id: "quote-1",
        state: "quoted",
        receiverKey: new Uint8Array(32),
        senderKey: new Uint8Array(32),
        operatorKey: new Uint8Array(32),
        dust: 330n,
        topup: 300n,
        locktime: 100n,
        batchExpiry: { kind: "height", value: 300n },
        operatorInputs: [{ ...COIN }],
        unsignedLockupTx: "unsigned",
        unsignedLockupId: "bb".repeat(32),
        covenantAddress: "tark1qexample",
        fare: { currency: "sats", units: 10n },
        createdAt: 1,
        updatedAt: 1,
        expiresAt: 60,
        ...overrides,
    };
    result.recoveryLocktime ??= { kind: result.batchExpiry.kind, value: result.locktime };
    return result;
};

const receive = (over: Partial<ReceiveQuote> = {}): ReceiveQuote => ({
    id: "receive-1",
    state: "quoted",
    receiverAddress: "ark1receiver",
    makerPublicKey: "22".repeat(32),
    params: {
        receiverKey: new Uint8Array(32).fill(0x11),
        senderKey: new Uint8Array(32).fill(0x22),
        operatorKey: new Uint8Array(32).fill(0x33),
        dust: 330n,
        topup: 329n,
        assetId: ASSET,
        locktime: 156n,
        claimMode: "recycle",
        recoveryRecipient: "receiver",
    },
    covenantAddress: "ark1covenant",
    fare: { currency: "sats", units: 0n },
    batchExpiry: { kind: "height", value: 300n },
    inputExpiryFloor: { kind: "height", value: 300n },
    recoveryLocktime: { kind: "height", value: 156n },
    loanSats: 329n,
    createdAt: NOW,
    expiresAt: NOW + 60,
    policyRevision: 0n,
    operatorInputs: [
        {
            ...COIN,
            value: 20_000n,
            tapTree: new Uint8Array([1]),
            spendLeaf: new Uint8Array([2]),
            expiry: { kind: "height", value: 300n },
        },
    ],
    ...over,
});

let db: Database;
let advances: AdvanceRepository;
let policy: PolicyRepository;
let reservations: ReservationRepository;
let swapFills: SwapFillRepository;

beforeEach(() => {
    db = openDatabase(":memory:");
    advances = new AdvanceRepository(db);
    policy = new PolicyRepository(db);
    policy.update(
        {
            paused: false,
            maxOutstandingSats: 1_000_000n,
            maxPerPaymentTopupSats: 100_000n,
            maxConcurrentAdvances: 10,
            assetRules: [
                { assetId: null, enabled: true, claim: "either", maxTopupSats: null, fares: [] },
                { assetId: ASSET, enabled: true, claim: "either", maxTopupSats: null, fares: [] },
            ],
        },
        "test",
    );
    reservations = new ReservationRepository(db);
    swapFills = new SwapFillRepository(db);
});
afterEach(() => db.close());

const reserve = (advance = quote()) =>
    reservations.reserveQuote({
        advance,
        expectedPolicyRevision: policy.getSnapshot().revision,
        recoveryExecutionBudget: { kind: advance.batchExpiry.kind, value: 1n },
    });

const reserveReceive = (value = receive()) => {
    const revision = policy.getSnapshot().revision;
    new ReceiveQuoteRepository(db).insert({
        quote: { ...value, policyRevision: revision },
        expectedPolicyRevision: revision,
        recoveryExecutionBudget: { kind: "height", value: 1n },
    });
};

describe("cross-flow reservation fence", () => {
    it("rejects an advance quote at insert when a swap fill holds the coin", () => {
        swapFills.insert(fill());
        // Repository call bypasses the selection-layer union on purpose: the
        // union would filter COIN before reserveQuote ever runs, so reaching
        // for the repository directly is the only way to exercise the fence.
        expect(() => reserve()).toThrow(ReservationConflictError);
        expect(advances.get("quote-1")).toBeUndefined();
        expect(reservations.listReservedOutpoints()).toEqual([]);
        expect(swapFills.listReservedOutpoints()).toEqual([COIN]);
    });

    it("rejects a swap-fill insert when an advance holds the coin", () => {
        reserve();
        expect(() => swapFills.insert(fill())).toThrow(SwapFillReservationConflictError);
        expect(swapFills.get("fill-1")).toBeUndefined();
        expect(swapFills.listReservedOutpoints()).toEqual([]);
        expect(reservations.listReservedOutpoints()).toEqual([COIN]);
    });

    it("rejects a swap-fill insert when a proceeds job holds the coin", () => {
        new ProceedsRepository(db).create("job", { inputs: [{ ...COIN }] }, 1);
        expect(() => swapFills.insert(fill())).toThrow(SwapFillReservationConflictError);
        expect(swapFills.get("fill-1")).toBeUndefined();
        expect(swapFills.listReservedOutpoints()).toEqual([]);
    });

    it("rejects a proceeds job when a swap fill holds the coin", () => {
        swapFills.insert(fill());
        expect(() =>
            new ProceedsRepository(db).create("job", { inputs: [{ ...COIN }] }, 1),
        ).toThrow(/reserved/);
    });

    it("rejects legacy flow inserts when a receive quote holds the coin", () => {
        reserveReceive();
        expect(() => reserve(quote({ id: "advance-2" }))).toThrow(ReservationConflictError);
        expect(() => swapFills.insert(fill())).toThrow(SwapFillReservationConflictError);
        expect(() =>
            new ProceedsRepository(db).create("job", { inputs: [{ ...COIN }] }, 1),
        ).toThrow(/reserved/);
    });

    it.each(["advance", "swap", "proceeds"] as const)(
        "rejects a receive quote when %s holds the coin",
        (flow) => {
            if (flow === "advance") reserve();
            if (flow === "swap") swapFills.insert(fill());
            if (flow === "proceeds")
                new ProceedsRepository(db).create("job", { inputs: [{ ...COIN }] }, 1);
            expect(() => reserveReceive()).toThrow(/reserved/);
        },
    );

    it("expires a stale receive reservation before an advance insert", () => {
        reserveReceive(receive({ expiresAt: NOW + 1 }));
        reserve(
            quote({
                createdAt: NOW + 1,
                updatedAt: NOW + 1,
                expiresAt: NOW + 61,
            }),
        );
        expect(new ReceiveQuoteRepository(db).get("receive-1")?.state).toBe("expired");
        expect(reservations.listReservedOutpoints()).toEqual([COIN]);
    });

    it("expires a stale swap reservation before a receive insert", () => {
        swapFills.insert(fill({ expiresAt: NOW + 1 }));
        reserveReceive(receive({ createdAt: NOW + 1, expiresAt: NOW + 61 }));
        expect(swapFills.get("fill-1")?.state).toBe("expired");
        expect(new ReceiveQuoteRepository(db).listReservedOutpoints()).toEqual([COIN]);
    });

    it.each(["receive", "swap"] as const)(
        "serializes a %s winner before the competing flow across SQLite connections",
        (winner) => {
            const dir = mkdtempSync(join(tmpdir(), "taxi-receive-race-"));
            const first = openDatabase(join(dir, "taxi.sqlite"));
            const terms = new PolicyRepository(first);
            terms.update(policy.get(), "test");
            const second = openDatabase(join(dir, "taxi.sqlite"));
            const receiveRepo = new ReceiveQuoteRepository(first);
            const swapRepo = new SwapFillRepository(second);
            const reserveLocal = () =>
                receiveRepo.insert({
                    quote: { ...receive(), policyRevision: terms.getSnapshot().revision },
                    expectedPolicyRevision: terms.getSnapshot().revision,
                    recoveryExecutionBudget: { kind: "height", value: 1n },
                });
            try {
                if (winner === "receive") {
                    reserveLocal();
                    expect(() => swapRepo.insert(fill())).toThrow(/reserved/);
                } else {
                    swapRepo.insert(fill());
                    expect(reserveLocal).toThrow(/reserved/);
                }
            } finally {
                second.close();
                first.close();
                rmSync(dir, { recursive: true, force: true });
            }
        },
    );
});

describe("cross-flow exposure fence", () => {
    it("rejects swap and advance quote creation after a receive quote consumes the cap", () => {
        reserveReceive();
        policy.update({ maxOutstandingSats: 500n }, "test");
        expect(() =>
            swapFills.insert(
                fill({ taxiInputs: [{ txid: "bb".repeat(32), vout: 1 }] }),
                policy.getSnapshot().revision,
            ),
        ).toThrow(/max outstanding/);
        expect(() =>
            reserve(
                quote({
                    id: "advance-2",
                    operatorInputs: [{ txid: "cc".repeat(32), vout: 2 }],
                }),
            ),
        ).toThrow(/max outstanding/);
    });

    it("rejects lockup submission when a later receive quote consumed the cap", () => {
        reserve(
            quote({
                operatorInputs: [{ txid: "cc".repeat(32), vout: 2 }],
                createdAt: NOW,
                updatedAt: NOW,
                expiresAt: NOW + 60,
            }),
        );
        policy.update({ maxOutstandingSats: 500n }, "test");
        reserveReceive();
        expect(() =>
            reservations.claimLockup(
                "quote-1",
                "bb".repeat(32),
                "digest",
                "envelope",
                () => NOW + 1,
            ),
        ).toThrow(/exceeds_max_outstanding/);
    });

    it("accepts the exact amount boundary and rejects the next count", () => {
        policy.update({ maxOutstandingSats: 658n, maxConcurrentAdvances: 1 }, "test");
        reserveReceive();
        expect(() =>
            reserveReceive(
                receive({
                    id: "receive-2",
                    operatorInputs: [
                        { ...receive().operatorInputs[0]!, txid: "bb".repeat(32), vout: 2 },
                    ],
                }),
            ),
        ).toThrow(/max concurrent/);
        policy.update({ maxConcurrentAdvances: 2 }, "test");
        expect(() =>
            reserveReceive(
                receive({
                    id: "receive-2",
                    operatorInputs: [
                        { ...receive().operatorInputs[0]!, txid: "bb".repeat(32), vout: 2 },
                    ],
                }),
            ),
        ).not.toThrow();
    });

    it("rejects a swap insert when its captured policy revision changed", () => {
        const revision = policy.getSnapshot().revision;
        policy.update({ maxOutstandingSats: 999_999n }, "test");
        expect(() => swapFills.insert(fill(), revision)).toThrow(/policy snapshot changed/);
    });
});
