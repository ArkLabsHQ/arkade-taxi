import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { ASSETS, DIGESTS, TAG, assetFor, verifyAsset } from "../get-arkadec.mjs";

const REPO = resolve(import.meta.dirname, "../..");
const win = ASSETS["win32-x64"];

describe("pinned arkadec download", () => {
    it("refuses a tampered archive, naming the digest it wanted", () => {
        const tampered = Uint8Array.from([1, 2, 3]);
        expect(() => verifyAsset(win, tampered)).toThrow(DIGESTS[win]);
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
