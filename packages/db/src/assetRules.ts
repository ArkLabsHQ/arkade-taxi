import type { AssetRule, FareOption } from "@arkade-taxi/core";

/**
 * JSON codec for the asset-rule table.
 *
 * Stored as one JSON column rather than normalised tables: rules are always
 * read as a whole with the policy, nothing queries into them, and `ruleFor` is
 * an in-memory find over a handful of entries. Normalising would buy a join
 * nobody makes.
 *
 * JSON.stringify cannot carry either of the two types this structure is made
 * of — it throws on a bigint and silently turns a Uint8Array into `{"0":..}` —
 * so every amount crosses as a decimal string and every txid as hex.
 */

type JsonAssetId = { txid: string; groupIndex: number } | null;

const toHex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");

const fromHex = (s: string): Uint8Array => {
    if (!/^[0-9a-f]*$/.test(s) || s.length % 2 !== 0) {
        throw new Error(`asset rules: txid must be lowercase hex, got ${JSON.stringify(s)}`);
    }
    return Uint8Array.from(s.match(/../g) ?? [], (byte) => parseInt(byte, 16));
};

const idOut = (id: AssetRule["assetId"]): JsonAssetId =>
    id === null ? null : { txid: toHex(id.txid), groupIndex: id.groupIndex };

const idIn = (id: JsonAssetId): AssetRule["assetId"] =>
    id === null ? null : { txid: fromHex(id.txid), groupIndex: id.groupIndex };

const fareOut = (f: FareOption): unknown => ({
    id: f.id,
    currency:
        f.currency.kind === "token"
            ? { kind: "token", assetId: idOut(f.currency.assetId) }
            : { kind: f.currency.kind },
    pricing:
        f.pricing.kind === "flat"
            ? { kind: "flat", units: f.pricing.units.toString() }
            : {
                  kind: "proportional",
                  bps: f.pricing.bps,
                  minUnits: f.pricing.minUnits.toString(),
                  maxUnits: f.pricing.maxUnits === null ? null : f.pricing.maxUnits.toString(),
              },
});

const fareIn = (raw: any): FareOption => ({
    id: raw.id,
    currency:
        raw.currency.kind === "token"
            ? { kind: "token", assetId: idIn(raw.currency.assetId)! }
            : { kind: raw.currency.kind },
    pricing:
        raw.pricing.kind === "flat"
            ? { kind: "flat", units: BigInt(raw.pricing.units) }
            : {
                  kind: "proportional",
                  bps: raw.pricing.bps,
                  minUnits: BigInt(raw.pricing.minUnits),
                  maxUnits: raw.pricing.maxUnits === null ? null : BigInt(raw.pricing.maxUnits),
              },
});

export const assetRulesToJson = (rules: readonly AssetRule[]): string =>
    JSON.stringify(
        rules.map((r) => ({
            assetId: idOut(r.assetId),
            enabled: r.enabled,
            fares: r.fares.map(fareOut),
            claim: r.claim,
            maxTopupSats: r.maxTopupSats === null ? null : r.maxTopupSats.toString(),
        })),
    );

export const assetRulesFromJson = (raw: string): AssetRule[] => {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) throw new Error("asset rules: expected a JSON array");
    return parsed.map((r: any) => ({
        assetId: idIn(r.assetId),
        enabled: r.enabled === true,
        fares: (r.fares ?? []).map(fareIn),
        claim: r.claim,
        maxTopupSats: r.maxTopupSats === null ? null : BigInt(r.maxTopupSats),
    }));
};
