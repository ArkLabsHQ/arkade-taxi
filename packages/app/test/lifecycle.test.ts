import { afterEach, describe, expect, it, vi } from "vitest";
import { fork } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
    createBackgroundLoops,
    createServiceLifecycle,
    type LifecycleDeps,
} from "../src/lifecycle.js";

function harness(over: Partial<LifecycleDeps> = {}) {
    const calls: string[] = [];
    let releaseProvider!: () => void;
    const providerGate = new Promise<void>((resolve) => {
        releaseProvider = resolve;
    });
    const deps: LifecycleDeps = {
        listen: async () => {
            calls.push("listen");
            return {
                stopAccepting: () => {
                    calls.push("stop-accepting");
                },
                finished: async () => void calls.push("finish-server"),
            };
        },
        verifyRuntime: async () => void calls.push("verify"),
        reconcile: async () => void calls.push("reconcile"),
        firstRecoveryTick: async () => void calls.push("recovery-tick"),
        startStreams: async () => void calls.push("streams"),
        startBackground: () => void calls.push("background"),
        stopBackground: () => void calls.push("stop-background"),
        stopRuntime: () => void calls.push("stop-runtime"),
        abort: () => void calls.push("abort"),
        drain: async () => void calls.push("drain"),
        disposeProviders: async () => void calls.push("dispose-providers"),
        closeDatabase: () => void calls.push("close-database"),
        shutdownTimeoutMs: 50,
        forceTerminate: (_code, reason) => void calls.push(`force-${reason}`),
        ...over,
    };
    return { calls, lifecycle: createServiceLifecycle(deps), providerGate, releaseProvider };
}

