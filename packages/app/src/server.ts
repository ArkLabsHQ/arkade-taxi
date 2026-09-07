import { Hono } from "hono";
import type { AdvanceRepository, PolicyRepository } from "@arkade-taxi/db";
import { createAdminRouter } from "./admin/index.js";
import { createRoutes, type RouteDeps } from "./routes.js";

export interface ServerDeps extends Omit<RouteDeps, "advances" | "policy"> {
    advances: AdvanceRepository;
    policy: PolicyRepository;
    /** Tick period, so the admin surface can derive its own staleness bar. */
    sweeperIntervalMs: number;
    sweeperRunning: () => boolean;
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
        sweeperStatus: () => {
            const s = deps.sweeper.status();
            return {
                running: deps.sweeperRunning(),
                lastTickAt: s.lastTickAt === null ? null : s.lastTickAt * 1000,
                intervalMs: deps.sweeperIntervalMs,
                lastHeight: s.lastTickHeight,
                sweptCount: s.recoveredTotal,
                lastError: s.lastError,
            };
        },
    };
}

export function createApp(deps: ServerDeps): Hono {
    const app = new Hono();
    app.route("/", createRoutes(deps));
    app.route(ADMIN_PREFIX, createAdminRouter(adminDeps(deps)));
    return app;
}
