import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
    AdvanceRepository,
    openDatabase,
    PolicyRepository,
    ReceiveQuoteRepository,
    ReceiveQuoteReservationConflictError,
    ReservationRepository,
    SwapFillRepository,
    type Database,
    type ReceiveQuote,
    type SwapFill,
} from "../src/index.js";
import type { Advance } from "@arkade-taxi/core";

const NOW = 1_757_000_000;
const ASSET = { txid: new Uint8Array(32).fill(0x12), groupIndex: 7 };
const INPUT = { txid: "aa".repeat(32), vout: 1 };

const quote = (over: Partial<ReceiveQuote> = {}): ReceiveQuote => ({
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
        locktime: 899_856n,
        claimMode: "recycle",
        recoveryRecipient: "receiver",
    },
    covenantAddress: "ark1covenant",
    fare: { currency: "sats", units: 3n },
    batchExpiry: { kind: "height", value: 900_000n },
    inputExpiryFloor: { kind: "height", value: 900_000n },
    recoveryLocktime: { kind: "height", value: 899_856n },
    loanSats: 329n,
    createdAt: NOW,
    expiresAt: NOW + 60,
    policyRevision: 1n,
    operatorInputs: [
        {
            ...INPUT,
            value: 20_000n,
            tapTree: new Uint8Array([1, 2]),
            spendLeaf: new Uint8Array([3, 4]),
            expiry: { kind: "height", value: 900_000n },
        },
    ],
    ...over,
});

const configure = (db: Database) => {
    const policy = new PolicyRepository(db);
    policy.update(
        {
            paused: false,
            maxOutstandingSats: 1_000n,
            maxPerPaymentTopupSats: 500n,
            maxConcurrentAdvances: 4,
            locktimeMarginBlocks: 144,
            assetRules: [
                {
                    assetId: ASSET,
                    enabled: true,
                    claim: "either",
                    maxTopupSats: null,
                    fares: [],
                },
            ],
        },
        "test",
    );
    return policy;
};

const insert = (repo: ReceiveQuoteRepository, policy: PolicyRepository, value = quote()) =>
    repo.insert({
        quote: { ...value, policyRevision: policy.getSnapshot().revision },
        expectedPolicyRevision: policy.getSnapshot().revision,
        recoveryExecutionBudget: { kind: "height", value: 72n },
    });

const graph = {
    arkTx: "aGVsbG8=",
    checkpoints: ["d29ybGQ="],
    graphId: new Uint8Array(32).fill(0xab),
    inputOwners: [null, "solver", "sponsor"] as (string | null)[],
};

const boundFill = (over: Partial<SwapFill> = {}): SwapFill => ({
    id: "fill-1",
    receiveQuoteId: "receive-1",
    operationId: "op-1",
    state: "quoted",
    offerHex: "deadbeef",
    offerTxid: "bb".repeat(32),
    offerVout: 0,
    solverInputs: [{ txid: "cc".repeat(32), vout: 0, value: 1n }],
    solverProceedsScript: new Uint8Array([0x51]),
    solverKeys: ["44".repeat(32)],
    taxiInputs: [INPUT],
    contributionSats: 329n,
    sponsorScript: new Uint8Array([0x52]),
    fare: { currency: "sats", units: 3n },
    maxFare: { currency: "sats", units: 30n },
    graph: structuredClone(graph),
    graphId: new Uint8Array(32).fill(0xab),
    submitInvoked: false,
    attempts: 0,
    createdAt: NOW,
    updatedAt: NOW,
    expiresAt: NOW + 60,
    ...over,
});