describe("service lifecycle", () => {
    it("runs recovery while reconciliation reports admission blockers", async () => {
        const h = harness({ reconcile: async () => ({ blockers: ["covenant_spend_unknown"] }) });
        await h.lifecycle.start();
        await h.lifecycle.refresh();
        expect(h.calls).toContain("recovery-tick");
        expect(h.lifecycle.status()).toMatchObject({
            complete: false,
            blocker: "startup_reconciliation_failed",
        });
    });
    it("forces a child with a live provider handle to exit after closing its listener", async () => {
        const child = fork(
            fileURLToPath(new URL("./fixtures/lifecycle-hung-child.mjs", import.meta.url)),
            [],
            {
                execArgv: ["--experimental-strip-types", "--no-warnings"],
                silent: true,
            },
        );
        const messages: string[] = [];
        let stderr = "";
        child.on("message", (message: { type?: string }) => {
            if (message.type) messages.push(message.type);
        });
        child.stderr!.on("data", (chunk) => {
            stderr += String(chunk);
        });
        await new Promise<void>((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error("child did not listen")), 2_000);
            child.on("message", (message: { type?: string }) => {
                if (message.type === "listening") {
                    clearTimeout(timer);
                    resolve();
                }
            });
        });

        const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
            (resolve) => child.once("exit", (code, signal) => resolve({ code, signal })),
        );
        child.send("stop");
        const result = await Promise.race([
            exited,
            new Promise<never>((_, reject) =>
                setTimeout(() => {
                    child.kill();
                    reject(new Error("child did not terminate"));
                }, 2_000),
            ),
        ]);

        expect(result).toEqual({ code: 1, signal: null });
        expect(messages).toEqual(expect.arrayContaining(["stop-accepting", "runtime-stopped"]));
        expect(messages).not.toContain("db-closed");
        expect(stderr).toBe(
            '{"level":"fatal","code":"shutdown_timeout","message":"taxi shutdown did not drain safely"}\n',
        );
        expect(stderr).not.toMatch(/PRIVATE_PROVIDER_CREDENTIAL|never-settling provider/);
    });
    it("starts liveness before a never-resolving provider and stays unready", async () => {
        const h = harness({ verifyRuntime: () => h.providerGate });
        await h.lifecycle.start();

        expect(h.calls).toEqual(["listen"]);
        expect(h.lifecycle.status()).toMatchObject({ phase: "provider", complete: false });
        expect(h.lifecycle.status().blocker).toBe("startup_provider_pending");
        h.releaseProvider();
        await h.lifecycle.refresh();
    });

    it("runs dependency phases in order and marks complete only after streams start", async () => {
        const h = harness();
        await h.lifecycle.start();
        await h.lifecycle.refresh();

        expect(h.calls).toEqual([
            "listen",
            "verify",
            "reconcile",
            "recovery-tick",
            "streams",
            "background",
        ]);
        expect(h.lifecycle.status()).toEqual({ phase: "ready", complete: true, blocker: null });
    });

    it.each(["verifyRuntime", "reconcile", "firstRecoveryTick", "startStreams"] as const)(
        "preserves completed startup during a routine %s refresh",
        async (method) => {
            let refreshing = false;
            let enter!: () => void;
            const entered = new Promise<void>((resolve) => (enter = resolve));
            const h = harness({
                [method]: async () => {
                    if (refreshing) {
                        enter();
                        await h.providerGate;
                    }
                },
            });
            await h.lifecycle.start();
            await h.lifecycle.refresh();
            refreshing = true;

            const refresh = h.lifecycle.refresh();
            await entered;
            try {
                expect(h.lifecycle.refresh()).toBe(refresh);
                expect(h.lifecycle.status()).toEqual({
                    phase: "ready",
                    complete: true,
                    blocker: null,
                });
            } finally {
                h.releaseProvider();
                await refresh;
            }
            expect(h.calls.filter((call) => call === "background")).toHaveLength(1);
        },
    );

    it.each([
        ["provider", "verifyRuntime"],
        ["reconciliation", "reconcile"],
        ["recovery", "firstRecoveryTick"],
        ["streams", "startStreams"],
    ] as const)(
        "closes a completed startup when a routine %s refresh fails",
        async (phase, method) => {
            let fail = false;
            const h = harness({
                [method]: async () => {
                    if (fail) throw new Error("refresh failed");
                },
            });
            await h.lifecycle.start();
            await h.lifecycle.refresh();
            fail = true;

            await h.lifecycle.refresh();

            expect(h.lifecycle.status()).toEqual({
                phase,
                complete: false,
                blocker: `startup_${phase}_failed`,
            });
            fail = false;
            await h.lifecycle.refresh();
            expect(h.lifecycle.status()).toEqual({ phase: "ready", complete: true, blocker: null });
        },
    );

    it("does not mark startup complete when the first recovery tick fails", async () => {
        const h = harness({
            firstRecoveryTick: async () => {
                throw new Error("private key=SECRET_SENTINEL");
            },
        });
        await h.lifecycle.start();
        await h.lifecycle.refresh();

        expect(h.lifecycle.status()).toEqual({
            phase: "recovery",
            complete: false,
            blocker: "startup_recovery_failed",
        });
        expect(JSON.stringify(h.lifecycle.status())).not.toContain("SECRET_SENTINEL");
        expect(h.calls).toContain("background");
        expect(h.calls).not.toContain("streams");
    });

    it.each([
        ["provider", "verifyRuntime"],
        ["reconciliation", "reconcile"],
        ["streams", "startStreams"],
        ["background", "startBackground"],
    ] as const)("keeps readiness closed when the %s stage fails", async (phase, method) => {
        const h = harness({
            [method]: () => {
                throw new Error("stage failed");
            },
        });
        await h.lifecycle.start();
        await h.lifecycle.refresh();

        expect(h.lifecycle.status()).toEqual({
            phase,
            complete: false,
            blocker: `startup_${phase}_failed`,
        });
    });

    it("stops admission first, drains persistence, and closes the database last", async () => {
        const h = harness();
        await h.lifecycle.start();
        await h.lifecycle.refresh();

        const result = await h.lifecycle.stop();

        expect(result).toEqual({ ok: true, code: "stopped" });
        expect(h.calls.slice(-8)).toEqual([
            "stop-accepting",
            "stop-background",
            "stop-runtime",
            "abort",
            "drain",
            "dispose-providers",
            "finish-server",
            "close-database",
        ]);
    });

    it("returns one deterministic failure without closing SQLite when drain hangs", async () => {
        const never = new Promise<void>(() => {});
        const h = harness({ drain: () => never, shutdownTimeoutMs: 5 });
        await h.lifecycle.start();
        const first = h.lifecycle.stop();
        const second = h.lifecycle.stop();

        expect(second).toBe(first);
        await expect(first).resolves.toEqual({ ok: false, code: "shutdown_timeout" });
        expect(h.calls.filter((call) => call === "stop-accepting")).toHaveLength(1);
        expect(h.calls).toContain("stop-runtime");
        expect(h.calls).toContain("force-shutdown_timeout");
        expect(h.calls).not.toContain("close-database");
    });

    it("forces deterministic nonzero termination after a shutdown failure", async () => {
        const h = harness({
            drain: async () => {
                throw new Error("credential=PRIVATE");
            },
        });
        await h.lifecycle.start();

        await expect(h.lifecycle.stop()).resolves.toEqual({ ok: false, code: "shutdown_failed" });
        expect(h.calls).toContain("force-shutdown_failed");
        expect(h.calls).not.toContain("close-database");
    });
});

