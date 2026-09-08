import type { AssetIdRef } from "@arkade-taxi/covenant";

/**
 * What a fare is charged in.
 *
 * `sameAsset` and `token` both resolve to an asset fare; they differ only in
 * where the asset id comes from. `sameAsset` takes it from the transfer, so one
 * rule serves every asset; `token` names a fixed one, which is what makes a
 * prepaid fare possible.
 */
export type FareCurrency =
    { kind: "sats" } | { kind: "sameAsset" } | { kind: "token"; assetId: AssetIdRef };

/**
 * How the amount is derived.
 *
 * `proportional` needs something to be a proportion OF, and that base differs
 * per currency — see {@link fareBase}. A token fare has no shared base with the
 * thing being moved, so it must be flat; {@link validateFareOption} refuses the
 * combination rather than inventing a rate.
 */
export type FarePricing =
    | { kind: "flat"; units: bigint }
    | { kind: "proportional"; bps: number; minUnits: bigint; maxUnits: bigint | null };

export interface FareOption {
    /** Stable across quotes, so a client can name the fare it accepted. */
    id: string;
    currency: FareCurrency;
    pricing: FarePricing;
}

/** A fare resolved against one transfer: a currency and a whole number of units. */
export type FareSpec =
    { currency: "sats"; units: bigint } | { currency: "asset"; assetId: AssetIdRef; units: bigint };

/** Which claim leaves a rule permits. */
export type ClaimMode = "recycle" | "purchase" | "either";

/**
 * One asset's terms. `assetId: null` is the plain sub-dust bitcoin transfer,
 * which is a first-class case and not an asset with a missing id.
 */
export interface AssetRule {
    assetId: AssetIdRef | null;
    enabled: boolean;
    /** Offered in operator preference order; a client may accept any of them. */
    fares: FareOption[];
    claim: ClaimMode;
    /** null defers to the policy-wide cap. */
    maxTopupSats: bigint | null;
}

export class FareError extends Error {
    readonly code = "fare";
}

/** Canonical key for an asset id. The group index is part of it deliberately —
 * the emulator's identity is the (txid, index) pair, so a txid-only key would
 * match a group the operator never listed. */
export const assetIdKey = (id: AssetIdRef): string =>
    `${[...id.txid].map((b) => b.toString(16).padStart(2, "0")).join("")}:${id.groupIndex}`;

export const sameAsset = (a: AssetIdRef, b: AssetIdRef): boolean => assetIdKey(a) === assetIdKey(b);

/** The rule governing a transfer, or undefined when the operator listed none. */
export const ruleFor = (rules: readonly AssetRule[], assetId?: AssetIdRef): AssetRule | undefined =>
    rules.find((r) =>
        assetId === undefined
            ? r.assetId === null
            : r.assetId !== null && sameAsset(r.assetId, assetId),
    );

export function validateFareOption(option: FareOption): void {
    const { currency, pricing } = option;
    if (option.id.trim() === "") throw new FareError("fare option needs a non-empty id");

    if (pricing.kind === "flat") {
        if (pricing.units < 0n)
            throw new FareError(`fare ${option.id}: flat units must not be negative`);
        return;
    }

    if (currency.kind === "token") {
        throw new FareError(
            `fare ${option.id}: a token fare must be flat — it shares no base with the transfer, ` +
                "so a proportion of it would need a price this service does not have",
        );
    }
    if (pricing.bps < 0 || pricing.bps > 10_000) {
        throw new FareError(`fare ${option.id}: bps must be within [0, 10000], got ${pricing.bps}`);
    }
    if (pricing.minUnits < 0n)
        throw new FareError(`fare ${option.id}: minUnits must not be negative`);
    if (pricing.maxUnits !== null && pricing.maxUnits < pricing.minUnits) {
        throw new FareError(`fare ${option.id}: maxUnits must not be below minUnits`);
    }
}

export interface FareContext {
    /** The operator's advance, in sats. The base a sats fare is a proportion of. */
    topupSats: bigint;
    /** Units of the asset being moved; absent for a bitcoin transfer. */
    assetUnits?: bigint;
    assetId?: AssetIdRef;
}

/**
 * What a proportional fare is a proportion of, per currency. A sats fare scales
 * with what the operator lends; a same-asset fare scales with what is moved.
 */
export function fareBase(currency: FareCurrency, ctx: FareContext): bigint {
    if (currency.kind === "sats") return ctx.topupSats;
    if (currency.kind === "sameAsset") {
        if (ctx.assetUnits === undefined) {
            throw new FareError("a sameAsset fare needs an asset transfer to price against");
        }
        return ctx.assetUnits;
    }
    throw new FareError("a token fare is never proportional");
}

export function resolveFare(option: FareOption, ctx: FareContext): FareSpec {
    validateFareOption(option);

    let units: bigint;
    if (option.pricing.kind === "flat") {
        units = option.pricing.units;
    } else {
        const base = fareBase(option.currency, ctx);
        // Floor, so rounding never charges more than the stated rate.
        const raw = (base * BigInt(option.pricing.bps)) / 10_000n;
        const floored = raw < option.pricing.minUnits ? option.pricing.minUnits : raw;
        units =
            option.pricing.maxUnits !== null && floored > option.pricing.maxUnits
                ? option.pricing.maxUnits
                : floored;
    }

    if (option.currency.kind === "sats") return { currency: "sats", units };
    if (option.currency.kind === "token") {
        return { currency: "asset", assetId: option.currency.assetId, units };
    }
    if (ctx.assetId === undefined) {
        throw new FareError("a sameAsset fare needs an asset transfer to charge against");
    }
    return { currency: "asset", assetId: ctx.assetId, units };
}

/**
 * The fare a client asked for, or the rule's first offer.
 *
 * Refuses an unknown id rather than falling back: a client that named a fare
 * expects that fare, and quietly substituting another is how someone is charged
 * in a currency they did not agree to.
 */
export function selectFare(rule: AssetRule, requestedId?: string): FareOption {
    if (rule.fares.length === 0)
        throw new FareError("the operator has offered no fare for this asset");
    if (requestedId === undefined) return rule.fares[0] as FareOption;

    const chosen = rule.fares.find((f) => f.id === requestedId);
    if (!chosen) {
        throw new FareError(
            `unknown fare '${requestedId}'; this asset offers ${rule.fares.map((f) => f.id).join(", ")}`,
        );
    }
    return chosen;
}

/**
 * Whether the SENDER needs spendable sats to take this fare.
 *
 * The point of the service is a sender who has none, so a sats fare quietly
 * reintroduces the requirement the covenant exists to remove. Worth being able
 * to ask rather than rediscovering it per deployment.
 */
export const fareNeedsSenderSats = (fare: FareSpec): boolean => fare.currency === "sats";
