/**
 * The operator's admin dashboard: live policy plus the observability that says
 * whether capital is at risk. Mounted by `server.ts`; no end-user surface.
 */

import { Hono } from "hono";
import { registerApiRoutes, type AdminDeps, type SweeperStatus } from "./routes.js";
import { registerStaticRoutes } from "./static.js";

export type { AdminDeps, SweeperStatus } from "./routes.js";
export { APP_JS, INDEX_HTML, STYLES_CSS } from "./static.js";

/**
 * Every route is registered twice — bare and under `/admin` — so the dashboard
 * answers at `/admin` whether the caller mounts this with
 * `app.route("/admin", …)` or `app.route("/", …)`. A mount mismatch would 404
 * the whole console, and the mount call is not ours to make.
 */
export function createAdminRouter(deps: AdminDeps): Hono {
    const router = new Hono();
    for (const prefix of ["", "/admin"]) {
        registerStaticRoutes(router, prefix);
        registerApiRoutes(router, prefix, deps);
    }
    return router;
}
