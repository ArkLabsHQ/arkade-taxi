import type { Database, Statement } from "better-sqlite3";
import type { Advance, AdvanceState, Outpoint } from "@arkade-taxi/core";
import { validateFundingSnapshot } from "@arkade-taxi/core";
import { assertNativeAccess } from "./coordination.js";
import { PolicyRepository } from "./policy.js";

const COLUMNS = [
    "id",
    "state",
    "receiver_key",
    "sender_key",
    "operator_key",
    "dust",
    "topup",
    "asset_txid",
    "asset_group_index",
    "asset_units",
    "locktime",
    "covenant_address",
    "fare_currency",
    "fare_units",
    "fare_asset_txid",
    "fare_asset_group_index",
    "outpoint_txid",
    "outpoint_vout",
    "spent_txid",
    "created_at",
    "updated_at",
    "expires_at",
    "batch_expiry_kind",
    "batch_expiry_value",
    "recovery_locktime_kind",
    "operator_inputs_json",
    "unsigned_lockup_tx",
    "unsigned_lockup_id",
    "submission_key",
    "signed_envelope_digest",
    "submission_phase",
    "signed_lockup_envelope",
    "prepared_ark_tx",
    "prepared_checkpoints_json",
    "server_final_ark_tx",
    "server_checkpoints_json",
    "submission_lease_owner",
    "submission_lease_token",
    "submission_lease_until",
    "submission_attempts",
    "submission_last_attempt_at",
    "submission_next_attempt_at",
    "finalized_at",
    "ark_txid",
    "submitted_at",
    "recovery_txid",
    "recovery_submitted_at",
    "recovery_phase",
    "recovery_graph_digest",
    "recovery_expected_txid",
    "recovery_prepared_ark_tx",
    "recovery_prepared_checkpoints_json",
    "recovery_response_ark_tx",
    "recovery_response_checkpoints_json",
    "recovery_lease_owner",
    "recovery_lease_token",
    "recovery_lease_until",
    "recovery_attempts",
    "recovery_last_attempt_at",
    "recovery_next_attempt_at",
    "last_observed_at",
    "observation_tip_hash",
    "observation_tip_height",
    "observation_stable_tip_hash",
    "observation_stable_tip_height",
    "observation_stable_count",
    "failure_code",
    "failure_detail",
] as const;

type AdvanceParams = Record<(typeof COLUMNS)[number], string | number | bigint | Uint8Array | null>;

interface AdvanceRow {
    id: string;
    state: AdvanceState;
    receiver_key: Buffer;
    sender_key: Buffer;
    operator_key: Buffer;
    dust: bigint;
    topup: bigint;
    asset_txid: Buffer | null;
    asset_group_index: bigint | null;
    asset_units: bigint | null;
    locktime: bigint;
    covenant_address: string;
    fare_currency: string;
    fare_units: bigint;
    fare_asset_txid: Uint8Array | null;
    fare_asset_group_index: bigint | null;
    outpoint_txid: string | null;
    outpoint_vout: bigint | null;
    spent_txid: string | null;
    created_at: bigint;
    updated_at: bigint;
    expires_at: bigint;
    batch_expiry_kind: "height" | "time" | null;
    batch_expiry_value: bigint | null;
    recovery_locktime_kind: "height" | "time" | null;
    operator_inputs_json: string | null;
    unsigned_lockup_tx: string | null;
    unsigned_lockup_id: string | null;
    submission_key: string | null;
    signed_envelope_digest: string | null;
    submission_phase:
        "claimed" | "prepared" | "responded" | "finalized" | "failed" | "legacy" | null;
    signed_lockup_envelope: string | null;
    prepared_ark_tx: string | null;
    prepared_checkpoints_json: string | null;
    server_final_ark_tx: string | null;
    server_checkpoints_json: string | null;
    submission_lease_owner: string | null;
    submission_lease_token: string | null;
    submission_lease_until: bigint | null;
    submission_attempts: bigint;
    submission_last_attempt_at: bigint | null;
    submission_next_attempt_at: bigint | null;
    finalized_at: bigint | null;
    ark_txid: string | null;
    submitted_at: bigint | null;
    recovery_txid: string | null;
    recovery_submitted_at: bigint | null;
    recovery_phase: "prepared" | "submitted" | "failed" | "legacy" | null;
    recovery_graph_digest: string | null;
    recovery_expected_txid: string | null;
    recovery_prepared_ark_tx: string | null;
    recovery_prepared_checkpoints_json: string | null;
    recovery_response_ark_tx: string | null;
    recovery_response_checkpoints_json: string | null;
    recovery_lease_owner: string | null;
    recovery_lease_token: string | null;
    recovery_lease_until: bigint | null;
    recovery_attempts: bigint;
    recovery_last_attempt_at: bigint | null;
    recovery_next_attempt_at: bigint | null;
    last_observed_at: bigint | null;
    observation_tip_hash: string | null;
    observation_tip_height: bigint | null;
    observation_stable_tip_hash: string | null;
    observation_stable_tip_height: bigint | null;
    observation_stable_count: bigint;
    failure_code: string | null;
    failure_detail: string | null;
}

export type RetryExpediteResult = "expedited" | "not_found" | "incompatible" | "live_lease";

export interface PreparedRecoveryRecord {
    digest: string;
    expectedTxid: string;
    arkTx: string;
    checkpoints: string[];
}

const INSERT_SQL = `INSERT INTO advances (${COLUMNS.join(", ")})
    VALUES (${COLUMNS.map((c) => `@${c}`).join(", ")})`;

const UPDATE_SQL = `UPDATE advances SET ${COLUMNS.filter((c) => c !== "id")
    .map((c) => `${c} = @${c}`)
    .join(", ")} WHERE id = @id`;

/** Copies out of the pooled Buffer: `.buffer` on it is 8KB of unrelated rows. */
const bytes = (b: Buffer): Uint8Array => Uint8Array.from(b);

const stringArray = (json: string, id: string): string[] => {
    try {
        const value: unknown = JSON.parse(json);
        if (!Array.isArray(value) || value.some((item) => typeof item !== "string"))
            throw new Error();
        return value;
    } catch {
        throw new Error(`advance ${id}: malformed submission checkpoint artifacts`);
    }
};

