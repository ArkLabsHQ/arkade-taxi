import DatabaseCtor, { type Database } from "better-sqlite3";
import type { AdvanceState } from "@arkade-taxi/core";

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

export const SCHEMA_VERSION = 1;

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
    submission_phase TEXT CHECK (submission_phase IN ('claimed', 'prepared', 'responded', 'finalized', 'failed')),
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
    recovery_phase TEXT CHECK (recovery_phase IN ('prepared', 'submitted', 'failed')),
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
    recovery_next_attempt_at INTEGER, kind TEXT NOT NULL DEFAULT 'covenant'
            CHECK (kind IN ('covenant', 'sponsored')), claim_mode TEXT
            CHECK (claim_mode IS NULL OR claim_mode IN ('recycle', 'purchase')), recovery_recipient TEXT
            CHECK (recovery_recipient IS NULL OR recovery_recipient IN ('sender', 'receiver')), receiver_fare_currency TEXT
                CHECK (receiver_fare_currency IS NULL OR receiver_fare_currency IN ('sats','asset')), receiver_fare_units TEXT
                CHECK ((receiver_fare_currency IS NULL) = (receiver_fare_units IS NULL))
                CHECK (receiver_fare_units IS NULL
                    OR (receiver_fare_units GLOB '[0-9]*' AND receiver_fare_units NOT GLOB '*[^0-9]*')), exit_signer_key BLOB, exit_delay_type TEXT
                CHECK (exit_delay_type IS NULL OR exit_delay_type IN ('blocks', 'seconds')), exit_delay_value INTEGER
                CHECK (exit_delay_value IS NULL OR exit_delay_value > 0), payment_sats INTEGER
                CHECK (payment_sats IS NULL OR payment_sats > 0), renewals INTEGER NOT NULL DEFAULT 0
                CHECK (renewals >= 0), last_renewed_at INTEGER, extra_packet BLOB
                CHECK (extra_packet IS NULL OR length(extra_packet) >= 2),
    CHECK ((batch_expiry_kind IS NULL) = (batch_expiry_value IS NULL)),
    CHECK (batch_expiry_kind IS NULL OR (batch_expiry_kind = 'time') = (locktime >= 500000000)),
    CHECK ((asset_txid IS NULL) = (asset_group_index IS NULL)),
    CHECK ((asset_txid IS NULL) = (asset_units IS NULL)),
    CHECK ((fare_asset_txid IS NULL) = (fare_asset_group_index IS NULL)),
    CHECK ((fare_currency = 'asset') = (fare_asset_txid IS NOT NULL)),
    CHECK ((outpoint_txid IS NULL) = (outpoint_vout IS NULL))
);

CREATE TABLE custody (
            advance_id TEXT PRIMARY KEY REFERENCES advances(id),
            owner_key BLOB NOT NULL,
            asset_txid BLOB,
            asset_group_index INTEGER,
            asset_units INTEGER CHECK (asset_units IS NULL OR asset_units > 0),
            owed_sats INTEGER NOT NULL CHECK (owed_sats >= 0),
            loan_sats INTEGER NOT NULL CHECK (loan_sats >= 0),
            fare_currency TEXT CHECK (fare_currency IS NULL OR fare_currency IN ('sats', 'asset')),
            fare_units INTEGER,
            state TEXT NOT NULL CHECK (state IN ('held', 'releasing', 'released', 'forfeit')),
            held_at INTEGER NOT NULL,
            expires_at INTEGER NOT NULL,
            release_lease_owner TEXT,
            release_lease_token TEXT,
            release_lease_until INTEGER,
            release_expected_txid TEXT,
            release_txid TEXT,
            released_at INTEGER,
            swept_at INTEGER,
            swept_actor TEXT,
            CHECK ((asset_txid IS NULL) = (asset_group_index IS NULL)),
            CHECK ((asset_txid IS NULL) = (asset_units IS NULL)),
            CHECK ((fare_currency IS NULL) = (fare_units IS NULL)),
            CHECK ((swept_at IS NULL) = (swept_actor IS NULL)),
            CHECK ((release_txid IS NULL) = (released_at IS NULL)),
            CHECK (state != 'forfeit' OR swept_at IS NOT NULL),
            CHECK (state != 'released' OR (release_txid IS NOT NULL AND swept_at IS NULL)),
            CHECK (state != 'releasing' OR release_expected_txid IS NOT NULL),
            CHECK (expires_at > held_at)
        );

