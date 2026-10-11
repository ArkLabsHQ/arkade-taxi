import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Advance } from "@arkade-taxi/core";
import { createSweeper, type RecoveryRunner, type SweeperDeps } from "../src/sweeper.js";
import { RecoveryArtifactError } from "../src/arkade/recovery.js";
import { advance, config, MemoryAdvances, NOW, policy as basePolicy } from "./fixtures.js";

const HEIGHT = 900_000n;
/** Every fixture's deadline sits at the tick's median time, so the headroom a
 * case adds to it is exactly the `remaining` the sweeper reports. */
const DEADLINE = BigInt(NOW);

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
            recoveryLocktime: { kind: "time", value: locktime },
        }),
    );

const seenAt =
    (expiries: Record<string, bigint>): SweeperDeps["observed"] =>
    (a) =>
        expiries[a.id] === undefined
            ? undefined
            : { swept: false, expiry: { kind: "time", value: expiries[a.id]! } };

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

    it("orders critical before warning before eligible", async () => {
        const cfg = config();
        const headroom = new Map<string, bigint>([
            ["eligible", cfg.recoveryBroadcastSeconds + 1n],
            ["warning", cfg.recoveryBroadcastSeconds],
            ["critical-late", cfg.recoveryCriticalSeconds],
            ["critical-early", cfg.recoveryCriticalSeconds - 1n],
        ]);
        let age = 0n;
        for (const id of headroom.keys())
            advances.insert(
                advance({
                    id,
                    locktime: DEADLINE - 10n + age++,
                    recoveryLocktime: { kind: "time", value: DEADLINE - 10n + age },
                }),
            );
        await createSweeper({
            ...deps(),
            observed: (a) => ({
                swept: false,
                expiry: { kind: "time", value: DEADLINE + headroom.get(a.id)! },
            }),
        }).tick(HEIGHT, DEADLINE);
        expect(recovery.seen).toEqual(["critical-early", "critical-late", "warning", "eligible"]);
    });

    it("pauses quotes and blocks readiness at critical headroom and after expiry", async () => {
        const cfg = config();
        advances.insert(
            advance({
                id: "critical",
                locktime: DEADLINE + cfg.recoveryCriticalBlocks,
                recoveryLocktime: { kind: "time", value: DEADLINE + cfg.recoveryCriticalBlocks },
            }),
        );
        advances.insert(
            advance({
                id: "expired",
                state: "recovering",
                locktime: DEADLINE - 100n,
                recoveryLocktime: { kind: "time", value: DEADLINE - 100n },
                recoveryPhase: "submitted",
            }),
        );
        const sweeper = createSweeper({
            ...deps(),
            observed: seenAt({
                critical: DEADLINE + cfg.recoveryCriticalSeconds,
                expired: DEADLINE - 100n,
            }),
        });
        await sweeper.tick(HEIGHT, BigInt(NOW));
        expect(paused).toBe(true);
        expect(sweeper.status().blockers).toEqual(
            expect.arrayContaining([
                expect.objectContaining({ advanceId: "critical", severity: "critical" }),
                expect.objectContaining({ advanceId: "expired", severity: "expired" }),
            ]),
        );
    });

    it("leaves an unrolled covenant to its exit leaf and still escalates a live one", async () => {
        const pastDeadline = (id: string, failureCode?: string) =>
            advance({
                id,
                state: "locked",
                locktime: DEADLINE - 100n,
                recoveryLocktime: { kind: "time", value: DEADLINE - 100n },
                failureCode,
            });
        advances.insert(pastDeadline("unrolled", "covenant_unrolled"));
        const sweeper = createSweeper({
            ...deps(),
            observed: seenAt({ unrolled: DEADLINE - 100n, live: DEADLINE - 100n }),
        });

        await sweeper.tick(HEIGHT, BigInt(NOW));
        expect(recovery.seen).toEqual([]);
        expect(paused).toBe(false);
        expect(sweeper.status().blockers).toEqual([]);
        expect(sweeper.status().lockedCount).toBe(1);

        advances.insert(pastDeadline("live"));
        await sweeper.tick(HEIGHT, BigInt(NOW));
        expect(recovery.seen).toEqual(["live"]);
        expect(paused).toBe(true);
        expect(sweeper.status().blockers).toEqual([
            expect.objectContaining({ advanceId: "live", severity: "expired" }),
        ]);
    });

    it("reclaims a coin it has not observed without alarming on the CLTV", async () => {
        locked("unseen", DEADLINE - 100n);
        const sweeper = createSweeper(deps());
        await sweeper.tick(HEIGHT, BigInt(NOW));
        expect(recovery.seen).toEqual(["unseen"]);
        expect(paused).toBe(false);
        expect(sweeper.status().blockers).toEqual([]);
        expect(sweeper.status().nearestDeadline.time).toMatchObject({
            advanceId: "unseen",
            severity: "eligible",
            code: "covenant_expiry_unobserved",
        });
    });

    it("keeps a persisted deterministic recovery quarantine blocking after restart", async () => {
        advances.insert(
            advance({
                id: "quarantined",
                state: "recovering",
                locktime: DEADLINE + 100_000n,
                recoveryLocktime: { kind: "time", value: DEADLINE + 100_000n },
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
        [BigInt(NOW), 100_000n, "eligible", "recovery_submission_ambiguous", false],
        [BigInt(NOW), 2n, "critical", "covenant_renewal_missing", true],
        [BigInt(NOW), 0n, "expired", "covenant_unspent_at_expiry", true],
        [null, 100_000n, "eligible", "chain_time_unavailable", false],
    ] as const)(
        "restores a persisted ambiguous recovery blocker with clock %s and headroom %s",
        async (time, headroom, severity, code, expectedPause) => {
            advances.insert(
                advance({
                    id: "retrying",
                    state: "recovering",
                    locktime: DEADLINE + headroom,
                    recoveryLocktime: { kind: "time", value: DEADLINE + headroom },
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
                observed: seenAt({ retrying: DEADLINE + headroom }),
            });

            const result = await sweeper.tick(HEIGHT, time);

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
                locktime: DEADLINE - 100n,
                recoveryLocktime: { kind: "time", value: DEADLINE - 100n },
                recoveryPhase: "failed",
                failureCode: "recovery_artifact_invalid",
                recoveryLastAttemptAt: NOW - 1,
            }),
        );
        const sweeper = createSweeper({
            ...deps(),
            observed: seenAt({ "expired-failure": DEADLINE - 100n }),
        });
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
                locktime: DEADLINE + cfg.recoveryCriticalBlocks,
                recoveryLocktime: { kind: "time", value: DEADLINE + cfg.recoveryCriticalBlocks },
                recoveryPhase: "failed",
                failureCode: "recovery_artifact_invalid",
            }),
        );
        const sweeper = createSweeper({
            ...deps(),
            observed: seenAt({ "critical-failure": DEADLINE + cfg.recoveryCriticalSeconds }),
        });
        await sweeper.tick(HEIGHT, BigInt(NOW));
        expect(sweeper.status().blockers).toEqual([
            expect.objectContaining({
                advanceId: "critical-failure",
                severity: "critical",
                code: "covenant_renewal_missing",
            }),
        ]);
        expect(sweeper.status().lastRecoveryError?.code).toBe("recovery_artifact_invalid");
    });
    it("preserves a recovered observation while the recovery response is delayed", async () => {
        locked("a", DEADLINE - 100_000n);
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
        const tick = sweeper.tick(HEIGHT, DEADLINE);
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
        locked("a", DEADLINE - 100_000n);
        locked("b", DEADLINE);

        const result = await createSweeper(deps()).tick(HEIGHT, DEADLINE);

        expect(result.recoverySubmitted).toBe(2);
        expect(result.failed).toBe(0);
        expect(advances.get("a")!.state).toBe("recovering");
        expect(advances.get("b")!.state).toBe("recovering");
    });

    it("records a recovery submission without inventing an observed spend", async () => {
        locked("a", DEADLINE - 100_000n);
        await createSweeper(deps()).tick(HEIGHT, DEADLINE);
        expect(advances.get("a")!.spentTxid).toBeUndefined();
        expect(advances.get("a")!.recoveryTxid).toBe("tx-a");
        expect(advances.get("a")!.recoverySubmittedAt).toBe(NOW);
        expect(advances.get("a")!.updatedAt).toBe(NOW);
    });

    it("leaves an advance whose locktime has not passed alone", async () => {
        locked("future", DEADLINE + 1n);
        const result = await createSweeper(deps()).tick(HEIGHT, DEADLINE);

        expect(result.considered).toBe(0);
        expect(recovery.seen).toEqual([]);
        expect(advances.get("future")!.state).toBe("locked");
    });

    it.each(["quoted", "locking", "recovered", "purchased"] as const)(
        "ignores a %s advance however old its locktime",
        async (state) => {
            advances.insert(advance({ id: "x", state, locktime: 1n }));
            const result = await createSweeper(deps()).tick(HEIGHT, DEADLINE);
            expect(result.considered).toBe(0);
        },
    );

    it("sweeps oldest locktime first", async () => {
        locked("young", DEADLINE - 1_000n);
        locked("old", DEADLINE - 200_000n);
        locked("middle", DEADLINE - 100_000n);

        await createSweeper(deps()).tick(HEIGHT, DEADLINE);
        expect(recovery.seen).toEqual(["old", "middle", "young"]);
    });
});

