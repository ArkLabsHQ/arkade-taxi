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
    FillRepository,
    type Database,
    type ReceiveQuote,
    type Fill,
} from "../src/index.js";
import type { Advance } from "@arkade-taxi/core";

const fillReservations = (db: Database) =>
    db
        .prepare<[], { txid: string; vout: bigint }>(
            "SELECT outpoint_txid AS txid, outpoint_vout AS vout FROM fill_reservations ORDER BY txid, vout",
        )
        .all()
        .map(({ txid, vout }) => ({ txid, vout: Number(vout) }));

const NOW = 1_757_000_000;
const ASSET = { txid: new Uint8Array(32).fill(0x12), groupIndex: 7 };
const INPUT = { txid: "aa".repeat(32), vout: 1 };
const DEADLINE = 1_800_000_000n;

const quote = (over: Partial<ReceiveQuote> = {}): ReceiveQuote => ({
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
    fare: { currency: "sats", units: 3n },
    batchExpiry: { kind: "height", value: 900_000n },
    inputExpiryFloor: { kind: "height", value: 900_000n },
    recoveryLocktime: { kind: "time", value: DEADLINE },
    loanSats: 330n,
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
        recoveryExecutionBudget: { kind: "time", value: 43_200n },
    });

const graph = {
    arkTx: "aGVsbG8=",
    checkpoints: ["d29ybGQ="],
};

