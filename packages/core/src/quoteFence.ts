import { ruleFor } from "./fares";
import { advanceKind, validateFundingSnapshot } from "./ledger";
import type { Advance, ExpiryDeadline, Policy } from "./types";

export type QuoteFenceCode =
    | "paused"
    | "asset_not_served"
    | "topup_exceeds_max_per_payment"
    | "no_locktime_headroom"
    | "exceeds_max_outstanding"
    | "max_concurrent_advances";

export type QuoteFenceRefusal =
    { kind: "unquoted" } | { kind: "budget" } | { kind: "admission"; code: QuoteFenceCode };

/** `exposure` is every flow's capital at risk, as db `totalExposure` reads it. */
export function exposureCapRefusal(
    exposure: { total: bigint; count: bigint },
    amount: bigint,
    policy: Pick<Policy, "maxOutstandingSats" | "maxConcurrentAdvances">,
): "exceeds_max_outstanding" | "max_concurrent_advances" | null {
    if (exposure.total + amount > policy.maxOutstandingSats) return "exceeds_max_outstanding";
    if (exposure.count >= BigInt(policy.maxConcurrentAdvances)) return "max_concurrent_advances";
    return null;
}

/**
 * The authoritative quote fence. Not `admit`: the two disagree on purpose in
 * codes and order, and where they do this one decides. Throws what
 * `validateFundingSnapshot` throws.
 */
export function quoteFenceRefusal({
    advance,
    policy,
    exposure,
    recoveryExecutionBudget,
}: {
    advance: Advance;
    policy: Policy;
    exposure: { total: bigint; count: bigint };
    recoveryExecutionBudget: ExpiryDeadline;
}): QuoteFenceRefusal | null {
    if (advance.state !== "quoted") return { kind: "unquoted" };
    validateFundingSnapshot(advance);
    // A sponsored direct send has no covenant leaf to recover, so no recovery
    // budget; the checks after this block apply to both kinds.
    if (advanceKind(advance) === "covenant") {
        const recovery = advance.recoveryLocktime;
        const policyMargin = BigInt(policy.locktimeMarginSeconds);
        if (
            !recovery ||
            recovery.kind !== "time" ||
            recoveryExecutionBudget?.kind !== "time" ||
            recoveryExecutionBudget.value < 0n ||
            policyMargin <= recoveryExecutionBudget.value ||
            recovery.value <= BigInt(advance.createdAt)
        )
            return { kind: "budget" };
    }
    if (policy.paused) return { kind: "admission", code: "paused" };
    const rule = ruleFor(policy.assetRules, advance.assetId);
    if (!rule?.enabled) return { kind: "admission", code: "asset_not_served" };
    if (
        advance.topup <= 0n ||
        advance.topup > advance.dust ||
        advance.topup > (rule.maxTopupSats ?? policy.maxPerPaymentTopupSats)
    )
        return { kind: "admission", code: "topup_exceeds_max_per_payment" };
    // A v2 locktime is not a margin off batch expiry, so there is no
    // headroom between the two to measure.
    if (
        advanceKind(advance) === "covenant" &&
        advance.batchExpiry !== undefined &&
        advance.batchExpiry.value - advance.locktime <
            BigInt(
                advance.batchExpiry.kind === "height"
                    ? policy.locktimeMarginBlocks
                    : policy.locktimeMarginSeconds,
            )
    )
        return { kind: "admission", code: "no_locktime_headroom" };
    const cap = exposureCapRefusal(exposure, advance.topup, policy);
    return cap ? { kind: "admission", code: cap } : null;
}
