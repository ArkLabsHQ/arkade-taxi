import { describe, expect, it } from "vitest";
import { DEFAULT_POLICY } from "@arkade-taxi/db";
import { advance, harness, healthySweeper, key } from "./fixtures.js";
import { PATCHABLE_POLICY_KEYS } from "../../src/admin/routes.js";

const INT64_MAX = "9223372036854775807";

describe("mounting", () => {
    it("serves the API when mounted with route('/admin', router)", async () => {
        const h = harness({ mount: "prefix" });

        expect((await h.json("/admin/api/status")).status).toBe(200);
        expect((await h.json("/admin/api/policy")).status).toBe(200);
    });

    it("serves the API when mounted with route('/', router)", async () => {
        const h = harness({ mount: "root" });

        expect((await h.json("/admin/api/status")).status).toBe(200);
        expect((await h.json("/admin/api/policy")).status).toBe(200);
    });

    it("404s an unknown admin path", async () => {
        const h = harness();

        expect((await h.json("/admin/api/nope")).status).toBe(404);
    });
});

describe("GET /admin/api/status", () => {
    it("sums exposure over locked advances only, as decimal strings", async () => {
        const h = harness();
        h.advances.insert(advance({ state: "locked", topup: 9_007_199_254_740_993n }));
        h.advances.insert(advance({ state: "locked", topup: 10n, locktime: 799_000n }));
        h.advances.insert(advance({ state: "quoted", topup: 5_000n }));
        h.advances.insert(advance({ state: "purchased", topup: 6_000n }));

        const { status, body } = await h.json("/admin/api/status");

        expect(status).toBe(200);
        expect(body.exposure).toEqual({
            outstandingSats: "9007199254741003",
            lockedCount: 2,
            oldestUnsweptLocktime: "799000",
        });
    });

    it("reports a null oldest locktime and zero exposure when nothing is locked", async () => {
        const h = harness();
        h.advances.insert(advance({ state: "quoted" }));

        const { body } = await h.json("/admin/api/status");

        expect(body.exposure).toEqual({
            outstandingSats: "0",
            lockedCount: 0,
            oldestUnsweptLocktime: null,
        });
    });

    it("counts every state, zero-filling the empty ones", async () => {
        const h = harness();
        h.advances.insert(advance({ state: "locked" }));
        h.advances.insert(advance({ state: "locked" }));
        h.advances.insert(advance({ state: "recovered" }));

        const { body } = await h.json("/admin/api/status");

        expect(body.counts).toEqual({
            quoted: 0,
            locking: 0,
            locked: 2,
            recycled: 0,
            purchased: 0,
            refunded: 0,
            recovered: 1,
            expired: 0,
        });
        expect(body.total).toBe(3);
    });

    it("reports the live policy pause switch", async () => {
        const h = harness();

        expect((await h.json("/admin/api/status")).body.paused).toBe(true);
        h.policy.update({ paused: false }, "alice");
        expect((await h.json("/admin/api/status")).body.paused).toBe(false);
    });

    it("calls the sweeper healthy when it ticked inside the window", async () => {
        const h = harness();
        h.setSweeper({ lastTickAt: Date.now() - 1_000 });

        const { body } = await h.json("/admin/api/status");

        expect(body.sweeper.healthy).toBe(true);
        expect(body.sweeper.running).toBe(true);
        expect(body.sweeper.sinceLastTickMs).toBeGreaterThanOrEqual(1_000);
        expect(body.sweeper.staleAfterMs).toBe(180_000);
        expect(body.sweeper.lastHeight).toBe("800123");
        expect(body.sweeper.sweptCount).toBe(3);
    });

    it("calls the sweeper unhealthy once the last tick is older than the stale window", async () => {
        const h = harness();
        h.setSweeper({ lastTickAt: Date.now() - 200_000 });

        const { body } = await h.json("/admin/api/status");

        expect(body.sweeper.healthy).toBe(false);
        expect(body.sweeper.sinceLastTickMs).toBeGreaterThan(body.sweeper.staleAfterMs);
    });

    it("calls the sweeper unhealthy when it has never ticked", async () => {
        const h = harness();
        h.setSweeper({ lastTickAt: null });

        const { body } = await h.json("/admin/api/status");

        expect(body.sweeper.healthy).toBe(false);
        expect(body.sweeper.lastTickAt).toBeNull();
        expect(body.sweeper.sinceLastTickMs).toBeNull();
    });

    it("calls the sweeper unhealthy when it is stopped or its last tick errored", async () => {
        const stopped = harness();
        stopped.setSweeper({ running: false });
        expect((await stopped.json("/admin/api/status")).body.sweeper.healthy).toBe(false);

        const errored = harness();
        errored.setSweeper({ lastError: "arkd unreachable" });
        const { body } = await errored.json("/admin/api/status");
        expect(body.sweeper.healthy).toBe(false);
        expect(body.sweeper.lastError).toBe("arkd unreachable");
    });

    it("floors the stale window at 30s so a tiny interval cannot look healthy forever", async () => {
        const h = harness();
        h.setSweeper({ intervalMs: 1_000, lastTickAt: Date.now() - 5_000 });

        const { body } = await h.json("/admin/api/status");

        expect(body.sweeper.staleAfterMs).toBe(30_000);
        expect(body.sweeper.healthy).toBe(true);
    });

    it("still reports exposure when the sweeper accessor throws", async () => {
        const h = harness({
            sweeper: () => {
                throw new Error("sweeper handle is gone");
            },
        });
        h.advances.insert(advance({ state: "locked", topup: 42n }));

        const { status, body } = await h.json("/admin/api/status");

        expect(status).toBe(200);
        expect(body.exposure.outstandingSats).toBe("42");
        expect(body.sweeper.healthy).toBe(false);
        expect(body.sweeper.lastError).toMatch(/sweeper handle is gone/);
    });
});

