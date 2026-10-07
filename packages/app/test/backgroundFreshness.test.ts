import { afterEach, describe, expect, it, vi } from "vitest";
import { ArkAddress, type ExtendedVirtualCoin, type Wallet } from "@arkade-os/sdk";
import { bytesToHex } from "@arkade-taxi/protocol";
import { createOperatorRuntime } from "../src/arkade/operatorWallet.js";
import { createServiceLifecycle } from "../src/lifecycle.js";
import type { LockupReconciler } from "../src/reconciler.js";
import { createRoutes } from "../src/routes.js";
import type { ServerDeps } from "../src/server.js";
import type { Sweeper } from "../src/sweeper.js";
import { arkInfo } from "./arkade/fixtures.js";
import { config, fundingCoin, NOW, policy, providerEmulatorKey, serverUnroll } from "./fixtures.js";

interface Harness {
    config: ReturnType<typeof config>;
    scans: number;
    scanGate?: Promise<void>;
    coins: ExtendedVirtualCoin[];
    wallet: Wallet;
    providers: NonNullable<Parameters<typeof createOperatorRuntime>[2]>["providers"];
    started(): void;
    runtime?: ReturnType<typeof createOperatorRuntime>;
    deps?: ServerDeps;
    lifecycle?: ReturnType<typeof createServiceLifecycle>;
}

const current = vi.hoisted(() => ({ value: undefined as Harness | undefined }));
vi.mock("../src/config.js", async (original) => ({
    ...(await original<typeof import("../src/config.js")>()),
    loadConfig: () => current.value!.config,
    resolveRuntimeConfig: async () => current.value!.config,
}));
vi.mock("../src/arkade/operatorWallet.js", async (original) => {
    const actual = await original<typeof import("../src/arkade/operatorWallet.js")>();
    return {
        ...actual,
        createOperatorRuntime: (
            cfg: Parameters<typeof createOperatorRuntime>[0],
            db: Parameters<typeof createOperatorRuntime>[1],
            options: Parameters<typeof createOperatorRuntime>[2],
        ) => {
            const h = current.value!;
            const runtime = actual.createOperatorRuntime(cfg, db, {
                ...options,
                now: () => Date.now(),
                providers: h.providers,
                onchainProvider: h.wallet.onchainProvider,
                walletFactory: async () => h.wallet,
            });
            h.runtime = runtime;
            return runtime;
        },
    };
});
vi.mock("../src/server.js", async (original) => {
    const actual = await original<typeof import("../src/server.js")>();
    return {
        ...actual,
        createApp: (deps: ServerDeps) => {
            const h = current.value!;
            h.deps = deps;
            deps.policy.update(policy(), "test");
            return actual.createApp(deps);
        },
    };
});
// Out of scope here, and its own blocker would mask the ones under test.
vi.mock("../src/proceeds.js", async (original) => ({
    ...(await original<typeof import("../src/proceeds.js")>()),
    createProceedsCollector: () => ({
        tick: async () => {},
        status: () => ({ running: false, jobId: null, state: "idle", blocker: null }),
        stop() {},
        drain: async () => {},
    }),
}));
// The scan this phase is about: on mutinynet `catchUp` ran for 30-73 s, and the
// whole reconcile chain waits behind it.
vi.mock("../src/watcher.js", async (original) => {
    const actual = await original<typeof import("../src/watcher.js")>();
    return {
        ...actual,
        createSpendWatcher: (deps: Parameters<typeof actual.createSpendWatcher>[0]) => {
            const h = current.value!;
            const watcher = actual.createSpendWatcher({ ...deps, wallet: undefined });
            return {
                ...watcher,
                catchUp: async () => {
                    h.scans += 1;
                    await h.scanGate;
                    await watcher.catchUp();
                },
            };
        },
    };
});
// Only `listen` is replaced: startBackground and stopBackground stay cli.ts's
// own wiring, which is the thing under test.
vi.mock("../src/lifecycle.js", async (original) => {
    const actual = await original<typeof import("../src/lifecycle.js")>();
    return {
        ...actual,
        createServiceLifecycle: (deps: Parameters<typeof createServiceLifecycle>[0]) => {
            const h = current.value!;
            const lifecycle = actual.createServiceLifecycle({
                ...deps,
                listen: async () => ({ stopAccepting() {}, finished: async () => {} }),
            });
            h.lifecycle = lifecycle;
            return {
                ...lifecycle,
                async start() {
                    await lifecycle.start();
                    await lifecycle.refresh();
                    h.started();
                },
            };
        },
    };
});
vi.mock("pino", () => ({
    pino: () => ({
        info() {},
        warn() {},
        error() {},
        debug() {},
        isLevelEnabled: () => false,
    }),
}));

let listeners: NodeJS.SignalsListener[] = [];
afterEach(async () => {
    const h = current.value;
    if (h) {
        h.scanGate = undefined;
        await h.lifecycle?.stop();
    }
    for (const signal of ["SIGINT", "SIGTERM"] as const)
        for (const listener of process.listeners(signal))
            if (!listeners.includes(listener)) process.removeListener(signal, listener);
    current.value = undefined;
    vi.useRealTimers();
    vi.restoreAllMocks();
});

const INTERVAL = 200;
const STALE_AFTER_SECONDS = 3;

