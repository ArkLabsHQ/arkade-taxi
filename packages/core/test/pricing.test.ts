import { describe, expect, it } from "vitest";
import type { Policy } from "../src/types.js";
import { defaultPricing, priceQuote, type PricingFn, type PricingInputs } from "../src/pricing.js";

const policy = (overrides: Partial<Policy> = {}): Policy => ({
    paused: false,
    feeFlatSats: 0n,
    feeBps: 0,
    maxOutstandingSats: 1_000_000n,
    maxPerPaymentTopupSats: 1_000n,
    maxConcurrentAdvances: 10,
    locktimeMarginBlocks: 144,
    assetAllowlist: null,
    allowBitcoin: true,
    quoteTtlSeconds: 60,
    ...overrides,
});

const inputs = (overrides: Partial<PricingInputs> = {}): PricingInputs => ({
    topup: 330n,
    senderSats: 0n,
    policy: policy(),
    ...overrides,
});

describe("defaultPricing", () => {
    it("charges nothing when both components are zero", () => {
        expect(defaultPricing(inputs())).toBe(0n);
    });

    it("charges the flat component alone when bps is zero", () => {
        expect(defaultPricing(inputs({ policy: policy({ feeFlatSats: 21n }) }))).toBe(21n);
    });

    it("charges the bps component alone when flat is zero", () => {
        expect(defaultPricing(inputs({ topup: 10_000n, policy: policy({ feeBps: 100 }) }))).toBe(
            100n,
        );
    });

    it("adds the two components", () => {
        const p = policy({ feeFlatSats: 21n, feeBps: 100 });
        expect(defaultPricing(inputs({ topup: 10_000n, policy: p }))).toBe(121n);
    });

    it("floors the bps component rather than rounding up", () => {
        const p = policy({ feeBps: 100 });
        expect(defaultPricing(inputs({ topup: 330n, policy: p }))).toBe(3n);
    });

    it("floors a sub-satoshi bps charge to zero", () => {
        expect(defaultPricing(inputs({ topup: 1n, policy: policy({ feeBps: 1 }) }))).toBe(0n);
    });

    it("returns a bigint", () => {
        expect(typeof defaultPricing(inputs({ policy: policy({ feeFlatSats: 5n }) }))).toBe(
            "bigint",
        );
    });

    it("never returns a negative fee", () => {
        const p = policy({ feeFlatSats: -100n, feeBps: 10 });
        expect(defaultPricing(inputs({ topup: 330n, policy: p }))).toBe(0n);
    });

    it("never returns a negative fee from a negative bps", () => {
        const p = policy({ feeFlatSats: 1n, feeBps: -10_000 });
        expect(defaultPricing(inputs({ topup: 330n, policy: p }))).toBe(0n);
    });

    it("keeps precision above Number.MAX_SAFE_INTEGER", () => {
        const p = policy({ feeBps: 1 });
        const topup = 10_000_000_000_000_000_000n;
        expect(defaultPricing(inputs({ topup, policy: p }))).toBe(1_000_000_000_000_000n);
    });

    // A fractional bps from a hand-edited policy truncates instead of throwing a
    // RangeError out of BigInt(), which would surface as a 500 on the quote path.
    it("truncates a fractional feeBps instead of throwing", () => {
        const p = policy({ feeBps: 100.9 });
        expect(defaultPricing(inputs({ topup: 10_000n, policy: p }))).toBe(100n);
    });

    it("ignores senderSats", () => {
        const p = policy({ feeFlatSats: 21n, feeBps: 100 });
        const withSender = defaultPricing(
            inputs({ topup: 10_000n, senderSats: 5_000n, policy: p }),
        );
        expect(withSender).toBe(defaultPricing(inputs({ topup: 10_000n, policy: p })));
    });
});

describe("priceQuote", () => {
    it("uses defaultPricing when no function is supplied", () => {
        const p = policy({ feeFlatSats: 21n, feeBps: 100 });
        expect(priceQuote(inputs({ topup: 10_000n, policy: p }))).toBe(121n);
    });

    it("uses the supplied function instead", () => {
        const flat: PricingFn = () => 7n;
        expect(priceQuote(inputs({ policy: policy({ feeFlatSats: 999n }) }), flat)).toBe(7n);
    });

    it("passes every input through to the supplied function", () => {
        const assetId = { txid: new Uint8Array(32).fill(9), groupIndex: 2 };
        let seen: PricingInputs | undefined;
        const capture: PricingFn = (i) => {
            seen = i;
            return 0n;
        };
        const given = inputs({ topup: 42n, senderSats: 288n, assetId });
        priceQuote(given, capture);
        expect(seen).toEqual(given);
    });
});
