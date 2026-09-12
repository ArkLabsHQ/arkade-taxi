import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Advance } from "@arkade-taxi/core";
import { createSweeper, type RecoveryRunner, type SweeperDeps } from "../src/sweeper.js";
import { RecoveryArtifactError } from "../src/arkade/recovery.js";
import { advance, config, MemoryAdvances, NOW, policy as basePolicy } from "./fixtures.js";

const HEIGHT = 900_000n;

class FakeRecovery implements RecoveryRunner {
    readonly seen: string[] = [];
    failFor = new Set<string>();
    txidFor = (id: string) => `tx-${id}`;

    async recover(
        a: Advance,
    ): Promise<{ txid: string; submittedAt: number; alreadyKnown: boolean }> {
        this.seen.push(a.id);
        if (this.failFor.has(a.id)) throw new Error(`recovery failed for ${a.id}`);
        return { txid: this.txidFor(a.id), submittedAt: clock, alreadyKnown: false };
    }
}

let advances: MemoryAdvances;
let recovery: FakeRecovery;
let clock: number;
let paused: boolean;

const deps = (): SweeperDeps => ({
    advances,
    recovery,
    now: () => clock,
    config: config(),
    policy: {
        get: () => basePolicy({ paused }),
        update: (patch: { paused?: boolean }) => {
            paused = patch.paused ?? paused;
            return basePolicy({ paused });
        },
    },
});

const locked = (id: string, locktime: bigint) =>
    advances.insert(
        advance({
            id,
            state: "locked",
            locktime,
            recoveryLocktime: { kind: "height", value: locktime },
            batchExpiry: { kind: "height", value: locktime + 100_000n },
        }),
    );

beforeEach(() => {
    advances = new MemoryAdvances();
    recovery = new FakeRecovery();
    clock = NOW;
    paused = false;
});

