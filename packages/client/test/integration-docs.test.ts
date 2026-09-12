import { execFileSync } from "node:child_process";
import {
    existsSync,
    mkdirSync,
    mkdtempSync,
    readFileSync,
    realpathSync,
    rmSync,
    symlinkSync,
    writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";
const { packageManagerInvocation } = (await import(
    new URL("../../../scripts/lib/harness.mjs", import.meta.url).href
)) as { packageManagerInvocation(args: string[]): { command: string; args: string[] } };

const integrationGuide = readFileSync(
    new URL("../../../docs/integration-js.md", import.meta.url),
    "utf8",
);

describe("JavaScript integration guide", () => {
    it("typechecks every TypeScript example against packed public exports", () => {
        const examples = [
            ...integrationGuide.matchAll(/^```(?:ts|typescript)\s*\r?\n([\s\S]*?)^```\s*$/gm),
        ].map((match) => match[1]);
        expect(examples.length).toBeGreaterThanOrEqual(2);
        const root = mkdtempSync(join(tmpdir(), "taxi-integration-docs-"));
        const repo = fileURLToPath(new URL("../../../", import.meta.url));
        try {
            const packages = join(root, "node_modules", "@arkade-taxi");
            mkdirSync(packages, { recursive: true });
            for (const name of ["protocol", "covenant", "client"]) {
                const cwd = join(repo, "packages", name);
                const build = packageManagerInvocation(["build"]);
                execFileSync(build.command, build.args, { cwd, timeout: 30_000, stdio: "pipe" });
                const pack = packageManagerInvocation([
                    "pack",
                    "--pack-destination",
                    root,
                    "--json",
                ]);
                const archive = JSON.parse(
                    execFileSync(pack.command, pack.args, {
                        cwd,
                        timeout: 20_000,
                        encoding: "utf8",
                    }),
                ).filename;
                expect(resolve(archive).startsWith(resolve(root) + sep)).toBe(true);
                const target = join(packages, name);
                mkdirSync(target);
                execFileSync("tar", ["-xzf", archive, "-C", target, "--strip-components=1"], {
                    timeout: 10_000,
                });
                if (existsSync(join(cwd, "node_modules")))
                    symlinkSync(
                        realpathSync(join(cwd, "node_modules")),
                        join(target, "node_modules"),
                        "junction",
                    );
            }
            mkdirSync(join(root, "node_modules", "@arkade-os"));
            symlinkSync(
                realpathSync(join(repo, "node_modules", "@arkade-os", "sdk")),
                join(root, "node_modules", "@arkade-os", "sdk"),
                "junction",
            );
            writeFileSync(join(root, "package.json"), JSON.stringify({ type: "module" }));
            const files = examples.map((code, index) => {
                const file = join(root, `example-${index}.ts`);
                writeFileSync(file, code);
                return file;
            });
            const program = ts.createProgram(files, {
                target: ts.ScriptTarget.ES2022,
                module: ts.ModuleKind.NodeNext,
                moduleResolution: ts.ModuleResolutionKind.NodeNext,
                strict: true,
                noEmit: true,
                skipLibCheck: true,
                types: [],
            });
            const diagnostics = ts.getPreEmitDiagnostics(program);
            expect(
                ts.formatDiagnosticsWithColorAndContext(diagnostics, {
                    getCanonicalFileName: (file) => file,
                    getCurrentDirectory: () => root,
                    getNewLine: () => "\n",
                }),
            ).toBe("");
        } finally {
            if (!resolve(root).startsWith(resolve(tmpdir()) + sep))
                throw new Error("unsafe temp path");
            rmSync(root, { recursive: true, force: true });
        }
    }, 60_000);

    it("uses sender composition and receiver events without polling examples", () => {
        expect(integrationGuide).toContain("requestVerifiedQuote");
        expect(integrationGuide).toContain("subscribeClaims");
        expect(integrationGuide).not.toMatch(
            /setInterval|setTimeout|\bwhile\s*\(|\/v1\/transfers\/:id/,
        );
    });

    it("states the ambient fetch trust boundary for covenant providers", () => {
        expect(integrationGuide).toMatch(/SDK REST providers use the realm's `globalThis\.fetch`/);
        expect(integrationGuide).toMatch(/`TaxiClient\(\{ fetch \}\)` does not configure/);
        expect(integrationGuide).toMatch(/same-realm code.*replace or\s+intercept.*global fetch/is);
        expect(integrationGuide).toMatch(/TLS.*reverse\s+proxy/is);
    });
});
