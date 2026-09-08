import { describe, expect, it } from "vitest";
import type { AssetIdRef } from "@arkade-taxi/covenant";
import type { Exposure, Policy, QuoteRequest } from "../src/types.js";
import { admit } from "../src/admission.js";
import type { AssetRule, FareOption } from "../src/fares.js";

const key = (fill: number) => new Uint8Array(32).fill(fill);

const DUST = 330n;
const MIN = 1n;

const asset = (fill: number, groupIndex = 0): AssetIdRef => ({ txid: key(fill), groupIndex });

const USDT = asset(7);
const TOKEN = asset(9);

const satsFare: FareOption = {
    id: "sats",
    currency: { kind: "sats" },
    pricing: { kind: "flat", units: 10n },
};
const ticketFare: FareOption = {
    id: "ticket",
    currency: { kind: "token", assetId: TOKEN },
    pricing: { kind: "flat", units: 1n },
};
const cutFare: FareOption = {
    id: "cut",
    currency: { kind: "sameAsset" },
    pricing: { kind: "proportional", bps: 100, minUnits: 1n, maxUnits: null },
};

const rule = (over: Partial<AssetRule> = {}): AssetRule => ({
    assetId: null,
    enabled: true,
    fares: [satsFare],
    claim: "either",
    maxTopupSats: null,
    ...over,
});

const policy = (overrides: Partial<Policy> = {}): Policy => ({
    paused: false,
    maxOutstandingSats: 1_000_000n,
    maxPerPaymentTopupSats: 1_000n,
    maxConcurrentAdvances: 10,
    locktimeMarginBlocks: 144,
    assetRules: [rule(), rule({ assetId: USDT, fares: [ticketFare, cutFare] })],
    quoteTtlSeconds: 60,
    ...overrides,
});

const request = (overrides: Partial<QuoteRequest> = {}): QuoteRequest => ({
    receiverKey: key(1),
    senderKey: key(2),
    senderSats: 0n,
    ...overrides,
});

const exposure = (overrides: Partial<Exposure> = {}): Exposure => ({
    outstandingSats: 0n,
    lockedCount: 0,
    oldestUnsweptLocktime: null,
    ...overrides,
});

const reasonOf = (d: ReturnType<typeof admit>): string => {
    if (d.ok) throw new Error("expected a rejection");
    return d.reason;
};

const okOf = (d: ReturnType<typeof admit>) => {
    if (!d.ok) throw new Error(`expected admission, got ${d.reason}`);
    return d;
};

describe("admit", () => {
    it("admits a bitcoin request against the bitcoin rule", () => {
        const d = okOf(admit(request(), policy(), exposure(), DUST, MIN));
        expect(d.topup).toBe(DUST);
        expect(d.fare).toEqual({ currency: "sats", units: 10n });
        expect(d.claim).toBe("either");
    });

    it("refuses while paused, before anything else is considered", () => {
        expect(reasonOf(admit(request(), policy({ paused: true }), exposure(), DUST, MIN))).toBe(
            "paused",
        );
    });

    it("refuses an asset the operator lists no rule for", () => {
        expect(
            reasonOf(admit(request({ assetId: asset(3) }), policy(), exposure(), DUST, MIN)),
        ).toBe("asset_not_served");
    });

    // A txid-only match would serve a group the operator never listed.
    it("does not serve a listed txid under a different group index", () => {
        expect(
            reasonOf(admit(request({ assetId: asset(7, 1) }), policy(), exposure(), DUST, MIN)),
        ).toBe("asset_not_served");
    });

    it("distinguishes a disabled rule from an absent one", () => {
        const p = policy({ assetRules: [rule({ enabled: false })] });
        expect(reasonOf(admit(request(), p, exposure(), DUST, MIN))).toBe("asset_disabled");
    });

    // The whole point of the redesign: bitcoin has its own rule, so listing an
    // asset cannot silently stop it being quoted.
    it("still quotes bitcoin when an asset rule is present", () => {
        expect(admit(request(), policy(), exposure(), DUST, MIN).ok).toBe(true);
    });
});

