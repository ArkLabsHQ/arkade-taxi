import type {
    AdmissionDecision,
    AdmissionWarning,
    Exposure,
    Policy,
    QuoteRequest,
} from "./types.js";
import type { CustodySolvency } from "./solvency.js";
import {
    FareError,
    resolveFare,
    resolveClaimMode,
    ruleFor,
    selectFare,
    type FareSpec,
} from "./fares.js";

export interface LendingGate {
    solvency: CustodySolvency;
    /** A loan this caller already knows can never be repaid: a sponsored
     * advance has no repayment leaf. Purchase mode is detected below. */
    unrecoverable?: boolean;
}

export function admit(
    req: QuoteRequest,
    policy: Policy,
    exposure: Exposure,
    dust: bigint,
    vtxoMinAmount: bigint,
    lending?: LendingGate,
): AdmissionDecision {
    if (policy.paused) return { ok: false, reason: "paused" };
    // Insolvency, not a liquidity dip: what is owed exceeds what is held plus
    // what is still out on loan. Quoting on would deepen it.
    if (lending?.solvency.shortfall) return { ok: false, reason: "custody_shortfall" };

    // One table, not a pair of flags. `assetId: null` is the bitcoin rule, so
    // "does this operator serve sub-dust bitcoin" and "does it serve USDT" are
    // the same question asked of the same structure.
    const rule = ruleFor(policy.assetRules, req.assetId);
    if (!rule) return { ok: false, reason: "asset_not_served" };
    if (!rule.enabled) return { ok: false, reason: "asset_disabled" };

    const isBitcoinTransfer = req.assetId === undefined;
    if (!isBitcoinTransfer && req.paymentSats !== undefined)
        return { ok: false, reason: "invalid_payment_sats" };
    // Every advance is one whole dust unit, so a repayment always comes back as a
    // spendable coin; a bitcoin payment rides beside it in the covenant.
    const topup = dust;
    const paymentSats = isBitcoinTransfer ? (req.paymentSats ?? req.senderSats) : 0n;
    // Deliberately tighter than the covenant, which only requires a positive
    // payment: the reclaim leaf holds the payer's sats until the wall-clock
    // deadline, so admission bounds how much can sit there and keeps the
    // payment spendable on its own if a refund ever has to stand it up.
    if (
        (paymentSats !== 0n || req.paymentSats !== undefined) &&
        (paymentSats < vtxoMinAmount || paymentSats >= dust || paymentSats > req.senderSats)
    )
        return { ok: false, reason: "invalid_payment_sats" };

    const perPaymentCap = rule.maxTopupSats ?? policy.maxPerPaymentTopupSats;
    if (topup > perPaymentCap) {
        return { ok: false, reason: "topup_exceeds_max_per_payment" };
    }
    if (exposure.outstandingSats + topup > policy.maxOutstandingSats) {
        return { ok: false, reason: "exceeds_max_outstanding" };
    }
    if (exposure.lockedCount >= policy.maxConcurrentAdvances) {
        return { ok: false, reason: "max_concurrent_advances" };
    }
    // Clamping already holds the range for any sane config; this catches a
    // vtxoMinAmount/dust pair that is itself misconfigured.
    if (topup < vtxoMinAmount || topup > dust) {
        return { ok: false, reason: "topup_outside_covenant_range" };
    }

    let fare: FareSpec;
    try {
        fare = resolveFare(selectFare(rule, req.fareId), {
            topupSats: topup,
            assetUnits: req.assetUnits,
            assetId: req.assetId,
        });
    } catch (error) {
        if (error instanceof FareError) return { ok: false, reason: "fare_unavailable" };
        throw error;
    }

    const claim = resolveClaimMode(rule.claim, req.claimMode);
    if (typeof claim !== "string") return { ok: false, reason: claim.reason };

    // Lend anyway and say so: refusing here would strand a payer over a
    // liability the operator chose to take on. One line flips it to a refusal.
    const warnings: AdmissionWarning[] = [];
    if (lending) {
        const coverageSats = lending.solvency.coverageSats - topup;
        if (coverageSats < 0n)
            warnings.push({
                code:
                    lending.unrecoverable || claim === "purchase"
                        ? "custody_funds_lent_unrecoverable"
                        : "custody_funds_lent",
                coverageSats,
            });
    }

    return {
        ok: true,
        topup,
        ...(paymentSats > 0n ? { paymentSats } : {}),
        fare,
        claim,
        ...(warnings.length ? { warnings } : {}),
    };
}
