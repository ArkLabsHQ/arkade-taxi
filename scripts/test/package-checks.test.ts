import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { distMismatch } from "../lib/package-checks.mjs";
const at = (...parts: string[]) => resolve(import.meta.dirname, "../..", ...parts);

describe("what a package packs", () => {
    it("keeps every Taxi package on one release version", () => {
        const read = (path: string) => JSON.parse(readFileSync(path, "utf8"));
        const release = read(at("package.json")).version;
        for (const entry of readdirSync(at("packages"), { withFileTypes: true }))
            if (entry.isDirectory())
                expect(read(at("packages", entry.name, "package.json")).version).toBe(release);
    });

    const fixture = (sources: string[], mapped: string[]) => {
        const root = mkdtempSync(join(tmpdir(), "dist-trace-"));
        mkdirSync(join(root, "src"), { recursive: true });
        mkdirSync(join(root, "dist"));
        for (const name of sources) {
            mkdirSync(join(root, "src", ...name.split("/").slice(0, -1)), { recursive: true });
            writeFileSync(join(root, "src", `${name}.ts`), "");
        }
        writeFileSync(
            join(root, "dist", "index.js.map"),
            JSON.stringify({ sources: mapped.map((name) => `../src/${name}.ts`) }),
        );
        return root;
    };

    it.each([
        ["an orphan", ["index", "a/b"], ["index", "a/b", "a/gone"], "a/gone.ts, which is not in"],
        ["nothing to trace back to", [], [], "has no src/"],
    ])("refuses %s", (_case, sources, mapped, reason) => {
        const root = fixture(sources, mapped);
        try {
            expect(distMismatch(root)).toContain(reason);
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });

    it("accepts a build that traces to src, type-only modules aside", () => {
        const root = fixture(["index", "a/b", "types"], ["index", "a/b"]);
        try {
            expect(distMismatch(root)).toBeUndefined();
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });

    it("refuses unmapped output left by an earlier compiler build", () => {
        const root = fixture(["index"], ["index"]);
        try {
            writeFileSync(join(root, "dist", "gone.js"), "export const old = true;");
            expect(distMismatch(root)).toContain("gone.js has no source map");
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });

    it("traces nested wallet bundles relative to their source maps", () => {
        const root = fixture(["index", "wallet/index"], ["index"]);
        try {
            const wallet = join(root, "dist", "wallet");
            mkdirSync(wallet);
            const map = join(wallet, "index.js.map");
            writeFileSync(map, JSON.stringify({ sources: ["../../src/wallet/index.ts"] }));
            expect(distMismatch(root)).toBeUndefined();
            writeFileSync(map, JSON.stringify({ sources: ["../../src/wallet/gone.ts"] }));
            expect(distMismatch(root)).toContain("gone.ts, which is not in");
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });

    it("holds for every package this repository builds", () => {
        for (const entry of readdirSync(at("packages"), { withFileTypes: true }))
            if (entry.isDirectory())
                expect(distMismatch(at("packages", entry.name))).toBeUndefined();
    });
});
