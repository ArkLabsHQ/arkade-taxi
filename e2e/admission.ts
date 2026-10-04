import { signLockup, TaxiError, type TaxiClient, type VerifiedQuote } from "@arkade-taxi/client";
import type { Identity } from "@arkade-os/sdk";

const transientReadiness = [
    "runtime_checking",
    "runtime_stale",
    "proceeds_collecting",
    "proceeds_output_pending",
];

const readinessCodes = [
    ...transientReadiness,
    "chain_height_unavailable",
    "chain_time_unavailable",
];

export interface AdmissionTiming {
    operation: "quote" | "lockup";
    endpoint: "/v1/transfers" | "/v1/transfers/:id/lockup" | "/ready";
    phase: "attempt" | "readiness-headers" | "readiness-json";
    event: "start" | "finish" | "blocked";
    outcome: "pending" | "fulfilled" | "rejected" | "timeout";
    at: number;
    monotonicMs: number;
    elapsedMs: number;
    remainingOriginalBudgetMs?: number;
    selectedAbortDurationMs?: number;
    status?: number;
    reason?: string;
    blockers?: string[];
}

export interface AdmissionWindow {
    readyUrl: string;
    expiresAt: number;
    maxAttempts?: number;
    now?: () => number;
    onFailure?: (phase: "attempt" | "readiness-headers" | "readiness-json") => void;
    timing?: { operation: "quote" | "lockup"; observe: (entry: AdmissionTiming) => void };
}

