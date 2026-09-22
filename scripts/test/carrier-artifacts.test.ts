import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
    MANIFEST_PATH,
    PINNED_PACKAGES,
    PINNED_SOURCES,
    SUPERSEDED_VENDOR,
    VENDOR_DIR,
    assertCandidateExport,
    dockerfileStages,
    installsDependencies,
    isOptOut,
    localWorkflowCalls,
    packageRootFrom,
    pinnedSourceMismatch,
    readJson,
    unverifiedInstall,
    workflowJobs,
    workspaceManifests,
} from "../carrier-artifacts/lib.mjs";

const REPO = resolve(import.meta.dirname, "../..");
const at = (...parts: string[]) => join(REPO, ...parts);
const lines = (...parts: string[]) => readFileSync(at(...parts), "utf8").split(/\r?\n/);
const WORKFLOWS = readdirSync(at(".github", "workflows")).filter((name) => /\.ya?ml$/.test(name));

// Literals, not imported constants: an assertion against the value under test
// would pass for any build. Both were added in the pinned source commit.
const CANDIDATES = [
    ["@arkade-os/sdk", "SendDeadlineExceededError"],
    ["@arkade-os/swap", "FundingOutputMismatchError"],
] as const;

describe("frozen carrier artifacts", () => {
    it("passes the built-in-Node verification with every scan group run", () => {
        const output = execFileSync(
            process.execPath,
            [at("scripts/carrier-artifacts/verify.mjs")],
            {
                cwd: REPO,
                encoding: "utf8",
            },
        );
        expect(output).toContain(`${PINNED_PACKAGES.length} archives`);
        expect(output).toContain("Dockerfile and workflows checked");
        expect(output).toContain("candidate exports confirmed from 3 importers");
    }, 30_000);

    it("resolves the candidate build, not the registry build of the same version", async () => {
        for (const importer of [
            "package.json",
            "packages/app/package.json",
            "packages/client/package.json",
        ])
            for (const [name, symbol] of CANDIDATES)
                await assertCandidateExport(packageRootFrom(at(importer), name), name, symbol);
    });

    it("refuses an archive packed from anywhere but the pinned source", () => {
        const { artifacts } = readJson(at(MANIFEST_PATH));
        expect(artifacts).toHaveLength(PINNED_PACKAGES.length);
        for (const artifact of artifacts) {
            expect(pinnedSourceMismatch(artifact)).toBeUndefined();
            const pinned = PINNED_SOURCES[artifact.package as keyof typeof PINNED_SOURCES];
            expect(artifact.source.commit).toBe(pinned.commit);
            expect(artifact.file).toContain(pinned.commit.slice(0, 8));
            for (const wrong of [
                { ...artifact, source: { ...artifact.source, commit: "0".repeat(40) } },
                { ...artifact, source: { ...artifact.source, directory: "packages/wrong" } },
                {
                    ...artifact,
                    source: { ...artifact.source, repository: "https://example.invalid" },
                },
                { ...artifact, package: "@arkade-os/unpinned" },
            ])
                expect(pinnedSourceMismatch(wrong)).toBeTypeOf("string");
        }
    });

    it("leaves no tracked resolution pointing at the untracked vendor directory", () => {
        for (const manifest of [...workspaceManifests(REPO), "pnpm-lock.yaml"])
            expect(readFileSync(at(...manifest.split("/")), "utf8")).not.toContain(
                SUPERSEDED_VENDOR,
            );
    });

    it("derives the manifests to scan from the workspace file rather than a list", () => {
        const manifests = workspaceManifests(REPO);
        expect(manifests).toContain("package.json");
        for (const entry of readdirSync(at("packages"), { withFileTypes: true }))
            if (entry.isDirectory())
                expect(manifests).toContain(`packages/${entry.name}/package.json`);
    });
});