describe("steady-state background loops", () => {
    afterEach(() => void vi.useRealTimers());
    const INTERVAL = 100;
    const fakeInterval = () =>
        vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "setTimeout"] });
    const flush = async (times = 3) => {
        for (let i = 0; i < times; i++) await new Promise<void>((resolve) => setImmediate(resolve));
    };

    it("refreshes freshness every interval while one reconcile pass stays in flight", async () => {
        fakeInterval();
        const calls: string[] = [];
        let reconciles = 0;
        const never = new Promise<void>(() => {});
        const loops = createBackgroundLoops({
            intervalMs: INTERVAL,
            reconcile: () => {
                reconciles += 1;
                return never;
            },
            verifyRecovery: async () => {
                calls.push("verify");
                return { chainHeight: 7n, chainTime: 9n };
            },
            sweep: async (chainHeight, chainTime) => {
                calls.push(`sweep:${chainHeight}:${chainTime}`);
            },
            lendingGate: async () => void calls.push("lending"),
            onError: (_loop, error) => {
                throw error;
            },
        });
        loops.start();
        loops.start();
        try {
            await vi.advanceTimersByTimeAsync(5 * INTERVAL);
        } finally {
            loops.stop();
        }

        expect(reconciles).toBe(1);
        expect(calls.slice(0, 3)).toEqual(["verify", "sweep:7:9", "lending"]);
        for (const call of ["verify", "sweep:7:9", "lending"])
            expect(calls.filter((entry) => entry === call)).toHaveLength(5);
    });

    it("never overlaps two passes of the same loop", async () => {
        fakeInterval();
        let release!: () => void;
        const held = new Promise<void>((resolve) => (release = resolve));
        let concurrent = 0;
        let peak = 0;
        let entries = 0;
        const loops = createBackgroundLoops({
            intervalMs: INTERVAL,
            reconcile: async () => {},
            verifyRecovery: async () => {
                entries += 1;
                peak = Math.max(peak, ++concurrent);
                await held;
                concurrent -= 1;
                return { chainHeight: null, chainTime: null };
            },
            sweep: async () => {},
            lendingGate: async () => {},
            onError: (_loop, error) => {
                throw error;
            },
        });
        loops.start();
        await vi.advanceTimersByTimeAsync(5 * INTERVAL);

        expect({ entries, peak }).toEqual({ entries: 1, peak: 1 });
        release();
        loops.stop();
        await loops.drain();
    });

    it("refreshes the lending gate and reports the loop when the runtime check throws", async () => {
        fakeInterval();
        const errors: { loop: string; message: string }[] = [];
        let gates = 0;
        let sweeps = 0;
        const loops = createBackgroundLoops({
            intervalMs: INTERVAL,
            reconcile: async () => {},
            verifyRecovery: async () => {
                throw new Error("runtime_unsafe");
            },
            sweep: async () => void (sweeps += 1),
            lendingGate: async () => void (gates += 1),
            onError: (loop, error) => void errors.push({ loop, message: (error as Error).message }),
        });
        loops.start();
        try {
            await vi.advanceTimersByTimeAsync(2 * INTERVAL);
        } finally {
            loops.stop();
        }

        expect({ gates, sweeps }).toEqual({ gates: 2, sweeps: 0 });
        expect(errors).toEqual([
            { loop: "freshness", message: "runtime_unsafe" },
            { loop: "freshness", message: "runtime_unsafe" },
        ]);
    });

    it("drains both loops on stop and runs no further tick", async () => {
        fakeInterval();
        let releaseFreshness!: () => void;
        let releaseReconcile!: () => void;
        const freshnessHeld = new Promise<void>((resolve) => (releaseFreshness = resolve));
        const reconcileHeld = new Promise<void>((resolve) => (releaseReconcile = resolve));
        const done: string[] = [];
        let starts = 0;
        const loops = createBackgroundLoops({
            intervalMs: INTERVAL,
            reconcile: async () => {
                starts += 1;
                await reconcileHeld;
                done.push("reconcile");
            },
            verifyRecovery: async () => {
                starts += 1;
                await freshnessHeld;
                return { chainHeight: null, chainTime: null };
            },
            sweep: async () => {},
            lendingGate: async () => void done.push("freshness"),
            onError: (_loop, error) => {
                throw error;
            },
        });
        loops.start();
        await vi.advanceTimersByTimeAsync(INTERVAL);
        loops.stop();
        const drained = loops.drain();
        await vi.advanceTimersByTimeAsync(10 * INTERVAL);

        expect({ starts, done }).toEqual({ starts: 2, done: [] });
        releaseFreshness();
        releaseReconcile();
        await drained;
        await flush();
        expect([...done].sort()).toEqual(["freshness", "reconcile"]);
        expect(starts).toBe(2);
    });
});
