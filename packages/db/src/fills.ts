import type { Database } from "better-sqlite3";
import { assertNativeAccess } from "./coordination.js";

/**
 * A fill is born `submitting`: `/v1/fills` validates, binds and signs inside one
 * request, so there is no quoted state between them and no window in which a
 * second caller could claim the same reservation.
 */
export type FillState = "submitting" | "settled" | "expired" | "cancelled";

export interface FillOutpoint {
    txid: string;
    vout: number;
}

export interface FillAssetId {
    txid: Uint8Array;
    groupIndex: number;
}

export type FillFare =
    | { currency: "sats"; units: bigint }
    | { currency: "asset"; assetId: FillAssetId; units: bigint };

export interface FillGraph {
    arkTx: string;
    checkpoints: string[];
}

export interface Fill {
    id: string;
    quoteId: string;
    operationId: string;
    state: FillState;
    /** Which arkTx inputs the Taxi signed; the only coins it will ever sign. */
    taxiInputs: FillOutpoint[];
    covenantOutputIndex: number;
    assetUnits: bigint;
    contributionSats: bigint;
    fare: FillFare;
    graph: FillGraph;
    graphId: Uint8Array;
    preparedArkTx?: string;
    preparedCheckpoints?: string[];
    submitInvoked: boolean;
    txid?: string;
    outpoint?: FillOutpoint;
    spentTxid?: string;
    failureCode?: string;
    failureDetail?: string;
    leaseOwner?: string;
    leaseToken?: string;
    leaseUntil?: number;
    attempts: number;
    nextAttemptAt?: number;
    createdAt: number;
    updatedAt: number;
    expiresAt: number;
    validUntil?: number;
}

export type FillClaimReason = "not_found" | "invalid_state" | "quote_expired";

export class FillClaimError extends Error {
    constructor(
        readonly reason: FillClaimReason,
        id: string,
    ) {
        super(`fill ${id}: ${reason}`);
        this.name = "FillClaimError";
    }
}

export class FillReservationConflictError extends Error {
    constructor() {
        super("fill: operator input already reserved");
        this.name = "FillReservationConflictError";
    }
}

interface FillRow {
    id: string;
    quote_id: string;
    operation_id: string;
    state: FillState;
    taxi_inputs_json: string;
    covenant_output_index: bigint;
    asset_units: bigint;
    contribution_sats: bigint;
    fare_currency: "sats" | "asset";
    fare_units: bigint;
    fare_asset_txid: Buffer | null;
    fare_asset_group_index: bigint | null;
    graph_json: string;
    graph_id: string;
    prepared_ark_tx: string | null;
    prepared_checkpoints_json: string | null;
    submit_invoked: bigint;
    txid: string | null;
    outpoint_txid: string | null;
    outpoint_vout: bigint | null;
    spent_txid: string | null;
    failure_code: string | null;
    failure_detail: string | null;
    lease_owner: string | null;
    lease_token: string | null;
    lease_until: bigint | null;
    attempts: bigint;
    next_attempt_at: bigint | null;
    created_at: bigint;
    updated_at: bigint;
    expires_at: bigint;
    valid_until: bigint | null;
}

const hex = (bytes: Uint8Array): string =>
    Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");

const unhex = (value: string): Uint8Array =>
    Uint8Array.from(value.match(/../g)?.map((byte) => Number.parseInt(byte, 16)) ?? []);

const fareFromRow = (r: FillRow): FillFare => {
    if (r.fare_currency === "asset") {
        if (r.fare_asset_txid === null || r.fare_asset_group_index === null)
            throw new Error(`fill ${r.id}: half-populated fare asset`);
        return {
            currency: "asset",
            assetId: {
                txid: Uint8Array.from(r.fare_asset_txid),
                groupIndex: Number(r.fare_asset_group_index),
            },
            units: r.fare_units,
        };
    }
    return { currency: "sats", units: r.fare_units };
};

