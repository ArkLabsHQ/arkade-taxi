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

    const fixture = (sources: string[], emitted: string[]) => {
        const root = mkdtempSync(join(tmpdir(), "dist-trace-"));
        for (const [dir, names, ext] of [
            ["src", sources, ".ts"],
            ["dist", emitted, ".js"],
        ] as const)
            for (const name of names) {
                mkdirSync(join(root, dir, ...name.split("/").slice(0, -1)), { recursive: true });
                writeFileSync(join(root, dir, `${name}${ext}`), "");
            }
        return root;
    };

    it.each([
        ["an orphan", ["index", "a/b"], ["index", "a/b", "a/gone"], "dist/a/gone.js has no src"],
        ["a module that never emitted", ["index", "a/b"], ["index"], "emitted no dist/a/b.js"],
        ["nothing to trace back to", [], ["index"], "has no src/"],
    ])("refuses %s", (_case, sources, emitted, reason) => {
        const root = fixture(sources, emitted);
        try {
            expect(distMismatch(root)).toContain(reason);
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });

    it("accepts a build that traces one-for-one", () => {
        const root = fixture(["index", "a/b"], ["index", "a/b"]);
        try {
            expect(distMismatch(root)).toBeUndefined();
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
