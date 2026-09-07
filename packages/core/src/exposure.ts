import type { Advance, Exposure } from "./types.js";

const isLocked = (a: Advance) => a.state === "locked";

export function computeExposure(advances: readonly Advance[]): Exposure {
    let outstandingSats = 0n;
    let lockedCount = 0;
    let oldestUnsweptLocktime: bigint | null = null;

    for (const a of advances) {
        if (!isLocked(a)) continue;
        outstandingSats += a.topup;
        lockedCount++;
        if (oldestUnsweptLocktime === null || a.locktime < oldestUnsweptLocktime) {
            oldestUnsweptLocktime = a.locktime;
        }
    }

    return { outstandingSats, lockedCount, oldestUnsweptLocktime };
}

export function sweepable(advances: readonly Advance[], currentHeight: bigint): Advance[] {
    return (
        advances
            .filter((a) => isLocked(a) && a.locktime <= currentHeight)
            // `x - y` would hand Array.sort a bigint, which coerces to NaN and
            // silently leaves the list in input order.
            .sort((x, y) => (x.locktime < y.locktime ? -1 : x.locktime > y.locktime ? 1 : 0))
    );
}
