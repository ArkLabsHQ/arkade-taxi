#!/usr/bin/env node
/**
 * MAINTAINER COMMAND. Nothing installs, builds or ships it, and the source
 * checkout stays read-only.
 *
 *   node scripts/carrier-artifacts/pack.mjs --sdk <ts-sdk checkout> [--out <dir>]
 *
 * Taxi's own packages are NOT frozen here: they are built from this repository,
 * and `scripts/e2e-stack.mjs` already packs and consumer-installs them.
 */

import { execFileSync } from "node:child_process";
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
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
    CANDIDATE_SDK_SYMBOL,
    CANDIDATE_SWAP_SYMBOL,
    PINNED_PACKAGES,
    PINNED_SOURCES,
    VENDOR_DIR,
    archiveManifest,
    assertCandidateExport,
    packageRootFrom,
    pinnedSourceMismatch,
    readJson,
    sha256,
} from "./lib.mjs";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const harness = await import(pathToFileURL(join(REPO, "scripts", "lib", "harness.mjs")).href);

// Grouped by repository, not by name: a package moved to a second source then
// fails this closure check instead of being packed against whichever checkout.
const SDK_SOURCE = PINNED_SOURCES["@arkade-os/sdk"];
const SDK_PACKAGES = PINNED_PACKAGES.filter(
    (name) => PINNED_SOURCES[name].repository === SDK_SOURCE.repository,
);
if (SDK_PACKAGES.length !== PINNED_PACKAGES.length)
    throw new Error("a pinned package names a source repository this command cannot pack from");

const args = process.argv.slice(2);
const flag = (name) => {
    const index = args.indexOf(`--${name}`);
    return index === -1 ? undefined : args[index + 1];
};

const sdkRoot = flag("sdk") && resolve(flag("sdk"));
const outDir = resolve(REPO, flag("out") ?? VENDOR_DIR);
if (!sdkRoot) {
    process.stderr.write("usage: pack.mjs --sdk <ts-sdk checkout> [--out <dir>]\n");
    process.exit(2);
}

const git = (cwd, ...argv) =>
    execFileSync("git", ["-C", cwd, ...argv], { encoding: "utf8" }).trim();

const assertPinnedSource = (root, source, label) => {
    const head = git(root, "rev-parse", "HEAD");
    if (head !== source.commit)
        throw new Error(`${label} is at ${head}, not the pinned ${source.commit}`);
    const dirty = git(root, "status", "--porcelain");
    if (dirty)
        throw new Error(
            `${label} at ${source.commit} is dirty; pack only from a clean checkout:\n${dirty}`,
        );
};

const runPnpm = (cwd, argv, npmUserConfig) => {
    const invocation = harness.packageManagerInvocation(argv);
    return execFileSync(invocation.command, invocation.args, {
        cwd,
        encoding: "utf8",
        env: harness.packageManagerEnvironment(process.env, npmUserConfig),
        maxBuffer: 256 * 1024 * 1024,
    });
};

const scratch = mkdtempSync(join(tmpdir(), "carrier-pack-"));
const archiveName = (name, version, commit) =>
    `${name.replace("@", "").replace("/", "-")}-${version}-${commit.slice(0, 8)}.tgz`;

