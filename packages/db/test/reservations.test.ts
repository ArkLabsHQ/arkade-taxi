import { afterEach, beforeEach, describe, expect, it } from "vitest";
import DatabaseCtor from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Worker } from "node:worker_threads";
import type { Database } from "better-sqlite3";
import type { Advance } from "@arkade-taxi/core";
import { transition } from "@arkade-taxi/core";
import {
    AdvanceRepository,
    PolicyRepository,
    RecoveryBudgetConflictError,
    ReservationRepository,
    ProceedsRepository,
    applyMigrations,
} from "../src/index.js";

const input = (vout = 0) => ({ txid: "aa".repeat(32), vout });
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
        operatorInputs: [input()],
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
beforeEach(() => {
    db = new DatabaseCtor(":memory:");
    db.pragma("foreign_keys = ON");
    applyMigrations(db);
    advances = new AdvanceRepository(db);
    policy = new PolicyRepository(db);
    policy.update(
        {
            paused: false,
            maxOutstandingSats: 1_000n,
            maxPerPaymentTopupSats: 330n,
            maxConcurrentAdvances: 3,
            assetRules: [
                { assetId: null, enabled: true, claim: "either", maxTopupSats: null, fares: [] },
            ],
        },
        "test",
    );
    reservations = new ReservationRepository(db);
});
afterEach(() => db.close());
const reserve = (advance = quote()) =>
    reservations.reserveQuote({
        advance,
        expectedPolicyRevision: policy.getSnapshot().revision,
        recoveryExecutionBudget: { kind: advance.batchExpiry.kind, value: 1n },
    });

