import type { Database } from "better-sqlite3";
import { assertNativeAccess } from "./coordination.js";

export type SwapFillState = "quoted" | "submitting" | "settled" | "expired" | "cancelled";

export interface SwapFillOutpoint {
    txid: string;
    vout: number;
}

export interface SwapFillSolverInput {
    txid: string;
    vout: number;
    value: bigint;
    assets?: { assetId: SwapFillAssetId; amount: bigint }[];
}

export interface SwapFillAssetId {
    txid: Uint8Array;
    groupIndex: number;
}

export type SwapFillFare =
    | { currency: "sats"; units: bigint }
    | { currency: "asset"; assetId: SwapFillAssetId; units: bigint };

export interface SwapFillGraph {
    arkTx: string;
    checkpoints: string[];
    graphId: Uint8Array;
    // Mirror-free: outpoints and payouts are derived from arkTx at the point
    // of use, so only the digest inputs the transaction does not carry live here.
    inputOwners: readonly (string | null)[];
}

export interface SwapFill {
    id: string;
    operationId: string;
    state: SwapFillState;
    offerHex: string;
    offerTxid?: string;
    offerVout?: number;
    swapAddress?: string;
    solverInputs: SwapFillSolverInput[];
    solverProceedsScript: Uint8Array;
    solverKeys: string[];
    taxiInputs: SwapFillOutpoint[];
    contributionSats: bigint;
    sponsorScript: Uint8Array;
    fare: SwapFillFare;
    maxFare: SwapFillFare;
    graph: SwapFillGraph;
    graphId: Uint8Array;
    solverGraph?: SwapFillGraph;
    preparedArkTx?: string;
    preparedCheckpoints?: string[];
    submitInvoked: boolean;
    txid?: string;
    outpoint?: SwapFillOutpoint;
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
}

export class SwapFillClaimError extends Error {
    constructor(
        readonly code: "not_found" | "quote_expired" | "invalid_state",
        id: string,
    ) {
        super(`swap-fill claim for ${id}: ${code}`);
        this.name = "SwapFillClaimError";
    }
}

export class SwapFillReservationConflictError extends Error {
    constructor() {
        super("swap-fill: taxi input already reserved");
        this.name = "SwapFillReservationConflictError";
    }
}

const hex = (b: Uint8Array): string => Buffer.from(b).toString("hex");
const unhex = (s: string): Uint8Array => Uint8Array.from(Buffer.from(s, "hex"));

const graphToJson = (g: SwapFillGraph): string =>
    JSON.stringify({
        arkTx: g.arkTx,
        checkpoints: g.checkpoints,
        graphId: hex(g.graphId),
        inputOwners: g.inputOwners,
    });

const graphFromJson = (json: string, id: string): SwapFillGraph => {
    let raw: Record<string, unknown>;
    try {
        raw = JSON.parse(json) as Record<string, unknown>;
    } catch {
        throw new Error(`swap-fill ${id}: malformed graph json`);
    }
    if (typeof raw.arkTx !== "string" || !Array.isArray(raw.checkpoints))
        throw new Error(`swap-fill ${id}: malformed graph json`);
    if (
        !Array.isArray(raw.inputOwners) ||
        raw.inputOwners.some((o) => o !== null && typeof o !== "string")
    )
        throw new Error(`swap-fill ${id}: malformed graph json`);
    return {
        arkTx: raw.arkTx,
        checkpoints: raw.checkpoints as string[],
        graphId: unhex(raw.graphId as string),
        inputOwners: raw.inputOwners as (string | null)[],
    };
};

const fareToRow = (
    fare: SwapFillFare,
): Record<string, string | number | bigint | Uint8Array | null> => ({
    fare_currency: fare.currency,
    fare_units: fare.units,
    fare_asset_txid: fare.currency === "asset" ? fare.assetId.txid : null,
    fare_asset_group_index: fare.currency === "asset" ? fare.assetId.groupIndex : null,
});

