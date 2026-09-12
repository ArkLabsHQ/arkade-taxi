import { describe, expect, it } from "vitest";
import DatabaseCtor from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Database } from "better-sqlite3";
import { ADVANCE_STATES, applyMigrations, MIGRATIONS } from "../src/schema.js";
import { AdvanceRepository } from "../src/advances.js";
import { PolicyRepository } from "../src/policy.js";

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
    it.each([false, true])(
        "upgrades v1 without inventing funding facts (populated: %s)",
        (populated) => {
            const db = fresh();
            applyMigrations(db, [MIGRATIONS[0]!]);
            if (populated) insertRaw(db);
            applyMigrations(db);
            const repo = new AdvanceRepository(db);
            expect(repo.listMissingFundingSnapshotIds()).toEqual(populated ? ["a1"] : []);
            if (populated) {
                expect(
                    db
                        .prepare(
                            "SELECT topup, batch_expiry_kind, batch_expiry_value FROM advances",
                        )
                        .get(),
                ).toEqual({ topup: 300n, batch_expiry_kind: null, batch_expiry_value: null });
                expect(() => repo.get("a1")).toThrow(/a1.*missing funding snapshot/);
            }
            expect(tableNames(db)).toContain("operator_input_reservations");
            expect(userVersion(db)).toBe(8);
        },
    );
    it("adds stable candidate height without losing a v6 candidate across reopen", () => {
        const directory = mkdtempSync(join(tmpdir(), "taxi-v6-stable-"));
        const path = join(directory, "state.sqlite");
        let db: Database | undefined;
        try {
            db = new DatabaseCtor(path);
            db.defaultSafeIntegers(true);
            applyMigrations(
                db,
                MIGRATIONS.filter(({ id }) => id <= 6),
            );
            insertRaw(db, { id: "stable" });
            db.prepare(
                `UPDATE advances SET observation_stable_tip_hash = ?,
                 observation_stable_count = 1 WHERE id = 'stable'`,
            ).run("34".repeat(32));
            db.close();
            db = new DatabaseCtor(path);
            db.defaultSafeIntegers(true);
            applyMigrations(db);
            expect(userVersion(db)).toBe(8);
            expect(
                db
                    .prepare(
                        `SELECT observation_stable_tip_hash AS hash,
                         observation_stable_tip_height AS height,
                         observation_stable_count AS count FROM advances WHERE id = 'stable'`,
                    )
                    .get(),
            ).toEqual({ hash: "34".repeat(32), height: null, count: 1n });
        } finally {
            db?.close();
            rmSync(directory, { recursive: true, force: true });
        }
    });
    it("marks pre-phase locking rows unresumable while retaining reservations", () => {
        const directory = mkdtempSync(join(tmpdir(), "taxi-v3-"));
        const path = join(directory, "state.sqlite");
        let db: Database | undefined;
        try {
            db = new DatabaseCtor(path);
            db.defaultSafeIntegers(true);
            applyMigrations(
                db,
                MIGRATIONS.filter(({ id }) => id <= 3),
            );
            new PolicyRepository(db);
            insertRaw(db, {
                state: "locking",
                batch_expiry_kind: "height",
                batch_expiry_value: 200n,
                operator_inputs_json: JSON.stringify([{ txid: "ab".repeat(32), vout: 0 }]),
                unsigned_lockup_tx: "legacy-envelope",
                unsigned_lockup_id: "cd".repeat(32),
            });
            insertRaw(db, {
                id: "a2",
                state: "locked",
                batch_expiry_kind: "height",
                batch_expiry_value: 200n,
                operator_inputs_json: JSON.stringify([{ txid: "ef".repeat(32), vout: 1 }]),
                unsigned_lockup_tx: "locked-envelope",
                unsigned_lockup_id: "12".repeat(32),
                outpoint_txid: "34".repeat(32),
                outpoint_vout: 0,
            });
            db.prepare(
                `INSERT INTO operator_input_reservations
                 (outpoint_txid, outpoint_vout, advance_id, batch_expiry_kind,
                  batch_expiry_value, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
            ).run("ab".repeat(32), 0, "a1", "height", 200, 1);
            db.close();
            db = undefined;

            db = new DatabaseCtor(path);
            db.defaultSafeIntegers(true);
            applyMigrations(db);
            expect(new AdvanceRepository(db).get("a1")).toMatchObject({
                state: "locking",
                submissionPhase: "legacy",
                failureCode: "lockup_submission_legacy_unresumable",
            });
            expect(new AdvanceRepository(db).get("a2")).toMatchObject({
                state: "locked",
                outpoint: { txid: "34".repeat(32), vout: 0 },
            });
            expect(new AdvanceRepository(db).get("a2")?.submissionPhase).toBeUndefined();
            expect(new AdvanceRepository(db).get("a2")?.failureCode).toBeUndefined();
            expect(
                db.prepare("SELECT count(*) AS n FROM operator_input_reservations").get(),
            ).toEqual({ n: 1n });
            expect(db.prepare("SELECT paused FROM policy WHERE id = 1").get()).toEqual({
                paused: 1n,
            });
            db.close();
            db = undefined;
        } finally {
            db?.close();
            rmSync(directory, { recursive: true, force: true });
        }
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
