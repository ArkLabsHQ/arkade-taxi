import { beforeEach, describe, expect, it } from "vitest";
import DatabaseCtor from "better-sqlite3";
import type { Database } from "better-sqlite3";
import type { Policy } from "@arkade-taxi/core";
import { applyMigrations } from "../src/schema.js";
import { DEFAULT_POLICY, PolicyRepository } from "../src/policy.js";

const RULE = {
    assetId: null,
    enabled: true,
    fares: [
        {
            id: "t",
            currency: { kind: "sats" as const },
            pricing: { kind: "flat" as const, units: 5n },
        },
    ],
    claim: "either" as const,
    maxTopupSats: null,
};

const TOKEN_ID = { txid: new Uint8Array(32).fill(9), groupIndex: 0 };
const TOKEN_RULE = {
    assetId: TOKEN_ID,
    enabled: true,
    fares: [
        {
            id: "ticket",
            currency: { kind: "token" as const, assetId: TOKEN_ID },
            pricing: { kind: "flat" as const, units: 1n },
        },
    ],
    claim: "purchase" as const,
    maxTopupSats: 500n,
};

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
        repo.update({ locktimeMarginBlocks: 45 }, "alice");

        const second = new PolicyRepository(db);

        expect(second.get().locktimeMarginBlocks).toBe(45);
        expect(
            Number(db.prepare<[], { n: bigint }>("SELECT count(*) n FROM policy").get()!.n),
        ).toBe(1);
    });
});

describe("round-trip fidelity", () => {
    it("keeps sats caps exact above Number.MAX_SAFE_INTEGER", () => {
        const updated = repo.update(
            { maxOutstandingSats: INT64_MAX, maxPerPaymentTopupSats: 9_007_199_254_740_993n },
            "alice",
        );

        expect(updated.maxOutstandingSats).toBe(INT64_MAX);
        expect(repo.get().maxOutstandingSats).toBe(INT64_MAX);
        expect(repo.get().maxPerPaymentTopupSats).toBe(9_007_199_254_740_993n);
    });

    it("returns booleans and numbers with their domain types", () => {
        repo.update(
            { paused: false, locktimeMarginBlocks: 30, maxConcurrentAdvances: 12 },
            "alice",
        );

        const p = repo.get();

        expect(p.paused).toBe(false);
        expect(typeof p.paused).toBe("boolean");
        expect(typeof p.locktimeMarginBlocks).toBe("number");
        expect(typeof p.maxConcurrentAdvances).toBe("number");
    });

    // The nested structure carries both types JSON cannot: a bigint fare and a
    // Uint8Array asset id.
    it("round-trips asset rules including bigints and asset ids", () => {
        repo.update({ assetRules: [RULE, TOKEN_RULE] }, "alice");
        expect(repo.get().assetRules).toEqual([RULE, TOKEN_RULE]);
    });

    it("stores an empty rule list as serving nothing, not as absent", () => {
        repo.update({ assetRules: [RULE] }, "alice");
        repo.update({ assetRules: [] }, "alice");
        expect(repo.get().assetRules).toEqual([]);
    });
});

describe("audit", () => {
    it("writes one row per changed field, attributed to the actor", () => {
        const before = Date.now();

        repo.update(
            { paused: false, locktimeMarginBlocks: 30, maxOutstandingSats: 500n },
            "alice@ui",
        );

        const rows = repo.history(10);
        expect(rows).toHaveLength(3);
        expect(rows.map((r) => r.field).sort()).toEqual([
            "locktimeMarginBlocks",
            "maxOutstandingSats",
            "paused",
        ]);
        expect(rows.every((r) => r.actor === "alice@ui")).toBe(true);
        expect(rows.every((r) => r.changedAt >= before && r.changedAt <= Date.now())).toBe(true);

        const margin = rows.find((r) => r.field === "locktimeMarginBlocks")!;
        expect(margin.oldValue).toBe(String(DEFAULT_POLICY.locktimeMarginBlocks));
        expect(margin.newValue).toBe("30");
        const paused = rows.find((r) => r.field === "paused")!;
        expect(paused.oldValue).toBe("true");
        expect(paused.newValue).toBe("false");
    });

    it("serialises bigints in full and rules as JSON", () => {
        repo.update({ maxOutstandingSats: INT64_MAX, assetRules: [RULE] }, "alice");

        const rows = repo.history(10);

        expect(rows.find((r) => r.field === "maxOutstandingSats")!.newValue).toBe(
            INT64_MAX.toString(),
        );
        const rules = rows.find((r) => r.field === "assetRules")!;
        expect(rules.oldValue).toBe("[]");
        expect(JSON.parse(rules.newValue)).toHaveLength(1);
    });

    it("ignores fields whose value did not change", () => {
        repo.update({ locktimeMarginBlocks: 30 }, "alice");

        repo.update({ locktimeMarginBlocks: 30, paused: DEFAULT_POLICY.paused }, "bob");

        expect(auditCount()).toBe(1);
    });

    it("compares rules by contents, not by reference", () => {
        repo.update({ assetRules: [RULE] }, "alice");

        repo.update({ assetRules: [{ ...RULE }] }, "bob");
        expect(auditCount()).toBe(1);

        repo.update({ assetRules: [] }, "bob");
        expect(auditCount()).toBe(2);
    });

    it("treats an omitted key and an undefined value alike", () => {
        repo.update({ locktimeMarginBlocks: undefined }, "alice");

        expect(auditCount()).toBe(0);
        expect(repo.get()).toEqual(DEFAULT_POLICY);
    });

    it("returns history newest first, capped by limit", () => {
        repo.update({ locktimeMarginBlocks: 1 }, "alice");
        repo.update({ locktimeMarginBlocks: 2 }, "bob");
        repo.update({ locktimeMarginBlocks: 3 }, "carol");

        expect(repo.history(2).map((r) => r.newValue)).toEqual(["3", "2"]);
        expect(repo.history(10)).toHaveLength(3);
        expect(repo.history(10)[0]!.actor).toBe("carol");
        expect(typeof repo.history(1)[0]!.id).toBe("number");
    });
});

describe("rejections", () => {
    it("refuses an unattributed edit", () => {
        expect(() => repo.update({ locktimeMarginBlocks: 30 }, "  ")).toThrow(/actor/i);
        expect(auditCount()).toBe(0);
        expect(repo.get().locktimeMarginBlocks).toBe(DEFAULT_POLICY.locktimeMarginBlocks);
    });

    it("refuses a field name outside the Policy contract", () => {
        const hostile = { "quote_ttl_seconds = 0, actor": 1 } as unknown as Partial<Policy>;

        expect(() => repo.update(hostile, "mallory")).toThrow(/unknown policy field/i);
        expect(repo.get()).toEqual(DEFAULT_POLICY);
    });

    it("leaves neither policy nor audit changed when one field in the patch is rejected", () => {
        expect(() =>
            repo.update(
                { locktimeMarginBlocks: 30, bogus: 1 } as unknown as Partial<Policy>,
                "mallory",
            ),
        ).toThrow();

        expect(repo.get().locktimeMarginBlocks).toBe(DEFAULT_POLICY.locktimeMarginBlocks);
        expect(auditCount()).toBe(0);
    });
});
