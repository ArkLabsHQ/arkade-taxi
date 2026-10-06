import type { FareOfferWire } from "@arkade-taxi/protocol";

export const DECIMAL = /^(0|[1-9][0-9]*)$/;
export const MAX_SATS = 2_100_000_000_000_000n;

export const wireUnits = (value: unknown): bigint | undefined =>
    typeof value === "string" && DECIMAL.test(value) ? BigInt(value) : undefined;

export const asRecord = (value: unknown): Record<string, unknown> | undefined =>
    typeof value === "object" && value !== null && !Array.isArray(value)
        ? (value as Record<string, unknown>)
        : undefined;

export const isCanonicalTxid = (value: unknown): value is string =>
    typeof value === "string" && /^[0-9a-f]{64}$/.test(value);

export const isTransferId = (value: unknown): value is string =>
    typeof value === "string" && /^[A-Za-z0-9._:-]+$/.test(value) && value.length <= 128;

export const isHttpUrl = (value: unknown): boolean => {
    try {
        return typeof value === "string" && ["http:", "https:"].includes(new URL(value).protocol);
    } catch {
        return false;
    }
};

/** What a fare charges on `base`, as the Taxi prices it; undefined for a malformed one. */
export const priceFare = (pricing: FareOfferWire["pricing"], base: bigint): bigint | undefined => {
    if (pricing.kind === "flat") return wireUnits(pricing.units);
    const [min, max] = [
        wireUnits(pricing.minUnits),
        pricing.maxUnits === null ? null : wireUnits(pricing.maxUnits),
    ];
    if (!Number.isInteger(pricing.bps) || pricing.bps < 0 || pricing.bps > 10_000) return undefined;
    if (min === undefined || max === undefined) return undefined;
    const raw = (base * BigInt(pricing.bps)) / 10_000n;
    const floored = raw < min ? min : raw;
    return max !== null && floored > max ? max : floored;
};