describe("renewal race", () => {
    const v2 = (over: Partial<Advance> = {}) => advances.insert(advance({ id: "v2", ...over }));

    it("raises a blocker and pauses for a swept covenant whose CLTV is still future", async () => {
        v2();
        const sweeper = createSweeper({
            ...deps(),
            observed: () => ({
                swept: true,
                expiry: { kind: "time", value: BigInt(NOW) + 100_000n },
            }),
        });

        await sweeper.tick(HEIGHT, BigInt(NOW));

        expect(sweeper.status().blockers).toEqual([
            expect.objectContaining({
                advanceId: "v2",
                severity: "critical",
                code: "covenant_swept_before_deadline",
            }),
        ]);
        expect(paused).toBe(true);
    });

    // Sweeping follows expiry, so this is the shape the swept case really
    // arrives in: naming it must not cost the expired rank.
    it("keeps the expired rank for a swept covenant already past its batch expiry", async () => {
        v2();
        const sweeper = createSweeper({
            ...deps(),
            observed: () => ({ swept: true, expiry: { kind: "time", value: BigInt(NOW) - 1n } }),
        });

        await sweeper.tick(HEIGHT, BigInt(NOW));

        expect(sweeper.status().blockers).toEqual([
            expect.objectContaining({
                advanceId: "v2",
                severity: "expired",
                code: "covenant_swept_before_deadline",
            }),
        ]);
        expect(paused).toBe(true);
    });

    it("clears the blocker once the delegatee renews inside the alarm window", async () => {
        v2();
        let expiry = BigInt(NOW) + config().recoveryCriticalSeconds;
        const sweeper = createSweeper({
            ...deps(),
            observed: () => ({ swept: false, expiry: { kind: "time", value: expiry } }),
        });

        await sweeper.tick(HEIGHT, BigInt(NOW));
        expect(paused).toBe(true);
        expect(sweeper.status().blockers).toEqual([
            expect.objectContaining({ advanceId: "v2", severity: "critical" }),
        ]);

        const renewed = advances.get("v2")!;
        advances.update({ ...renewed, renewals: 1, lastRenewedAt: NOW });
        expiry = BigInt(NOW) + 100_000n;
        await sweeper.tick(HEIGHT, BigInt(NOW));

        expect(sweeper.status().blockers).toEqual([]);
        expect(sweeper.status().deadlines).toEqual([
            expect.objectContaining({ advanceId: "v2", severity: "eligible" }),
        ]);
    });

    it.each([
        [undefined, "covenant_renewal_missing"],
        [1, "covenant_renewal_stopped"],
    ] as const)(
        "names a %s renewal history as %s in the warning window",
        async (renewals, code) => {
            v2(renewals === undefined ? {} : { renewals, lastRenewedAt: NOW });
            const onRenewalWarning = vi.fn();
            const sweeper = createSweeper({
                ...deps(),
                onRenewalWarning,
                observed: () => ({
                    swept: false,
                    expiry: {
                        kind: "time",
                        value: BigInt(NOW) + config().recoveryBroadcastSeconds,
                    },
                }),
            });

            await sweeper.tick(HEIGHT, BigInt(NOW));

            expect(sweeper.status().deadlines).toEqual([
                expect.objectContaining({ advanceId: "v2", severity: "warning", code }),
            ]);
            // A warning stops lending for nobody; it only has to reach the operator.
            expect(paused).toBe(false);
            expect(onRenewalWarning).toHaveBeenCalledWith({
                delegation: advances.get("v2")!.covenantAddress,
                deadline: expect.objectContaining({ code }),
            });

            await sweeper.tick(HEIGHT, BigInt(NOW));
            expect(onRenewalWarning).toHaveBeenCalledTimes(1);
        },
    );

    // A matured deadline is reclaimed rather than alarmed on, even where the
    // coin was swept: the reclaim is the remedy and it is already available.
    it("reclaims a matured advance whose coin was swept", async () => {
        locked("matured", DEADLINE - 50_000n);
        const sweeper = createSweeper({
            ...deps(),
            observed: () => ({ swept: true, expiry: { kind: "time", value: BigInt(NOW) } }),
        });

        await sweeper.tick(HEIGHT, BigInt(NOW));

        expect(sweeper.status().blockers).toEqual([
            expect.objectContaining({ advanceId: "matured", severity: "expired" }),
        ]);
        expect(recovery.seen).toEqual(["matured"]);
    });
});