CREATE TABLE custody_release_inputs (
            outpoint_txid TEXT NOT NULL CHECK (
                length(outpoint_txid) = 64 AND outpoint_txid NOT GLOB '*[^0-9a-f]*'
            ),
            outpoint_vout INTEGER NOT NULL CHECK (outpoint_vout BETWEEN 0 AND 4294967295),
            advance_id TEXT NOT NULL REFERENCES custody(advance_id),
            created_at INTEGER NOT NULL,
            PRIMARY KEY (outpoint_txid, outpoint_vout)
        );

CREATE TABLE fill_reservations (
            outpoint_txid TEXT NOT NULL CHECK (
                length(outpoint_txid) = 64 AND outpoint_txid NOT GLOB '*[^0-9a-f]*'
            ),
            outpoint_vout INTEGER NOT NULL CHECK (outpoint_vout BETWEEN 0 AND 4294967295),
            fill_id TEXT NOT NULL REFERENCES fills(id),
            created_at INTEGER NOT NULL,
            PRIMARY KEY (outpoint_txid, outpoint_vout)
        );

CREATE TABLE fills (
            id TEXT PRIMARY KEY,
            operation_id TEXT NOT NULL UNIQUE,
            state TEXT NOT NULL CHECK (state IN ('submitting', 'settled', 'expired', 'cancelled')),
            quote_id TEXT NOT NULL,
            taxi_inputs_json TEXT NOT NULL CHECK (json_valid(taxi_inputs_json)),
            covenant_output_index INTEGER NOT NULL CHECK (covenant_output_index >= 0),
            asset_units INTEGER NOT NULL CHECK (asset_units > 0),
            contribution_sats INTEGER NOT NULL CHECK (contribution_sats > 0),
            fare_currency TEXT NOT NULL CHECK (fare_currency IN ('sats', 'asset')),
            fare_units INTEGER NOT NULL CHECK (fare_units >= 0),
            fare_asset_txid BLOB,
            fare_asset_group_index INTEGER,
            graph_json TEXT NOT NULL CHECK (json_valid(graph_json)),
            graph_id TEXT NOT NULL CHECK (length(graph_id) = 64 AND graph_id NOT GLOB '*[^0-9a-f]*'),
            prepared_ark_tx TEXT,
            prepared_checkpoints_json TEXT,
            submit_invoked INTEGER NOT NULL DEFAULT 0 CHECK (submit_invoked IN (0, 1)),
            txid TEXT,
            outpoint_txid TEXT,
            outpoint_vout INTEGER,
            spent_txid TEXT,
            failure_code TEXT,
            failure_detail TEXT,
            lease_owner TEXT,
            lease_token TEXT,
            lease_until INTEGER,
            attempts INTEGER NOT NULL DEFAULT 0,
            next_attempt_at INTEGER,
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL,
            expires_at INTEGER NOT NULL,
            valid_until INTEGER,
            CHECK ((fare_currency = 'asset') = (fare_asset_txid IS NOT NULL)),
            CHECK ((fare_asset_txid IS NULL) = (fare_asset_group_index IS NULL)),
            CHECK ((outpoint_txid IS NULL) = (outpoint_vout IS NULL)),
            CHECK (expires_at > created_at)
        );

