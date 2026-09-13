import { expect, it } from "vitest";
import {
    assertScenarioBoundary,
    ownCleanup,
    runWithCleanup,
    unwindAll,
    ownedPayoutOutpoints,
} from "../lib/scenario-cleanup.mjs";

it("waits for only the terminal scenario's exact fare and repayment receipts", () => {
    const row = { arkTxid: "lockup", spentTxid: "claim", fare: { units: "1" } };
    expect(ownedPayoutOutpoints([{ ...row, state: "recycled" }])).toEqual([
        { txid: "lockup", vout: 1 },
        { txid: "claim", vout: 0 },
    ]);
    expect(ownedPayoutOutpoints([{ ...row, state: "purchased" }])).toEqual([
        { txid: "lockup", vout: 1 },
    ]);
    expect(ownedPayoutOutpoints([{ ...row, state: "recycled", fare: { units: "0" } }])).toEqual([
        { txid: "claim", vout: 0 },
    ]);
    expect(ownedPayoutOutpoints([{ ...row, state: "quoted" }, { state: "expired" }])).toEqual([]);
});

it.each(["quoted", "locking", "locked", "recovering"])(
    "rejects a new scenario while a prior %s advance remains active",
    (state) => {
        expect(() => assertScenarioBoundary([{ id: "prior-owned", state }])).toThrow(/prior-owned/);
    },
);

it("allows a new scenario only after all prior advances are terminal", () => {
    expect(() =>
        assertScenarioBoundary(
            ["expired", "purchased", "recycled", "refunded", "recovered"].map((state) => ({
                id: state,
                state,
            })),
        ),
    ).not.toThrow();
});

it("attempts every owned advance even when the first refund fails", async () => {
    const attempts: string[] = [];
    const failure = new Error("first refund failed");
    const error = await unwindAll(["first", "second"], async (id: string) => {
        attempts.push(id);
        if (id === "first") throw failure;
    }).catch((caught: unknown) => caught);
    expect(attempts).toEqual(["first", "second"]);
    expect(error).toBeInstanceOf(AggregateError);
    expect((error as AggregateError).errors).toEqual([failure]);
});

it("preserves the original assertion while recording a cleanup failure", async () => {
    const original = new Error("original financial assertion");
    const cleanup = new Error("refund failed");
    const failure = await runWithCleanup(async () => {
        ownCleanup(async () => {
            throw cleanup;
        });
        throw original;
    }).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(AggregateError);
    expect((failure as AggregateError).cause).toBe(original);
    expect((failure as AggregateError).errors).toEqual([original, cleanup]);
});

it.each([undefined, null, false, 0, ""])(
    "preserves a falsy original throw (%#) after successful cleanup",
    async (original) => {
        let released = false;
        const result = await runWithCleanup(async () => {
            ownCleanup(async () => {
                released = true;
            });
            throw original;
        }).then(
            () => ({ resolved: true }),
            (error: unknown) => ({ error }),
        );
        expect(released).toBe(true);
        expect(result).toStrictEqual({ error: original });
    },
);

it.each([undefined, null, false, 0, ""])(
    "retains a falsy original throw (%#) as the first error and cause of failed cleanup",
    async (original) => {
        const cleanup = new Error("refund failed");
        const failure = await runWithCleanup(async () => {
            ownCleanup(async () => {
                throw cleanup;
            });
            throw original;
        }).catch((error: unknown) => error);
        expect(failure).toBeInstanceOf(AggregateError);
        expect((failure as AggregateError).cause).toBe(original);
        expect((failure as AggregateError).errors).toEqual([original, cleanup]);
    },
);

it("unwinds every owned resource once even after an explicit failing close", async () => {
    const released: number[] = [];
    await expect(
        runWithCleanup(async () => {
            ownCleanup(async () => {
                released.push(1);
            });
            const close = ownCleanup(async () => {
                released.push(2);
                throw new Error("failure");
            });
            await close();
        }),
    ).rejects.toThrow("scenario cleanup failed");
    expect(released).toEqual([2, 1]);
});

it.each([null, undefined])(
    "preserves the original assertion when cleanup rejects with %s",
    async (cleanup) => {
        const original = new Error("original scenario assertion");
        const failure = await runWithCleanup(async () => {
            ownCleanup(async () => {
                throw cleanup;
            });
            throw original;
        }).catch((error: unknown) => error);
        expect(failure).toBeInstanceOf(AggregateError);
        expect((failure as AggregateError).cause).toBe(original);
        expect((failure as AggregateError).errors).toEqual([original, cleanup]);
        expect((failure as AggregateError).message).toContain(String(cleanup));
    },
);
