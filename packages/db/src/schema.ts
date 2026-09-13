import type { Database } from "better-sqlite3";
import type { AdvanceState } from "@arkade-taxi/core";

export interface Migration {
    id: number;
    up: string;
}

export const ADVANCE_STATES = [
    "quoted",
    "locking",
    "locked",
    "recovering",
    "recycled",
    "purchased",
    "refunded",
    "recovered",
    "expired",
] as const satisfies readonly AdvanceState[];

/** Fails to compile if `AdvanceState` gains a member the CHECK below does not list. */
type NoUnlistedState<T extends never> = T;
export type _StatesAreExhaustive = NoUnlistedState<
    Exclude<AdvanceState, (typeof ADVANCE_STATES)[number]>
>;

/**
 * Sats and locktimes are INTEGER, read back through `safeIntegers` as BigInt.
 * TEXT would order and sum lexicographically, breaking `listSweepable` and
 * `sumTopupByState` unless every value were zero-padded to a fixed width.
 */
const INITIAL_SCHEMA = `
CREATE TABLE advances (
    id TEXT PRIMARY KEY,
    state TEXT NOT NULL CHECK (state IN ('quoted', 'locking', 'locked', 'recovering',
        'recycled', 'purchased', 'refunded', 'recovered', 'expired')),
    receiver_key BLOB NOT NULL,
    sender_key BLOB NOT NULL,
    operator_key BLOB NOT NULL,
    dust INTEGER NOT NULL,
    topup INTEGER NOT NULL,
    asset_txid BLOB,
    asset_group_index INTEGER,
    asset_units INTEGER,
    locktime INTEGER NOT NULL,
    covenant_address TEXT NOT NULL,
    fare_currency TEXT NOT NULL CHECK (fare_currency IN ('sats', 'asset')),
    fare_units INTEGER NOT NULL,
    fare_asset_txid BLOB,
    fare_asset_group_index INTEGER,
    outpoint_txid TEXT,
    outpoint_vout INTEGER,
    spent_txid TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    batch_expiry_kind TEXT CHECK (batch_expiry_kind IN ('height', 'time')),
    batch_expiry_value INTEGER CHECK (batch_expiry_value > locktime),
    operator_inputs_json TEXT,
    unsigned_lockup_tx TEXT,
    unsigned_lockup_id TEXT,
    submission_key TEXT,
    ark_txid TEXT,
    submitted_at INTEGER,
    recovery_txid TEXT,
    recovery_submitted_at INTEGER,
    last_observed_at INTEGER,
    failure_code TEXT,
    failure_detail TEXT,
    signed_envelope_digest TEXT,
    submission_phase TEXT,
    signed_lockup_envelope TEXT,
    prepared_ark_tx TEXT,
    prepared_checkpoints_json TEXT,
    server_final_ark_tx TEXT,
    server_checkpoints_json TEXT,
    submission_lease_owner TEXT,
    submission_lease_until INTEGER,
    submission_attempts INTEGER NOT NULL DEFAULT 0,
    submission_last_attempt_at INTEGER,
    submission_next_attempt_at INTEGER,
    finalized_at INTEGER,
    submission_lease_token TEXT,
    observation_tip_hash TEXT,
    observation_tip_height INTEGER,
    observation_stable_tip_hash TEXT,
    observation_stable_count INTEGER NOT NULL DEFAULT 0,
    observation_stable_tip_height INTEGER,
    recovery_locktime_kind TEXT CHECK (recovery_locktime_kind IN ('height', 'time')),
    recovery_phase TEXT CHECK (recovery_phase IN ('prepared', 'submitted', 'failed', 'legacy')),
    recovery_graph_digest TEXT,
    recovery_expected_txid TEXT,
    recovery_prepared_ark_tx TEXT,
    recovery_prepared_checkpoints_json TEXT,
    recovery_response_ark_tx TEXT,
    recovery_response_checkpoints_json TEXT,
    recovery_lease_owner TEXT,
    recovery_lease_token TEXT,
    recovery_lease_until INTEGER,
    recovery_attempts INTEGER NOT NULL DEFAULT 0,
    recovery_last_attempt_at INTEGER,
    recovery_next_attempt_at INTEGER,
    CHECK ((batch_expiry_kind IS NULL) = (batch_expiry_value IS NULL)),
    CHECK (batch_expiry_kind IS NULL OR (batch_expiry_kind = 'time') = (locktime >= 500000000)),
    CHECK ((asset_txid IS NULL) = (asset_group_index IS NULL)),
    CHECK ((asset_txid IS NULL) = (asset_units IS NULL)),
    CHECK ((fare_asset_txid IS NULL) = (fare_asset_group_index IS NULL)),
    CHECK ((fare_currency = 'asset') = (fare_asset_txid IS NOT NULL)),
    CHECK ((outpoint_txid IS NULL) = (outpoint_vout IS NULL))
);

CREATE INDEX advances_state_locktime ON advances (state, locktime);
CREATE INDEX advances_state_batch_expiry ON advances (state, batch_expiry_kind, batch_expiry_value);
CREATE UNIQUE INDEX advances_outpoint ON advances (outpoint_txid, outpoint_vout);
CREATE TABLE operator_input_reservations (
    outpoint_txid TEXT NOT NULL,
    outpoint_vout INTEGER NOT NULL CHECK (outpoint_vout BETWEEN 0 AND 4294967295),
    advance_id TEXT NOT NULL REFERENCES advances(id),
    batch_expiry_kind TEXT NOT NULL CHECK (batch_expiry_kind IN ('height', 'time')),
    batch_expiry_value INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (outpoint_txid, outpoint_vout)
);
CREATE INDEX operator_input_reservations_advance ON operator_input_reservations (advance_id);
CREATE INDEX advances_receiver_updated ON advances (receiver_key, updated_at, id);

CREATE TABLE policy (
    id                         INTEGER PRIMARY KEY CHECK (id = 1),
    paused                     INTEGER NOT NULL CHECK (paused IN (0, 1)),
    max_outstanding_sats       INTEGER NOT NULL,
    max_per_payment_topup_sats INTEGER NOT NULL,
    max_concurrent_advances    INTEGER NOT NULL,
    locktime_margin_blocks     INTEGER NOT NULL,
    asset_rules                TEXT NOT NULL,
    quote_ttl_seconds          INTEGER NOT NULL,
    revision INTEGER NOT NULL DEFAULT 0 CHECK (typeof(revision) = 'integer' AND revision >= 0),
    locktime_margin_seconds INTEGER NOT NULL DEFAULT 86400 CHECK (locktime_margin_seconds >= 0)
);

CREATE TABLE policy_audit (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    changed_at INTEGER NOT NULL,
    field      TEXT NOT NULL,
    old_value  TEXT NOT NULL,
    new_value  TEXT NOT NULL,
    actor      TEXT NOT NULL
);

CREATE INDEX policy_audit_changed_at ON policy_audit (changed_at);
CREATE TABLE proceeds_jobs (
    id TEXT PRIMARY KEY,
    plan_json TEXT NOT NULL,
    state TEXT NOT NULL CHECK (state IN ('pending', 'settling', 'quarantined', 'complete')),
    blocker TEXT,
    commitment_txid TEXT,
    lease_owner TEXT,
    lease_until INTEGER,
    created_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX proceeds_one_active ON proceeds_jobs ((1)) WHERE state != 'complete';
CREATE TABLE proceeds_inputs (
    outpoint_txid TEXT NOT NULL,
    outpoint_vout INTEGER NOT NULL CHECK (outpoint_vout BETWEEN 0 AND 4294967295),
    job_id TEXT NOT NULL REFERENCES proceeds_jobs(id),
    PRIMARY KEY (outpoint_txid, outpoint_vout)
);
`;

