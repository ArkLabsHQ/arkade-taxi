import { isExposed } from "./ledger.js";
import type { Advance, Exposure, ExpiryDeadline } from "./types.js";

const isLocked = (a: Advance) => a.state === "locked";

export function computeExposure(advances: readonly Advance[]): Exposure {
    let outstandingSats = 0n;
    let lockedCount = 0;
    let oldestUnsweptLocktime: bigint | null = null;
    const locktimeKinds = new Set<ExpiryDeadline["kind"]>();

    for (const a of advances) {
        if (!isExposed(a)) continue;
        outstandingSats += a.topup;
        lockedCount++;
        if (!isLocked(a)) continue;
        // A covenant advance has no batch expiry; its deadline carries the domain.
        locktimeKinds.add(a.batchExpiry?.kind ?? a.recoveryLocktime?.kind ?? "time");
        if (locktimeKinds.size > 1) {
            oldestUnsweptLocktime = null;
            continue;
        }
        if (oldestUnsweptLocktime === null || a.locktime < oldestUnsweptLocktime) {
            oldestUnsweptLocktime = a.locktime;
        }
    }

    return { outstandingSats, lockedCount, oldestUnsweptLocktime };
}

export function sweepable(
    advances: readonly Advance[],
    currentHeight: bigint,
    medianTime?: bigint,
): Advance[] {
    return advances
        .filter((a) => {
            const recovery = a.recoveryLocktime;
            // The deadline outlives the funding coins, so it is not held to
            // their domain; without this nothing ever sweeps.
            if (
                !isLocked(a) ||
                !recovery ||
                (a.batchExpiry !== undefined && recovery.kind !== a.batchExpiry.kind) ||
                (a.batchExpiry === undefined && recovery.kind !== "time") ||
                recovery.value !== a.locktime
            )
                return false;
            const clock = recovery.kind === "height" ? currentHeight : medianTime;
            return clock !== undefined && recovery.value <= clock;
        })
        .sort((x, y) => {
            const kind =
                x.recoveryLocktime!.kind === y.recoveryLocktime!.kind
                    ? 0
                    : x.recoveryLocktime!.kind === "height"
                      ? -1
                      : 1;
            if (kind) return kind;
            const xe = x.batchExpiry?.value ?? x.locktime;
            const ye = y.batchExpiry?.value ?? y.locktime;
            if (xe !== ye) return xe < ye ? -1 : 1;
            if (x.locktime !== y.locktime) return x.locktime < y.locktime ? -1 : 1;
            return x.id < y.id ? -1 : x.id > y.id ? 1 : 0;
        });
}