try {
    assertPinnedSource(sdkRoot, SDK_SOURCE, "ts-sdk checkout");

    const npmUserConfig = join(scratch, "pack.npmrc");
    writeFileSync(npmUserConfig, "registry=https://registry.npmjs.org/\n");

    const packDir = join(scratch, "packs");
    mkdirSync(packDir);
    const packed = [];
    for (const name of SDK_PACKAGES) {
        // The SDK's `prepack` runs tsup, which writes to stdout, so `pack --json`
        // is unparseable here. The new file in the destination is not.
        const before = new Set(readdirSync(packDir));
        runPnpm(sdkRoot, ["--filter", name, "pack", "--pack-destination", packDir], npmUserConfig);
        const produced = readdirSync(packDir).filter((e) => e.endsWith(".tgz") && !before.has(e));
        if (produced.length !== 1)
            throw new Error(`packing ${name} produced ${produced.length} archives, expected one`);
        packed.push({ name, path: join(packDir, produced[0]) });
    }
    if (
        JSON.stringify(packed.map((entry) => entry.name).sort()) !==
        JSON.stringify([...PINNED_PACKAGES].sort())
    )
        throw new Error("packed set does not match the pinned set");

    // Load the archives from a throwaway consumer before freezing them: a pack
    // that produced bytes is not a pack that produced a loadable candidate.
    const consumer = join(scratch, "consumer");
    mkdirSync(consumer);
    const spec = (path) => `file:${relative(consumer, path).replaceAll("\\", "/")}`;
    writeFileSync(
        join(consumer, "package.json"),
        `${JSON.stringify(
            {
                name: "carrier-candidate-consumer",
                private: true,
                type: "module",
                dependencies: Object.fromEntries(packed.map((e) => [e.name, spec(e.path)])),
                pnpm: { overrides: Object.fromEntries(packed.map((e) => [e.name, spec(e.path)])) },
            },
            null,
            2,
        )}\n`,
    );
    runPnpm(
        consumer,
        [
            "--store-dir",
            join(scratch, "pnpm-store"),
            "install",
            "--ignore-scripts",
            "--frozen-lockfile=false",
        ],
        npmUserConfig,
    );
    const from = join(consumer, "package.json");
    for (const [name, symbol] of [
        ["@arkade-os/sdk", CANDIDATE_SDK_SYMBOL],
        ["@arkade-os/swap", CANDIDATE_SWAP_SYMBOL],
    ])
        await assertCandidateExport(packageRootFrom(from, name), name, symbol);

    const pnpmVersion = runPnpm(sdkRoot, ["--version"], npmUserConfig).trim();
    const artifacts = [];
    mkdirSync(outDir, { recursive: true });
    for (const entry of packed.sort((a, b) => a.name.localeCompare(b.name))) {
        const manifest = archiveManifest(entry.path);
        if (manifest.name !== entry.name)
            throw new Error(`${entry.path}: archive declares ${manifest.name}`);
        if (!manifest.license)
            throw new Error(
                `${manifest.name} declares no license; this manifest will not invent one`,
            );
        const source = PINNED_SOURCES[entry.name];
        const file = archiveName(manifest.name, manifest.version, source.commit);
        copyFileSync(entry.path, join(outDir, file));
        const bytes = readFileSync(join(outDir, file));
        artifacts.push({
            file,
            package: manifest.name,
            version: manifest.version,
            license: manifest.license,
            licenseFrom: "the package manifest inside the archive",
            sha256: sha256(bytes),
            bytes: bytes.length,
            source: { ...source },
            toolchain: {
                node: process.version,
                pnpm: pnpmVersion,
                declaredPackageManager: readJson(join(sdkRoot, "package.json")).packageManager,
                command: `pnpm --filter ${manifest.name} pack`,
                platform: `${process.platform}-${process.arch}`,
            },
        });
    }

    for (const artifact of artifacts) {
        const mismatch = pinnedSourceMismatch(artifact);
        if (mismatch) throw new Error(mismatch);
    }

    const superseded = readdirSync(outDir).filter(
        (name) => name.endsWith(".tgz") && !artifacts.some((artifact) => artifact.file === name),
    );
    for (const name of superseded) rmSync(join(outDir, name));

    writeFileSync(
        join(outDir, "manifest.json"),
        `${JSON.stringify(
            {
                note: "Frozen candidate packages, built from source and never published to any registry. These digests are of THIS bundle: repacking @arkade-os/sdk from the same commit emits different tsup chunk ids, so a re-pack is a deliberate re-freeze — run scripts/carrier-artifacts/pack.mjs, then pnpm install, then node scripts/carrier-artifacts/verify.mjs.",
                packedAtUtc: new Date().toISOString(),
                artifacts,
            },
            null,
            4,
        )}\n`,
    );

    const where = relative(REPO, outDir).replaceAll("\\", "/") || VENDOR_DIR;
    process.stdout.write(`${artifacts.length} archives frozen in ${where}\n`);
    for (const artifact of artifacts)
        process.stdout.write(`  ${artifact.sha256}  ${artifact.file}\n`);
    if (superseded.length) process.stdout.write(`removed superseded: ${superseded.join(", ")}\n`);
    process.stdout.write(`manifest: ${where}/manifest.json\n`);
} finally {
    try {
        rmSync(scratch, { recursive: true, force: true });
    } catch (error) {
        process.stderr.write(`could not remove ${scratch}: ${error.message}\n`);
    }
}