export const MIGRATIONS: readonly Migration[] = [{ id: 1, up: INITIAL_SCHEMA }];

export function applyMigrations(db: Database, migrations: readonly Migration[] = MIGRATIONS): void {
    const ordered = [...migrations].sort((a, b) => a.id - b.id);
    const seen = new Set<number>();
    for (const m of ordered) {
        if (!Number.isSafeInteger(m.id) || m.id <= 0) {
            throw new Error(`migration id must be a positive safe integer, got ${m.id}`);
        }
        if (seen.has(m.id)) throw new Error(`duplicate migration id ${m.id}`);
        seen.add(m.id);
    }

    const current = Number(db.pragma("user_version", { simple: true }));
    if (
        migrations === MIGRATIONS &&
        current > 0 &&
        (current !== 1 ||
            !db
                .prepare(
                    "SELECT 1 FROM pragma_table_info('advances') WHERE name = 'asset_units' AND type = 'INTEGER'",
                )
                .get() ||
            !db
                .prepare(
                    "SELECT 1 FROM pragma_table_info('proceeds_jobs') WHERE name = 'lease_until' AND type = 'INTEGER'",
                )
                .get() ||
            !db
                .prepare(
                    "SELECT 1 FROM pragma_table_info('proceeds_inputs') WHERE name = 'job_id' AND type = 'TEXT'",
                )
                .get())
    )
        throw new Error(
            "Incompatible development schema: recreate the database before starting this service",
        );
    const pending = ordered.filter((m) => m.id > current);
    if (pending.length === 0) return;
    const target = pending[pending.length - 1]!.id;

    db.transaction(() => {
        for (const m of pending) db.exec(m.up);
        // PRAGMA takes no bind parameter; `target` is a validated integer.
        db.pragma(`user_version = ${target}`);
    })();
}