describe("installing-path scan", () => {
    it.each([
        ["            - run: pnpm install --frozen-lockfile", true],
        ["            - run: pnpm i", true],
        ["              run: npm ci", true],
        ["RUN corepack pnpm install --frozen-lockfile", true],
        ["                    if pnpm install --frozen-lockfile; then exit 0; fi", true],
        ["                  run_install: true", true],
        ["                  run_install: |", true],
        ["            - run: yarn", true],
        ["                  run_install: false", false],
        ["            - uses: pnpm/action-setup@v4", false],
        ["            - run: pnpm -r build", false],
        ["            - run: pnpm vectors", false],
        ["            - run: node scripts/carrier-artifacts/verify.mjs", false],
    ])("reads %j as an install: %s", (line, expected) => {
        expect(installsDependencies(line)).toBe(expected);
    });

    it.each([
        [[], undefined],
        [["RUN node scripts/carrier-artifacts/verify.mjs", "RUN pnpm install"], undefined],
        [["RUN pnpm install", "RUN node scripts/carrier-artifacts/verify.mjs"], 1],
        [["# RUN node scripts/carrier-artifacts/verify.mjs", "RUN pnpm install"], 2],
        [["RUN echo scripts/carrier-artifacts/verify.mjs", "RUN pnpm install"], 2],
        [
            [
                "            - if: false",
                "              run: pnpm verify:artifacts",
                "            - run: pnpm i",
            ],
            3,
        ],
        [
            [
                "            - name: gate",
                "              if: false",
                "              run: pnpm verify:artifacts",
                "            - run: pnpm i",
            ],
            4,
        ],
        [["  # carrier-artifacts: not a dependency install", "  run: pnpm install"], undefined],
        [["  # carrier-artifacts: not a dependency install", "", "  run: pnpm install"], 3],
        [
            [
                "  run: pnpm install",
                "  # carrier-artifacts: not a dependency install",
                "  run: pnpm i",
            ],
            1,
        ],
    ])("locates the first unverified install in %j", (source, expected) => {
        expect(unverifiedInstall(source)).toBe(expected);
    });

    it("treats a later Dockerfile stage as its own filesystem", () => {
        const leak = [
            "FROM node AS build",
            "RUN node scripts/carrier-artifacts/verify.mjs",
            "RUN pnpm install",
            "FROM node AS runtime",
            "RUN pnpm add -g something",
        ];
        expect(unverifiedInstall(leak)).toBeUndefined();
        const stages = [...dockerfileStages(leak).values()];
        expect(stages).toHaveLength(2);
        expect(unverifiedInstall(stages[1])).toBe(2);

        const real = dockerfileStages(lines("Dockerfile"));
        expect(real.size).toBeGreaterThan(1);
        for (const stage of real.values()) expect(unverifiedInstall(stage)).toBeUndefined();
    });

    it.each(WORKFLOWS)("reads every job of %s in three shapes", (file) => {
        const source = readFileSync(at(".github", "workflows", file), "utf8");
        const installs = (body: string[]) =>
            body.filter((line) => !/^\s*#/.test(line) && installsDependencies(line)).length;
        for (const shape of [
            source,
            source.replace(/^jobs:$/m, "jobs: # what this file builds"),
            source.replaceAll(/^ {4}/gm, "        ").replace(/^ {8}(\w+):$/m, "    $1:"),
        ]) {
            const jobs = workflowJobs(shape);
            expect(jobs.size).toBeGreaterThan(0);
            expect([...jobs.keys()]).not.toContain("push");
            expect([...jobs.keys()]).not.toContain("pull_request");
            expect([...jobs.values()].reduce((total, job) => total + installs(job), 0)).toBe(
                installs(shape.split(/\r?\n/)),
            );
            for (const job of jobs.values()) expect(unverifiedInstall(job)).toBeUndefined();
        }
    });

    it("scans every local target a job delegates to, whatever its path", () => {
        const scanned = ["Dockerfile", ...WORKFLOWS.map((file) => `.github/workflows/${file}`)];
        const called = WORKFLOWS.flatMap((file) =>
            localWorkflowCalls(lines(".github", "workflows", file)),
        );
        expect(called.length).toBeGreaterThan(0);
        for (const target of called) expect(scanned).toContain(target);
        // A target outside the scanned directory must still be seen, or the
        // binding could only fail for paths it already accepted.
        expect(localWorkflowCalls(["        uses: ./.github/actions/elsewhere"])).toEqual([
            ".github/actions/elsewhere",
        ]);
        expect(localWorkflowCalls(["        uses: actions/checkout@v5"])).toEqual([]);
    });

    it("counts an exemption only where one is written as an adjacent comment", () => {
        const marker = "  # carrier-artifacts: not a dependency install";
        expect(isOptOut(marker)).toBe(true);
        expect(isOptOut(marker.replace("#", "name:"))).toBe(false);
        expect(isOptOut(undefined)).toBe(false);
        const scanned = ["Dockerfile", ...WORKFLOWS.map((file) => `.github/workflows/${file}`)];
        const written = scanned.flatMap((file) => lines(...file.split("/"))).filter(isOptOut);
        expect(written.length).toBeLessThanOrEqual(1);
    });
});

describe("the Docker dependency layer", () => {
    it("copies the archives and verifies them before it installs", () => {
        const build = [...dockerfileStages(lines("Dockerfile")).values()][0];
        const copiesAt = build.findIndex((line) => new RegExp(`^COPY .*${VENDOR_DIR}`).test(line));
        const installsAt = build.findIndex((line) => installsDependencies(line));
        expect(copiesAt).toBeGreaterThanOrEqual(0);
        expect(copiesAt).toBeLessThan(installsAt);
    });
});
