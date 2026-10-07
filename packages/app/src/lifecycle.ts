type LifecyclePhase =
    | "local"
    | "listening"
    | "provider"
    | "reconciliation"
    | "recovery"
    | "streams"
    | "background"
    | "ready"
    | "stopping"
    | "stopped";

interface LifecycleStatus {
    phase: LifecyclePhase;
    complete: boolean;
    blocker: string | null;
}

export interface LifecycleServer {
    stopAccepting(): void;
    finished(): Promise<void>;
}

export interface LifecycleDeps {
    listen(): Promise<LifecycleServer>;
    verifyRuntime(): Promise<void>;
    reconcile(): Promise<void | { blockers: string[] }>;
    firstRecoveryTick(): Promise<void>;
    startStreams(): Promise<void>;
    startBackground(prompt: () => Promise<void>): void;
    stopBackground(): void;
    stopRuntime(): void;
    abort(): void;
    drain(): Promise<void>;
    disposeProviders(): Promise<void>;
    closeDatabase(): void;
    shutdownTimeoutMs: number;
    forceTerminate(code: 1, reason: "shutdown_timeout" | "shutdown_failed"): void;
}

type ShutdownResult =
    { ok: true; code: "stopped" } | { ok: false; code: "shutdown_timeout" | "shutdown_failed" };

export function shutdownFatalDiagnostic(code: "shutdown_timeout" | "shutdown_failed"): string {
    return JSON.stringify({
        level: "fatal",
        code,
        message: "taxi shutdown did not drain safely",
    });
}

export function createServiceLifecycle(deps: LifecycleDeps) {
    let state: LifecycleStatus = { phase: "local", complete: false, blocker: null };
    let server: LifecycleServer | undefined;
    let initialization: Promise<void> | undefined;
    let backgroundStarted = false;
    let stopping: Promise<ShutdownResult> | undefined;

    const initialize = async (): Promise<void> => {
        const startup = !state.complete;
        let currentPhase: LifecyclePhase = "provider";
        let reconciliationBlocked = false;
        try {
            for (const [phase, work] of [
                ["provider", deps.verifyRuntime],
                ["reconciliation", deps.reconcile],
                ["recovery", deps.firstRecoveryTick],
                ["streams", deps.startStreams],
            ] as const) {
                currentPhase = phase;
                if (startup)
                    state = {
                        phase,
                        complete: false,
                        blocker: `startup_${phase}_pending`,
                    };
                const result = await work();
                if (phase === "reconciliation" && result)
                    reconciliationBlocked = result.blockers.length > 0;
            }
            currentPhase = "background";
            if (startup)
                state = {
                    phase: "background",
                    complete: false,
                    blocker: "startup_background_pending",
                };
            if (!backgroundStarted) {
                deps.startBackground(refresh);
                backgroundStarted = true;
            }
            state = reconciliationBlocked
                ? {
                      phase: "reconciliation",
                      complete: false,
                      blocker: "startup_reconciliation_failed",
                  }
                : { phase: "ready", complete: true, blocker: null };
        } catch {
            const failedPhase = currentPhase;
            state = {
                phase: failedPhase,
                complete: false,
                blocker: `startup_${failedPhase}_failed`,
            };
            if (!backgroundStarted && !stopping) {
                try {
                    deps.startBackground(refresh);
                    backgroundStarted = true;
                } catch {
                    state = {
                        phase: "background",
                        complete: false,
                        blocker: "startup_background_failed",
                    };
                }
            }
        }
    };

    const refresh = (): Promise<void> => {
        if (stopping) return Promise.resolve();
        if (!initialization)
            initialization = initialize().finally(() => {
                initialization = undefined;
            });
        return initialization;
    };

    const start = async (): Promise<void> => {
        if (server) return;
        state = { phase: "listening", complete: false, blocker: "startup_listening" };
        server = await deps.listen();
        void refresh();
    };

    const bounded = async (work: Promise<void>, deadline: number): Promise<boolean> => {
        const remaining = Math.max(0, deadline - Date.now());
        let timer: ReturnType<typeof setTimeout> | undefined;
        const timeout = new Promise<false>((resolve) => {
            timer = setTimeout(() => resolve(false), remaining);
        });
        const result = await Promise.race([work.then(() => true as const), timeout]);
        if (timer) clearTimeout(timer);
        return result;
    };

    const stop = (): Promise<ShutdownResult> =>
        (stopping ??= (async () => {
            state = { phase: "stopping", complete: false, blocker: "shutdown_in_progress" };
            const deadline = Date.now() + deps.shutdownTimeoutMs;
            const fail = (code: "shutdown_timeout" | "shutdown_failed"): ShutdownResult => {
                deps.forceTerminate(1, code);
                return { ok: false, code };
            };
            try {
                server?.stopAccepting();
                deps.stopBackground();
                deps.stopRuntime();
                deps.abort();
                const drained = await bounded(
                    Promise.all([initialization, deps.drain()]).then(() => {}),
                    deadline,
                );
                if (!drained) return fail("shutdown_timeout");
                if (!(await bounded(deps.disposeProviders(), deadline)))
                    return fail("shutdown_timeout");
                if (server && !(await bounded(server.finished(), deadline)))
                    return fail("shutdown_timeout");
                deps.closeDatabase();
                state = { phase: "stopped", complete: false, blocker: "runtime_stopped" };
                return { ok: true, code: "stopped" };
            } catch {
                return fail("shutdown_failed");
            }
        })());

    return { start, refresh, stop, status: (): LifecycleStatus => ({ ...state }) };
}

