import { spawnSync } from "node:child_process";
import {
    copyFileSync,
    mkdirSync,
    mkdtempSync,
    readFileSync,
    readdirSync,
    rmSync,
    writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

type Manifest = Record<string, unknown> & {
    private?: boolean;
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
};

const REPO = resolve(import.meta.dirname, "../..");
const GATE = join(REPO, "scripts/carrier-artifacts/release-gate.mjs");
const read = (...parts: string[]) => JSON.parse(readFileSync(join(REPO, ...parts), "utf8"));
const { artifacts } = read("vendor/carrier/manifest.json") as {
    artifacts: { package: string; version: string; source: { commit: string } }[];
};
const claimed = new Map(artifacts.map((a) => [a.package, a.version]));
const COMMIT = artifacts[0]!.source.commit;
const unclaimed = (version: string) => version.replace(/\d+$/, (n) => String(Number(n) + 1));

const gate = (root: string, ack = "") =>
    spawnSync(process.execPath, [GATE, root], {
        encoding: "utf8",
        env: { ...process.env, CARRIER_RELEASE_ACK: ack },
    });

const roots: string[] = [];
afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** This workspace's manifests in a scratch root, each package passed through `edit`. */
const workspace = (edit: (dir: string, manifest: Manifest) => void = () => {}): string => {
    const root = mkdtempSync(join(tmpdir(), "release-gate-"));
    roots.push(root);
    for (const file of ["package.json", "pnpm-workspace.yaml", "vendor/carrier/manifest.json"]) {
        mkdirSync(dirname(join(root, file)), { recursive: true });
        copyFileSync(join(REPO, file), join(root, file));
    }
    for (const dir of readdirSync(join(REPO, "packages"))) {
        const manifest = read("packages", dir, "package.json") as Manifest;
        edit(dir, manifest);
        mkdirSync(join(root, "packages", dir), { recursive: true });
        writeFileSync(join(root, "packages", dir, "package.json"), JSON.stringify(manifest));
    }
    return root;
};

const redeclare = (manifest: Manifest, spec: (name: string, version: string) => string) => {
    for (const [name, version] of claimed)
        if (manifest.dependencies?.[name] !== undefined)
            manifest.dependencies[name] = spec(name, version);
};

describe("release gate", () => {
    it("fails on this repository today, naming every published declaration", () => {
        const run = gate(REPO);
        expect(run.status).toBe(1);
        for (const [dir, name] of [
            ["client", "@arkade-os/sdk"],
            ["client", "@arkade-os/swap"],
            ["covenant", "@arkade-os/sdk"],
            ["app", "@arkade-os/swap"],
        ])
            expect(run.stderr).toContain(`packages/${dir}/package.json dependencies ${name}@`);
    });

    it("passes once every declaration is an exact version the candidates do not claim", () => {
        const run = gate(workspace((_, m) => redeclare(m, (_, v) => unclaimed(v))));
        expect(run.stderr).toBe("");
        expect(run.status).toBe(0);
    });

    it.each([
        ["a range admitting the candidate", (v: string) => `^${v}`],
        ["a range that happens to exclude it", (v: string) => `^${unclaimed(v)}`],
        ["a dist-tag", () => "latest"],
        ["build metadata on the claimed number", (v: string) => `${v}+rebuilt`],
    ])("refuses %s", (_case, spec) => {
        const root = workspace((dir, m) =>
            redeclare(m, (_, v) => (dir === "client" ? spec(v) : unclaimed(v))),
        );
        const run = gate(root);
        expect(run.status).toBe(1);
        expect(run.stderr).toContain("packages/client/package.json");
        expect(run.stderr).not.toContain("packages/covenant/package.json");
    });

    it("ignores devDependencies and private packages, which no consumer installs", () => {
        const root = workspace((dir, m) => {
            if (dir === "app") m.private = true;
            else if (dir === "client") {
                m.devDependencies = { ...m.devDependencies, ...m.dependencies };
                for (const name of claimed.keys()) delete m.dependencies?.[name];
            } else redeclare(m, (_, v) => unclaimed(v));
        });
        expect(gate(root).status).toBe(0);
    });

    it("yields only to an acknowledgement naming the candidates' own commit", () => {
        const acked = gate(REPO, COMMIT);
        expect(acked.status).toBe(0);
        expect(acked.stdout).toContain("OVERRIDDEN");
        const stale = gate(REPO, "0".repeat(40));
        expect(stale.status).toBe(1);
        expect(stale.stderr).toContain(`it is set to ${"0".repeat(40)}`);
    });

    it("runs unguarded in the packages job, before anything is published", () => {
        const release = readFileSync(join(REPO, ".github/workflows/release.yml"), "utf8");
        const job = release.slice(release.indexOf("\n    packages:\n"));
        const step = job.indexOf("run: node scripts/carrier-artifacts/release-gate.mjs");
        expect(step).toBeGreaterThan(0);
        expect(step).toBeLessThan(job.indexOf("run: pnpm publish -r"));
        const block = job.slice(
            job.lastIndexOf("\n            - ", step),
            job.indexOf("\n\n", step),
        );
        expect(block).not.toMatch(/^\s+(?:-\s+)?(?:if|continue-on-error):/m);
    });
});