describe("fares", () => {
    it("takes the rule's first offer when the client names none", () => {
        const d = okOf(admit(request({ assetId: USDT }), policy(), exposure(), DUST, MIN));
        expect(d.fare).toEqual({ currency: "asset", assetId: TOKEN, units: 1n });
    });

    it("charges a prepaid token fare that does not vary with the amount moved", () => {
        const big = okOf(
            admit(
                request({ assetId: USDT, assetUnits: 10n ** 12n }),
                policy(),
                exposure(),
                DUST,
                MIN,
            ),
        );
        expect(big.fare).toEqual({ currency: "asset", assetId: TOKEN, units: 1n });
    });

    it("charges a sameAsset fare in the asset being moved", () => {
        const d = okOf(
            admit(
                request({ assetId: USDT, assetUnits: 1_000_000n, fareId: "cut" }),
                policy(),
                exposure(),
                DUST,
                MIN,
            ),
        );
        expect(d.fare).toEqual({ currency: "asset", assetId: USDT, units: 10_000n });
    });

    it("refuses a fare the rule does not offer", () => {
        const d = admit(
            request({ assetId: USDT, fareId: "nope" }),
            policy(),
            exposure(),
            DUST,
            MIN,
        );
        expect(reasonOf(d)).toBe("fare_unavailable");
    });

    // A sameAsset fare has nothing to be a proportion of on a bitcoin transfer.
    it("refuses a sameAsset fare on a bitcoin transfer rather than guessing", () => {
        const p = policy({ assetRules: [rule({ fares: [cutFare] })] });
        expect(reasonOf(admit(request(), p, exposure(), DUST, MIN))).toBe("fare_unavailable");
    });

    it("refuses a rule that offers no fare at all", () => {
        const p = policy({ assetRules: [rule({ fares: [] })] });
        expect(reasonOf(admit(request(), p, exposure(), DUST, MIN))).toBe("fare_unavailable");
    });
});

describe("caps", () => {
    it("refuses a topup above the per-payment cap", () => {
        const p = policy({ maxPerPaymentTopupSats: 1n });
        expect(reasonOf(admit(request(), p, exposure(), DUST, MIN))).toBe(
            "topup_exceeds_max_per_payment",
        );
    });

    // A per-asset cap is the flexible half: one asset can be held tighter than
    // the deployment-wide number without moving it for everyone.
    it("prefers the rule's own cap over the policy-wide one", () => {
        const p = policy({
            maxPerPaymentTopupSats: 1_000n,
            assetRules: [rule({ maxTopupSats: 1n })],
        });
        expect(reasonOf(admit(request(), p, exposure(), DUST, MIN))).toBe(
            "topup_exceeds_max_per_payment",
        );
    });

    it("falls back to the policy cap when the rule sets none", () => {
        expect(admit(request(), policy(), exposure(), DUST, MIN).ok).toBe(true);
    });

    it("refuses when the advance would exceed outstanding exposure", () => {
        const d = admit(request(), policy({ maxOutstandingSats: 1n }), exposure(), DUST, MIN);
        expect(reasonOf(d)).toBe("exceeds_max_outstanding");
    });

    it("refuses at the concurrency limit", () => {
        const d = admit(request(), policy({ maxConcurrentAdvances: 0 }), exposure(), DUST, MIN);
        expect(reasonOf(d)).toBe("max_concurrent_advances");
    });

    it("refuses a topup outside the covenant's own range", () => {
        const d = admit(request(), policy(), exposure(), 1n, 5n);
        expect(reasonOf(d)).toBe("topup_outside_covenant_range");
    });
});

describe("topup", () => {
    it("funds the whole dust unit when the sender brings no sats", () => {
        expect(okOf(admit(request(), policy(), exposure(), DUST, MIN)).topup).toBe(DUST);
    });

    it("funds only the shortfall when the sender brings sats", () => {
        expect(
            okOf(admit(request({ senderSats: 300n }), policy(), exposure(), DUST, MIN)).topup,
        ).toBe(30n);
    });

    it("never drops below vtxoMinAmount", () => {
        expect(
            okOf(admit(request({ senderSats: DUST }), policy(), exposure(), DUST, MIN)).topup,
        ).toBe(MIN);
    });
});