async function boot() {
    vi.resetModules();
    vi.useFakeTimers({
        toFake: ["Date", "setTimeout", "clearTimeout", "setInterval", "clearInterval"],
    });
    vi.setSystemTime(NOW * 1_000);
    listeners = [...process.listeners("SIGINT"), ...process.listeners("SIGTERM")];
    const cfg = config({ addressHrp: "tark", reconcileIntervalMs: INTERVAL });
    let started!: () => void;
    const startup = new Promise<void>((resolve) => (started = resolve));
    const h: Harness = {
        config: cfg,
        scans: 0,
        coins: [fundingCoin(), fundingCoin({ vout: 1, expiresAtHeight: 900_001 })],
        providers: {
            arkProvider: {
                getInfo: async () =>
                    arkInfo({ checkpointTapscript: bytesToHex(serverUnroll.script) }),
            },
            emulatorProvider: {
                getInfo: async () => ({ signerPubkey: bytesToHex(providerEmulatorKey) }),
            },
        },
        wallet: {
            settle: async () => "",
            getVtxoManager: async () => ({ renewVtxos: async () => "" }),
            getAddress: async () =>
                new ArkAddress(cfg.serverPubkey, cfg.operatorKey, cfg.addressHrp).encode(),
            getSpendableVtxos: async () => h.coins,
            getContractManager: async () => ({
                getSyncState: () => ({ mode: "online", lastSyncedAt: Date.now() }),
            }),
            getProviderConnectionState: () => ({ mode: "online" }),
            onchainProvider: {
                getChainTip: async () => ({
                    height: 700_000,
                    time: Math.floor(Date.now() / 1_000),
                    hash: "aa".repeat(32),
                }),
            },
            dispose: async () => {},
        } as unknown as Wallet,
        started,
    };
    current.value = h;
    const argv = process.argv;
    process.argv = [argv[0]!, "cli", "serve"];
    try {
        await import("../src/cli.js");
        await startup;
    } finally {
        process.argv = argv;
    }
    return h;
}

const blockers = async (h: Harness): Promise<string[]> => {
    const ready = await createRoutes(h.deps!).request("/ready");
    return (await ready.json()).blockers;
};

const sweeperOf = (h: Harness) => h.deps!.sweeper as unknown as Sweeper;
const reconcilerOf = (h: Harness) => h.deps!.reconciler as unknown as LockupReconciler;

/** Counts work on the real objects cli.ts hands the freshness loop. */
const observeFreshnessWork = (h: Harness) => {
    const counts = { sweeps: 0, lendingGate: 0 };
    const sweeper = sweeperOf(h);
    const reconciler = reconcilerOf(h);
    const tick = sweeper.tick.bind(sweeper);
    const custody = reconciler.custody.bind(reconciler);
    sweeper.tick = async (height, medianTime) => {
        counts.sweeps += 1;
        return tick(height, medianTime);
    };
    reconciler.custody = async () => {
        counts.lendingGate += 1;
        await custody();
    };
    return counts;
};

describe("steady-state freshness under a slow watcher scan", () => {
    it("refreshes the runtime check, the sweep and the lending gate while a scan is in flight", async () => {
        const h = await boot();
        expect(await blockers(h)).toEqual([]);
        const counts = observeFreshnessWork(h);
        const scanned = h.scans;

        let release!: () => void;
        h.scanGate = new Promise<void>((resolve) => (release = resolve));
        const held = (STALE_AFTER_SECONDS + 2) * 1_000;
        try {
            await vi.advanceTimersByTimeAsync(held);

            expect(h.scans).toBe(scanned + 1);
            expect(await blockers(h)).toEqual([]);
            expect(h.runtime!.safety().checkedAt).toBeGreaterThan(NOW * 1_000);
            expect(sweeperOf(h).status().lastTickAt).toBe(Math.floor(Date.now() / 1_000));
            expect(counts.sweeps).toBeGreaterThanOrEqual(held / INTERVAL - 1);
            expect(counts.lendingGate).toBeGreaterThanOrEqual(held / INTERVAL - 1);
        } finally {
            release();
        }
    }, 30_000);

    it("still closes readiness while a scan is in flight and the runtime check fails", async () => {
        const h = await boot();
        const counts = observeFreshnessWork(h);

        let release!: () => void;
        h.scanGate = new Promise<void>((resolve) => (release = resolve));
        await vi.advanceTimersByTimeAsync(INTERVAL);
        h.coins = [];
        try {
            await vi.advanceTimersByTimeAsync(2 * INTERVAL);
            expect(await blockers(h)).toContain("operator_reserve_low");
            // The gate reads what is owed, not whether recovery may submit.
            expect(counts.lendingGate).toBeGreaterThan(0);
        } finally {
            release();
        }
    }, 30_000);

    it("drains an in-flight freshness pass on stop", async () => {
        const h = await boot();
        const sweeper = sweeperOf(h);
        const tick = sweeper.tick.bind(sweeper);
        let entered!: () => void;
        const inside = new Promise<void>((resolve) => (entered = resolve));
        let release!: () => void;
        const held = new Promise<void>((resolve) => (release = resolve));
        let finished = false;
        sweeper.tick = async (height, medianTime) => {
            entered();
            await held;
            const result = await tick(height, medianTime);
            finished = true;
            return result;
        };
        await vi.advanceTimersByTimeAsync(INTERVAL);
        await inside;

        const stopped = h.lifecycle!.stop();
        expect(finished).toBe(false);
        release();
        expect(await stopped).toEqual({ ok: true, code: "stopped" });
        expect(finished).toBe(true);
    }, 30_000);
});
