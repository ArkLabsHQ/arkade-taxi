import { beforeEach, describe, expect, it } from "vitest";
import DatabaseCtor from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Database } from "better-sqlite3";
import type { Advance } from "@arkade-taxi/core";
import { applyMigrations } from "../src/schema.js";
import { AdvanceRepository } from "../src/advances.js";
import { PolicyRepository } from "../src/policy.js";

const ABOVE_MAX_SAFE = 9_007_199_254_740_993n; // 2^53 + 1
const INT64_MAX = 9_223_372_036_854_775_807n;

function advance(overrides: Partial<Advance> = {}): Advance {
    const result: Advance = {
        id: "adv-1",
        state: "quoted",
        receiverKey: new Uint8Array(32).fill(0xa1),
        senderKey: new Uint8Array(32).fill(0xb2),
        operatorKey: new Uint8Array(32).fill(0xc3),
        dust: 330n,
        topup: 300n,
        locktime: 850_000n,
        batchExpiry: { kind: "height", value: INT64_MAX },
        operatorInputs: [{ txid: "ab".repeat(32), vout: 7 }],
        unsignedLockupTx: "unsigned-lockup",
        unsignedLockupId: "cd".repeat(32),
        covenantAddress: "tark1qcovenantexample",
        fare: { currency: "sats", units: 25n },
        createdAt: 1_757_000_000,
        updatedAt: 1_757_000_001,
        expiresAt: 1_757_000_600,
        ...overrides,
    };
    result.recoveryLocktime ??= { kind: result.batchExpiry.kind, value: result.locktime };
    return result;
}

let db: Database;
let repo: AdvanceRepository;

beforeEach(() => {
    db = new DatabaseCtor(":memory:");
    applyMigrations(db);
    repo = new AdvanceRepository(db);
});

