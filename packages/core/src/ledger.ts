import { TERMINAL_STATES, type Advance, type AdvanceState } from "./types.js";

/** Keyed by every AdvanceState so adding one to types.ts fails the build here
 * rather than silently arriving with no outbound edges. */
const EDGES: Record<AdvanceState, readonly AdvanceState[]> = {
    quoted: ["locking", "expired"],
    locking: ["locked"],
    locked: ["recycled", "purchased", "refunded", "recovering"],
    recovering: ["recovered"],
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
    if (to === "locking") validateFundingSnapshot(a);
    return { ...a, state: to, updatedAt: at };
}

export function validateFundingSnapshot(a: Advance): void {
    const expiry = a.batchExpiry;
    const recovery = a.recoveryLocktime;
    if (
        !expiry ||
        !recovery ||
        typeof expiry.value !== "bigint" ||
        typeof recovery.value !== "bigint" ||
        recovery.value !== a.locktime ||
        recovery.kind !== expiry.kind ||
        expiry.value <= recovery.value ||
        (expiry.kind !== "height" && expiry.kind !== "time") ||
        (recovery.kind === "height" && recovery.value >= 500_000_000n) ||
        (recovery.kind === "time" && recovery.value < 500_000_000n)
    ) {
        throw new Error(
            `advance ${a.id}: tagged recovery locktime must match and be strictly before batch expiry`,
        );
    }
    if (
        typeof a.unsignedLockupTx !== "string" ||
        a.unsignedLockupTx.length === 0 ||
        typeof a.unsignedLockupId !== "string" ||
        a.unsignedLockupId.length === 0 ||
        !Array.isArray(a.operatorInputs) ||
        a.operatorInputs.length === 0
    ) {
        throw new Error(`advance ${a.id}: missing funding snapshot`);
    }
    for (const input of a.operatorInputs) {
        if (
            !input ||
            typeof input.txid !== "string" ||
            !/^[0-9a-f]{64}$/.test(input.txid) ||
            !Number.isInteger(input.vout) ||
            input.vout < 0 ||
            input.vout > 0xffff_ffff
        ) {
            throw new Error(`advance ${a.id}: invalid operator input`);
        }
    }
}

export function isTerminal(s: AdvanceState): boolean {
    return (TERMINAL_STATES as readonly AdvanceState[]).includes(s);
}

/** Only a `quoted` advance can expire; every other state is either settled or
 * already anchored to chain state that outlives the quote window. */
export function isExpired(a: Advance, now: number): boolean {
    return a.state === "quoted" && now >= a.expiresAt;
}
