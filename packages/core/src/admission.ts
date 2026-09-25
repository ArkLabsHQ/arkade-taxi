import type { AdmissionDecision, Exposure, Policy, QuoteRequest } from "./types.js";
import {
    FareError,
    resolveFare,
    resolveClaimMode,
    ruleFor,
    selectFare,
    type FareSpec,
} from "./fares.js";

/** A bitcoin transfer nets the sender's sats against the shortfall; an asset
 * transfer fronts the whole unit, since there the sats are only the carrier. */
function requiredTopup(
    senderSats: bigint,
    dust: bigint,
    vtxoMinAmount: bigint,
    isBitcoinTransfer: boolean,
): bigint {
    const shortfall = isBitcoinTransfer ? dust - senderSats : dust;
    const capped = shortfall > dust ? dust : shortfall;
    return capped < vtxoMinAmount ? vtxoMinAmount : capped;
}

export function admit(
    req: QuoteRequest,
    policy: Policy,
    exposure: Exposure,
    dust: bigint,
    vtxoMinAmount: bigint,
): AdmissionDecision {
    if (policy.paused) return { ok: false, reason: "paused" };

    // One table, not a pair of flags. `assetId: null` is the bitcoin rule, so
    // "does this operator serve sub-dust bitcoin" and "does it serve USDT" are
    // the same question asked of the same structure.
    const rule = ruleFor(policy.assetRules, req.assetId);
    if (!rule) return { ok: false, reason: "asset_not_served" };
    if (!rule.enabled) return { ok: false, reason: "asset_disabled" };

    const topup = requiredTopup(req.senderSats, dust, vtxoMinAmount, req.assetId === undefined);

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

    return { ok: true, topup, fare, claim };
}
