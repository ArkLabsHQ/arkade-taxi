import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { ASSETS, DIGESTS, TAG, assetFor, verifyAsset } from "../get-arkadec.mjs";

const REPO = resolve(import.meta.dirname, "../..");
const win = ASSETS["win32-x64"];

describe("pinned arkadec download", () => {
    it("refuses a tampered archive, naming the digest it wanted", () => {
        const tampered = Uint8Array.from([1, 2, 3]);
        expect(() => verifyAsset(win, tampered)).toThrow(DIGESTS[win]);
    });

    it.each([true, false])("authenticates a cached executable (archive present: %s)", (archive) => {
        const scratch = mkdtempSync(join(tmpdir(), "taxi-arkadec-cache-"));
        try {
            const cache = join(scratch, ".reference/arkadec");
            mkdirSync(cache, { recursive: true });
            writeFileSync(
                join(cache, process.platform === "win32" ? "arkadec.exe" : "arkadec"),
                "untrusted",
            );
            const asset = assetFor();
            if (archive) writeFileSync(join(cache, asset), "tampered");
            const source = pathToFileURL(resolve(REPO, "scripts/get-arkadec.mjs")).href;
            const result = spawnSync(
                process.execPath,
                [
                    "--input-type=module",
                    "--eval",
                    [
                        'globalThis.fetch = async () => { throw new Error("download required"); };',
                        `const { fetchArkadec } = await import(${JSON.stringify(source)});`,
                        "await fetchArkadec();",
                    ].join("\n"),
                ],
                { cwd: scratch, encoding: "utf8" },
            );
            expect(result.status).not.toBe(0);
            expect(result.stderr).toContain(archive ? DIGESTS[asset] : "download required");
        } finally {
            rmSync(scratch, { recursive: true, force: true });
        }
    });

    it("refuses an asset the release never published", () => {
        expect(() => verifyAsset("arkadec-from-somewhere-else.zip", new Uint8Array())).toThrow(
            /no pinned digest/,
        );
    });

    it("pins every platform the release builds, under one tag", () => {
        expect(TAG).toBe("v0.1.0-test");
        expect(Object.values(ASSETS).sort()).toEqual(Object.keys(DIGESTS).sort());
        for (const [name, digest] of Object.entries(DIGESTS)) {
            expect(name).toContain(TAG);
            expect(digest).toMatch(/^[0-9a-f]{64}$/);
        }
    });

    it("refuses a host the release has no binary for", () => {
        expect(() => assetFor("sunos", "sparc")).toThrow(/sunos-sparc/);
        expect(assetFor("linux", "x64")).toBe(ASSETS["linux-x64"]);
    });

    // CI runs linux-x64, so a missing digest there breaks the artifact gate, not a laptop.
    it("keeps the CI host's digest reachable from the lockfile's node engine", () => {
        const ci = readFileSync(resolve(REPO, ".github/workflows/ci.yml"), "utf8");
        expect(ci).toContain("ubuntu-latest");
        expect(DIGESTS[ASSETS["linux-x64"]]).toMatch(/^[0-9a-f]{64}$/);
    });
});