const boundAdvance = (over: Partial<Advance> = {}): Advance => ({
    id: "receive-1",
    state: "locking",
    receiverKey: quote().params.receiverKey,
    senderKey: quote().params.senderKey,
    operatorKey: quote().params.operatorKey,
    dust: 330n,
    topup: 329n,
    assetId: ASSET,
    assetUnits: 5n,
    claimMode: "recycle",
    recoveryRecipient: "receiver",
    locktime: 899_856n,
    covenantAddress: quote().covenantAddress,
    fare: { currency: "sats", units: 3n },
    createdAt: NOW,
    updatedAt: NOW,
    expiresAt: NOW + 60,
    batchExpiry: { kind: "height", value: 900_000n },
    recoveryLocktime: { kind: "height", value: 899_856n },
    operatorInputs: [INPUT],
    unsignedLockupTx: 'taxi-source:{"tag":"joint-fill","version":1}',
    unsignedLockupId: "ab".repeat(32),
    ...over,
});

let cleanup: (() => void) | undefined;
afterEach(() => {
    cleanup?.();
    cleanup = undefined;
});

describe("receive quote repository", () => {
    it("round-trips immutable terms and full operator snapshots across restart", () => {
        const dir = mkdtempSync(join(tmpdir(), "taxi-receive-quote-"));
        cleanup = () => rmSync(dir, { recursive: true, force: true });
        const path = join(dir, "taxi.sqlite");
        const first = openDatabase(path);
        const policy = configure(first);
        const revision = policy.getSnapshot().revision;
        const lifetime = quote({
            params: { ...quote().params, locktime: 849_856n },
            inputExpiryFloor: { kind: "height", value: 850_000n },
            recoveryLocktime: { kind: "height", value: 849_856n },
        });
        insert(new ReceiveQuoteRepository(first), policy, lifetime);
        first.close();

        const second = openDatabase(path);
        const stored = new ReceiveQuoteRepository(second).get("receive-1");
        expect(stored).toEqual({
            ...lifetime,
            policyRevision: revision,
        });
        expect(stored?.operatorInputs[0]).toMatchObject({
            ...INPUT,
            value: 20_000n,
            expiry: { kind: "height", value: 900_000n },
        });
        second.close();
    });

    it("fails closed when persisted economics are corrupted", () => {
        const db = openDatabase(":memory:");
        const policy = configure(db);
        const repo = new ReceiveQuoteRepository(db);
        insert(repo, policy);
        db.prepare("UPDATE receive_quotes SET params_json = ? WHERE id = ?").run(
            JSON.stringify({ dust: "330" }),
            "receive-1",
        );
        expect(() => repo.get("receive-1")).toThrow(/params/);
        db.close();
    });

    it("expires and releases only unbound quotes", () => {
        const db = openDatabase(":memory:");
        const policy = configure(db);
        const repo = new ReceiveQuoteRepository(db);
        insert(
            repo,
            policy,
            quote({
                id: "unbound",
                operatorInputs: [{ ...quote().operatorInputs[0]!, txid: "dd".repeat(32), vout: 4 }],
            }),
        );
        insert(repo, policy);
        repo.bind({
            quoteId: "receive-1",
            fill: boundFill(),
            advance: boundAdvance(),
            expectedPolicyRevision: policy.getSnapshot().revision,
            now: NOW,
        });

        expect(repo.expireQuotes(NOW + 60)).toBe(1);
        expect(repo.get("unbound")?.state).toBe("expired");
        expect(repo.get("receive-1")?.state).toBe("bound");
        expect(repo.listReservedOutpoints()).toEqual([]);
        expect(new ReservationRepository(db).listForAdvance("receive-1")).toEqual([INPUT]);
        db.close();
    });

    it("rechecks revision, pause and aggregate receive exposure in the transaction", () => {
        const db = openDatabase(":memory:");
        const policy = configure(db);
        const repo = new ReceiveQuoteRepository(db);
        insert(repo, policy);

        const stale = policy.getSnapshot().revision;
        policy.update({ maxOutstandingSats: 657n }, "test");
        expect(() =>
            repo.insert({
                quote: quote({ id: "receive-2", policyRevision: stale }),
                expectedPolicyRevision: stale,
                recoveryExecutionBudget: { kind: "height", value: 72n },
            }),
        ).toThrow(/policy snapshot changed/);

        const current = policy.getSnapshot().revision;
        expect(() =>
            repo.insert({
                quote: quote({ id: "receive-2", policyRevision: current }),
                expectedPolicyRevision: current,
                recoveryExecutionBudget: { kind: "height", value: 72n },
            }),
        ).toThrow(/max outstanding/);
        db.close();
    });

    it("rejects a changed reservation snapshot atomically", () => {
        const db = openDatabase(":memory:");
        const policy = configure(db);
        const repo = new ReceiveQuoteRepository(db);
        insert(repo, policy);
        const current = policy.getSnapshot().revision;
        expect(() =>
            repo.insert({
                quote: quote({
                    id: "receive-2",
                    operatorInputs: [
                        { ...quote().operatorInputs[0]!, txid: "bb".repeat(32), vout: 2 },
                    ],
                }),
                expectedPolicyRevision: current,
                recoveryExecutionBudget: { kind: "height", value: 72n },
                expectedReservedOutpoints: [],
            }),
        ).toThrow(ReceiveQuoteReservationConflictError);
        db.close();
    });

    it("atomically transfers one receive obligation into a bound fill and advance", () => {
        const db = openDatabase(":memory:");
        const policy = configure(db);
        const repo = new ReceiveQuoteRepository(db);
        insert(repo, policy);
        const revision = policy.getSnapshot().revision;
        repo.bind({
            quoteId: "receive-1",
            fill: boundFill(),
            advance: boundAdvance(),
            expectedPolicyRevision: revision,
            now: NOW,
        });
        expect(repo.get("receive-1")).toMatchObject({ state: "bound", boundFillId: "fill-1" });
        expect(new SwapFillRepository(db).get("fill-1")?.receiveQuoteId).toBe("receive-1");
        expect(new AdvanceRepository(db).get("receive-1")?.state).toBe("locking");
        expect(new ReservationRepository(db).listForAdvance("receive-1")).toEqual([INPUT]);
        expect(new AdvanceRepository(db).exposureTotals()).toEqual({
            outstandingSats: 329n,
            lockedCount: 1,
        });
        expect(new SwapFillRepository(db).exposureTotals()).toEqual({
            outstandingSats: 0n,
            activeCount: 0,
        });
        expect(() =>
            repo.bind({
                quoteId: "receive-1",
                fill: { ...boundFill(), id: "fill-2", operationId: "op-2" },
                advance: boundAdvance(),
                expectedPolicyRevision: revision,
                now: NOW,
            }),
        ).toThrow(/bound|state/);
        expect(new SwapFillRepository(db).expireQuotes(NOW + 60)).toBe(1);
        expect(repo.get("receive-1")?.state).toBe("expired");
        expect(new AdvanceRepository(db).get("receive-1")?.state).toBe("expired");
        expect(new ReservationRepository(db).listForAdvance("receive-1")).toEqual([]);
        db.close();
    });

    describe("bind: receiver fare agreement", () => {
        const receiverPaidFare = { currency: "asset" as const, units: 9n };

        const receiverPaidQuote = (over: Partial<ReceiveQuote> = {}): ReceiveQuote =>
            quote({
                params: {
                    ...quote().params,
                    dust: 330n,
                    topup: 330n,
                    receiverFare: receiverPaidFare,
                },
                payer: "receiver",
                receiverFare: { ...receiverPaidFare, assetId: ASSET },
                loanSats: 330n,
                fare: { currency: "sats", units: 0n },
                ...over,
            });

        const receiverPaidAdvance = (over: Partial<Advance> = {}): Advance =>
            boundAdvance({ topup: 330n, fare: { currency: "sats", units: 0n }, ...over });

        it("refuses to bind when the quote carries a receiver fare the advance omits", () => {
            const db = openDatabase(":memory:");
            const policy = configure(db);
            const repo = new ReceiveQuoteRepository(db);
            insert(repo, policy, receiverPaidQuote());
            expect(() =>
                repo.bind({
                    quoteId: "receive-1",
                    fill: boundFill({
                        contributionSats: 330n,
                        fare: { currency: "sats", units: 0n },
                    }),
                    advance: receiverPaidAdvance(),
                    expectedPolicyRevision: policy.getSnapshot().revision,
                    now: NOW,
                }),
            ).toThrow(/economics mismatch/);
            db.close();
        });

        it("refuses to bind when the advance carries a receiver fare the quote omits", () => {
            const db = openDatabase(":memory:");
            const policy = configure(db);
            const repo = new ReceiveQuoteRepository(db);
            insert(repo, policy);
            expect(() =>
                repo.bind({
                    quoteId: "receive-1",
                    fill: boundFill(),
                    advance: boundAdvance({ receiverFare: receiverPaidFare }),
                    expectedPolicyRevision: policy.getSnapshot().revision,
                    now: NOW,
                }),
            ).toThrow(/economics mismatch/);
            db.close();
        });

        it.each([
            ["currency", { currency: "sats" as const, units: 9n }],
            ["units", { currency: "asset" as const, units: 8n }],
        ])(
            "refuses to bind when the receiver fare %s differs from the quote's",
            (_field, advanceFare) => {
                const db = openDatabase(":memory:");
                const policy = configure(db);
                const repo = new ReceiveQuoteRepository(db);
                insert(repo, policy, receiverPaidQuote());
                expect(() =>
                    repo.bind({
                        quoteId: "receive-1",
                        fill: boundFill({
                            contributionSats: 330n,
                            fare: { currency: "sats", units: 0n },
                        }),
                        advance: receiverPaidAdvance({ receiverFare: advanceFare }),
                        expectedPolicyRevision: policy.getSnapshot().revision,
                        now: NOW,
                    }),
                ).toThrow(/economics mismatch/);
                db.close();
            },
        );

        it("binds when the advance's receiver fare agrees with the quote's", () => {
            const db = openDatabase(":memory:");
            const policy = configure(db);
            const repo = new ReceiveQuoteRepository(db);
            insert(repo, policy, receiverPaidQuote());
            expect(() =>
                repo.bind({
                    quoteId: "receive-1",
                    fill: boundFill({
                        contributionSats: 330n,
                        fare: { currency: "sats", units: 0n },
                    }),
                    advance: receiverPaidAdvance({ receiverFare: receiverPaidFare }),
                    expectedPolicyRevision: policy.getSnapshot().revision,
                    now: NOW,
                }),
            ).not.toThrow();
            db.close();
        });
    });

    it("isolates an inconsistent bound row so unrelated expiries still complete", () => {
        const db = openDatabase(":memory:");
        const policy = configure(db);
        const quotes = new ReceiveQuoteRepository(db);
        const fills = new SwapFillRepository(db);
        const advances = new AdvanceRepository(db);
        const reservations = new ReservationRepository(db);
        const SECOND = { txid: "ee".repeat(32), vout: 2 };
        const UNBOUND = { txid: "ff".repeat(32), vout: 0 };
        const LIVE = { txid: "ff".repeat(32), vout: 1 };
        insert(quotes, policy);
        quotes.bind({
            quoteId: "receive-1",
            fill: boundFill(),
            advance: boundAdvance(),
            expectedPolicyRevision: policy.getSnapshot().revision,
            now: NOW,
        });
        insert(
            quotes,
            policy,
            quote({
                id: "receive-2",
                operatorInputs: [{ ...quote().operatorInputs[0]!, ...SECOND }],
            }),
        );
        quotes.bind({
            quoteId: "receive-2",
            fill: boundFill({
                id: "fill-2",
                receiveQuoteId: "receive-2",
                operationId: "op-2",
                taxiInputs: [SECOND],
            }),
            advance: boundAdvance({ id: "receive-2", operatorInputs: [SECOND] }),
            expectedPolicyRevision: policy.getSnapshot().revision,
            now: NOW,
        });
        fills.insert(
            boundFill({
                id: "fill-3",
                receiveQuoteId: undefined,
                operationId: "op-3",
                taxiInputs: [UNBOUND],
            }),
        );
        fills.insert(
            boundFill({
                id: "fill-4",
                receiveQuoteId: undefined,
                operationId: "op-4",
                taxiInputs: [LIVE],
                expiresAt: NOW + 600,
            }),
        );
        db.prepare(
            "UPDATE receive_quotes SET state = 'expired', bound_fill_id = NULL WHERE id = 'receive-2'",
        ).run();

        expect(fills.expireQuotes(NOW + 60)).toBe(2);
        expect(fills.get("fill-1")?.state).toBe("expired");
        expect(advances.get("receive-1")?.state).toBe("expired");
        expect(reservations.listForAdvance("receive-1")).toEqual([]);
        expect(fills.get("fill-3")?.state).toBe("expired");
        expect(fills.get("fill-4")?.state).toBe("quoted");
        expect(fills.listReservedOutpoints()).toEqual([LIVE]);

        const stuck = fills.get("fill-2")!;
        expect(stuck.state).toBe("quoted");
        expect(stuck.failureCode).toBe("swap_fill_bound_expiry_unsafe");
        expect(stuck.failureDetail).toMatch(/receive-2/);
        expect(advances.get("receive-2")?.state).toBe("locking");
        expect(reservations.listForAdvance("receive-2")).toEqual([SECOND]);

        expect(
            fills.claimSubmit("fill-4", {
                leaseOwner: "w1",
                leaseToken: "t1",
                leaseUntil: NOW + 90,
                solverGraph: structuredClone(graph),
                now: NOW + 60,
            }).state,
        ).toBe("submitting");
        db.close();
    });

    it("refuses to claim a bound fill the sweep could not expire", () => {
        const db = openDatabase(":memory:");
        const policy = configure(db);
        const quotes = new ReceiveQuoteRepository(db);
        const fills = new SwapFillRepository(db);
        insert(quotes, policy);
        quotes.bind({
            quoteId: "receive-1",
            fill: boundFill(),
            advance: boundAdvance(),
            expectedPolicyRevision: policy.getSnapshot().revision,
            now: NOW,
        });
        db.prepare(
            "UPDATE receive_quotes SET state = 'expired', bound_fill_id = NULL WHERE id = 'receive-1'",
        ).run();
        expect(fills.expireQuotes(NOW + 60)).toBe(0);
        expect(() =>
            fills.claimSubmit("fill-1", {
                leaseOwner: "w1",
                leaseToken: "t1",
                leaseUntil: NOW + 90,
                solverGraph: structuredClone(graph),
                now: NOW + 60,
            }),
        ).toThrow(/quote_expired/);
        db.close();
    });

    it("marks the linked advance locked only when the trusted fill is observed", () => {
        const db = openDatabase(":memory:");
        const policy = configure(db);
        const quotes = new ReceiveQuoteRepository(db);
        insert(quotes, policy);
        quotes.bind({
            quoteId: "receive-1",
            fill: boundFill(),
            advance: boundAdvance(),
            expectedPolicyRevision: policy.getSnapshot().revision,
            now: NOW,
        });
        db.prepare(
            "UPDATE swap_fills SET state = 'submitting', submit_invoked = 1 WHERE id = 'fill-1'",
        ).run();
        const fills = new SwapFillRepository(db);
        expect(
            fills.reconcileSettled(
                "fill-1",
                "ab".repeat(32),
                { txid: "ab".repeat(32), vout: 0 },
                NOW + 1,
            ),
        ).toBe(true);
        expect(new AdvanceRepository(db).get("receive-1")).toMatchObject({
            state: "locked",
            arkTxid: "ab".repeat(32),
            outpoint: { txid: "ab".repeat(32), vout: 0 },
        });
        expect(quotes.get("receive-1")?.state).toBe("bound");
        expect(new ReservationRepository(db).listForAdvance("receive-1")).toEqual([INPUT]);
        db.close();
    });
});
