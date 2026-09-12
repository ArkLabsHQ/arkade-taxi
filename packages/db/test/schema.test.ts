import { describe, expect, it } from "vitest";
import DatabaseCtor from "better-sqlite3";
import type { Database } from "better-sqlite3";
import { ADVANCE_STATES, applyMigrations, MIGRATIONS } from "../src/schema.js";

function fresh(): Database {
    const db = new DatabaseCtor(":memory:");
    db.defaultSafeIntegers(true);
    return db;
}

function migrated(): Database {
    const db = fresh();
    applyMigrations(db);
    return db;
}

function userVersion(db: Database): number {
    return Number(db.pragma("user_version", { simple: true }));
}

function tableNames(db: Database): string[] {
    return db
        .prepare<[], { name: string }>("SELECT name FROM sqlite_master WHERE type = 'table'")
        .all()
        .map((r) => r.name);
}

const RAW_ADVANCE = {
    id: "a1",
    state: "quoted",
    receiver_key: new Uint8Array(32).fill(1),
    sender_key: new Uint8Array(32).fill(2),
    operator_key: new Uint8Array(32).fill(3),
    dust: 330n,
    topup: 300n,
    asset_txid: null,
    asset_group_index: null,
    asset_units: null,
    locktime: 100n,
    covenant_address: "tark1qexample",
    fare_currency: "sats",
    fare_units: 10n,
    fare_asset_txid: null,
    fare_asset_group_index: null,
    outpoint_txid: null,
    outpoint_vout: null,
    spent_txid: null,
    created_at: 1n,
    updated_at: 1n,
    expires_at: 2n,
};

function insertRaw(db: Database, overrides: Record<string, unknown> = {}): void {
    const row = { ...RAW_ADVANCE, ...overrides };
    const cols = Object.keys(row);
    db.prepare(
        `INSERT INTO advances (${cols.join(", ")}) VALUES (${cols.map((c) => "@" + c).join(", ")})`,
    ).run(row);
}

describe("migrations", () => {
    it("defines one fresh schema; old development databases are unsupported", () => {
        expect(MIGRATIONS.map(({ id }) => id)).toEqual([1]);
        expect(MIGRATIONS[0]!.up).not.toMatch(/ALTER TABLE|advances_v2/i);
        const db = migrated();
        expect(userVersion(db)).toBe(1);
        expect(tableNames(db).sort()).toEqual([
            "advances",
            "operator_input_reservations",
            "policy",
            "policy_audit",
            "sqlite_sequence",
        ]);
        const columns = db
            .prepare<[], { name: string }>("PRAGMA table_info(advances)")
            .all()
            .map(({ name }) => name)
            .sort();
        expect(columns).toEqual(
            `
            id state receiver_key sender_key operator_key dust topup asset_txid asset_group_index
            asset_units locktime covenant_address fare_currency fare_units fare_asset_txid
            fare_asset_group_index outpoint_txid outpoint_vout spent_txid created_at updated_at expires_at
            batch_expiry_kind batch_expiry_value operator_inputs_json unsigned_lockup_tx unsigned_lockup_id
            submission_key ark_txid submitted_at recovery_txid recovery_submitted_at last_observed_at
            failure_code failure_detail signed_envelope_digest submission_phase signed_lockup_envelope
            prepared_ark_tx prepared_checkpoints_json server_final_ark_tx server_checkpoints_json
            submission_lease_owner submission_lease_until submission_attempts submission_last_attempt_at
            submission_next_attempt_at finalized_at submission_lease_token observation_tip_hash
            observation_tip_height observation_stable_tip_hash observation_stable_count observation_stable_tip_height
            recovery_locktime_kind recovery_phase recovery_graph_digest recovery_expected_txid
            recovery_prepared_ark_tx recovery_prepared_checkpoints_json recovery_response_ark_tx
            recovery_response_checkpoints_json recovery_lease_owner recovery_lease_token recovery_lease_until
            recovery_attempts recovery_last_attempt_at recovery_next_attempt_at
        `
                .trim()
                .split(/\s+/)
                .sort(),
        );
        for (const [index, names] of [
            ["advances_state_locktime", ["state", "locktime"]],
            ["advances_state_batch_expiry", ["state", "batch_expiry_kind", "batch_expiry_value"]],
            ["advances_outpoint", ["outpoint_txid", "outpoint_vout"]],
            ["advances_receiver_updated", ["receiver_key", "updated_at", "id"]],
        ] as const) {
            expect(
                db
                    .prepare<[], { name: string }>(`PRAGMA index_info(${index})`)
                    .all()
                    .map(({ name }) => name),
            ).toEqual(names);
        }
        expect(
            db
                .prepare<[], { name: string; unique: bigint }>("PRAGMA index_list(advances)")
                .all()
                .find(({ name }) => name === "advances_outpoint")?.unique,
        ).toBe(1n);
    });
    it("creates every table and stamps user_version with the highest applied id", () => {
        const db = migrated();

        expect(tableNames(db)).toEqual(
            expect.arrayContaining(["advances", "policy", "policy_audit"]),
        );
        expect(userVersion(db)).toBe(Math.max(...MIGRATIONS.map((m) => m.id)));
    });

    it("is idempotent and preserves existing rows on re-application", () => {
        const db = migrated();
        insertRaw(db);

        applyMigrations(db);
        applyMigrations(db);

        expect(db.prepare<[], { n: bigint }>("SELECT count(*) n FROM advances").get()?.n).toBe(1n);
        expect(userVersion(db)).toBe(Math.max(...MIGRATIONS.map((m) => m.id)));
    });

    it("applies pending migrations in id order regardless of array order", () => {
        const db = fresh();

        applyMigrations(db, [
            { id: 2, up: "INSERT INTO t (v) VALUES ('x')" },
            { id: 1, up: "CREATE TABLE t (v TEXT)" },
        ]);

        expect(db.prepare<[], { v: string }>("SELECT v FROM t").get()?.v).toBe("x");
        expect(userVersion(db)).toBe(2);
    });

    it("skips migrations at or below the current user_version", () => {
        const db = fresh();
        applyMigrations(db, [{ id: 1, up: "CREATE TABLE t (v TEXT)" }]);

        applyMigrations(db, [
            { id: 1, up: "SELECT raise_error_if_reapplied" },
            { id: 2, up: "CREATE TABLE u (v TEXT)" },
        ]);

        expect(tableNames(db)).toEqual(expect.arrayContaining(["t", "u"]));
        expect(userVersion(db)).toBe(2);
    });

    it("rolls the whole batch back when one migration fails", () => {
        const db = fresh();

        expect(() =>
            applyMigrations(db, [
                { id: 1, up: "CREATE TABLE t (v TEXT)" },
                { id: 2, up: "CREATE TABLE ((( syntax error" },
            ]),
        ).toThrow();

        expect(tableNames(db)).not.toContain("t");
        expect(userVersion(db)).toBe(0);
    });

    it("rejects duplicate or non-integer migration ids", () => {
        expect(() =>
            applyMigrations(fresh(), [
                { id: 1, up: "CREATE TABLE a (v TEXT)" },
                { id: 1, up: "CREATE TABLE b (v TEXT)" },
            ]),
        ).toThrow(/duplicate/i);
        expect(() =>
            applyMigrations(fresh(), [{ id: 1.5, up: "CREATE TABLE a (v TEXT)" }]),
        ).toThrow(/integer/i);
    });
});

