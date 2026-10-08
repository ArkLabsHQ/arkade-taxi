import { advanceKind, type Advance, type Outpoint } from "@arkade-taxi/core";
import type {
    AdvanceRepository,
    CustodyLiabilities,
    CustodyRepository,
    PolicyRepository,
    ReservationRepository,
} from "@arkade-taxi/db";
import {
    Transaction,
    canSpendOffchain,
    type IndexerProvider,
    type VirtualCoin,
} from "@arkade-os/sdk";
import type { AssetIdRef } from "@arkade-taxi/covenant";
import type { CustodySolvency } from "@arkade-taxi/core";
import { base64, hex } from "@scure/base";
import { decodeLockupEnvelope } from "./arkade/psbt.js";
import { readFundingSource } from "./arkade/fundingSource.js";
import type { SubmissionResumer } from "./arkade/submit.js";
import type { SpendWatcher, WatcherBlocker } from "./watcher.js";
import { sanitizeOperationalError } from "./errors.js";

/** The pass's whole solvency view, not a summary of it: the lending gate reads
 * the same object the operator surface shows. Never a blocker — negative
 * coverage means lending dipped into what is owed, which the operator chose. */
export interface CustodyCoverage extends CustodySolvency {
    rows: number;
    /** The oldest release waiting on liquidity, if any. */
    oldestWaiting?: { advanceId: string; since: number };
}

export interface ReconcilerStatus {
    lastTickAt: number | null;
    locking: number;
    blockers: string[];
    lastWatcherScanAt?: number | null;
    watching?: number;
    activelyScanned?: number;
    blockerDetails?: WatcherBlocker[];
    warnings?: WatcherBlocker[];
    custody?: CustodyCoverage;
}

export interface LockupReconciler {
    tick(fresh?: boolean): Promise<void>;
    status(): ReconcilerStatus;
}

export interface CustodyReconcilerDeps {
    repo: Pick<CustodyRepository, "listActive" | "liabilities" | "nearingWindow">;
    /** The solvency view for this pass, taken against one chain tip. */
    solvency(liabilities: CustodyLiabilities): Promise<CustodySolvency>;
    /** Releases currently waiting on liquidity. */
    waiting(): readonly { advanceId: string; since: number }[];
    /** How close to the end of its window a row is before it raises an alarm. */
    alarmSeconds: number;
}

export interface LockupReconcilerDeps {
    advances: Pick<AdvanceRepository, "byState" | "recordLockupObserved" | "sponsoredLocked">;
    reservations: Pick<
        ReservationRepository,
        "recordLockupConflict" | "releaseForAdvance" | "listForAdvance"
    >;
    policy: Pick<PolicyRepository, "get">;
    indexer: Pick<IndexerProvider, "getVtxos">;
    submission: Pick<SubmissionResumer, "resume">;
    watcher?: Pick<SpendWatcher, "catchUp" | "status">;
    custody?: CustodyReconcilerDeps;
    now(): number;
    clock(): { height: number; timestamp: Date };
}

const key = ({ txid, vout }: Outpoint): string => `${txid}:${vout}`;

function expectedLockup(advance: Advance): { outpoint: Outpoint; script: string } {
    const tagged = readFundingSource(advance.unsignedLockupTx);
    if (tagged.kind === "joint-fill") {
        if (tagged.source.graph.graphId !== advance.unsignedLockupId)
            throw new Error(`advance ${advance.id}: persisted lockup commitment mismatch`);
        const tx = Transaction.fromPSBT(base64.decode(tagged.source.graph.arkTx));
        const output = tx.getOutput(tagged.covenantOutpoint.vout);
        if (!output.script)
            throw new Error(`advance ${advance.id}: covenant output script missing`);
        return { outpoint: tagged.covenantOutpoint, script: hex.encode(output.script) };
    }
    const envelope = decodeLockupEnvelope(advance.unsignedLockupTx);
    if (envelope.unsignedTxId !== advance.unsignedLockupId || envelope.covenantOutputIndex !== 0)
        throw new Error(`advance ${advance.id}: persisted lockup commitment mismatch`);
    const tx = Transaction.fromPSBT(base64.decode(envelope.arkTx));
    const output = tx.getOutput(envelope.covenantOutputIndex);
    if (!output.script) throw new Error(`advance ${advance.id}: covenant output script missing`);
    return {
        outpoint: { txid: tx.id, vout: envelope.covenantOutputIndex },
        script: hex.encode(output.script),
    };
}