describe("resilience", () => {
    it("preserves expiry severity when recovery fails during the same tick", async () => {
        advances.insert(
            advance({
                id: "expired-now",
                state: "locked",
                locktime: DEADLINE,
                recoveryLocktime: { kind: "time", value: DEADLINE },
            }),
        );
        const sweeper = createSweeper({
            ...deps(),
            observed: seenAt({ "expired-now": DEADLINE }),
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
        locked("hung", DEADLINE - 100n);
        locked("later", DEADLINE - 99n);
        const never = new Promise<never>(() => {});
        const stop = vi.fn();
        const recover = vi.fn((row: Advance) =>
            row.id === "hung"
                ? never
                : Promise.resolve({ txid: `tx-${row.id}`, submittedAt: NOW, alreadyKnown: false }),
        );
        const sweeper = createSweeper({
            ...deps(),
            recovery: { recover, stop },
            observed: () => ({
                swept: false,
                expiry: { kind: "time", value: DEADLINE + config().recoveryCriticalSeconds },
            }),
        });

        await expect(
            Promise.race([
                sweeper.tick(HEIGHT, DEADLINE),
                new Promise((_, reject) =>
                    setTimeout(() => reject(new Error("tick remained blocked")), 100),
                ),
            ]),
        ).resolves.toBeDefined();
        expect(recover.mock.calls.map(([row]) => row.id)).toEqual(["hung", "later"]);
        expect(advances.get("later")?.state).toBe("recovering");

        await sweeper.tick(HEIGHT, DEADLINE + 90n);
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
        locked("first", DEADLINE - 200_000n);
        locked("boom", DEADLINE - 100_000n);
        locked("last", DEADLINE - 10_000n);
        recovery.failFor.add("boom");

        const result = await createSweeper(deps()).tick(HEIGHT, DEADLINE);

        expect(recovery.seen).toEqual(["first", "boom", "last"]);
        expect(result.recoverySubmitted).toBe(2);
        expect(result.failed).toBe(1);
        expect(advances.get("first")!.state).toBe("recovering");
        expect(advances.get("last")!.state).toBe("recovering");
    });

    it("retries an ambiguous recovery attempt on a later tick", async () => {
        locked("boom", DEADLINE - 100_000n);
        recovery.failFor.add("boom");
        const sweeper = createSweeper(deps());

        await sweeper.tick(HEIGHT, DEADLINE);
        expect(advances.get("boom")!.state).toBe("locked");

        recovery.failFor.clear();
        const second = await sweeper.tick(HEIGHT, DEADLINE);
        expect(second.considered).toBe(1);
        expect(recovery.seen).toEqual(["boom", "boom"]);
        expect(advances.get("boom")!.state).toBe("recovering");
    });

    it("reports a per-advance result summary", async () => {
        locked("ok", DEADLINE - 200_000n);
        locked("bad", DEADLINE - 100_000n);
        recovery.failFor.add("bad");

        const { results } = await createSweeper(deps()).tick(HEIGHT, DEADLINE);

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
    it("reports the oldest unswept locktime and an unknown remaining clock", async () => {
        locked("older", DEADLINE - 100_000n);
        locked("newer", DEADLINE - 10n);
        const sweeper = createSweeper(deps());
        await sweeper.tick(null, null);
        expect(sweeper.status().oldestUnsweptLocktime).toEqual({
            height: null,
            time: DEADLINE - 100_000n,
        });
        expect(sweeper.status().nearestDeadline.time?.remaining).toBeNull();
    });

    it("has no successful tick before the first one runs", () => {
        expect(createSweeper(deps()).status().lastTickAt).toBeNull();
    });

    it("stamps the last successful tick", async () => {
        const sweeper = createSweeper(deps());
        await sweeper.tick(HEIGHT, DEADLINE);

        expect(sweeper.status().lastTickAt).toBe(NOW);
        expect(sweeper.status().lastTickHeight).toBe(HEIGHT);
    });

    // A tick that recovered nothing still proves the sweeper is running, which
    // is what the container healthcheck asks about.
    it("stamps an empty tick", async () => {
        const sweeper = createSweeper(deps());
        await sweeper.tick(HEIGHT, DEADLINE);
        expect(sweeper.status().lastTickAt).toBe(NOW);
    });

    it("still stamps a tick in which an advance failed", async () => {
        locked("bad", DEADLINE - 200_000n);
        recovery.failFor.add("bad");
        const sweeper = createSweeper(deps());

        await sweeper.tick(HEIGHT, DEADLINE);
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

        await expect(sweeper.tick(HEIGHT, DEADLINE)).rejects.toThrow(/database is locked/);
        expect(sweeper.status().lastTickAt).toBeNull();
    });

    it("counts recoveries and failures across ticks", async () => {
        locked("a", DEADLINE - 200_000n);
        locked("bad", DEADLINE - 100_000n);
        recovery.failFor.add("bad");
        const sweeper = createSweeper(deps());

        await sweeper.tick(HEIGHT, DEADLINE);
        clock = NOW + 60;
        await sweeper.tick(HEIGHT, DEADLINE);

        expect(sweeper.status().recoverySubmittedTotal).toBe(1);
        expect(sweeper.status().failedTotal).toBe(2);
        expect(sweeper.status().lastTickAt).toBe(NOW + 60);
    });

    it("remembers the last failure and clears it on a clean tick", async () => {
        locked("bad", DEADLINE - 200_000n);
        recovery.failFor.add("bad");
        const sweeper = createSweeper(deps());

        await sweeper.tick(HEIGHT, DEADLINE);
        expect(sweeper.status().lastError).toMatch(/recovery failed for bad/);

        recovery.failFor.clear();
        await sweeper.tick(HEIGHT, DEADLINE);
        expect(sweeper.status().lastError).toBeNull();
    });

    it("reports each failure to the logger without aborting", async () => {
        locked("bad", DEADLINE - 200_000n);
        recovery.failFor.add("bad");
        const onError = vi.fn();

        await createSweeper({ ...deps(), onError }).tick(HEIGHT, DEADLINE);
        expect(onError).toHaveBeenCalledTimes(1);
        expect(onError.mock.calls[0]![0]).toBe("bad");
    });

    it("redacts qualified credentials before the logging boundary", async () => {
        locked("bad", DEADLINE - 200_000n);
        const onError = vi.fn();
        const unsafeRecovery: RecoveryRunner = {
            recover: async () => {
                throw new Error("db_password=never-log-this");
            },
        };

        await createSweeper({ ...deps(), recovery: unsafeRecovery, onError }).tick(
            HEIGHT,
            DEADLINE,
        );

        const logged = onError.mock.calls[0]![1] as Error;
        expect(logged.message).toContain("[redacted]");
        expect(logged.message).not.toContain("never-log-this");
    });
});
