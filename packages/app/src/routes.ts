import { Hono, type Context } from "hono";
import { streamSSE } from "hono/streaming";
import { TERMINAL_STATES } from "@arkade-taxi/core";
import {
    bytesToHex,
    PROTOCOL_VERSION,
    satsToWire,
    type InfoResponse,
    type LockupRequestBody,
} from "@arkade-taxi/protocol";
import { ErrorCode, sanitizeOperationalError, ServiceError, toErrorResponse } from "./errors.js";
import { assetRuleToWire } from "./rulesWire.js";
import { createQuote, getTransfer, submitLockup, type QuoteDeps } from "./quotes.js";
import type { Sweeper } from "./sweeper.js";
import type { RecoveryDeadline, SweeperStatus } from "./sweeper.js";
import type { LockupReconciler } from "./reconciler.js";
import { ACTIVE_CLAIM_STATES, listReceiverClaims, parseReceiverAddresses } from "./claims.js";
import { ReceiverClaimFeed, type ClaimFeedLogger } from "./claimFeed.js";
import type { ProceedsStatus } from "./proceeds.js";

export interface RouteDeps extends QuoteDeps {
    claimFeed?: Pick<ReceiverClaimFeed, "subscribe">;
    claimFeedLogger?: ClaimFeedLogger;
    sweeper: Pick<Sweeper, "status">;
    reconciler: Pick<LockupReconciler, "status">;
    /** Seconds since the last completed tick after which /health reports
     * degraded. */
    sweeperStaleAfterSeconds: number;
    startup?: () => StartupStatus;
    proceeds?: () => ProceedsStatus;
}

export interface StartupStatus {
    phase: string;
    complete: boolean;
    blocker: string | null;
}

export interface HealthResponse {
    proceeds?: ProceedsStatus;
    runtime?: {
        checkedAt: number;
        chainHeight: string | null;
        chainTime: string | null;
        walletSynced: boolean;
        providerIdentityOk: boolean;
        blockers: string[];
        provider?: {
            network: string | null;
            identityOk: boolean;
            serverPubkey: string;
            emulatorPubkey: string;
        };
        inventory?: {
            usableSats: string;
            reservedSats: string;
            usableVtxos: number;
            reservedVtxos: number;
        };
    };
    status: "ok" | "degraded";
    paused: boolean;
    now: number;
    startup?: StartupStatus;
    blockers: string[];
    sweeper: {
        lastTickAt: number | null;
        lastTickHeight: string | null;
        lastTickMedianTime: string | null;
        recoverySubmittedTotal: number;
        failedTotal: number;
        lastError: string | null;
        lastRecoveryError: SweeperStatus["lastRecoveryError"];
        lockedCount: number;
        recoveringCount: number;
        lastSuccessfulObservationAt: number | null;
        lastSuccessfulRecoveryAt: number | null;
        nearestDeadline: {
            height: SerializedRecoveryDeadline | null;
            time: SerializedRecoveryDeadline | null;
        };
        oldestUnsweptLocktime: { height: string | null; time: string | null };
        blockers: SerializedRecoveryDeadline[];
    };
    reconciler: {
        lastTickAt: number | null;
        locking: number;
        blockers: string[];
        lastWatcherScanAt: number | null;
        watching: number;
    };
    reason?: string;
}

export interface OperationalSnapshot {
    ready: boolean;
    body: HealthResponse;
}

type SerializedRecoveryDeadline = Omit<
    RecoveryDeadline,
    "locktime" | "batchExpiry" | "remaining"
> & {
    locktime: string;
    batchExpiry: string;
    remaining: string | null;
};

const serializeDeadline = (deadline: RecoveryDeadline): SerializedRecoveryDeadline => ({
    advanceId: deadline.advanceId,
    kind: deadline.kind,
    locktime: deadline.locktime.toString(),
    batchExpiry: deadline.batchExpiry.toString(),
    remaining: deadline.remaining?.toString() ?? null,
    severity: deadline.severity,
    code: safeCode(deadline.code, "recovery_blocked"),
});