function toParams(a: Advance): AdvanceParams {
    validateFundingSnapshot(a);
    if (
        (a.assetId === undefined) !== (a.assetUnits === undefined) ||
        (a.assetUnits !== undefined && (typeof a.assetUnits !== "bigint" || a.assetUnits <= 0n))
    )
        throw new Error(
            `advance ${a.id}: asset quantity must be positive exactly when assetId is present`,
        );
    return {
        id: a.id,
        state: a.state,
        receiver_key: a.receiverKey,
        sender_key: a.senderKey,
        operator_key: a.operatorKey,
        dust: a.dust,
        topup: a.topup,
        asset_txid: a.assetId?.txid ?? null,
        asset_group_index: a.assetId?.groupIndex ?? null,
        asset_units: a.assetUnits ?? null,
        locktime: a.locktime,
        covenant_address: a.covenantAddress,
        fare_currency: a.fare.currency,
        fare_units: a.fare.units,
        fare_asset_txid: a.fare.currency === "asset" ? a.fare.assetId.txid : null,
        fare_asset_group_index: a.fare.currency === "asset" ? a.fare.assetId.groupIndex : null,
        outpoint_txid: a.outpoint?.txid ?? null,
        outpoint_vout: a.outpoint?.vout ?? null,
        spent_txid: a.spentTxid ?? null,
        created_at: a.createdAt,
        updated_at: a.updatedAt,
        expires_at: a.expiresAt,
        batch_expiry_kind: a.batchExpiry.kind,
        batch_expiry_value: a.batchExpiry.value,
        recovery_locktime_kind: a.recoveryLocktime?.kind ?? null,
        operator_inputs_json: JSON.stringify(
            a.operatorInputs.map(({ txid, vout }) => ({ txid, vout })),
        ),
        unsigned_lockup_tx: a.unsignedLockupTx,
        unsigned_lockup_id: a.unsignedLockupId,
        submission_key: a.submissionKey ?? null,
        signed_envelope_digest: a.signedEnvelopeDigest ?? null,
        submission_phase: a.submissionPhase ?? null,
        signed_lockup_envelope: a.signedLockupEnvelope ?? null,
        prepared_ark_tx: a.preparedArkTx ?? null,
        prepared_checkpoints_json: a.preparedCheckpoints
            ? JSON.stringify(a.preparedCheckpoints)
            : null,
        server_final_ark_tx: a.serverFinalArkTx ?? null,
        server_checkpoints_json: a.serverCheckpoints ? JSON.stringify(a.serverCheckpoints) : null,
        submission_lease_owner: a.submissionLeaseOwner ?? null,
        submission_lease_token: a.submissionLeaseToken ?? null,
        submission_lease_until: a.submissionLeaseUntil ?? null,
        submission_attempts: a.submissionAttempts ?? 0,
        submission_last_attempt_at: a.submissionLastAttemptAt ?? null,
        submission_next_attempt_at: a.submissionNextAttemptAt ?? null,
        finalized_at: a.finalizedAt ?? null,
        ark_txid: a.arkTxid ?? null,
        submitted_at: a.submittedAt ?? null,
        recovery_txid: a.recoveryTxid ?? null,
        recovery_submitted_at: a.recoverySubmittedAt ?? null,
        recovery_phase: a.recoveryPhase ?? null,
        recovery_graph_digest: a.recoveryGraphDigest ?? null,
        recovery_expected_txid: a.recoveryExpectedTxid ?? null,
        recovery_prepared_ark_tx: a.recoveryPreparedArkTx ?? null,
        recovery_prepared_checkpoints_json: a.recoveryPreparedCheckpoints
            ? JSON.stringify(a.recoveryPreparedCheckpoints)
            : null,
        recovery_response_ark_tx: a.recoveryResponseArkTx ?? null,
        recovery_response_checkpoints_json: a.recoveryResponseCheckpoints
            ? JSON.stringify(a.recoveryResponseCheckpoints)
            : null,
        recovery_lease_owner: a.recoveryLeaseOwner ?? null,
        recovery_lease_token: a.recoveryLeaseToken ?? null,
        recovery_lease_until: a.recoveryLeaseUntil ?? null,
        recovery_attempts: a.recoveryAttempts ?? 0,
        recovery_last_attempt_at: a.recoveryLastAttemptAt ?? null,
        recovery_next_attempt_at: a.recoveryNextAttemptAt ?? null,
        last_observed_at: a.lastObservedAt ?? null,
        observation_tip_hash: a.observationTipHash ?? null,
        observation_tip_height: a.observationTipHeight ?? null,
        observation_stable_tip_hash: a.observationStableTipHash ?? null,
        observation_stable_tip_height: a.observationStableTipHeight ?? null,
        observation_stable_count: a.observationStableCount ?? 0,
        failure_code: a.failureCode ?? null,
        failure_detail: a.failureDetail ?? null,
    };
}

