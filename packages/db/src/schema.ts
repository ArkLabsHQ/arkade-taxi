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
    fee_sats          INTEGER NOT NULL,
    outpoint_txid     TEXT,
    outpoint_vout     INTEGER,
    spent_txid        TEXT,
    created_at        INTEGER NOT NULL,
    updated_at        INTEGER NOT NULL,
    expires_at        INTEGER NOT NULL,
    CHECK ((asset_txid IS NULL) = (asset_group_index IS NULL)),
    CHECK ((outpoint_txid IS NULL) = (outpoint_vout IS NULL))
);

CREATE INDEX advances_state_locktime ON advances (state, locktime);
CREATE UNIQUE INDEX advances_outpoint ON advances (outpoint_txid, outpoint_vout);

CREATE TABLE policy (
    id                         INTEGER PRIMARY KEY CHECK (id = 1),
    paused                     INTEGER NOT NULL CHECK (paused IN (0, 1)),
    fee_flat_sats              INTEGER NOT NULL,
    fee_bps                    INTEGER NOT NULL,
    max_outstanding_sats       INTEGER NOT NULL,
    max_per_payment_topup_sats INTEGER NOT NULL,
    max_concurrent_advances    INTEGER NOT NULL,
    locktime_margin_blocks     INTEGER NOT NULL,
    asset_allowlist            TEXT,
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

/**
 * Defaults to 1 (allowed) so an existing row keeps quoting bitcoin: this split
 * the asset allowlist in two, and a migration that silently stopped a service
 * from quoting what it quoted yesterday would be the wrong way to land it.
 */
const ADD_ALLOW_BITCOIN = `
ALTER TABLE policy ADD COLUMN allow_bitcoin INTEGER NOT NULL DEFAULT 1 CHECK (allow_bitcoin IN (0, 1));
`;

export const MIGRATIONS: readonly Migration[] = [
    { id: 1, up: INITIAL_SCHEMA },
    { id: 2, up: ADD_ALLOW_BITCOIN },
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