describe("GET /admin/api/policy", () => {
    it("returns the policy with every sats field as a decimal string", async () => {
        const h = harness();

        const { status, body } = await h.json("/admin/api/policy");

        expect(status).toBe(200);
        expect(body).toEqual({
            paused: true,
            maxOutstandingSats: "0",
            maxPerPaymentTopupSats: "0",
            maxConcurrentAdvances: 0,
            locktimeMarginBlocks: DEFAULT_POLICY.locktimeMarginBlocks,
            assetRules: [],
            quoteTtlSeconds: 60,
        });
    });
});

describe("PATCH /admin/api/policy", () => {
    it("applies the patch, returns the updated policy and audits it to the actor", async () => {
        const h = harness();

        const { status, body } = await h.send("/admin/api/policy", "PATCH", {
            actor: "alice@ui",
            paused: false,
            locktimeMarginBlocks: 45,
            maxOutstandingSats: INT64_MAX,
        });

        expect(status).toBe(200);
        expect(body.paused).toBe(false);
        expect(body.locktimeMarginBlocks).toBe(45);
        expect(body.maxOutstandingSats).toBe(INT64_MAX);
        expect(h.policy.get().maxOutstandingSats).toBe(9_223_372_036_854_775_807n);

        const rows = h.policy.history(10);
        expect(rows).toHaveLength(3);
        expect(rows.every((r) => r.actor === "alice@ui")).toBe(true);
    });

    it("keeps sats exact above 2^53 rather than routing them through a number", async () => {
        const h = harness();

        const { body } = await h.send("/admin/api/policy", "PATCH", {
            actor: "alice",
            maxOutstandingSats: "9007199254740993",
        });

        expect(body.maxOutstandingSats).toBe("9007199254740993");
        expect(h.policy.get().maxOutstandingSats).toBe(9_007_199_254_740_993n);
    });

    it("rejects a blank actor with 400 and changes nothing", async () => {
        const h = harness();

        const { status, body } = await h.send("/admin/api/policy", "PATCH", {
            actor: "   ",
            locktimeMarginBlocks: 7,
        });

        expect(status).toBe(400);
        expect(body.error).toMatch(/actor/i);
        expect(h.policy.get().locktimeMarginBlocks).toBe(DEFAULT_POLICY.locktimeMarginBlocks);
        expect(h.policy.history(10)).toHaveLength(0);
    });

    it("rejects a missing actor with 400", async () => {
        const h = harness();

        const { status } = await h.send("/admin/api/policy", "PATCH", { locktimeMarginBlocks: 45 });

        expect(status).toBe(400);
        expect(h.policy.history(10)).toHaveLength(0);
    });

    it("rejects a field outside the Policy contract with 400", async () => {
        const h = harness();

        const { status, body } = await h.send("/admin/api/policy", "PATCH", {
            actor: "mallory",
            quote_ttl_seconds: 0,
        });

        expect(status).toBe(400);
        expect(body.error).toBeTruthy();
        expect(h.policy.get()).toEqual(DEFAULT_POLICY);
    });

    it("rejects a malformed or negative sats value with 400", async () => {
        const h = harness();

        for (const maxOutstandingSats of ["-1", "1.5", "1e3", "", "abc"]) {
            const { status } = await h.send("/admin/api/policy", "PATCH", {
                actor: "alice",
                maxOutstandingSats,
            });
            expect(status, `maxOutstandingSats=${maxOutstandingSats}`).toBe(400);
        }
        expect(h.policy.history(10)).toHaveLength(0);
    });

    it("rejects a malformed body with 400 rather than throwing", async () => {
        const h = harness();

        const res = await h.app.request("/admin/api/policy", {
            method: "PATCH",
            headers: { "content-type": "application/json" },
            body: "{ not json",
        });

        expect(res.status).toBe(400);
    });
});

