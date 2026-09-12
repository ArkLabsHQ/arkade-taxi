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
    it("sums every active exposure and keeps oldest locktimes in separate domains", async () => {
        const h = harness();
        h.advances.insert(advance({ state: "locked", topup: 9_007_199_254_740_993n }));
        h.advances.insert(advance({ state: "locking", topup: 10n, locktime: 799_000n }));
        h.advances.insert(
            advance({
                state: "recovering",
                topup: 20n,
                locktime: 1_700_000_000n,
                batchExpiry: { kind: "time", value: 1_700_100_000n },
                recoveryLocktime: { kind: "time", value: 1_700_000_000n },
            }),
        );
        h.advances.insert(advance({ state: "quoted", topup: 5_000n }));
        h.advances.insert(advance({ state: "purchased", topup: 6_000n }));

        const { status, body } = await h.json("/admin/api/status");

        expect(status).toBe(200);
        expect(body.exposure).toEqual({
            outstandingSats: "9007199254741023",
            activeCount: 3,
            oldestUnsweptLocktime: { height: "799000", time: "1700000000" },
        });
    });

    it("reports a null oldest locktime and zero exposure when nothing is locked", async () => {
        const h = harness();
        h.advances.insert(advance({ state: "quoted" }));

        const { body } = await h.json("/admin/api/status");

        expect(body.exposure).toEqual({
            outstandingSats: "0",
            activeCount: 0,
            oldestUnsweptLocktime: { height: null, time: null },
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
            recovering: 0,
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
        expect(body.sweeper.recoverySubmittedTotal).toBe(3);
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

    it("redacts sensitive sweeper failures from the admin response", async () => {
        const h = harness();
        h.setSweeper({ lastError: `private key=${"11".repeat(32)}` });

        const { body } = await h.json("/admin/api/status");

        expect(body.sweeper.lastError).toContain("[redacted]");
        expect(JSON.stringify(body)).not.toContain("11".repeat(32));
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
            locktimeMarginSeconds: DEFAULT_POLICY.locktimeMarginSeconds,
            assetRules: [],
            quoteTtlSeconds: 60,
        });
    });
});

