import { describe, expect, it } from "vitest";
import type { Advance, AdvanceState } from "../src/types.js";
import { computeExposure, sweepable } from "../src/exposure.js";

const key = (fill: number) => new Uint8Array(32).fill(fill);

let seq = 0;
const advance = (state: AdvanceState, topup: bigint, locktime: bigint): Advance => ({
    id: `adv-${++seq}`,
    state,
    receiverKey: key(1),
    senderKey: key(2),
    operatorKey: key(3),
    dust: 330n,
    topup,
    locktime,
    covenantAddress: "tark1qexample",
    feeSats: 10n,
    createdAt: 1_000,
    updatedAt: 1_000,
    expiresAt: 2_000,
});

describe("computeExposure", () => {
    it("reports zero exposure for no advances", () => {
        expect(computeExposure([])).toEqual({
            outstandingSats: 0n,
            lockedCount: 0,
            oldestUnsweptLocktime: null,
        });
    });

    it("sums topup over locked advances only", () => {
        const advances = [
            advance("locked", 100n, 800_000n),
            advance("locked", 230n, 810_000n),
            advance("quoted", 999n, 700_000n),
            advance("locking", 999n, 700_000n),
            advance("recycled", 999n, 700_000n),
            advance("purchased", 999n, 700_000n),
            advance("refunded", 999n, 700_000n),
            advance("recovered", 999n, 700_000n),
            advance("expired", 999n, 700_000n),
        ];
        expect(computeExposure(advances)).toEqual({
            outstandingSats: 330n,
            lockedCount: 2,
            oldestUnsweptLocktime: 800_000n,
        });
    });

    it("returns a bigint total, not a number", () => {
        expect(typeof computeExposure([advance("locked", 100n, 800_000n)]).outstandingSats).toBe(
            "bigint",
        );
    });

    it("has a null oldest locktime when nothing is locked", () => {
        const advances = [advance("quoted", 100n, 1n), advance("recovered", 100n, 2n)];
        expect(computeExposure(advances).oldestUnsweptLocktime).toBeNull();
        expect(computeExposure(advances).outstandingSats).toBe(0n);
    });

    it("takes the minimum locktime regardless of input order", () => {
        const advances = [
            advance("locked", 1n, 900_000n),
            advance("locked", 1n, 700_000n),
            advance("locked", 1n, 800_000n),
        ];
        expect(computeExposure(advances).oldestUnsweptLocktime).toBe(700_000n);
    });

    // A terminal advance at a lower locktime must not drag the sweeper's oldest
    // marker backwards; it has already been spent.
    it("ignores a lower locktime held by a non-locked advance", () => {
        const advances = [advance("locked", 1n, 800_000n), advance("recycled", 1n, 1n)];
        expect(computeExposure(advances).oldestUnsweptLocktime).toBe(800_000n);
    });

    it("does not mutate the input array", () => {
        const advances = [advance("locked", 1n, 900_000n), advance("locked", 1n, 700_000n)];
        const copy = [...advances];
        computeExposure(advances);
        expect(advances).toEqual(copy);
    });
});

describe("sweepable", () => {
    it("returns nothing for no advances", () => {
        expect(sweepable([], 900_000n)).toEqual([]);
    });

    it("returns locked advances at or below the current height, oldest first", () => {
        const a = advance("locked", 1n, 800_000n);
        const b = advance("locked", 1n, 700_000n);
        const c = advance("locked", 1n, 900_001n);
        expect(sweepable([a, b, c], 900_000n).map((x) => x.locktime)).toEqual([700_000n, 800_000n]);
    });

    it("includes an advance whose locktime equals the current height", () => {
        const a = advance("locked", 1n, 900_000n);
        expect(sweepable([a], 900_000n)).toEqual([a]);
    });

    it("excludes an advance one block short of its locktime", () => {
        expect(sweepable([advance("locked", 1n, 900_001n)], 900_000n)).toEqual([]);
    });

    it.each([
        "quoted",
        "locking",
        "recycled",
        "purchased",
        "refunded",
        "recovered",
        "expired",
    ] as const)("excludes %s however mature its locktime", (state) => {
        expect(sweepable([advance(state, 1n, 1n)], 900_000n)).toEqual([]);
    });

    it("does not mutate or reorder the input array", () => {
        const advances = [advance("locked", 1n, 900_000n), advance("locked", 1n, 700_000n)];
        const order = advances.map((a) => a.id);
        sweepable(advances, 900_000n);
        expect(advances.map((a) => a.id)).toEqual(order);
    });

    // Sorting bigints with `a - b` yields a bigint, which Array.sort coerces to
    // NaN and treats as "equal", leaving the list unsorted.
    it("orders correctly across a span wider than Number.MAX_SAFE_INTEGER", () => {
        const big = advance("locked", 1n, 9_007_199_254_740_995n);
        const small = advance("locked", 1n, 9_007_199_254_740_993n);
        const height = 9_007_199_254_740_999n;
        expect(sweepable([big, small], height).map((x) => x.id)).toEqual([small.id, big.id]);
    });
});
