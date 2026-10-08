import { Hono, type Context, type Next } from "hono";
import type { AdvanceRepository, PolicyRepository } from "@arkade-taxi/db";
import { createAdminRouter } from "./admin/index.js";
import { createRoutes, operationalSnapshot, type RouteDeps } from "./routes.js";
import { ReceiverClaimFeed } from "./claimFeed.js";
import type { createBoarding } from "./boarding.js";
import { shownConfig } from "./config.js";

export interface ServerDeps extends Omit<RouteDeps, "advances" | "policy" | "claimFeed"> {
    advances: AdvanceRepository;
    policy: PolicyRepository;
    runtime: RouteDeps["runtime"] & { refresh(): Promise<unknown> };
    /** Tick period, so the admin surface can derive its own staleness bar. */
    sweeperIntervalMs: number;
    sweeperRunning: () => boolean;
    rescan(): Promise<void>;
    boarding: ReturnType<typeof createBoarding>;
    accepting?: () => boolean;
    shutdownSignal?: AbortSignal;
}

/**
 * Hand-rolled: `hono/cors` reads `c.res` before `next()`, which double-wraps
 * the `/v1/claims/events` SSE stream on finalize and breaks shutdown drain.
 */
function v1Cors() {
    return async (c: Context, next: Next) => {
        c.header("Access-Control-Allow-Origin", "*");
        if (c.req.method === "OPTIONS") {
            c.header("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
            c.header("Access-Control-Allow-Headers", "content-type");
            c.header("Access-Control-Max-Age", "300");
            return c.body(null, 204);
        }
        await next();
    };
}

const FUNDING_TTL_MS = 10_000;

/** Concurrent and repeated funding requests share one wallet read for
 * FUNDING_TTL_MS. A rejected read is dropped, so the next request retries. */
function fundingRead<T>(read: () => Promise<T>, nowMs: () => number): () => Promise<T> {
    let entry: { at: number; value: Promise<T> } | undefined;
    return () => {
        if (!entry || nowMs() - entry.at >= FUNDING_TTL_MS) {
            const current = { at: nowMs(), value: read() };
            current.value.catch(() => {
                if (entry === current) entry = undefined;
            });
            entry = current;
        }
        return entry.value;
    };
}

/**
 * The admin surface reads `lastTickAt` as epoch MILLISECONDS, while the ledger
 * — and so the sweeper — keeps unix seconds to match `QuoteResponse.expiresAt`.
 * Converted here rather than in either module, so neither has to know about the
 * other's unit.
 */
function adminDeps(deps: ServerDeps) {
    const coins = fundingRead(() => deps.inventory.getSpendableVtxos(), deps.nowMs);
    const boardingAddress = fundingRead(() => deps.boarding.address(), deps.nowMs);
    const deposits = fundingRead(() => deps.boarding.deposits(), deps.nowMs);
    return {
        advances: deps.advances,
        policy: deps.policy,
        swapFills: deps.swapFills,
        receiveQuotes: deps.receiveQuotes,
        recoveryExecutionBudget: {
            height: deps.config.recoveryBroadcastBlocks,
            time: deps.config.recoveryBroadcastSeconds,
        },
        dust: deps.config.dust,
        vtxoMinAmount: deps.config.vtxoMinAmount,
        sweeperStatus: () => {
            const s = deps.sweeper.status();
            return {
                running: deps.sweeperRunning(),
                lastTickAt: s.lastTickAt === null ? null : s.lastTickAt * 1000,
                intervalMs: deps.sweeperIntervalMs,
                lastHeight: s.lastTickHeight,
                recoverySubmittedTotal: s.recoverySubmittedTotal,
                lastError: s.lastError,
                deadlines: s.deadlines,
            };
        },
        /** The lifecycle refresh resolves with a runtime check still in flight, which
         * publishes `runtime_checking` and no chain height; settle it here, so every
         * admin rescan ends on a snapshot its caller can read synchronously. */
        rescan: async () => {
            await deps.rescan();
            await deps.runtime.refresh();
        },
        operationalSnapshot: (options?: { ignoreManualPause?: boolean }) =>
            operationalSnapshot(deps, options),
        now: deps.now,
        serviceConfig: shownConfig(deps.config),
        adminOperator: deps.config.adminOperator,
        funding: async () => ({
            config: deps.config,
            inventory: deps.runtime.safety().inventory,
            coins: await coins(),
            boarding: {
                address: await boardingAddress().catch(() => null),
                deposits: await deposits().catch(() => null),
            },
        }),
    };
}

function acceptingOnly(deps: Pick<ServerDeps, "shutdownSignal" | "accepting">) {
    return async (c: Context, next: Next) => {
        if (deps.shutdownSignal?.aborted || deps.accepting?.() === false)
            return c.json({ code: "shutting_down", error: "service is shutting down" }, 503);
        await next();
    };
}

/** No /v1 handler reads a cookie, so `origin: "*"` is safe here. */
export function createApp(deps: Omit<ServerDeps, "boarding">): Hono {
    const app = new Hono();
    app.use("/v1/*", v1Cors());
    app.use("*", acceptingOnly(deps));
    const claimFeed = new ReceiverClaimFeed(deps);
    deps.shutdownSignal?.addEventListener("abort", () => claimFeed.close(), { once: true });
    if (deps.shutdownSignal?.aborted) claimFeed.close();
    app.route("/", createRoutes({ ...deps, claimFeed }));
    return app;
}

/** Unauthenticated: serve it only where an authenticating proxy is the way in. */
export function createAdminApp(deps: ServerDeps): Hono {
    const app = new Hono();
    app.use("*", acceptingOnly(deps));
    app.route("/", createAdminRouter(adminDeps(deps)));
    return app;
}
