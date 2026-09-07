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
    locktime: 100n,
    covenant_address: "tark1qexample",
    fee_sats: 10n,
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
    it("accepts every AdvanceState", () => {
        const db = migrated();

        for (const [i, state] of ADVANCE_STATES.entries()) {
            expect(() => insertRaw(db, { id: `a${i}`, state })).not.toThrow();
        }
        expect(ADVANCE_STATES).toHaveLength(8);
    });

    it("rejects a state outside the eight", () => {
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
                    `INSERT INTO policy (id, paused, fee_flat_sats, fee_bps, max_outstanding_sats,
                     max_per_payment_topup_sats, max_concurrent_advances, locktime_margin_blocks,
                     asset_allowlist, quote_ttl_seconds)
                     VALUES (?, 0, 0, 0, 0, 0, 0, 0, NULL, 60)`,
                )
                .run(id);

        expect(() => insert(1)).not.toThrow();
        expect(() => insert(2)).toThrow(/CHECK constraint failed/);
    });
});
