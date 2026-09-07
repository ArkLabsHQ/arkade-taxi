import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Advance } from "@arkade-taxi/core";
import { createSweeper, type RecoveryRunner, type SweeperDeps } from "../src/sweeper.js";
import { advance, MemoryAdvances, NOW } from "./fixtures.js";

const HEIGHT = 900_000n;

class FakeRecovery implements RecoveryRunner {
    readonly seen: string[] = [];
    failFor = new Set<string>();
    txidFor = (id: string) => `tx-${id}`;

    async recover(a: Advance): Promise<{ txid: string }> {
        this.seen.push(a.id);
        if (this.failFor.has(a.id)) throw new Error(`recovery failed for ${a.id}`);
        return { txid: this.txidFor(a.id) };
    }
}

let advances: MemoryAdvances;
let recovery: FakeRecovery;
let clock: number;

const deps = (): SweeperDeps => ({
    advances,
    recovery,
    now: () => clock,
});

const locked = (id: string, locktime: bigint) =>
    advances.insert(advance({ id, state: "locked", locktime }));

beforeEach(() => {
    advances = new MemoryAdvances();
    recovery = new FakeRecovery();
    clock = NOW;
});

describe("tick", () => {
    it("recovers every advance whose locktime has passed", async () => {
        locked("a", 800_000n);
        locked("b", 900_000n);

        const result = await createSweeper(deps()).tick(HEIGHT);

        expect(result.recovered).toBe(2);
        expect(result.failed).toBe(0);
        expect(advances.get("a")!.state).toBe("recovered");
        expect(advances.get("b")!.state).toBe("recovered");
    });

    it("records the recovery txid as the spend", async () => {
        locked("a", 800_000n);
        await createSweeper(deps()).tick(HEIGHT);
        expect(advances.get("a")!.spentTxid).toBe("tx-a");
        expect(advances.get("a")!.updatedAt).toBe(NOW);
    });

    it("leaves an advance whose locktime has not passed alone", async () => {
        locked("future", 900_001n);
        const result = await createSweeper(deps()).tick(HEIGHT);

        expect(result.considered).toBe(0);
        expect(recovery.seen).toEqual([]);
        expect(advances.get("future")!.state).toBe("locked");
    });

    it.each(["quoted", "locking", "recovered", "purchased"] as const)(
        "ignores a %s advance however old its locktime",
        async (state) => {
            advances.insert(advance({ id: "x", state, locktime: 1n }));
            const result = await createSweeper(deps()).tick(HEIGHT);
            expect(result.considered).toBe(0);
        },
    );

    it("sweeps oldest locktime first", async () => {
        locked("young", 899_000n);
        locked("old", 700_000n);
        locked("middle", 800_000n);

        await createSweeper(deps()).tick(HEIGHT);
        expect(recovery.seen).toEqual(["old", "middle", "young"]);
    });
});

describe("resilience", () => {
    it("processes the remainder after a mid-list failure", async () => {
        locked("first", 700_000n);
        locked("boom", 800_000n);
        locked("last", 890_000n);
        recovery.failFor.add("boom");

        const result = await createSweeper(deps()).tick(HEIGHT);

        expect(recovery.seen).toEqual(["first", "boom", "last"]);
        expect(result.recovered).toBe(2);
        expect(result.failed).toBe(1);
        expect(advances.get("first")!.state).toBe("recovered");
        expect(advances.get("last")!.state).toBe("recovered");
    });

    it("leaves the failed advance locked so the next tick retries it", async () => {
        locked("boom", 800_000n);
        recovery.failFor.add("boom");
        const sweeper = createSweeper(deps());

        await sweeper.tick(HEIGHT);
        expect(advances.get("boom")!.state).toBe("locked");

        recovery.failFor.clear();
        const second = await sweeper.tick(HEIGHT);
        expect(second.recovered).toBe(1);
        expect(advances.get("boom")!.state).toBe("recovered");
    });

    it("reports a per-advance result summary", async () => {
        locked("ok", 700_000n);
        locked("bad", 800_000n);
        recovery.failFor.add("bad");

        const { results } = await createSweeper(deps()).tick(HEIGHT);

        expect(results).toEqual([
            { id: "ok", ok: true, txid: "tx-ok" },
            { id: "bad", ok: false, error: "recovery failed for bad" },
        ]);
    });

    it("survives a persistence failure as well as a recovery failure", async () => {
        locked("a", 700_000n);
        locked("b", 800_000n);
        advances.failUpdateAt = 1;

        const result = await createSweeper(deps()).tick(HEIGHT);
        expect(result.failed).toBe(1);
        expect(result.recovered).toBe(1);
        expect(advances.get("b")!.state).toBe("recovered");
    });
});

describe("liveness", () => {
    it("has no successful tick before the first one runs", () => {
        expect(createSweeper(deps()).status().lastTickAt).toBeNull();
    });

    it("stamps the last successful tick", async () => {
        const sweeper = createSweeper(deps());
        await sweeper.tick(HEIGHT);

        expect(sweeper.status().lastTickAt).toBe(NOW);
        expect(sweeper.status().lastTickHeight).toBe(HEIGHT);
    });

    // A tick that recovered nothing still proves the sweeper is running, which
    // is what the container healthcheck asks about.
    it("stamps an empty tick", async () => {
        const sweeper = createSweeper(deps());
        await sweeper.tick(HEIGHT);
        expect(sweeper.status().lastTickAt).toBe(NOW);
    });

    it("still stamps a tick in which an advance failed", async () => {
        locked("bad", 700_000n);
        recovery.failFor.add("bad");
        const sweeper = createSweeper(deps());

        await sweeper.tick(HEIGHT);
        expect(sweeper.status().lastTickAt).toBe(NOW);
    });

    // Listing is the sweeper itself failing, not one advance failing; reporting
    // it as a healthy tick would hide the only outage that costs money.
    it("does not stamp a tick whose listing threw", async () => {
        const sweeper = createSweeper({
            ...deps(),
            advances: {
                ...advances,
                byState: () => {
                    throw new Error("database is locked");
                },
            } as unknown as MemoryAdvances,
        });

        await expect(sweeper.tick(HEIGHT)).rejects.toThrow(/database is locked/);
        expect(sweeper.status().lastTickAt).toBeNull();
    });

    it("counts recoveries and failures across ticks", async () => {
        locked("a", 700_000n);
        locked("bad", 800_000n);
        recovery.failFor.add("bad");
        const sweeper = createSweeper(deps());

        await sweeper.tick(HEIGHT);
        clock = NOW + 60;
        await sweeper.tick(HEIGHT);

        expect(sweeper.status().recoveredTotal).toBe(1);
        expect(sweeper.status().failedTotal).toBe(2);
        expect(sweeper.status().lastTickAt).toBe(NOW + 60);
    });

    it("remembers the last failure and clears it on a clean tick", async () => {
        locked("bad", 700_000n);
        recovery.failFor.add("bad");
        const sweeper = createSweeper(deps());

        await sweeper.tick(HEIGHT);
        expect(sweeper.status().lastError).toMatch(/recovery failed for bad/);

        recovery.failFor.clear();
        await sweeper.tick(HEIGHT);
        expect(sweeper.status().lastError).toBeNull();
    });

    it("reports each failure to the logger without aborting", async () => {
        locked("bad", 700_000n);
        recovery.failFor.add("bad");
        const onError = vi.fn();

        await createSweeper({ ...deps(), onError }).tick(HEIGHT);
        expect(onError).toHaveBeenCalledTimes(1);
        expect(onError.mock.calls[0]![0]).toBe("bad");
    });
});