describe("round-trip fidelity", () => {
    it.each([undefined, 0n, -1n])("rejects asset quantity %s", (assetUnits) => {
        const row = advance({
            assetId: { txid: new Uint8Array(32).fill(1), groupIndex: 0 },
            assetUnits,
        });
        expect(() => repo.insert(row)).toThrow(/asset.*quantity/i);
        repo.insert(advance());
        expect(() => repo.update(row)).toThrow(/asset.*quantity/i);
    });

    it("rejects a bitcoin advance with an asset quantity", () => {
        expect(() => repo.insert(advance({ assetUnits: 1n }))).toThrow(/asset.*quantity/i);
    });

    it("looks up deduplicated receiver keys in update and id order across states", () => {
        const BOB = new Uint8Array(32).fill(1);
        const ALICE = new Uint8Array(32).fill(2);
        for (const row of [
            advance({ id: "bob-terminal", receiverKey: BOB, state: "recycled", updatedAt: 30 }),
            advance({ id: "bob-tie-b", receiverKey: BOB, state: "locked", updatedAt: 20 }),
            advance({ id: "foreign", updatedAt: 5 }),
            advance({ id: "alice-tie-a", receiverKey: ALICE, updatedAt: 20 }),
            advance({
                id: "bob-older",
                receiverKey: BOB,
                state: "recovering",
                updatedAt: 10,
                assetId: { txid: new Uint8Array(32).fill(3), groupIndex: 0 },
                assetUnits: ABOVE_MAX_SAFE,
            }),
        ])
            repo.insert(row);
        expect(repo.byReceiverKeys([BOB, ALICE, BOB]).map(({ id }) => id)).toEqual([
            "bob-older",
            "alice-tie-a",
            "bob-tie-b",
            "bob-terminal",
        ]);
        expect(repo.byReceiverKeys([BOB])[0]?.assetUnits).toBe(ABOVE_MAX_SAFE);
        expect(repo.byReceiverKeys([ALICE]).map(({ id }) => id)).toEqual(["alice-tie-a"]);
        expect(repo.byReceiverKeys([new Uint8Array(32)])).toEqual([]);
        expect(repo.byReceiverKeys([])).toEqual([]);
    });

    it.each([0, 31, 33])("rejects a %s byte receiver key", (size) => {
        expect(() => repo.byReceiverKeys([new Uint8Array(size)])).toThrow(/32 bytes/);
    });
    it("expedites only an idle resumable submission without changing durable artifacts", () => {
        repo.insert(
            advance({
                state: "locking",
                submissionPhase: "prepared",
                preparedArkTx: "operator-signed-ark",
                preparedCheckpoints: ["checkpoint"],
                submissionNextAttemptAt: 500,
            }),
        );

        expect(repo.expediteSubmission("adv-1", 100)).toBe("expedited");
        expect(repo.get("adv-1")).toMatchObject({
            submissionPhase: "prepared",
            preparedArkTx: "operator-signed-ark",
            preparedCheckpoints: ["checkpoint"],
            submissionNextAttemptAt: 100,
        });
    });

    it("refuses submission retry for live leases, quarantine, terminal, and unknown rows", () => {
        repo.insert(
            advance({
                id: "leased",
                state: "locking",
                submissionPhase: "prepared",
                submissionLeaseOwner: "worker",
                submissionLeaseToken: "token",
                submissionLeaseUntil: 200,
            }),
        );
        repo.insert(advance({ id: "failed", state: "locking", submissionPhase: "failed" }));
        repo.insert(advance({ id: "terminal", state: "recovered" }));

        expect(repo.expediteSubmission("leased", 100)).toBe("live_lease");
        expect(repo.expediteSubmission("failed", 100)).toBe("incompatible");
        expect(repo.expediteSubmission("terminal", 100)).toBe("incompatible");
        expect(repo.expediteSubmission("missing", 100)).toBe("not_found");
    });

    it("expedites only an idle prepared recovery without changing its graph", () => {
        repo.insert(
            advance({
                state: "recovering",
                recoveryPhase: "prepared",
                recoveryGraphDigest: "11".repeat(32),
                recoveryExpectedTxid: "22".repeat(32),
                recoveryPreparedArkTx: "prepared-recovery",
                recoveryPreparedCheckpoints: ["checkpoint"],
                recoveryNextAttemptAt: 500,
            }),
        );

        expect(repo.expediteRecovery("adv-1", 100)).toBe("expedited");
        expect(repo.get("adv-1")).toMatchObject({
            recoveryPhase: "prepared",
            recoveryGraphDigest: "11".repeat(32),
            recoveryExpectedTxid: "22".repeat(32),
            recoveryPreparedArkTx: "prepared-recovery",
            recoveryPreparedCheckpoints: ["checkpoint"],
            recoveryNextAttemptAt: 100,
        });
    });

    it("refuses recovery retry for live leases, submitted quarantine, and unknown rows", () => {
        repo.insert(
            advance({
                id: "leased",
                state: "recovering",
                recoveryPhase: "prepared",
                recoveryLeaseOwner: "worker",
                recoveryLeaseToken: "token",
                recoveryLeaseUntil: 200,
            }),
        );
        repo.insert(advance({ id: "submitted", state: "recovering", recoveryPhase: "submitted" }));
        repo.insert(advance({ id: "legacy", state: "recovering", recoveryPhase: "legacy" }));

        expect(repo.expediteRecovery("leased", 100)).toBe("live_lease");
        expect(repo.expediteRecovery("submitted", 100)).toBe("incompatible");
        expect(repo.expediteRecovery("legacy", 100)).toBe("incompatible");
        expect(repo.expediteRecovery("missing", 100)).toBe("not_found");
    });

    it("leases and advances the exact durable submission artifacts with compare-and-set", () => {
        repo.insert(
            advance({
                state: "locking",
                submissionKey: "lockup:adv-1:graph",
                signedEnvelopeDigest: "11".repeat(32),
                submissionPhase: "claimed",
                signedLockupEnvelope: "sender-envelope",
            }),
        );
        const other = new AdvanceRepository(db);

        expect(repo.claimSubmissionLease("adv-1", "worker-a", "token-a", 100, 110)).toMatchObject({
            submissionPhase: "claimed",
            submissionLeaseOwner: "worker-a",
            submissionLeaseToken: "token-a",
        });
        expect(
            other.claimSubmissionLease("adv-1", "worker-b", "token-b", 105, 115),
        ).toBeUndefined();
        expect(repo.renewSubmissionLease("adv-1", "worker-a", "token-a", "claimed", 109, 120)).toBe(
            true,
        );
        expect(
            other.claimSubmissionLease("adv-1", "worker-b", "token-b", 111, 121),
        ).toBeUndefined();
        expect(
            other.recordPreparedSubmission(
                "adv-1",
                "worker-b",
                "token-b",
                "operator-signed-ark",
                ["owner-checkpoint-1", "owner-checkpoint-2"],
                105,
            ),
        ).toBe(false);
        expect(other.claimSubmissionLease("adv-1", "worker-b", "token-b", 121, 131)).toMatchObject({
            submissionLeaseOwner: "worker-b",
            submissionLeaseToken: "token-b",
        });
        expect(
            other.recordPreparedSubmission(
                "adv-1",
                "worker-b",
                "token-b",
                "operator-signed-ark",
                ["owner-checkpoint-1", "owner-checkpoint-2"],
                112,
            ),
        ).toBe(true);
        expect(
            other.recordSubmissionResponse(
                "adv-1",
                "worker-b",
                "token-b",
                "aa".repeat(32),
                "server-final-ark",
                ["server-checkpoint-1", "server-checkpoint-2"],
                113,
            ),
        ).toBe(true);
        expect(other.recordSubmissionFinalized("adv-1", "worker-b", "token-b", 124)).toBe(true);
        expect(repo.get("adv-1")).toMatchObject({
            submissionPhase: "finalized",
            preparedArkTx: "operator-signed-ark",
            preparedCheckpoints: ["owner-checkpoint-1", "owner-checkpoint-2"],
            arkTxid: "aa".repeat(32),
            serverFinalArkTx: "server-final-ark",
            serverCheckpoints: ["server-checkpoint-1", "server-checkpoint-2"],
            finalizedAt: 124,
        });
        expect(repo.get("adv-1")?.submissionLeaseOwner).toBeUndefined();
    });

    it("releases a failed phase with durable attempt metadata and backoff", () => {
        repo.insert(
            advance({
                state: "locking",
                submissionPhase: "prepared",
                preparedArkTx: "operator-signed-ark",
                preparedCheckpoints: ["checkpoint"],
            }),
        );
        expect(repo.claimSubmissionLease("adv-1", "worker-a", "token-a", 100, 110)).toBeDefined();
        expect(
            repo.recordSubmissionAttemptFailure(
                "adv-1",
                "worker-a",
                "token-a",
                "lockup_submit_ambiguous",
                "submit outcome requires reconciliation",
                101,
                130,
            ),
        ).toBe(true);
        expect(repo.get("adv-1")).toMatchObject({
            submissionPhase: "prepared",
            submissionAttempts: 1,
            submissionLastAttemptAt: 101,
            submissionNextAttemptAt: 130,
            failureCode: "lockup_submit_ambiguous",
        });
        expect(repo.claimSubmissionLease("adv-1", "worker-b", "token-b", 129, 139)).toBeUndefined();
        expect(repo.claimSubmissionLease("adv-1", "worker-b", "token-b", 130, 140)).toBeDefined();
    });

    it("persists all submission and recovery fields across repository recreation", () => {
        const a = advance({
            state: "recovering",
            submissionKey: "attempt-1",
            arkTxid: "ark-tx",
            submittedAt: 100,
            recoveryTxid: "recovery-tx",
            recoverySubmittedAt: 200,
            lastObservedAt: 300,
            failureCode: "ambiguous",
            failureDetail: "connection closed",
        });
        repo.insert(a);
        expect(new AdvanceRepository(db).get(a.id)).toEqual(a);
        repo.update(advance());
        expect(repo.get(a.id)).toEqual(advance());
    });

    it.each([
        "{}",
        "[null]",
        '[{"txid":"aa","vout":-1}]',
        "not-json",
        JSON.stringify([{ txid: "aa".repeat(32), vout: 0, secret: "bad" }]),
    ])("rejects malformed operator inputs with the advance id: %s", (json) => {
        repo.insert(advance());
        db.prepare("UPDATE advances SET operator_inputs_json = ? WHERE id = 'adv-1'").run(json);
        expect(() => repo.get("adv-1")).toThrow(/adv-1.*operator_inputs_json/);
    });

    it("serializes only public outpoint values", () => {
        const input = { txid: "ab".repeat(32), vout: 7, secret: "never persist" };
        repo.insert(advance({ operatorInputs: [input] }));
        expect(db.prepare("SELECT operator_inputs_json AS json FROM advances").get()).toEqual({
            json: JSON.stringify([{ txid: input.txid, vout: input.vout }]),
        });
    });

    it.each(["unsignedLockupTx", "unsignedLockupId"] as const)(
        "rejects a non-string %s at the persistence boundary",
        (field) => {
            expect(() =>
                repo.insert(advance({ [field]: 123 } as unknown as Partial<Advance>)),
            ).toThrow(/funding snapshot/);
        },
    );

    it.each([849_999n, 850_000n])(
        "refuses expiry at or before locktime: %s",
        (batchExpiryHeight) => {
            expect(() =>
                repo.insert(advance({ batchExpiry: { kind: "height", value: batchExpiryHeight } })),
            ).toThrow(/batch.*expiry/i);
        },
    );
    it("returns every field of a bitcoin-variant advance unchanged", () => {
        const a = advance({
            outpoint: { txid: "ab".repeat(32), vout: 3 },
            spentTxid: "cd".repeat(32),
        });

        repo.insert(a);

        expect(repo.get(a.id)).toEqual(a);
    });

    it("keeps sats and locktimes exact above Number.MAX_SAFE_INTEGER", () => {
        const a = advance({
            dust: ABOVE_MAX_SAFE,
            topup: ABOVE_MAX_SAFE - 1n,
            fare: { currency: "sats" as const, units: INT64_MAX },
            locktime: ABOVE_MAX_SAFE + 2n,
            batchExpiry: { kind: "time", value: INT64_MAX },
        });

        repo.insert(a);
        const got = repo.get(a.id)!;

        expect(got.dust).toBe(ABOVE_MAX_SAFE);
        expect(got.topup).toBe(ABOVE_MAX_SAFE - 1n);
        expect(got.fare.units).toBe(INT64_MAX);
        expect(got.locktime).toBe(ABOVE_MAX_SAFE + 2n);
        expect(got.dust).not.toBe(got.topup);
        expect(Number(got.dust)).toBe(Number(got.topup));
    });

    it("stays exact on a Database that never enabled safeIntegers", () => {
        const plain = new DatabaseCtor(":memory:");
        applyMigrations(plain);
        const a = advance({ dust: ABOVE_MAX_SAFE });

        new AdvanceRepository(plain).insert(a);

        expect(new AdvanceRepository(plain).get(a.id)?.dust).toBe(ABOVE_MAX_SAFE);
    });

    it("returns keys byte-identical and not as pooled Buffer views", () => {
        const receiverKey = Uint8Array.from({ length: 32 }, (_, i) => i * 7);
        repo.insert(advance({ receiverKey }));

        const got = repo.get("adv-1")!;

        expect(Array.from(got.receiverKey)).toEqual(Array.from(receiverKey));
        expect(got.receiverKey).toEqual(receiverKey);
        expect(got.receiverKey.byteOffset).toBe(0);
        expect(got.receiverKey.buffer.byteLength).toBe(32);
    });

    it("reports a missing assetId as undefined, never null", () => {
        repo.insert(advance());

        const got = repo.get("adv-1")!;

        expect(got.assetId).toBeUndefined();
        expect(got.assetId).not.toBeNull();
        expect("spentTxid" in got && got.spentTxid !== undefined).toBe(false);
        expect(got.outpoint).toBeUndefined();
    });

    it("round-trips an asset-variant advance through two queryable columns", () => {
        const assetId = { txid: Uint8Array.from({ length: 32 }, (_, i) => 255 - i), groupIndex: 4 };
        repo.insert(advance({ assetId, assetUnits: ABOVE_MAX_SAFE }));

        const got = repo.get("adv-1")!;

        expect(Array.from(got.assetId!.txid)).toEqual(Array.from(assetId.txid));
        expect(got.assetId!.groupIndex).toBe(4);
        expect(got.assetUnits).toBe(ABOVE_MAX_SAFE);
        repo.update({ ...got, assetUnits: ABOVE_MAX_SAFE + 1n });
        expect(repo.get(got.id)?.assetUnits).toBe(ABOVE_MAX_SAFE + 1n);
        expect(typeof got.assetId!.groupIndex).toBe("number");
        const byAsset = db
            .prepare<[number], { id: string }>(
                "SELECT id FROM advances WHERE asset_group_index = ?",
            )
            .get(4);
        expect(byAsset?.id).toBe("adv-1");
    });

    it("returns timestamps and vout as numbers, not bigints", () => {
        repo.insert(advance({ outpoint: { txid: "ef".repeat(32), vout: 2 } }));

        const got = repo.get("adv-1")!;

        expect(typeof got.createdAt).toBe("number");
        expect(typeof got.updatedAt).toBe("number");
        expect(typeof got.expiresAt).toBe("number");
        expect(typeof got.outpoint!.vout).toBe("number");
    });

    it("returns undefined for an unknown id and refuses a duplicate insert", () => {
        repo.insert(advance());

        expect(repo.get("nope")).toBeUndefined();
        expect(() => repo.insert(advance())).toThrow(/UNIQUE constraint failed/);
    });
});