function exactCoin(
    response: { vtxos: VirtualCoin[] },
    outpoint: Outpoint,
): VirtualCoin | undefined {
    if (!Array.isArray(response.vtxos) || response.vtxos.length > 1) return undefined;
    const coin = response.vtxos[0];
    if (!coin) return undefined;
    if (coin.txid !== outpoint.txid || coin.vout !== outpoint.vout) return undefined;
    return coin;
}

const safeTxid = (value: string | undefined): value is string =>
    typeof value === "string" && /^[0-9a-f]{64}$/.test(value);

/**
 * Custody holds no coin of its own, so there is nothing to re-bind: the pass
 * reports coverage and raises the operator's alarms. One solvency view per
 * tick, so two readers never disagree about "now".
 */
async function reconcileCustody(deps: LockupReconcilerDeps): Promise<{
    alarms: WatcherBlocker[];
    coverage?: CustodyCoverage;
}> {
    const custody = deps.custody;
    if (!custody) return { alarms: [] };
    const alarms: WatcherBlocker[] = [];
    for (const row of custody.repo.nearingWindow(deps.now(), custody.alarmSeconds))
        alarms.push({
            advanceId: row.advanceId,
            code: "custody_window_ending",
            detail: `custody window ends at ${row.expiresAt}; a release is honoured past it`,
        });
    const liabilities = custody.repo.liabilities();
    // Nothing owed means nothing to dip into: no inventory read, and no lending gate.
    if (liabilities.rows === 0) return { alarms };
    const solvency = await custody.solvency(liabilities);
    if (solvency.shortfall)
        alarms.push({
            code: "custody_shortfall",
            detail:
                `owed ${solvency.owedSats} sats against ${solvency.lendableSats} lendable and ` +
                `${solvency.receivableSats} receivable; ${solvency.shortAssets.length} asset(s) short`,
        });
    else if (solvency.coverageSats < 0n)
        alarms.push({
            code: "custody_funds_lent",
            detail: `custody coverage is ${solvency.coverageSats} sats`,
        });
    const waiting = [...custody.waiting()].sort((a, b) => a.since - b.since);
    const oldest = waiting[0];
    if (oldest)
        alarms.push({
            advanceId: oldest.advanceId,
            code: "custody_release_awaiting_liquidity",
            detail: `${waiting.length} release(s) waiting, the oldest since ${oldest.since}`,
        });
    return {
        alarms,
        coverage: {
            ...solvency,
            rows: liabilities.rows,
            ...(oldest ? { oldestWaiting: oldest } : {}),
        },
    };
}