// Optional fields are left absent rather than set to null: the domain contract
// says `undefined`. Timestamps and indices are narrowed back to `number`, which
// safeIntegers would otherwise hand back as BigInt.
function fromRow(r: AdvanceRow): Advance {
    if (
        r.batch_expiry_kind === null ||
        r.batch_expiry_value === null ||
        r.operator_inputs_json === null ||
        r.unsigned_lockup_tx === null ||
        r.unsigned_lockup_id === null
    ) {
        throw new Error(`advance ${r.id}: missing funding snapshot`);
    }
    let operatorInputs: Outpoint[];
    try {
        const parsed: unknown = JSON.parse(r.operator_inputs_json);
        if (
            !Array.isArray(parsed) ||
            parsed.length === 0 ||
            parsed.some(
                (input) =>
                    !input ||
                    typeof input !== "object" ||
                    Object.keys(input).length !== 2 ||
                    typeof input.txid !== "string" ||
                    !/^[0-9a-f]{64}$/.test(input.txid) ||
                    !Number.isInteger(input.vout) ||
                    input.vout < 0 ||
                    input.vout > 0xffff_ffff,
            )
        ) {
            throw new Error("invalid outpoint array");
        }
        operatorInputs = parsed;
    } catch {
        throw new Error(`advance ${r.id}: malformed operator_inputs_json`);
    }
    const a: Advance = {
        id: r.id,
        state: r.state,
        receiverKey: bytes(r.receiver_key),
        senderKey: bytes(r.sender_key),
        operatorKey: bytes(r.operator_key),
        dust: r.dust,
        topup: r.topup,
        locktime: r.locktime,
        covenantAddress: r.covenant_address,
        fare:
            r.fare_currency === "asset"
                ? {
                      currency: "asset",
                      assetId: {
                          txid: bytes(r.fare_asset_txid as Parameters<typeof bytes>[0]),
                          groupIndex: Number(r.fare_asset_group_index),
                      },
                      units: r.fare_units,
                  }
                : { currency: "sats", units: r.fare_units },
        createdAt: Number(r.created_at),
        updatedAt: Number(r.updated_at),
        expiresAt: Number(r.expires_at),
        batchExpiry: { kind: r.batch_expiry_kind, value: r.batch_expiry_value },
        operatorInputs,
        unsignedLockupTx: r.unsigned_lockup_tx,
        unsignedLockupId: r.unsigned_lockup_id,
    };
    if (r.recovery_locktime_kind !== null)
        a.recoveryLocktime = { kind: r.recovery_locktime_kind, value: r.locktime };
    if (r.asset_txid !== null) {
        a.assetId = { txid: bytes(r.asset_txid), groupIndex: Number(r.asset_group_index) };
    }
    if (r.asset_units !== null) a.assetUnits = r.asset_units;
    if (r.outpoint_txid !== null) {
        a.outpoint = { txid: r.outpoint_txid, vout: Number(r.outpoint_vout) };
    }
    if (r.spent_txid !== null) a.spentTxid = r.spent_txid;
    if (r.submission_key !== null) a.submissionKey = r.submission_key;
    if (r.signed_envelope_digest !== null) a.signedEnvelopeDigest = r.signed_envelope_digest;
    if (r.submission_phase !== null) a.submissionPhase = r.submission_phase;
    if (r.signed_lockup_envelope !== null) a.signedLockupEnvelope = r.signed_lockup_envelope;
    if (r.prepared_ark_tx !== null) a.preparedArkTx = r.prepared_ark_tx;
    if (r.prepared_checkpoints_json !== null)
        a.preparedCheckpoints = stringArray(r.prepared_checkpoints_json, r.id);
    if (r.server_final_ark_tx !== null) a.serverFinalArkTx = r.server_final_ark_tx;
    if (r.server_checkpoints_json !== null)
        a.serverCheckpoints = stringArray(r.server_checkpoints_json, r.id);
    if (r.submission_lease_owner !== null) a.submissionLeaseOwner = r.submission_lease_owner;
    if (r.submission_lease_token !== null) a.submissionLeaseToken = r.submission_lease_token;
    if (r.submission_lease_until !== null)
        a.submissionLeaseUntil = Number(r.submission_lease_until);
    if (r.submission_attempts > 0n) a.submissionAttempts = Number(r.submission_attempts);
    if (r.submission_last_attempt_at !== null)
        a.submissionLastAttemptAt = Number(r.submission_last_attempt_at);
    if (r.submission_next_attempt_at !== null)
        a.submissionNextAttemptAt = Number(r.submission_next_attempt_at);
    if (r.finalized_at !== null) a.finalizedAt = Number(r.finalized_at);
    if (r.ark_txid !== null) a.arkTxid = r.ark_txid;
    if (r.submitted_at !== null) a.submittedAt = Number(r.submitted_at);
    if (r.recovery_txid !== null) a.recoveryTxid = r.recovery_txid;
    if (r.recovery_submitted_at !== null) a.recoverySubmittedAt = Number(r.recovery_submitted_at);
    if (r.recovery_phase !== null) a.recoveryPhase = r.recovery_phase;
    if (r.recovery_graph_digest !== null) a.recoveryGraphDigest = r.recovery_graph_digest;
    if (r.recovery_expected_txid !== null) a.recoveryExpectedTxid = r.recovery_expected_txid;
    if (r.recovery_prepared_ark_tx !== null) a.recoveryPreparedArkTx = r.recovery_prepared_ark_tx;
    if (r.recovery_prepared_checkpoints_json !== null)
        a.recoveryPreparedCheckpoints = stringArray(r.recovery_prepared_checkpoints_json, r.id);
    if (r.recovery_response_ark_tx !== null) a.recoveryResponseArkTx = r.recovery_response_ark_tx;
    if (r.recovery_response_checkpoints_json !== null)
        a.recoveryResponseCheckpoints = stringArray(r.recovery_response_checkpoints_json, r.id);
    if (r.recovery_lease_owner !== null) a.recoveryLeaseOwner = r.recovery_lease_owner;
    if (r.recovery_lease_token !== null) a.recoveryLeaseToken = r.recovery_lease_token;
    if (r.recovery_lease_until !== null) a.recoveryLeaseUntil = Number(r.recovery_lease_until);
    if (r.recovery_attempts > 0n) a.recoveryAttempts = Number(r.recovery_attempts);
    if (r.recovery_last_attempt_at !== null)
        a.recoveryLastAttemptAt = Number(r.recovery_last_attempt_at);
    if (r.recovery_next_attempt_at !== null)
        a.recoveryNextAttemptAt = Number(r.recovery_next_attempt_at);
    if (r.last_observed_at !== null) a.lastObservedAt = Number(r.last_observed_at);
    if (r.observation_tip_hash !== null) a.observationTipHash = r.observation_tip_hash;
    if (r.observation_tip_height !== null)
        a.observationTipHeight = Number(r.observation_tip_height);
    if (r.observation_stable_tip_hash !== null)
        a.observationStableTipHash = r.observation_stable_tip_hash;
    if (r.observation_stable_tip_height !== null)
        a.observationStableTipHeight = Number(r.observation_stable_tip_height);
    if (r.observation_stable_count > 0n)
        a.observationStableCount = Number(r.observation_stable_count);
    if (r.failure_code !== null) a.failureCode = r.failure_code;
    if (r.failure_detail !== null) a.failureDetail = r.failure_detail;
    return a;
}

export class AdvanceRepository {
    readonly #db: Database;
    readonly #missingFunding: Statement<[], { id: string }>;
    readonly #insert: Statement<[AdvanceParams]>;
    readonly #update: Statement<[AdvanceParams]>;
    readonly #get: Statement<[string], AdvanceRow>;
    readonly #byState: Statement<[AdvanceState], AdvanceRow>;
    readonly #byReceiverKeys = new Map<number, Statement<Buffer[], AdvanceRow>>();
    readonly #byOutpoint: Statement<[string, number], AdvanceRow>;
    readonly #sweepable: Statement<[bigint, bigint | null], AdvanceRow>;
    readonly #sumTopup: Statement<[AdvanceState], { total: bigint | null }>;
    readonly #lockupSubmission: Statement<[string, number, string]>;
    readonly #lockupFailure: Statement<[string, string, number, string]>;
    readonly #lockupObserved: Statement<[string, string, number, number, number, string]>;
    readonly #recoverySubmission: Statement<[string, number, string]>;
    readonly #claimRecovery: Statement<[number, number, string], AdvanceRow>;