describe("GET /admin/api/policy/history", () => {
    it("returns audit rows newest first, capped by limit", async () => {
        const h = harness();
        h.policy.update({ locktimeMarginBlocks: 1 }, "alice");
        h.policy.update({ locktimeMarginBlocks: 2 }, "bob");
        h.policy.update({ locktimeMarginBlocks: 3 }, "carol");

        const { status, body } = await h.json("/admin/api/policy/history?limit=2");

        expect(status).toBe(200);
        expect(body.history).toHaveLength(2);
        expect(body.history[0]).toMatchObject({
            field: "locktimeMarginBlocks",
            newValue: "3",
            actor: "carol",
        });
        expect(body.history[1].newValue).toBe("2");
    });

    it("defaults the limit when none is given", async () => {
        const h = harness();
        h.policy.update({ locktimeMarginBlocks: 1 }, "alice");

        const { body } = await h.json("/admin/api/policy/history");

        expect(body.history).toHaveLength(1);
    });

    it("rejects a non-positive or malformed limit with 400", async () => {
        const h = harness();

        for (const limit of ["0", "-1", "abc", "1.5", "100000"]) {
            const { status } = await h.json(`/admin/api/policy/history?limit=${limit}`);
            expect(status, `limit=${limit}`).toBe(400);
        }
    });
});

describe("GET /admin/api/advances", () => {
    it("returns advances newest first with hex keys and decimal sats", async () => {
        const h = harness();
        h.advances.insert(advance({ id: "old", createdAt: 1_000, topup: 1n }));
        h.advances.insert(advance({ id: "new", createdAt: 3_000, topup: 2n }));
        h.advances.insert(advance({ id: "mid", createdAt: 2_000, topup: 3n }));

        const { status, body } = await h.json("/admin/api/advances");

        expect(status).toBe(200);
        expect(body.advances.map((a: { id: string }) => a.id)).toEqual(["new", "mid", "old"]);
        expect(body.advances[0]).toMatchObject({
            state: "locked",
            receiverKey: "11".repeat(32),
            senderKey: "22".repeat(32),
            operatorKey: "33".repeat(32),
            dust: "330",
            topup: "2",
            locktime: "800000",
            fare: { currency: "sats", units: "0" },
            createdAt: 3_000,
        });
    });

    it("keeps a topup above 2^53 exact", async () => {
        const h = harness();
        h.advances.insert(advance({ topup: 9_007_199_254_740_993n }));

        const { body } = await h.json("/admin/api/advances");

        expect(body.advances[0].topup).toBe("9007199254740993");
    });

    it("filters by state", async () => {
        const h = harness();
        h.advances.insert(advance({ id: "l", state: "locked" }));
        h.advances.insert(advance({ id: "q", state: "quoted" }));

        const { body } = await h.json("/admin/api/advances?state=quoted");

        expect(body.advances.map((a: { id: string }) => a.id)).toEqual(["q"]);
    });

    it("honours limit while keeping the newest", async () => {
        const h = harness();
        h.advances.insert(advance({ id: "old", createdAt: 1_000 }));
        h.advances.insert(advance({ id: "new", createdAt: 2_000 }));

        const { body } = await h.json("/admin/api/advances?limit=1");

        expect(body.advances.map((a: { id: string }) => a.id)).toEqual(["new"]);
    });

    it("rejects an unknown state or a malformed limit with 400", async () => {
        const h = harness();

        expect((await h.json("/admin/api/advances?state=bogus")).status).toBe(400);
        expect((await h.json("/admin/api/advances?limit=0")).status).toBe(400);
        expect((await h.json("/admin/api/advances?limit=abc")).status).toBe(400);
    });

    it("serialises optional fields when present and omits them when absent", async () => {
        const h = harness();
        h.advances.insert(
            advance({
                id: "full",
                createdAt: 2_000,
                assetId: { txid: key(0xab), groupIndex: 2 },
                outpoint: { txid: "ff".repeat(32), vout: 1 },
                spentTxid: "ee".repeat(32),
            }),
        );
        h.advances.insert(advance({ id: "bare", createdAt: 1_000 }));

        const { body } = await h.json("/admin/api/advances");
        const [full, bare] = body.advances;

        expect(full.assetId).toEqual({ txid: "ab".repeat(32), groupIndex: 2 });
        expect(full.outpoint).toEqual({ txid: "ff".repeat(32), vout: 1 });
        expect(full.spentTxid).toBe("ee".repeat(32));
        expect(bare.assetId).toBeUndefined();
        expect(bare.outpoint).toBeUndefined();
        expect(bare.spentTxid).toBeUndefined();
    });
});

