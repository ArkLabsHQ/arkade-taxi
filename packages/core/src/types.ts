import type { AssetIdRef } from "@arkade-taxi/covenant";
import type { AssetRule, ClaimMode, FareSpec } from "./fares.js";

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

    /**
     * Charged at lockup as a separate output: the covenant pins the operator's
     * repayment to exactly `topup`, so no fare is expressible inside it.
     *
     * Not necessarily sats. The sender this service exists for holds an asset
     * and no spare bitcoin, so a sats-only fare would demand the very thing the
     * covenant removes the need for.
     */
    fare: FareSpec;

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
    maxOutstandingSats: bigint;
    maxPerPaymentTopupSats: bigint;
    maxConcurrentAdvances: number;
    /** Blocks of headroom required between `locktime` and the covenant VTXO's
     * expiry. The covenant cannot be renewed by the operator alone — renewing
     * means spending it, which means satisfying a leaf — so recovery must fire
     * first. UNVERIFIED against arkd; kept configurable for that reason. */
    locktimeMarginBlocks: number;
    /**
     * What this operator serves, and on what terms, per asset. An entry with
     * `assetId: null` is the plain sub-dust bitcoin case.
     *
     * One table rather than an allowlist plus a bitcoin flag: those were two
     * mechanisms answering the same question, and folding bitcoin into an
     * ASSET allowlist made enabling the allowlist silently stop quoting it.
     */
    assetRules: AssetRule[];
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
    /** Units of the asset being moved; priced against by a proportional fare. */
    assetUnits?: bigint;
    /** Which of the rule's offered fares the client accepts. Omitted takes the first. */
    fareId?: string;
}

export type AdmissionDecision =
    { ok: true; topup: bigint; fare: FareSpec; claim: ClaimMode } | { ok: false; reason: string };
