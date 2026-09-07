import type { AssetIdRef } from "@arkade-taxi/covenant";
import type { AdmissionDecision, Exposure, Policy, QuoteRequest } from "./types.js";
import { priceQuote, type PricingFn } from "./pricing.js";

const toHex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");

/**
 * Canonical key for `Policy.assetAllowlist`, which is `string[]` while an asset
 * is really the pair (txid, groupIndex). Both halves are in the key: a txid-only
 * one would admit a group the operator never listed. Hex is the raw internal
 * byte order, never reversed display hex.
 */
export function assetIdKey(id: AssetIdRef): string {
    return `${toHex(id.txid)}:${id.groupIndex}`;
}

function requiredTopup(senderSats: bigint, dust: bigint, vtxoMinAmount: bigint): bigint {
    const shortfall = dust - senderSats;
    const capped = shortfall > dust ? dust : shortfall;
    return capped < vtxoMinAmount ? vtxoMinAmount : capped;
}

export function admit(
    req: QuoteRequest,
    policy: Policy,
    exposure: Exposure,
    dust: bigint,
    vtxoMinAmount: bigint,
    pricing?: PricingFn,
): AdmissionDecision {
    if (policy.paused) return { ok: false, reason: "paused" };

    if (policy.assetAllowlist !== null) {
        // Fail closed: an assetless bitcoin request is not on an enumerated list.
        const key = req.assetId ? assetIdKey(req.assetId) : null;
        if (key === null || !policy.assetAllowlist.includes(key)) {
            return { ok: false, reason: "asset_not_allowed" };
        }
    }

    const topup = requiredTopup(req.senderSats, dust, vtxoMinAmount);

    if (topup > policy.maxPerPaymentTopupSats) {
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

    const feeSats = priceQuote(
        { topup, senderSats: req.senderSats, policy, assetId: req.assetId },
        pricing,
    );
    return { ok: true, topup, feeSats };
}
