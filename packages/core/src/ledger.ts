import { TERMINAL_STATES, type Advance, type AdvanceState } from "./types.js";

/** Keyed by every AdvanceState so adding one to types.ts fails the build here
 * rather than silently arriving with no outbound edges. */
const EDGES: Record<AdvanceState, readonly AdvanceState[]> = {
    quoted: ["locking", "expired"],
    locking: ["locked", "quoted"],
    locked: ["recycled", "purchased", "refunded", "recovered"],
    recycled: [],
    purchased: [],
    refunded: [],
    recovered: [],
    expired: [],
};

export function canTransition(from: AdvanceState, to: AdvanceState): boolean {
    return (EDGES[from] ?? []).includes(to);
}

export function transition(a: Advance, to: AdvanceState, at: number): Advance {
    if (!canTransition(a.state, to)) {
        throw new Error(`ledger: illegal transition ${a.state} -> ${to}`);
    }
    return { ...a, state: to, updatedAt: at };
}

export function isTerminal(s: AdvanceState): boolean {
    return (TERMINAL_STATES as readonly AdvanceState[]).includes(s);
}

/** Only a `quoted` advance can expire; every other state is either settled or
 * already anchored to chain state that outlives the quote window. */
export function isExpired(a: Advance, now: number): boolean {
    return a.state === "quoted" && now >= a.expiresAt;
}
