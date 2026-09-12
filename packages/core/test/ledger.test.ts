import { describe, expect, it } from "vitest";
import type { Advance, AdvanceState } from "../src/types.js";
import { canTransition, isExpired, isTerminal, transition } from "../src/ledger.js";

const ALL_STATES: readonly AdvanceState[] = [
    "quoted",
    "locking",
    "locked",
    "recovering",
    "recycled",
    "purchased",
    "refunded",
    "recovered",
    "expired",
];

const LEGAL: ReadonlyArray<readonly [AdvanceState, AdvanceState]> = [
    ["quoted", "locking"],
    ["quoted", "expired"],
    ["locking", "locked"],
    ["locked", "recycled"],
    ["locked", "purchased"],
    ["locked", "refunded"],
    ["locked", "recovering"],
    ["recovering", "recovered"],
];

const key = (fill: number) => new Uint8Array(32).fill(fill);

const advance = (overrides: Partial<Advance> = {}): Advance => {
    const result: Advance = {
        id: "adv-1",
        state: "quoted",
        receiverKey: key(1),
        senderKey: key(2),
        operatorKey: key(3),
        dust: 330n,
        topup: 330n,
        locktime: 800_000n,
        batchExpiry: { kind: "height", value: 800_500n },
        operatorInputs: [{ txid: "aa".repeat(32), vout: 0 }],
        unsignedLockupTx: "unsigned",
        unsignedLockupId: "bb".repeat(32),
        covenantAddress: "tark1qexample",
        fare: { currency: "sats", units: 10n },
        createdAt: 1_000,
        updatedAt: 1_000,
        expiresAt: 2_000,
        ...overrides,
    };
    result.recoveryLocktime ??= { kind: result.batchExpiry.kind, value: result.locktime };
    return result;
};

describe("canTransition", () => {
    it.each(LEGAL)("allows %s -> %s", (from, to) => {
        expect(canTransition(from, to)).toBe(true);
    });

    it("rejects every pair outside the legal graph", () => {
        const legal = new Set(LEGAL.map(([from, to]) => `${from}->${to}`));
        const wrong: string[] = [];
        for (const from of ALL_STATES) {
            for (const to of ALL_STATES) {
                const edge = `${from}->${to}`;
                if (!legal.has(edge) && canTransition(from, to)) wrong.push(edge);
            }
        }
        expect(wrong).toEqual([]);
    });

    it.each(["recycled", "purchased", "refunded", "recovered", "expired"] as const)(
        "leaves terminal state %s with no outbound edge",
        (from) => {
            expect(ALL_STATES.filter((to) => canTransition(from, to))).toEqual([]);
        },
    );

    it("rejects a self-transition", () => {
        for (const s of ALL_STATES) expect(canTransition(s, s)).toBe(false);
    });

    it("keeps ambiguous submissions in locking", () => {
        const a = advance({ state: "locking", submissionKey: "attempt-1" });
        expect(() => transition(a, "quoted", 5_000)).toThrow();
        expect(a.state).toBe("locking");
    });

    it("keeps recovery attempts recovering until an observation", () => {
        const a = transition(advance({ state: "locked" }), "recovering", 5_000);
        expect(() => transition(a, "locked", 6_000)).toThrow();
        expect(isExpired(a, 99_999)).toBe(false);
        expect(transition(a, "recovered", 7_000).state).toBe("recovered");
    });

    it.each([799_999n, 800_000n])("rejects unsafe batch expiry %s", (batchExpiryHeight) => {
        expect(() =>
            transition(
                advance({ batchExpiry: { kind: "height", value: batchExpiryHeight } }),
                "locking",
                5_000,
            ),
        ).toThrow(/batch.*expiry/i);
    });
});

describe("transition", () => {
    it("accepts timestamp deadlines only with timestamp CLTV", () => {
        const timed = advance({
            locktime: 1789132000n,
            batchExpiry: { kind: "time", value: 1789132933n },
        });
        expect(transition(timed, "locking", 5000).batchExpiry).toEqual({
            kind: "time",
            value: 1789132933n,
        });
        expect(() => transition({ ...timed, locktime: 400n }, "locking", 5000)).toThrow(/expiry/);
        expect(() =>
            transition(
                { ...timed, batchExpiry: { kind: "height", value: 1789132933n } },
                "locking",
                5000,
            ),
        ).toThrow(/expiry/);
    });
    it("returns a new object with the new state and updatedAt", () => {
        const before = advance();
        const after = transition(before, "locking", 5_000);
        expect(after).not.toBe(before);
        expect(after.state).toBe("locking");
        expect(after.updatedAt).toBe(5_000);
    });

    it("does not mutate the input", () => {
        const before = advance();
        transition(before, "locking", 5_000);
        expect(before.state).toBe("quoted");
        expect(before.updatedAt).toBe(1_000);
    });

    it("carries every other field through unchanged", () => {
        const before = advance({ state: "locked", outpoint: { txid: "aa", vout: 1 } });
        const after = transition(before, "recycled", 9_000);
        expect(after).toEqual({ ...before, state: "recycled", updatedAt: 9_000 });
    });

    it("throws on an illegal transition", () => {
        expect(() => transition(advance({ state: "quoted" }), "locked", 5_000)).toThrow(
            /quoted.*locked/,
        );
    });

    it("throws when leaving a terminal state", () => {
        expect(() => transition(advance({ state: "recycled" }), "refunded", 5_000)).toThrow();
    });

    it("throws on a self-transition", () => {
        expect(() => transition(advance({ state: "locked" }), "locked", 5_000)).toThrow();
    });

    it.each(LEGAL)("accepts the legal edge %s -> %s", (from, to) => {
        expect(transition(advance({ state: from }), to, 7_000).state).toBe(to);
    });
});

describe("isTerminal", () => {
    it.each(["recycled", "purchased", "refunded", "recovered", "expired"] as const)(
        "reports %s as terminal",
        (s) => {
            expect(isTerminal(s)).toBe(true);
        },
    );

    it.each(["quoted", "locking", "locked"] as const)("reports %s as non-terminal", (s) => {
        expect(isTerminal(s)).toBe(false);
    });
});

describe("isExpired", () => {
    it("is false for a quote still inside its validity window", () => {
        expect(isExpired(advance({ expiresAt: 2_000 }), 1_999)).toBe(false);
    });

    it("is true for a quote past its validity window", () => {
        expect(isExpired(advance({ expiresAt: 2_000 }), 2_001)).toBe(true);
    });

    // Boundary is inclusive: at expiresAt the quote is already spent.
    it("is true exactly at expiresAt", () => {
        expect(isExpired(advance({ expiresAt: 2_000 }), 2_000)).toBe(true);
    });

    it.each([
        "locking",
        "locked",
        "recycled",
        "purchased",
        "refunded",
        "recovered",
        "expired",
    ] as const)("is false for %s however far past expiresAt", (state) => {
        expect(isExpired(advance({ state, expiresAt: 2_000 }), 9_999_999)).toBe(false);
    });
});
