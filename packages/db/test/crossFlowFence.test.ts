import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Advance } from "@arkade-taxi/core";
import { totalExposure } from "../src/reservations.js";
import {
    AdvanceRepository,
    CustodyRepository,
    openDatabase,
    PolicyRepository,
    ProceedsRepository,
    ReceiveQuoteRepository,
    ReservationConflictError,
    ReservationRepository,
    FillRepository,
    FillReservationConflictError,
    type Database,
    type Fill,
    type ReceiveQuote,
} from "../src/index.js";

const COIN = { txid: "aa".repeat(32), vout: 0 };
const fillReservations = (db: Database) =>
    db
        .prepare<[], { txid: string; vout: bigint }>(
            "SELECT outpoint_txid AS txid, outpoint_vout AS vout FROM fill_reservations ORDER BY txid, vout",
        )
        .all()
        .map(({ txid, vout }) => ({ txid, vout: Number(vout) }));

const NOW = 1_757_000_000;
const ASSET = { txid: new Uint8Array(32).fill(0x12), groupIndex: 7 };

const GRAPH = {
    arkTx: "aGVsbG8=",
    checkpoints: ["d29ybGQ="],
};

const fill = (over: Partial<Fill> = {}): Fill => ({
    id: "fill-1",
    operationId: "op-1",
    state: "submitting",
    quoteId: "receive-1",
    covenantOutputIndex: 0,
    assetUnits: 5n,
    taxiInputs: [{ ...COIN }],
    contributionSats: 330n,
    fare: { currency: "sats", units: 10n },
    graph: structuredClone(GRAPH),
    graphId: new Uint8Array(32).fill(0xab),
    submitInvoked: false,
    attempts: 0,
    createdAt: NOW,
    updatedAt: NOW,
    expiresAt: NOW + 60,
    ...over,
});

const DEADLINE = 1_757_000_000n + 8_640_000n;