type LoopName = "freshness" | "reconcile";

export interface BackgroundLoopDeps {
    intervalMs: number;
    /** The reconcile chain, i.e. the lifecycle's own `refresh`. */
    reconcile(): Promise<void>;
    /** Republishes the runtime snapshot and reports the sweep's chain clock. */
    verifyRecovery(): Promise<{ chainHeight: bigint | null; chainTime: bigint | null }>;
    sweep(chainHeight: bigint | null, chainTime: bigint | null): Promise<void>;
    /** The custody solvency pass the lending gate reads. */
    lendingGate(): Promise<void>;
    onError(loop: LoopName, error: unknown): void;
}

/**
 * Steady state runs as two independent timers, so a slow watcher scan inside the
 * reconcile chain cannot stale readiness, delay the recovery sweep or delay the
 * lending gate. One in-flight promise per loop; startup stays serialized in
 * `initialize`, which runs before either timer is installed.
 */
export function createBackgroundLoops(deps: BackgroundLoopDeps) {
    const timers: ReturnType<typeof setInterval>[] = [];
    const pending = new Map<LoopName, Promise<void>>();

    const freshness = async (): Promise<void> => {
        try {
            const safety = await deps.verifyRecovery();
            await deps.sweep(safety.chainHeight, safety.chainTime);
        } finally {
            // What is owed is not conditional on whether recovery may submit.
            await deps.lendingGate();
        }
    };

    const run = (loop: LoopName, work: () => Promise<void>): Promise<void> => {
        const existing = pending.get(loop);
        if (existing) return existing;
        const started = (async () => work())()
            .catch((error: unknown) => deps.onError(loop, error))
            .finally(() => pending.delete(loop));
        pending.set(loop, started);
        return started;
    };

    return {
        start() {
            if (timers.length) return;
            for (const [loop, work] of [
                ["freshness", freshness],
                ["reconcile", () => deps.reconcile()],
            ] as const)
                timers.push(setInterval(() => void run(loop, work), deps.intervalMs));
        },
        stop() {
            for (const timer of timers.splice(0)) clearInterval(timer);
        },
        drain: (): Promise<void> => Promise.all([...pending.values()]).then(() => {}),
    };
}