function fromRow(r: FillRow): Fill {
    const graph = JSON.parse(r.graph_json) as FillGraph;
    return {
        id: r.id,
        quoteId: r.quote_id,
        operationId: r.operation_id,
        state: r.state,
        taxiInputs: JSON.parse(r.taxi_inputs_json) as FillOutpoint[],
        covenantOutputIndex: Number(r.covenant_output_index),
        assetUnits: r.asset_units,
        contributionSats: r.contribution_sats,
        fare: fareFromRow(r),
        graph: { arkTx: graph.arkTx, checkpoints: [...graph.checkpoints] },
        graphId: unhex(r.graph_id),
        submitInvoked: Number(r.submit_invoked) === 1,
        attempts: Number(r.attempts),
        createdAt: Number(r.created_at),
        updatedAt: Number(r.updated_at),
        expiresAt: Number(r.expires_at),
        ...(r.prepared_ark_tx === null ? {} : { preparedArkTx: r.prepared_ark_tx }),
        ...(r.prepared_checkpoints_json === null
            ? {}
            : { preparedCheckpoints: JSON.parse(r.prepared_checkpoints_json) as string[] }),
        ...(r.txid === null ? {} : { txid: r.txid }),
        ...(r.outpoint_txid === null || r.outpoint_vout === null
            ? {}
            : { outpoint: { txid: r.outpoint_txid, vout: Number(r.outpoint_vout) } }),
        ...(r.spent_txid === null ? {} : { spentTxid: r.spent_txid }),
        ...(r.failure_code === null ? {} : { failureCode: r.failure_code }),
        ...(r.failure_detail === null ? {} : { failureDetail: r.failure_detail }),
        ...(r.lease_owner === null ? {} : { leaseOwner: r.lease_owner }),
        ...(r.lease_token === null ? {} : { leaseToken: r.lease_token }),
        ...(r.lease_until === null ? {} : { leaseUntil: Number(r.lease_until) }),
        ...(r.next_attempt_at === null ? {} : { nextAttemptAt: Number(r.next_attempt_at) }),
        ...(r.valid_until === null ? {} : { validUntil: Number(r.valid_until) }),
    };
}

export class FillRepository {
    readonly #db: Database;

    constructor(db: Database) {
        assertNativeAccess(db);
        this.#db = db;
    }

