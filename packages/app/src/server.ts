import { Hono, type Context, type Next } from "hono";
import type { AdvanceRepository, PolicyRepository } from "@arkade-taxi/db";
import { createAdminRouter } from "./admin/index.js";
import { createRoutes, operationalSnapshot, type RouteDeps } from "./routes.js";
import { ReceiverClaimFeed } from "./claimFeed.js";

export interface ServerDeps extends Omit<RouteDeps, "advances" | "policy" | "claimFeed"> {
    advances: AdvanceRepository;
    policy: PolicyRepository;
    /** Tick period, so the admin surface can derive its own staleness bar. */
    sweeperIntervalMs: number;
    sweeperRunning: () => boolean;
    rescan(): Promise<void>;
    accepting?: () => boolean;
    shutdownSignal?: AbortSignal;
}

export const ADMIN_PREFIX = "/admin";

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

/**
 * The admin surface reads `lastTickAt` as epoch MILLISECONDS, while the ledger
 * — and so the sweeper — keeps unix seconds to match `QuoteResponse.expiresAt`.
 * Converted here rather than in either module, so neither has to know about the
 * other's unit.
 */
function adminDeps(deps: ServerDeps) {
    return {
        advances: deps.advances,
        policy: deps.policy,
        recoveryExecutionBudget: {
            height: deps.config.recoveryBroadcastBlocks,
            time: deps.config.recoveryBroadcastSeconds,
        },
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
        rescan: deps.rescan,
        operationalSnapshot: (options?: { ignoreManualPause?: boolean }) =>
            operationalSnapshot(deps, options),
        now: deps.now,
    };
}

/** No /v1 handler reads a cookie, so `origin: "*"` is safe here; /admin gets
 * no CORS headers and never Allow-Credentials. */
export function createApp(deps: ServerDeps): Hono {
    const app = new Hono();
    app.use("/v1/*", v1Cors());
    app.use("*", async (c, next) => {
        if (deps.shutdownSignal?.aborted || deps.accepting?.() === false)
            return c.json({ code: "shutting_down", error: "service is shutting down" }, 503);
        await next();
    });
    const claimFeed = new ReceiverClaimFeed(deps);
    deps.shutdownSignal?.addEventListener("abort", () => claimFeed.close(), { once: true });
    if (deps.shutdownSignal?.aborted) claimFeed.close();
    app.route("/", createRoutes({ ...deps, claimFeed }));
    app.route(ADMIN_PREFIX, createAdminRouter(adminDeps(deps)));
    return app;
}
