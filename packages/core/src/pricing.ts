import type { AssetIdRef } from "@arkade-taxi/covenant";
import type { Policy } from "./types.js";

export interface PricingInputs {
    topup: bigint;
    senderSats: bigint;
    policy: Policy;
    assetId?: AssetIdRef;
}

export type PricingFn = (i: PricingInputs) => bigint;

/**
 * Flat-regardless-of-size misprices the advances carrying the real capital risk;
 * free-but-capped as a loss-leader caps revenue at zero. Both lost. Charged at
 * lockup as a separate output — the covenant pins repayment to exactly `topup`,
 * so no fee is expressible inside it. Substitute via `priceQuote(i, fn)`.
 */
export const defaultPricing: PricingFn = ({ topup, policy }) => {
    const bps = BigInt(Math.trunc(policy.feeBps));
    const fee = policy.feeFlatSats + (topup * bps) / 10_000n;
    return fee > 0n ? fee : 0n;
};

export function priceQuote(i: PricingInputs, fn: PricingFn = defaultPricing): bigint {
    return fn(i);
}