describe("tick", () => {
    it("uses median time only for timestamp recovery and becomes eligible at the exact CLTV", async () => {
        const timestamp = BigInt(NOW + 10);
        advances.insert(
            advance({
                id: "time",
                locktime: timestamp,
                recoveryLocktime: { kind: "time", value: timestamp },
                batchExpiry: { kind: "time", value: timestamp + 100_000n },
            }),
        );
        const sweeper = createSweeper(deps());
        await sweeper.tick(HEIGHT, timestamp - 1n);
        expect(recovery.seen).toEqual([]);
        await sweeper.tick(HEIGHT, timestamp);
        expect(recovery.seen).toEqual(["time"]);
    });

    it("orders critical before warning before eligible with a fixed kind tie order", async () => {
        const cfg = config();
        const rows = [
            advance({
                id: "eligible",
                locktime: HEIGHT,
                recoveryLocktime: { kind: "height", value: HEIGHT },
                batchExpiry: { kind: "height", value: HEIGHT + cfg.recoveryBroadcastBlocks + 1n },
            }),
            advance({
                id: "warning",
                locktime: HEIGHT,
                recoveryLocktime: { kind: "height", value: HEIGHT },
                batchExpiry: { kind: "height", value: HEIGHT + cfg.recoveryBroadcastBlocks },
            }),
            advance({
                id: "time-critical",
                locktime: BigInt(NOW),
                recoveryLocktime: { kind: "time", value: BigInt(NOW) },
                batchExpiry: { kind: "time", value: BigInt(NOW) + cfg.recoveryCriticalSeconds },
            }),
            advance({
                id: "height-critical",
                locktime: HEIGHT,
                recoveryLocktime: { kind: "height", value: HEIGHT },
                batchExpiry: { kind: "height", value: HEIGHT + cfg.recoveryCriticalBlocks },
            }),
        ];
        rows.forEach((row) => advances.insert(row));
        await createSweeper(deps()).tick(HEIGHT, BigInt(NOW));
        expect(recovery.seen).toEqual(["height-critical", "time-critical", "warning", "eligible"]);
    });

    it("pauses quotes and blocks readiness at critical headroom and after expiry", async () => {
        const cfg = config();
        advances.insert(
            advance({
                id: "critical",
                locktime: HEIGHT,
                recoveryLocktime: { kind: "height", value: HEIGHT },
                batchExpiry: { kind: "height", value: HEIGHT + cfg.recoveryCriticalBlocks },
            }),
        );
        advances.insert(
            advance({
                id: "expired",
                state: "recovering",
                locktime: HEIGHT - 100n,
                recoveryLocktime: { kind: "height", value: HEIGHT - 100n },
                batchExpiry: { kind: "height", value: HEIGHT },
                recoveryPhase: "submitted",
            }),
        );
        const sweeper = createSweeper(deps());
        await sweeper.tick(HEIGHT, BigInt(NOW));
        expect(paused).toBe(true);
        expect(sweeper.status().blockers).toEqual(
            expect.arrayContaining([
                expect.objectContaining({ advanceId: "critical", severity: "critical" }),
                expect.objectContaining({ advanceId: "expired", severity: "expired" }),
            ]),
        );
    });

    it("keeps a persisted deterministic recovery quarantine blocking after restart", async () => {
        advances.insert(
            advance({
                id: "quarantined",
                state: "recovering",
                locktime: HEIGHT,
                recoveryLocktime: { kind: "height", value: HEIGHT },
                batchExpiry: { kind: "height", value: HEIGHT + 100_000n },
                recoveryPhase: "failed",
                failureCode: "recovery_artifact_invalid",
            }),
        );
        const sweeper = createSweeper(deps());

        await sweeper.tick(HEIGHT, BigInt(NOW));

        expect(recovery.seen).toEqual([]);
        expect(paused).toBe(true);
        expect(sweeper.status().blockers).toEqual([
            expect.objectContaining({
                advanceId: "quarantined",
                severity: "critical",
                code: "recovery_artifact_invalid",
            }),
        ]);
        expect(sweeper.status().lastRecoveryError).toMatchObject({
            advanceId: "quarantined",
            code: "recovery_artifact_invalid",
        });
    });

    it.each([
        [HEIGHT, 100_000n, "eligible", "recovery_submission_ambiguous", false],
        [HEIGHT, 2n, "critical", "recovery_deadline_critical", true],
        [HEIGHT, 0n, "expired", "covenant_unspent_at_expiry", true],
        [null, 100_000n, "eligible", "chain_height_unavailable", false],
    ] as const)(
        "restores a persisted ambiguous recovery blocker with clock %s and headroom %s",
        async (height, headroom, severity, code, expectedPause) => {
            advances.insert(
                advance({
                    id: "retrying",
                    state: "recovering",
                    locktime: HEIGHT,
                    recoveryLocktime: { kind: "height", value: HEIGHT },
                    batchExpiry: { kind: "height", value: HEIGHT + headroom },
                    recoveryPhase: "prepared",
                    failureCode: "recovery_submission_ambiguous",
                    failureDetail: "retained for retry",
                    recoveryLastAttemptAt: NOW - 1,
                    recoveryNextAttemptAt: NOW + 30,
                }),
            );
            const sweeper = createSweeper({
                ...deps(),
                recovery: { recover: async () => undefined },
            });

            const result = await sweeper.tick(height, BigInt(NOW));

            expect(result.failed).toBe(0);
            expect(sweeper.status().failedTotal).toBe(0);
            expect(sweeper.status().blockers).toEqual([
                expect.objectContaining({ advanceId: "retrying", severity, code }),
            ]);
            expect(sweeper.status().lastRecoveryError).toMatchObject({
                advanceId: "retrying",
                code: "recovery_submission_ambiguous",
                at: NOW - 1,
            });
            expect(paused).toBe(expectedPause);
        },
    );

    it("never downgrades an expired covenant to its recovery failure", async () => {
        advances.insert(
            advance({
                id: "expired-failure",
                state: "recovering",
                locktime: HEIGHT - 100n,
                recoveryLocktime: { kind: "height", value: HEIGHT - 100n },
                batchExpiry: { kind: "height", value: HEIGHT },
                recoveryPhase: "failed",
                failureCode: "recovery_artifact_invalid",
                recoveryLastAttemptAt: NOW - 1,
            }),
        );
        const sweeper = createSweeper(deps());
        await sweeper.tick(HEIGHT, BigInt(NOW));
        expect(sweeper.status().blockers).toEqual([
            expect.objectContaining({
                advanceId: "expired-failure",
                severity: "expired",
                code: "covenant_unspent_at_expiry",
            }),
        ]);
        expect(sweeper.status().lastRecoveryError).toMatchObject({
            advanceId: "expired-failure",
            code: "recovery_artifact_invalid",
        });
    });

    it("keeps critical deadline severity ahead of recovery quarantine detail", async () => {
        const cfg = config();
        advances.insert(
            advance({
                id: "critical-failure",
                state: "recovering",
                locktime: HEIGHT - 100n,
                recoveryLocktime: { kind: "height", value: HEIGHT - 100n },
                batchExpiry: { kind: "height", value: HEIGHT + cfg.recoveryCriticalBlocks },
                recoveryPhase: "failed",
                failureCode: "recovery_artifact_invalid",
            }),
        );
        const sweeper = createSweeper(deps());
        await sweeper.tick(HEIGHT, BigInt(NOW));
        expect(sweeper.status().blockers).toEqual([
            expect.objectContaining({
                advanceId: "critical-failure",
                severity: "critical",
                code: "recovery_deadline_critical",
            }),
        ]);
        expect(sweeper.status().lastRecoveryError?.code).toBe("recovery_artifact_invalid");
    });
    it("preserves a recovered observation while the recovery response is delayed", async () => {
        locked("a", 800_000n);
        let finish!: () => void;
        const response = new Promise<void>((resolve) => {
            finish = resolve;
        });
        const sweeper = createSweeper({
            ...deps(),
            recovery: {
                recover: async () => {
                    await response;
                    return { txid: "tx-a", submittedAt: NOW, alreadyKnown: false };
                },
            },
        });
        const tick = sweeper.tick(HEIGHT);
        const observed = {
            ...advances.get("a")!,
            state: "recovered" as const,
            spentTxid: "observed-spend",
            lastObservedAt: NOW + 2,
            updatedAt: NOW + 2,
        };
        advances.update(observed);
        finish();
        await tick;
        expect(advances.get("a")).toMatchObject(observed);
        expect(advances.get("a")!.recoveryTxid).toBe("tx-a");
    });

    it("submits recovery for every advance whose locktime has passed", async () => {
        locked("a", 800_000n);
        locked("b", 900_000n);

        const result = await createSweeper(deps()).tick(HEIGHT);

        expect(result.recoverySubmitted).toBe(2);
        expect(result.failed).toBe(0);
        expect(advances.get("a")!.state).toBe("recovering");
        expect(advances.get("b")!.state).toBe("recovering");
    });

    it("records a recovery submission without inventing an observed spend", async () => {
        locked("a", 800_000n);
        await createSweeper(deps()).tick(HEIGHT);
        expect(advances.get("a")!.spentTxid).toBeUndefined();
        expect(advances.get("a")!.recoveryTxid).toBe("tx-a");
        expect(advances.get("a")!.recoverySubmittedAt).toBe(NOW);
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
    it("preserves expiry severity when recovery fails during the same tick", async () => {
        advances.insert(
            advance({
                id: "expired-now",
                state: "locked",
                locktime: HEIGHT - 100n,
                recoveryLocktime: { kind: "height", value: HEIGHT - 100n },
                batchExpiry: { kind: "height", value: HEIGHT },
            }),
        );
        const sweeper = createSweeper({
            ...deps(),
            recovery: {
                recover: async () => {
                    const current = advances.get("expired-now")!;
                    advances.update({
                        ...current,
                        state: "recovering",
                        recoveryPhase: "failed",
                        recoveryAttempts: 1,
                        recoveryLastAttemptAt: NOW,
                        failureCode: "recovery_artifact_invalid",
                        failureDetail: "deterministic graph failure",
                    });
                    throw new RecoveryArtifactError("deterministic graph failure");
                },
            },
        });
        await sweeper.tick(HEIGHT, BigInt(NOW));
        expect(sweeper.status().blockers).toEqual([
            expect.objectContaining({
                advanceId: "expired-now",
                severity: "expired",
                code: "covenant_unspent_at_expiry",
                remaining: 0n,
            }),
        ]);
        expect(sweeper.status().lastRecoveryError).toMatchObject({
            advanceId: "expired-now",
            code: "recovery_artifact_invalid",
            message: "deterministic graph failure",
        });
    });

    it("does not let a never-settling first recovery starve later rows or deadline ticks", async () => {
        locked("hung", HEIGHT - 100n);
        const first = advances.get("hung")!;
        advances.update({
            ...first,
            batchExpiry: { kind: "height", value: HEIGHT + 100n },
        });
        locked("later", HEIGHT - 100n);
        const second = advances.get("later")!;
        advances.update({
            ...second,
            batchExpiry: { kind: "height", value: HEIGHT + 100n },
        });
        const never = new Promise<never>(() => {});
        const stop = vi.fn();
        const recover = vi.fn((row: Advance) =>
            row.id === "hung"
                ? never
                : Promise.resolve({ txid: `tx-${row.id}`, submittedAt: NOW, alreadyKnown: false }),
        );
        const sweeper = createSweeper({ ...deps(), recovery: { recover, stop } });

        await expect(
            Promise.race([
                sweeper.tick(HEIGHT),
                new Promise((_, reject) =>
                    setTimeout(() => reject(new Error("tick remained blocked")), 100),
                ),
            ]),
        ).resolves.toBeDefined();
        expect(recover.mock.calls.map(([row]) => row.id)).toEqual(["hung", "later"]);
        expect(advances.get("later")?.state).toBe("recovering");

        await sweeper.tick(HEIGHT + 90n);
        expect(recover.mock.calls.filter(([row]) => row.id === "hung")).toHaveLength(1);
        expect(paused).toBe(true);
        expect(sweeper.status().blockers).toEqual(
            expect.arrayContaining([
                expect.objectContaining({ advanceId: "hung", severity: "critical" }),
            ]),
        );
        sweeper.stop();
        expect(stop).toHaveBeenCalledOnce();
    });

    it("processes the remainder after a mid-list failure", async () => {
        locked("first", 700_000n);
        locked("boom", 800_000n);
        locked("last", 890_000n);
        recovery.failFor.add("boom");

        const result = await createSweeper(deps()).tick(HEIGHT);

        expect(recovery.seen).toEqual(["first", "boom", "last"]);
        expect(result.recoverySubmitted).toBe(2);
        expect(result.failed).toBe(1);
        expect(advances.get("first")!.state).toBe("recovering");
        expect(advances.get("last")!.state).toBe("recovering");
    });

    it("retries an ambiguous recovery attempt on a later tick", async () => {
        locked("boom", 800_000n);
        recovery.failFor.add("boom");
        const sweeper = createSweeper(deps());

        await sweeper.tick(HEIGHT);
        expect(advances.get("boom")!.state).toBe("locked");

        recovery.failFor.clear();
        const second = await sweeper.tick(HEIGHT);
        expect(second.considered).toBe(1);
        expect(recovery.seen).toEqual(["boom", "boom"]);
        expect(advances.get("boom")!.state).toBe("recovering");
    });

    it("reports a per-advance result summary", async () => {
        locked("ok", 700_000n);
        locked("bad", 800_000n);
        recovery.failFor.add("bad");

        const { results } = await createSweeper(deps()).tick(HEIGHT);

        expect(results).toEqual([
            { id: "ok", ok: true, txid: "tx-ok" },
            {
                id: "bad",
                ok: false,
                error: "recovery failed for bad",
                errorCode: "recovery_submission_ambiguous",
            },
        ]);
    });
});

describe("liveness", () => {
    it("reports oldest unswept locktimes per domain and unknown remaining clocks", async () => {
        locked("height", 800_000n);
        advances.insert(
            advance({
                id: "time",
                locktime: BigInt(NOW - 10),
                recoveryLocktime: { kind: "time", value: BigInt(NOW - 10) },
                batchExpiry: { kind: "time", value: BigInt(NOW + 100_000) },
            }),
        );
        const sweeper = createSweeper(deps());
        await sweeper.tick(null, null);
        expect(sweeper.status().oldestUnsweptLocktime).toEqual({
            height: 800_000n,
            time: BigInt(NOW - 10),
        });
        expect(sweeper.status().nearestDeadline.height?.remaining).toBeNull();
        expect(sweeper.status().nearestDeadline.time?.remaining).toBeNull();
    });

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

        expect(sweeper.status().recoverySubmittedTotal).toBe(1);
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

    it("redacts qualified credentials before the logging boundary", async () => {
        locked("bad", 700_000n);
        const onError = vi.fn();
        const unsafeRecovery: RecoveryRunner = {
            recover: async () => {
                throw new Error("db_password=never-log-this");
            },
        };

        await createSweeper({ ...deps(), recovery: unsafeRecovery, onError }).tick(HEIGHT);

        const logged = onError.mock.calls[0]![1] as Error;
        expect(logged.message).toContain("[redacted]");
        expect(logged.message).not.toContain("never-log-this");
    });
});