describe("queries", () => {
    it("does not compare timestamp recovery with chain height", () => {
        repo.insert(
            advance({
                id: "timed",
                state: "locked",
                locktime: 1789132000n,
                batchExpiry: { kind: "time", value: 1789132933n },
            }),
        );
        expect(repo.listSweepable(200n)).toEqual([]);
        expect(repo.listSweepable(200n, 1789131999n)).toEqual([]);
        expect(repo.listSweepable(200n, 1789132000n).map((a) => a.id)).toEqual(["timed"]);
    });
    it("selects by state", () => {
        repo.insert(advance({ id: "q1", state: "quoted" }));
        repo.insert(advance({ id: "l1", state: "locked" }));
        repo.insert(advance({ id: "l2", state: "locked" }));

        expect(
            repo
                .byState("locked")
                .map((a) => a.id)
                .sort(),
        ).toEqual(["l1", "l2"]);
        expect(repo.byState("expired")).toEqual([]);
    });

    it("selects by outpoint", () => {
        const outpoint = { txid: "11".repeat(32), vout: 7 };
        repo.insert(advance({ id: "o1", outpoint }));
        repo.insert(advance({ id: "o2", outpoint: { txid: "22".repeat(32), vout: 7 } }));

        expect(repo.byOutpoint(outpoint)?.id).toBe("o1");
        expect(repo.byOutpoint({ txid: outpoint.txid, vout: 8 })).toBeUndefined();
        expect(repo.byOutpoint({ txid: "33".repeat(32), vout: 7 })).toBeUndefined();
    });

    it("lists sweepable advances oldest locktime first, matured only", () => {
        repo.insert(advance({ id: "late", state: "locked", locktime: 900n }));
        repo.insert(advance({ id: "early", state: "locked", locktime: 700n }));
        repo.insert(advance({ id: "due", state: "locked", locktime: 800n }));
        repo.insert(advance({ id: "unlocked", state: "quoted", locktime: 700n }));

        expect(repo.listSweepable(800n).map((a) => a.id)).toEqual(["early", "due"]);
        expect(repo.listSweepable(699n)).toEqual([]);
    });

    it("orders each tagged domain by expiry then locktime with a fixed kind tie order", () => {
        repo.insert(
            advance({
                id: "height-later-expiry",
                state: "locked",
                locktime: 600n,
                batchExpiry: { kind: "height", value: 1_200n },
            }),
        );
        repo.insert(
            advance({
                id: "height-earlier-expiry",
                state: "locked",
                locktime: 700n,
                batchExpiry: { kind: "height", value: 1_100n },
            }),
        );
        repo.insert(
            advance({
                id: "time",
                state: "locked",
                locktime: 1_789_132_000n,
                batchExpiry: { kind: "time", value: 1_789_133_000n },
            }),
        );

        expect(repo.listSweepable(800n, 1_789_132_000n).map((a) => a.id)).toEqual([
            "height-earlier-expiry",
            "height-later-expiry",
            "time",
        ]);
    });

    it("compares locktimes above 2^53 without collapsing them", () => {
        repo.insert(
            advance({
                id: "under",
                state: "locked",
                locktime: ABOVE_MAX_SAFE,
                batchExpiry: { kind: "time", value: INT64_MAX },
            }),
        );
        repo.insert(
            advance({
                id: "over",
                state: "locked",
                locktime: ABOVE_MAX_SAFE + 1n,
                batchExpiry: { kind: "time", value: INT64_MAX },
            }),
        );

        expect(repo.listSweepable(200n, ABOVE_MAX_SAFE).map((a) => a.id)).toEqual(["under"]);
    });

    it("sums topup per state exactly, and returns 0n for an empty state", () => {
        repo.insert(advance({ id: "s1", state: "locked", topup: ABOVE_MAX_SAFE }));
        repo.insert(advance({ id: "s2", state: "locked", topup: ABOVE_MAX_SAFE }));
        repo.insert(advance({ id: "s3", state: "quoted", topup: 5n }));

        expect(repo.sumTopupByState("locked")).toBe(ABOVE_MAX_SAFE * 2n);
        expect(repo.sumTopupByState("quoted")).toBe(5n);
        expect(repo.sumTopupByState("refunded")).toBe(0n);
    });
});