describe("advances constraints", () => {
    it("requires asset identity and quantity together", () => {
        const db = migrated();
        const asset = { asset_txid: new Uint8Array(32).fill(9), asset_group_index: 0n };
        expect(() => insertRaw(db, asset)).toThrow(/CHECK constraint failed/);
        expect(() => insertRaw(db, { asset_units: 1n })).toThrow(/CHECK constraint failed/);
        expect(() => insertRaw(db, { ...asset, asset_units: 9007199254740993n })).not.toThrow();
    });
    it("accepts every AdvanceState", () => {
        const db = migrated();

        for (const [i, state] of ADVANCE_STATES.entries()) {
            expect(() => insertRaw(db, { id: `a${i}`, state })).not.toThrow();
        }
        expect(ADVANCE_STATES).toHaveLength(9);
    });

    it("rejects an unknown state", () => {
        const db = migrated();

        expect(() => insertRaw(db, { state: "settled" })).toThrow(/CHECK constraint failed/);
    });

    it("rejects a half-populated assetId", () => {
        const db = migrated();

        expect(() => insertRaw(db, { asset_txid: new Uint8Array(32).fill(9) })).toThrow(
            /CHECK constraint failed/,
        );
        expect(() => insertRaw(db, { asset_group_index: 0n })).toThrow(/CHECK constraint failed/);
    });

    it("rejects a half-populated outpoint", () => {
        const db = migrated();

        expect(() => insertRaw(db, { outpoint_txid: "ff".repeat(32) })).toThrow(
            /CHECK constraint failed/,
        );
        expect(() => insertRaw(db, { outpoint_vout: 0n })).toThrow(/CHECK constraint failed/);
    });

    it("refuses to bind one outpoint to two advances", () => {
        const db = migrated();
        const outpoint = { outpoint_txid: "aa".repeat(32), outpoint_vout: 1n };
        insertRaw(db, { id: "a1", ...outpoint });

        expect(() => insertRaw(db, { id: "a2", ...outpoint })).toThrow(/UNIQUE constraint failed/);
        expect(() => insertRaw(db, { id: "a3" })).not.toThrow();
    });
});

describe("policy constraints", () => {
    it("admits only the row with id = 1", () => {
        const db = migrated();
        const insert = (id: number) =>
            db
                .prepare(
                    `INSERT INTO policy (id, paused, max_outstanding_sats,
                     max_per_payment_topup_sats, max_concurrent_advances, locktime_margin_blocks,
                     asset_rules, quote_ttl_seconds)
                     VALUES (?, 0, 0, 0, 0, 0, '[]', 60)`,
                )
                .run(id);

        expect(() => insert(1)).not.toThrow();
        expect(() => insert(2)).toThrow(/CHECK constraint failed/);
    });
});