const safeCode = (value: string, fallback: string): string =>
    /^[a-z0-9][a-z0-9_.:-]{0,127}$/i.test(value) ? value : fallback;

export function operationalSnapshot(
    deps: Pick<
        RouteDeps,
        | "now"
        | "policy"
        | "runtime"
        | "sweeper"
        | "reconciler"
        | "sweeperStaleAfterSeconds"
        | "startup"
        | "proceeds"
    >,
    options: { ignoreManualPause?: boolean } = {},
): OperationalSnapshot {
    const s = deps.sweeper.status();
    const now = deps.now();
    const age = s.lastTickAt === null ? null : now - s.lastTickAt;
    const runtime = deps.runtime?.safety();
    const reconciler = deps.reconciler.status();
    const paused = deps.policy.get().paused;
    const startup = deps.startup?.();
    const proceeds = deps.proceeds?.();
    const blockers = [
        ...(proceeds?.blocker
            ? [safeCode(proceeds.blocker, "proceeds_blocked")]
            : proceeds?.jobId
              ? ["proceeds_collecting"]
              : []),
        ...(!options.ignoreManualPause && paused ? ["manual_pause"] : []),
        ...(startup && !startup.complete
            ? [safeCode(startup.blocker ?? `startup_${startup.phase}`, "startup_blocked")]
            : []),
        ...(runtime?.blockers.map((code) => safeCode(code, "runtime_blocked")) ?? []),
        ...(runtime?.chainHeight === null ? ["chain_height_unavailable"] : []),
        ...(runtime?.chainTime === null ? ["chain_time_unavailable"] : []),
        ...s.blockers.map(({ code }) => safeCode(code, "recovery_blocked")),
        ...reconciler.blockers.map((code) => safeCode(code, "reconciler_blocked")),
        ...(reconciler.lastTickAt === null ? ["reconciler_not_started"] : []),
        ...(age === null
            ? ["sweeper_not_started"]
            : age > deps.sweeperStaleAfterSeconds
              ? ["sweeper_stale"]
              : []),
    ];
    const uniqueBlockers = [...new Set(blockers)];
    const ready = uniqueBlockers.length === 0;
    const lastRecoveryError = s.lastRecoveryError
        ? {
              advanceId: s.lastRecoveryError.advanceId,
              code: safeCode(s.lastRecoveryError.code, "recovery_failed"),
              at: s.lastRecoveryError.at,
              message: sanitizeOperationalError(
                  new Error(s.lastRecoveryError.message),
                  "recovery failed",
              ),
          }
        : null;

    const reason =
        uniqueBlockers[0] === "reconciler_not_started"
            ? "the lockup reconciler has not completed a tick"
            : uniqueBlockers[0] === "sweeper_not_started"
              ? "the sweeper has not completed a tick"
              : uniqueBlockers[0] === "chain_height_unavailable"
                ? "verified chain height is unavailable"
                : uniqueBlockers[0] === "chain_time_unavailable"
                  ? "verified chain median time is unavailable"
                  : uniqueBlockers[0];
    return {
        ready,
        body: {
            ...(proceeds ? { proceeds } : {}),
            status: ready ? "ok" : "degraded",
            paused,
            now,
            ...(startup
                ? {
                      startup: {
                          phase: safeCode(startup.phase, "unknown"),
                          complete: startup.complete,
                          blocker: startup.blocker
                              ? safeCode(startup.blocker, "startup_blocked")
                              : null,
                      },
                  }
                : {}),
            blockers: uniqueBlockers,
            ...(runtime
                ? {
                      runtime: {
                          checkedAt: runtime.checkedAt,
                          chainHeight: runtime.chainHeight?.toString() ?? null,
                          chainTime: runtime.chainTime?.toString() ?? null,
                          walletSynced: runtime.walletSynced,
                          providerIdentityOk: runtime.providerIdentityOk,
                          ...(runtime.provider
                              ? {
                                    provider: {
                                        network: runtime.provider.network
                                            ? safeCode(runtime.provider.network, "unknown")
                                            : null,
                                        identityOk: runtime.provider.identityOk,
                                        serverPubkey: runtime.provider.serverPubkey,
                                        emulatorPubkey: runtime.provider.emulatorPubkey,
                                    },
                                }
                              : {}),
                          blockers: runtime.blockers.map((code) =>
                              safeCode(code, "runtime_blocked"),
                          ),
                          ...(runtime.inventory
                              ? {
                                    inventory: {
                                        ...runtime.inventory,
                                        usableSats: runtime.inventory.usableSats.toString(),
                                        reservedSats: runtime.inventory.reservedSats.toString(),
                                    },
                                }
                              : {}),
                      },
                  }
                : {}),
            sweeper: {
                lastTickAt: s.lastTickAt,
                lastTickHeight: s.lastTickHeight === null ? null : satsToWire(s.lastTickHeight),
                lastTickMedianTime:
                    s.lastTickMedianTime === null ? null : s.lastTickMedianTime.toString(),
                recoverySubmittedTotal: s.recoverySubmittedTotal,
                failedTotal: s.failedTotal,
                lastError: s.lastError
                    ? sanitizeOperationalError(new Error(s.lastError), "sweeper failed")
                    : null,
                lastRecoveryError,
                lockedCount: s.lockedCount,
                recoveringCount: s.recoveringCount,
                lastSuccessfulObservationAt: s.lastSuccessfulObservationAt,
                lastSuccessfulRecoveryAt: s.lastSuccessfulRecoveryAt,
                nearestDeadline: {
                    height: s.nearestDeadline.height
                        ? serializeDeadline(s.nearestDeadline.height)
                        : null,
                    time: s.nearestDeadline.time ? serializeDeadline(s.nearestDeadline.time) : null,
                },
                oldestUnsweptLocktime: {
                    height: s.oldestUnsweptLocktime.height?.toString() ?? null,
                    time: s.oldestUnsweptLocktime.time?.toString() ?? null,
                },
                blockers: s.blockers.map(serializeDeadline),
            },
            reconciler: {
                lastTickAt: reconciler.lastTickAt,
                locking: reconciler.locking,
                blockers: reconciler.blockers.map((code) => safeCode(code, "reconciler_blocked")),
                lastWatcherScanAt: reconciler.lastWatcherScanAt ?? null,
                watching: reconciler.watching ?? 0,
            },
            ...(ready ? {} : { reason }),
        },
    };
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

const assertFinancialMutationReady = (deps: RouteDeps): void => {
    const state = operationalSnapshot(deps, { ignoreManualPause: true });
    if (!state.ready)
        throw new ServiceError("not_ready", 503, state.body.reason ?? "service is not ready");
};

export function createRoutes(deps: RouteDeps): Hono {
    const app = new Hono();
    const claimFeed = deps.claimFeed ?? new ReceiverClaimFeed(deps);

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
                assetRules: p.assetRules.map(assetRuleToWire),
                maxPerPaymentTopupSats: satsToWire(p.maxPerPaymentTopupSats),
                paused: p.paused,
            };
            return body;
        }),
    );

    app.post("/v1/transfers", (c) =>
        handle(c, async () => {
            return createQuote(deps, await readJson(c), () => assertFinancialMutationReady(deps));
        }),
    );

    app.post("/v1/transfers/:id/lockup", async (c) => {
        try {
            assertFinancialMutationReady(deps);
            const id = c.req.param("id");
            const body = await submitLockup(deps, id, signedTxOf(await readJson(c)));
            return c.json(body, deps.advances.get(id)?.state === "locked" ? 200 : 202);
        } catch (e) {
            const err = ServiceError.from(e);
            return c.json(toErrorResponse(err), err.status);
        }
    });

    app.get("/v1/transfers/:id", (c) => handle(c, () => getTransfer(deps, c.req.param("id"))));

    app.get("/v1/claims", (c) =>
        handle(c, () => ({
            claims: listReceiverClaims(
                deps,
                parseReceiverAddresses(
                    new URL(c.req.url).searchParams.getAll("receiver"),
                    deps.config,
                ),
                ACTIVE_CLAIM_STATES,
            ),
        })),
    );

    app.get("/v1/claims/events", (c) => {
        try {
            const receivers = parseReceiverAddresses(
                new URL(c.req.url).searchParams.getAll("receiver"),
                deps.config,
            );
            const baseline = listReceiverClaims(deps, receivers, [
                ...ACTIVE_CLAIM_STATES,
                ...TERMINAL_STATES,
            ]);
            const snapshot = baseline.filter((claim) =>
                ACTIVE_CLAIM_STATES.some((state) => state === claim.state),
            );
            const response = streamSSE(c, async (stream) => {
                let unsubscribe: (() => void) | undefined;
                let heartbeat: ReturnType<typeof setInterval> | undefined;
                let resolveEnded!: () => void;
                const ended = new Promise<void>((resolve) => {
                    resolveEnded = resolve;
                });
                const stop = () => stream.abort();
                const cleanup = () => {
                    clearInterval(heartbeat);
                    unsubscribe?.();
                    c.req.raw.signal.removeEventListener("abort", stop);
                    resolveEnded();
                };
                stream.onAbort(cleanup);
                c.req.raw.signal.addEventListener("abort", stop, { once: true });
                if (c.req.raw.signal.aborted) {
                    stop();
                    return;
                }
                let writing = Promise.resolve();
                const write = (frame: string): Promise<void> => {
                    const next = writing.then(async () => {
                        if (stream.aborted) return;
                        // Hono write/writeSSE swallow transport errors; pipe propagates them.
                        await stream.pipe(
                            new ReadableStream({
                                start(controller) {
                                    controller.enqueue(new TextEncoder().encode(frame));
                                    controller.close();
                                },
                            }),
                        );
                    });
                    writing = next.catch(stop);
                    return next;
                };
                try {
                    const initial = write(
                        `event: claims-snapshot\ndata: ${JSON.stringify({ claims: snapshot })}\n\n`,
                    );
                    unsubscribe = claimFeed.subscribe(
                        receivers.receiverKeys,
                        {
                            onChanged: (event) =>
                                write(`event: claims-changed\ndata: ${JSON.stringify(event)}\n\n`),
                            onError: stop,
                        },
                        baseline,
                    );
                    await initial;
                    if (stream.aborted) return;
                    let heartbeatPending = false;
                    heartbeat = setInterval(() => {
                        if (heartbeatPending) return;
                        heartbeatPending = true;
                        void write(": heartbeat\n\n")
                            .catch(stop)
                            .finally(() => {
                                heartbeatPending = false;
                            });
                    }, 15_000);
                    await ended;
                } catch {
                    stop();
                } finally {
                    cleanup();
                }
            });
            response.headers.set("Connection", "close");
            return response;
        } catch (error) {
            const err = ServiceError.from(error);
            return c.json(toErrorResponse(err), err.status);
        }
    });

    // Liveness, not readiness: 200 whenever the process can serve. A stale
    // sweeper means arkd is unreachable, and restarting the container cannot
    // make it reachable — an orchestrator treating that as liveness would churn
    // forever while hiding the cause. Staleness is reported in the body and
    // gates /ready instead.
    app.get("/health", (c) => c.json(operationalSnapshot(deps).body, 200));

    app.get("/ready", (c) => {
        const { body, ready } = operationalSnapshot(deps);
        return c.json(body, ready ? 200 : 503);
    });

    return app;
}
