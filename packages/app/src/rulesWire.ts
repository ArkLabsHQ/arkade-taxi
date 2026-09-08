import type { AssetRule } from "@arkade-taxi/core";
import { assetIdToWire, satsToWire } from "@arkade-taxi/protocol";
import type { AssetRuleWire, FareOfferWire } from "@arkade-taxi/protocol";

/** Projects the operator's rules for `/v1/info` and the admin console. Shared so
 * the two cannot describe the same terms differently. */
export const fareOfferToWire = (f: AssetRule["fares"][number]): FareOfferWire => ({
    id: f.id,
    currency: f.currency.kind,
    ...(f.currency.kind === "token" ? { assetId: assetIdToWire(f.currency.assetId) } : {}),
    pricing:
        f.pricing.kind === "flat"
            ? { kind: "flat", units: satsToWire(f.pricing.units) }
            : {
                  kind: "proportional",
                  bps: f.pricing.bps,
                  minUnits: satsToWire(f.pricing.minUnits),
                  maxUnits: f.pricing.maxUnits === null ? null : satsToWire(f.pricing.maxUnits),
              },
});

export const assetRuleToWire = (r: AssetRule): AssetRuleWire => ({
    assetId: r.assetId === null ? null : assetIdToWire(r.assetId),
    enabled: r.enabled,
    fares: r.fares.map(fareOfferToWire),
    claim: r.claim,
    maxTopupSats: r.maxTopupSats === null ? null : satsToWire(r.maxTopupSats),
});
