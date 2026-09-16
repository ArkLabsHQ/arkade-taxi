import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Advance } from "@arkade-taxi/core";
import {
    AdvanceRepository,
    openDatabase,
    PolicyRepository,
    ProceedsRepository,
    ReservationConflictError,
    ReservationRepository,
    SwapFillRepository,
    SwapFillReservationConflictError,
    type Database,
    type SwapFill,
} from "../src/index.js";

const COIN = { txid: "aa".repeat(32), vout: 0 };
const NOW = 1_757_000_000;

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
});
