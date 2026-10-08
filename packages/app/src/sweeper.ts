import { advanceKind, type Advance, type ExpiryDeadline } from "@arkade-taxi/core";
import type { RuntimeConfig } from "./config.js";
import type { ObservedCovenant } from "./watcher.js";
import type { AdvanceStore } from "./quotes.js";
import { RecoveryArtifactError, type RecoverySubmission } from "./arkade/recovery.js";
import { sanitizeOperationalError } from "./errors.js";

export interface RecoveryRunner {
    recover(a: Advance): Promise<RecoverySubmission | undefined>;
    stop?(): void;
}

export interface SweeperDeps {
    advances: AdvanceStore;
    recovery: RecoveryRunner;
    now(): number;
    config?: Pick<
        RuntimeConfig,
        | "recoveryBroadcastBlocks"
        | "recoveryCriticalBlocks"
        | "recoveryBroadcastSeconds"
        | "recoveryCriticalSeconds"
    >;
    policy?: {
        get(): { paused: boolean };
        update(patch: { paused?: boolean }, actor?: string): unknown;
    };
    onError?: (advanceId: string, error: unknown) => void;
    canRecover?: (advance: Advance) => boolean;
    /** The watcher's last read of the covenant coin. A v2 advance stores no
     * batch expiry, so this is the only source for the one it races. */
    observed?: (advance: Advance) => ObservedCovenant | undefined;
    /** A v2 renewal fell behind. Fired on change, not per tick: an alarm that
     * repeats at tick rate is one an operator learns to skip. */
    onRenewalWarning?: (warning: { delegation: string; deadline: RecoveryDeadline }) => void;
}

export interface SweepResult {
    id: string;
    ok: boolean;
    txid?: string;
    error?: string;
    errorCode?: string;
    alreadyKnown?: boolean;
}

export interface TickResult {
    at: number;
    height: bigint | null;
    medianTime: bigint | null;
    considered: number;
    recoverySubmitted: number;
    failed: number;
    results: SweepResult[];
}

export type DeadlineSeverity = "eligible" | "warning" | "critical" | "expired";

export interface RecoveryDeadline {
    advanceId: string;
    kind: ExpiryDeadline["kind"];
    locktime: bigint;
    /** Null on v2, which stores none: its clock is the deadline itself. */
    batchExpiry: bigint | null;
    remaining: bigint | null;
    severity: DeadlineSeverity;
    code: string;
}

export interface SweeperStatus {
    lastTickAt: number | null;
    lastTickHeight: bigint | null;
    lastTickMedianTime: bigint | null;
    recoverySubmittedTotal: number;
    failedTotal: number;
    lastError: string | null;
    lastRecoveryError: { advanceId: string; code: string; at: number; message: string } | null;
    lockedCount: number;
    recoveringCount: number;
    lastSuccessfulObservationAt: number | null;
    lastSuccessfulRecoveryAt: number | null;
    nearestDeadline: { height: RecoveryDeadline | null; time: RecoveryDeadline | null };
    oldestUnsweptLocktime: { height: bigint | null; time: bigint | null };
    blockers: RecoveryDeadline[];
    deadlines: RecoveryDeadline[];
}

export interface Sweeper {
    tick(currentHeight: bigint | null, medianTime?: bigint | null): Promise<TickResult>;
    status(): SweeperStatus;
    stop(): void;
}

const compareBig = (a: bigint, b: bigint): number => (a < b ? -1 : a > b ? 1 : 0);
const severityRank: Record<DeadlineSeverity, number> = {
    expired: 0,
    critical: 1,
    warning: 2,
    eligible: 3,
};

