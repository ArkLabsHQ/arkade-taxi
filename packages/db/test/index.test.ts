import { afterAll, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
    ADVANCE_STATES,
    AdvanceRepository,
    DEFAULT_POLICY,
    MIGRATIONS,
    openDatabase,
    PolicyRepository,
    applyMigrations,
} from "../src/index.js";

const dir = mkdtempSync(join(tmpdir(), "arkade-taxi-db-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const ABOVE_MAX_SAFE = 9_007_199_254_740_993n;

function seedAdvance(repo: AdvanceRepository, id: string): void {
    repo.insert({
        id,
        state: "locked",
        receiverKey: new Uint8Array(32).fill(1),
        senderKey: new Uint8Array(32).fill(2),
        operatorKey: new Uint8Array(32).fill(3),
        dust: ABOVE_MAX_SAFE,
        topup: 300n,
        locktime: 850_000n,
        covenantAddress: "tark1qcovenantexample",
        fare: { currency: "sats", units: 25n },
        createdAt: 1,
        updatedAt: 1,
        expiresAt: 2,
    });
}

describe("openDatabase", () => {
    it("returns a migrated in-memory database", () => {
        const db = openDatabase(":memory:");

        expect(Number(db.pragma("user_version", { simple: true }))).toBe(
            Math.max(...MIGRATIONS.map((m) => m.id)),
        );
        const repo = new AdvanceRepository(db);
        seedAdvance(repo, "a1");
        expect(repo.get("a1")?.dust).toBe(ABOVE_MAX_SAFE);
        expect(new PolicyRepository(db).get()).toEqual(DEFAULT_POLICY);
    });

    it("defaults ad-hoc queries to safe integers", () => {
        const db = openDatabase(":memory:");
        seedAdvance(new AdvanceRepository(db), "a1");

        const row = db.prepare<[], { dust: bigint }>("SELECT dust FROM advances").get();

        expect(row?.dust).toBe(ABOVE_MAX_SAFE);
    });

    it("persists to a file and re-migrates idempotently on reopen", () => {
        const path = join(dir, "taxi.sqlite");

        const first = openDatabase(path);
        seedAdvance(new AdvanceRepository(first), "a1");
        new PolicyRepository(first).update({ locktimeMarginBlocks: 42 }, "alice");
        first.close();

        const second = openDatabase(path);

        expect(new AdvanceRepository(second).get("a1")?.dust).toBe(ABOVE_MAX_SAFE);
        expect(new PolicyRepository(second).get().locktimeMarginBlocks).toBe(42);
        expect(new PolicyRepository(second).history(10)).toHaveLength(1);
        second.close();
    });

    it("re-exports the schema surface", () => {
        expect(ADVANCE_STATES).toContain("locked");
        expect(typeof applyMigrations).toBe("function");
        expect(MIGRATIONS.length).toBeGreaterThan(0);
    });
});