const boundFill = (over: Partial<Fill> = {}): Fill => ({
    id: "fill-1",
    quoteId: "receive-1",
    operationId: "op-1",
    state: "submitting",
    covenantOutputIndex: 0,
    assetUnits: 5n,
    taxiInputs: [INPUT],
    contributionSats: 330n,
    fare: { currency: "sats", units: 3n },
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
    operatorSignerKey: quote().params.operatorSignerKey,
    exitDelay: quote().params.exitDelay,
    dust: 330n,
    topup: 330n,
    assetId: ASSET,
    assetUnits: 5n,
    claimMode: "recycle",
    recoveryRecipient: "receiver",
    locktime: DEADLINE,
    covenantAddress: quote().covenantAddress,
    fare: { currency: "sats", units: 3n },
    createdAt: NOW,
    updatedAt: NOW,
    expiresAt: NOW + 60,
    recoveryLocktime: { kind: "time", value: DEADLINE },
    operatorInputs: [INPUT],
    unsignedLockupTx: 'taxi-source:{"tag":"fill","version":1}',
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
            params: { ...quote().params, locktime: DEADLINE + 10n },
            inputExpiryFloor: { kind: "height", value: 850_000n },
            recoveryLocktime: { kind: "time", value: DEADLINE + 10n },
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

    it("round-trips the exit params through params_json", () => {
        const db = openDatabase(":memory:");
        const policy = configure(db);
        const repo = new ReceiveQuoteRepository(db);
        insert(
            repo,
            policy,
            quote({
                params: {
                    ...quote().params,
                    operatorSignerKey: new Uint8Array(32).fill(9),
                    exitDelay: { value: 86_016n, type: "seconds" as const },
                },
            }),
        );
        const { params } = repo.get("receive-1")!;
        expect(params.operatorSignerKey).toEqual(new Uint8Array(32).fill(9));
        expect(params.exitDelay).toEqual({ value: 86_016n, type: "seconds" });
        db.close();
    });

    // The version rides in its own column, never in params_json: that decoder is
    // strict, so a v2 row inside it would be undecodable by a rolled-back build.
    it("round-trips a receiver-paid quote with no version in params_json", () => {
        const db = openDatabase(":memory:");
        const policy = configure(db);
        const repo = new ReceiveQuoteRepository(db);
        const fare = { currency: "asset" as const, units: 9n };
        const paid = quote({
            params: { ...quote().params, receiverFare: fare },
            payer: "receiver",
            receiverFare: { ...fare, assetId: ASSET },
        });
        insert(repo, policy, paid);
        expect(repo.get("receive-1")).toEqual({
            ...paid,
            policyRevision: policy.getSnapshot().revision,
        });
        expect(
            JSON.parse(
                db
                    .prepare<[], { params_json: string }>("SELECT params_json FROM receive_quotes")
                    .get()!.params_json,
            ),
        ).not.toHaveProperty("covenantVersion");
        db.close();
    });

    it("refuses a stored params object missing the exit params", () => {
        const db = openDatabase(":memory:");
        const policy = configure(db);
        const repo = new ReceiveQuoteRepository(db);
        insert(repo, policy);
        const { params_json } = db
            .prepare<[], { params_json: string }>("SELECT params_json FROM receive_quotes")
            .get()!;
        const { operatorSignerKey, exitDelay, ...legacy } = JSON.parse(params_json);
        db.prepare("UPDATE receive_quotes SET params_json = ?").run(JSON.stringify(legacy));
        expect(() => repo.get("receive-1")).toThrow(/params/);
        db.close();
    });

    it.each(
        (["quoted", "expired", "bound"] as const).flatMap((state) =>
            (["operatorSignerKey", "exitDelay"] as const).map((field) => [state, field] as const),
        ),
    )("refuses a database holding a quote in state %s whose params lack %s", (state, field) => {
        const db = openDatabase(":memory:");
        const policy = configure(db);
        const repo = new ReceiveQuoteRepository(db);
        insert(repo, policy);
        if (state === "expired") repo.expireQuotes(NOW + 60);
        if (state === "bound")
            repo.bindFill({
                quoteId: "receive-1",
                fill: boundFill(),
                advance: boundAdvance(),
                expectedPolicyRevision: policy.getSnapshot().revision,
                now: NOW,
            });
        expect(() => repo.assertExitParamsPresent()).not.toThrow();
        db.prepare("UPDATE receive_quotes SET params_json = json_remove(params_json, ?)").run(
            `$.${field}`,
        );
        expect(() => repo.assertExitParamsPresent()).toThrow(
            /receive quotes were written before the covenant exit leaf.*recreate the database/,
        );
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
        repo.bindFill({
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
                recoveryExecutionBudget: { kind: "time", value: 43_200n },
            }),
        ).toThrow(/policy snapshot changed/);

        const current = policy.getSnapshot().revision;
        expect(() =>
            repo.insert({
                quote: quote({ id: "receive-2", policyRevision: current }),
                expectedPolicyRevision: current,
                recoveryExecutionBudget: { kind: "time", value: 43_200n },
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
                recoveryExecutionBudget: { kind: "time", value: 43_200n },
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
        repo.bindFill({
            quoteId: "receive-1",
            fill: boundFill(),
            advance: boundAdvance(),
            expectedPolicyRevision: revision,
            now: NOW,
        });
        expect(repo.get("receive-1")).toMatchObject({ state: "bound", boundFillId: "fill-1" });
        expect(new FillRepository(db).get("fill-1")?.quoteId).toBe("receive-1");
        expect(new AdvanceRepository(db).get("receive-1")?.state).toBe("locking");
        expect(new ReservationRepository(db).listForAdvance("receive-1")).toEqual([INPUT]);
        expect(new AdvanceRepository(db).exposureTotals()).toEqual({
            outstandingSats: 330n,
            lockedCount: 1,
        });
        expect(repo.exposureTotals()).toEqual({
            outstandingSats: 0n,
            activeCount: 0,
        });
        expect(() =>
            repo.bindFill({
                quoteId: "receive-1",
                fill: { ...boundFill(), id: "fill-2", operationId: "op-2" },
                advance: boundAdvance(),
                expectedPolicyRevision: revision,
                now: NOW,
            }),
        ).toThrow(/bound|state/);
        expect(new FillRepository(db).expire(NOW + 60)).toBe(1);
        expect(repo.get("receive-1")?.state).toBe("bound");
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
                repo.bindFill({
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
                repo.bindFill({
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
                    repo.bindFill({
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
                repo.bindFill({
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

    it.each([
        { currency: "asset" as const, units: 3n, assetId: ASSET },
        { currency: "sats" as const, units: 4n },
    ])("refuses binding when the advance fare differs from the quote", (fare) => {
        const db = openDatabase(":memory:");
        const policy = configure(db);
        const repo = new ReceiveQuoteRepository(db);
        insert(repo, policy);
        expect(() =>
            repo.bindFill({
                quoteId: "receive-1",
                fill: boundFill(),
                advance: boundAdvance({ fare }),
                expectedPolicyRevision: policy.getSnapshot().revision,
                now: NOW,
            }),
        ).toThrow(/economics mismatch/);
        expect(repo.get("receive-1")?.state).toBe("quoted");
        expect(new FillRepository(db).get("fill-1")).toBeUndefined();
        expect(new AdvanceRepository(db).get("receive-1")).toBeUndefined();
        db.close();
    });

    describe("bind: exit params agreement", () => {
        it.each([
            ["signer key", { operatorSignerKey: new Uint8Array(32).fill(0x45) }],
            ["delay type", { exitDelay: { value: 5n, type: "seconds" as const } }],
            ["delay value", { exitDelay: { value: 6n, type: "blocks" as const } }],
        ])(
            "refuses to bind when the advance's exit %s differs from the quote's",
            (_field, over) => {
                const db = openDatabase(":memory:");
                const policy = configure(db);
                const repo = new ReceiveQuoteRepository(db);
                insert(repo, policy);
                expect(() =>
                    repo.bindFill({
                        quoteId: "receive-1",
                        fill: boundFill(),
                        advance: boundAdvance(over),
                        expectedPolicyRevision: policy.getSnapshot().revision,
                        now: NOW,
                    }),
                ).toThrow(/economics mismatch/);
                db.close();
            },
        );
    });

    it("isolates an inconsistent bound row so unrelated expiries still complete", () => {
        const db = openDatabase(":memory:");
        const policy = configure(db);
        const quotes = new ReceiveQuoteRepository(db);
        const fills = new FillRepository(db);
        const advances = new AdvanceRepository(db);
        const reservations = new ReservationRepository(db);
        const SECOND = { txid: "ee".repeat(32), vout: 2 };
        const UNBOUND = { txid: "ff".repeat(32), vout: 0 };
        const LIVE = { txid: "ff".repeat(32), vout: 1 };
        insert(quotes, policy);
        quotes.bindFill({
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
        quotes.bindFill({
            quoteId: "receive-2",
            fill: boundFill({
                id: "fill-2",
                quoteId: "receive-2",
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
                quoteId: "missing",
                operationId: "op-3",
                taxiInputs: [UNBOUND],
            }),
        );
        fills.insert(
            boundFill({
                id: "fill-4",
                quoteId: "missing",
                operationId: "op-4",
                taxiInputs: [LIVE],
                expiresAt: NOW + 600,
            }),
        );
        db.prepare(
            "UPDATE receive_quotes SET state = 'expired', bound_fill_id = NULL WHERE id = 'receive-2'",
        ).run();

        expect(fills.expire(NOW + 60)).toBe(1);
        expect(fills.get("fill-1")?.state).toBe("expired");
        expect(advances.get("receive-1")?.state).toBe("expired");
        expect(reservations.listForAdvance("receive-1")).toEqual([]);
        expect(fills.get("fill-3")).toMatchObject({
            state: "submitting",
            failureCode: "fill_bound_expiry_unsafe",
        });
        expect(fills.get("fill-4")?.state).toBe("submitting");
        expect(fillReservations(db)).toEqual([UNBOUND, LIVE]);

        const stuck = fills.get("fill-2")!;
        expect(stuck.state).toBe("submitting");
        expect(stuck.failureCode).toBe("fill_bound_expiry_unsafe");
        expect(stuck.failureDetail).toMatch(/receive-2/);
        expect(advances.get("receive-2")?.state).toBe("locking");
        expect(reservations.listForAdvance("receive-2")).toEqual([SECOND]);

        expect(fills.reconcileCandidates(NOW + 60).map(({ id }) => id)).toContain("fill-4");
        db.close();
    });

    it("refuses to cancel a bound fill the sweep could not expire", () => {
        const db = openDatabase(":memory:");
        const policy = configure(db);
        const quotes = new ReceiveQuoteRepository(db);
        const fills = new FillRepository(db);
        insert(quotes, policy);
        quotes.bindFill({
            quoteId: "receive-1",
            fill: boundFill(),
            advance: boundAdvance(),
            expectedPolicyRevision: policy.getSnapshot().revision,
            now: NOW,
        });
        db.prepare(
            "UPDATE receive_quotes SET state = 'expired', bound_fill_id = NULL WHERE id = 'receive-1'",
        ).run();
        expect(fills.expire(NOW + 60)).toBe(0);
        expect(() =>
            fills.reconcileCancelled(fills.get("fill-1")!, "never_invoked", NOW + 60),
        ).toThrow(/binding disagrees/);
        expect(new AdvanceRepository(db).get("receive-1")?.state).toBe("locking");
        expect(new ReservationRepository(db).listForAdvance("receive-1")).toEqual([INPUT]);
        db.close();
    });

    it("marks the linked advance locked only when the trusted fill is observed", () => {
        const db = openDatabase(":memory:");
        const policy = configure(db);
        const quotes = new ReceiveQuoteRepository(db);
        insert(quotes, policy);
        quotes.bindFill({
            quoteId: "receive-1",
            fill: boundFill(),
            advance: boundAdvance(),
            expectedPolicyRevision: policy.getSnapshot().revision,
            now: NOW,
        });
        db.prepare("UPDATE fills SET submit_invoked = 1 WHERE id = 'fill-1'").run();
        const fills = new FillRepository(db);
        expect(
            fills.reconcileSettled(
                fills.get("fill-1")!,
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
