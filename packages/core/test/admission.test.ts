import { describe, expect, it } from "vitest";
import type { AssetIdRef } from "@arkade-taxi/covenant";
import type { Exposure, Policy, QuoteRequest } from "../src/types.js";
import { admit, assetIdKey } from "../src/admission.js";
import type { PricingFn } from "../src/pricing.js";

const key = (fill: number) => new Uint8Array(32).fill(fill);

const DUST = 330n;
const MIN = 1n;

const asset = (fill: number, groupIndex = 0): AssetIdRef => ({ txid: key(fill), groupIndex });

const policy = (overrides: Partial<Policy> = {}): Policy => ({
    paused: false,
    feeFlatSats: 10n,
    feeBps: 100,
    maxOutstandingSats: 1_000_000n,
    maxPerPaymentTopupSats: 1_000n,
    maxConcurrentAdvances: 10,
    locktimeMarginBlocks: 144,
    assetAllowlist: null,
    allowBitcoin: true,
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

const reasonOf = (d: ReturnType<typeof admit>) => (d.ok ? undefined : d.reason);

describe("assetIdKey", () => {
    it("encodes the txid as hex joined to the group index", () => {
        expect(assetIdKey({ txid: new Uint8Array([0xde, 0xad, 0x00]), groupIndex: 3 })).toBe(
            "dead00:3",
        );
    });

    // The covenant's canonical AssetID is the (txid, groupIndex) pair, so a
    // txid-only key would admit an asset the operator never listed.
    it("distinguishes two group indices under one txid", () => {
        expect(assetIdKey(asset(7, 0))).not.toBe(assetIdKey(asset(7, 1)));
    });
});

describe("admit", () => {
    it("admits a well-formed request", () => {
        const d = admit(request(), policy(), exposure(), DUST, MIN);
        expect(d).toEqual({ ok: true, topup: 330n, feeSats: 13n });
    });

    it("rejects when the operator is paused", () => {
        const d = admit(request(), policy({ paused: true }), exposure(), DUST, MIN);
        expect(d.ok).toBe(false);
        expect(reasonOf(d)).toBe("paused");
    });

    it("rejects an asset outside a non-null allowlist", () => {
        const p = policy({ assetAllowlist: [assetIdKey(asset(7))] });
        const d = admit(request({ assetId: asset(8) }), p, exposure(), DUST, MIN);
        expect(reasonOf(d)).toBe("asset_not_allowed");
    });

    it("admits an asset on the allowlist", () => {
        const p = policy({ assetAllowlist: [assetIdKey(asset(7)), assetIdKey(asset(8))] });
        expect(admit(request({ assetId: asset(8) }), p, exposure(), DUST, MIN).ok).toBe(true);
    });

    it("rejects a matching txid under a different group index", () => {
        const p = policy({ assetAllowlist: [assetIdKey(asset(7, 0))] });
        const d = admit(request({ assetId: asset(7, 1) }), p, exposure(), DUST, MIN);
        expect(reasonOf(d)).toBe("asset_not_allowed");
    });

    it("admits any asset when the allowlist is null", () => {
        expect(admit(request({ assetId: asset(9) }), policy(), exposure(), DUST, MIN).ok).toBe(
            true,
        );
    });

    it("admits an assetless bitcoin request when the allowlist is null", () => {
        expect(admit(request(), policy(), exposure(), DUST, MIN).ok).toBe(true);
    });

    // The asset allowlist governs assets only. Gating bitcoin on it would mean
    // enabling an allowlist silently stopped sub-dust bitcoin quotes.
    it("admits a bitcoin request even against a non-null asset allowlist", () => {
        const p = policy({ assetAllowlist: [assetIdKey(asset(7))], allowBitcoin: true });
        expect(admit(request(), p, exposure(), DUST, MIN).ok).toBe(true);
    });

    it("rejects a bitcoin request when allowBitcoin is off", () => {
        const p = policy({ allowBitcoin: false });
        expect(reasonOf(admit(request(), p, exposure(), DUST, MIN))).toBe("bitcoin_not_allowed");
    });

    it("still admits an allowlisted asset when allowBitcoin is off", () => {
        const p = policy({ allowBitcoin: false, assetAllowlist: [assetIdKey(asset(7))] });
        expect(admit(request({ assetId: asset(7) }), p, exposure(), DUST, MIN).ok).toBe(true);
    });

    it("rejects everything when the allowlist is empty", () => {
        const p = policy({ assetAllowlist: [] });
        expect(reasonOf(admit(request({ assetId: asset(7) }), p, exposure(), DUST, MIN))).toBe(
            "asset_not_allowed",
        );
    });

    it("rejects a topup above the per-payment cap", () => {
        const p = policy({ maxPerPaymentTopupSats: 329n });
        expect(reasonOf(admit(request(), p, exposure(), DUST, MIN))).toBe(
            "topup_exceeds_max_per_payment",
        );
    });

    it("admits a topup exactly at the per-payment cap", () => {
        const p = policy({ maxPerPaymentTopupSats: 330n });
        expect(admit(request(), p, exposure(), DUST, MIN).ok).toBe(true);
    });

    it("rejects when the topup would breach the outstanding cap", () => {
        const p = policy({ maxOutstandingSats: 400n });
        const e = exposure({ outstandingSats: 71n, lockedCount: 1 });
        expect(reasonOf(admit(request(), p, e, DUST, MIN))).toBe("exceeds_max_outstanding");
    });

    it("admits when the topup lands exactly on the outstanding cap", () => {
        const p = policy({ maxOutstandingSats: 400n });
        const e = exposure({ outstandingSats: 70n, lockedCount: 1 });
        expect(admit(request(), p, e, DUST, MIN).ok).toBe(true);
    });

    it("rejects at the concurrency cap", () => {
        const e = exposure({ lockedCount: 10 });
        expect(reasonOf(admit(request(), policy(), e, DUST, MIN))).toBe("max_concurrent_advances");
    });

    it("rejects above the concurrency cap", () => {
        const e = exposure({ lockedCount: 11 });
        expect(reasonOf(admit(request(), policy(), e, DUST, MIN))).toBe("max_concurrent_advances");
    });

    it("admits one below the concurrency cap", () => {
        expect(admit(request(), policy(), exposure({ lockedCount: 9 }), DUST, MIN).ok).toBe(true);
    });

    // Clamping keeps topup inside the range for any sane config, so this only
    // fires when vtxoMinAmount and dust are themselves misconfigured.
    it("rejects a topup outside the covenant's legal range", () => {
        expect(reasonOf(admit(request(), policy(), exposure(), 330n, 400n))).toBe(
            "topup_outside_covenant_range",
        );
    });

    it("rejects when dust is zero", () => {
        expect(reasonOf(admit(request(), policy(), exposure(), 0n, MIN))).toBe(
            "topup_outside_covenant_range",
        );
    });

    it("returns a distinct reason for each rejection", () => {
        const reasons = [
            reasonOf(admit(request(), policy({ paused: true }), exposure(), DUST, MIN)),
            reasonOf(
                admit(
                    request({ assetId: asset(8) }),
                    policy({ assetAllowlist: [assetIdKey(asset(7))] }),
                    exposure(),
                    DUST,
                    MIN,
                ),
            ),
            reasonOf(
                admit(request(), policy({ maxPerPaymentTopupSats: 329n }), exposure(), DUST, MIN),
            ),
            reasonOf(
                admit(
                    request(),
                    policy({ maxOutstandingSats: 400n }),
                    exposure({ outstandingSats: 71n }),
                    DUST,
                    MIN,
                ),
            ),
            reasonOf(admit(request(), policy(), exposure({ lockedCount: 10 }), DUST, MIN)),
            reasonOf(admit(request(), policy(), exposure(), 330n, 400n)),
        ];
        expect(reasons.every((r) => typeof r === "string" && r.length > 0)).toBe(true);
        expect(new Set(reasons).size).toBe(reasons.length);
    });
});

describe("admit topup computation", () => {
    const topupOf = (senderSats: bigint, dust = DUST, min = MIN) => {
        const d = admit(request({ senderSats }), policy(), exposure(), dust, min);
        return d.ok ? d.topup : undefined;
    };

    it("fronts the whole dust unit when the sender brings nothing", () => {
        expect(topupOf(0n)).toBe(330n);
    });

    it("fronts only the shortfall when the sender contributes", () => {
        expect(topupOf(100n)).toBe(230n);
    });

    it("floors at vtxoMinAmount when the sender covers the whole unit", () => {
        expect(topupOf(330n, 330n, 10n)).toBe(10n);
    });

    it("floors at vtxoMinAmount when the sender brings more than dust", () => {
        expect(topupOf(1_000n, 330n, 10n)).toBe(10n);
    });

    it("caps at dust for a negative senderSats", () => {
        expect(topupOf(-100n)).toBe(330n);
    });

    it("returns a bigint topup", () => {
        expect(typeof topupOf(0n)).toBe("bigint");
    });
});

describe("admit fee", () => {
    it("prices the fee from the computed topup", () => {
        const p = policy({ feeFlatSats: 21n, feeBps: 100, maxPerPaymentTopupSats: 10_000n });
        const d = admit(request({ senderSats: 0n }), p, exposure(), 10_000n, MIN);
        expect(d.ok && d.feeSats).toBe(121n);
    });

    it("accepts a substituted pricing function", () => {
        const flat: PricingFn = () => 7n;
        const d = admit(request(), policy(), exposure(), DUST, MIN, flat);
        expect(d.ok && d.feeSats).toBe(7n);
    });

    it("passes the request's assetId to the pricing function", () => {
        const id = asset(9, 4);
        const seen: (AssetIdRef | undefined)[] = [];
        const capture: PricingFn = (i) => {
            seen.push(i.assetId);
            return 0n;
        };
        admit(request({ assetId: id }), policy(), exposure(), DUST, MIN, capture);
        expect(seen).toEqual([id]);
    });
});