describe("POST /admin/api/pause and /resume", () => {
    it("pauses and audits the change", async () => {
        const h = harness();
        h.policy.update({ paused: false }, "setup");

        const { status, body } = await h.send("/admin/api/pause", "POST", { actor: "alice" });

        expect(status).toBe(200);
        expect(body.paused).toBe(true);
        expect(h.policy.get().paused).toBe(true);
        expect(h.policy.history(10)[0]).toMatchObject({
            field: "paused",
            newValue: "true",
            actor: "alice",
        });
    });

    it("resumes and audits the change", async () => {
        const h = harness();

        const { status, body } = await h.send("/admin/api/resume", "POST", { actor: "bob" });

        expect(status).toBe(200);
        expect(body.paused).toBe(false);
        expect(h.policy.history(10)[0]).toMatchObject({
            field: "paused",
            newValue: "false",
            actor: "bob",
        });
    });

    it("rejects a blank or missing actor with 400 on both", async () => {
        const h = harness();

        expect((await h.send("/admin/api/pause", "POST", { actor: " " })).status).toBe(400);
        expect((await h.send("/admin/api/resume", "POST", {})).status).toBe(400);
        expect(h.policy.history(10)).toHaveLength(0);
    });

    it("is idempotent without writing an audit row for a no-op", async () => {
        const h = harness();

        await h.send("/admin/api/pause", "POST", { actor: "alice" });

        expect(h.policy.get().paused).toBe(true);
        expect(h.policy.history(10)).toHaveLength(0);
    });
});

describe("sweeper status contract", () => {
    it("tolerates a status missing its optional fields", async () => {
        const h = harness({
            sweeper: () => ({ running: true, lastTickAt: Date.now(), intervalMs: 60_000 }),
        });

        const { body } = await h.json("/admin/api/status");

        expect(body.sweeper.healthy).toBe(true);
        expect(body.sweeper.lastHeight).toBeNull();
        expect(body.sweeper.sweptCount).toBe(0);
        expect(body.sweeper.lastError).toBeNull();
    });

    it("serialises a chain height above 2^53 as a decimal string", async () => {
        const h = harness();
        h.setSweeper({ ...healthySweeper(), lastHeight: 9_007_199_254_740_993n });

        const { body } = await h.json("/admin/api/status");

        expect(body.sweeper.lastHeight).toBe("9007199254740993");
    });
});

/**
 * The db layer catches a new Policy field at compile time via
 * `satisfies Record<keyof Policy, string>`. The admin schema is hand-written
 * zod with no such link, so a new field silently becomes unsettable and
 * `.strict()` turns an attempt to set it into a 400. This is the check that
 * fails instead.
 */
describe("policy surface completeness", () => {
    it("exposes every Policy field as patchable", () => {
        expect([...PATCHABLE_POLICY_KEYS].sort()).toEqual(Object.keys(DEFAULT_POLICY).sort());
    });

    it("returns every Policy field on GET", async () => {
        const h = harness();
        const { body } = await h.json("/admin/api/policy");
        expect(Object.keys(body).sort()).toEqual(Object.keys(DEFAULT_POLICY).sort());
    });

    it("accepts a patch for the nested rule table", async () => {
        const h = harness();
        const res = await h.json("/admin/api/policy", {
            method: "PATCH",
            body: JSON.stringify({ actor: "ops", assetRules: [] }),
        });
        expect(res.status).toBe(200);
        expect(res.body.assetRules).toEqual([]);
    });
});
