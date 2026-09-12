import { describe, expect, it } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
    existsSync,
    linkSync,
    mkdtempSync,
    readFileSync,
    readdirSync,
    rmSync,
    writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { prepareResultPublication } from "../lib/harness.mjs";

const exec = promisify(execFile);

describe("current E2E result publication", () => {
    it("removes previous results before stack setup can fail without starting tests", () => {
        const directory = mkdtempSync(join(tmpdir(), "taxi12-results-"));
        const destinations = [join(directory, "e2e-results.json"), join(directory, "results.json")];
        try {
            for (const path of destinations) writeFileSync(path, '{"previousRun":true}');
            prepareResultPublication({ source: join(directory, "current.json"), destinations });
            expect(destinations.map(existsSync)).toEqual([false, false]);
        } finally {
            rmSync(directory, { recursive: true, force: true });
        }
    });

    it("publishes the successful test command result with secrets redacted", async () => {
        const directory = mkdtempSync(join(tmpdir(), "taxi12-results-"));
        const source = join(directory, "current.json");
        const destinations = [join(directory, "e2e-results.json"), join(directory, "results.json")];
        try {
            const run = prepareResultPublication({
                source,
                destinations,
                knownSecrets: ["test-secret"],
            });
            await expect(
                run(async () => {
                    writeFileSync(
                        source,
                        JSON.stringify({ numPassedTests: 12, log: "test-secret" }),
                    );
                    return "completed";
                }),
            ).resolves.toBe("completed");
            for (const path of destinations)
                expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({
                    numPassedTests: 12,
                    log: "[REDACTED]",
                });
        } finally {
            rmSync(directory, { recursive: true, force: true });
        }
    });

    it("publishes the current failed child result while retaining its nonzero exit", async () => {
        const directory = mkdtempSync(join(tmpdir(), "taxi12-results-"));
        const source = join(directory, "current.json");
        const destinations = [join(directory, "e2e-results.json"), join(directory, "results.json")];
        try {
            for (const path of destinations) writeFileSync(path, '{"previousRun":true}');
            const run = prepareResultPublication({ source, destinations });
            await expect(
                run(() =>
                    exec(process.execPath, [
                        "--input-type=module",
                        "-e",
                        'import { writeFileSync } from "node:fs"; writeFileSync(process.argv[1], JSON.stringify({ numFailedTests: 3, numPassedTests: 9 })); process.exitCode = 7;',
                        source,
                    ]),
                ),
            ).rejects.toMatchObject({ code: 7 });
            for (const path of destinations)
                expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({
                    numFailedTests: 3,
                    numPassedTests: 9,
                });
        } finally {
            rmSync(directory, { recursive: true, force: true });
        }
    });

    it("leaves no stale result when the test command fails before producing JSON", async () => {
        const directory = mkdtempSync(join(tmpdir(), "taxi12-results-"));
        const destinations = [join(directory, "e2e-results.json"), join(directory, "results.json")];
        const failure = new Error("test command failed before reporting");
        try {
            for (const path of destinations) writeFileSync(path, '{"previousRun":true}');
            const run = prepareResultPublication({
                source: join(directory, "current.json"),
                destinations,
            });
            await expect(
                run(async () => {
                    throw failure;
                }),
            ).rejects.toBe(failure);
            expect(destinations.map(existsSync)).toEqual([false, false]);
        } finally {
            rmSync(directory, { recursive: true, force: true });
        }
    });

    it("does not replace a previous run with a partial JSON report", async () => {
        const directory = mkdtempSync(join(tmpdir(), "taxi12-results-"));
        const source = join(directory, "current.json");
        const destinations = [join(directory, "e2e-results.json"), join(directory, "results.json")];
        try {
            for (const path of destinations) writeFileSync(path, '{"previousRun":true}');
            const run = prepareResultPublication({ source, destinations });
            await expect(
                run(async () => {
                    writeFileSync(source, '{"numPassedTests":');
                }),
            ).rejects.toBeInstanceOf(SyntaxError);
            expect(destinations.map(existsSync)).toEqual([false, false]);
        } finally {
            rmSync(directory, { recursive: true, force: true });
        }
    });

    it("atomically replaces each result file without modifying its previous file identity", async () => {
        const directory = mkdtempSync(join(tmpdir(), "taxi12-results-"));
        const source = join(directory, "current.json");
        const destination = join(directory, "e2e-results.json");
        const previous = join(directory, "previous.json");
        try {
            const run = prepareResultPublication({ source, destinations: [destination] });
            writeFileSync(destination, '{"previousRun":true}');
            linkSync(destination, previous);
            await run(async () => {
                writeFileSync(source, '{"numPassedTests":12}');
            });
            expect(JSON.parse(readFileSync(destination, "utf8"))).toEqual({ numPassedTests: 12 });
            expect(readFileSync(previous, "utf8")).toBe('{"previousRun":true}');
            expect(readdirSync(directory).sort()).toEqual([
                "current.json",
                "e2e-results.json",
                "previous.json",
            ]);
        } finally {
            rmSync(directory, { recursive: true, force: true });
        }
    });
});