const quote = (overrides: Partial<Advance> = {}): Advance => {
    const result: Advance = {
        id: "quote-1",
        state: "quoted",
        receiverKey: new Uint8Array(32),
        senderKey: new Uint8Array(32),
        operatorKey: new Uint8Array(32),
        operatorSignerKey: new Uint8Array(32).fill(4),
        exitDelay: { value: 5n, type: "blocks" },
        dust: 330n,
        topup: 330n,
        locktime: DEADLINE,
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
    result.recoveryLocktime ??= {
        kind: result.batchExpiry?.kind ?? "time",
        value: result.locktime,
    };
    return result;
};

const receive = (over: Partial<ReceiveQuote> = {}): ReceiveQuote => ({
    id: "receive-1",
    state: "quoted",
    receiverAddress: "ark1receiver",
    senderKey: "22".repeat(32),
    params: {
        receiverKey: new Uint8Array(32).fill(0x11),
        senderKey: new Uint8Array(32).fill(0x22),
        operatorKey: new Uint8Array(32).fill(0x33),
        operatorSignerKey: new Uint8Array(32).fill(0x44),
        exitDelay: { value: 5n, type: "blocks" },
        dust: 330n,
        topup: 330n,
        assetId: ASSET,
        locktime: DEADLINE,
        claimMode: "recycle",
        recoveryRecipient: "receiver",
    },
    covenantAddress: "ark1covenant",
    fare: { currency: "sats", units: 0n },
    batchExpiry: { kind: "height", value: 300n },
    inputExpiryFloor: { kind: "height", value: 300n },
    recoveryLocktime: { kind: "time", value: DEADLINE },
    loanSats: 330n,
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
let fills: FillRepository;

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
    fills = new FillRepository(db);
});
afterEach(() => db.close());

const reserve = (advance = quote()) =>
    reservations.reserveQuote({
        advance,
        expectedPolicyRevision: policy.getSnapshot().revision,
        recoveryExecutionBudget: { kind: "time", value: 1n },
    });

const reserveReceive = (value = receive()) => {
    const revision = policy.getSnapshot().revision;
    new ReceiveQuoteRepository(db).insert({
        quote: { ...value, policyRevision: revision },
        expectedPolicyRevision: revision,
        recoveryExecutionBudget: { kind: "time", value: 1n },
    });
};

describe("cross-flow reservation fence", () => {
    it("rejects an advance quote at insert when a fill holds the coin", () => {
        fills.insert(fill());
        // Repository call bypasses the selection-layer union on purpose: the
        // union would filter COIN before reserveQuote ever runs, so reaching
        // for the repository directly is the only way to exercise the fence.
        expect(() => reserve()).toThrow(ReservationConflictError);
        expect(advances.get("quote-1")).toBeUndefined();
        expect(reservations.listReservedOutpoints()).toEqual([]);
        expect(fillReservations(db)).toEqual([COIN]);
    });

    it("rejects a fill insert when an advance holds the coin", () => {
        reserve();
        expect(() => fills.insert(fill())).toThrow(FillReservationConflictError);
        expect(fills.get("fill-1")).toBeUndefined();
        expect(fillReservations(db)).toEqual([]);
        expect(reservations.listReservedOutpoints()).toEqual([COIN]);
    });

    it("rejects a fill insert when a proceeds job holds the coin", () => {
        new ProceedsRepository(db).create("job", { inputs: [{ ...COIN }] }, 1);
        expect(() => fills.insert(fill())).toThrow(FillReservationConflictError);
        expect(fills.get("fill-1")).toBeUndefined();
        expect(fillReservations(db)).toEqual([]);
    });

    it("rejects an advance quote at insert when a proceeds job holds the coin", () => {
        new ProceedsRepository(db).create("job", { inputs: [{ ...COIN }] }, 1);
        expect(() => reserve()).toThrow(ReservationConflictError);
        expect(advances.get("quote-1")).toBeUndefined();
        expect(reservations.listReservedOutpoints()).toEqual([COIN]);
    });

    it("rejects a proceeds job when a fill holds the coin", () => {
        fills.insert(fill());
        expect(() =>
            new ProceedsRepository(db).create("job", { inputs: [{ ...COIN }] }, 1),
        ).toThrow(/reserved/);
    });

    it("rejects legacy flow inserts when a receive quote holds the coin", () => {
        reserveReceive();
        expect(() => reserve(quote({ id: "advance-2" }))).toThrow(ReservationConflictError);
        expect(() => fills.insert(fill())).toThrow(FillReservationConflictError);
        expect(() =>
            new ProceedsRepository(db).create("job", { inputs: [{ ...COIN }] }, 1),
        ).toThrow(/reserved/);
    });

    // Custody is a liability, not a coin: a reclaimed coin is ordinary inventory
    // and every other flow may lend it. Only an in-flight release binds coins,
    // and it binds them away from background settlement, not from quoting.
    it("fences nothing while a custody row is merely held", () => {
        const custodian = new AdvanceRepository(db, { custodyWindowSeconds: 8_640_000 });
        custodian.insert(quote({ id: "reclaimed", state: "locked", paymentSats: 1_000n }));
        custodian.recordSpendObservation("reclaimed", "locked", "recovered", COIN.txid, NOW, {
            hash: "34".repeat(32),
            height: 700_000,
        });
        const custody = new CustodyRepository(db);
        expect(custody.liabilities().owedSats).toBe(1_000n);
        expect(custody.listHeldOutpoints()).toEqual([]);
        expect(() => reserve(quote({ id: "advance-2" }))).not.toThrow();
    });

    it.each(["advance", "fill", "proceeds"] as const)(
        "rejects a receive quote when %s holds the coin",
        (flow) => {
            if (flow === "advance") reserve();
            if (flow === "fill") fills.insert(fill());
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

    it("keeps an unresolved fill reservation after its deadline", () => {
        fills.insert(fill({ expiresAt: NOW + 1 }));
        expect(() => reserveReceive(receive({ createdAt: NOW + 1, expiresAt: NOW + 61 }))).toThrow(
            /reserved/,
        );
        expect(fills.get("fill-1")?.state).toBe("submitting");
        expect(fillReservations(db)).toEqual([COIN]);
    });

    it.each(["receive", "fill"] as const)(
        "serializes a %s winner before the competing flow across SQLite connections",
        (winner) => {
            const dir = mkdtempSync(join(tmpdir(), "taxi-receive-race-"));
            const first = openDatabase(join(dir, "taxi.sqlite"));
            const terms = new PolicyRepository(first);
            terms.update(policy.get(), "test");
            const second = openDatabase(join(dir, "taxi.sqlite"));
            const receiveRepo = new ReceiveQuoteRepository(first);
            const fillRepo = new FillRepository(second);
            const reserveLocal = () =>
                receiveRepo.insert({
                    quote: { ...receive(), policyRevision: terms.getSnapshot().revision },
                    expectedPolicyRevision: terms.getSnapshot().revision,
                    recoveryExecutionBudget: { kind: "time", value: 1n },
                });
            try {
                if (winner === "receive") {
                    reserveLocal();
                    expect(() => fillRepo.insert(fill())).toThrow(/reserved/);
                } else {
                    fillRepo.insert(fill());
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
    it("counts a bound fill's advance once while fencing the next advance", () => {
        policy.update({ maxOutstandingSats: 500n }, "test");
        reserveReceive();
        const receiveQuote = receive();
        new ReceiveQuoteRepository(db).bindFill({
            quoteId: receiveQuote.id,
            fill: fill({ fare: receiveQuote.fare }),
            advance: quote({
                ...receiveQuote.params,
                id: receiveQuote.id,
                state: "locking",
                covenantAddress: receiveQuote.covenantAddress,
                assetUnits: 5n,
                fare: receiveQuote.fare,
                createdAt: NOW,
                updatedAt: NOW,
                expiresAt: NOW + 60,
                recoveryLocktime: receiveQuote.recoveryLocktime,
            }),
            expectedPolicyRevision: policy.getSnapshot().revision,
            now: NOW,
        });
        expect(advances.exposureTotals()).toEqual({ outstandingSats: 330n, lockedCount: 1 });
        expect(totalExposure(db)).toEqual({ total: 330n, count: 1n });
        expect(() =>
            reserve(
                quote({ id: "advance-2", operatorInputs: [{ txid: "cc".repeat(32), vout: 2 }] }),
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
        policy.update({ maxOutstandingSats: 660n, maxConcurrentAdvances: 1 }, "test");
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

    it("rejects binding a fill when its captured policy revision changed", () => {
        reserveReceive();
        const revision = policy.getSnapshot().revision;
        policy.update({ maxOutstandingSats: 999_999n }, "test");
        expect(() =>
            new ReceiveQuoteRepository(db).bindFill({
                quoteId: "receive-1",
                fill: fill(),
                advance: quote(),
                expectedPolicyRevision: revision,
                now: NOW,
            }),
        ).toThrow(/policy snapshot changed/);
        expect(new ReceiveQuoteRepository(db).get("receive-1")?.state).toBe("quoted");
        expect(fills.get("fill-1")).toBeUndefined();
    });
});
