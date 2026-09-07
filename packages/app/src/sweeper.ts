import { sweepable, transition, type Advance } from "@arkade-taxi/core";
import type { AdvanceStore } from "./quotes.js";

/**
 * Running the permissionless recovery leaf needs a live arkd and emulator, so
 * the runner is a seam. NO REAL IMPLEMENTATION EXISTS YET — it is pending a
 * live stack. The scheduling, ordering and failure isolation around it do not
 * need one, which is the whole reason they live above this interface.
 */
export interface RecoveryRunner {
    recover(a: Advance): Promise<{ txid: string }>;
}

export interface SweeperDeps {
    advances: AdvanceStore;
    recovery: RecoveryRunner;
    /** Unix SECONDS. */
    now(): number;
    onError?: (advanceId: string, error: unknown) => void;
}

export interface SweepResult {
    id: string;
    ok: boolean;
    txid?: string;
    error?: string;
}

export interface TickResult {
    at: number;
    height: bigint;
    considered: number;
    recovered: number;
    failed: number;
    results: SweepResult[];
}

export interface SweeperStatus {
    /** Last tick that completed, whether or not every advance in it succeeded.
     * `null` until the first one. The container healthcheck reads this. */
    lastTickAt: number | null;
    lastTickHeight: bigint | null;
    recoveredTotal: number;
    failedTotal: number;
    /** Most recent per-advance failure, cleared by a tick in which none failed.
     * Recovery is the only thing bounding exposure, so this is surfaced rather
     * than buried in the log. */
    lastError: string | null;
}

export interface Sweeper {
    tick(currentHeight: bigint): Promise<TickResult>;
    status(): SweeperStatus;
}

const messageOf = (e: unknown): string => (e instanceof Error ? e.message : String(e));

export function createSweeper(deps: SweeperDeps): Sweeper {
    let lastTickAt: number | null = null;
    let lastTickHeight: bigint | null = null;
    let recoveredTotal = 0;
    let failedTotal = 0;
    let lastError: string | null = null;

    /**
     * Isolation is per advance and covers the write as well as the recovery: a
     * partially-swept batch is fine (a still-locked advance is retried next
     * tick) but a half-swept one that aborted the loop would leave older, more
     * urgent advances unrecovered behind a newer failing one.
     */
    async function sweepOne(a: Advance): Promise<SweepResult> {
        try {
            const { txid } = await deps.recovery.recover(a);
            deps.advances.update({
                ...transition(a, "recovered", deps.now()),
                spentTxid: txid,
            });
            return { id: a.id, ok: true, txid };
        } catch (e) {
            deps.onError?.(a.id, e);
            return { id: a.id, ok: false, error: messageOf(e) };
        }
    }

    return {
        async tick(currentHeight: bigint): Promise<TickResult> {
            // Outside the isolation: a listing failure is the sweeper down, not
            // one advance failing, and must not read as a healthy tick.
            const due = sweepable(deps.advances.byState("locked"), currentHeight);

            const results: SweepResult[] = [];
            for (const a of due) results.push(await sweepOne(a));

            const recovered = results.filter((r) => r.ok).length;
            const failed = results.length - recovered;
            recoveredTotal += recovered;
            failedTotal += failed;
            const failures = results.filter((r) => !r.ok);
            lastError =
                failures.length === 0 ? null : (failures[failures.length - 1]!.error ?? null);

            lastTickAt = deps.now();
            lastTickHeight = currentHeight;

            return {
                at: lastTickAt,
                height: currentHeight,
                considered: due.length,
                recovered,
                failed,
                results,
            };
        },

        status: () => ({ lastTickAt, lastTickHeight, recoveredTotal, failedTotal, lastError }),
    };
}
