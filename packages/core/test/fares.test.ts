import { describe, expect, it } from "vitest";
import {
    assetIdKey,
    fareNeedsSenderSats,
    FareError,
    resolveFare,
    ruleFor,
    selectFare,
    validateFareOption,
    type AssetRule,
    type FareOption,
} from "../src/fares.js";
import type { AssetIdRef } from "@arkade-taxi/covenant";

const asset = (fill: number, groupIndex = 0): AssetIdRef => ({
    txid: new Uint8Array(32).fill(fill),
    groupIndex,
});

const TOKEN = asset(9);
const USDT = asset(7);

const flat = (id: string, currency: FareOption["currency"], units: bigint): FareOption => ({
    id,
    currency,
    pricing: { kind: "flat", units },
});

describe("validateFareOption", () => {
    it("accepts a flat token fare, which is the point of a prepaid fare", () => {
        expect(() =>
            validateFareOption(flat("ticket", { kind: "token", assetId: TOKEN }, 1n)),
        ).not.toThrow();
    });

    // A token shares no base with the thing being moved, so a percentage of it
    // would need a price this service deliberately does not have.
    it("refuses a proportional token fare, explaining why", () => {
        expect(() =>
            validateFareOption({
                id: "bad",
                currency: { kind: "token", assetId: TOKEN },
                pricing: { kind: "proportional", bps: 100, minUnits: 0n, maxUnits: null },
            }),
        ).toThrow(/shares no base/);
    });

    it("rejects an empty id, since a client names the fare it accepted", () => {
        expect(() => validateFareOption(flat("", { kind: "sats" }, 1n))).toThrow(/non-empty id/);
    });

    it("rejects negative and inverted bounds", () => {
        expect(() => validateFareOption(flat("f", { kind: "sats" }, -1n))).toThrow(/negative/);
        expect(() =>
            validateFareOption({
                id: "p",
                currency: { kind: "sats" },
                pricing: { kind: "proportional", bps: 100, minUnits: 10n, maxUnits: 5n },
            }),
        ).toThrow(/below minUnits/);
    });
});

describe("resolveFare", () => {
    const ctx = { topupSats: 330n, assetUnits: 1_000_000n, assetId: USDT };

    it("charges a flat token fare regardless of what is moved", () => {
        expect(resolveFare(flat("ticket", { kind: "token", assetId: TOKEN }, 1n), ctx)).toEqual({
            currency: "asset",
            assetId: TOKEN,
            units: 1n,
        });
    });

    it("takes a sameAsset fare in the asset being transferred", () => {
        const f = resolveFare(flat("cut", { kind: "sameAsset" }, 500n), ctx);
        expect(f).toEqual({ currency: "asset", assetId: USDT, units: 500n });
    });

    // A sats fare scales with what the operator lends; a sameAsset fare with
    // what is moved. Getting the base wrong is a silent mispricing.
    it("prices a proportional sats fare against the topup", () => {
        const f = resolveFare(
            {
                id: "bps",
                currency: { kind: "sats" },
                pricing: { kind: "proportional", bps: 1000, minUnits: 0n, maxUnits: null },
            },
            ctx,
        );
        expect(f).toEqual({ currency: "sats", units: 33n });
    });

    it("prices a proportional sameAsset fare against the asset amount", () => {
        const f = resolveFare(
            {
                id: "bps",
                currency: { kind: "sameAsset" },
                pricing: { kind: "proportional", bps: 100, minUnits: 0n, maxUnits: null },
            },
            ctx,
        );
        expect(f).toEqual({ currency: "asset", assetId: USDT, units: 10_000n });
    });

    it("floors, so rounding never charges above the stated rate", () => {
        const f = resolveFare(
            {
                id: "bps",
                currency: { kind: "sats" },
                pricing: { kind: "proportional", bps: 1, minUnits: 0n, maxUnits: null },
            },
            { topupSats: 330n },
        );
        expect(f).toEqual({ currency: "sats", units: 0n });
    });

    it("applies the floor and the ceiling", () => {
        const opt = (min: bigint, max: bigint | null): FareOption => ({
            id: "bps",
            currency: { kind: "sats" },
            pricing: { kind: "proportional", bps: 1000, minUnits: min, maxUnits: max },
        });
        expect(resolveFare(opt(100n, null), ctx)).toEqual({ currency: "sats", units: 100n });
        expect(resolveFare(opt(0n, 10n), ctx)).toEqual({ currency: "sats", units: 10n });
    });

    it("refuses a sameAsset fare on a bitcoin transfer", () => {
        expect(() =>
            resolveFare(flat("cut", { kind: "sameAsset" }, 1n), { topupSats: 330n }),
        ).toThrow(FareError);
    });
});

describe("selectFare", () => {
    const rule = (fares: FareOption[]): AssetRule => ({
        assetId: USDT,
        enabled: true,
        fares,
        claim: "either",
        maxTopupSats: null,
    });

    it("defaults to the operator's first offer", () => {
        const r = rule([flat("a", { kind: "sats" }, 1n), flat("b", { kind: "sameAsset" }, 2n)]);
        expect(selectFare(r).id).toBe("a");
    });

    it("honours a named fare", () => {
        const r = rule([flat("a", { kind: "sats" }, 1n), flat("b", { kind: "sameAsset" }, 2n)]);
        expect(selectFare(r, "b").id).toBe("b");
    });

    // Substituting quietly is how someone is charged in a currency they did not
    // agree to.
    it("refuses an unknown fare rather than falling back", () => {
        const r = rule([flat("a", { kind: "sats" }, 1n)]);
        expect(() => selectFare(r, "nope")).toThrow(/unknown fare 'nope'/);
    });

    it("refuses a rule offering no fare at all", () => {
        expect(() => selectFare(rule([]))).toThrow(/no fare/);
    });
});

describe("ruleFor", () => {
    const rules: AssetRule[] = [
        { assetId: null, enabled: true, fares: [], claim: "either", maxTopupSats: null },
        { assetId: USDT, enabled: true, fares: [], claim: "recycle", maxTopupSats: null },
    ];

    it("matches the bitcoin rule when there is no asset", () => {
        expect(ruleFor(rules)?.assetId).toBeNull();
    });

    it("matches an asset by its full identity", () => {
        expect(ruleFor(rules, USDT)?.claim).toBe("recycle");
    });

    // A txid-only key would match a group the operator never listed.
    it("does not match the same txid under a different group index", () => {
        expect(ruleFor(rules, asset(7, 1))).toBeUndefined();
    });

    it("returns undefined for an unlisted asset", () => {
        expect(ruleFor(rules, asset(3))).toBeUndefined();
    });
});

describe("fareNeedsSenderSats", () => {
    // The service exists for a sender with no spendable sats, so a sats fare
    // quietly reintroduces the requirement the covenant removes.
    it("is true only for a sats fare", () => {
        expect(fareNeedsSenderSats({ currency: "sats", units: 1n })).toBe(true);
        expect(fareNeedsSenderSats({ currency: "asset", assetId: TOKEN, units: 1n })).toBe(false);
    });
});

describe("assetIdKey", () => {
    it("includes the group index", () => {
        expect(assetIdKey(asset(7, 0))).not.toBe(assetIdKey(asset(7, 1)));
    });
});