CREATE TABLE "operator_input_reservations" (
            outpoint_txid TEXT NOT NULL,
            outpoint_vout INTEGER NOT NULL CHECK (outpoint_vout BETWEEN 0 AND 4294967295),
            advance_id TEXT NOT NULL REFERENCES advances(id),
            batch_expiry_kind TEXT CHECK (batch_expiry_kind IS NULL OR batch_expiry_kind IN ('height', 'time')),
            batch_expiry_value INTEGER,
            created_at INTEGER NOT NULL,
            CHECK ((batch_expiry_kind IS NULL) = (batch_expiry_value IS NULL)),
            PRIMARY KEY (outpoint_txid, outpoint_vout)
        );

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

CREATE TABLE proceeds_inputs (
    outpoint_txid TEXT NOT NULL,
    outpoint_vout INTEGER NOT NULL CHECK (outpoint_vout BETWEEN 0 AND 4294967295),
    job_id TEXT NOT NULL REFERENCES proceeds_jobs(id),
    PRIMARY KEY (outpoint_txid, outpoint_vout)
);

CREATE TABLE proceeds_jobs (
    id TEXT PRIMARY KEY,
    plan_json TEXT NOT NULL,
    state TEXT NOT NULL CHECK (state IN ('pending', 'settling', 'quarantined', 'complete')),
    blocker TEXT,
    commitment_txid TEXT,
    submission_state TEXT NOT NULL DEFAULT 'unsubmitted' CHECK (submission_state IN ('unsubmitted', 'entered')),
    lease_owner TEXT,
    lease_until INTEGER,
    created_at INTEGER NOT NULL
);

CREATE TABLE proceeds_local_intents (
    job_id TEXT NOT NULL REFERENCES proceeds_jobs(id),
    digest TEXT NOT NULL CHECK (length(digest) = 64 AND digest NOT GLOB '*[^0-9a-f]*'),
    PRIMARY KEY (job_id, digest)
);

CREATE TABLE receive_quote_reservations (
            outpoint_txid TEXT NOT NULL CHECK (
                length(outpoint_txid) = 64 AND outpoint_txid NOT GLOB '*[^0-9a-f]*'
            ),
            outpoint_vout INTEGER NOT NULL CHECK (outpoint_vout BETWEEN 0 AND 4294967295),
            quote_id TEXT NOT NULL REFERENCES receive_quotes(id),
            created_at INTEGER NOT NULL,
            PRIMARY KEY (outpoint_txid, outpoint_vout)
        );

CREATE TABLE "receive_quotes" (
            id TEXT PRIMARY KEY,
            state TEXT NOT NULL CHECK (state IN ('quoted', 'bound', 'expired')),
            receiver_address TEXT NOT NULL CHECK (length(receiver_address) > 0),
            sender_key TEXT NOT NULL CHECK (
                length(sender_key) = 64 AND sender_key NOT GLOB '*[^0-9a-f]*'
            ),
            params_json TEXT NOT NULL CHECK (json_valid(params_json)),
            covenant_address TEXT NOT NULL CHECK (length(covenant_address) > 0),
            fare_json TEXT NOT NULL CHECK (json_valid(fare_json)),
            batch_expiry_kind TEXT NOT NULL CHECK (batch_expiry_kind IN ('height', 'time')),
            batch_expiry_value INTEGER NOT NULL,
            input_expiry_floor_kind TEXT NOT NULL CHECK (input_expiry_floor_kind IN ('height', 'time')),
            input_expiry_floor_value INTEGER NOT NULL,
            recovery_locktime_kind TEXT NOT NULL CHECK (recovery_locktime_kind = 'time'),
            recovery_locktime_value INTEGER NOT NULL CHECK (recovery_locktime_value >= 500000000),
            loan_sats INTEGER NOT NULL CHECK (loan_sats > 0),
            created_at INTEGER NOT NULL,
            expires_at INTEGER NOT NULL,
            policy_revision INTEGER NOT NULL CHECK (policy_revision >= 0),
            operator_inputs_json TEXT NOT NULL CHECK (json_valid(operator_inputs_json)),
            bound_fill_id TEXT,
            payer TEXT CHECK (payer IS NULL OR payer = 'receiver'),
            receiver_fare_json TEXT CHECK (receiver_fare_json IS NULL OR json_valid(receiver_fare_json)),
            CHECK ((payer IS NULL) = (receiver_fare_json IS NULL)),
            CHECK (expires_at > created_at),
            CHECK (batch_expiry_kind = input_expiry_floor_kind),
            CHECK (batch_expiry_value >= input_expiry_floor_value),
            CHECK (recovery_locktime_value > created_at),
            CHECK ((state = 'bound') = (bound_fill_id IS NOT NULL))
        );

