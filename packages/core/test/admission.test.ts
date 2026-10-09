import { describe, expect, it } from "vitest";
import { validateParams, type AssetIdRef, type DustCovenantParams } from "@arkade-taxi/covenant";
import type { Exposure, Policy, QuoteRequest } from "../src/types.js";
import { admit } from "../src/admission.js";
import type { CustodySolvency } from "../src/solvency.js";
import type { AssetRule, FareOption } from "../src/fares.js";

const key = (fill: number) => new Uint8Array(32).fill(fill);

const DUST = 330n;
const MIN = 1n;

const COVENANT_PARAMS: DustCovenantParams = {
    receiverKey: key(1),
    senderKey: key(2),
    operatorKey: key(3),
    operatorSignerKey: key(6),
    exitDelay: { value: 86_016n, type: "seconds" },
    dust: DUST,
    topup: DUST,
    locktime: 1_800_000_000n,
};

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
    locktimeMarginSeconds: 86400,
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
        expect(d.claim).toBe("recycle");
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

describe("the any-asset rule", () => {
    const any = rule({ assetId: "*", fares: [cutFare] });
    const ask = (assetId: AssetIdRef | undefined, assetRules: AssetRule[]) =>
        admit(
            request({ assetId, assetUnits: 100n }),
            policy({ assetRules }),
            exposure(),
            DUST,
            MIN,
        );

    it("admits an asset that has no rule of its own", () => {
        expect(okOf(ask(asset(3), [any])).fare).toEqual({
            currency: "asset",
            assetId: asset(3),
            units: 1n,
        });
    });

    it("lets an exact rule switch one asset off while it serves the rest", () => {
        const rules = [any, rule({ assetId: USDT, enabled: false })];
        expect(reasonOf(ask(USDT, rules))).toBe("asset_disabled");
        expect(ask(asset(3), rules).ok).toBe(true);
    });

    it("lets an exact rule price one asset differently", () => {
        const rules = [any, rule({ assetId: USDT, fares: [ticketFare] })];
        expect(okOf(ask(USDT, rules)).fare).toEqual({
            currency: "asset",
            assetId: TOKEN,
            units: 1n,
        });
    });

    it("does not serve bitcoin", () => {
        expect(reasonOf(ask(undefined, [any]))).toBe("asset_not_served");
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

    it("warns while exposure nears the cap and stays silent with headroom", () => {
        const near = policy({ maxOutstandingSats: 1_000n });
        expect(
            okOf(admit(request(), near, exposure({ outstandingSats: 600n }), DUST, MIN)).warnings,
        ).toEqual([{ code: "exposure_nearing_cap", headroomSats: 70n }]);
        expect(
            okOf(admit(request(), near, exposure({ outstandingSats: 500n }), DUST, MIN)).warnings,
        ).toBeUndefined();
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
        const d = okOf(admit(request(), policy(), exposure(), DUST, MIN));
        expect(d.topup).toBe(DUST);
        expect(d.paymentSats).toBeUndefined();
    });

    it("lends the whole dust unit beside the sats the sender brings", () => {
        const d = okOf(admit(request({ senderSats: 300n }), policy(), exposure(), DUST, MIN));
        expect(d.topup).toBe(DUST);
        expect(d.paymentSats).toBe(300n);
    });

    it("refuses a sender who already holds a whole dust unit", () => {
        expect(
            reasonOf(admit(request({ senderSats: DUST }), policy(), exposure(), DUST, MIN)),
        ).toBe("invalid_payment_sats");
    });
});

describe("paymentSats", () => {
    const ask = (paymentSats: bigint, over: Partial<QuoteRequest> = {}, p = policy(), min = MIN) =>
        admit(request({ senderSats: 10_000n, paymentSats, ...over }), p, exposure(), DUST, min);

    it("lends the whole dust unit and carries the payment beside it", () => {
        const d = okOf(ask(100n));
        expect(d.topup).toBe(DUST);
        expect(d.paymentSats).toBe(100n);
    });

    it.each([100n, 330n, 10_000n])("ignores the %s sats the sender's coins hold", (senderSats) => {
        expect(okOf(ask(100n, { senderSats })).paymentSats).toBe(100n);
    });

    it.each([MIN, DUST - MIN])("admits the boundary payment %s", (paymentSats) => {
        expect(okOf(ask(paymentSats)).topup).toBe(DUST);
    });

    it.each([10n, DUST - 1n])(
        "admits the boundary payment %s under a larger minimum",
        (paymentSats) => {
            expect(okOf(ask(paymentSats, {}, policy(), 10n)).paymentSats).toBe(paymentSats);
        },
    );

    it.each([0n, DUST, DUST + 1n])("refuses the unsendable amount %s", (paymentSats) => {
        expect(reasonOf(ask(paymentSats))).toBe("invalid_payment_sats");
    });

    it("refuses a payment under a larger minimum", () => {
        expect(reasonOf(ask(9n, {}, policy(), 10n))).toBe("invalid_payment_sats");
    });

    it("stays tighter than the covenant's own positive-payment rule", () => {
        for (const paymentSats of [1n, DUST, DUST * 2n]) {
            expect(() =>
                validateParams({ ...COVENANT_PARAMS, paymentSats }, paymentSats < 10n ? 1n : 10n),
            ).not.toThrow();
        }
        expect(reasonOf(ask(1n, {}, policy(), 10n))).toBe("invalid_payment_sats");
        expect(reasonOf(ask(DUST, { senderSats: DUST * 4n }))).toBe("invalid_payment_sats");
    });

    it("refuses a payment the sender's own coins cannot cover", () => {
        expect(reasonOf(ask(100n, { senderSats: 99n }))).toBe("invalid_payment_sats");
        expect(okOf(ask(100n, { senderSats: 100n })).paymentSats).toBe(100n);
    });

    it("refuses an exact amount on an asset transfer", () => {
        expect(reasonOf(ask(100n, { assetId: USDT, assetUnits: 5n, fareId: "ticket" }))).toBe(
            "invalid_payment_sats",
        );
    });

    it("still applies the per-payment cap to the resulting advance", () => {
        expect(reasonOf(ask(100n, {}, policy({ maxPerPaymentTopupSats: DUST - 1n })))).toBe(
            "topup_exceeds_max_per_payment",
        );
        expect(
            reasonOf(ask(100n, {}, policy({ assetRules: [rule({ maxTopupSats: DUST - 1n })] }))),
        ).toBe("topup_exceeds_max_per_payment");
    });
});

// For a pure asset transfer the operator fronts the full dust unit and every
// sender sat comes back as change.
describe("asset leg preserves sender sats", () => {
    const assetRule = (claim: AssetRule["claim"]) =>
        rule({ assetId: USDT, claim, fares: [cutFare] });

    it.each([1n, 330n, 10_000n])(
        "fronts the full dust and returns all %s sender sats as change",
        (senderSats) => {
            const d = okOf(
                admit(
                    request({ assetId: USDT, assetUnits: 5n, senderSats }),
                    policy({ assetRules: [assetRule("recycle")] }),
                    exposure(),
                    DUST,
                    MIN,
                ),
            );
            expect(d.topup).toBe(DUST);
            expect(senderSats + d.topup - DUST).toBe(senderSats);
        },
    );

    it("never nets the advance against a bitcoin sender's sats", () => {
        expect(
            okOf(admit(request({ senderSats: 1n }), policy(), exposure(), DUST, MIN)).topup,
        ).toBe(DUST);
    });
});

describe("claim mode", () => {
    const assetRule = (claim: AssetRule["claim"]) =>
        rule({ assetId: USDT, claim, fares: [cutFare] });
    const ask = (claimMode: "recycle" | "purchase" | undefined, claim: AssetRule["claim"]) =>
        admit(
            request({ assetId: USDT, assetUnits: 5n, claimMode }),
            policy({ assetRules: [assetRule(claim)] }),
            exposure(),
            DUST,
            MIN,
        );

    it("resolves the rule's single mode when the request names none", () => {
        expect(okOf(ask(undefined, "recycle")).claim).toBe("recycle");
        expect(okOf(ask(undefined, "purchase")).claim).toBe("purchase");
    });

    it("resolves recycle for an either rule so the tree commits to one leaf", () => {
        expect(okOf(ask(undefined, "either")).claim).toBe("recycle");
    });

    it("accepts the mode the rule permits", () => {
        expect(okOf(ask("purchase", "purchase")).claim).toBe("purchase");
        expect(okOf(ask("recycle", "either")).claim).toBe("recycle");
        expect(okOf(ask("purchase", "either")).claim).toBe("purchase");
    });

    it.each([
        ["purchase", "recycle"],
        ["recycle", "purchase"],
    ] as const)("refuses %s against a %s-only rule before any reservation", (asked, claim) => {
        expect(reasonOf(ask(asked, claim))).toBe("claim_mode_not_allowed");
    });

    it("refuses a mode the wire could never have carried", () => {
        expect(reasonOf(ask("nonsense" as unknown as "recycle", "either"))).toBe(
            "unknown_claim_mode",
        );
    });
});

describe("the custody lending gate", () => {
    const solvency = (over: Partial<CustodySolvency> = {}): CustodySolvency => ({
        coverageSats: 10_000n,
        coverageAssets: [],
        owedSats: 0n,
        lendableSats: 10_000n,
        receivableSats: 0n,
        shortAssets: [],
        shortfall: false,
        ...over,
    });
    const gate = (over: Partial<CustodySolvency> = {}, unrecoverable?: boolean) =>
        admit(request(), policy(), exposure(), DUST, MIN, {
            solvency: solvency(over),
            ...(unrecoverable === undefined ? {} : { unrecoverable }),
        });

    it("changes nothing when no gate is passed", () => {
        expect(okOf(admit(request(), policy(), exposure(), DUST, MIN)).warnings).toBeUndefined();
    });

    it("admits and stays silent while coverage survives the loan", () => {
        expect(okOf(gate({ coverageSats: DUST })).warnings).toBeUndefined();
    });

    it("lends anyway and warns with the coverage left after the loan", () => {
        expect(okOf(gate({ coverageSats: DUST - 1n })).warnings).toEqual([
            { code: "custody_funds_lent", coverageSats: -1n },
        ]);
        expect(okOf(gate({ coverageSats: -500n })).warnings).toEqual([
            { code: "custody_funds_lent", coverageSats: -830n },
        ]);
    });

    it("names a loan that can never be repaid", () => {
        expect(okOf(gate({ coverageSats: 0n }, true)).warnings).toEqual([
            { code: "custody_funds_lent_unrecoverable", coverageSats: -330n },
        ]);
        const purchase = admit(
            request({ claimMode: "purchase" }),
            policy({ assetRules: [rule({ claim: "purchase" })] }),
            exposure(),
            DUST,
            MIN,
            { solvency: solvency({ coverageSats: 0n }) },
        );
        expect(okOf(purchase).warnings).toEqual([
            { code: "custody_funds_lent_unrecoverable", coverageSats: -330n },
        ]);
    });

    it("refuses every quote in a shortfall, before any other check", () => {
        expect(reasonOf(gate({ shortfall: true }))).toBe("custody_shortfall");
        expect(
            reasonOf(
                admit(request({ assetId: asset(99) }), policy(), exposure(), DUST, MIN, {
                    solvency: solvency({ shortfall: true }),
                }),
            ),
        ).toBe("custody_shortfall");
    });
});
