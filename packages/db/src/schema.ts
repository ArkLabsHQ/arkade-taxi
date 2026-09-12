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
    id                TEXT PRIMARY KEY,
    state             TEXT NOT NULL CHECK (state IN (
                          'quoted', 'locking', 'locked', 'recycled',
                          'purchased', 'refunded', 'recovered', 'expired')),
    receiver_key      BLOB NOT NULL,
    sender_key        BLOB NOT NULL,
    operator_key      BLOB NOT NULL,
    dust              INTEGER NOT NULL,
    topup             INTEGER NOT NULL,
    asset_txid        BLOB,
    asset_group_index INTEGER,
    locktime          INTEGER NOT NULL,
    covenant_address  TEXT NOT NULL,
    fare_currency     TEXT NOT NULL CHECK (fare_currency IN ('sats', 'asset')),
    fare_units        INTEGER NOT NULL,
    fare_asset_txid   BLOB,
    fare_asset_group_index INTEGER,
    outpoint_txid     TEXT,
    outpoint_vout     INTEGER,
    spent_txid        TEXT,
    created_at        INTEGER NOT NULL,
    updated_at        INTEGER NOT NULL,
    expires_at        INTEGER NOT NULL,
    CHECK ((asset_txid IS NULL) = (asset_group_index IS NULL)),
    CHECK ((fare_asset_txid IS NULL) = (fare_asset_group_index IS NULL)),
    CHECK ((fare_currency = 'asset') = (fare_asset_txid IS NOT NULL)),
    CHECK ((outpoint_txid IS NULL) = (outpoint_vout IS NULL))
);

CREATE INDEX advances_state_locktime ON advances (state, locktime);
CREATE UNIQUE INDEX advances_outpoint ON advances (outpoint_txid, outpoint_vout);