describe("update", () => {
    it("records a proved spend and releases reservations in one immediate transaction", () => {
        repo.insert(
            advance({
                state: "locked",
                outpoint: { txid: "ef".repeat(32), vout: 0 },
            }),
        );
        db.prepare("INSERT INTO operator_input_reservations VALUES (?, ?, ?, ?, ?, ?)").run(
            "ab".repeat(32),
            7,
            "adv-1",
            "height",
            900000,
            1,
        );
        db.exec(`CREATE TRIGGER fail_release BEFORE DELETE ON operator_input_reservations
                 BEGIN SELECT raise(ABORT, 'release failed'); END`);

        expect(() =>
            repo.recordSpendObservation("adv-1", "locked", "purchased", "12".repeat(32), 500, {
                hash: "34".repeat(32),
                height: 700000,
            }),
        ).toThrow(/release failed/);
        expect(repo.get("adv-1")).toMatchObject({ state: "locked" });

        db.exec("DROP TRIGGER fail_release");
        expect(
            repo.recordSpendObservation("adv-1", "locked", "purchased", "12".repeat(32), 500, {
                hash: "34".repeat(32),
                height: 700000,
            }),
        ).toBe("recorded");
        expect(repo.get("adv-1")).toMatchObject({
            state: "purchased",
            spentTxid: "12".repeat(32),
            lastObservedAt: 500,
            observationTipHash: "34".repeat(32),
            observationTipHeight: 700000,
        });
        expect(db.prepare("SELECT count(*) AS n FROM operator_input_reservations").get()).toEqual({
            n: 0,
        });
    });

    it("makes an identical terminal observation a no-op and preserves competing evidence", () => {
        repo.insert(
            advance({
                state: "locked",
                outpoint: { txid: "ef".repeat(32), vout: 0 },
            }),
        );
        const tip = { hash: "34".repeat(32), height: 700000 };
        expect(
            repo.recordSpendObservation("adv-1", "locked", "refunded", "12".repeat(32), 500, tip),
        ).toBe("recorded");
        expect(
            repo.recordSpendObservation("adv-1", "locked", "refunded", "12".repeat(32), 500, tip),
        ).toBe("duplicate");
        expect(
            repo.recordSpendObservation("adv-1", "locked", "purchased", "56".repeat(32), 501, {
                hash: "78".repeat(32),
                height: 700000,
            }),
        ).toBe("disagreement");
        expect(repo.get("adv-1")).toMatchObject({
            state: "refunded",
            spentTxid: "12".repeat(32),
            failureCode: "covenant_observation_disagreement",
        });
        expect(new PolicyRepository(db).get().paused).toBe(true);
    });

    it("does not roll a terminal tip baseline backward on a stale stable-observation race", () => {
        repo.insert(
            advance({
                state: "locked",
                outpoint: { txid: "ef".repeat(32), vout: 0 },
            }),
        );
        const spentTxid = "12".repeat(32);
        expect(
            repo.recordSpendObservation("adv-1", "locked", "purchased", spentTxid, 500, {
                hash: "34".repeat(32),
                height: 700001,
            }),
        ).toBe("recorded");
        expect(
            repo.recordStableSpendObservation("adv-1", "purchased", spentTxid, 501, {
                hash: "56".repeat(32),
                height: 700000,
                time: 1_757_000_000,
            }),
        ).toBe("disagreement");
        repo.recordSpendDisagreement("adv-1", "replacement requires stable evidence", 502, {
            hash: "78".repeat(32),
            height: 700001,
        });
        for (const at of [503, 504]) {
            expect(
                repo.recordStableSpendObservation("adv-1", "purchased", spentTxid, at, {
                    hash: "56".repeat(32),
                    height: 700000,
                    time: 1_757_000_000,
                }),
            ).toBe("disagreement");
        }
        expect(repo.get("adv-1")).toMatchObject({
            observationTipHash: "34".repeat(32),
            observationTipHeight: 700001,
            failureCode: "covenant_observation_disagreement",
        });
        expect(repo.get("adv-1")?.observationStableTipHash).toBeUndefined();
        expect(repo.get("adv-1")?.observationStableTipHeight).toBeUndefined();
        expect(new PolicyRepository(db).get().paused).toBe(true);
    });

    it("persists an equal-height replacement pair across connections and reopen", () => {
        const dir = mkdtempSync(join(tmpdir(), "taxi-stable-pair-"));
        const path = join(dir, "taxi.sqlite");
        const first = new DatabaseCtor(path);
        let second: Database | undefined;
        try {
            applyMigrations(first);
            const firstRepo = new AdvanceRepository(first);
            firstRepo.insert(
                advance({
                    state: "locked",
                    outpoint: { txid: "ef".repeat(32), vout: 0 },
                }),
            );
            const spentTxid = "12".repeat(32);
            firstRepo.recordSpendObservation("adv-1", "locked", "purchased", spentTxid, 500, {
                hash: "34".repeat(32),
                height: 700001,
            });
            firstRepo.recordSpendDisagreement("adv-1", "same-height replacement", 501, {
                hash: "56".repeat(32),
                height: 700001,
            });
            second = new DatabaseCtor(path);
            const secondRepo = new AdvanceRepository(second);
            expect(
                secondRepo.recordStableSpendObservation("adv-1", "purchased", spentTxid, 502, {
                    hash: "56".repeat(32),
                    height: 700001,
                    time: 1_757_000_000,
                }),
            ).toBe("pending");
            expect(secondRepo.get("adv-1")?.observationStableTipHeight).toBe(700001);
            second.close();
            second = new DatabaseCtor(path);
            const reopenedRepo = new AdvanceRepository(second);
            expect(
                reopenedRepo.recordStableSpendObservation("adv-1", "purchased", spentTxid, 503, {
                    hash: "56".repeat(32),
                    height: 700001,
                    time: 1_757_000_000,
                }),
            ).toBe("cleared");
            expect(reopenedRepo.get("adv-1")).toMatchObject({
                observationTipHash: "56".repeat(32),
                observationTipHeight: 700001,
            });
            expect(new PolicyRepository(second).get().paused).toBe(true);
        } finally {
            second?.close();
            first.close();
            rmSync(dir, { recursive: true, force: true });
        }
    });

    it("advances a healthy terminal baseline only to a higher tip pair", () => {
        repo.insert(
            advance({
                state: "locked",
                outpoint: { txid: "ef".repeat(32), vout: 0 },
            }),
        );
        const spentTxid = "12".repeat(32);
        repo.recordSpendObservation("adv-1", "locked", "purchased", spentTxid, 500, {
            hash: "34".repeat(32),
            height: 700001,
        });
        expect(
            repo.recordStableSpendObservation("adv-1", "purchased", spentTxid, 501, {
                hash: "56".repeat(32),
                height: 700002,
                time: 1_757_000_000,
            }),
        ).toBe("advanced");
        expect(repo.get("adv-1")).toMatchObject({
            observationTipHash: "56".repeat(32),
            observationTipHeight: 700002,
        });
    });

    it.each([
        { hash: "bad", height: 700001, time: 1_757_000_000 },
        { hash: "56".repeat(32), height: -1, time: 1_757_000_000 },
        { hash: "56".repeat(32), height: 700001, time: Number.NaN },
    ])("rejects an invalid stable candidate identity inside the transaction", (tip) => {
        repo.insert(
            advance({
                state: "locked",
                outpoint: { txid: "ef".repeat(32), vout: 0 },
            }),
        );
        const spentTxid = "12".repeat(32);
        repo.recordSpendObservation("adv-1", "locked", "purchased", spentTxid, 500, {
            hash: "34".repeat(32),
            height: 700001,
        });
        repo.recordSpendDisagreement("adv-1", "replacement", 501, {
            hash: "56".repeat(32),
            height: 700001,
        });
        expect(repo.recordStableSpendObservation("adv-1", "purchased", spentTxid, 502, tip)).toBe(
            "disagreement",
        );
        expect(repo.get("adv-1")?.observationStableTipHash).toBeUndefined();
        expect(new PolicyRepository(db).get().paused).toBe(true);
    });

    it("retains a persisted terminal winner when canonical evidence disagrees", () => {
        repo.insert(
            advance({
                state: "recovered",
                spentTxid: "ab".repeat(32),
                outpoint: { txid: "ef".repeat(32), vout: 0 },
            }),
        );
        expect(
            repo.recordSpendObservation("adv-1", "recovering", "purchased", "12".repeat(32), 500, {
                hash: "34".repeat(32),
                height: 700000,
            }),
        ).toBe("disagreement");
        expect(repo.get("adv-1")).toMatchObject({
            state: "recovered",
            failureCode: "covenant_observation_disagreement",
        });
        expect(repo.get("adv-1")?.spentTxid).toBe("ab".repeat(32));
        expect(new PolicyRepository(db).get().paused).toBe(true);
    });

    it("shares the recovery claim across independent database connections", () => {
        const dir = mkdtempSync(join(tmpdir(), "taxi-recovery-claim-"));
        const first = new DatabaseCtor(join(dir, "taxi.sqlite"));
        let second: Database | undefined;
        try {
            applyMigrations(first);
            second = new DatabaseCtor(join(dir, "taxi.sqlite"));
            const firstRepo = new AdvanceRepository(first);
            const secondRepo = new AdvanceRepository(second);
            firstRepo.insert(advance({ state: "locked" }));
            expect(firstRepo.claimRecovery("adv-1", 100)).toBeDefined();
            expect(secondRepo.claimRecovery("adv-1", 101)).toBeUndefined();
            expect(secondRepo.get("adv-1")!.recoverySubmittedAt).toBe(100);
        } finally {
            second?.close();
            first.close();
            rmSync(dir, { recursive: true, force: true });
        }
    });

    it("rolls back a recovery claim when the persisted snapshot is unsafe", () => {
        repo.insert(advance({ state: "locked" }));
        db.prepare("UPDATE advances SET unsigned_lockup_tx = NULL WHERE id = 'adv-1'").run();
        expect(() => repo.claimRecovery("adv-1", 100)).toThrow(/missing funding snapshot/);
        expect(db.prepare("SELECT state FROM advances WHERE id = 'adv-1'").get()).toEqual({
            state: "locked",
        });
    });

    it("records unresolved failure metadata while retaining observed timestamps", () => {
        const before = advance({ state: "locking", lastObservedAt: 50, updatedAt: 200 });
        repo.insert(before);
        repo.recordLockupFailure(before.id, "ambiguous", "needs reconciliation", 100);
        expect(repo.get(before.id)).toEqual({
            ...before,
            failureCode: "ambiguous",
            failureDetail: "needs reconciliation",
        });
    });
    it("records late lockup metadata without overwriting a newer observation", () => {
        const observed = advance({
            state: "locked",
            outpoint: { txid: "dd".repeat(32), vout: 2 },
            lastObservedAt: 200,
            updatedAt: 200,
        });
        repo.insert(observed);
        repo.recordLockupSubmission(observed.id, "aa".repeat(32), 100);
        repo.recordLockupFailure(observed.id, "ambiguous", "late failure", 300);
        expect(repo.get(observed.id)).toEqual({ ...observed, arkTxid: "aa".repeat(32) });
    });

    it("records late recovery metadata without overwriting a terminal spend", () => {
        const observed = advance({
            state: "recovered",
            spentTxid: "spent",
            lastObservedAt: 200,
            updatedAt: 200,
        });
        repo.insert(observed);
        repo.recordRecoverySubmission(observed.id, "recovery", 100);
        expect(repo.get(observed.id)).toEqual({ ...observed, recoveryTxid: "recovery" });
    });

    it("atomically claims locked recovery once across repository instances", () => {
        repo.insert(advance({ state: "locked", lastObservedAt: 50 }));
        const other = new AdvanceRepository(db);
        expect(repo.claimRecovery("adv-1", 100)).toMatchObject({
            state: "recovering",
            recoverySubmittedAt: 100,
            lastObservedAt: 50,
        });
        expect(other.claimRecovery("adv-1", 101)).toBeUndefined();
        expect(other.get("adv-1")!.recoverySubmittedAt).toBe(100);
    });

    it.each(["quoted", "locking", "recovering", "recovered", "expired"] as const)(
        "does not claim recovery from %s",
        (state) => {
            repo.insert(advance({ state }));
            expect(repo.claimRecovery("adv-1", 100)).toBeUndefined();
            expect(repo.get("adv-1")!.state).toBe(state);
        },
    );
    it("overwrites every mutable field", () => {
        repo.insert(advance());
        const moved: Advance = {
            ...advance(),
            state: "locked",
            outpoint: { txid: "99".repeat(32), vout: 1 },
            spentTxid: "88".repeat(32),
            topup: ABOVE_MAX_SAFE,
            updatedAt: 1_757_000_900,
        };

        repo.update(moved);

        expect(repo.get("adv-1")).toEqual(moved);
    });

    it("clears optional fields back to undefined", () => {
        repo.insert(
            advance({
                outpoint: { txid: "99".repeat(32), vout: 1 },
                spentTxid: "88".repeat(32),
                assetId: { txid: new Uint8Array(32).fill(1), groupIndex: 2 },
                assetUnits: 1n,
            }),
        );

        repo.update(advance());

        const got = repo.get("adv-1")!;
        expect(got.outpoint).toBeUndefined();
        expect(got.spentTxid).toBeUndefined();
        expect(got.assetId).toBeUndefined();
        expect(got.assetUnits).toBeUndefined();
    });

    it("refuses to silently no-op on an unknown id", () => {
        expect(() => repo.update(advance({ id: "ghost" }))).toThrow(/ghost/);
    });
});
