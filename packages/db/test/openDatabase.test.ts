import { afterAll, describe, expect, it } from "vitest";
import DatabaseCtor, { type Database } from "better-sqlite3";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { applyMigrations, MIGRATIONS, openDatabase, PolicyRepository } from "../src/index.js";

const dir = mkdtempSync(join(tmpdir(), "taxi-database-durability-"));
afterAll(() => {
    expect(dirname(resolve(dir))).toBe(resolve(tmpdir()));
    expect(basename(dir).startsWith("taxi-database-durability-")).toBe(true);
    rmSync(dir, { recursive: true, force: true });
});
const amount = 9_007_199_254_740_993n;

function schema(db: Database) {
    return db
        .prepare("SELECT type, name, tbl_name, sql FROM sqlite_master ORDER BY type, name")
        .all();
}

function expectFull(db: Database) {
    expect(Number(db.pragma("synchronous", { simple: true }))).toBe(2);
}

describe("openDatabase durability", () => {
    it("opens a new disk database in WAL with full durability and migrations", () => {
        const db = openDatabase(join(dir, "new.sqlite"));
        try {
            expect(db.pragma("journal_mode", { simple: true })).toBe("wal");
            expectFull(db);
            expect(Number(db.pragma("user_version", { simple: true }))).toBe(
                Math.max(...MIGRATIONS.map((migration) => migration.id)),
            );
            expect(new PolicyRepository(db).get().paused).toBe(true);
        } finally {
            db.close();
        }
    });

    it("upgrades a DELETE database without changing schema, policy, audit, or bigint values", () => {
        const path = join(dir, "existing.sqlite");
        const previous = new DatabaseCtor(path);
        previous.defaultSafeIntegers(true);
        previous.pragma("journal_mode = DELETE");
        previous.pragma("synchronous = FULL");
        applyMigrations(previous);
        new PolicyRepository(previous).update({ maxOutstandingSats: amount }, "test");
        const expectedSchema = schema(previous);
        const expectedPolicy = new PolicyRepository(previous).getSnapshot();
        const expectedAudit = new PolicyRepository(previous).history(10);
        const expectedVersion = previous.pragma("user_version", { simple: true });
        previous.close();
        for (let attempt = 0; attempt < 2; attempt++) {
            const db = openDatabase(path);
            try {
                expect(db.pragma("journal_mode", { simple: true })).toBe("wal");
                expectFull(db);
                expect(schema(db)).toEqual(expectedSchema);
                expect(db.pragma("user_version", { simple: true })).toBe(expectedVersion);
                expect(new PolicyRepository(db).getSnapshot()).toEqual(expectedPolicy);
                expect(new PolicyRepository(db).history(10)).toEqual(expectedAudit);
                expect(db.prepare("SELECT max_outstanding_sats FROM policy").get()).toEqual({
                    max_outstanding_sats: amount,
                });
                expect(db.pragma("integrity_check", { simple: true })).toBe("ok");
            } finally {
                db.close();
            }
        }
    });

    it("retains in-memory operation, full durability setting, and bigint precision", () => {
        const db = openDatabase(":memory:");
        try {
            expect(db.pragma("journal_mode", { simple: true })).toBe("memory");
            expectFull(db);
            new PolicyRepository(db).update({ maxOutstandingSats: amount }, "test");
            expect(new PolicyRepository(db).get().maxOutstandingSats).toBe(amount);
        } finally {
            db.close();
        }
    });

    it("recovers committed rows after immediate child exit and discards rolled-back and unfinished writes", () => {
        const path = join(dir, "abrupt.sqlite");
        const moduleUrl = new URL("../dist/index.js", import.meta.url).href;
        const child = spawnSync(
            process.execPath,
            [
                "--input-type=module",
                "--eval",
                `import { openDatabase } from ${JSON.stringify(moduleUrl)};
const db = openDatabase(process.argv[1]);
if (db.pragma("journal_mode", { simple: true }) !== "wal") process.exit(11);
if (Number(db.pragma("synchronous", { simple: true })) !== 2) process.exit(12);
db.exec("CREATE TABLE durable_rows (id INTEGER PRIMARY KEY, amount INTEGER NOT NULL)");
const insert = db.prepare("INSERT INTO durable_rows VALUES (?, ?)");
db.transaction(() => insert.run(1, 9007199254740993n))();
db.exec("BEGIN IMMEDIATE");
insert.run(2, 9007199254740995n);
db.exec("ROLLBACK");
db.exec("BEGIN IMMEDIATE");
insert.run(3, 9007199254740997n);
process.exit(17);`,
                path,
            ],
            { encoding: "utf8", timeout: 4000 },
        );
        expect(child.error).toBeUndefined();
        expect(child.signal).toBeNull();
        expect(child.status).toBe(17);
        expect(child.stdout).toBe("");
        expect(child.stderr).toBe("");
        expect(existsSync(`${path}-wal`)).toBe(true);
        const db = openDatabase(path);
        try {
            expectFull(db);
            expect(db.prepare("SELECT * FROM durable_rows ORDER BY id").all()).toEqual([
                { id: 1n, amount },
            ]);
            expect(db.pragma("integrity_check", { simple: true })).toBe("ok");
        } finally {
            db.close();
        }
    });
});