CREATE TABLE policy (
    id                         INTEGER PRIMARY KEY CHECK (id = 1),
    paused                     INTEGER NOT NULL CHECK (paused IN (0, 1)),
    max_outstanding_sats       INTEGER NOT NULL,
    max_per_payment_topup_sats INTEGER NOT NULL,
    max_concurrent_advances    INTEGER NOT NULL,
    locktime_margin_blocks     INTEGER NOT NULL,
    asset_rules                TEXT NOT NULL,
    quote_ttl_seconds          INTEGER NOT NULL
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
`;

const DURABLE_FUNDING_SCHEMA = `
CREATE TABLE advances_v2 (
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
    CHECK ((batch_expiry_kind IS NULL) = (batch_expiry_value IS NULL)),
    CHECK (batch_expiry_kind IS NULL OR (batch_expiry_kind = 'time') = (locktime >= 500000000)),
    CHECK ((asset_txid IS NULL) = (asset_group_index IS NULL)),
    CHECK ((fare_asset_txid IS NULL) = (fare_asset_group_index IS NULL)),
    CHECK ((fare_currency = 'asset') = (fare_asset_txid IS NOT NULL)),
    CHECK ((outpoint_txid IS NULL) = (outpoint_vout IS NULL))
);
INSERT INTO advances_v2 (id, state, receiver_key, sender_key, operator_key, dust, topup,
    asset_txid, asset_group_index, locktime, covenant_address, fare_currency, fare_units,
    fare_asset_txid, fare_asset_group_index, outpoint_txid, outpoint_vout, spent_txid,
    created_at, updated_at, expires_at)
SELECT id, state, receiver_key, sender_key, operator_key, dust, topup,
    asset_txid, asset_group_index, locktime, covenant_address, fare_currency, fare_units,
    fare_asset_txid, fare_asset_group_index, outpoint_txid, outpoint_vout, spent_txid,
    created_at, updated_at, expires_at FROM advances;
DROP TABLE advances;
ALTER TABLE advances_v2 RENAME TO advances;
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
ALTER TABLE policy ADD COLUMN revision INTEGER NOT NULL DEFAULT 0 CHECK (typeof(revision) = 'integer' AND revision >= 0);
ALTER TABLE policy ADD COLUMN locktime_margin_seconds INTEGER NOT NULL DEFAULT 86400 CHECK (locktime_margin_seconds >= 0);
`;

export const MIGRATIONS: readonly Migration[] = [
    { id: 1, up: INITIAL_SCHEMA },
    { id: 2, up: DURABLE_FUNDING_SCHEMA },
    {
        id: 3,
        up: "ALTER TABLE advances ADD COLUMN signed_envelope_digest TEXT;",
    },
    {
        id: 4,
        up: `ALTER TABLE advances ADD COLUMN submission_phase TEXT;
ALTER TABLE advances ADD COLUMN signed_lockup_envelope TEXT;
ALTER TABLE advances ADD COLUMN prepared_ark_tx TEXT;
ALTER TABLE advances ADD COLUMN prepared_checkpoints_json TEXT;
ALTER TABLE advances ADD COLUMN server_final_ark_tx TEXT;
ALTER TABLE advances ADD COLUMN server_checkpoints_json TEXT;
ALTER TABLE advances ADD COLUMN submission_lease_owner TEXT;
ALTER TABLE advances ADD COLUMN submission_lease_until INTEGER;
ALTER TABLE advances ADD COLUMN submission_attempts INTEGER NOT NULL DEFAULT 0;
ALTER TABLE advances ADD COLUMN submission_last_attempt_at INTEGER;
ALTER TABLE advances ADD COLUMN submission_next_attempt_at INTEGER;
ALTER TABLE advances ADD COLUMN finalized_at INTEGER;`,
    },
    {
        id: 5,
        up: `ALTER TABLE advances ADD COLUMN submission_lease_token TEXT;
UPDATE advances SET submission_phase = 'legacy',
    failure_code = 'lockup_submission_legacy_unresumable',
    failure_detail = 'Legacy locking row has no signed envelope or durable submission artifacts'
    WHERE state = 'locking' AND submission_phase IS NULL;
UPDATE policy SET paused = 1, revision = revision + 1
    WHERE id = 1 AND paused = 0 AND EXISTS (
        SELECT 1 FROM advances WHERE submission_phase = 'legacy'
    );`,
    },
    {
        id: 6,
        up: `ALTER TABLE advances ADD COLUMN observation_tip_hash TEXT;
ALTER TABLE advances ADD COLUMN observation_tip_height INTEGER;
ALTER TABLE advances ADD COLUMN observation_stable_tip_hash TEXT;
ALTER TABLE advances ADD COLUMN observation_stable_count INTEGER NOT NULL DEFAULT 0;`,
    },
    {
        id: 7,
        up: "ALTER TABLE advances ADD COLUMN observation_stable_tip_height INTEGER;",
    },
    {
        id: 8,
        up: `ALTER TABLE advances ADD COLUMN recovery_locktime_kind TEXT CHECK (recovery_locktime_kind IN ('height', 'time'));
ALTER TABLE advances ADD COLUMN recovery_phase TEXT CHECK (recovery_phase IN ('prepared', 'submitted', 'failed', 'legacy'));
ALTER TABLE advances ADD COLUMN recovery_graph_digest TEXT;
ALTER TABLE advances ADD COLUMN recovery_expected_txid TEXT;
ALTER TABLE advances ADD COLUMN recovery_prepared_ark_tx TEXT;
ALTER TABLE advances ADD COLUMN recovery_prepared_checkpoints_json TEXT;
ALTER TABLE advances ADD COLUMN recovery_response_ark_tx TEXT;
ALTER TABLE advances ADD COLUMN recovery_response_checkpoints_json TEXT;
ALTER TABLE advances ADD COLUMN recovery_lease_owner TEXT;
ALTER TABLE advances ADD COLUMN recovery_lease_token TEXT;
ALTER TABLE advances ADD COLUMN recovery_lease_until INTEGER;
ALTER TABLE advances ADD COLUMN recovery_attempts INTEGER NOT NULL DEFAULT 0;
ALTER TABLE advances ADD COLUMN recovery_last_attempt_at INTEGER;
ALTER TABLE advances ADD COLUMN recovery_next_attempt_at INTEGER;`,
    },
];

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
    const pending = ordered.filter((m) => m.id > current);
    if (pending.length === 0) return;
    const target = pending[pending.length - 1]!.id;

    db.transaction(() => {
        for (const m of pending) db.exec(m.up);
        // PRAGMA takes no bind parameter; `target` is a validated integer.
        db.pragma(`user_version = ${target}`);
    })();
}
