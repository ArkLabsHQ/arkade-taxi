import { advanceKind, isExposed } from "./ledger.js";
import { assetIdKey } from "./fares.js";
import type { Advance } from "./types.js";
import type { AssetIdRef } from "@arkade-taxi/covenant";

export interface AssetAmount {
    assetId: AssetIdRef;
    units: bigint;
}

/** What the Taxi owes the receivers whose deliveries it holds. */
export interface CustodyOwed {
    owedSats: bigint;
    assets: readonly AssetAmount[];
}

/**
 * Whether the Taxi can still honour every custody liability.
 *
 * Custody is commingled: a reclaimed delivery is ordinary inventory, so the
 * question is solvency, not whether a particular coin is still there.
 */
export interface CustodySolvency {
    /** Signed. Negative means lending has already dipped into the liability. */
    coverageSats: bigint;
    /** Signed, per asset. */
    coverageAssets: readonly AssetAmount[];
    owedSats: bigint;
    lendableSats: bigint;
    receivableSats: bigint;
    /** Asset ids owed more than is held. */
    shortAssets: readonly AssetIdRef[];
    shortfall: boolean;
}

/**
 * Loans that will come back as spendable coins. A sponsored advance has no
 * repayment leaf and a purchase-mode claim gives its carrier away, so neither
 * is a receivable (`types.ts` on `kind`, and `claimMode`).
 */
export function computeReceivables(advances: readonly Advance[]): bigint {
    let sats = 0n;
    for (const a of advances) {
        if (!isExposed(a) || advanceKind(a) === "sponsored" || a.claimMode === "purchase") continue;
        sats += a.topup;
    }
    return sats;
}

/**
 * Assets carry no receivable: the Taxi lends sats, never units, so the only
 * cover for a unit liability is units it already holds.
 */
export function assessSolvency(args: {
    owed: CustodyOwed;
    lendableSats: bigint;
    heldUnits: readonly AssetAmount[];
    receivableSats: bigint;
}): CustodySolvency {
    const { owed, lendableSats, receivableSats } = args;
    const held = new Map(args.heldUnits.map((a) => [assetIdKey(a.assetId), a.units]));
    const coverageAssets = owed.assets.map(({ assetId, units }) => ({
        assetId,
        units: (held.get(assetIdKey(assetId)) ?? 0n) - units,
    }));
    const shortAssets = coverageAssets.filter((a) => a.units < 0n).map((a) => a.assetId);
    return {
        coverageSats: lendableSats - owed.owedSats,
        coverageAssets,
        owedSats: owed.owedSats,
        lendableSats,
        receivableSats,
        shortAssets,
        shortfall: shortAssets.length > 0 || lendableSats + receivableSats < owed.owedSats,
    };
}
