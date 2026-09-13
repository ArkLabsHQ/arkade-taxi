import type { Database } from "better-sqlite3";
import type { Outpoint } from "@arkade-taxi/core";
import { assertNativeAccess } from "./coordination.js";

export interface ProceedsPlan {
    inputs: Outpoint[];
    [field: string]: unknown;
}
export interface ProceedsJob {
    id: string;
    plan: ProceedsPlan;
    state: "pending" | "settling" | "quarantined" | "complete";
    blocker: string | null;
    commitmentTxid: string | null;
}
export interface ProceedsSubmissionEvidence {
    state: "unsubmitted" | "entered";
    localIntents: string[];
}
type Row = Omit<ProceedsJob, "plan"> & { plan_json: string };
const columns = "id, plan_json, state, blocker, commitment_txid AS commitmentTxid";
const decode = (row: Row | undefined): ProceedsJob | undefined =>
    row && {
        id: row.id,
        plan: JSON.parse(row.plan_json),
        state: row.state,
        blocker: row.blocker,
        commitmentTxid: row.commitmentTxid,
    };

export class ProceedsRepository {
    constructor(private readonly db: Database) {
        assertNativeAccess(db);
    }

    active(): ProceedsJob | undefined {
        assertNativeAccess(this.db);
        return decode(
            this.db
                .prepare<[], Row>(`SELECT ${columns} FROM proceeds_jobs WHERE state != 'complete'`)
                .get(),
        );
    }
    get(id: string): ProceedsJob | undefined {
        assertNativeAccess(this.db);
        return decode(
            this.db
                .prepare<[string], Row>(`SELECT ${columns} FROM proceeds_jobs WHERE id = ?`)
                .get(id),
        );
    }
    claim(id: string, owner: string, now: number, until: number): boolean {
        assertNativeAccess(this.db);
        return (
            Number(
                this.db
                    .prepare(
                        "UPDATE proceeds_jobs SET lease_owner = ?, lease_until = ? WHERE id = ? AND state != 'complete' AND (lease_until IS NULL OR lease_until < ? OR lease_owner = ?)",
                    )
                    .run(owner, until, id, now, owner).changes,
            ) === 1
        );
    }
    assertLease(id: string, owner: string, now: number): void {
        assertNativeAccess(this.db);
        if (
            !this.db
                .prepare(
                    "SELECT 1 FROM proceeds_jobs WHERE id = ? AND lease_owner = ? AND lease_until >= ? AND state != 'complete'",
                )
                .get(id, owner, now)
        )
            throw new Error("proceeds_lease_lost");
    }
    submissionEvidence(id: string): ProceedsSubmissionEvidence {
        assertNativeAccess(this.db);
        const row = this.db
            .prepare<[string], { state: string }>(
                "SELECT submission_state AS state FROM proceeds_jobs WHERE id = ?",
            )
            .get(id);
        if (row?.state !== "unsubmitted" && row?.state !== "entered")
            throw new Error("proceeds_submission_evidence_missing");
        return {
            state: row.state,
            localIntents: this.db
                .prepare<[string], { digest: string }>(
                    "SELECT digest FROM proceeds_local_intents WHERE job_id = ? ORDER BY digest",
                )
                .all(id)
                .map(({ digest }) => digest),
        };
    }
    rememberLocalIntent(id: string, owner: string, now: number, digest: string): void {
        assertNativeAccess(this.db);
        this.db
            .transaction(() => {
                this.assertLease(id, owner, now);
                if (this.submissionEvidence(id).state !== "unsubmitted")
                    throw new Error("proceeds_submission_ambiguous");
                this.db
                    .prepare(
                        "INSERT OR IGNORE INTO proceeds_local_intents (job_id, digest) VALUES (?, ?)",
                    )
                    .run(id, digest);
            })
            .immediate();
    }
    enterSubmission(id: string, owner: string, now: number, digest: string): void {
        assertNativeAccess(this.db);
        this.db
            .transaction(() => {
                this.assertLease(id, owner, now);
                const evidence = this.submissionEvidence(id);
                if (evidence.state !== "unsubmitted")
                    throw new Error("proceeds_submission_ambiguous");
                if (!evidence.localIntents.includes(digest))
                    throw new Error("proceeds_intent_unbound");
                this.db
                    .prepare("UPDATE proceeds_jobs SET submission_state = 'entered' WHERE id = ?")
                    .run(id);
            })
            .immediate();
    }
    create(
        id: string,
        plan: ProceedsPlan,
        at: number,
        expectedReserved?: readonly Outpoint[],
    ): void {
        assertNativeAccess(this.db);
        this.db
            .transaction(() => {
                if (this.active()) throw new Error("proceeds job already active");
                if (expectedReserved) {
                    const current = this.db
                        .prepare<[], { txid: string; vout: number }>(
                            "SELECT outpoint_txid AS txid, outpoint_vout AS vout FROM operator_input_reservations UNION ALL SELECT outpoint_txid, outpoint_vout FROM proceeds_inputs",
                        )
                        .all();
                    const expected = new Set(expectedReserved.map((o) => `${o.txid}:${o.vout}`));
                    if (
                        current.length !== expected.size ||
                        current.some((o) => !expected.has(`${o.txid}:${o.vout}`))
                    )
                        throw new Error("proceeds_reservation_changed");
                }
                if (!plan.inputs.length) throw new Error("proceeds inputs empty");
                this.db
                    .prepare(
                        "INSERT INTO proceeds_jobs (id, plan_json, state, created_at) VALUES (?, ?, 'pending', ?)",
                    )
                    .run(id, JSON.stringify(plan), at);
                for (const input of plan.inputs) {
                    if (
                        this.db
                            .prepare(
                                "SELECT 1 FROM operator_input_reservations WHERE outpoint_txid = ? AND outpoint_vout = ?",
                            )
                            .get(input.txid, input.vout)
                    )
                        throw new Error("proceeds input already reserved");
                    this.db
                        .prepare("INSERT INTO proceeds_inputs VALUES (?, ?, ?)")
                        .run(input.txid, input.vout, id);
                }
            })
            .immediate();
    }
    update(
        id: string,
        state: Exclude<ProceedsJob["state"], "complete">,
        blocker: string | null,
        commitmentTxid: string | null,
    ): void {
        assertNativeAccess(this.db);
        this.db
            .prepare(
                "UPDATE proceeds_jobs SET state = ?, blocker = ?, commitment_txid = coalesce(?, commitment_txid) WHERE id = ? AND state != 'complete'",
            )
            .run(state, blocker, commitmentTxid, id);
    }
    complete(id: string, commitmentTxid: string): void {
        assertNativeAccess(this.db);
        this.db
            .transaction(() => {
                if (!/^[a-f0-9]{64}$/.test(commitmentTxid))
                    throw new Error("proceeds commitment invalid");
                this.db
                    .prepare(
                        "UPDATE proceeds_jobs SET state = 'complete', blocker = NULL, commitment_txid = ? WHERE id = ?",
                    )
                    .run(commitmentTxid, id);
                this.db.prepare("DELETE FROM proceeds_inputs WHERE job_id = ?").run(id);
            })
            .immediate();
    }
}
