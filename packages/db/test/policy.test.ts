import { beforeEach, describe, expect, it } from "vitest";
import DatabaseCtor from "better-sqlite3";
import type { Database } from "better-sqlite3";
import type { Policy } from "@arkade-taxi/core";
import { applyMigrations } from "../src/schema.js";
import { DEFAULT_POLICY, PolicyRepository } from "../src/policy.js";

const INT64_MAX = 9_223_372_036_854_775_807n;

let db: Database;
let repo: PolicyRepository;

beforeEach(() => {
    db = new DatabaseCtor(":memory:");
    applyMigrations(db);
    repo = new PolicyRepository(db);
});

const auditCount = () =>
    Number(db.prepare<[], { n: bigint }>("SELECT count(*) n FROM policy_audit").get()!.n);

describe("seeding", () => {
    it("seeds defaults on first use without auditing the seed", () => {
        expect(repo.get()).toEqual(DEFAULT_POLICY);
        expect(auditCount()).toBe(0);
    });

    it("does not re-seed over an edited policy", () => {
        repo.update({ feeBps: 45 }, "alice");

        const second = new PolicyRepository(db);

        expect(second.get().feeBps).toBe(45);
        expect(
            Number(db.prepare<[], { n: bigint }>("SELECT count(*) n FROM policy").get()!.n),
        ).toBe(1);
    });
});

describe("round-trip fidelity", () => {
    it("keeps sats caps exact above Number.MAX_SAFE_INTEGER", () => {
        const updated = repo.update(
            { maxOutstandingSats: INT64_MAX, feeFlatSats: 9_007_199_254_740_993n },
            "alice",
        );

        expect(updated.maxOutstandingSats).toBe(INT64_MAX);
        expect(repo.get().maxOutstandingSats).toBe(INT64_MAX);
        expect(repo.get().feeFlatSats).toBe(9_007_199_254_740_993n);
    });

    it("returns booleans and numbers with their domain types", () => {
        repo.update({ paused: false, feeBps: 30, maxConcurrentAdvances: 12 }, "alice");

        const p = repo.get();

        expect(p.paused).toBe(false);
        expect(typeof p.paused).toBe("boolean");
        expect(typeof p.feeBps).toBe("number");
        expect(typeof p.maxConcurrentAdvances).toBe("number");
    });

    it("distinguishes an empty allowlist from an absent one", () => {
        expect(repo.update({ assetAllowlist: null }, "alice").assetAllowlist).toBeNull();
        expect(repo.get().assetAllowlist).toBeNull();

        expect(repo.update({ assetAllowlist: [] }, "alice").assetAllowlist).toEqual([]);
        expect(repo.get().assetAllowlist).toEqual([]);

        repo.update({ assetAllowlist: ["usd", "eur"] }, "alice");
        expect(repo.get().assetAllowlist).toEqual(["usd", "eur"]);
    });
});

describe("audit", () => {
    it("writes one row per changed field, attributed to the actor", () => {
        const before = Date.now();

        repo.update({ paused: false, feeBps: 30, feeFlatSats: 500n }, "alice@ui");

        const rows = repo.history(10);
        expect(rows).toHaveLength(3);
        expect(rows.map((r) => r.field).sort()).toEqual(["feeBps", "feeFlatSats", "paused"]);
        expect(rows.every((r) => r.actor === "alice@ui")).toBe(true);
        expect(rows.every((r) => r.changedAt >= before && r.changedAt <= Date.now())).toBe(true);

        const bps = rows.find((r) => r.field === "feeBps")!;
        expect(bps.oldValue).toBe("0");
        expect(bps.newValue).toBe("30");
        const paused = rows.find((r) => r.field === "paused")!;
        expect(paused.oldValue).toBe("true");
        expect(paused.newValue).toBe("false");
    });

    it("serialises bigints in full and allowlists as JSON", () => {
        repo.update({ feeFlatSats: INT64_MAX, assetAllowlist: ["usd"] }, "alice");

        const rows = repo.history(10);

        expect(rows.find((r) => r.field === "feeFlatSats")!.newValue).toBe(INT64_MAX.toString());
        const allow = rows.find((r) => r.field === "assetAllowlist")!;
        expect(allow.oldValue).toBe("[]");
        expect(allow.newValue).toBe('["usd"]');
    });

    it("ignores fields whose value did not change", () => {
        repo.update({ feeBps: 30 }, "alice");

        repo.update({ feeBps: 30, paused: DEFAULT_POLICY.paused }, "bob");

        expect(auditCount()).toBe(1);
    });

    it("compares allowlists by contents, not by reference", () => {
        repo.update({ assetAllowlist: ["usd"] }, "alice");

        repo.update({ assetAllowlist: ["usd"] }, "bob");
        expect(auditCount()).toBe(1);

        repo.update({ assetAllowlist: ["usd", "eur"] }, "bob");
        expect(auditCount()).toBe(2);
    });

    it("treats an omitted key and an undefined value alike", () => {
        repo.update({ feeBps: undefined }, "alice");

        expect(auditCount()).toBe(0);
        expect(repo.get()).toEqual(DEFAULT_POLICY);
    });

    it("returns history newest first, capped by limit", () => {
        repo.update({ feeBps: 1 }, "alice");
        repo.update({ feeBps: 2 }, "bob");
        repo.update({ feeBps: 3 }, "carol");

        expect(repo.history(2).map((r) => r.newValue)).toEqual(["3", "2"]);
        expect(repo.history(10)).toHaveLength(3);
        expect(repo.history(10)[0]!.actor).toBe("carol");
        expect(typeof repo.history(1)[0]!.id).toBe("number");
    });
});

describe("rejections", () => {
    it("refuses an unattributed edit", () => {
        expect(() => repo.update({ feeBps: 30 }, "  ")).toThrow(/actor/i);
        expect(auditCount()).toBe(0);
        expect(repo.get().feeBps).toBe(DEFAULT_POLICY.feeBps);
    });

    it("refuses a field name outside the Policy contract", () => {
        const hostile = { "quote_ttl_seconds = 0, actor": 1 } as unknown as Partial<Policy>;

        expect(() => repo.update(hostile, "mallory")).toThrow(/unknown policy field/i);
        expect(repo.get()).toEqual(DEFAULT_POLICY);
    });

    it("leaves neither policy nor audit changed when one field in the patch is rejected", () => {
        expect(() =>
            repo.update({ feeBps: 30, bogus: 1 } as unknown as Partial<Policy>, "mallory"),
        ).toThrow();

        expect(repo.get().feeBps).toBe(DEFAULT_POLICY.feeBps);
        expect(auditCount()).toBe(0);
    });
});
