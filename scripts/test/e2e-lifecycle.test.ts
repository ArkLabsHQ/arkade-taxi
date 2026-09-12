import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import * as stack from "../e2e-stack.mjs";

const source = readFileSync(resolve(import.meta.dirname, "../e2e-stack.mjs"), "utf8");

const waitFor = async (ready: () => boolean) => {
    for (let attempt = 0; attempt < 300; attempt++) {
        if (ready()) return;
        await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error("timed out waiting for child process state");
};

const processExists = (pid: number) => {
    try {
        process.kill(pid, 0);
        return true;
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
        throw error;
    }
};

describe("E2E artifact lifecycle", () => {
    it("packs the client and builds the owned production image before stack startup", () => {
        const start = source.indexOf('[state.runner, "start"');
        expect(start).toBeGreaterThan(0);
        expect(source.indexOf("await packClient(root, childEnv)")).toBeLessThan(start);
        expect(source.indexOf("taxiImage = `arkade-taxi:e2e-${id}`")).toBeLessThan(start);
        expect(source.indexOf('"build",\n                "-f"')).toBeLessThan(start);
    });

    it("captures one redacted stack section per selected service on every outcome", () => {
        expect(stack.stackDiagnosticRequests).toBeTypeOf("function");
        if (typeof stack.stackDiagnosticRequests !== "function") return;
        expect(stack.stackDiagnosticRequests()).toEqual([
            ["compose ps", ["ps", "--all", "--format", "json"]],
            ["bitcoin", ["logs", "--no-color", "--tail", "300", "bitcoin"]],
            ["bitcoin-miner", ["logs", "--no-color", "--tail", "300", "bitcoin-miner"]],
            ["postgres", ["logs", "--no-color", "--tail", "300", "postgres"]],
            ["nbxplorer", ["logs", "--no-color", "--tail", "300", "nbxplorer"]],
            ["fulcrum", ["logs", "--no-color", "--tail", "300", "fulcrum"]],
            ["mempool_api", ["logs", "--no-color", "--tail", "300", "mempool_api"]],
            ["mempool_web", ["logs", "--no-color", "--tail", "300", "mempool_web"]],
            ["arkd-wallet", ["logs", "--no-color", "--tail", "300", "arkd-wallet"]],
            ["arkd", ["logs", "--no-color", "--tail", "300", "arkd"]],
            ["emulator", ["logs", "--no-color", "--tail", "300", "emulator"]],
        ]);
        const successStart = source.indexOf("const skipped = results.numPendingTests");
        const success = source.slice(
            successStart,
            source.indexOf("    } catch (error)", successStart),
        );
        expect(success).toContain("await captureStackDiagnostics(state, artifacts, knownSecrets)");
    });

    it("turns SIGINT and SIGTERM into bounded cooperative cleanup", () => {
        expect(stack.createInterruptionState).toBeTypeOf("function");
        if (typeof stack.createInterruptionState !== "function") return;
        const interruption = stack.createInterruptionState();
        const activeSignal = interruption.operationSignal();
        expect(activeSignal?.aborted).toBe(false);
        expect(interruption.interrupt("SIGTERM")).toBe(true);
        expect(activeSignal?.aborted).toBe(true);
        expect(() => interruption.assertOperationAllowed()).toThrow("SIGTERM");
        expect(interruption.interrupt("SIGINT")).toBe(false);
        interruption.beginCleanup();
        expect(interruption.operationSignal()).toBeUndefined();
        expect(interruption.commandTimeout()).toBe(30_000);
        expect(() => interruption.assertOperationAllowed()).not.toThrow();
        expect(source).toMatch(/process\.on\("SIGINT", signalHandlers\.SIGINT\)/);
        expect(source).toMatch(/process\.on\("SIGTERM", signalHandlers\.SIGTERM\)/);
        expect(source).toContain("signal: activeInterruption?.operationSignal()");
        const cleanup = source.indexOf("    } finally {");
        expect(source.indexOf("await interruption.waitForOperations()", cleanup)).toBeLessThan(
            source.indexOf("interruption.beginCleanup()", cleanup),
        );
    });

    it("does not release interruption cleanup until the owned child process tree drains", async () => {
        expect(stack.startOwnedProcess).toBeTypeOf("function");
        if (typeof stack.startOwnedProcess !== "function") return;
        const root = mkdtempSync(resolve(tmpdir(), "taxi-e2e-process-"));
        const pidFile = resolve(root, "descendant.pid");
        const script = [
            'const { spawn } = require("node:child_process")',
            'const { writeFileSync } = require("node:fs")',
            'const descendant = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" })',
            "writeFileSync(process.argv[1], String(descendant.pid))",
            "setInterval(() => {}, 1000)",
        ].join(";");
        let descendantPid: number | undefined;
        let ownedPid: number | undefined;
        let childClosed = false;
        let cleanupStarted = false;
        try {
            const interruption = stack.createInterruptionState(1_000);
            expect(interruption.waitForOperations).toBeTypeOf("function");
            if (typeof interruption.waitForOperations !== "function") return;
            const owned = stack.startOwnedProcess(process.execPath, ["-e", script, pidFile], {
                interruption,
                print: false,
            });
            ownedPid = owned.child.pid;
            owned.child.once("close", () => (childClosed = true));
            const completion = owned.completion.catch((error: unknown) => error);
            await waitFor(() => existsSync(pidFile));
            descendantPid = Number(readFileSync(pidFile, "utf8"));
            expect(processExists(descendantPid)).toBe(true);
            interruption.interrupt("SIGTERM");
            expect(() => interruption.beginCleanup()).toThrow("owned process");
            await interruption.waitForOperations();
            interruption.beginCleanup();
            cleanupStarted = true;
            expect(childClosed).toBe(true);
            expect(processExists(descendantPid)).toBe(false);
            expect(await completion).toMatchObject({ message: expect.stringContaining("SIGTERM") });
            expect(cleanupStarted).toBe(true);
        } finally {
            if (!descendantPid && existsSync(pidFile))
                descendantPid = Number(readFileSync(pidFile, "utf8"));
            if (descendantPid && processExists(descendantPid))
                process.kill(descendantPid, "SIGKILL");
            if (ownedPid && processExists(ownedPid)) process.kill(ownedPid, "SIGKILL");
            rmSync(root, { recursive: true, force: true });
        }
    });
});
