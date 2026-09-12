import { afterEach, describe, expect, it, vi } from "vitest";
import { type ArkInfo, type Wallet } from "@arkade-os/sdk";
import {
    AdvanceRepository,
    openDatabase,
    PolicyRepository,
    ReservationRepository,
} from "@arkade-taxi/db";
import { bytesToHex } from "@arkade-taxi/protocol";
import { createOperatorRuntime } from "../src/arkade/operatorWallet.js";
import { createServiceLifecycle } from "../src/lifecycle.js";
import { createRoutes, type RouteDeps } from "../src/routes.js";
import { createQuote, FakeLockupBuilder, type QuoteDeps } from "../src/quotes.js";
import { arkInfo } from "./arkade/fixtures.js";
import {
    config,
    emulatorKey,
    fundingCoin,
    MemoryAdvances,
    NOW,
    policy,
    quoteBody,
    quoteInfrastructure,
    serverUnroll,
} from "./fixtures.js";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
    for (const dispose of cleanup.splice(0)) await dispose();
    vi.useRealTimers();
});

function gate() {
    let release!: () => void;
    const pending = new Promise<void>((resolve) => (release = resolve));
    return { pending, release };
}

function setup() {
    const db = openDatabase(":memory:");
    const advances = new AdvanceRepository(db);
    const reservations = new ReservationRepository(db);
    const terms = new PolicyRepository(db);
    terms.update(policy(), "test");
    const cfg = config({ addressHrp: "tark", reconcileIntervalMs: 1_000 });
    let now = NOW * 1_000;
    let info: ArkInfo = arkInfo({ checkpointTapscript: bytesToHex(serverUnroll.script) });
    let providerFails = false;
    let checkGate: Promise<void> | undefined;
    let walletGate: Promise<void> | undefined;
    let online = true;
    let height = 700000;
    let walletEntered = gate();
    let coins = [fundingCoin(), fundingCoin({ vout: 1, expiresAtHeight: 900001 })];
    const wallet = {
        getSpendableVtxos: async () => {
            walletEntered.release();
            await walletGate;
            return coins;
        },
        getContractManager: async () => ({
            getSyncState: () => ({ mode: online ? "online" : "degraded", lastSyncedAt: now }),
        }),
        getProviderConnectionState: () => ({ mode: online ? "online" : "degraded" }),
        onchainProvider: {
            getChainTip: async () => ({ height, time: NOW, hash: "aa".repeat(32) }),
        },
        dispose: async () => {},
    } as unknown as Wallet;
    const runtime = createOperatorRuntime(cfg, db, {
        now: () => now,
        providers: {
            arkProvider: {
                getInfo: async () => {
                    await checkGate;
                    if (providerFails) throw new Error("credentials=PRIVATE_PROVIDER_FAILURE");
                    return info;
                },
            },
            emulatorProvider: { getInfo: async () => ({ signerPubkey: bytesToHex(emulatorKey) }) },
        },
        walletFactory: async () => wallet,
        reservedOutpoints: () => reservations.listReservedOutpoints(),
    });
    const builder = new FakeLockupBuilder(cfg, serverUnroll);
    const observed: unknown[] = [];
    const deps: QuoteDeps = {
        ...quoteInfrastructure(new MemoryAdvances(), policy),
        config: cfg,
        advances,
        reservations,
        policy: terms,
        now: () => Math.floor(now / 1_000),
        nowMs: () => now,
        randomId: () => "quote-interleaving",
        runtime: {
            ...runtime,
            safety: () => {
                const value = runtime.safety();
                observed.push({
                    ageMs: now - value.checkedAt,
                    walletSynced: value.walletSynced,
                    providerIdentityOk: value.providerIdentityOk,
                    blockers: value.blockers,
                    chainHeight: value.chainHeight?.toString() ?? null,
                    chainTime: value.chainTime?.toString() ?? null,
                });
                return value;
            },
        },
        inventory: {
            getSpendableVtxos: () => wallet.getSpendableVtxos(),
            getLockedVtxoOutpoints: () => runtime.storage.intentRepository.getLockedVtxoOutpoints(),
        },
        getServerUnroll: runtime.getServerUnroll,
        lockupBuilder: builder,
        lockupSubmitter: builder,
    };
    const lifecycle = createServiceLifecycle({
        listen: async () => ({ stopAccepting() {}, finished: async () => {} }),
        verifyRuntime: () => runtime.assertAdmission(),
        reconcile: async () => {},
        firstRecoveryTick: async () => {},
        startStreams: async () => {},
        startBackground() {},
        stopBackground() {},
        stopRuntime: runtime.stop,
        abort() {},
        drain: async () => {},
        disposeProviders: () => runtime.dispose(),
        closeDatabase: () => db.close(),
        shutdownTimeoutMs: 50,
        forceTerminate() {},
    });
    cleanup.push(async () => {
        await runtime.dispose();
        db.close();
    });
    const router = (over: Partial<RouteDeps> = {}) =>
        createRoutes({
            ...deps,
            startup: lifecycle.status,
            reconciler: {
                status: () => ({ lastTickAt: Math.floor(now / 1_000), locking: 0, blockers: [] }),
            },
            sweeperStaleAfterSeconds: 3,
            sweeper: {
                status: () => ({
                    lastTickAt: Math.floor(now / 1_000),
                    lastTickHeight: 700000n,
                    lastTickMedianTime: BigInt(NOW),
                    recoverySubmittedTotal: 0,
                    failedTotal: 0,
                    lastError: null,
                    lastRecoveryError: null,
                    lockedCount: 0,
                    recoveringCount: 0,
                    lastSuccessfulObservationAt: Math.floor(now / 1_000),
                    lastSuccessfulRecoveryAt: null,
                    nearestDeadline: { height: null, time: null },
                    oldestUnsweptLocktime: { height: null, time: null },
                    blockers: [],
                    deadlines: [],
                }),
            },
            ...over,
        });
    return {
        deps,
        runtime,
        lifecycle,
        advances,
        reservations,
        builder,
        observed,
        router,
        setNow: (value: number) => (now = value),
        setInfo: (value: ArkInfo) => (info = value),
        failProvider: () => (providerFails = true),
        setOnline: (value: boolean) => (online = value),
        setHeight: (value: number) => (height = value),
        setCoins: (value: typeof coins) => (coins = value),
        pauseCheck: (value: Promise<void>) => (checkGate = value),
        pauseWallet: (value: Promise<void>) => {
            walletGate = value;
            walletEntered = gate();
            return walletEntered.pending;
        },
    };
}