    /** Inserts a fill already holding its submit lease, and reserves its coins. */
    insert(fill: Fill): void {
        assertNativeAccess(this.#db);
        this.#db
            .transaction(() => {
                // Cross-flow fence: an advance or a proceeds job may already hold
                // one of these coins. Checked here so the database serializes it.
                for (const input of fill.taxiInputs)
                    for (const [table, column] of [
                        ["operator_input_reservations", "advance_id"],
                        ["receive_quote_reservations", "quote_id"],
                        ["proceeds_inputs", "job_id"],
                        ["fill_reservations", "fill_id"],
                    ] as const)
                        if (
                            this.#db
                                .prepare(
                                    `SELECT ${column} FROM ${table} WHERE outpoint_txid = ? AND outpoint_vout = ?`,
                                )
                                .get(input.txid, input.vout)
                        )
                            throw new FillReservationConflictError();
                this.#db
                    .prepare(
                        `INSERT INTO fills (id, quote_id, operation_id, state, taxi_inputs_json,
                         covenant_output_index, asset_units, contribution_sats, fare_currency, fare_units,
                         fare_asset_txid, fare_asset_group_index, graph_json, graph_id, prepared_ark_tx,
                         prepared_checkpoints_json, submit_invoked, txid, outpoint_txid, outpoint_vout,
                         spent_txid, failure_code, failure_detail, lease_owner, lease_token, lease_until,
                         attempts, next_attempt_at, created_at, updated_at, expires_at, valid_until)
                         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                    )
                    .run(
                        fill.id,
                        fill.quoteId,
                        fill.operationId,
                        fill.state,
                        JSON.stringify(fill.taxiInputs),
                        fill.covenantOutputIndex,
                        fill.assetUnits,
                        fill.contributionSats,
                        fill.fare.currency,
                        fill.fare.units,
                        fill.fare.currency === "asset" ? Buffer.from(fill.fare.assetId.txid) : null,
                        fill.fare.currency === "asset" ? fill.fare.assetId.groupIndex : null,
                        JSON.stringify({
                            arkTx: fill.graph.arkTx,
                            checkpoints: fill.graph.checkpoints,
                        }),
                        hex(fill.graphId),
                        fill.preparedArkTx ?? null,
                        fill.preparedCheckpoints === undefined
                            ? null
                            : JSON.stringify(fill.preparedCheckpoints),
                        fill.submitInvoked ? 1 : 0,
                        fill.txid ?? null,
                        fill.outpoint?.txid ?? null,
                        fill.outpoint?.vout ?? null,
                        fill.spentTxid ?? null,
                        fill.failureCode ?? null,
                        fill.failureDetail ?? null,
                        fill.leaseOwner ?? null,
                        fill.leaseToken ?? null,
                        fill.leaseUntil ?? null,
                        fill.attempts,
                        fill.nextAttemptAt ?? null,
                        fill.createdAt,
                        fill.updatedAt,
                        fill.expiresAt,
                        fill.validUntil ?? null,
                    );
                const reserve = this.#db.prepare(
                    "INSERT INTO fill_reservations (outpoint_txid, outpoint_vout, fill_id, created_at) VALUES (?, ?, ?, ?)",
                );
                for (const input of fill.taxiInputs)
                    reserve.run(input.txid, input.vout, fill.id, fill.createdAt);
            })
            .immediate();
    }

    get(id: string): Fill | undefined {
        assertNativeAccess(this.#db);
        const row = this.#db
            .prepare<[string], FillRow>("SELECT * FROM fills WHERE id = ?")
            .safeIntegers(true)
            .get(id);
        return row ? fromRow(row) : undefined;
    }

    getByOperation(operationId: string): Fill | undefined {
        assertNativeAccess(this.#db);
        const row = this.#db
            .prepare<[string], FillRow>("SELECT * FROM fills WHERE operation_id = ?")
            .safeIntegers(true)
            .get(operationId);
        return row ? fromRow(row) : undefined;
    }

    listByState(state: FillState): Fill[] {
        assertNativeAccess(this.#db);
        return this.#db
            .prepare<[FillState], FillRow>("SELECT * FROM fills WHERE state = ? ORDER BY id")
            .safeIntegers(true)
            .all(state)
            .map(fromRow);
    }

    reconcileCandidates(now: number): Fill[] {
        assertNativeAccess(this.#db);
        return this.#db
            .prepare<[number, number], FillRow>(
                `SELECT * FROM fills WHERE state = 'submitting'
             AND (lease_until IS NULL OR lease_until <= ?)
             AND (next_attempt_at IS NULL OR next_attempt_at <= ?) ORDER BY id`,
            )
            .safeIntegers(true)
            .all(now, now)
            .map(fromRow);
    }

    reconcileSettled(snapshot: Fill, txid: string, outpoint: FillOutpoint, now: number): boolean {
        assertNativeAccess(this.#db);
        return this.#db
            .transaction(() => {
                if (!snapshot.submitInvoked || !this.#matches(snapshot, now)) return false;
                if (outpoint.txid !== txid || outpoint.vout !== snapshot.covenantOutputIndex)
                    throw new Error("fill: settlement outpoint disagrees");
                this.#lockLiability(snapshot, txid, outpoint, now);
                this.#db
                    .prepare(
                        `UPDATE fills SET state = 'settled', txid = ?, outpoint_txid = ?, outpoint_vout = ?,
                 failure_code = NULL, failure_detail = NULL, lease_owner = NULL, lease_token = NULL,
                 lease_until = NULL, next_attempt_at = NULL, updated_at = max(updated_at, ?) WHERE id = ?`,
                    )
                    .run(txid, outpoint.txid, outpoint.vout, now, snapshot.id);
                this.#release(snapshot.id);
                return true;
            })
            .immediate();
    }

    reconcileCancelled(snapshot: Fill, code: string, now: number, spentTxid?: string): boolean {
        assertNativeAccess(this.#db);
        return this.#db
            .transaction(() => {
                if (!this.#matches(snapshot, now)) return false;
                if (snapshot.submitInvoked && !spentTxid) return false;
                this.#cancelLiability(snapshot.id, code, now);
                this.#db
                    .prepare(
                        `UPDATE fills SET state = 'cancelled', spent_txid = ?, failure_code = ?,
                 lease_owner = NULL, lease_token = NULL, lease_until = NULL, next_attempt_at = NULL,
                 updated_at = max(updated_at, ?) WHERE id = ?`,
                    )
                    .run(spentTxid ?? null, code, now, snapshot.id);
                this.#release(snapshot.id);
                return true;
            })
            .immediate();
    }

    #matches(snapshot: Fill, now: number): boolean {
        const current = this.get(snapshot.id);
        return (
            current !== undefined &&
            current.state === "submitting" &&
            current.submitInvoked === snapshot.submitInvoked &&
            current.leaseToken === snapshot.leaseToken &&
            current.leaseOwner === snapshot.leaseOwner &&
            current.leaseUntil === snapshot.leaseUntil &&
            current.updatedAt === snapshot.updatedAt &&
            (current.leaseUntil === undefined || current.leaseUntil <= now)
        );
    }

    #lockLiability(fill: Fill, txid: string, outpoint: FillOutpoint, now: number): void {
        this.#assertBound(fill);
        const advance = this.#db
            .prepare<
                [string],
                {
                    state: string;
                    ark_txid: string | null;
                    outpoint_txid: string | null;
                    outpoint_vout: bigint | null;
                }
            >("SELECT state, ark_txid, outpoint_txid, outpoint_vout FROM advances WHERE id = ?")
            .safeIntegers(true)
            .get(fill.quoteId);
        if (!advance) throw new Error(`fill: linked advance ${fill.quoteId} is missing`);
        if (advance.state === "locking") {
            this.#db
                .prepare(
                    `UPDATE advances SET state = 'locked', ark_txid = ?, outpoint_txid = ?, outpoint_vout = ?,
                 last_observed_at = ?, updated_at = max(updated_at, ?), failure_code = NULL,
                 failure_detail = NULL WHERE id = ? AND state = 'locking'`,
                )
                .run(txid, outpoint.txid, outpoint.vout, now, now, fill.quoteId);
        } else if (
            !["locked", "recovering", "recycled", "purchased", "refunded", "recovered"].includes(
                advance.state,
            ) ||
            advance.ark_txid !== txid ||
            advance.outpoint_txid !== outpoint.txid ||
            Number(advance.outpoint_vout) !== outpoint.vout
        )
            throw new Error(`fill: linked advance ${fill.quoteId} observation disagrees`);
    }

    #cancelLiability(id: string, code: string, now: number): void {
        const fill = this.get(id)!;
        this.#assertBound(fill);
        const changed = this.#db
            .prepare(
                `UPDATE advances SET state = 'expired', failure_code = ?,
             submission_lease_owner = NULL, submission_lease_token = NULL, submission_lease_until = NULL,
             submission_next_attempt_at = NULL, updated_at = max(updated_at, ?)
             WHERE id = ? AND state = 'locking'`,
            )
            .run(code, now, fill.quoteId).changes;
        if (Number(changed) !== 1)
            throw new Error(`fill: linked advance ${fill.quoteId} is not locking`);
        this.#db
            .prepare("DELETE FROM operator_input_reservations WHERE advance_id = ?")
            .run(fill.quoteId);
    }

    #assertBound(fill: Fill): void {
        const quote = this.#db
            .prepare<[string], { state: string; bound_fill_id: string | null }>(
                "SELECT state, bound_fill_id FROM receive_quotes WHERE id = ?",
            )
            .get(fill.quoteId);
        if (quote?.state !== "bound" || quote.bound_fill_id !== fill.id)
            throw new Error(`fill: receive quote ${fill.quoteId} binding disagrees`);
    }

    recordPrepared(
        id: string,
        leaseToken: string,
        arkTx: string,
        checkpoints: string[],
        now: number,
    ): boolean {
        assertNativeAccess(this.#db);
        const update = this.#db
            .prepare(
                `UPDATE fills SET prepared_ark_tx = ?, prepared_checkpoints_json = ?,
                 updated_at = max(updated_at, ?) WHERE id = ? AND state = 'submitting' AND lease_token = ?`,
            )
            .run(arkTx, JSON.stringify(checkpoints), now, id, leaseToken);
        return Number(update.changes) === 1;
    }

    recordSubmitInvoked(id: string, leaseToken: string, now: number): boolean {
        assertNativeAccess(this.#db);
        const update = this.#db
            .prepare(
                `UPDATE fills SET submit_invoked = 1, updated_at = max(updated_at, ?)
                 WHERE id = ? AND state = 'submitting' AND lease_token = ?`,
            )
            .run(now, id, leaseToken);
        return Number(update.changes) === 1;
    }

    /** The provider accepted the graph. The row stays `submitting` because
     * settlement is an observation, but the txid is recorded now: without it a
     * status read and a reconciler have no transaction to follow. */
    recordSubmitted(id: string, leaseToken: string, txid: string, now: number): boolean {
        assertNativeAccess(this.#db);
        const update = this.#db
            .prepare(
                `UPDATE fills SET txid = ?, updated_at = max(updated_at, ?)
                 WHERE id = ? AND state = 'submitting' AND lease_token = ?`,
            )
            .run(txid, now, id, leaseToken);
        return Number(update.changes) === 1;
    }

    recordSettled(
        id: string,
        leaseToken: string,
        txid: string,
        outpoint: FillOutpoint,
        now: number,
    ): Fill {
        assertNativeAccess(this.#db);
        return this.#db
            .transaction(() => {
                const update = this.#db
                    .prepare(
                        `UPDATE fills SET state = 'settled', txid = ?, outpoint_txid = ?,
                         outpoint_vout = ?, lease_owner = NULL, lease_token = NULL, lease_until = NULL,
                         next_attempt_at = NULL, updated_at = max(updated_at, ?)
                         WHERE id = ? AND state = 'submitting' AND lease_token = ? AND submit_invoked = 1`,
                    )
                    .run(txid, outpoint.txid, outpoint.vout, now, id, leaseToken);
                if (Number(update.changes) !== 1) throw new FillClaimError("invalid_state", id);
                this.#lockLiability(this.get(id)!, txid, outpoint, now);
                this.#release(id);
                return this.get(id)!;
            })
            .immediate();
    }

    /** A signed graph the provider neither accepted nor refused: keep the lease
     * released, the failure recorded, and the row out of every terminal state. */
    recordAmbiguous(
        id: string,
        leaseToken: string,
        code: string,
        detail: string,
        nextAttemptAt: number,
        now: number,
    ): void {
        assertNativeAccess(this.#db);
        this.#db
            .prepare(
                `UPDATE fills SET failure_code = ?, failure_detail = ?, next_attempt_at = ?,
                 lease_owner = NULL, lease_token = NULL, lease_until = NULL, updated_at = max(updated_at, ?)
                 WHERE id = ? AND state = 'submitting' AND lease_token = ?`,
            )
            .run(code, detail, nextAttemptAt, now, id, leaseToken);
    }

    /** Nothing was submitted, so the reservation goes back and the row cancels:
     * unlike the old rail there is no quoted state to fall back to. */
    recordSigningFailure(
        id: string,
        leaseToken: string,
        code: string,
        detail: string,
        now: number,
    ): void {
        assertNativeAccess(this.#db);
        this.#db
            .transaction(() => {
                const update = this.#db
                    .prepare(
                        `UPDATE fills SET state = 'cancelled', failure_code = ?, failure_detail = ?,
                         lease_owner = NULL, lease_token = NULL, lease_until = NULL, next_attempt_at = NULL,
                         submit_invoked = 0, updated_at = max(updated_at, ?)
                         WHERE id = ? AND state = 'submitting' AND lease_token = ? AND submit_invoked = 0`,
                    )
                    .run(code, detail, now, id, leaseToken);
                if (Number(update.changes) === 1) {
                    this.#cancelLiability(id, code, now);
                    this.#release(id);
                }
            })
            .immediate();
    }

    expire(at: number): number {
        assertNativeAccess(this.#db);
        return this.#db
            .transaction(() => {
                const stale = this.#db
                    .prepare<[number, number], { id: string }>(
                        `SELECT id FROM fills WHERE state = 'submitting' AND submit_invoked = 0
                         AND expires_at <= ? AND (lease_until IS NULL OR lease_until <= ?)`,
                    )
                    .all(at, at);
                let expired = 0;
                for (const { id } of stale) {
                    try {
                        this.#db.transaction(() => {
                            this.#cancelLiability(id, "fill_submit_never_invoked", at);
                            this.#db
                                .prepare(
                                    `UPDATE fills SET state = 'expired', lease_owner = NULL, lease_token = NULL,
                                 lease_until = NULL, next_attempt_at = NULL, updated_at = max(updated_at, ?) WHERE id = ?`,
                                )
                                .run(at, id);
                            this.#release(id);
                        })();
                        expired += 1;
                    } catch (error) {
                        this.#db
                            .prepare(
                                "UPDATE fills SET failure_code = 'fill_bound_expiry_unsafe', failure_detail = ?, updated_at = max(updated_at, ?) WHERE id = ?",
                            )
                            .run(error instanceof Error ? error.message : String(error), at, id);
                    }
                }
                return expired;
            })
            .immediate();
    }

    #release(id: string): void {
        this.#db.prepare("DELETE FROM fill_reservations WHERE fill_id = ?").run(id);
    }
}
