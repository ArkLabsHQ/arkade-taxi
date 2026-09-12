import type { Advance, Exposure } from "./types.js";

const isLocked = (a: Advance) => a.state === "locked";

export function computeExposure(advances: readonly Advance[]): Exposure {
    let outstandingSats = 0n;
    let lockedCount = 0;
    let oldestUnsweptLocktime: bigint | null = null;
    const locktimeKinds = new Set<Advance["batchExpiry"]["kind"]>();

    for (const a of advances) {
        if (a.state !== "locking" && a.state !== "locked" && a.state !== "recovering") continue;
        outstandingSats += a.topup;
        lockedCount++;
        if (!isLocked(a)) continue;
        locktimeKinds.add(a.batchExpiry.kind);
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
            if (
                !isLocked(a) ||
                !recovery ||
                recovery.kind !== a.batchExpiry.kind ||
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
            if (x.batchExpiry.value !== y.batchExpiry.value)
                return x.batchExpiry.value < y.batchExpiry.value ? -1 : 1;
            if (x.locktime !== y.locktime) return x.locktime < y.locktime ? -1 : 1;
            return x.id < y.id ? -1 : x.id > y.id ? 1 : 0;
        });
}
