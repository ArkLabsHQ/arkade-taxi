import type { Outpoint } from "@arkade-taxi/core";

export interface ReservedOutpointSource {
    listReservedOutpoints(): readonly Outpoint[];
}

export function unionReservedOutpoints(
    ...sources: readonly (ReservedOutpointSource | undefined | null)[]
): Outpoint[] {
    const seen = new Set<string>();
    const out: Outpoint[] = [];
    for (const source of sources) {
        if (!source) continue;
        for (const { txid, vout } of source.listReservedOutpoints()) {
            const key = `${txid}:${vout}`;
            if (seen.has(key)) continue;
            seen.add(key);
            out.push({ txid, vout });
        }
    }
    out.sort((a, b) => (a.txid < b.txid ? -1 : a.txid > b.txid ? 1 : a.vout - b.vout));
    return out;
}