export async function preEffectRequest<T>(
    attempt: () => Promise<T>,
    window: AdmissionWindow,
    unchanged: () => Promise<void> = async () => {},
): Promise<T> {
    const now = window.now ?? Date.now;
    let remainingOriginalBudgetMs = 0;
    let selectedAbortDurationMs: number | undefined;
    const failed = (phase: Parameters<NonNullable<AdmissionWindow["onFailure"]>>[0]) => {
        try {
            window.onFailure?.(phase);
        } catch {}
    };
    const observed = <T>(
        phase: Parameters<NonNullable<AdmissionWindow["onFailure"]>>[0],
        work: () => Promise<T>,
        status?: number,
    ): Promise<T> => {
        const started = window.timing ? performance.now() : 0;
        const at = window.timing ? Date.now() : 0;
        let budget = remainingOriginalBudgetMs;
        let abortDuration: number | undefined;
        const record = (event: AdmissionTiming["event"], value?: unknown, rejected = false) => {
            if (!window.timing) return;
            try {
                const monotonicMs = event === "start" ? started : performance.now();
                const responseStatus =
                    phase === "readiness-headers" && !rejected
                        ? (value as Response | undefined)?.status
                        : status;
                const body =
                    phase === "readiness-json" && !rejected && value && typeof value === "object"
                        ? (value as { reason?: unknown; blockers?: unknown })
                        : undefined;
                const blockers = body?.blockers;
                window.timing.observe({
                    operation: window.timing.operation === "lockup" ? "lockup" : "quote",
                    endpoint:
                        phase === "attempt"
                            ? window.timing.operation === "lockup"
                                ? "/v1/transfers/:id/lockup"
                                : "/v1/transfers"
                            : "/ready",
                    phase,
                    event,
                    outcome:
                        event === "start"
                            ? "pending"
                            : !rejected
                              ? "fulfilled"
                              : value instanceof DOMException && value.name === "TimeoutError"
                                ? "timeout"
                                : "rejected",
                    at: event === "start" ? at : Date.now(),
                    monotonicMs,
                    elapsedMs: monotonicMs - started,
                    ...(phase !== "readiness-json" && Number.isFinite(budget)
                        ? { remainingOriginalBudgetMs: budget }
                        : {}),
                    ...(phase === "readiness-headers" && abortDuration !== undefined
                        ? { selectedAbortDurationMs: abortDuration }
                        : {}),
                    ...(Number.isInteger(responseStatus) &&
                    responseStatus! >= 100 &&
                    responseStatus! <= 599
                        ? { status: responseStatus }
                        : {}),
                    ...(typeof body?.reason === "string" && readinessCodes.includes(body.reason)
                        ? { reason: body.reason }
                        : {}),
                    ...(Array.isArray(blockers)
                        ? { blockers: readinessCodes.filter((code) => blockers.includes(code)) }
                        : {}),
                });
            } catch {}
        };
        try {
            const result = work();
            budget = remainingOriginalBudgetMs;
            abortDuration = selectedAbortDurationMs;
            if (window.onFailure && phase !== "attempt")
                void result.then(undefined, () => failed(phase));
            record("start");
            if (window.timing)
                void result.then(
                    (value) => record("finish", value),
                    (error) => record("finish", error, true),
                );
            return result;
        } catch (error) {
            budget = remainingOriginalBudgetMs;
            abortDuration = selectedAbortDurationMs;
            if (phase === "readiness-headers" && abortDuration === undefined) {
                record("blocked", error, true);
            } else {
                record("start");
                record("finish", error, true);
            }
            if (phase !== "attempt") failed(phase);
            throw error;
        }
    };
    const limit = window.maxAttempts ?? 3;
    if (!Number.isInteger(limit) || limit < 1 || limit > 3)
        throw new Error("invalid pre-effect attempt limit");
    const remaining = () => {
        const value = window.expiresAt * 1000 - now();
        remainingOriginalBudgetMs = value;
        if (!Number.isFinite(value) || value <= 0)
            throw new Error("pre-effect request reached its original expiry");
        return value;
    };
    for (let index = 0; index < limit; index++) {
        remaining();
        try {
            return await observed("attempt", attempt);
        } catch (error) {
            if (
                !(error instanceof TaxiError) ||
                !(
                    (error.code === "not_ready" && transientReadiness.includes(error.message)) ||
                    (error.code === "runtime_unsafe" &&
                        ["runtime_checking", "runtime_stale"].includes(error.message))
                )
            ) {
                failed("attempt");
                throw error;
            }
            if (index + 1 === limit) {
                failed("attempt");
                throw new Error("pre-effect request exhausted its attempt limit", { cause: error });
            }
        }
        while (true) {
            selectedAbortDurationMs = undefined;
            const response = await observed("readiness-headers", () => {
                selectedAbortDurationMs = Math.max(1, Math.min(5000, Math.ceil(remaining())));
                return fetch(window.readyUrl, {
                    signal: AbortSignal.timeout(selectedAbortDurationMs),
                });
            });
            const body = await observed("readiness-json", () => response.json(), response.status);
            remaining();
            if (
                response.status === 200 &&
                body.status === "ok" &&
                body.paused === false &&
                Array.isArray(body.blockers) &&
                body.blockers.length === 0
            )
                break;
            const allowed = [
                ...transientReadiness,
                "chain_height_unavailable",
                "chain_time_unavailable",
            ];
            if (
                response.status !== 503 ||
                body.status !== "degraded" ||
                !transientReadiness.includes(body.reason) ||
                !Array.isArray(body.blockers) ||
                !body.blockers.includes(body.reason) ||
                body.blockers.some((code: unknown) => !allowed.includes(code as string))
            )
                throw new Error("readiness did not confirm the exact transient pre-effect state");
            await new Promise((resolve) => setTimeout(resolve, Math.min(50, remaining())));
        }
        await unchanged();
    }
    throw new Error("pre-effect attempt limit exhausted");
}

export async function submitWithReadiness(
    client: TaxiClient,
    verified: VerifiedQuote,
    identity: Identity,
    window: Omit<AdmissionWindow, "expiresAt">,
) {
    const signed = await signLockup({ verified, identity });
    return preEffectRequest(
        () => client.submitLockup(verified, signed),
        { ...window, expiresAt: verified.quote.expiresAt },
        async () => {
            const state = await client.status(verified.quote.transferId);
            if (
                state.transferId !== verified.quote.transferId ||
                state.state !== "quoted" ||
                state.submissionPhase !== undefined ||
                state.outpoint !== undefined ||
                state.spentTxid !== undefined ||
                state.failureCode !== undefined ||
                state.failureDetail !== undefined
            )
                throw new Error(
                    "transfer is not an unchanged quoted advance without submission effects",
                );
        },
    );
}
