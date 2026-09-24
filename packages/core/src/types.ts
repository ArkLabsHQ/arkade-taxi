import type { AssetIdRef, ReceiverFare } from "@arkade-taxi/covenant";
import type { AssetRule, ClaimMode, FareSpec, ResolvedClaimMode } from "./fares.js";

/**
 * Transitions are driven by observed chain state, never by optimism: `locked`
 * on seeing the covenant outpoint spendable, terminal states on seeing the
 * spend. `expired` is the only state reached without a chain event.
 */
export type AdvanceState =
    | "quoted"
    | "locking"
    | "locked"
    | "recovering"
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
export type ExpiryDeadline = { kind: "height"; value: bigint } | { kind: "time"; value: bigint };

export interface FundingSnapshot {
    batchExpiry: ExpiryDeadline;
    recoveryLocktime?: ExpiryDeadline;
    operatorInputs: Outpoint[];
    unsignedLockupTx: string;
    unsignedLockupId: string;
}

export interface SubmissionState {
    submissionKey?: string;
    signedEnvelopeDigest?: string;
    submissionPhase?: "claimed" | "prepared" | "responded" | "finalized" | "failed" | "legacy";
    signedLockupEnvelope?: string;
    preparedArkTx?: string;
    preparedCheckpoints?: string[];
    serverFinalArkTx?: string;
    serverCheckpoints?: string[];
    submissionLeaseOwner?: string;
    submissionLeaseToken?: string;
    submissionLeaseUntil?: number;
    submissionAttempts?: number;
    submissionLastAttemptAt?: number;
    submissionNextAttemptAt?: number;
    finalizedAt?: number;
    arkTxid?: string;
    submittedAt?: number;
    recoveryTxid?: string;
    recoverySubmittedAt?: number;
    recoveryPhase?: "prepared" | "submitted" | "failed" | "legacy";
    recoveryGraphDigest?: string;
    recoveryExpectedTxid?: string;
    recoveryPreparedArkTx?: string;
    recoveryPreparedCheckpoints?: string[];
    recoveryResponseArkTx?: string;
    recoveryResponseCheckpoints?: string[];
    recoveryLeaseOwner?: string;
    recoveryLeaseToken?: string;
    recoveryLeaseUntil?: number;
    recoveryAttempts?: number;
    recoveryLastAttemptAt?: number;
    recoveryNextAttemptAt?: number;
    lastObservedAt?: number;
    observationTipHash?: string;
    observationTipHeight?: number;
    observationStableTipHash?: string;
    observationStableTipHeight?: number;
    observationStableCount?: number;
    failureCode?: string;
    failureDetail?: string;
}

/** One fronted dust unit, from quote to settlement. */
export interface Advance extends FundingSnapshot, SubmissionState {
    id: string;
    state: AdvanceState;

    /**
     * `covenant` is the joint-funded covenant VTXO the receiver claims with
     * `recycle` or `purchase`. `sponsored` is a joint-funded direct payment:
     * the operator fronts the dust carrier of an output paying the receiver's
     * own address, so no claim, recovery or refund leaf exists. A sponsored
     * advance reaches `locked` when its payment outpoint is observed and never
     * leaves it. Optional so persisted and in-memory covenant advances keep
     * their shape; absent means `covenant`.
     */
    kind?: "covenant" | "sponsored";

    receiverKey: Uint8Array;
    senderKey: Uint8Array;
    operatorKey: Uint8Array;
    dust: bigint;
    topup: bigint;
    assetId?: AssetIdRef;
    assetUnits?: bigint;
    recoveryRecipient?: "sender" | "receiver";
    /** Leaf this covenant committed to; absent is the legacy four-leaf tree. */
    claimMode?: "recycle" | "purchase";
    /** Legacy scalar retained for the covenant parameter. Scheduling uses recoveryLocktime.
     * Sponsored advances carry no locktime; the persisted value is a domain
     * sentinel satisfying the batch-expiry CHECK (0n for height expiries,
     * 500000000n for time expiries). */
    locktime: bigint;

    /** Derived from the params; the client verifies against its own derivation.
     * A sponsored advance stores the receiver's own Arkade address here: the
     * payment output pays it directly instead of a covenant. */
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

    /** What the receiver owes at claim, charged out of the covenant itself.
     * Persisted because the claim feed and every recovery rebuild read the
     * advance, and the fare is part of the covenant address. */
    receiverFare?: ReceiverFare;

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
    locktimeMarginSeconds: number;
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
    /** Leaf the sender authorises; omitted resolves against the rule. */
    claimMode?: Exclude<ClaimMode, "either">;
    /** Sats the sender contributes toward the dust unit; 0 for a pure-asset
     * payment, where the operator funds the whole thing. */
    senderSats: bigint;
    /** Units of the asset being moved; priced against by a proportional fare. */
    assetUnits?: bigint;
    /** Which of the rule's offered fares the client accepts. Omitted takes the first. */
    fareId?: string;
}

export type AdmissionDecision =
    | { ok: true; topup: bigint; fare: FareSpec; claim: ResolvedClaimMode }
    | { ok: false; reason: string };
