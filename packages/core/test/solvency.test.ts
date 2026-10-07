import { describe, expect, it } from "vitest";
import type { Advance } from "../src/types.js";
import { assessSolvency, computeReceivables } from "../src/solvency.js";

const asset = (byte: number, groupIndex = 0) => ({
    txid: new Uint8Array(32).fill(byte),
    groupIndex,
});
const USDT = asset(7);
const EURC = asset(8);

type Args = Parameters<typeof assessSolvency>[0];

const assess = (over: Partial<Args> = {}, owed: Partial<Args["owed"]> = {}) =>
    assessSolvency({
        owed: { owedSats: 1_000n, assets: [{ assetId: USDT, units: 50n }], ...owed },
        lendableSats: 5_000n,
        heldUnits: [{ assetId: USDT, units: 50n }],
        receivableSats: 0n,
        ...over,
    });

describe("assessSolvency", () => {
    it("reports coverage as a signed figure, not a blocker", () => {
        expect(assess()).toMatchObject({
            coverageSats: 4_000n,
            owedSats: 1_000n,
            lendableSats: 5_000n,
            shortAssets: [],
            shortfall: false,
        });
        expect(assess({ lendableSats: 400n }).coverageSats).toBe(-600n);
    });

    it("counts a receivable as an asset, because a repayment comes back spendable", () => {
        expect(assess({ lendableSats: 700n, receivableSats: 400n })).toMatchObject({
            shortfall: false,
            coverageSats: -300n,
        });
        expect(assess({ lendableSats: 700n, receivableSats: 299n })).toMatchObject({
            shortfall: true,
        });
    });

    it("is insolvent only when owed sats exceed lendable plus receivable", () => {
        expect(assess({ lendableSats: 999n })).toMatchObject({ shortfall: true });
        expect(assess({ lendableSats: 1_000n })).toMatchObject({ shortfall: false });
    });

    it("names every asset owed more than is held, with no receivable to offset it", () => {
        const verdict = assess(
            { heldUnits: [{ assetId: USDT, units: 49n }], receivableSats: 1_000_000n },
            {
                assets: [
                    { assetId: USDT, units: 50n },
                    { assetId: EURC, units: 9n },
                ],
            },
        );
        expect(verdict.shortfall).toBe(true);
        expect(verdict.shortAssets.map((id) => id.txid[0])).toEqual([7, 8]);
        expect(verdict.coverageAssets).toEqual([
            { assetId: USDT, units: -1n },
            { assetId: EURC, units: -9n },
        ]);
    });

    it("distinguishes two group indices of one genesis txid", () => {
        expect(
            assess(
                { heldUnits: [{ assetId: asset(7, 0), units: 500n }] },
                { assets: [{ assetId: asset(7, 1), units: 5n }] },
            ).shortAssets,
        ).toHaveLength(1);
    });

    it("owes nothing when there are no rows", () => {
        expect(assess({ heldUnits: [] }, { owedSats: 0n, assets: [] })).toMatchObject({
            shortfall: false,
            shortAssets: [],
            coverageSats: 5_000n,
        });
    });
});

const advance = (over: Partial<Advance> = {}): Advance =>
    ({
        id: "a",
        state: "locked",
        topup: 330n,
        ...over,
    }) as Advance;

describe("computeReceivables", () => {
    it("sums the topup of every exposed covenant advance", () => {
        expect(
            computeReceivables([
                advance({ id: "a", state: "locked" }),
                advance({ id: "b", state: "locking" }),
                advance({ id: "c", state: "recovering" }),
            ]),
        ).toBe(990n);
    });

    it("ignores an advance that is not exposed", () => {
        expect(
            computeReceivables([
                advance({ state: "quoted" }),
                advance({ state: "recycled" }),
                advance({ state: "recovered" }),
                advance({ state: "expired" }),
            ]),
        ).toBe(0n);
    });

    // A sponsored advance has no repayment leaf and a purchase-mode claim gives
    // its carrier away, so neither ever comes back as a spendable coin.
    it("excludes a sponsored advance and a purchase-mode covenant", () => {
        expect(
            computeReceivables([
                advance({ id: "a", kind: "sponsored", state: "locking" }),
                advance({ id: "b", claimMode: "purchase" }),
                advance({ id: "c", claimMode: "recycle" }),
            ]),
        ).toBe(330n);
    });
});