    constructor(db: Database) {
        assertNativeAccess(db);
        this.#db = db;
        // Per statement, not per connection: a caller's Database default must not
        // decide whether a sats value survives above 2^53.
        const read = <B extends unknown[], R>(sql: string): Statement<B, R> =>
            db.prepare<B, R>(sql).safeIntegers(true);

        this.#insert = db.prepare(INSERT_SQL);
        this.#update = db.prepare(UPDATE_SQL);
        this.#get = read("SELECT * FROM advances WHERE id = ?");
        this.#byState = read("SELECT * FROM advances WHERE state = ?");
        this.#byOutpoint = read(
            "SELECT * FROM advances WHERE outpoint_txid = ? AND outpoint_vout = ?",
        );
        this.#sweepable = read(
            `SELECT * FROM advances WHERE state = 'locked' AND
             recovery_locktime_kind = batch_expiry_kind AND
             ((recovery_locktime_kind = 'height' AND locktime <= ?) OR
              (recovery_locktime_kind = 'time' AND locktime <= ?))
             ORDER BY CASE recovery_locktime_kind WHEN 'height' THEN 0 ELSE 1 END,
                      batch_expiry_value ASC, locktime ASC, id ASC`,
        );
        this.#sumTopup = read("SELECT sum(topup) AS total FROM advances WHERE state = ?");
        this.#missingFunding =
            read(`SELECT id FROM advances WHERE batch_expiry_kind IS NULL OR batch_expiry_value IS NULL
            OR operator_inputs_json IS NULL OR unsigned_lockup_tx IS NULL OR unsigned_lockup_id IS NULL ORDER BY id`);
        this.#lockupSubmission = db.prepare(`UPDATE advances SET ark_txid = coalesce(ark_txid, ?),
            updated_at = max(updated_at, ?) WHERE id = ? AND state IN ('locking', 'locked')`);
        this.#lockupFailure = db.prepare(`UPDATE advances SET failure_code = ?, failure_detail = ?,
            updated_at = max(updated_at, ?) WHERE id = ? AND state = 'locking'`);
        this.#lockupObserved =
            db.prepare(`UPDATE advances SET state = 'locked', ark_txid = coalesce(ark_txid, ?),
            outpoint_txid = ?, outpoint_vout = ?, last_observed_at = ?, updated_at = max(updated_at, ?),
            failure_code = NULL, failure_detail = NULL WHERE id = ? AND state = 'locking'`);
        this.#recoverySubmission =
            db.prepare(`UPDATE advances SET recovery_txid = coalesce(recovery_txid, ?),
            updated_at = max(updated_at, ?) WHERE id = ?`);
        this.#claimRecovery =
            read(`UPDATE advances SET state = 'recovering', recovery_submitted_at = ?,
            updated_at = max(updated_at, ?) WHERE id = ? AND state = 'locked' RETURNING *`);
    }

    insert(a: Advance): void {
        assertNativeAccess(this.#db);
        this.#insert.run(toParams(a));
    }

    listMissingFundingSnapshotIds(): string[] {
        assertNativeAccess(this.#db);
        return this.#missingFunding.all().map(({ id }) => id);
    }

    get(id: string): Advance | undefined {
        assertNativeAccess(this.#db);
        const row = this.#get.get(id);
        return row && fromRow(row);
    }

    byState(s: AdvanceState): Advance[] {
        assertNativeAccess(this.#db);
        return this.#byState.all(s).map(fromRow);
    }

    byReceiverKeys(receiverKeys: readonly Uint8Array[]): Advance[] {
        assertNativeAccess(this.#db);
        const keys = new Map<string, Buffer>();
        for (const key of receiverKeys) {
            if (key.length !== 32) throw new Error("receiver key must be 32 bytes");
            const buffer = Buffer.from(key);
            keys.set(buffer.toString("hex"), buffer);
        }
        if (keys.size === 0) return [];
        let statement = this.#byReceiverKeys.get(keys.size);
        if (!statement) {
            statement = this.#db
                .prepare<Buffer[], AdvanceRow>(
                    `SELECT * FROM advances WHERE receiver_key IN (${Array(keys.size).fill("?").join(", ")})
                     ORDER BY updated_at ASC, id ASC`,
                )
                .safeIntegers(true);
            this.#byReceiverKeys.set(keys.size, statement);
        }
        return statement.all(...keys.values()).map(fromRow);
    }

    byOutpoint(o: Outpoint): Advance | undefined {
        assertNativeAccess(this.#db);
        const row = this.#byOutpoint.get(o.txid, o.vout);
        return row && fromRow(row);
    }

    update(a: Advance): void {
        assertNativeAccess(this.#db);
        if (this.#update.run(toParams(a)).changes === 0) {
            throw new Error(`advance ${a.id} not found`);
        }
    }

    expediteSubmission(id: string, at: number): RetryExpediteResult {
        assertNativeAccess(this.#db);
        return this.#db
            .transaction(() => {
                const current = this.get(id);
                if (!current) return "not_found" as const;
                if (
                    current.state !== "locking" ||
                    !current.submissionPhase ||
                    !["claimed", "prepared", "responded"].includes(current.submissionPhase)
                )
                    return "incompatible" as const;
                if (
                    current.submissionLeaseOwner !== undefined &&
                    (current.submissionLeaseUntil === undefined ||
                        current.submissionLeaseUntil > at)
                )
                    return "live_lease" as const;
                const changed = this.#db
                    .prepare(
                        `UPDATE advances SET submission_next_attempt_at = ?, updated_at = max(updated_at, ?)
                         WHERE id = ? AND state = 'locking'
                         AND submission_phase IN ('claimed', 'prepared', 'responded')
                         AND (submission_lease_owner IS NULL OR submission_lease_until <= ?)`,
                    )
                    .run(at, at, id, at).changes;
                return changed === 1 ? ("expedited" as const) : ("incompatible" as const);
            })
            .immediate();
    }

    expediteRecovery(id: string, at: number): RetryExpediteResult {
        assertNativeAccess(this.#db);
        return this.#db
            .transaction(() => {
                const current = this.get(id);
                if (!current) return "not_found" as const;
                if (current.state !== "recovering" || current.recoveryPhase !== "prepared")
                    return "incompatible" as const;
                if (
                    current.recoveryLeaseOwner !== undefined &&
                    (current.recoveryLeaseUntil === undefined || current.recoveryLeaseUntil > at)
                )
                    return "live_lease" as const;
                const changed = this.#db
                    .prepare(
                        `UPDATE advances SET recovery_next_attempt_at = ?, updated_at = max(updated_at, ?)
                         WHERE id = ? AND state = 'recovering' AND recovery_phase = 'prepared'
                         AND (recovery_lease_owner IS NULL OR recovery_lease_until <= ?)`,
                    )
                    .run(at, at, id, at).changes;
                return changed === 1 ? ("expedited" as const) : ("incompatible" as const);
            })
            .immediate();
    }

    claimSubmissionLease(
        id: string,
        owner: string,
        token: string,
        at: number,
        leaseUntil: number,
    ): Advance | undefined {
        assertNativeAccess(this.#db);
        const row = this.#db
            .prepare<[string, string, number, string, number, number], AdvanceRow>(
                `UPDATE advances SET submission_lease_owner = ?, submission_lease_token = ?, submission_lease_until = ?
                 WHERE id = ? AND state = 'locking' AND submission_phase IN ('claimed', 'prepared', 'responded')
                 AND (submission_lease_owner IS NULL OR submission_lease_until <= ?)
                 AND (submission_next_attempt_at IS NULL OR submission_next_attempt_at <= ?)
                 RETURNING *`,
            )
            .safeIntegers(true)
            .get(owner, token, leaseUntil, id, at, at);
        return row && fromRow(row);
    }

    renewSubmissionLease(
        id: string,
        owner: string,
        token: string,
        phase: "claimed" | "prepared" | "responded",
        at: number,
        leaseUntil: number,
    ): boolean {
        assertNativeAccess(this.#db);
        return (
            this.#db
                .prepare(
                    `UPDATE advances SET submission_lease_until = ? WHERE id = ? AND state = 'locking'
                     AND submission_phase = ? AND submission_lease_owner = ?
                     AND submission_lease_token = ? AND submission_lease_until > ?`,
                )
                .run(leaseUntil, id, phase, owner, token, at).changes === 1
        );
    }

    recordPreparedSubmission(
        id: string,
        owner: string,
        token: string,
        arkTx: string,
        checkpoints: string[],
        at: number,
    ): boolean {
        assertNativeAccess(this.#db);
        return (
            this.#db
                .prepare(
                    `UPDATE advances SET submission_phase = 'prepared', prepared_ark_tx = ?,
                     prepared_checkpoints_json = ?, updated_at = max(updated_at, ?)
                     WHERE id = ? AND state = 'locking' AND submission_phase = 'claimed'
                     AND submission_lease_owner = ? AND submission_lease_token = ?`,
                )
                .run(arkTx, JSON.stringify(checkpoints), at, id, owner, token).changes === 1
        );
    }

    recordSubmissionResponse(
        id: string,
        owner: string,
        token: string,
        arkTxid: string,
        finalArkTx: string,
        checkpoints: string[],
        at: number,
    ): boolean {
        assertNativeAccess(this.#db);
        return (
            this.#db
                .prepare(
                    `UPDATE advances SET submission_phase = 'responded', ark_txid = ?,
                     server_final_ark_tx = ?, server_checkpoints_json = ?, updated_at = max(updated_at, ?)
                     WHERE id = ? AND state = 'locking' AND submission_phase = 'prepared'
                     AND submission_lease_owner = ? AND submission_lease_token = ?`,
                )
                .run(arkTxid, finalArkTx, JSON.stringify(checkpoints), at, id, owner, token)
                .changes === 1
        );
    }

    recordSubmissionFinalized(id: string, owner: string, token: string, at: number): boolean {
        assertNativeAccess(this.#db);
        return (
            this.#db
                .prepare(
                    `UPDATE advances SET submission_phase = 'finalized', finalized_at = ?,
                     submission_lease_owner = NULL, submission_lease_token = NULL,
                     submission_lease_until = NULL,
                     failure_code = NULL, failure_detail = NULL, updated_at = max(updated_at, ?)
                     WHERE id = ? AND state = 'locking' AND submission_phase = 'responded'
                     AND submission_lease_owner = ? AND submission_lease_token = ?`,
                )
                .run(at, at, id, owner, token).changes === 1
        );
    }

    claimRecoveryLease(
        id: string,
        owner: string,
        token: string,
        at: number,
        leaseUntil: number,
        prepared?: PreparedRecoveryRecord,
    ): Advance | undefined {
        assertNativeAccess(this.#db);
        return this.#db
            .transaction(() => {
                const current = this.get(id);
                if (!current) throw new Error(`advance ${id} not found`);
                if (current.state === "locked") {
                    if (!prepared) throw new Error(`advance ${id}: missing prepared recovery`);
                    validateFundingSnapshot(current);
                    const changed = this.#db
                        .prepare(
                            `UPDATE advances SET state = 'recovering', recovery_phase = 'prepared',
                             recovery_graph_digest = ?, recovery_expected_txid = ?,
                             recovery_prepared_ark_tx = ?, recovery_prepared_checkpoints_json = ?,
                             recovery_lease_owner = ?, recovery_lease_token = ?, recovery_lease_until = ?,
                             recovery_next_attempt_at = NULL, updated_at = max(updated_at, ?)
                             WHERE id = ? AND state = 'locked' AND recovery_phase IS NULL`,
                        )
                        .run(
                            prepared.digest,
                            prepared.expectedTxid,
                            prepared.arkTx,
                            JSON.stringify(prepared.checkpoints),
                            owner,
                            token,
                            leaseUntil,
                            at,
                            id,
                        ).changes;
                    return changed === 1 ? this.get(id) : undefined;
                }
                if (current.state !== "recovering" || current.recoveryPhase !== "prepared")
                    return undefined;
                const changed = this.#db
                    .prepare(
                        `UPDATE advances SET recovery_lease_owner = ?, recovery_lease_token = ?,
                         recovery_lease_until = ? WHERE id = ? AND state = 'recovering'
                         AND recovery_phase = 'prepared'
                         AND (recovery_lease_owner IS NULL OR recovery_lease_until <= ?)
                         AND (recovery_next_attempt_at IS NULL OR recovery_next_attempt_at <= ?)`,
                    )
                    .run(owner, token, leaseUntil, id, at, at).changes;
                return changed === 1 ? this.get(id) : undefined;
            })
            .immediate();
    }

    recordRecoveryPreparationFailure(
        id: string,
        code: string,
        detail: string,
        at: number,
    ): boolean {
        assertNativeAccess(this.#db);
        return this.#db
            .transaction(() => {
                const changed =
                    this.#db
                        .prepare(
                            `UPDATE advances SET state = 'recovering', recovery_phase = 'failed',
                             recovery_attempts = recovery_attempts + 1,
                             recovery_last_attempt_at = ?, recovery_next_attempt_at = NULL,
                             failure_code = ?, failure_detail = ?, updated_at = max(updated_at, ?)
                             WHERE id = ? AND state = 'locked' AND recovery_phase IS NULL`,
                        )
                        .run(at, code, detail, at, id).changes === 1;
                if (changed) new PolicyRepository(this.#db).update({ paused: true }, "recovery");
                return changed;
            })
            .immediate();
    }

    renewRecoveryLease(
        id: string,
        owner: string,
        token: string,
        at: number,
        leaseUntil: number,
    ): boolean {
        assertNativeAccess(this.#db);
        return (
            this.#db
                .prepare(
                    `UPDATE advances SET recovery_lease_until = ? WHERE id = ?
                     AND state = 'recovering' AND recovery_phase = 'prepared'
                     AND recovery_lease_owner = ? AND recovery_lease_token = ?
                     AND recovery_lease_until > ?`,
                )
                .run(leaseUntil, id, owner, token, at).changes === 1
        );
    }

    recordRecoveryResponse(
        id: string,
        owner: string,
        token: string,
        txid: string,
        signedArkTx: string,
        signedCheckpoints: string[],
        at: number,
    ): boolean {
        assertNativeAccess(this.#db);
        return (
            this.#db
                .prepare(
                    `UPDATE advances SET recovery_phase = 'submitted', recovery_txid = ?,
                     recovery_submitted_at = ?, recovery_response_ark_tx = ?,
                     recovery_response_checkpoints_json = ?, recovery_lease_owner = NULL,
                     recovery_lease_token = NULL, recovery_lease_until = NULL,
                     recovery_next_attempt_at = NULL,
                     failure_code = NULL, failure_detail = NULL, updated_at = max(updated_at, ?)
                     WHERE id = ? AND state = 'recovering' AND recovery_phase = 'prepared'
                     AND recovery_expected_txid = ? AND recovery_lease_owner = ?
                     AND recovery_lease_token = ?`,
                )
                .run(
                    txid,
                    at,
                    signedArkTx,
                    JSON.stringify(signedCheckpoints),
                    at,
                    id,
                    txid,
                    owner,
                    token,
                ).changes === 1
        );
    }

    recordRecoveryAttemptFailure(
        id: string,
        owner: string,
        token: string,
        code: string,
        detail: string,
        at: number,
        nextAttemptAt: number,
    ): boolean {
        assertNativeAccess(this.#db);
        return (
            this.#db
                .prepare(
                    `UPDATE advances SET recovery_attempts = recovery_attempts + 1,
                     recovery_last_attempt_at = ?, recovery_next_attempt_at = ?,
                     recovery_lease_owner = NULL, recovery_lease_token = NULL,
                     recovery_lease_until = NULL, failure_code = ?, failure_detail = ?,
                     updated_at = max(updated_at, ?) WHERE id = ? AND state = 'recovering'
                     AND recovery_phase = 'prepared' AND recovery_lease_owner = ?
                     AND recovery_lease_token = ?`,
                )
                .run(at, nextAttemptAt, code, detail, at, id, owner, token).changes === 1
        );
    }

    recordPermanentRecoveryFailure(
        id: string,
        owner: string,
        token: string,
        code: string,
        detail: string,
        at: number,
    ): boolean {
        assertNativeAccess(this.#db);
        return this.#db
            .transaction(() => {
                const changed =
                    this.#db
                        .prepare(
                            `UPDATE advances SET recovery_phase = 'failed',
                             recovery_attempts = recovery_attempts + 1,
                             recovery_last_attempt_at = ?, recovery_next_attempt_at = NULL,
                             recovery_lease_owner = NULL, recovery_lease_token = NULL,
                             recovery_lease_until = NULL, failure_code = ?, failure_detail = ?,
                             updated_at = max(updated_at, ?) WHERE id = ? AND state = 'recovering'
                             AND recovery_lease_owner = ? AND recovery_lease_token = ?`,
                        )
                        .run(at, code, detail, at, id, owner, token).changes === 1;
                if (changed) new PolicyRepository(this.#db).update({ paused: true }, "recovery");
                return changed;
            })
            .immediate();
    }

    recordSubmissionAttemptFailure(
        id: string,
        owner: string,
        token: string,
        code: string,
        detail: string,
        at: number,
        nextAttemptAt: number,
    ): boolean {
        assertNativeAccess(this.#db);
        return (
            this.#db
                .prepare(
                    `UPDATE advances SET submission_attempts = submission_attempts + 1,
                     submission_last_attempt_at = ?, submission_next_attempt_at = ?,
                     submission_lease_owner = NULL, submission_lease_token = NULL,
                     submission_lease_until = NULL,
                     failure_code = ?, failure_detail = ?, updated_at = max(updated_at, ?)
                     WHERE id = ? AND state = 'locking' AND submission_lease_owner = ?
                     AND submission_lease_token = ?`,
                )
                .run(at, nextAttemptAt, code, detail, at, id, owner, token).changes === 1
        );
    }

    recordPermanentSubmissionFailure(
        id: string,
        owner: string,
        token: string,
        code: string,
        detail: string,
        at: number,
    ): boolean {
        assertNativeAccess(this.#db);
        return this.#db
            .transaction(() => {
                const changed =
                    this.#db
                        .prepare(
                            `UPDATE advances SET submission_phase = 'failed',
                             submission_attempts = submission_attempts + 1,
                             submission_last_attempt_at = ?, submission_next_attempt_at = NULL,
                             submission_lease_owner = NULL, submission_lease_token = NULL,
                             submission_lease_until = NULL, failure_code = ?, failure_detail = ?,
                             updated_at = max(updated_at, ?) WHERE id = ? AND state = 'locking'
                             AND submission_lease_owner = ? AND submission_lease_token = ?`,
                        )
                        .run(at, code, detail, at, id, owner, token).changes === 1;
                if (changed) new PolicyRepository(this.#db).update({ paused: true }, "submission");
                return changed;
            })
            .immediate();
    }

    recordLockupSubmission(id: string, arkTxid: string, at: number): void {
        assertNativeAccess(this.#db);
        if (this.#lockupSubmission.run(arkTxid, at, id).changes === 0) {
            throw new Error(`advance ${id} not found`);
        }
    }

    recordLockupFailure(id: string, code: string, detail: string, at: number): void {
        assertNativeAccess(this.#db);
        this.#lockupFailure.run(code, detail, at, id);
    }

    recordLockupObserved(id: string, outpoint: Outpoint, at: number): boolean {
        assertNativeAccess(this.#db);
        return (
            this.#lockupObserved.run(outpoint.txid, outpoint.txid, outpoint.vout, at, at, id)
                .changes === 1
        );
    }

    recordSpendObservation(
        id: string,
        expectedState: "locking" | "locked" | "recovering",
        terminalState: "recycled" | "purchased" | "refunded" | "recovered",
        spentTxid: string,
        at: number,
        tip: { hash: string; height: number },
    ): "recorded" | "duplicate" | "retry" | "disagreement" {
        assertNativeAccess(this.#db);
        if (!/^[0-9a-f]{64}$/.test(spentTxid) || !/^[0-9a-f]{64}$/.test(tip.hash))
            throw new Error("advance observation: invalid transaction or tip hash");
        if (
            !Number.isSafeInteger(at) ||
            at < 0 ||
            !Number.isSafeInteger(tip.height) ||
            tip.height < 0
        )
            throw new Error("advance observation: invalid clock");
        return this.#db
            .transaction(() => {
                const current = this.get(id);
                if (!current) throw new Error(`advance ${id} not found`);
                if (current.state === terminalState && current.spentTxid === spentTxid) {
                    return "duplicate" as const;
                }
                const compatibleForwardDrift =
                    (expectedState === "locking" && current.state === "locked") ||
                    ((expectedState === "locking" || expectedState === "locked") &&
                        current.state === "recovering");
                if (current.state !== expectedState && compatibleForwardDrift)
                    return "retry" as const;
                if (
                    ["recycled", "purchased", "refunded", "recovered"].includes(current.state) ||
                    current.state !== expectedState
                ) {
                    this.#db
                        .prepare(
                            `UPDATE advances SET failure_code = 'covenant_observation_disagreement',
                             failure_detail = ?, observation_stable_tip_hash = NULL,
                             observation_stable_tip_height = NULL,
                             observation_stable_count = 0, updated_at = max(updated_at, ?)
                             WHERE id = ?`,
                        )
                        .run(
                            `canonical spend ${spentTxid} classified ${terminalState} at ${tip.hash}:${tip.height} conflicts with persisted ${current.spentTxid ?? "none"}/${current.state}`,
                            at,
                            id,
                        );
                    new PolicyRepository(this.#db).update({ paused: true }, "spend-watcher");
                    return "disagreement" as const;
                }
                const changed = this.#db
                    .prepare(
                        `UPDATE advances SET state = ?, spent_txid = ?, last_observed_at = ?,
                         observation_tip_hash = ?, observation_tip_height = ?,
                         observation_stable_tip_hash = NULL,
                         observation_stable_tip_height = NULL, observation_stable_count = 0,
                         recovery_lease_owner = NULL, recovery_lease_token = NULL,
                         recovery_lease_until = NULL, recovery_next_attempt_at = NULL,
                         failure_code = NULL, failure_detail = NULL, updated_at = max(updated_at, ?)
                         WHERE id = ? AND state = ? AND spent_txid IS NULL`,
                    )
                    .run(
                        terminalState,
                        spentTxid,
                        at,
                        tip.hash,
                        tip.height,
                        at,
                        id,
                        expectedState,
                    ).changes;
                if (changed !== 1)
                    throw new Error(`advance ${id}: observation compare-and-set lost`);
                this.#db
                    .prepare("DELETE FROM operator_input_reservations WHERE advance_id = ?")
                    .run(id);
                return "recorded" as const;
            })
            .immediate();
    }

    clearSpendUnknown(id: string, expectedState: Advance["state"], at: number): void {
        assertNativeAccess(this.#db);
        this.#db
            .prepare(
                `UPDATE advances SET failure_code = NULL, failure_detail = NULL,
             observation_stable_tip_hash = NULL, observation_stable_tip_height = NULL,
             observation_stable_count = 0, updated_at = max(updated_at, ?)
             WHERE id = ? AND state = ? AND failure_code = 'covenant_spend_unknown'`,
            )
            .run(at, id, expectedState);
    }

    recordSpendUnknown(
        id: string,
        candidateTxid: string | undefined,
        reason: string,
        at: number,
        tip: { hash: string; height: number },
    ): void {
        assertNativeAccess(this.#db);
        this.#db
            .transaction(() => {
                const current = this.get(id);
                if (!current) throw new Error(`advance ${id} not found`);
                if (
                    current.state !== "locking" &&
                    current.state !== "locked" &&
                    current.state !== "recovering"
                )
                    return;
                this.#db
                    .prepare(
                        `UPDATE advances SET failure_code = 'covenant_spend_unknown', failure_detail = ?,
                         observation_stable_tip_hash = NULL,
                         observation_stable_tip_height = NULL, observation_stable_count = 0,
                         updated_at = max(updated_at, ?) WHERE id = ? AND state = ?`,
                    )
                    .run(
                        `candidate ${candidateTxid ?? "unavailable"} at ${tip.hash}:${tip.height}: ${reason}`,
                        at,
                        id,
                        current.state,
                    );
                new PolicyRepository(this.#db).update({ paused: true }, "spend-watcher");
            })
            .immediate();
    }

    recordSpendDisagreement(
        id: string,
        reason: string,
        at: number,
        tip: { hash: string; height: number },
    ): void {
        assertNativeAccess(this.#db);
        this.#db
            .transaction(() => {
                if (!this.get(id)) throw new Error(`advance ${id} not found`);
                this.#db
                    .prepare(
                        `UPDATE advances SET failure_code = 'covenant_observation_disagreement',
                         failure_detail = ?, observation_stable_tip_hash = NULL,
                         observation_stable_tip_height = NULL,
                         observation_stable_count = 0, updated_at = max(updated_at, ?)
                         WHERE id = ?`,
                    )
                    .run(`${reason} at ${tip.hash}:${tip.height}`, at, id);
                new PolicyRepository(this.#db).update({ paused: true }, "spend-watcher");
            })
            .immediate();
    }

    recordStableSpendObservation(
        id: string,
        terminalState: "recycled" | "purchased" | "refunded" | "recovered",
        spentTxid: string,
        at: number,
        tip: { hash: string; height: number; time: number },
    ): "ignored" | "advanced" | "pending" | "cleared" | "disagreement" {
        assertNativeAccess(this.#db);
        return this.#db
            .transaction(() => {
                const current = this.get(id);
                if (!current) throw new Error(`advance ${id} not found`);
                if (current.state !== terminalState || current.spentTxid !== spentTxid)
                    return "ignored" as const;
                const disagree = (reason: string) => {
                    const changed = this.#db
                        .prepare(
                            `UPDATE advances SET failure_code = 'covenant_observation_disagreement',
                             failure_detail = ?, observation_stable_tip_hash = NULL,
                             observation_stable_tip_height = NULL,
                             observation_stable_count = 0, updated_at = max(updated_at, ?)
                             WHERE id = ? AND state = ? AND spent_txid = ?`,
                        )
                        .run(reason, at, id, terminalState, spentTxid).changes;
                    if (changed !== 1) return "ignored" as const;
                    new PolicyRepository(this.#db).update({ paused: true }, "spend-watcher");
                    return "disagreement" as const;
                };
                if (
                    !Number.isSafeInteger(at) ||
                    at < 0 ||
                    !/^[0-9a-f]{64}$/.test(tip.hash) ||
                    !Number.isSafeInteger(tip.height) ||
                    tip.height < 0 ||
                    !Number.isSafeInteger(tip.time) ||
                    tip.time < 0
                )
                    return disagree("stable canonical tip identity is malformed");
                const previousHash = current.observationTipHash;
                const previousHeight = current.observationTipHeight;
                if (
                    previousHash === undefined ||
                    !/^[0-9a-f]{64}$/.test(previousHash) ||
                    previousHeight === undefined ||
                    !Number.isSafeInteger(previousHeight) ||
                    previousHeight < 0
                )
                    return disagree("persisted terminal tip identity is malformed");
                if (current.failureCode !== "covenant_observation_disagreement") {
                    if (
                        tip.height < previousHeight ||
                        (tip.height === previousHeight && tip.hash !== previousHash) ||
                        (tip.height > previousHeight && tip.hash === previousHash)
                    )
                        return disagree(
                            `stale or contradictory canonical tip ${tip.hash}:${tip.height} conflicts with persisted observation`,
                        );
                    if (previousHash === tip.hash && previousHeight === tip.height)
                        return "ignored" as const;
                    const changed = this.#db
                        .prepare(
                            `UPDATE advances SET last_observed_at = ?, observation_tip_hash = ?,
                             observation_tip_height = ?, updated_at = max(updated_at, ?)
                             WHERE id = ? AND state = ? AND spent_txid = ?
                             AND observation_tip_hash = ? AND observation_tip_height = ?
                             AND failure_code IS NOT 'covenant_observation_disagreement'`,
                        )
                        .run(
                            at,
                            tip.hash,
                            tip.height,
                            at,
                            id,
                            terminalState,
                            spentTxid,
                            previousHash,
                            previousHeight,
                        ).changes;
                    return changed === 1 ? ("advanced" as const) : ("ignored" as const);
                }
                if (
                    tip.height < previousHeight ||
                    (tip.height > previousHeight && tip.hash === previousHash)
                )
                    return disagree(
                        `stable candidate ${tip.hash}:${tip.height} is below or contradicts persisted observation ${previousHash}:${previousHeight}`,
                    );
                const previousStableHash = current.observationStableTipHash;
                const previousStableHeight = current.observationStableTipHeight;
                const count =
                    previousStableHash === tip.hash && previousStableHeight === tip.height
                        ? (current.observationStableCount ?? 0) + 1
                        : 1;
                const cleared = count >= 2;
                const changed = this.#db
                    .prepare(
                        `UPDATE advances SET observation_stable_tip_hash = ?,
                         observation_stable_tip_height = ?, observation_stable_count = ?,
                         last_observed_at = ?,
                         observation_tip_hash = CASE WHEN ? THEN ? ELSE observation_tip_hash END,
                         observation_tip_height = CASE WHEN ? THEN ? ELSE observation_tip_height END,
                         failure_code = CASE WHEN ? THEN NULL ELSE failure_code END,
                         failure_detail = CASE WHEN ? THEN NULL ELSE failure_detail END,
                         updated_at = max(updated_at, ?)
                         WHERE id = ? AND state = ? AND spent_txid = ?
                         AND failure_code = 'covenant_observation_disagreement'
                         AND observation_tip_hash = ? AND observation_tip_height = ?
                         AND observation_stable_count = ?`,
                    )
                    .run(
                        cleared ? null : tip.hash,
                        cleared ? null : tip.height,
                        cleared ? 0 : count,
                        at,
                        cleared ? 1 : 0,
                        tip.hash,
                        cleared ? 1 : 0,
                        tip.height,
                        cleared ? 1 : 0,
                        cleared ? 1 : 0,
                        at,
                        id,
                        terminalState,
                        spentTxid,
                        previousHash,
                        previousHeight,
                        current.observationStableCount ?? 0,
                    ).changes;
                if (changed !== 1) return "ignored" as const;
                return cleared ? ("cleared" as const) : ("pending" as const);
            })
            .immediate();
    }

    recordRecoverySubmission(id: string, txid: string, at: number): void {
        assertNativeAccess(this.#db);
        if (this.#recoverySubmission.run(txid, at, id).changes === 0) {
            throw new Error(`advance ${id} not found`);
        }
    }

    claimRecovery(id: string, at: number): Advance | undefined {
        assertNativeAccess(this.#db);
        return this.#db
            .transaction(() => {
                const row = this.#claimRecovery.get(at, at, id);
                return row && fromRow(row);
            })
            .immediate();
    }

    listSweepable(currentHeight: bigint, medianTime?: bigint): Advance[] {
        assertNativeAccess(this.#db);
        return this.#sweepable.all(currentHeight, medianTime ?? null).map(fromRow);
    }

    sumTopupByState(s: AdvanceState): bigint {
        assertNativeAccess(this.#db);
        return this.#sumTopup.get(s)?.total ?? 0n;
    }
}
