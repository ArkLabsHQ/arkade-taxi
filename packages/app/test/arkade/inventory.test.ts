import { describe, expect, it } from "vitest";
import { selectOperatorFunding } from "../../src/arkade/inventory.js";
import { fundingCoin, runtimeSafety } from "../fixtures.js";

const select = (over: Partial<Parameters<typeof selectOperatorFunding>[0]> = {}) =>
    selectOperatorFunding({
        spendable: [
            fundingCoin({ value: 338 }),
            fundingCoin({ vout: 1, value: 10000, expiresAtHeight: 900001 }),
        ],
        reserved: [],
        requiredSats: 338n,
        safety: runtimeSafety(),
        nowMs: 1757000000000,
        maxSnapshotAgeMs: 30000,
        minExpiryHeadroomBlocks: 144n,
        minExpiryHeadroomSeconds: 86400n,
        minReserveSats: 10000n,
        ...over,
    });

describe("selectOperatorFunding", () => {
    it("funds the exact topup plus sats fare and leaves unreserved reserve", () => {
        expect(select()).toMatchObject({
            totalValue: 338n,
            batchExpiry: { kind: "height", value: 900000n },
        });
        expect(select().inputs).toHaveLength(1);
    });
    it("orders multiple inputs by expiry, value, txid and vout without mutating the wallet", () => {
        const coins = [
            fundingCoin({ txid: "cc".repeat(32), value: 100, vout: 1 }),
            fundingCoin({ txid: "aa".repeat(32), value: 100, vout: 2 }),
            fundingCoin({ txid: "aa".repeat(32), value: 100, vout: 0 }),
            fundingCoin({ value: 38, vout: 3, expiresAtHeight: 900001 }),
            fundingCoin({ value: 50 }),
        ];
        const before = [...coins];
        const selection = select({ spendable: coins, minReserveSats: 0n });
        expect(selection.inputs.map((c) => [c.value, c.txid.slice(0, 2), c.vout])).toEqual([
            [50, "bb", 0],
            [100, "aa", 0],
            [100, "aa", 2],
            [100, "cc", 1],
        ]);
        expect(selection.totalValue).toBe(350n);
        expect(selection.batchExpiry).toEqual({ kind: "height", value: 900000n });
        expect(coins).toEqual(before);
    });
    it("excludes reserved outpoints from both funding and reserve", () => {
        expect(() => select({ reserved: [{ txid: "bb".repeat(32), vout: 1 }] })).toThrow(
            /inventory|reserve/,
        );
    });
    it("requires reserve after reserving whole inputs, without spending unconfirmed change", () => {
        expect(() => select({ spendable: [fundingCoin({ value: 10338 })] })).toThrow(
            /inventory|reserve/,
        );
    });
    it.each([{ txid: "invalid" }, { vout: -1 }, { vout: 4294967296 }])(
        "does not count malformed inventory %s toward reserve",
        (over) => {
            expect(() =>
                select({
                    spendable: [
                        fundingCoin({ value: 338 }),
                        fundingCoin({ ...over, value: 10000, expiresAtHeight: 900001 }),
                    ],
                }),
            ).toThrow();
        },
    );
    it.each([
        { expiresAtHeight: undefined },
        { expiresAtHeight: 700100 },
        { isSpent: true },
        { isSwept: true },
        { isUnrolled: true },
        { spentBy: "tx" },
        { settledBy: "tx" },
        { value: Number.MAX_SAFE_INTEGER + 1 },
    ])("never selects unsafe input %s", (over) => {
        expect(() => select({ spendable: [fundingCoin(over)], minReserveSats: 0n })).toThrow();
    });
    it("rejects stale, unsynchronized and unknown chain snapshots", () => {
        for (const over of [
            { checkedAt: 1756999900000 },
            { walletSynced: false },
            { chainHeight: null },
            { chainTime: null },
            { blockers: ["intent_locks_unavailable"] },
        ]) {
            expect(() => select({ safety: runtimeSafety(over) })).toThrow(/verified/);
        }
    });
    it("uses timestamp headroom against MTP and keeps expiry domains separate", () => {
        const timed = fundingCoin({
            txid: "dd".repeat(32),
            value: 338,
            expiresAtHeight: undefined,
            expiresAt: new Date(1757086400000),
        });
        expect(select({ spendable: [timed], minReserveSats: 0n }).batchExpiry).toEqual({
            kind: "time",
            value: 1757086400n,
        });
        expect(() =>
            select({ spendable: [timed], minReserveSats: 0n, minExpiryHeadroomSeconds: 86401n }),
        ).toThrow();
        expect(() =>
            select({
                spendable: [fundingCoin({ value: 200 }), { ...timed, value: 200 }],
                minReserveSats: 0n,
            }),
        ).toThrow(/inventory/);
    });
    it("deterministically chooses one sufficient domain without comparing its expiry to the other", () => {
        const timed = fundingCoin({
            txid: "dd".repeat(32),
            expiresAtHeight: undefined,
            expiresAt: new Date(1757086400000),
        });
        const height = fundingCoin();
        expect(select({ spendable: [timed, height], minReserveSats: 0n }).inputs).toEqual([height]);
        expect(select({ spendable: [height, timed], minReserveSats: 0n }).inputs).toEqual([height]);
    });
    it("rejects duplicate outpoints rather than counting value twice", () => {
        const coin = fundingCoin({ value: 200 });
        expect(() => select({ spendable: [coin, coin], minReserveSats: 0n })).toThrow();
    });
});