CREATE UNIQUE INDEX advances_outpoint ON advances (outpoint_txid, outpoint_vout);

CREATE INDEX advances_receiver_updated ON advances (receiver_key, updated_at, id);

CREATE INDEX advances_state_batch_expiry ON advances (state, batch_expiry_kind, batch_expiry_value);

CREATE INDEX advances_state_locktime ON advances (state, locktime);

CREATE INDEX custody_asset ON custody (asset_txid, asset_group_index)
            WHERE asset_txid IS NOT NULL;

CREATE INDEX custody_owner ON custody (owner_key, held_at);

CREATE INDEX custody_release_inputs_advance ON custody_release_inputs (advance_id);

CREATE INDEX custody_state_expiry ON custody (state, expires_at);

CREATE INDEX fill_reservations_fill ON fill_reservations (fill_id);

CREATE UNIQUE INDEX fills_operation ON fills (operation_id);

CREATE INDEX fills_quote ON fills (quote_id);

CREATE INDEX fills_state ON fills (state, expires_at);

CREATE INDEX operator_input_reservations_advance ON operator_input_reservations (advance_id);

CREATE INDEX policy_audit_changed_at ON policy_audit (changed_at);

CREATE UNIQUE INDEX proceeds_one_active ON proceeds_jobs ((1)) WHERE state != 'complete';

CREATE INDEX receive_quote_reservations_quote ON receive_quote_reservations (quote_id);

CREATE INDEX receive_quotes_state_expiry ON receive_quotes (state, expires_at);
`;

type SchemaObject = { type: string; name: string; tbl_name: string; sql: string };

function schemaObjects(db: Database): SchemaObject[] {
    return db
        .prepare<[], SchemaObject>(
            "SELECT type, name, tbl_name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name",
        )
        .all()
        .map((row) => ({ ...row, sql: row.sql.replace(/\s+/g, " ").trim() }));
}

const expectedSchema = (() => {
    const reference = new DatabaseCtor(":memory:");
    try {
        reference.exec(INITIAL_SCHEMA);
        return schemaObjects(reference);
    } finally {
        reference.close();
    }
})();
const ownedTables = new Set(
    expectedSchema.filter(({ type }) => type === "table").map(({ name }) => name),
);

function isInitialized(db: Database): boolean {
    const version = Number(db.pragma("user_version", { simple: true }));
    if (version !== 0 && version !== SCHEMA_VERSION)
        throw new Error(
            `Unsupported database schema ${version}; this service requires schema ${SCHEMA_VERSION}`,
        );
    const objects = schemaObjects(db);
    if (version === 0) {
        if (db.prepare("SELECT 1 FROM sqlite_master LIMIT 1").get())
            throw new Error("Incompatible nonempty database without a v1 schema");
        return false;
    }
    const owned = objects.filter(
        ({ name, tbl_name }) => ownedTables.has(name) || ownedTables.has(tbl_name),
    );
    if (JSON.stringify(owned) !== JSON.stringify(expectedSchema))
        throw new Error(
            "Incompatible database schema: Taxi v1 tables, indexes or constraints differ",
        );
    return true;
}

export function initializeSchema(db: Database): void {
    if (isInitialized(db)) return;
    db.transaction(() => {
        if (isInitialized(db)) return;
        db.exec(INITIAL_SCHEMA);
        db.pragma(`user_version = ${SCHEMA_VERSION}`);
    }).immediate();
}
