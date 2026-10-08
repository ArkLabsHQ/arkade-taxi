import type { Exposure } from "@arkade-taxi/core";

export interface ExposureSource {
    exposureTotals():
        | { outstandingSats: bigint; lockedCount: number }
        | { outstandingSats: bigint; activeCount: number };
}

/**
 * Capital at risk, over every flow that ties it up. Must total what
 * `totalExposure` in db totals: that statement is the authority, so counting
 * less here admits a quote the fence then refuses.
 */
export function totalExposure(
    ...sources: readonly (ExposureSource | undefined | null)[]
): Exposure {
    let outstandingSats = 0n;
    let lockedCount = 0;
    for (const source of sources) {
        if (!source) continue;
        const totals = source.exposureTotals();
        outstandingSats += totals.outstandingSats;
        lockedCount += "lockedCount" in totals ? totals.lockedCount : totals.activeCount;
    }
    return { outstandingSats, lockedCount, oldestUnsweptLocktime: null };
}
