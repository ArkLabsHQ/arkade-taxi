import { EventEmitter } from "node:events";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import * as stack from "../e2e-stack.mjs";

const controlledChild = (pid: number) =>
    Object.assign(new EventEmitter(), {
        pid,
        stdout: new PassThrough(),
        stderr: new PassThrough(),
        unref() {},
    });

const monitor = (
    child: ReturnType<typeof controlledChild>,
    interruption: ReturnType<typeof stack.createInterruptionState>,
    terminate: () => Promise<void>,
    terminationTimeoutMs = 100,
) => {
    expect(stack.monitorOwnedProcess).toBeTypeOf("function");
    if (typeof stack.monitorOwnedProcess !== "function") return;
    return stack.monitorOwnedProcess({
        command: "controlled-child",
        args: [],
        child,
        interruption,
        terminate,
        terminationTimeoutMs,
        options: { print: false },
    });
};

describe("owned process interruption", () => {
    it("fails closed when drain fails after the direct child closes", async () => {
        const interruption = stack.createInterruptionState();
        const child = controlledChild(41001);
        const completion = monitor(child, interruption, async () => {
            throw new Error("controlled drain failure");
        });
        if (!completion) return;
        interruption.interrupt("SIGTERM");
        child.emit("close", 143);
        await expect(completion).rejects.toThrow("controlled drain failure");
        await expect(interruption.waitForOperations()).rejects.toThrow("controlled drain failure");
        expect(() => interruption.beginCleanup()).toThrow("controlled drain failure");
    });

    it("settles a failed termination without waiting for a missing close event", async () => {
        const interruption = stack.createInterruptionState();
        const child = controlledChild(41002);
        const completion = monitor(child, interruption, async () => {
            throw new Error("drain failed without close");
        });
        if (!completion) return;
        const started = Date.now();
        interruption.interrupt("SIGINT");
        await expect(completion).rejects.toThrow("drain failed without close");
        expect(Date.now() - started).toBeLessThan(500);
        await expect(interruption.waitForOperations()).rejects.toThrow(
            "drain failed without close",
        );
        expect(() => interruption.beginCleanup()).toThrow("drain failed without close");
    });

    it("bounds a termination attempt that never settles", async () => {
        const interruption = stack.createInterruptionState();
        const child = controlledChild(41005);
        const completion = monitor(child, interruption, () => new Promise(() => {}), 25);
        if (!completion) return;
        const started = Date.now();
        interruption.interrupt("SIGTERM");
        await expect(completion).rejects.toThrow("25ms");
        expect(Date.now() - started).toBeLessThan(500);
        await expect(interruption.waitForOperations()).rejects.toThrow("25ms");
        expect(() => interruption.beginCleanup()).toThrow("25ms");
    });

    it("keeps cleanup closed when one of two concurrent owned operations cannot drain", async () => {
        const interruption = stack.createInterruptionState();
        const drainedChild = controlledChild(41003);
        const failedChild = controlledChild(41004);
        const drained = monitor(drainedChild, interruption, async () => {});
        const failed = monitor(failedChild, interruption, async () => {
            throw new Error("second operation did not drain");
        });
        if (!drained || !failed) return;
        interruption.interrupt("SIGTERM");
        drainedChild.emit("close", 143);
        failedChild.emit("close", 143);
        const outcomes = await Promise.allSettled([drained, failed]);
        expect(outcomes.map((outcome) => outcome.status)).toEqual(["rejected", "rejected"]);
        expect(String((outcomes[1] as PromiseRejectedResult).reason)).toContain(
            "second operation did not drain",
        );
        await expect(interruption.waitForOperations()).rejects.toThrow(
            "second operation did not drain",
        );
        expect(() => interruption.beginCleanup()).toThrow("second operation did not drain");
    });

    it("records a redacted fail-closed artifact when resource deletion is skipped", () => {
        expect(stack.recordFailClosedInterruption).toBeTypeOf("function");
        if (typeof stack.recordFailClosedInterruption !== "function") return;
        const root = mkdtempSync(resolve(tmpdir(), "taxi-fail-closed-"));
        const secret = "controlled-secret-value";
        try {
            const error = stack.recordFailClosedInterruption({
                artifacts: root,
                error: new Error(`drain failed for ${secret}`),
                knownSecrets: [secret],
                root: "C:\\retained-owned-run",
                state: { project: "taxi12-controlled" },
            });
            const artifact = readFileSync(resolve(root, "failure.log"), "utf8");
            expect(error.message).toContain("resource deletion was skipped");
            expect(artifact).toContain("resource deletion was skipped");
            expect(artifact).toContain("C:\\retained-owned-run");
            expect(artifact).toContain("[REDACTED]");
            expect(artifact).not.toContain(secret);
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });
});
