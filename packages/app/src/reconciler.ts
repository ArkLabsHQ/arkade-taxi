import type { Advance, Outpoint } from "@arkade-taxi/core";
import type { AdvanceRepository, PolicyRepository, ReservationRepository } from "@arkade-taxi/db";
import {
    Transaction,
    canSpendOffchain,
    type IndexerProvider,
    type VirtualCoin,
} from "@arkade-os/sdk";
import { base64, hex } from "@scure/base";
import { decodeLockupEnvelope } from "./arkade/psbt.js";
import type { SubmissionResumer } from "./arkade/submit.js";
import type { SpendWatcher, WatcherBlocker } from "./watcher.js";

export interface ReconcilerStatus {
    lastTickAt: number | null;
    locking: number;
    blockers: string[];
    lastWatcherScanAt?: number | null;
    watching?: number;
    blockerDetails?: WatcherBlocker[];
}

export interface LockupReconciler {
    tick(): Promise<void>;
    status(): ReconcilerStatus;
}

export interface LockupReconcilerDeps {
    advances: Pick<AdvanceRepository, "byState" | "recordLockupObserved">;
    reservations: Pick<ReservationRepository, "recordLockupConflict">;
    policy: Pick<PolicyRepository, "get">;
    indexer: Pick<IndexerProvider, "getVtxos">;
    submission: Pick<SubmissionResumer, "resume">;
    watcher?: Pick<SpendWatcher, "catchUp" | "status">;
    now(): number;
    clock(): { height: number; timestamp: Date };
}

const key = ({ txid, vout }: Outpoint): string => `${txid}:${vout}`;

function expectedLockup(advance: Advance): { outpoint: Outpoint; script: string } {
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
    let pending: Promise<void> | undefined;

    const reconcile = async (advance: Advance): Promise<void> => {
        let expected: ReturnType<typeof expectedLockup>;
        try {
            await deps.submission.resume(advance.id);
            expected = expectedLockup(advance);
            const response = await deps.indexer.getVtxos({ outpoints: [expected.outpoint] });
            const coin = exactCoin(response, expected.outpoint);
            if (coin) {
                if (
                    coin.script === expected.script &&
                    canSpendOffchain(coin, deps.clock()) &&
                    !coin.isSpent &&
                    !coin.spentBy
                )
                    deps.advances.recordLockupObserved(advance.id, expected.outpoint, deps.now());
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

    return {
        tick() {
            if (!pending)
                pending = (async () => {
                    const rows = deps.advances.byState("locking");
                    for (const advance of rows) await reconcile(advance);
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
            return {
                lastTickAt,
                locking,
                blockers: [...new Set([...blockers, ...blockerDetails.map(({ code }) => code)])],
                ...(watcher
                    ? {
                          lastWatcherScanAt: watcher.lastScanAt,
                          watching: watcher.watching,
                          blockerDetails: blockerDetails.map((blocker) => ({ ...blocker })),
                      }
                    : {}),
            };
        },
    };
}