describe("PATCH /admin/api/policy", () => {
    it("applies the patch, returns the updated policy and audits it to the actor", async () => {
        const h = harness();

        const { status, body } = await h.send(
            "/admin/api/policy",
            "PATCH",
            {
                paused: false,
                locktimeMarginBlocks: 73,
                maxOutstandingSats: INT64_MAX,
            },
            "alice@ui",
        );

        expect(status).toBe(200);
        expect(body.paused).toBe(false);
        expect(body.locktimeMarginBlocks).toBe(73);
        expect(body.maxOutstandingSats).toBe(INT64_MAX);
        expect(h.policy.get().maxOutstandingSats).toBe(9_223_372_036_854_775_807n);

        const rows = h.policy.history(10);
        expect(rows).toHaveLength(3);
        expect(rows.every((r) => r.actor === "alice@ui")).toBe(true);
    });

    it("keeps sats exact above 2^53 rather than routing them through a number", async () => {
        const h = harness();

        const { body } = await h.send(
            "/admin/api/policy",
            "PATCH",
            { maxOutstandingSats: "9007199254740993" },
            "alice",
        );

        expect(body.maxOutstandingSats).toBe("9007199254740993");
        expect(h.policy.get().maxOutstandingSats).toBe(9_007_199_254_740_993n);
    });

    it.each([
        ["locktimeMarginBlocks", 72],
        ["locktimeMarginBlocks", 71],
        ["locktimeMarginSeconds", 43_200],
        ["locktimeMarginSeconds", 43_199],
    ] as const)("rejects %s=%s beneath the configured recovery budget", async (field, value) => {
        const h = harness();
        const before = h.policy.get();
        const { status, body } = await h.send(
            "/admin/api/policy",
            "PATCH",
            { [field]: value },
            "unsafe-admin",
        );
        expect(status).toBe(400);
        expect(body.error).toMatch(/recovery execution budget/);
        expect(h.policy.get()).toEqual(before);
        expect(h.policy.history(10)).toEqual([]);
    });

    it("rejects a blank proxy actor with 400 and changes nothing", async () => {
        const h = harness();

        const { status, body } = await h.send(
            "/admin/api/policy",
            "PATCH",
            { locktimeMarginBlocks: 7 },
            "   ",
        );

        expect(status).toBe(400);
        expect(body.error).toMatch(/operator identity/i);
        expect(h.policy.get().locktimeMarginBlocks).toBe(DEFAULT_POLICY.locktimeMarginBlocks);
        expect(h.policy.history(10)).toHaveLength(0);
    });

    it("rejects a missing proxy actor with 400", async () => {
        const h = harness();

        const { status } = await h.json("/admin/api/policy", {
            method: "PATCH",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ locktimeMarginBlocks: 45 }),
        });

        expect(status).toBe(400);
        expect(h.policy.history(10)).toHaveLength(0);
    });

    it("rejects body-selected actors, oversized actors, and simple-form mutations", async () => {
        const h = harness();
        const before = h.policy.get();

        expect(
            (
                await h.send(
                    "/admin/api/policy",
                    "PATCH",
                    { actor: "body-attacker", quoteTtlSeconds: 30 },
                    "proxy-user",
                )
            ).status,
        ).toBe(400);
        expect(
            (await h.send("/admin/api/policy", "PATCH", { quoteTtlSeconds: 30 }, "x".repeat(129)))
                .status,
        ).toBe(400);
        expect(
            (
                await h.json("/admin/api/policy", {
                    method: "PATCH",
                    headers: {
                        "content-type": "application/x-www-form-urlencoded",
                        "x-taxi-operator": "proxy-user",
                    },
                    body: "quoteTtlSeconds=30",
                })
            ).status,
        ).toBe(400);
        expect(h.policy.get()).toEqual(before);
        expect(h.policy.history(10)).toEqual([]);
    });

    it("rejects a field outside the Policy contract with 400", async () => {
        const h = harness();

        const { status, body } = await h.send(
            "/admin/api/policy",
            "PATCH",
            { quote_ttl_seconds: 0 },
            "mallory",
        );

        expect(status).toBe(400);
        expect(body.error).toBeTruthy();
        expect(h.policy.get()).toEqual(DEFAULT_POLICY);
    });

    it("rejects a malformed or negative sats value with 400", async () => {
        const h = harness();

        for (const maxOutstandingSats of ["-1", "1.5", "1e3", "", "abc"]) {
            const { status } = await h.send(
                "/admin/api/policy",
                "PATCH",
                { maxOutstandingSats },
                "alice",
            );
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
    it("orders active safety work before recent inactive rows", async () => {
        const h = harness();
        h.advances.insert(advance({ id: "old", state: "quoted", createdAt: 1_000, topup: 1n }));
        h.advances.insert(advance({ id: "new", state: "quoted", createdAt: 3_000, topup: 2n }));
        h.advances.insert(advance({ id: "active", createdAt: 2_000, topup: 3n }));

        const { status, body } = await h.json("/admin/api/advances");

        expect(status).toBe(200);
        expect(body.advances.map((a: { id: string }) => a.id)).toEqual(["active", "new", "old"]);
        expect(body.advances[0]).toMatchObject({
            state: "locked",
            receiverKey: "11".repeat(32),
            senderKey: "22".repeat(32),
            operatorKey: "33".repeat(32),
            dust: "330",
            topup: "3",
            locktime: "800000",
            fare: { currency: "sats", units: "0" },
            createdAt: 2_000,
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

    it("honours limit while retaining active safety work", async () => {
        const h = harness();
        h.advances.insert(advance({ id: "old", state: "locked", createdAt: 1_000 }));
        h.advances.insert(advance({ id: "new", state: "quoted", createdAt: 2_000 }));

        const { body } = await h.json("/admin/api/advances?limit=1");

        expect(body.advances.map((a: { id: string }) => a.id)).toEqual(["old"]);
    });

    it("never hides an urgent older recovering row behind the default 200 recent rows", async () => {
        const h = harness();
        for (let index = 0; index < 201; index++)
            h.advances.insert(
                advance({ id: `recent-${index}`, state: "quoted", createdAt: 10_000 + index }),
            );
        h.advances.insert(
            advance({
                id: "urgent",
                state: "recovering",
                createdAt: 1,
                batchExpiry: { kind: "height", value: 800_124n },
                recoveryLocktime: { kind: "height", value: 800_000n },
            }),
        );

        const { body } = await h.json("/admin/api/advances");

        expect(body.advances).toHaveLength(200);
        expect(body.advances[0].id).toBe("urgent");
    });

    it.each([
        ["time", "height"],
        ["height", "time"],
    ] as const)(
        "keeps one expired %s exposure ahead of more than 200 eligible %s exposures",
        async (urgentKind, benignKind) => {
            const urgentId = `urgent-${urgentKind}`;
            const h = harness();
            for (let index = 0; index < 201; index++) {
                const id = `benign-${benignKind}-${index}`;
                h.advances.insert(
                    advance({
                        id,
                        state: "locked",
                        locktime: benignKind === "height" ? 800_000n : 1_700_000_000n,
                        recoveryLocktime: {
                            kind: benignKind,
                            value: benignKind === "height" ? 800_000n : 1_700_000_000n,
                        },
                        batchExpiry: {
                            kind: benignKind,
                            value: benignKind === "height" ? 900_000n : 1_800_000_000n,
                        },
                    }),
                );
            }
            const urgentLocktime = urgentKind === "height" ? 799_000n : 1_699_000_000n;
            h.advances.insert(
                advance({
                    id: urgentId,
                    state: "recovering",
                    locktime: urgentLocktime,
                    recoveryLocktime: { kind: urgentKind, value: urgentLocktime },
                    batchExpiry: { kind: urgentKind, value: urgentLocktime + 1n },
                }),
            );
            h.setSweeper({
                deadlines: [
                    {
                        advanceId: urgentId,
                        kind: urgentKind,
                        locktime: urgentLocktime,
                        batchExpiry: urgentLocktime + 1n,
                        remaining: 0n,
                        severity: "expired",
                        code: "covenant_unspent_at_expiry",
                    },
                ],
            } as any);

            const { body } = await h.json("/admin/api/advances");

            expect(body.advances).toHaveLength(200);
            expect(body.advances[0].id).toBe(urgentId);
        },
    );

    it("orders active rows by domain then same-domain expiry, locktime, and id", async () => {
        const h = harness();
        h.advances.insert(
            advance({
                id: "time-small-scalar",
                batchExpiry: { kind: "time", value: 1_700_100_000n },
                locktime: 1_700_000_000n,
                recoveryLocktime: { kind: "time", value: 1_700_000_000n },
            }),
        );
        h.advances.insert(
            advance({
                id: "height-b",
                batchExpiry: { kind: "height", value: 900n },
                locktime: 5n,
                recoveryLocktime: { kind: "height", value: 5n },
            }),
        );
        h.advances.insert(
            advance({
                id: "height-a",
                batchExpiry: { kind: "height", value: 900n },
                locktime: 5n,
                recoveryLocktime: { kind: "height", value: 5n },
            }),
        );
        h.advances.insert(
            advance({
                id: "height-first",
                batchExpiry: { kind: "height", value: 899n },
                locktime: 800n,
                recoveryLocktime: { kind: "height", value: 800n },
            }),
        );

        const { body } = await h.json("/admin/api/advances");

        expect(body.advances.map((row: { id: string }) => row.id)).toEqual([
            "height-first",
            "height-a",
            "height-b",
            "time-small-scalar",
        ]);
    });

    it("pages more than 200 urgent rows without hiding or duplicating the remainder", async () => {
        const h = harness();
        const deadlines = [];
        for (let index = 0; index < 201; index++) {
            const id = `urgent-${String(index).padStart(3, "0")}`;
            h.advances.insert(
                advance({
                    id,
                    state: "recovering",
                    locktime: 700_000n + BigInt(index),
                    recoveryLocktime: { kind: "height", value: 700_000n + BigInt(index) },
                    batchExpiry: { kind: "height", value: 800_000n + BigInt(index) },
                }),
            );
            deadlines.push({
                advanceId: id,
                kind: "height" as const,
                locktime: 700_000n + BigInt(index),
                batchExpiry: 800_000n + BigInt(index),
                remaining: 0n,
                severity: index === 200 ? ("critical" as const) : ("expired" as const),
                code: index === 200 ? "recovery_deadline_critical" : "covenant_unspent_at_expiry",
            });
        }
        h.setSweeper({ deadlines } as any);

        const first = await h.json("/admin/api/advances?state=recovering&limit=200");
        const second = await h.json(
            `/admin/api/advances?state=recovering&limit=200&offset=${first.body.nextOffset}&snapshot=${first.body.snapshotToken}`,
        );
        const firstIds = first.body.advances.map((row: { id: string }) => row.id);
        const secondIds = second.body.advances.map((row: { id: string }) => row.id);

        expect(first.body).toMatchObject({
            offset: 0,
            limit: 200,
            nextOffset: 200,
            hasMore: true,
            hiddenUrgentCount: 1,
            paginationMode: "current_snapshot",
        });
        expect(first.body.snapshotToken).toMatch(/^[a-f0-9]{64}$/);
        expect(second.body).toMatchObject({
            offset: 200,
            limit: 200,
            nextOffset: null,
            hasMore: false,
            hiddenUrgentCount: 0,
            paginationMode: "current_snapshot",
            snapshotToken: first.body.snapshotToken,
        });
        expect(firstIds).toHaveLength(200);
        expect(secondIds).toHaveLength(1);
        expect(new Set([...firstIds, ...secondIds]).size).toBe(201);
    });

    it.each(["-1", "1.5", "abc", "1000001", "9007199254740992"])(
        "rejects malformed or overflowing advance offset %s",
        async (offset) => {
            expect((await harness().json(`/admin/api/advances?offset=${offset}`)).status).toBe(400);
        },
    );

    it("rejects a stale page token when urgency changes and makes the urgent row visible", async () => {
        const h = harness();
        h.advances.insert(advance({ id: "first" }));
        h.advances.insert(advance({ id: "second" }));
        h.setSweeper({
            deadlines: [
                {
                    advanceId: "first",
                    kind: "height",
                    locktime: 800_000n,
                    batchExpiry: 900_000n,
                    remaining: 0n,
                    severity: "expired",
                    code: "covenant_unspent_at_expiry",
                },
            ],
        } as any);
        const first = await h.json("/admin/api/advances?limit=1");
        h.setSweeper({
            deadlines: [
                {
                    advanceId: "second",
                    kind: "height",
                    locktime: 800_000n,
                    batchExpiry: 900_000n,
                    remaining: 0n,
                    severity: "expired",
                    code: "covenant_unspent_at_expiry",
                },
            ],
        } as any);
        const changed = await h.json(
            `/admin/api/advances?limit=1&offset=1&snapshot=${first.body.snapshotToken}`,
        );
        const refreshed = await h.json("/admin/api/advances?limit=1");

        expect(changed.status).toBe(409);
        expect(changed.body).toMatchObject({ code: "snapshot_changed" });
        expect(changed.body.advances).toBeUndefined();
        expect(refreshed.body.advances.map((row: { id: string }) => row.id)).toEqual(["second"]);
        expect(refreshed.body.snapshotToken).not.toBe(first.body.snapshotToken);
    });

    it("returns deterministic tokens scoped to the selected filter", async () => {
        const h = harness();
        h.advances.insert(advance({ id: "only" }));

        const all = await h.json("/admin/api/advances?limit=1");
        const repeated = await h.json("/admin/api/advances?limit=1");
        const locked = await h.json("/admin/api/advances?state=locked&limit=1");

        expect(repeated.body.snapshotToken).toBe(all.body.snapshotToken);
        expect(locked.body.snapshotToken).toMatch(/^[a-f0-9]{64}$/);
        expect(locked.body.snapshotToken).not.toBe(all.body.snapshotToken);
    });

    it.each([
        "/admin/api/advances?offset=1",
        "/admin/api/advances?offset=1&snapshot=short",
        `/admin/api/advances?snapshot=${"a".repeat(65)}`,
        "/admin/api/advances?snapshot=not_hex___________________________________________",
    ])("rejects a missing or malformed snapshot token: %s", async (path) => {
        expect((await harness().json(path)).status).toBe(400);
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
        const full = body.advances.find((row: { id: string }) => row.id === "full");
        const bare = body.advances.find((row: { id: string }) => row.id === "bare");

        expect(full.assetId).toEqual({ txid: "ab".repeat(32), groupIndex: 2 });
        expect(full.outpoint).toEqual({ txid: "ff".repeat(32), vout: 1 });
        expect(full.spentTxid).toBe("ee".repeat(32));
        expect(bare.assetId).toBeUndefined();
        expect(bare.outpoint).toBeUndefined();
        expect(bare.spentTxid).toBeUndefined();
    });

    it("exposes durable phases and deadlines without signed transaction artifacts", async () => {
        const h = harness({ now: () => 2_000 });
        h.advances.insert(
            advance({
                id: "active",
                state: "recovering",
                updatedAt: 1_900,
                batchExpiry: { kind: "time", value: 9_007_199_254_740_993n },
                recoveryLocktime: { kind: "time", value: 9_007_199_254_700_000n },
                locktime: 9_007_199_254_700_000n,
                submissionPhase: "finalized",
                recoveryPhase: "prepared",
                submissionAttempts: 2,
                recoveryAttempts: 3,
                recoveryExpectedTxid: "aa".repeat(32),
                arkTxid: "bb".repeat(32),
                preparedArkTx: "PRIVATE_PREPARED_TX",
                signedLockupEnvelope: "PRIVATE_SIGNED_PSBT",
                recoveryPreparedArkTx: "PRIVATE_RECOVERY_TX",
            }),
        );

        const { body } = await h.json("/admin/api/advances");
        expect(body.advances[0]).toMatchObject({
            ageSeconds: 100,
            batchExpiry: { kind: "time", value: "9007199254740993" },
            recoveryLocktime: { kind: "time", value: "9007199254700000" },
            submissionPhase: "finalized",
            recoveryPhase: "prepared",
            submissionAttempts: 2,
            recoveryAttempts: 3,
            arkTxid: "bb".repeat(32),
        });
        expect(JSON.stringify(body)).not.toMatch(/PRIVATE_/);
        expect(JSON.stringify(body)).not.toContain("recoveryExpectedTxid");
    });
});

describe("POST /admin/api/pause and /resume", () => {
    it("pauses and audits the change", async () => {
        const h = harness();
        h.policy.update({ paused: false }, "setup");

        const { status, body } = await h.send("/admin/api/policy/pause", "POST", {}, "alice");

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

        const { status, body } = await h.send("/admin/api/policy/resume", "POST", {}, "bob");

        expect(status).toBe(200);
        expect(body.paused).toBe(false);
        expect(h.policy.history(10)[0]).toMatchObject({
            field: "paused",
            newValue: "false",
            actor: "bob",
        });
    });

    it("rejects a blank or missing proxy actor with 400 on both", async () => {
        const h = harness();

        expect((await h.send("/admin/api/policy/pause", "POST", {}, " ")).status).toBe(400);
        expect(
            (
                await h.json("/admin/api/policy/resume", {
                    method: "POST",
                    headers: { "content-type": "application/json" },
                    body: "{}",
                })
            ).status,
        ).toBe(400);
        expect(h.policy.history(10)).toHaveLength(0);
    });

    it("is idempotent without writing an audit row for a no-op", async () => {
        const h = harness();

        await h.send("/admin/api/policy/pause", "POST", {}, "alice");

        expect(h.policy.get().paused).toBe(true);
        expect(h.policy.history(10)).toHaveLength(0);
    });
});

describe("operator actions", () => {
    it("keeps pause and rescan remediation available while readiness is blocked", async () => {
        let rescans = 0;
        const h = harness({
            rescan: async () => void rescans++,
            operationalSnapshot: () =>
                ({
                    ready: false,
                    body: { status: "degraded", blockers: ["provider_unavailable"] },
                }) as any,
        });
        h.policy.update({ paused: false }, "setup");

        expect((await h.send("/admin/api/policy/pause", "POST", {}, "alice")).status).toBe(200);
        expect((await h.send("/admin/api/rescan", "POST", {}, "alice")).status).toBe(202);
        expect(rescans).toBe(1);
    });

    it("shares concurrent rescan prompts and audits each proxy actor", async () => {
        let calls = 0;
        let release!: () => void;
        const gate = new Promise<void>((resolve) => {
            release = resolve;
        });
        const h = harness({
            rescan: async () => {
                calls++;
                await gate;
            },
        });

        const first = h.send("/admin/api/rescan", "POST", {}, "alice");
        const second = h.send("/admin/api/rescan", "POST", {}, "bob");
        await new Promise((resolve) => setTimeout(resolve, 0));
        expect(calls).toBe(1);
        release();
        expect((await first).status).toBe(202);
        expect((await second).status).toBe(202);
        expect(
            h.policy
                .history(10)
                .map((row) => row.actor)
                .sort(),
        ).toEqual(["alice", "bob"]);
    });

    it("expedites a resumable submission and returns no persisted transaction artifacts", async () => {
        const h = harness();
        h.advances.insert(
            advance({
                id: "retry-me",
                state: "locking",
                submissionPhase: "prepared",
                preparedArkTx: "PRIVATE_PREPARED_TX",
                preparedCheckpoints: ["PRIVATE_CHECKPOINT"],
                submissionNextAttemptAt: 500,
            }),
        );

        const response = await h.send(
            "/admin/api/advances/retry-me/retry-submission",
            "POST",
            {},
            "alice",
        );

        expect(response.status).toBe(202);
        expect(response.body).toEqual({
            accepted: true,
            action: "retry-submission",
            advanceId: "retry-me",
        });
        expect(JSON.stringify(response.body)).not.toMatch(/PRIVATE_/);
        expect(h.advances.get("retry-me")?.submissionNextAttemptAt).toBe(100);
        expect(h.policy.history(10)[0]).toMatchObject({ actor: "alice" });
    });

    it("returns stable 404 and 409 retry outcomes without prompting", async () => {
        let calls = 0;
        const h = harness({ rescan: async () => void calls++ });
        h.advances.insert(advance({ id: "done", state: "recovered" }));

        expect(
            (await h.send("/admin/api/advances/missing/retry-submission", "POST", {})).status,
        ).toBe(404);
        const conflict = await h.send("/admin/api/advances/done/retry-recovery", "POST", {});
        expect(conflict.status).toBe(409);
        expect(conflict.body.code).toBe("retry_incompatible");
        expect(calls).toBe(0);
        expect(h.policy.history(10)).toEqual([]);
    });

    it("rescans before resume and leaves policy and audit unchanged while blocked", async () => {
        const order: string[] = [];
        const h = harness({
            rescan: async () => void order.push("rescan"),
            operationalSnapshot: () => {
                order.push("snapshot");
                return {
                    ready: false,
                    body: { status: "degraded", blockers: ["watcher_blocked"] },
                } as any;
            },
        });

        const response = await h.send("/admin/api/policy/resume", "POST", {}, "alice");

        expect(response.status).toBe(409);
        expect(response.body).toEqual({
            code: "resume_blocked",
            error: "watcher_blocked",
            blockers: ["watcher_blocked"],
        });
        expect(order).toEqual(["rescan", "snapshot"]);
        expect(h.policy.get().paused).toBe(true);
        expect(h.policy.history(10)).toEqual([]);
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
        expect(body.sweeper.recoverySubmittedTotal).toBe(0);
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
        const res = await h.send("/admin/api/policy", "PATCH", { assetRules: [] }, "ops");
        expect(res.status).toBe(200);
        expect(res.body.assetRules).toEqual([]);
    });
});