export function createSweeper(deps: SweeperDeps): Sweeper {
    let lastTickAt: number | null = null;
    let lastTickHeight: bigint | null = null;
    let lastTickMedianTime: bigint | null = null;
    let recoverySubmittedTotal = 0;
    let failedTotal = 0;
    let lastError: string | null = null;
    let lastRecoveryError: SweeperStatus["lastRecoveryError"] = null;
    let lockedCount = 0;
    let recoveringCount = 0;
    let lastSuccessfulObservationAt: number | null = null;
    let lastSuccessfulRecoveryAt: number | null = null;
    let nearestDeadline: SweeperStatus["nearestDeadline"] = { height: null, time: null };
    let oldestUnsweptLocktime: SweeperStatus["oldestUnsweptLocktime"] = {
        height: null,
        time: null,
    };
    let blockers: RecoveryDeadline[] = [];
    let deadlines: RecoveryDeadline[] = [];
    let stopped = false;
    const inFlight = new Map<string, Promise<void>>();
    const completed: SweepResult[] = [];
    const warned = new Map<string, string>();

    const threshold = (kind: "height" | "time", critical: boolean): bigint => {
        if (!deps.config) return 0n;
        if (kind === "height")
            return critical
                ? deps.config.recoveryCriticalBlocks
                : deps.config.recoveryBroadcastBlocks;
        return critical
            ? deps.config.recoveryCriticalSeconds
            : deps.config.recoveryBroadcastSeconds;
    };

    const deadline = (
        advance: Advance,
        height: bigint | null,
        time: bigint | null,
    ): RecoveryDeadline => {
        const recovery = advance.recoveryLocktime;
        const v2 = advance.covenantVersion === 2;
        // v2 stores no expiry, and races batch expiry alone: the remedy is
        // "renew", not "reclaim", so the clock is the coin's current one.
        const seen = v2 ? deps.observed?.(advance) : undefined;
        const expiry = advance.batchExpiry ?? seen?.expiry;
        if (
            !recovery ||
            (!v2 && recovery.kind !== (expiry?.kind ?? "time")) ||
            recovery.value !== advance.locktime
        )
            return {
                advanceId: advance.id,
                kind: expiry?.kind ?? "time",
                locktime: advance.locktime,
                batchExpiry: expiry?.value ?? null,
                remaining: -1n,
                severity: "expired",
                code: "recovery_locktime_invalid",
            };
        // `kind` stays the CLTV's domain, which decides eligibility; only on v2
        // can the expiry raced sit in the other one.
        const racing = expiry ?? recovery;
        const chainClock = racing.kind === "height" ? height : time;
        const at = {
            advanceId: advance.id,
            kind: recovery.kind,
            locktime: recovery.value,
            batchExpiry: expiry?.value ?? null,
        };
        if (chainClock === null)
            return {
                ...at,
                remaining: null,
                severity: "eligible",
                code: `chain_${racing.kind}_unavailable`,
            };
        const remaining = racing.value - chainClock;
        const severity =
            remaining <= 0n
                ? "expired"
                : remaining <= threshold(racing.kind, true)
                  ? "critical"
                  : remaining <= threshold(racing.kind, false)
                    ? "warning"
                    : "eligible";
        // Swept with the CLTV still locked: anyone may take the reclaim leaf and
        // nothing on-chain closes that window, so custody is the net from here.
        // Sweeping follows expiry, so this escalates and never downgrades.
        const cltvClock = recovery.kind === "height" ? height : time;
        const swept = seen?.swept === true && cltvClock !== null && recovery.value > cltvClock;
        // A renewal lands far outside the alarm window, so reaching it at all
        // means renewal is overdue; `renewals` says whether it ever ran.
        const renewal =
            (advance.renewals ?? 0) > 0 || advance.lastRenewedAt !== undefined
                ? "covenant_renewal_stopped"
                : "covenant_renewal_missing";
        return {
            ...at,
            remaining,
            severity: swept && severity !== "expired" ? "critical" : severity,
            code: swept
                ? "covenant_swept_before_deadline"
                : severity === "expired"
                  ? "covenant_unspent_at_expiry"
                  : severity === "critical"
                    ? v2
                        ? renewal
                        : "recovery_deadline_critical"
                    : severity === "warning"
                      ? v2
                          ? renewal
                          : "recovery_deadline_warning"
                      : "recovery_eligible",
        };
    };

    const compareDeadline = (a: RecoveryDeadline, b: RecoveryDeadline): number => {
        const severity = severityRank[a.severity] - severityRank[b.severity];
        if (severity) return severity;
        if (a.kind !== b.kind) return a.kind === "height" ? -1 : 1;
        return (
            compareBig(a.batchExpiry ?? a.locktime, b.batchExpiry ?? b.locktime) ||
            compareBig(a.locktime, b.locktime) ||
            a.advanceId.localeCompare(b.advanceId)
        );
    };

    const hasRecoveryFailure = (advance: Advance): boolean =>
        advance.recoveryPhase === "failed" ||
        (advance.recoveryPhase === "prepared" && advance.failureCode !== undefined);

    const deadlineWithFailure = (
        advance: Advance,
        height: bigint | null,
        time: bigint | null,
        fallbackCode = "recovery_quarantined",
    ): RecoveryDeadline => {
        const item = deadline(advance, height, time);
        return hasRecoveryFailure(advance) &&
            (advance.recoveryPhase === "failed" || item.remaining !== null) &&
            item.severity !== "expired" &&
            item.severity !== "critical"
            ? {
                  ...item,
                  severity: advance.recoveryPhase === "failed" ? "critical" : item.severity,
                  code: advance.failureCode ?? fallbackCode,
              }
            : item;
    };

    const pause = () => {
        if (deps.policy && !deps.policy.get().paused)
            deps.policy.update({ paused: true }, "recovery-deadline");
    };

    async function sweepOne(a: Advance): Promise<SweepResult | undefined> {
        try {
            const submitted = await deps.recovery.recover(a);
            if (!submitted) return undefined;
            const latest = deps.advances.get(a.id);
            if (latest?.state === "locked") {
                const claimed = deps.advances.claimRecovery(a.id, deps.now());
                if (claimed)
                    deps.advances.recordRecoverySubmission(
                        a.id,
                        submitted.txid,
                        submitted.submittedAt,
                    );
                const recorded = deps.advances.get(a.id);
                if (recorded?.state === "recovering" && !recorded.recoveryPhase)
                    deps.advances.update({ ...recorded, recoveryPhase: "submitted" });
            } else if (latest?.state === "recovered") {
                deps.advances.recordRecoverySubmission(a.id, submitted.txid, submitted.submittedAt);
            }
            lastSuccessfulRecoveryAt =
                lastSuccessfulRecoveryAt === null
                    ? submitted.submittedAt
                    : Math.max(lastSuccessfulRecoveryAt, submitted.submittedAt);
            return {
                id: a.id,
                ok: true,
                txid: submitted.txid,
                ...(submitted.alreadyKnown ? { alreadyKnown: true } : {}),
            };
        } catch (error) {
            const message = sanitizeOperationalError(error, "recovery failed");
            const errorCode =
                error instanceof RecoveryArtifactError
                    ? error.code
                    : "recovery_submission_ambiguous";
            deps.onError?.(a.id, new Error(message));
            return { id: a.id, ok: false, error: message, errorCode };
        }
    }

    return {
        async tick(currentHeight, medianTime = null) {
            // Sponsored direct sends settle at `locked` and have no recovery
            // leaf; the reconciler observes and releases them instead.
            const locked = deps.advances
                .byState("locked")
                .filter((advance) => advanceKind(advance) === "covenant");
            const recovering = deps.advances
                .byState("recovering")
                .filter((advance) => advanceKind(advance) === "covenant");
            lockedCount = locked.length;
            recoveringCount = recovering.length;
            // Unrolled, it can leave only on-chain through the exit leaf: nothing to recover.
            const active = [...locked, ...recovering].filter(
                (advance) => advance.failureCode !== "covenant_unrolled",
            );
            const byId = new Map(active.map((advance) => [advance.id, advance]));
            for (const advance of active) {
                if (!hasRecoveryFailure(advance)) continue;
                const at = advance.recoveryLastAttemptAt ?? advance.updatedAt;
                if (lastRecoveryError && lastRecoveryError.at > at) continue;
                lastRecoveryError = {
                    advanceId: advance.id,
                    code: advance.failureCode ?? "recovery_quarantined",
                    at,
                    message: sanitizeOperationalError(advance.failureDetail, "recovery failed"),
                };
            }
            deadlines = active.map((advance) =>
                deadlineWithFailure(advance, currentHeight, medianTime),
            );
            oldestUnsweptLocktime = active.reduce<SweeperStatus["oldestUnsweptLocktime"]>(
                (oldest, advance) => {
                    const recovery = advance.recoveryLocktime;
                    if (
                        !recovery ||
                        recovery.kind !== (advance.batchExpiry?.kind ?? "time") ||
                        recovery.value !== advance.locktime
                    )
                        return oldest;
                    const current = oldest[recovery.kind];
                    if (current === null || recovery.value < current)
                        oldest[recovery.kind] = recovery.value;
                    return oldest;
                },
                { height: null, time: null },
            );
            nearestDeadline = {
                height:
                    deadlines.filter((item) => item.kind === "height").sort(compareDeadline)[0] ??
                    null,
                time:
                    deadlines.filter((item) => item.kind === "time").sort(compareDeadline)[0] ??
                    null,
            };
            for (const id of warned.keys()) if (!byId.has(id)) warned.delete(id);
            for (const item of deadlines) {
                const renewal = item.code.startsWith("covenant_renewal_");
                if (renewal && warned.get(item.advanceId) !== item.code)
                    deps.onRenewalWarning?.({
                        delegation: byId.get(item.advanceId)!.covenantAddress,
                        deadline: item,
                    });
                if (renewal) warned.set(item.advanceId, item.code);
                else warned.delete(item.advanceId);
            }
            blockers = deadlines.filter(
                (item) =>
                    item.severity === "critical" ||
                    item.severity === "expired" ||
                    item.code.endsWith("_unavailable") ||
                    hasRecoveryFailure(byId.get(item.advanceId)!),
            );
            if (blockers.some((item) => ["critical", "expired"].includes(item.severity))) pause();
            const due = deadlines
                .filter((item) => {
                    const advance = byId.get(item.advanceId)!;
                    const chainClock = item.kind === "height" ? currentHeight : medianTime;
                    return (
                        chainClock !== null &&
                        item.locktime <= chainClock &&
                        (deps.canRecover?.(advance) ?? true) &&
                        advance.recoveryPhase !== "submitted" &&
                        advance.recoveryPhase !== "failed"
                    );
                })
                .sort(compareDeadline)
                .map((item) => byId.get(item.advanceId)!);

            const launched: Promise<void>[] = [];
            if (!stopped) {
                for (const advance of due) {
                    if (inFlight.has(advance.id)) continue;
                    const work = sweepOne(advance)
                        .then((result) => {
                            if (result) completed.push(result);
                        })
                        .finally(() => inFlight.delete(advance.id));
                    inFlight.set(advance.id, work);
                    launched.push(work);
                }
            }
            await Promise.race([
                Promise.allSettled(launched),
                new Promise<void>((resolve) => setTimeout(resolve, 0)),
            ]);
            const results = completed.splice(0);
            const recoverySubmitted = results.filter(
                (result) => result.ok && !result.alreadyKnown,
            ).length;
            const failures = results.filter((result) => !result.ok);
            recoverySubmittedTotal += recoverySubmitted;
            failedTotal += failures.length;
            if (failures.length) {
                const failure = failures[failures.length - 1]!;
                lastError = failure.error ?? null;
                lastRecoveryError = {
                    advanceId: failure.id,
                    code: failure.errorCode ?? "recovery_failed",
                    at: deps.now(),
                    message: failure.error ?? "recovery failed",
                };
                for (const failure of failures) {
                    const latest = deps.advances.get(failure.id);
                    if (!latest || !hasRecoveryFailure(latest)) continue;
                    const unresolved = deadlineWithFailure(
                        latest,
                        currentHeight,
                        medianTime,
                        failure.errorCode,
                    );
                    blockers = [
                        ...blockers.filter((item) => item.advanceId !== latest.id),
                        unresolved,
                    ].sort(compareDeadline);
                    if (["critical", "expired"].includes(unresolved.severity)) pause();
                }
            } else {
                lastError = null;
            }
            const observedRows = [
                ...active,
                ...(["recycled", "purchased", "refunded", "recovered"] as const).flatMap((state) =>
                    deps.advances.byState(state),
                ),
            ];
            const observedAt = observedRows.reduce<number | null>(
                (latest, advance) =>
                    advance.lastObservedAt === undefined
                        ? latest
                        : latest === null
                          ? advance.lastObservedAt
                          : Math.max(latest, advance.lastObservedAt),
                null,
            );
            if (observedAt !== null)
                lastSuccessfulObservationAt =
                    lastSuccessfulObservationAt === null
                        ? observedAt
                        : Math.max(lastSuccessfulObservationAt, observedAt);
            const recoveredAt = observedRows.reduce<number | null>(
                (latest, advance) =>
                    advance.recoverySubmittedAt === undefined
                        ? latest
                        : latest === null
                          ? advance.recoverySubmittedAt
                          : Math.max(latest, advance.recoverySubmittedAt),
                null,
            );
            if (recoveredAt !== null)
                lastSuccessfulRecoveryAt =
                    lastSuccessfulRecoveryAt === null
                        ? recoveredAt
                        : Math.max(lastSuccessfulRecoveryAt, recoveredAt);
            lastTickAt = deps.now();
            lastTickHeight = currentHeight;
            lastTickMedianTime = medianTime;
            return {
                at: lastTickAt,
                height: currentHeight,
                medianTime,
                considered: launched.length,
                recoverySubmitted,
                failed: failures.length,
                results,
            };
        },
        status: () => ({
            lastTickAt,
            lastTickHeight,
            lastTickMedianTime,
            recoverySubmittedTotal,
            failedTotal,
            lastError,
            lastRecoveryError,
            lockedCount,
            recoveringCount,
            lastSuccessfulObservationAt,
            lastSuccessfulRecoveryAt,
            nearestDeadline,
            oldestUnsweptLocktime,
            blockers,
            deadlines: [...deadlines],
        }),
        stop: () => {
            stopped = true;
            deps.recovery.stop?.();
        },
    };
}
