import { Hono } from "hono";
import type { AdvanceRepository, PolicyRepository } from "@arkade-taxi/db";
import { createAdminRouter } from "./admin/index.js";
import { createRoutes, operationalSnapshot, type RouteDeps } from "./routes.js";

export interface ServerDeps extends Omit<RouteDeps, "advances" | "policy"> {
    advances: AdvanceRepository;
    policy: PolicyRepository;
    /** Tick period, so the admin surface can derive its own staleness bar. */
    sweeperIntervalMs: number;
    sweeperRunning: () => boolean;
    rescan(): Promise<void>;
    accepting?: () => boolean;
}

export const ADMIN_PREFIX = "/admin";

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

export function createApp(deps: ServerDeps): Hono {
    const app = new Hono();
    app.use("*", async (c, next) => {
        if (deps.accepting?.() === false)
            return c.json({ code: "shutting_down", error: "service is shutting down" }, 503);
        await next();
    });
    app.route("/", createRoutes(deps));
    app.route(ADMIN_PREFIX, createAdminRouter(adminDeps(deps)));
    return app;
}
