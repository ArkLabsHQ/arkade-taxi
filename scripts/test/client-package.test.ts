import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { packageManagerInvocation } from "../lib/harness.mjs";

it("packs executable client entries and declarations without development files or imports", () => {
    const root = mkdtempSync(join(tmpdir(), "taxi-client-pack-"));
    try {
        const invocation = packageManagerInvocation(["pack", "--pack-destination", root, "--json"]);
        const packed = JSON.parse(
            execFileSync(invocation.command, invocation.args, {
                cwd: fileURLToPath(new URL("../../packages/client", import.meta.url)),
                encoding: "utf8",
                timeout: 20_000,
            }),
        );
        const archive = resolve(packed.filename);
        expect(archive.startsWith(resolve(root) + sep)).toBe(true);
        const entries = execFileSync("tar", ["-tzf", archive], { encoding: "utf8" })
            .trim()
            .split(/\r?\n/);
        expect(entries).toContain("package/dist/index.js");
        expect(entries).toContain("package/dist/index.d.ts");
        expect(entries.filter((entry) => /\/(?:src|test|tests)\/|\/tsconfig/.test(entry))).toEqual(
            [],
        );
        const manifest = JSON.parse(
            execFileSync("tar", ["-xOf", archive, "package/package.json"], {
                encoding: "utf8",
            }),
        );
        for (const entry of [
            manifest.main,
            manifest.types,
            ...Object.values(manifest.exports["."]),
        ])
            expect(entries).toContain(`package/${String(entry).replace(/^\.\//, "")}`);
        for (const entry of entries.filter((entry) => /\.(?:js|d\.ts)$/.test(entry))) {
            const output = execFileSync("tar", ["-xOf", archive, entry], { encoding: "utf8" });
            const imports = [...output.matchAll(/(?:from\s*|import\s*\(?)["']([^"']+)["']/g)];
            expect(
                imports
                    .map((match) => match[1])
                    .filter((path) => /(?:^|\/)(?:src|test|tests)(?:\/|$)|\.ts$/.test(path)),
            ).toEqual([]);
        }
    } finally {
        if (!resolve(root).startsWith(resolve(tmpdir()) + sep)) throw new Error("unsafe temp path");
        rmSync(root, { recursive: true, force: true });
    }
}, 30_000);
