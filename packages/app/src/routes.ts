import { Hono, type Context } from "hono";
import {
    bytesToHex,
    PROTOCOL_VERSION,
    satsToWire,
    type AssetIdWire,
    type InfoResponse,
    type LockupRequestBody,
} from "@arkade-taxi/protocol";
import { ErrorCode, ServiceError, toErrorResponse } from "./errors.js";
import { createQuote, getTransfer, submitLockup, type QuoteDeps } from "./quotes.js";
import type { Sweeper } from "./sweeper.js";

export interface RouteDeps extends QuoteDeps {
    sweeper: Pick<Sweeper, "status">;
    /** Seconds since the last completed tick after which /health reports
     * degraded. */
    sweeperStaleAfterSeconds: number;
}

export interface HealthResponse {
    status: "ok" | "degraded";
    now: number;
    sweeper: {
        lastTickAt: number | null;
        lastTickHeight: string | null;
        recoveredTotal: number;
        failedTotal: number;
        lastError: string | null;
    };
    reason?: string;
}

/** `assetIdKey`'s format is `<hex txid>:<groupIndex>`. A row that does not
 * parse is dropped rather than failing the whole response: `admit` is the
 * authority on the allowlist, this is advisory. */
function allowlistToWire(keys: string[] | null): AssetIdWire[] | null {
    if (keys === null) return null;
    const out: AssetIdWire[] = [];
    for (const key of keys) {
        const at = key.lastIndexOf(":");
        if (at <= 0) continue;
        const groupIndex = Number(key.slice(at + 1));
        if (!Number.isSafeInteger(groupIndex) || groupIndex < 0) continue;
        out.push({ txid: key.slice(0, at), groupIndex });
    }
    return out;
}

async function readJson(c: Context): Promise<unknown> {
    try {
        return await c.req.json();
    } catch (cause) {
        throw new ServiceError(ErrorCode.InvalidRequest, 400, "request body is not valid JSON", {
            cause,
        });
    }
}

const signedTxOf = (body: unknown): string => {
    const tx = (body as LockupRequestBody | null)?.signedLockupTx;
    if (typeof tx !== "string" || tx === "") {
        throw new ServiceError(
            ErrorCode.InvalidRequest,
            400,
            "signedLockupTx must be a non-empty base64 PSBT",
        );
    }
    return tx;
};

export function createRoutes(deps: RouteDeps): Hono {
    const app = new Hono();

    const handle = async (c: Context, fn: () => unknown | Promise<unknown>) => {
        try {
            return c.json(await fn());
        } catch (e) {
            const err = ServiceError.from(e);
            return c.json(toErrorResponse(err), err.status);
        }
    };

    app.get("/v1/info", (c) =>
        handle(c, () => {
            const p = deps.policy.get();
            const cfg = deps.config;
            const body: InfoResponse = {
                protocolVersion: PROTOCOL_VERSION,
                operatorKey: bytesToHex(cfg.operatorKey),
                serverKey: bytesToHex(cfg.serverPubkey),
                emulatorKey: bytesToHex(cfg.emulatorPubkey),
                arkdUrl: cfg.arkdUrl,
                emulatorUrl: cfg.emulatorUrl,
                dust: satsToWire(cfg.dust),
                vtxoMinAmount: satsToWire(cfg.vtxoMinAmount),
                assetAllowlist: allowlistToWire(p.assetAllowlist),
                feeFlatSats: satsToWire(p.feeFlatSats),
                feeBps: p.feeBps,
                maxPerPaymentTopupSats: satsToWire(p.maxPerPaymentTopupSats),
                paused: p.paused,
            };
            return body;
        }),
    );

    app.post("/v1/transfers", (c) => handle(c, async () => createQuote(deps, await readJson(c))));

    app.post("/v1/transfers/:id/lockup", (c) =>
        handle(c, async () => submitLockup(deps, c.req.param("id"), signedTxOf(await readJson(c)))),
    );

    app.get("/v1/transfers/:id", (c) => handle(c, () => getTransfer(deps, c.req.param("id"))));

    const healthBody = (): { body: HealthResponse; ready: boolean } => {
        const s = deps.sweeper.status();
        const now = deps.now();
        const age = s.lastTickAt === null ? null : now - s.lastTickAt;
        const ready = age !== null && age <= deps.sweeperStaleAfterSeconds;

        return {
            ready,
            body: {
                status: ready ? "ok" : "degraded",
                now,
                sweeper: {
                    lastTickAt: s.lastTickAt,
                    lastTickHeight: s.lastTickHeight === null ? null : satsToWire(s.lastTickHeight),
                    recoveredTotal: s.recoveredTotal,
                    failedTotal: s.failedTotal,
                    lastError: s.lastError,
                },
                ...(ready
                    ? {}
                    : {
                          reason:
                              age === null
                                  ? "the sweeper has not completed a tick"
                                  : `the sweeper last ticked ${age}s ago`,
                      }),
            },
        };
    };

    // Liveness, not readiness: 200 whenever the process can serve. A stale
    // sweeper means arkd is unreachable, and restarting the container cannot
    // make it reachable — an orchestrator treating that as liveness would churn
    // forever while hiding the cause. Staleness is reported in the body and
    // gates /ready instead.
    app.get("/health", (c) => c.json(healthBody().body, 200));

    app.get("/ready", (c) => {
        const { body, ready } = healthBody();
        return c.json(body, ready ? 200 : 503);
    });

    return app;
}
