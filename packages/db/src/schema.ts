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
    submission_state TEXT NOT NULL DEFAULT 'unsubmitted' CHECK (submission_state IN ('unsubmitted', 'entered')),
    lease_owner TEXT,
    lease_until INTEGER,
    created_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX proceeds_one_active ON proceeds_jobs ((1)) WHERE state != 'complete';
CREATE TABLE proceeds_local_intents (
    job_id TEXT NOT NULL REFERENCES proceeds_jobs(id),
    digest TEXT NOT NULL CHECK (length(digest) = 64 AND digest NOT GLOB '*[^0-9a-f]*'),
    PRIMARY KEY (job_id, digest)
);
CREATE TABLE proceeds_inputs (
    outpoint_txid TEXT NOT NULL,
    outpoint_vout INTEGER NOT NULL CHECK (outpoint_vout BETWEEN 0 AND 4294967295),
    job_id TEXT NOT NULL REFERENCES proceeds_jobs(id),
    PRIMARY KEY (outpoint_txid, outpoint_vout)
);
`;

export const MIGRATIONS: readonly Migration[] = [
    { id: 1, up: INITIAL_SCHEMA },
    {
        id: 2,
        // Sponsored direct sends reuse the advances table: `locked` is their
        // terminal state, so no state CHECK changes. Existing rows default to
        // the covenant flow they were written by.
        up: `ALTER TABLE advances ADD COLUMN kind TEXT NOT NULL DEFAULT 'covenant'
            CHECK (kind IN ('covenant', 'sponsored'))`,
    },
    {
        id: 3,
        // Sponsored swap fills live in their own tables: new states, new
        // reservation scope, no edits to the advances schema or its rows.
        up: `CREATE TABLE swap_fills (
            id TEXT PRIMARY KEY,
            operation_id TEXT NOT NULL UNIQUE,
            state TEXT NOT NULL CHECK (state IN ('quoted', 'submitting', 'settled', 'expired', 'cancelled')),
            offer_hex TEXT NOT NULL,
            offer_txid TEXT,
            offer_vout INTEGER,
            swap_address TEXT,
            solver_inputs_json TEXT NOT NULL,
            solver_proceeds_script TEXT NOT NULL,
            solver_keys_json TEXT NOT NULL,
            taxi_inputs_json TEXT NOT NULL,
            contribution_sats INTEGER NOT NULL CHECK (contribution_sats > 0),
            fare_currency TEXT NOT NULL CHECK (fare_currency IN ('sats', 'asset')),
            fare_units INTEGER NOT NULL CHECK (fare_units >= 0),
            fare_asset_txid BLOB,
            fare_asset_group_index INTEGER,
            max_fare_json TEXT NOT NULL,
            graph_json TEXT NOT NULL,
            graph_id TEXT NOT NULL,
            solver_graph_json TEXT,
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
            CHECK ((offer_txid IS NULL) = (offer_vout IS NULL)),
            CHECK ((fare_currency = 'asset') = (fare_asset_txid IS NOT NULL)),
            CHECK ((fare_asset_txid IS NULL) = (fare_asset_group_index IS NULL)),
            CHECK ((outpoint_txid IS NULL) = (outpoint_vout IS NULL))
        );
        CREATE UNIQUE INDEX swap_fills_operation ON swap_fills (operation_id);
        CREATE INDEX swap_fills_state ON swap_fills (state, expires_at);
        CREATE TABLE swap_fill_reservations (
            outpoint_txid TEXT NOT NULL,
            outpoint_vout INTEGER NOT NULL CHECK (outpoint_vout BETWEEN 0 AND 4294967295),
            fill_id TEXT NOT NULL REFERENCES swap_fills(id),
            created_at INTEGER NOT NULL,
            PRIMARY KEY (outpoint_txid, outpoint_vout)
        );
        CREATE INDEX swap_fill_reservations_fill ON swap_fill_reservations (fill_id);`,
    },
    {
        id: 4,
        // The settlement proof identifies sponsor outputs by script, so the
        // sponsor script is stored beside the solver proceeds script. Rows
        // predate deployment, so no backfill beyond the empty default.
        up: `ALTER TABLE swap_fills ADD COLUMN sponsor_script TEXT NOT NULL DEFAULT ''`,
    },
    {
        id: 5,
        // Additive and nullable: NULL is the legacy four-leaf covenant, so no
        // row is rewritten and no address changes.
        up: `ALTER TABLE advances ADD COLUMN claim_mode TEXT
            CHECK (claim_mode IS NULL OR claim_mode IN ('recycle', 'purchase'))`,
    },
    {
        id: 6,
        up: `ALTER TABLE advances ADD COLUMN recovery_recipient TEXT
            CHECK (recovery_recipient IS NULL OR recovery_recipient IN ('sender', 'receiver'))`,
    },
    {
        id: 7,
        up: `CREATE TABLE receive_quotes (
            id TEXT PRIMARY KEY,
            state TEXT NOT NULL CHECK (state IN ('quoted', 'bound', 'expired')),
            receiver_address TEXT NOT NULL CHECK (length(receiver_address) > 0),
            maker_public_key TEXT NOT NULL CHECK (
                length(maker_public_key) = 64 AND maker_public_key NOT GLOB '*[^0-9a-f]*'
            ),
            params_json TEXT NOT NULL CHECK (json_valid(params_json)),
            covenant_address TEXT NOT NULL CHECK (length(covenant_address) > 0),
            fare_json TEXT NOT NULL CHECK (json_valid(fare_json)),
            batch_expiry_kind TEXT NOT NULL CHECK (batch_expiry_kind IN ('height', 'time')),
            batch_expiry_value INTEGER NOT NULL,
            input_expiry_floor_kind TEXT NOT NULL CHECK (input_expiry_floor_kind IN ('height', 'time')),
            input_expiry_floor_value INTEGER NOT NULL,
            recovery_locktime_kind TEXT NOT NULL CHECK (recovery_locktime_kind IN ('height', 'time')),
            recovery_locktime_value INTEGER NOT NULL,
            loan_sats INTEGER NOT NULL CHECK (loan_sats > 0),
            created_at INTEGER NOT NULL,
            expires_at INTEGER NOT NULL,
            policy_revision INTEGER NOT NULL CHECK (policy_revision >= 0),
            operator_inputs_json TEXT NOT NULL CHECK (json_valid(operator_inputs_json)),
            bound_fill_id TEXT,
            CHECK (expires_at > created_at),
            CHECK (batch_expiry_kind = input_expiry_floor_kind),
            CHECK (input_expiry_floor_kind = recovery_locktime_kind),
            CHECK (batch_expiry_value >= input_expiry_floor_value),
            CHECK (input_expiry_floor_value > recovery_locktime_value),
            CHECK ((state = 'bound') = (bound_fill_id IS NOT NULL))
        );
        CREATE INDEX receive_quotes_state_expiry ON receive_quotes (state, expires_at);
        CREATE TABLE receive_quote_reservations (
            outpoint_txid TEXT NOT NULL CHECK (
                length(outpoint_txid) = 64 AND outpoint_txid NOT GLOB '*[^0-9a-f]*'
            ),
            outpoint_vout INTEGER NOT NULL CHECK (outpoint_vout BETWEEN 0 AND 4294967295),
            quote_id TEXT NOT NULL REFERENCES receive_quotes(id),
            created_at INTEGER NOT NULL,
            PRIMARY KEY (outpoint_txid, outpoint_vout)
        );
        CREATE INDEX receive_quote_reservations_quote ON receive_quote_reservations (quote_id);`,
    },
    {
        id: 8,
        up: `ALTER TABLE swap_fills ADD COLUMN receive_quote_id TEXT;
        CREATE UNIQUE INDEX swap_fills_receive_quote ON swap_fills (receive_quote_id)
            WHERE receive_quote_id IS NOT NULL;`,
    },
    {
        id: 9,
        // Additive and nullable: NULL is a fill quoted without a caller
        // deadline, which is the legacy operator-TTL-only behaviour.
        up: `ALTER TABLE swap_fills ADD COLUMN valid_until INTEGER
            CHECK (valid_until IS NULL OR valid_until > 0)`,
    },
    {
        id: 10,
        // Additive and nullable on both tables. NULL is a sender-paid transfer, which
        // is every row written before this migration. `advances` matters as much as
        // `receive_quotes`: the claim feed and every recovery rebuild read the advance,
        // and the fare is part of the covenant address.
        up: `ALTER TABLE receive_quotes ADD COLUMN payer TEXT
                CHECK (payer IS NULL OR payer = 'receiver');
             ALTER TABLE receive_quotes ADD COLUMN receiver_fare_json TEXT
                CHECK (receiver_fare_json IS NULL OR json_valid(receiver_fare_json))
                CHECK ((payer IS NULL) = (receiver_fare_json IS NULL));
             ALTER TABLE advances ADD COLUMN receiver_fare_currency TEXT
                CHECK (receiver_fare_currency IS NULL OR receiver_fare_currency IN ('sats','asset'));
             ALTER TABLE advances ADD COLUMN receiver_fare_units TEXT
                CHECK ((receiver_fare_currency IS NULL) = (receiver_fare_units IS NULL))
                CHECK (receiver_fare_units IS NULL
                    OR (receiver_fare_units GLOB '[0-9]*' AND receiver_fare_units NOT GLOB '*[^0-9]*'));`,
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
    const maxKnown = Math.max(...ordered.map((m) => m.id));
    const hasCanonicalV1 =
        current > 0 &&
        db
            .prepare(
                "SELECT 1 FROM pragma_table_info('advances') WHERE name = 'asset_units' AND type = 'INTEGER'",
            )
            .get() &&
        db
            .prepare(
                "SELECT 1 FROM pragma_table_info('proceeds_jobs') WHERE name = 'lease_until' AND type = 'INTEGER'",
            )
            .get() &&
        db
            .prepare(
                "SELECT 1 FROM pragma_table_info('proceeds_inputs') WHERE name = 'job_id' AND type = 'TEXT'",
            )
            .get() &&
        db
            .prepare(
                "SELECT 1 FROM pragma_table_info('proceeds_jobs') WHERE name = 'submission_state' AND type = 'TEXT'",
            )
            .get() &&
        db
            .prepare(
                "SELECT 1 FROM pragma_table_info('proceeds_local_intents') WHERE name = 'digest' AND type = 'TEXT'",
            )
            .get();
    const hasKind =
        hasCanonicalV1 &&
        !!db
            .prepare(
                "SELECT 1 FROM pragma_table_info('advances') WHERE name = 'kind' AND type = 'TEXT'",
            )
            .get();
    const hasSwapFills =
        hasKind &&
        !!db
            .prepare(
                "SELECT 1 FROM pragma_table_info('swap_fills') WHERE name = 'graph_id' AND type = 'TEXT'",
            )
            .get() &&
        !!db
            .prepare(
                "SELECT 1 FROM pragma_table_info('swap_fill_reservations') WHERE name = 'fill_id' AND type = 'TEXT'",
            )
            .get();
    const hasSponsorScript =
        hasSwapFills &&
        !!db
            .prepare(
                "SELECT 1 FROM pragma_table_info('swap_fills') WHERE name = 'sponsor_script' AND type = 'TEXT'",
            )
            .get();
    const hasClaimMode =
        hasSponsorScript &&
        !!db
            .prepare(
                "SELECT 1 FROM pragma_table_info('advances') WHERE name = 'claim_mode' AND type = 'TEXT'",
            )
            .get();
    const hasRecoveryRecipient =
        hasClaimMode &&
        !!db
            .prepare(
                "SELECT 1 FROM pragma_table_info('advances') WHERE name = 'recovery_recipient' AND type = 'TEXT'",
            )
            .get();
    const hasReceiveQuotes =
        hasRecoveryRecipient &&
        !!db
            .prepare(
                "SELECT 1 FROM pragma_table_info('receive_quotes') WHERE name = 'input_expiry_floor_value' AND type = 'INTEGER'",
            )
            .get() &&
        !!db
            .prepare(
                "SELECT 1 FROM pragma_table_info('receive_quote_reservations') WHERE name = 'quote_id' AND type = 'TEXT'",
            )
            .get();
    const hasReceiveQuoteLink =
        hasReceiveQuotes &&
        !!db
            .prepare(
                "SELECT 1 FROM pragma_table_info('swap_fills') WHERE name = 'receive_quote_id' AND type = 'TEXT'",
            )
            .get();
    const hasSwapFillDeadline =
        hasReceiveQuoteLink &&
        !!db
            .prepare(
                "SELECT 1 FROM pragma_table_info('swap_fills') WHERE name = 'valid_until' AND type = 'INTEGER'",
            )
            .get();
    const hasReceiverPaid =
        hasSwapFillDeadline &&
        !!db
            .prepare(
                "SELECT 1 FROM pragma_table_info('advances') WHERE name = 'receiver_fare_currency' AND type = 'TEXT'",
            )
            .get();
    if (
        migrations === MIGRATIONS &&
        current > 0 &&
        (current > maxKnown ||
            (current === 1 && !hasCanonicalV1) ||
            (current === 2 && !hasKind) ||
            (current === 3 && !hasSwapFills) ||
            (current === 4 && !hasSponsorScript) ||
            (current === 5 && !hasClaimMode) ||
            (current === 6 && !hasRecoveryRecipient) ||
            (current === 7 && !hasReceiveQuotes) ||
            (current === 8 && !hasReceiveQuoteLink) ||
            (current === 9 && !hasSwapFillDeadline) ||
            (current === 10 && !hasReceiverPaid))
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
