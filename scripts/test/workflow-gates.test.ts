import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const readWorkflow = (name: string) =>
    readFileSync(resolve(import.meta.dirname, "../../.github/workflows", name), "utf8");

const job = (source: string, name: string) => {
    const match = new RegExp(
        `^    ${name}:\\n([\\s\\S]*?)(?=^    [a-z][\\w-]*:\\n|(?![\\s\\S]))`,
        "m",
    ).exec(source);
    if (!match) throw new Error(`missing ${name} job`);
    return match[0];
};

describe("required E2E workflow gate", () => {
    const e2e = readWorkflow("e2e.yml");
    const ci = readWorkflow("ci.yml");
    const release = readWorkflow("release.yml");

    it("runs the reusable unfiltered suite for PRs, main, dispatches, and release tags", () => {
        expect(ci).toMatch(/push:\n        branches: \[main\]/);
        expect(ci).toMatch(/    pull_request:/);
        expect(release).toMatch(/tags: \["v\*"\]/);
        expect(e2e).toMatch(/    workflow_call:/);
        expect(e2e).toMatch(/    workflow_dispatch:/);
        expect(job(ci, "e2e")).toContain("uses: ./.github/workflows/e2e.yml");
        expect(job(release, "e2e")).toContain("uses: ./.github/workflows/e2e.yml");
        expect(job(ci, "e2e")).not.toMatch(/^        if:/m);
        expect(job(release, "e2e")).not.toMatch(/^        if:/m);
        expect(ci).not.toMatch(/^\s+(paths|paths-ignore|branches-ignore):/m);
        expect(release).not.toMatch(/^\s+(paths|paths-ignore|branches-ignore):/m);
        expect(e2e).toMatch(/^[ \t]+run: pnpm e2e:stack\r?$/m);
        expect(job(e2e, "e2e")).not.toMatch(/^        if:/m);
        expect(e2e).not.toMatch(/run-e2e|E2E_FILES|files:/);
    });

    it("tests shallow arkade-regtest master and records its resolved SHA immediately", () => {
        expect(e2e).toMatch(
            /repository: ArkLabsHQ\/arkade-regtest\n                  ref: master\n                  fetch-depth: 1\n                  path: arkade-regtest\n\n            - name: Record arkade-regtest master\n              run: \|\n                  REGTEST_SHA=\$\(git -C arkade-regtest rev-parse HEAD\)\n                  echo "arkade-regtest master: \$REGTEST_SHA"/,
        );
        expect(e2e).not.toMatch(/REGTEST_REF|597a6dfd360b8d77b80060fcd0f52daf8370ab12/);
    });

    it("blocks image and package publishing until release E2E succeeds", () => {
        expect(job(release, "image")).toMatch(/needs: e2e/);
        expect(job(release, "packages")).toMatch(/needs: \[e2e, image\]/);
    });

    it("keeps the bounded full harness and publishes deterministic diagnostics always", () => {
        expect(job(e2e, "e2e")).toMatch(/timeout-minutes: 45/);
        expect(e2e).toMatch(/AUTOMINE_INTERVAL: "0"/);
        const upload = e2e.slice(e2e.indexOf("actions/upload-artifact@v4"));
        expect(upload).toMatch(/if: \$\{\{ always\(\) \}\}/);
        for (const artifact of [
            "e2e-artifacts/stack.json",
            "e2e-results.json",
            "e2e-artifacts/results.json",
            "e2e-artifacts/taxi.log",
            "e2e-artifacts/stack.log",
        ])
            expect(upload).toContain(artifact);
    });
});
