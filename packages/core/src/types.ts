import type { AssetIdRef } from "@arkade-taxi/covenant";

/**
 * Transitions are driven by observed chain state, never by optimism: `locked`
 * on seeing the covenant outpoint spendable, terminal states on seeing the
 * spend. `expired` is the only state reached without a chain event.
 */
export type AdvanceState =
    | "quoted"
    | "locking"
    | "locked"
    | "recycled"
    | "purchased"
    | "refunded"
    | "recovered"
    | "expired";

export const TERMINAL_STATES = [
    "recycled",
    "purchased",
    "refunded",
    "recovered",
    "expired",
] as const satisfies readonly AdvanceState[];

export type Outpoint = { txid: string; vout: number };

/** One fronted dust unit, from quote to settlement. */
export interface Advance {
    id: string;
    state: AdvanceState;

    receiverKey: Uint8Array;
    senderKey: Uint8Array;
    operatorKey: Uint8Array;
    dust: bigint;
    topup: bigint;
    assetId?: AssetIdRef;
    locktime: bigint;

    /** Derived from the params; the client verifies against its own derivation. */
    covenantAddress: string;

    /** Charged at lockup as a separate output: the covenant pins the operator's
     * repayment to exactly `topup`, so no fee is expressible inside it. */
    feeSats: bigint;

    outpoint?: Outpoint;
    spentTxid?: string;

    createdAt: number;
    updatedAt: number;
    /** Quote validity. Past this, an untaken quote becomes `expired`. */
    expiresAt: number;
}

/** Live-reconfigurable operator policy. Persisted; UI edits are audited. */
export interface Policy {
    paused: boolean;
    feeFlatSats: bigint;
    feeBps: number;
    maxOutstandingSats: bigint;
    maxPerPaymentTopupSats: bigint;
    maxConcurrentAdvances: number;
    /** Blocks of headroom required between `locktime` and the covenant VTXO's
     * expiry. The covenant cannot be renewed by the operator alone — renewing
     * means spending it, which means satisfying a leaf — so recovery must fire
     * first. UNVERIFIED against arkd; kept configurable for that reason. */
    locktimeMarginBlocks: number;
    /** null means every asset is accepted. Governs assets only — see allowBitcoin. */
    assetAllowlist: string[] | null;
    /**
     * Whether plain sub-dust bitcoin transfers are quoted, independent of the
     * asset allowlist. Separate because a field named `assetAllowlist` silently
     * disabling bitcoin is a coupling nobody would predict, and sub-dust bitcoin
     * is a first-class case rather than an asset with no id.
     */
    allowBitcoin: boolean;
    quoteTtlSeconds: number;
}

/** What the operator currently has at risk. Locked capital, not expected loss:
 * every advance is recoverable at its locktime. */
export interface Exposure {
    outstandingSats: bigint;
    lockedCount: number;
    oldestUnsweptLocktime: bigint | null;
}

export interface QuoteRequest {
    receiverKey: Uint8Array;
    senderKey: Uint8Array;
    assetId?: AssetIdRef;
    /** Sats the sender contributes toward the dust unit; 0 for a pure-asset
     * payment, where the operator funds the whole thing. */
    senderSats: bigint;
}

export type AdmissionDecision =
    { ok: true; topup: bigint; feeSats: bigint } | { ok: false; reason: string };