describe("quote and runtime refresh interleaving", () => {
    it("revalidates an expired readiness cache before admitting a quote", async () => {
        const h = setup();
        await h.lifecycle.start();
        await h.lifecycle.refresh();
        const router = h.router();
        h.setNow(NOW * 1_000 + 1_000);
        const ready = await router.request("/ready");
        expect(ready.status).toBe(503);
        expect((await ready.json()).blockers).toEqual(["runtime_stale"]);

        const quote = await router.request("/v1/transfers", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(quoteBody()),
        });

        expect({ status: quote.status, body: await quote.json() }).toMatchObject({
            status: 200,
            body: { transferId: "quote-interleaving" },
        });
        expect(h.runtime.safety()).toMatchObject({ checkedAt: NOW * 1_000 + 1_000, blockers: [] });
        expect(h.reservations.listReservedOutpoints()).toHaveLength(1);
    });

    it.each([true, false])(
        "awaits a genuine pending check and admits only a verified result (healthy=%s)",
        async (healthy) => {
            const h = setup();
            await h.lifecycle.start();
            await h.lifecycle.refresh();
            const router = h.router();
            const walletRelease = gate();
            const entered = h.pauseWallet(walletRelease.pending);
            const refresh = h.runtime.refresh();
            await entered;
            expect((await router.request("/ready")).status).toBe(503);
            const quote = router.request("/v1/transfers", {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify(quoteBody()),
            });
            expect(h.advances.byState("quoted")).toEqual([]);
            expect(h.reservations.listReservedOutpoints()).toEqual([]);
            h.setOnline(healthy);
            walletRelease.release();
            await refresh;
            const response = await quote;
            expect({ status: response.status, body: await response.json() }).toMatchObject({
                status: healthy ? 200 : 503,
                body: healthy
                    ? { transferId: "quote-interleaving" }
                    : { code: "runtime_unsafe", error: "wallet_unsynced" },
            });
            expect(h.reservations.listReservedOutpoints()).toHaveLength(healthy ? 1 : 0);
        },
    );

    it.each(["provider", "identity", "tip", "sync", "reserve"])(
        "keeps HTTP readiness and quote admission closed after failed %s revalidation",
        async (failure) => {
            const h = setup();
            await h.lifecycle.start();
            await h.lifecycle.refresh();
            const router = h.router();
            h.setNow(NOW * 1_000 + 1_000);
            if (failure === "provider") h.failProvider();
            if (failure === "identity")
                h.setInfo(arkInfo({ signerPubkey: bytesToHex(emulatorKey) }));
            if (failure === "tip") h.setHeight(NaN);
            if (failure === "sync") h.setOnline(false);
            if (failure === "reserve") h.setCoins([]);

            const quote = await router.request("/v1/transfers", {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify(quoteBody()),
            });
            expect(quote.status).toBe(503);
            const body = await quote.json();
            expect(body).toMatchObject({ code: "runtime_unsafe" });
            expect(JSON.stringify(body)).not.toContain("PRIVATE_PROVIDER_FAILURE");
            expect((await router.request("/ready")).status).toBe(503);
            expect(h.advances.byState("quoted")).toEqual([]);
            expect(h.reservations.listReservedOutpoints()).toEqual([]);
            expect(h.builder.built).toEqual([]);
        },
    );

    it("does not admit an HTTP quote when new verification itself becomes stale", async () => {
        const h = setup();
        await h.lifecycle.start();
        await h.lifecycle.refresh();
        const router = h.router();
        h.setNow(NOW * 1_000 + 1_000);
        const release = gate();
        const entered = h.pauseWallet(release.pending);
        const quote = router.request("/v1/transfers", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(quoteBody()),
        });
        await entered;
        h.setNow(NOW * 1_000 + 2_000);
        release.release();
        const response = await quote;

        expect({ status: response.status, body: await response.json() }).toEqual({
            status: 503,
            body: { code: "runtime_unsafe", error: "runtime_stale" },
        });
        expect((await router.request("/ready")).status).toBe(503);
        expect(h.advances.byState("quoted")).toEqual([]);
        expect(h.reservations.listReservedOutpoints()).toEqual([]);
    });

    it.each(["startup", "reconciliation", "sweeper"])(
        "retains the %s admission guard inside a healthy runtime lease",
        async (blocked) => {
            const h = setup();
            await h.lifecycle.start();
            await h.lifecycle.refresh();
            const router = h.router(
                blocked === "startup"
                    ? {
                          startup: () => ({
                              complete: false,
                              phase: "streams",
                              blocker: "startup_streams_pending",
                          }),
                      }
                    : blocked === "reconciliation"
                      ? {
                            reconciler: {
                                status: () => ({
                                    lastTickAt: NOW,
                                    locking: 0,
                                    blockers: ["reconciliation_blocked"],
                                }),
                            },
                        }
                      : { sweeperStaleAfterSeconds: -1 },
            );

            const quote = await router.request("/v1/transfers", {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify(quoteBody()),
            });
            expect(quote.status).toBe(503);
            expect(await quote.json()).toMatchObject({ code: "not_ready" });
            expect(h.runtime.safety().blockers).toEqual([]);
            expect(h.advances.byState("quoted")).toEqual([]);
            expect(h.reservations.listReservedOutpoints()).toEqual([]);
            expect(h.builder.built).toEqual([]);
        },
    );

    it("persists a quote after real provider, wallet, chain and reserve validation", async () => {
        const h = setup();
        const quote = await createQuote(h.deps, quoteBody());
        expect(h.advances.get(quote.transferId)?.state).toBe("quoted");
        expect(h.reservations.listReservedOutpoints()).toEqual([
            { txid: "bb".repeat(32), vout: 0 },
        ]);
    });

    it.each([1, 2])(
        "keeps one verified admission through a periodic check at inventory read %s",
        async (read) => {
            const h = setup();
            await h.lifecycle.start();
            await h.lifecycle.refresh();
            const inventoryEntered = gate();
            const inventoryRelease = gate();
            const providerRelease = gate();
            const locks = h.deps.inventory.getLockedVtxoOutpoints;
            let reads = 0;
            h.deps.inventory.getLockedVtxoOutpoints = async () => {
                if (++reads === read) {
                    inventoryEntered.release();
                    await inventoryRelease.pending;
                }
                return locks();
            };
            const quote = createQuote(h.deps, quoteBody()).then(
                (value) => ({ value }),
                (error: unknown) => ({ error, observed: h.observed }),
            );
            await inventoryEntered.pending;
            h.pauseCheck(providerRelease.pending);
            const refresh = h.lifecycle.refresh();
            inventoryRelease.release();
            try {
                const result = await quote;
                expect(result).toMatchObject({ value: { transferId: "quote-interleaving" } });
                expect(h.advances.get("quote-interleaving")?.state).toBe("quoted");
                expect(h.reservations.listReservedOutpoints()).toHaveLength(1);
            } finally {
                providerRelease.release();
                await refresh;
            }
            expect(h.runtime.safety().inventory?.reservedSats).toBe(20000n);
        },
    );

    it("does not redate observations when wallet verification consumes the freshness window", async () => {
        const h = setup();
        const walletRelease = gate();
        const entered = h.pauseWallet(walletRelease.pending);
        const admission = h.runtime.assertAdmission();
        await entered;
        h.setNow(NOW * 1_000 + 1_000);
        walletRelease.release();
        await expect(admission).rejects.toMatchObject({
            code: "runtime_unsafe",
            message: "runtime_stale",
        });
        expect(h.runtime.safety()).toMatchObject({
            checkedAt: NOW * 1_000,
            walletSynced: true,
            providerIdentityOk: true,
            blockers: ["runtime_stale"],
        });
        expect(h.reservations.listReservedOutpoints()).toEqual([]);
    });

    it.each(["identity", "tip", "sync", "reserve"])(
        "rejects an unverified %s before quoting",
        async (failure) => {
            const h = setup();
            if (failure === "identity")
                h.setInfo(arkInfo({ signerPubkey: bytesToHex(emulatorKey) }));
            if (failure === "tip") h.setHeight(NaN);
            if (failure === "sync") h.setOnline(false);
            if (failure === "reserve") h.setCoins([]);

            await expect(createQuote(h.deps, quoteBody())).rejects.toMatchObject({
                code: "runtime_unsafe",
                status: 503,
            });
            expect(h.advances.byState("quoted")).toEqual([]);
            expect(h.reservations.listReservedOutpoints()).toEqual([]);
            expect(h.builder.built).toEqual([]);
            await h.runtime.refresh();
            expect(h.runtime.safety().blockers.length).toBeGreaterThan(0);
        },
    );

    it("rejects a lease whose verified observations expire during construction", async () => {
        const h = setup();
        const build = h.builder.buildUnsigned.bind(h.builder);
        h.builder.buildUnsigned = async (request) => {
            const funding = await build(request);
            h.setNow(NOW * 1_000 + 1_000);
            return funding;
        };

        await expect(createQuote(h.deps, quoteBody())).rejects.toMatchObject({
            code: "runtime_unsafe",
            status: 503,
        });
        expect(h.advances.byState("quoted")).toEqual([]);
        expect(h.reservations.listReservedOutpoints()).toEqual([]);
        await h.runtime.refresh();
        expect(h.runtime.safety().blockers).toEqual([]);
    });

    it("serializes concurrent quotes without double reserving the verified inventory", async () => {
        const h = setup();
        const results = await Promise.allSettled([
            createQuote(h.deps, quoteBody()),
            createQuote(h.deps, quoteBody()),
        ]);
        expect(results.map((result) => result.status)).toEqual(["fulfilled", "rejected"]);
        expect(results[1]).toMatchObject({ reason: { code: "operator_inventory_insufficient" } });
        expect(h.advances.byState("quoted")).toHaveLength(1);
        expect(h.reservations.listReservedOutpoints()).toHaveLength(1);
    });

    it("drains an active lease on stop without persisting its quote", async () => {
        const h = setup();
        const inventoryEntered = gate();
        const inventoryRelease = gate();
        const locks = h.deps.inventory.getLockedVtxoOutpoints;
        h.deps.inventory.getLockedVtxoOutpoints = async () => {
            inventoryEntered.release();
            await inventoryRelease.pending;
            return locks();
        };
        const quote = createQuote(h.deps, quoteBody());
        await inventoryEntered.pending;
        const disposed = h.runtime.dispose();
        inventoryRelease.release();

        await expect(quote).rejects.toMatchObject({ code: "runtime_unsafe", status: 503 });
        await disposed;
        expect(h.runtime.wallet).toBeUndefined();
        expect(h.advances.byState("quoted")).toEqual([]);
        expect(h.reservations.listReservedOutpoints()).toEqual([]);
    });

    it("releases an expired hung quote lease without authorizing its late continuation", async () => {
        vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
        const h = setup();
        await h.lifecycle.start();
        await h.lifecycle.refresh();
        const inventoryEntered = gate();
        const inventoryRelease = gate();
        const locks = h.deps.inventory.getLockedVtxoOutpoints;
        let reads = 0;
        h.deps.inventory.getLockedVtxoOutpoints = async () => {
            if (++reads === 2) {
                inventoryEntered.release();
                await inventoryRelease.pending;
            }
            return locks();
        };
        const quote = createQuote(h.deps, quoteBody()).catch((error: unknown) => error);
        await inventoryEntered.pending;
        const refresh = h.lifecycle.refresh();
        h.setNow(NOW * 1_000 + 1_000);
        try {
            await vi.advanceTimersByTimeAsync(1_000);
            expect(h.runtime.safety()).toMatchObject({
                checkedAt: NOW * 1_000 + 1_000,
                blockers: [],
            });
        } finally {
            inventoryRelease.release();
            await refresh;
        }
        expect(await quote).toMatchObject({ code: "runtime_unsafe", status: 503 });
        expect(h.advances.byState("quoted")).toEqual([]);
        expect(h.reservations.listReservedOutpoints()).toEqual([]);
    });

    it("does not let later admissions overtake a waiting periodic refresh", async () => {
        const h = setup();
        const firstEntered = gate();
        const firstRelease = gate();
        const secondEntered = gate();
        const secondRelease = gate();
        const first = h.runtime.withAdmission(async () => {
            firstEntered.release();
            await firstRelease.pending;
        });
        await firstEntered.pending;
        const refresh = h.runtime.refresh();
        const second = h.runtime.withAdmission(async () => {
            secondEntered.release();
            await secondRelease.pending;
        });
        firstRelease.release();
        try {
            expect(
                await Promise.race([
                    refresh.then(() => "refresh"),
                    secondEntered.pending.then(() => "second admission"),
                ]),
            ).toBe("refresh");
        } finally {
            secondRelease.release();
            await Promise.all([first, refresh, second]);
        }
    });

    it("refreshes at the active deadline ahead of an already queued admission backlog", async () => {
        vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
        const h = setup();
        const firstEntered = gate();
        const firstRelease = gate();
        const queuedRelease = gate();
        const events: string[] = [];
        const first = h.runtime
            .withAdmission(async (assertCurrent) => {
                firstEntered.release();
                await firstRelease.pending;
                assertCurrent();
            })
            .catch((error: unknown) => error);
        await firstEntered.pending;
        const queued = ["second", "third"].map((name) =>
            h.runtime.withAdmission(async (assertCurrent) => {
                events.push(name);
                await queuedRelease.pending;
                assertCurrent();
            }),
        );
        const refresh = h.runtime.refresh().then((state) => {
            events.push("refresh");
            return state;
        });
        h.setNow(NOW * 1_000 + 1_000);
        try {
            await vi.advanceTimersByTimeAsync(1_000);
            expect([...events]).toEqual(["refresh", "second"]);
            expect(await refresh).toMatchObject({
                checkedAt: NOW * 1_000 + 1_000,
                blockers: [],
            });
        } finally {
            firstRelease.release();
            queuedRelease.release();
            await Promise.all([first, ...queued, refresh]);
        }
        expect(events).toEqual(["refresh", "second", "third"]);
        expect(await first).toMatchObject({ code: "runtime_unsafe", message: "runtime_stale" });
        expect(vi.getTimerCount()).toBe(0);
    });

    it("coalesces refresh ahead of queued work and rejects failed provider verification", async () => {
        vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
        const h = setup();
        const firstEntered = gate();
        const firstRelease = gate();
        const work = vi.fn(async () => {});
        const first = h.runtime.withAdmission(async (assertCurrent) => {
            firstEntered.release();
            await firstRelease.pending;
            assertCurrent();
        });
        await firstEntered.pending;
        const queued = [1, 2].map(() =>
            h.runtime.withAdmission(work).catch((error: unknown) => error),
        );
        const refresh = h.runtime.refresh();
        expect(h.runtime.refresh()).toBe(refresh);
        h.failProvider();
        firstRelease.release();

        await first;
        expect((await refresh).blockers).toContain("server_unavailable");
        for (const result of await Promise.all(queued)) {
            expect(result).toMatchObject({ code: "runtime_unsafe", status: 503 });
        }
        expect(work).not.toHaveBeenCalled();
        expect(h.reservations.listReservedOutpoints()).toEqual([]);
        expect(vi.getTimerCount()).toBe(0);
    });

    it("drains queued admissions and a waiting refresh on stop without invoking queued work", async () => {
        vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
        const h = setup();
        const firstEntered = gate();
        const firstRelease = gate();
        const work = vi.fn(async () => {});
        const first = h.runtime
            .withAdmission(async (assertCurrent) => {
                firstEntered.release();
                await firstRelease.pending;
                assertCurrent();
            })
            .catch((error: unknown) => error);
        await firstEntered.pending;
        const queued = [1, 2].map(() =>
            h.runtime.withAdmission(work).catch((error: unknown) => error),
        );
        const refresh = h.runtime.refresh();
        const disposed = h.runtime.dispose();
        firstRelease.release();

        await disposed;
        expect((await refresh).blockers).toContain("runtime_stopped");
        for (const result of await Promise.all([first, ...queued])) {
            expect(result).toMatchObject({ code: "runtime_unsafe", message: "runtime_stopped" });
        }
        expect(work).not.toHaveBeenCalled();
        expect(h.runtime.wallet).toBeUndefined();
        expect(h.reservations.listReservedOutpoints()).toEqual([]);
        expect(vi.getTimerCount()).toBe(0);
    });
});