describe("durable reservations", () => {
    it("atomically excludes proceeds inputs from new quote reservations in both directions", () => {
        const jobs = new ProceedsRepository(db);
        jobs.create("job", { inputs: [input()] }, 1);
        expect(() => reserve()).toThrow(/already reserved/);
        expect(advances.get("quote-1")).toBeUndefined();
        jobs.complete("job", "cc".repeat(32));
        reserve();
        expect(() => jobs.create("next", { inputs: [input()] }, 2)).toThrow(/already reserved/);
        expect(jobs.get("next")).toBeUndefined();
    });
    it("serializes simultaneous claims on separate workers at 300 sats and one advance", async () => {
        const directory = mkdtempSync(join(tmpdir(), "taxi-worker-cap-"));
        const path = join(directory, "taxi.sqlite");
        const database = new DatabaseCtor(path);
        applyMigrations(database);
        const p = new PolicyRepository(database);
        p.update({ ...policy.get(), maxOutstandingSats: 300n, maxConcurrentAdvances: 1 }, "test");
        const repository = new ReservationRepository(database);
        const quotes = [quote(), quote({ id: "quote-2", operatorInputs: [input(1)] })];
        for (const advance of quotes)
            repository.reserveQuote({
                advance,
                expectedPolicyRevision: p.getSnapshot().revision,
                recoveryExecutionBudget: { kind: "height", value: 1n },
            });
        const gate = new SharedArrayBuffer(4);
        const workers: Worker[] = [];
        const ready: Promise<void>[] = [];
        const results: Promise<{ id: string; claimed?: boolean; code?: string }>[] = [];
        try {
            for (const advance of quotes) {
                const worker = new Worker(
                    `
                    const { parentPort, workerData } = require("node:worker_threads");
                    (async () => {
                        const { openDatabase, ReservationRepository } = await import(workerData.module);
                        const db = openDatabase(workerData.path);
                        parentPort.postMessage({ ready: true });
                        Atomics.wait(new Int32Array(workerData.gate), 0, 0);
                        try {
                            const result = new ReservationRepository(db).claimLockup(workerData.id, workerData.txid, "cc".repeat(32), "signed", () => 2);
                            parentPort.postMessage({ id: workerData.id, claimed: result.claimed });
                        } catch (error) { parentPort.postMessage({ id: workerData.id, code: error.code }); }
                        finally { db.close(); }
                    })().catch(error => { throw error; });
                `,
                    {
                        eval: true,
                        workerData: {
                            module: new URL("../dist/index.js", import.meta.url).href,
                            path,
                            id: advance.id,
                            txid: advance.unsignedLockupId,
                            gate,
                        },
                    },
                );
                workers.push(worker);
                ready.push(
                    new Promise((resolve, reject) => {
                        worker.once("error", reject);
                        worker.once("message", () => resolve());
                    }),
                );
                results.push(
                    new Promise((resolve, reject) => {
                        worker.once("error", reject);
                        worker.on("message", (message) => {
                            if (!message.ready) resolve(message);
                        });
                    }),
                );
            }
            await Promise.all(ready);
            Atomics.store(new Int32Array(gate), 0, 1);
            Atomics.notify(new Int32Array(gate), 0);
            const claims = await Promise.all(results);
            expect(claims.filter((claim) => claim.claimed)).toHaveLength(1);
            expect(claims.filter((claim) => claim.code === "exceeds_max_outstanding")).toHaveLength(
                1,
            );
            const rows = new AdvanceRepository(database);
            const rejected = claims.find((claim) => claim.code)!;
            expect(rows.get(rejected.id)).toEqual(quotes.find((quote) => quote.id === rejected.id));
            expect(rows.byState("locking")).toHaveLength(1);
        } finally {
            await Promise.all(workers.map((worker) => worker.terminate()));
            database.close();
            rmSync(directory, { recursive: true, force: true });
        }
    });
    it.each([
        [300n, 1, "exceeds_max_outstanding"],
        [300n, 2, "exceeds_max_outstanding"],
        [600n, 1, "max_concurrent_advances"],
    ] as const)(
        "atomically enforces claim capacity %s sats / %s advances",
        async (maxOutstandingSats, maxConcurrentAdvances, code) => {
            const directory = mkdtempSync(join(tmpdir(), "taxi-claim-cap-"));
            const first = new DatabaseCtor(join(directory, "taxi.sqlite"));
            applyMigrations(first);
            const second = new DatabaseCtor(join(directory, "taxi.sqlite"));
            try {
                const p = new PolicyRepository(first);
                p.update({ ...policy.get(), maxOutstandingSats, maxConcurrentAdvances }, "test");
                const repositories = [
                    new ReservationRepository(first),
                    new ReservationRepository(second),
                ];
                const quotes = [quote(), quote({ id: "quote-2", operatorInputs: [input(1)] })];
                for (const [i, advance] of quotes.entries())
                    repositories[i]!.reserveQuote({
                        advance,
                        expectedPolicyRevision: p.getSnapshot().revision,
                        recoveryExecutionBudget: { kind: "height", value: 1n },
                    });
                const results = await Promise.allSettled(
                    repositories.map(async (repository, i) =>
                        repository.claimLockup(
                            quotes[i]!.id,
                            quotes[i]!.unsignedLockupId,
                            "cc".repeat(32),
                            "signed",
                            () => 2,
                        ),
                    ),
                );
                expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
                expect(results[1]).toMatchObject({ status: "rejected", reason: { code } });
                const rows = new AdvanceRepository(first);
                expect(rows.get("quote-2")).toEqual(quotes[1]);
                expect(rows.byState("locking").reduce((sum, row) => sum + row.topup, 0n)).toBe(
                    300n,
                );
                expect(repositories[1]!.listForAdvance("quote-2")).toEqual([input(1)]);
                expect(
                    repositories[0]!.claimLockup(
                        "quote-1",
                        quotes[0]!.unsignedLockupId,
                        "cc".repeat(32),
                        "signed",
                        () => 2,
                    ).claimed,
                ).toBe(false);
            } finally {
                second.close();
                first.close();
                rmSync(directory, { recursive: true, force: true });
            }
        },
    );
    it.each([
        {
            kind: "height" as const,
            locktime: 100n,
            budget: 72n,
            equalExpiry: 172n,
        },
        {
            kind: "time" as const,
            locktime: 1_789_132_000n,
            budget: 43_200n,
            equalExpiry: 1_789_175_200n,
        },
    ])("atomically enforces the $kind recovery execution budget", (sample) => {
        policy.update(
            sample.kind === "height"
                ? { locktimeMarginBlocks: Number(sample.budget + 1n) }
                : { locktimeMarginSeconds: Number(sample.budget + 1n) },
            "test",
        );
        const equal = quote({
            id: `equal-${sample.kind}`,
            locktime: sample.locktime,
            recoveryLocktime: { kind: sample.kind, value: sample.locktime },
            batchExpiry: { kind: sample.kind, value: sample.equalExpiry },
        });
        expect(() =>
            reservations.reserveQuote({
                advance: equal,
                expectedPolicyRevision: policy.getSnapshot().revision,
                recoveryExecutionBudget: { kind: sample.kind, value: sample.budget },
            }),
        ).toThrow(RecoveryBudgetConflictError);
        expect(advances.get(equal.id)).toBeUndefined();

        const valid = quote({
            id: `valid-${sample.kind}`,
            operatorInputs: [input(1)],
            locktime: sample.locktime,
            recoveryLocktime: { kind: sample.kind, value: sample.locktime },
            batchExpiry: { kind: sample.kind, value: sample.equalExpiry + 1n },
        });
        reservations.reserveQuote({
            advance: valid,
            expectedPolicyRevision: policy.getSnapshot().revision,
            recoveryExecutionBudget: { kind: sample.kind, value: sample.budget },
        });
        expect(advances.get(valid.id)).toBeDefined();
    });

    it("fails closed when the policy margin changes beneath the execution budget", () => {
        const revision = policy.getSnapshot().revision;
        policy.update({ locktimeMarginBlocks: 72 }, "racing-admin");
        expect(() =>
            reservations.reserveQuote({
                advance: quote(),
                expectedPolicyRevision: revision,
                recoveryExecutionBudget: { kind: "height", value: 72n },
            }),
        ).toThrow(expect.objectContaining({ code: "policy_changed" }));
        expect(() =>
            reservations.reserveQuote({
                advance: quote(),
                expectedPolicyRevision: policy.getSnapshot().revision,
                recoveryExecutionBudget: { kind: "height", value: 72n },
            }),
        ).toThrow(RecoveryBudgetConflictError);
        expect(advances.get("quote-1")).toBeUndefined();
    });
    it("atomically stores the exact envelope digest and replays only an exact duplicate", () => {
        reserve();
        const first = reservations.claimLockup(
            "quote-1",
            "bb".repeat(32),
            "cc".repeat(32),
            "exact-sender-signed-envelope",
            () => 59,
        );
        const duplicate = reservations.claimLockup(
            "quote-1",
            "bb".repeat(32),
            "cc".repeat(32),
            "exact-sender-signed-envelope",
            () => 59,
        );
        expect(first).toMatchObject({ claimed: true, advance: { state: "locking" } });
        expect(duplicate).toMatchObject({ claimed: false, advance: { state: "locking" } });
        expect(advances.get("quote-1")?.signedEnvelopeDigest).toBe("cc".repeat(32));
        expect(advances.get("quote-1")).toMatchObject({
            submissionPhase: "claimed",
            signedLockupEnvelope: "exact-sender-signed-envelope",
        });
        expect(() =>
            reservations.claimLockup(
                "quote-1",
                "bb".repeat(32),
                "dd".repeat(32),
                "different-envelope",
                () => 59,
            ),
        ).toThrow(expect.objectContaining({ code: "envelope_conflict" }));
        expect(() =>
            reservations.claimLockup(
                "quote-1",
                "bb".repeat(32),
                "cc".repeat(32),
                "different-envelope-with-the-same-digest",
                () => 59,
            ),
        ).toThrow(expect.objectContaining({ code: "envelope_conflict" }));
    });

    it.each(["cleanup", "claim"])(
        "serializes %s winning before the competing operation across SQLite connections",
        (winner) => {
            const dir = mkdtempSync(join(tmpdir(), "taxi-claim-"));
            const first = new DatabaseCtor(join(dir, "taxi.sqlite"));
            let second: Database | undefined;
            try {
                applyMigrations(first);
                const terms = new PolicyRepository(first);
                terms.update(policy.get(), "test");
                const owner = new ReservationRepository(first);
                owner.reserveQuote({
                    advance: quote(),
                    expectedPolicyRevision: terms.getSnapshot().revision,
                    recoveryExecutionBudget: { kind: "height", value: 1n },
                });
                second = new DatabaseCtor(join(dir, "taxi.sqlite"));
                const cleaner = new ReservationRepository(second);
                if (winner === "cleanup") {
                    cleaner.expireQuotes(60);
                    expect(() =>
                        owner.claimLockup(
                            "quote-1",
                            "bb".repeat(32),
                            "cc".repeat(32),
                            "signed-envelope",
                            () => 59,
                        ),
                    ).toThrow(expect.objectContaining({ code: "quote_expired" }));
                    expect(new AdvanceRepository(first).get("quote-1")?.state).toBe("expired");
                    expect(owner.listForAdvance("quote-1")).toEqual([]);
                } else {
                    expect(
                        owner.claimLockup(
                            "quote-1",
                            "bb".repeat(32),
                            "cc".repeat(32),
                            "signed-envelope",
                            () => 59,
                        ),
                    ).toMatchObject({
                        claimed: true,
                        advance: {
                            state: "locking",
                            submittedAt: 59,
                            submissionKey: `lockup:quote-1:${"bb".repeat(32)}`,
                        },
                    });
                    expect(cleaner.expireQuotes(60)).toBe(0);
                    expect(new AdvanceRepository(second).get("quote-1")?.state).toBe("locking");
                    expect(cleaner.listForAdvance("quote-1")).toEqual([input()]);
                    expect(
                        cleaner.claimLockup(
                            "quote-1",
                            "bb".repeat(32),
                            "cc".repeat(32),
                            "signed-envelope",
                            () => 59,
                        ),
                    ).toMatchObject({ claimed: false, advance: { state: "locking" } });
                }
            } finally {
                second?.close();
                first.close();
                rmSync(dir, { recursive: true, force: true });
            }
        },
    );
    it("atomically expires a stale claim and never claims an unknown advance", () => {
        reserve();
        expect(() =>
            reservations.claimLockup(
                "quote-1",
                "bb".repeat(32),
                "cc".repeat(32),
                "signed-envelope",
                () => 60,
            ),
        ).toThrow(expect.objectContaining({ code: "quote_expired" }));
        expect(advances.get("quote-1")?.state).toBe("expired");
        expect(reservations.listReservedOutpoints()).toEqual([]);
        expect(() =>
            reservations.claimLockup(
                "unknown",
                "bb".repeat(32),
                "cc".repeat(32),
                "signed-envelope",
                () => 59,
            ),
        ).toThrow(expect.objectContaining({ code: "not_found" }));
    });
    it.each(["missing", "partial", "wrong-owner"])(
        "refuses a claim with %s input reservations",
        (corruption) => {
            reserve(quote({ operatorInputs: [input(), input(1)] }));
            if (corruption === "wrong-owner") {
                advances.insert(quote({ id: "other", operatorInputs: [input(2)] }));
                db.prepare(
                    "UPDATE operator_input_reservations SET advance_id = 'other' WHERE outpoint_vout = 1",
                ).run();
            } else {
                db.prepare(
                    `DELETE FROM operator_input_reservations ${corruption === "partial" ? "WHERE outpoint_vout = 1" : ""}`,
                ).run();
            }
            expect(() =>
                reservations.claimLockup(
                    "quote-1",
                    "bb".repeat(32),
                    "cc".repeat(32),
                    "signed-envelope",
                    () => 59,
                ),
            ).toThrow(expect.objectContaining({ code: "funding_reservation_invalid" }));
            expect(advances.get("quote-1")?.state).toBe("quoted");
            expect(advances.get("quote-1")?.submittedAt).toBeUndefined();
        },
    );
    it("expires abandoned quotes and releases reservations atomically and idempotently", () => {
        reserve();
        reserve(quote({ id: "fresh", operatorInputs: [input(1)], expiresAt: 61 }));
        reserve(quote({ id: "submitted", operatorInputs: [input(2)] }));
        advances.update(transition(advances.get("submitted")!, "locking", 59));
        expect(reservations.expireQuotes(59)).toBe(0);
        expect(reservations.expireQuotes(60)).toBe(1);
        expect(advances.get("quote-1")).toMatchObject({ state: "expired", updatedAt: 60 });
        expect(reservations.listReservedOutpoints()).toEqual([input(1), input(2)]);
        expect(new ReservationRepository(db).expireQuotes(60)).toBe(0);
        expect(advances.get("submitted")?.state).toBe("locking");
    });
    it("rolls back quote expiry when reservation deletion fails", () => {
        reserve();
        db.exec(
            "CREATE TRIGGER reject_release BEFORE DELETE ON operator_input_reservations BEGIN SELECT RAISE(ABORT, 'delete failed'); END",
        );
        expect(() => reservations.expireQuotes(60)).toThrow(/delete failed/);
        expect(advances.get("quote-1")?.state).toBe("quoted");
        expect(reservations.listReservedOutpoints()).toEqual([input()]);
        db.exec("DROP TRIGGER reject_release");
        expect(reservations.expireQuotes(60)).toBe(1);
        expect(reservations.listReservedOutpoints()).toEqual([]);
    });
    it("cleans previously expired reservations after reopening", () => {
        const dir = mkdtempSync(join(tmpdir(), "taxi-expiry-"));
        const path = join(dir, "taxi.sqlite");
        const first = new DatabaseCtor(path);
        let second: Database | undefined;
        try {
            applyMigrations(first);
            const firstPolicy = new PolicyRepository(first);
            firstPolicy.update(policy.get(), "test");
            const firstReservations = new ReservationRepository(first);
            firstReservations.reserveQuote({
                advance: quote(),
                expectedPolicyRevision: firstPolicy.getSnapshot().revision,
                recoveryExecutionBudget: { kind: "height", value: 1n },
            });
            new AdvanceRepository(first).update(transition(quote(), "expired", 60));
            first.close();
            second = new DatabaseCtor(path);
            const reopened = new ReservationRepository(second);
            expect(reopened.expireQuotes(60)).toBe(0);
            expect(reopened.listReservedOutpoints()).toEqual([]);
            expect(reopened.expireQuotes(60)).toBe(0);
        } finally {
            second?.close();
            if (first.open) first.close();
            rmSync(dir, { recursive: true, force: true });
        }
    });
    it("atomically rejects inventory reservation changes even for disjoint inputs", () => {
        const expectedReservedOutpoints = reservations.listReservedOutpoints();
        reserve();
        expect(() =>
            reservations.reserveQuote({
                advance: quote({ id: "disjoint", operatorInputs: [input(1)] }),
                expectedPolicyRevision: policy.getSnapshot().revision,
                recoveryExecutionBudget: { kind: "height", value: 1n },
                expectedReservedOutpoints,
            }),
        ).toThrow(/reservation/);
        expect(advances.get("disjoint")).toBeUndefined();
        expect(reservations.listReservedOutpoints()).toEqual([input()]);
    });
    it("identifies input conflicts separately from policy changes for bounded quote retries", () => {
        reserve();
        try {
            reserve(quote({ id: "conflicting" }));
            throw new Error("expected conflict");
        } catch (error) {
            expect((error as Error).name).toBe("ReservationConflictError");
        }
        const revision = policy.getSnapshot().revision;
        policy.update({ paused: true }, "test");
        try {
            reservations.reserveQuote({
                advance: quote({ id: "policy-changed", operatorInputs: [input(1)] }),
                expectedPolicyRevision: revision,
                recoveryExecutionBudget: { kind: "height", value: 1n },
            });
            throw new Error("expected policy error");
        } catch (error) {
            expect((error as Error).name).not.toBe("ReservationConflictError");
        }
    });
    it("persists timestamp expiry and enforces only the seconds policy margin", () => {
        policy.update({ locktimeMarginSeconds: 60 }, "test");
        const timed = quote({
            locktime: 1789132800n,
            batchExpiry: { kind: "time", value: 1789132933n },
        });
        reserve(timed);
        expect(advances.get(timed.id)?.batchExpiry).toEqual({ kind: "time", value: 1789132933n });
        expect(
            db
                .prepare(
                    "SELECT batch_expiry_kind, batch_expiry_value FROM operator_input_reservations",
                )
                .get(),
        ).toEqual({ batch_expiry_kind: "time", batch_expiry_value: 1789132933 });
        expect(() =>
            reserve(
                quote({
                    id: "too-late",
                    locktime: 1789132900n,
                    batchExpiry: { kind: "time", value: 1789132933n },
                    operatorInputs: [input(1)],
                }),
            ),
        ).toThrow(/margin/);
    });
    it("keeps reservations and revision across reopen and rejects conflicts from another connection", () => {
        const dir = mkdtempSync(join(tmpdir(), "taxi-reservations-"));
        const path = join(dir, "taxi.sqlite");
        const first = new DatabaseCtor(path);
        let second: Database | undefined;
        try {
            applyMigrations(first);
            const firstPolicy = new PolicyRepository(first);
            firstPolicy.update(policy.get(), "test");
            const revision = firstPolicy.getSnapshot().revision;
            new ReservationRepository(first).reserveQuote({
                advance: quote(),
                expectedPolicyRevision: revision,
                recoveryExecutionBudget: { kind: "height", value: 1n },
            });
            second = new DatabaseCtor(path);
            applyMigrations(second);
            expect(new PolicyRepository(second).getSnapshot().revision).toBe(revision);
            const other = new ReservationRepository(second);
            expect(other.listForAdvance("quote-1")).toEqual([input()]);
            expect(() =>
                other.reserveQuote({
                    advance: quote({ id: "quote-2" }),
                    expectedPolicyRevision: revision,
                    recoveryExecutionBudget: { kind: "height", value: 1n },
                }),
            ).toThrow(/reserved/);
            new PolicyRepository(second).update({ paused: true }, "test");
            expect(() =>
                new ReservationRepository(first).reserveQuote({
                    advance: quote({ id: "quote-3", operatorInputs: [input(3)] }),
                    expectedPolicyRevision: revision,
                    recoveryExecutionBudget: { kind: "height", value: 1n },
                }),
            ).toThrow(/policy.*changed/);
        } finally {
            second?.close();
            first.close();
            rmSync(dir, { recursive: true, force: true });
        }
    });

    it("rolls back policy fields and revision if the audit write fails", () => {
        const before = policy.getSnapshot();
        db.exec(
            "CREATE TRIGGER reject_audit BEFORE INSERT ON policy_audit BEGIN SELECT RAISE(ABORT, 'audit failed'); END",
        );
        expect(() => policy.update({ paused: true }, "test")).toThrow(/audit failed/);
        expect(policy.getSnapshot()).toEqual(before);
    });

    it("retains exact reservation heights and compares exposure above 2^53", () => {
        const large = 9_007_199_254_740_993n;
        policy.update({ maxOutstandingSats: large + 300n }, "test");
        advances.insert(quote({ id: "existing", state: "locking", topup: large, dust: large }));
        reserve(quote({ batchExpiry: { kind: "height", value: large } }));
        expect(
            db
                .prepare("SELECT batch_expiry_value FROM operator_input_reservations")
                .safeIntegers(true)
                .get(),
        ).toEqual({ batch_expiry_value: large });
        expect(() =>
            reserve(quote({ id: "too-much", topup: 301n, operatorInputs: [input(1)] })),
        ).toThrow(/outstanding/);
    });
    it("persists the quote and its inputs together", () => {
        reserve();
        expect(advances.get("quote-1")).toEqual(quote());
        expect(new ReservationRepository(db).listReservedOutpoints()).toEqual([input()]);
        expect(reservations.listForAdvance("quote-1")).toEqual([input()]);
    });
    it("rejects a changed policy revision even when values change back", () => {
        const { revision } = policy.getSnapshot();
        policy.update({ paused: true }, "test");
        policy.update({ paused: false }, "test");
        expect(() =>
            reservations.reserveQuote({
                advance: quote(),
                expectedPolicyRevision: revision,
                recoveryExecutionBudget: { kind: "height", value: 1n },
            }),
        ).toThrow(/policy.*changed/);
        expect(advances.get("quote-1")).toBeUndefined();
        expect(reservations.listReservedOutpoints()).toEqual([]);
    });
    it("does not increment revision for no-op updates and increments once per change", () => {
        const { revision } = policy.getSnapshot();
        policy.update({ paused: false }, "test");
        expect(policy.getSnapshot().revision).toBe(revision);
        policy.update({ paused: true, maxConcurrentAdvances: 2 }, "test");
        expect(policy.getSnapshot().revision).toBe(revision + 1n);
    });
    it("rolls back the new quote and every reservation on an input conflict", () => {
        reserve();
        expect(() =>
            reserve(quote({ id: "quote-2", operatorInputs: [input(1), input()] })),
        ).toThrow(/reserved|UNIQUE/);
        expect(advances.get("quote-2")).toBeUndefined();
        expect(reservations.listReservedOutpoints()).toEqual([input()]);
    });
    it("rolls back duplicate inputs within one quote", () => {
        expect(() => reserve(quote({ operatorInputs: [input(), input()] }))).toThrow();
        expect(advances.get("quote-1")).toBeUndefined();
        expect(reservations.listReservedOutpoints()).toEqual([]);
    });
    it.each(["locking", "locked", "recovering"] as const)(
        "counts %s toward exposure caps",
        (state) => {
            advances.insert(quote({ id: "existing", state, topup: 800n }));
            expect(() => reserve()).toThrow(/outstanding/);
            expect(advances.get("quote-1")).toBeUndefined();
        },
    );
    it("rechecks concurrent advance count", () => {
        policy.update({ maxConcurrentAdvances: 1 }, "test");
        advances.insert(quote({ id: "existing", state: "recovering" }));
        expect(() => reserve()).toThrow(/concurrent/);
    });
    it.each([
        { paused: true },
        { maxPerPaymentTopupSats: 299n },
        { locktimeMarginBlocks: 201 },
        { assetRules: [] },
    ])("rechecks policy limits %s", (patch) => {
        policy.update(patch, "test");
        expect(() => reserve()).toThrow();
        expect(reservations.listReservedOutpoints()).toEqual([]);
    });
    it.each(["quoted", "locking", "locked", "recovering"] as const)(
        "does not release %s reservations",
        (state) => {
            reserve();
            advances.update(quote({ state }));
            expect(() => reservations.releaseForAdvance("quote-1")).toThrow(/release/);
            expect(reservations.listForAdvance("quote-1")).toEqual([input()]);
        },
    );
    it("releases an expired quote", () => {
        reserve();
        advances.update(transition(advances.get("quote-1")!, "expired", 60));
        reservations.releaseForAdvance("quote-1");
        expect(reservations.listForAdvance("quote-1")).toEqual([]);
    });
    it.each(["recycled", "purchased", "refunded", "recovered"] as const)(
        "requires an observed spend before releasing %s",
        (state) => {
            reserve();
            const a = quote({ state });
            advances.update(a);
            expect(() => reservations.releaseForAdvance(a.id)).toThrow(/observed/);
            advances.update({ ...a, spentTxid: "cc".repeat(32), lastObservedAt: 100 });
            reservations.releaseForAdvance(a.id);
            expect(reservations.listReservedOutpoints()).toEqual([]);
        },
    );
});