export function createLockupReconciler(deps: LockupReconcilerDeps): LockupReconciler {
    const blockingCodes = (rows: Advance[]): string[] => [
        ...new Set(
            rows
                .filter(
                    (advance) =>
                        advance.failureCode === "reserved_input_conflict" ||
                        advance.submissionPhase === "failed" ||
                        advance.submissionPhase === "legacy",
                )
                .map((advance) => advance.failureCode)
                .filter((code): code is string => !!code),
        ),
    ];
    let lastTickAt: number | null = null;
    const initial = deps.advances.byState("locking");
    let locking = initial.length;
    let blockers = blockingCodes(initial);
    let releaseBlockers: WatcherBlocker[] = [];
    let custodyAlarms: WatcherBlocker[] = [];
    let custodyCoverage: CustodyCoverage | undefined;
    let pending: Promise<void> | undefined;

    const reconcile = async (advance: Advance): Promise<void> => {
        let expected: ReturnType<typeof expectedLockup>;
        // A sponsored advance settles when its payment outpoint is observed:
        // exact txid plus exact payment script proves the joint transaction
        // was accepted, even if the receiver already spent onwards.
        const sponsored = advanceKind(advance) === "sponsored";
        const settleSponsored = (): void => {
            deps.advances.recordLockupObserved(advance.id, expected.outpoint, deps.now());
            deps.reservations.releaseForAdvance(advance.id);
        };
        try {
            if (readFundingSource(advance.unsignedLockupTx).kind === "legacy")
                await deps.submission.resume(advance.id);
            expected = expectedLockup(advance);
            const response = await deps.indexer.getVtxos({ outpoints: [expected.outpoint] });
            const coin = exactCoin(response, expected.outpoint);
            if (coin) {
                if (
                    coin.script === expected.script &&
                    (sponsored ||
                        (canSpendOffchain(coin, deps.clock()) && !coin.isSpent && !coin.spentBy))
                ) {
                    if (sponsored) settleSponsored();
                    else
                        deps.advances.recordLockupObserved(
                            advance.id,
                            expected.outpoint,
                            deps.now(),
                        );
                }
                return;
            }
            if (response.vtxos.length !== 0) return;
            const inputs = await deps.indexer.getVtxos({ outpoints: advance.operatorInputs });
            const requested = new Set(advance.operatorInputs.map(key));
            if (
                !Array.isArray(inputs.vtxos) ||
                new Set(inputs.vtxos.map((input) => key(input))).size !== inputs.vtxos.length ||
                inputs.vtxos.some((input) => !requested.has(key(input)))
            )
                return;
            if (
                sponsored &&
                inputs.vtxos.length === requested.size &&
                inputs.vtxos.every(
                    (input) =>
                        (input.isSpent || !!input.spentBy) &&
                        safeTxid(input.arkTxId) &&
                        input.arkTxId === expected.outpoint.txid,
                )
            ) {
                settleSponsored();
                return;
            }
            const conflict = inputs.vtxos.find(
                (input) =>
                    (input.isSpent || !!input.spentBy) &&
                    safeTxid(input.arkTxId) &&
                    input.arkTxId !== expected.outpoint.txid,
            );
            if (!conflict) return;
            const spender = safeTxid(conflict.arkTxId) ? conflict.arkTxId : conflict.spentBy!;
            deps.reservations.recordLockupConflict(
                advance.id,
                `reserved input ${key(conflict)} was spent by conflicting Arkade transaction ${spender}`,
                deps.now(),
            );
        } catch {
            return;
        }
    };

    const reconciler: LockupReconciler = {
        tick(fresh = false) {
            if (fresh && pending) return pending.then(() => reconciler.tick());
            if (!pending)
                pending = (async () => {
                    const rows = deps.advances.byState("locking");
                    for (const advance of rows) await reconcile(advance);
                    // A crash between observation and release strands a
                    // delivered sponsored row with held reservations; both
                    // writes are local and the release is idempotent, so
                    // re-release settled rows every tick until clean. A row
                    // that keeps failing surfaces as a blocker with its id.
                    releaseBlockers = [];
                    for (const row of deps.advances.sponsoredLocked()) {
                        if (!row.outpoint) continue;
                        try {
                            if (deps.reservations.listForAdvance(row.id).length === 0) continue;
                            deps.reservations.releaseForAdvance(row.id);
                        } catch (cause) {
                            releaseBlockers.push({
                                advanceId: row.id,
                                code: "sponsored_release_failed",
                                detail: sanitizeOperationalError(
                                    cause,
                                    "sponsored reservation release failed",
                                ),
                            });
                        }
                    }
                    try {
                        const pass = await reconcileCustody(deps);
                        custodyAlarms = pass.alarms;
                        custodyCoverage = pass.coverage;
                    } catch (cause) {
                        custodyAlarms = [
                            {
                                code: "custody_reconcile_failed",
                                detail: sanitizeOperationalError(cause, "custody reconcile failed"),
                            },
                        ];
                    }
                    await deps.watcher?.catchUp();
                    const remaining = deps.advances.byState("locking");
                    locking = remaining.length;
                    blockers = blockingCodes(remaining);
                    lastTickAt = deps.now();
                })().finally(() => {
                    pending = undefined;
                });
            return pending;
        },
        status: () => {
            const watcher = deps.watcher?.status();
            const blockerDetails = watcher?.blockers ?? [];
            const details = [
                ...blockerDetails.map((blocker) => ({ ...blocker })),
                ...releaseBlockers.map((blocker) => ({ ...blocker })),
            ];
            // Warnings, not blockers: a window ending must not pause the Taxi.
            const warnings = custodyAlarms.length
                ? [...(watcher?.warnings ?? []), ...custodyAlarms.map((alarm) => ({ ...alarm }))]
                : watcher?.warnings;
            return {
                lastTickAt,
                locking,
                blockers: [...new Set([...blockers, ...details.map(({ code }) => code)])],
                ...(watcher
                    ? {
                          lastWatcherScanAt: watcher.lastScanAt,
                          watching: watcher.watching,
                          activelyScanned: watcher.activelyScanned,
                          blockerDetails: details,
                          warnings,
                      }
                    : releaseBlockers.length
                      ? { blockerDetails: details }
                      : {}),
                ...(!watcher && warnings?.length ? { warnings } : {}),
                ...(custodyCoverage ? { custody: custodyCoverage } : {}),
            };
        },
    };
    return reconciler;
}