interface SwapFillRow {
    id: string;
    operation_id: string;
    state: SwapFillState;
    offer_hex: string;
    offer_txid: string | null;
    offer_vout: bigint | null;
    swap_address: string | null;
    solver_inputs_json: string;
    solver_proceeds_script: string;
    solver_keys_json: string;
    taxi_inputs_json: string;
    contribution_sats: bigint;
    sponsor_script: string;
    fare_currency: string;
    fare_units: bigint;
    fare_asset_txid: Buffer | null;
    fare_asset_group_index: bigint | null;
    max_fare_json: string;
    graph_json: string;
    graph_id: string;
    solver_graph_json: string | null;
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
}

const fareFromRow = (r: SwapFillRow, id: string): SwapFillFare => {
    if (r.fare_currency === "asset") {
        if (r.fare_asset_txid === null || r.fare_asset_group_index === null)
            throw new Error(`swap-fill ${id}: half-populated fare asset`);
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

function fromRow(r: SwapFillRow): SwapFill {
    const solverInputs = JSON.parse(r.solver_inputs_json) as {
        txid: string;
        vout: number;
        value: string;
        assets?: { assetId: { txid: string; groupIndex: number }; amount: string }[];
    }[];
    const maxFare = JSON.parse(r.max_fare_json) as {
        currency: "sats" | "asset";
        units: string;
        assetId?: { txid: string; groupIndex: number };
    };
    const fill: SwapFill = {
        id: r.id,
        operationId: r.operation_id,
        state: r.state,
        offerHex: r.offer_hex,
        solverInputs: solverInputs.map((i) => ({
            txid: i.txid,
            vout: i.vout,
            value: BigInt(i.value),
            ...(i.assets
                ? {
                      assets: i.assets.map((a) => ({
                          assetId: {
                              txid: unhex(a.assetId.txid),
                              groupIndex: a.assetId.groupIndex,
                          },
                          amount: BigInt(a.amount),
                      })),
                  }
                : {}),
        })),
        solverProceedsScript: unhex(r.solver_proceeds_script),
        solverKeys: JSON.parse(r.solver_keys_json) as string[],
        taxiInputs: JSON.parse(r.taxi_inputs_json) as SwapFillOutpoint[],
        contributionSats: r.contribution_sats,
        sponsorScript: unhex(r.sponsor_script),
        fare: fareFromRow(r, r.id),
        maxFare:
            maxFare.currency === "asset" && maxFare.assetId
                ? {
                      currency: "asset",
                      assetId: {
                          txid: unhex(maxFare.assetId.txid),
                          groupIndex: maxFare.assetId.groupIndex,
                      },
                      units: BigInt(maxFare.units),
                  }
                : { currency: "sats", units: BigInt(maxFare.units) },
        graph: graphFromJson(r.graph_json, r.id),
        graphId: unhex(r.graph_id),
        submitInvoked: r.submit_invoked === 1n,
        attempts: Number(r.attempts),
        createdAt: Number(r.created_at),
        updatedAt: Number(r.updated_at),
        expiresAt: Number(r.expires_at),
    };
    if (r.offer_txid !== null && r.offer_vout !== null) {
        fill.offerTxid = r.offer_txid;
        fill.offerVout = Number(r.offer_vout);
    }
    if (r.swap_address !== null) fill.swapAddress = r.swap_address;
    if (r.solver_graph_json !== null) fill.solverGraph = graphFromJson(r.solver_graph_json, r.id);
    if (r.prepared_ark_tx !== null) fill.preparedArkTx = r.prepared_ark_tx;
    if (r.prepared_checkpoints_json !== null)
        fill.preparedCheckpoints = JSON.parse(r.prepared_checkpoints_json) as string[];
    if (r.txid !== null) fill.txid = r.txid;
    if (r.outpoint_txid !== null && r.outpoint_vout !== null)
        fill.outpoint = { txid: r.outpoint_txid, vout: Number(r.outpoint_vout) };
    if (r.spent_txid !== null) fill.spentTxid = r.spent_txid;
    if (r.failure_code !== null) fill.failureCode = r.failure_code;
    if (r.failure_detail !== null) fill.failureDetail = r.failure_detail;
    if (r.lease_owner !== null) fill.leaseOwner = r.lease_owner;
    if (r.lease_token !== null) fill.leaseToken = r.lease_token;
    if (r.lease_until !== null) fill.leaseUntil = Number(r.lease_until);
    if (r.next_attempt_at !== null) fill.nextAttemptAt = Number(r.next_attempt_at);
    return fill;
}

export class SwapFillRepository {
    readonly #db: Database;

    constructor(db: Database) {
        assertNativeAccess(db);
        this.#db = db;
    }

    insert(fill: SwapFill): void {
        assertNativeAccess(this.#db);
        const maxFare =
            fill.maxFare.currency === "asset"
                ? {
                      currency: "asset",
                      units: fill.maxFare.units.toString(10),
                      assetId: {
                          txid: hex(fill.maxFare.assetId.txid),
                          groupIndex: fill.maxFare.assetId.groupIndex,
                      },
                  }
                : { currency: "sats", units: fill.maxFare.units.toString(10) };
        this.#db
            .transaction(() => {
                // Cross-flow fence: an advance or proceeds job may hold this
                // coin; checked here so the database serializes the race.
                for (const input of fill.taxiInputs) {
                    if (
                        this.#db
                            .prepare(
                                "SELECT 1 FROM operator_input_reservations WHERE outpoint_txid = ? AND outpoint_vout = ?",
                            )
                            .get(input.txid, input.vout)
                    )
                        throw new SwapFillReservationConflictError();
                    if (
                        this.#db
                            .prepare(
                                "SELECT 1 FROM proceeds_inputs WHERE outpoint_txid = ? AND outpoint_vout = ?",
                            )
                            .get(input.txid, input.vout)
                    )
                        throw new SwapFillReservationConflictError();
                }
                this.#db
                    .prepare(
                        `INSERT INTO swap_fills (id, operation_id, state, offer_hex, offer_txid, offer_vout,
                         swap_address, solver_inputs_json, solver_proceeds_script, solver_keys_json,
                         taxi_inputs_json, contribution_sats, sponsor_script, fare_currency, fare_units, fare_asset_txid,
                         fare_asset_group_index, max_fare_json, graph_json, graph_id, solver_graph_json,
                         prepared_ark_tx, prepared_checkpoints_json, submit_invoked, txid, outpoint_txid,
                         outpoint_vout, spent_txid, failure_code, failure_detail, lease_owner, lease_token,
                         lease_until, attempts, next_attempt_at, created_at, updated_at, expires_at)
                         VALUES (@id, @operation_id, @state, @offer_hex, @offer_txid, @offer_vout,
                         @swap_address, @solver_inputs_json, @solver_proceeds_script, @solver_keys_json,
                         @taxi_inputs_json, @contribution_sats, @sponsor_script, @fare_currency, @fare_units, @fare_asset_txid,
                         @fare_asset_group_index, @max_fare_json, @graph_json, @graph_id, @solver_graph_json,
                         @prepared_ark_tx, @prepared_checkpoints_json, @submit_invoked, @txid, @outpoint_txid,
                         @outpoint_vout, @spent_txid, @failure_code, @failure_detail, @lease_owner, @lease_token,
                         @lease_until, @attempts, @next_attempt_at, @created_at, @updated_at, @expires_at)`,
                    )
                    .run({
                        id: fill.id,
                        operation_id: fill.operationId,
                        state: fill.state,
                        offer_hex: fill.offerHex,
                        offer_txid: fill.offerTxid ?? null,
                        offer_vout: fill.offerVout ?? null,
                        swap_address: fill.swapAddress ?? null,
                        solver_inputs_json: JSON.stringify(
                            fill.solverInputs.map((i) => ({
                                txid: i.txid,
                                vout: i.vout,
                                value: i.value.toString(10),
                                ...(i.assets
                                    ? {
                                          assets: i.assets.map((a) => ({
                                              assetId: {
                                                  txid: hex(a.assetId.txid),
                                                  groupIndex: a.assetId.groupIndex,
                                              },
                                              amount: a.amount.toString(10),
                                          })),
                                      }
                                    : {}),
                            })),
                        ),
                        solver_proceeds_script: hex(fill.solverProceedsScript),
                        solver_keys_json: JSON.stringify(fill.solverKeys),
                        taxi_inputs_json: JSON.stringify(fill.taxiInputs),
                        contribution_sats: fill.contributionSats,
                        sponsor_script: hex(fill.sponsorScript),
                        ...fareToRow(fill.fare),
                        max_fare_json: JSON.stringify(maxFare),
                        graph_json: graphToJson(fill.graph),
                        graph_id: hex(fill.graphId),
                        solver_graph_json: fill.solverGraph ? graphToJson(fill.solverGraph) : null,
                        prepared_ark_tx: fill.preparedArkTx ?? null,
                        prepared_checkpoints_json: fill.preparedCheckpoints
                            ? JSON.stringify(fill.preparedCheckpoints)
                            : null,
                        submit_invoked: fill.submitInvoked ? 1 : 0,
                        txid: fill.txid ?? null,
                        outpoint_txid: fill.outpoint?.txid ?? null,
                        outpoint_vout: fill.outpoint?.vout ?? null,
                        spent_txid: fill.spentTxid ?? null,
                        failure_code: fill.failureCode ?? null,
                        failure_detail: fill.failureDetail ?? null,
                        lease_owner: fill.leaseOwner ?? null,
                        lease_token: fill.leaseToken ?? null,
                        lease_until: fill.leaseUntil ?? null,
                        attempts: fill.attempts,
                        next_attempt_at: fill.nextAttemptAt ?? null,
                        created_at: fill.createdAt,
                        updated_at: fill.updatedAt,
                        expires_at: fill.expiresAt,
                    });
                const reserve = this.#db.prepare(
                    "INSERT INTO swap_fill_reservations (outpoint_txid, outpoint_vout, fill_id, created_at) VALUES (?, ?, ?, ?)",
                );
                for (const input of fill.taxiInputs)
                    reserve.run(input.txid, input.vout, fill.id, fill.createdAt);
            })
            .immediate();
    }

    get(id: string): SwapFill | undefined {
        assertNativeAccess(this.#db);
        const row = this.#db
            .prepare<unknown[], SwapFillRow>("SELECT * FROM swap_fills WHERE id = ?")
            .safeIntegers(true)
            .get(id);
        return row ? fromRow(row) : undefined;
    }

    getByOperation(operationId: string): SwapFill | undefined {
        assertNativeAccess(this.#db);
        const row = this.#db
            .prepare<unknown[], SwapFillRow>("SELECT * FROM swap_fills WHERE operation_id = ?")
            .safeIntegers(true)
            .get(operationId);
        return row ? fromRow(row) : undefined;
    }

    listByState(state: SwapFillState): SwapFill[] {
        assertNativeAccess(this.#db);
        return this.#db
            .prepare<unknown[], SwapFillRow>("SELECT * FROM swap_fills WHERE state = ? ORDER BY id")
            .safeIntegers(true)
            .all(state)
            .map(fromRow);
    }

    exposureTotals(): { outstandingSats: bigint; activeCount: number } {
        assertNativeAccess(this.#db);
        const row = this.#db
            .prepare<[], { total: bigint; count: bigint }>(
                `SELECT coalesce(sum(contribution_sats), 0) AS total, count(*) AS count
                 FROM swap_fills WHERE state IN ('quoted', 'submitting')`,
            )
            .safeIntegers(true)
            .get()!;
        return { outstandingSats: row.total, activeCount: Number(row.count) };
    }

    listReservedOutpoints(): SwapFillOutpoint[] {
        assertNativeAccess(this.#db);
        return this.#db
            .prepare<[], { txid: string; vout: bigint }>(
                "SELECT outpoint_txid AS txid, outpoint_vout AS vout FROM swap_fill_reservations ORDER BY txid, vout",
            )
            .safeIntegers(true)
            .all()
            .map(({ txid, vout }) => ({ txid, vout: Number(vout) }));
    }

    claimSubmit(
        id: string,
        claim: {
            leaseOwner: string;
            leaseToken: string;
            leaseUntil: number;
            solverGraph: SwapFillGraph;
            now: number;
        },
    ): SwapFill {
        assertNativeAccess(this.#db);
        const result = this.#db
            .transaction(() => {
                this.#expire(claim.now);
                const current = this.get(id);
                if (!current) throw new SwapFillClaimError("not_found", id);
                if (current.state === "expired") throw new SwapFillClaimError("quote_expired", id);
                if (current.state !== "quoted") throw new SwapFillClaimError("invalid_state", id);
                this.#db
                    .prepare(
                        `UPDATE swap_fills SET state = 'submitting', solver_graph_json = ?,
                         lease_owner = ?, lease_token = ?, lease_until = ?, attempts = attempts + 1,
                         failure_code = NULL, failure_detail = NULL, updated_at = max(updated_at, ?)
                         WHERE id = ? AND state = 'quoted'`,
                    )
                    .run(
                        graphToJson(claim.solverGraph),
                        claim.leaseOwner,
                        claim.leaseToken,
                        claim.leaseUntil,
                        claim.now,
                        id,
                    );
                return this.get(id)!;
            })
            .immediate();
        return result;
    }

    recordTaxiSigned(
        id: string,
        leaseToken: string,
        taxiGraph: SwapFillGraph,
        now: number,
    ): boolean {
        assertNativeAccess(this.#db);
        const update = this.#db
            .prepare(
                `UPDATE swap_fills SET solver_graph_json = ?, updated_at = max(updated_at, ?)
                 WHERE id = ? AND state = 'submitting' AND lease_token = ?`,
            )
            .run(graphToJson(taxiGraph), now, id, leaseToken);
        return Number(update.changes) === 1;
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
                `UPDATE swap_fills SET prepared_ark_tx = ?, prepared_checkpoints_json = ?,
                 updated_at = max(updated_at, ?) WHERE id = ? AND state = 'submitting' AND lease_token = ?`,
            )
            .run(arkTx, JSON.stringify(checkpoints), now, id, leaseToken);
        return Number(update.changes) === 1;
    }

    recordSubmitInvoked(id: string, leaseToken: string, now: number): boolean {
        assertNativeAccess(this.#db);
        const update = this.#db
            .prepare(
                `UPDATE swap_fills SET submit_invoked = 1, updated_at = max(updated_at, ?)
                 WHERE id = ? AND state = 'submitting' AND lease_token = ?`,
            )
            .run(now, id, leaseToken);
        return Number(update.changes) === 1;
    }

    renewLease(id: string, owner: string, token: string, until: number, now: number): boolean {
        assertNativeAccess(this.#db);
        const update = this.#db
            .prepare(
                `UPDATE swap_fills SET lease_until = ?, updated_at = max(updated_at, ?)
                 WHERE id = ? AND state = 'submitting' AND lease_owner = ? AND lease_token = ?`,
            )
            .run(until, now, id, owner, token);
        return Number(update.changes) === 1;
    }

    recordSettled(
        id: string,
        leaseToken: string,
        txid: string,
        outpoint: SwapFillOutpoint,
        now: number,
    ): SwapFill {
        assertNativeAccess(this.#db);
        return this.#db
            .transaction(() => {
                const update = this.#db
                    .prepare(
                        `UPDATE swap_fills SET state = 'settled', txid = ?, outpoint_txid = ?,
                         outpoint_vout = ?, lease_owner = NULL, lease_token = NULL, lease_until = NULL,
                         next_attempt_at = NULL, updated_at = max(updated_at, ?)
                         WHERE id = ? AND state = 'submitting' AND lease_token = ?`,
                    )
                    .run(txid, outpoint.txid, outpoint.vout, now, id, leaseToken);
                if (Number(update.changes) !== 1) throw new SwapFillClaimError("invalid_state", id);
                this.#release(id);
                return this.get(id)!;
            })
            .immediate();
    }

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
                `UPDATE swap_fills SET failure_code = ?, failure_detail = ?, next_attempt_at = ?,
                 lease_owner = NULL, lease_token = NULL, lease_until = NULL, updated_at = max(updated_at, ?)
                 WHERE id = ? AND state = 'submitting' AND lease_token = ?`,
            )
            .run(code, detail, nextAttemptAt, now, id, leaseToken);
    }

    recordSigningFailure(
        id: string,
        leaseToken: string,
        code: string,
        detail: string,
        now: number,
    ): void {
        assertNativeAccess(this.#db);
        this.#db
            .prepare(
                `UPDATE swap_fills SET state = 'quoted', failure_code = ?, failure_detail = ?,
                 lease_owner = NULL, lease_token = NULL, lease_until = NULL, next_attempt_at = NULL,
                 submit_invoked = 0, updated_at = max(updated_at, ?)
                 WHERE id = ? AND state = 'submitting' AND lease_token = ?`,
            )
            .run(code, detail, now, id, leaseToken);
    }

    recordCancelled(id: string, spentTxid: string, code: string, now: number): void {
        assertNativeAccess(this.#db);
        this.#db
            .transaction(() => {
                const update = this.#db
                    .prepare(
                        `UPDATE swap_fills SET state = 'cancelled', spent_txid = ?, failure_code = ?,
                         lease_owner = NULL, lease_token = NULL, lease_until = NULL, next_attempt_at = NULL,
                         updated_at = max(updated_at, ?)
                         WHERE id = ? AND state IN ('quoted', 'submitting')`,
                    )
                    .run(spentTxid, code, now, id);
                if (Number(update.changes) === 1) this.#release(id);
            })
            .immediate();
    }

    reconcileSettled(id: string, txid: string, outpoint: SwapFillOutpoint, now: number): boolean {
        assertNativeAccess(this.#db);
        return this.#db
            .transaction(() => {
                const update = this.#db
                    .prepare(
                        `UPDATE swap_fills SET state = 'settled', txid = ?, outpoint_txid = ?,
                         outpoint_vout = ?, lease_owner = NULL, lease_token = NULL, lease_until = NULL,
                         next_attempt_at = NULL, updated_at = max(updated_at, ?)
                         WHERE id = ? AND state = 'submitting' AND submit_invoked = 1`,
                    )
                    .run(txid, outpoint.txid, outpoint.vout, now, id);
                if (Number(update.changes) !== 1) return false;
                this.#release(id);
                return true;
            })
            .immediate();
    }

    reconcileRequeue(id: string, code: string, detail: string, now: number): boolean {
        assertNativeAccess(this.#db);
        const update = this.#db
            .prepare(
                `UPDATE swap_fills SET state = 'quoted', failure_code = ?, failure_detail = ?,
                 lease_owner = NULL, lease_token = NULL, lease_until = NULL, next_attempt_at = NULL,
                 submit_invoked = 0, updated_at = max(updated_at, ?)
                 WHERE id = ? AND state = 'submitting' AND submit_invoked = 0`,
            )
            .run(code, detail, now, id);
        return Number(update.changes) === 1;
    }

    expireQuotes(at: number): number {
        assertNativeAccess(this.#db);
        return this.#db
            .transaction(() => {
                const expired = this.#db
                    .prepare(
                        "UPDATE swap_fills SET state = 'expired', updated_at = max(updated_at, ?) WHERE state = 'quoted' AND expires_at <= ?",
                    )
                    .run(at, at).changes;
                this.#db
                    .prepare(
                        "DELETE FROM swap_fill_reservations WHERE fill_id IN (SELECT id FROM swap_fills WHERE state = 'expired' AND expires_at <= ?)",
                    )
                    .run(at);
                return Number(expired);
            })
            .immediate();
    }

    reconcileCandidates(now: number): SwapFill[] {
        assertNativeAccess(this.#db);
        return this.#db
            .prepare<unknown[], SwapFillRow>(
                `SELECT * FROM swap_fills WHERE state = 'submitting'
                 AND (next_attempt_at IS NULL OR next_attempt_at <= ?)
                 AND (lease_until IS NULL OR lease_until <= ?) ORDER BY id`,
            )
            .safeIntegers(true)
            .all(now, now)
            .map(fromRow);
    }

    #expire(at: number): void {
        this.#db
            .prepare(
                "UPDATE swap_fills SET state = 'expired', updated_at = max(updated_at, ?) WHERE state = 'quoted' AND expires_at <= ?",
            )
            .run(at, at);
        this.#db
            .prepare(
                "DELETE FROM swap_fill_reservations WHERE fill_id IN (SELECT id FROM swap_fills WHERE state = 'expired' AND expires_at <= ?)",
            )
            .run(at);
    }

    #release(fillId: string): void {
        this.#db.prepare("DELETE FROM swap_fill_reservations WHERE fill_id = ?").run(fillId);
    }
}
