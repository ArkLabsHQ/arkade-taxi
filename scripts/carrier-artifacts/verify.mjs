#!/usr/bin/env node
// Prove the frozen archives are what this repository claims, and that nothing
// resolves past them to a registry or stale build. Built-in Node only: it runs
// in the Docker layer BEFORE `pnpm install`.

import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
    ARCHIVE_DECLARER,
    CANDIDATE_SYMBOLS,
    EXEMPT_INSTALLS,
    MANIFEST_PATH,
    PINNED_PACKAGES,
    SUPERSEDED_VENDOR,
    VENDOR_DIR,
    WORKSPACE_FILE,
    archiveManifest,
    assertCandidateExport,
    declaredSpec,
    dockerfileStages,
    fileSpec,
    installsDependencies,
    isComment,
    isOptOut,
    localWorkflowCalls,
    packageRootFrom,
    pinnedSourceMismatch,
    readFlatMapping,
    readJson,
    sha256,
    unprovenDefaultShell,
    unverifiedInstall,
    workflowJobs,
    workspaceManifests,
} from "./lib.mjs";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const at = (...parts) => join(REPO, ...parts);
const failures = [];
const check = (condition, message) => {
    if (!condition) failures.push(message);
    return condition;
};

// A named reason rather than a stack trace, because a Docker log is where this one lands.
const fail = (reason) => {
    process.stderr.write(`carrier artifacts FAILED:\n  - ${reason}\n`);
    process.exit(1);
};
if (!existsSync(at(MANIFEST_PATH)))
    fail(`${MANIFEST_PATH} is missing; the frozen archives are not in this tree`);
if (!existsSync(at(VENDOR_DIR)))
    fail(`${VENDOR_DIR} is missing; the frozen archives are not in this tree`);

const manifest = readJson(at(MANIFEST_PATH));
const byPackage = new Map(manifest.artifacts?.map((a) => [a.package, a]) ?? []);
check(
    JSON.stringify([...byPackage.keys()].sort()) === JSON.stringify([...PINNED_PACKAGES].sort()),
    `${MANIFEST_PATH} covers ${[...byPackage.keys()].join(", ")}, expected exactly ${PINNED_PACKAGES.join(", ")}`,
);

const present = readdirSync(at(VENDOR_DIR)).filter((name) => name !== "manifest.json");
const expected = manifest.artifacts?.map((a) => a.file) ?? [];
check(
    JSON.stringify([...present].sort()) === JSON.stringify([...expected].sort()),
    `${VENDOR_DIR} holds ${present.join(", ")}, and the manifest lists ${expected.join(", ")}`,
);

for (const artifact of manifest.artifacts ?? []) {
    const path = at(VENDOR_DIR, artifact.file);
    if (
        !check(
            existsSync(path),
            `${artifact.file} is listed in the manifest and missing from ${VENDOR_DIR}`,
        )
    )
        continue;
    const bytes = readFileSync(path);
    check(
        bytes.length === artifact.bytes,
        `${artifact.file} is ${bytes.length} bytes, manifest says ${artifact.bytes}`,
    );
    check(
        sha256(bytes) === artifact.sha256,
        `${artifact.file} sha256 ${sha256(bytes)} != manifest ${artifact.sha256}`,
    );

    // Corrupt bytes throw out of gunzip, and a stack trace in a Docker log names
    // a line number rather than a cause.
    let declared;
    try {
        declared = archiveManifest(path);
    } catch (error) {
        check(false, `${artifact.file} cannot be read as an archive: ${error.message}`);
    }
    check(
        declared !== undefined &&
            declared.name === artifact.package &&
            declared.version === artifact.version,
        `${artifact.file} contains ${declared?.name}@${declared?.version}, manifest says ${artifact.package}@${artifact.version}`,
    );
    const mismatch = pinnedSourceMismatch(artifact);
    check(mismatch === undefined, mismatch ?? "");
    check(
        artifact.file.endsWith(`-${artifact.version}-${artifact.source?.commit?.slice(0, 8)}.tgz`),
        `${artifact.file} does not carry its version and source commit in its name`,
    );
    check(Boolean(artifact.license), `${artifact.file} records no license`);
    check(
        Boolean(
            artifact.toolchain?.node && artifact.toolchain?.pnpm && artifact.toolchain?.command,
        ),
        `${artifact.file} records no build toolchain`,
    );
}

// pnpm 10 takes settings from pnpm-workspace.yaml, so an `overrides` block
// appearing there would silently overrule the root package.json this repo uses.
const workspaceYaml = readFileSync(at(WORKSPACE_FILE), "utf8");
check(
    readFlatMapping(workspaceYaml, "overrides") === undefined,
    `${WORKSPACE_FILE} declares overrides, which overrule the package.json ones this repository writes`,
);

const root = readJson(at("package.json"));
const overrides = root.pnpm?.overrides ?? {};
for (const name of PINNED_PACKAGES) {
    const artifact = byPackage.get(name);
    check(
        artifact !== undefined && overrides[name] === fileSpec(`./${VENDOR_DIR}`, artifact.file),
        `package.json override of ${name} is ${overrides[name]}, which is not a frozen archive`,
    );
}

// Every manifest the workspace installs from, derived from pnpm-workspace.yaml
// rather than listed, so a new package cannot declare a candidate unscanned.
const manifests = workspaceManifests(REPO);
check(manifests.length > 1, `${WORKSPACE_FILE} expanded to ${manifests.length} manifests to scan`);
for (const relative of manifests) {
    const declared = readJson(at(...relative.split("/")));
    const body = readFileSync(at(...relative.split("/")), "utf8");
    check(
        !body.includes(SUPERSEDED_VENDOR),
        `${relative} still names ${SUPERSEDED_VENDOR}, which no checkout tracks`,
    );
    for (const name of PINNED_PACKAGES) {
        const spec = declaredSpec(declared, name);
        if (spec === undefined) continue;
        // `release.yml` publishes packages/*, so only the private root may name
        // a path; everywhere else the root override supplies the bytes.
        if (relative === ARCHIVE_DECLARER)
            check(
                spec === fileSpec(`./${VENDOR_DIR}`, byPackage.get(name)?.file),
                `${relative} declares ${name} as ${spec}, which is not the frozen archive`,
            );
        else {
            check(
                !spec.startsWith("file:"),
                `${relative} declares ${name} as ${spec}; a published manifest must not carry a path`,
            );
            // The registry serves this number from a DIFFERENT build, so drift here
            // turns a dropped override from a failed install into a silent swap.
            check(
                spec === byPackage.get(name)?.version,
                `${relative} declares ${name} as ${spec}, not the frozen ${byPackage.get(name)?.version}; the registry answers that coordinate with other bytes`,
            );
        }
    }
}

// Where a registry or stale build reappears: every resolution must name a frozen
// archive, and the integrity pnpm recorded must be the sha512 of these bytes.
const lock = readFileSync(at("pnpm-lock.yaml"), "utf8");
const escape = (value) => value.replaceAll(/[.*+?^${}()|[\]\\/]/g, "\\$&");
check(
    !lock.includes(SUPERSEDED_VENDOR),
    `pnpm-lock.yaml still resolves through ${SUPERSEDED_VENDOR}`,
);
for (const name of PINNED_PACKAGES) {
    const artifact = byPackage.get(name);
    const keys = [
        ...lock.matchAll(new RegExp(`^ {2}'${escape(name)}@([^']+)':(?: \\{\\})?$`, "gm")),
    ];
    if (!check(keys.length > 0, `pnpm-lock.yaml resolves nothing for ${name}`)) continue;
    for (const [, spec] of keys)
        check(
            spec.startsWith(`file:${VENDOR_DIR}/${artifact?.file}`),
            `pnpm-lock.yaml resolves ${name}@${spec}, which is not the frozen archive`,
        );
    check(
        overrides[name] !== undefined && lock.includes(`'${name}': ${overrides[name]}`),
        `pnpm-lock.yaml does not record the override of ${name}`,
    );
    if (!artifact || !existsSync(at(VENDOR_DIR, artifact.file))) continue;
    const integrity = `sha512-${createHash("sha512")
        .update(readFileSync(at(VENDOR_DIR, artifact.file)))
        .digest("base64")}`;
    check(lock.includes(integrity), `pnpm-lock.yaml does not pin the bytes of ${artifact.file}`);
}

// The Docker dependency layer copies manifests, this directory and the archives,
// so this group has nothing to read there; the unit suite runs in a whole
// checkout and asserts it was not skipped.
const wholeCheckout = existsSync(at("Dockerfile"));
let scannedUnits = 0;
let scannedInstalls = 0;
if (wholeCheckout) {
    const workflowDir = at(".github", "workflows");
    const workflows = existsSync(workflowDir)
        ? readdirSync(workflowDir).filter((name) => /\.ya?ml$/.test(name))
        : [];
    check(workflows.length > 0, ".github/workflows holds no workflow to scan");
    const sources = [["Dockerfile", readFileSync(at("Dockerfile"), "utf8").split(/\r?\n/)]];
    for (const file of workflows)
        sources.push([
            `.github/workflows/${file}`,
            readFileSync(join(workflowDir, file), "utf8").split(/\r?\n/),
        ]);

    // "Nothing to scan" must be distinguishable from "not scanned".
    const installs = (lines) =>
        lines.filter((line) => !isComment(line) && installsDependencies(line)).length;
    const scanned = [];
    for (const [name, lines] of sources) {
        const units =
            name === "Dockerfile" ? dockerfileStages(lines) : workflowJobs(lines.join("\n"));
        const label = name === "Dockerfile" ? "stage" : "job";
        if (!check(units.size > 0, `${name} yielded no ${label}s, so this scan cannot read it`))
            continue;
        check(
            [...units.values()].reduce((total, unit) => total + installs(unit), 0) ===
                installs(lines),
            `${name} installs on a line this scan attributes to no ${label}`,
        );
        // Units are contiguous and ordered, so a cursor recovers the file line.
        let cursor = 0;
        for (const [unit, unitLines] of units) {
            const start = lines.indexOf(unitLines[0], cursor);
            cursor = start + unitLines.length;
            scanned.push([`${name} ${label} ${unit}`, unitLines, start]);
        }
        scannedUnits += units.size;
        scannedInstalls += installs(lines);
        // A job delegating to a reusable workflow selects the file that installs.
        for (const target of localWorkflowCalls(lines))
            check(
                sources.some(([scannedName]) => scannedName === target),
                `${name} delegates to ${target}, which this scan does not read`,
            );
        // Outside every job, so the per-job scan cannot see it: refuse the file —
        // but only where it installs, since a workflow with none has no gate.
        check(
            installs(lines) === 0 || !unprovenDefaultShell(lines.join("\n")),
            `${name} defaults every run to a shell this scan cannot prove keeps a failure fatal`,
        );
    }
    for (const [name, lines, offset = 0] of scanned) {
        const line = unverifiedInstall(lines);
        check(
            line === undefined,
            `${name} installs at line ${line + offset} without verifying the carrier artifacts first`,
        );
        const installsAt = lines.findIndex(
            (line) => !isComment(line) && installsDependencies(line),
        );
        if (installsAt === -1 || !name.startsWith("Dockerfile")) continue;
        const copiesAt = lines.findIndex(
            (line) => !isComment(line) && new RegExp(`^COPY .*${escape(VENDOR_DIR)}`).test(line),
        );
        check(
            copiesAt !== -1 && copiesAt < installsAt,
            `${name} installs before it copies ${VENDOR_DIR}`,
        );
    }

    // A ceiling, not a quota: deleting a decorative marker must not turn this red.
    const markers = sources.reduce((total, [, lines]) => total + lines.filter(isOptOut).length, 0);
    check(
        markers <= EXEMPT_INSTALLS,
        `${markers} install exemptions are written across the scanned files, and ${EXEMPT_INSTALLS} is allowed`,
    );
}

// What actually resolved, when there is an install to ask. Which importers owe
// an answer is read from the manifests, so a resolution that is merely absent
// cannot read as one that passed.
const declaredBy = new Map(PINNED_PACKAGES.map((name) => [name, []]));
for (const relative of manifests) {
    const declared = readJson(at(...relative.split("/")));
    for (const name of PINNED_PACKAGES)
        if (declaredSpec(declared, name) !== undefined) declaredBy.get(name).push(relative);
}
const installed = existsSync(at("node_modules"));
let confirmed = 0;
let owed = 0;
for (const [name, importers] of declaredBy) {
    if (
        !check(
            importers.length > 0,
            `no workspace manifest declares ${name}, so nothing pins its build`,
        )
    )
        continue;
    owed += importers.length;
    if (!installed) continue;
    for (const relative of importers)
        try {
            await assertCandidateExport(
                packageRootFrom(at(...relative.split("/")), name),
                name,
                CANDIDATE_SYMBOLS[name],
            );
            confirmed++;
        } catch (error) {
            failures.push(`${relative}: ${error.message}`);
        }
}
check(
    !installed || confirmed === owed,
    `${confirmed} of ${owed} declared candidate resolutions were confirmed`,
);

if (failures.length) fail(failures.join("\n  - "));
process.stdout.write(
    `carrier artifacts verified: ${manifest.artifacts.length} archives, lock pinned to their bytes, ` +
        `${wholeCheckout ? `Dockerfile and workflows checked across ${scannedUnits} units holding ${scannedInstalls} installing paths` : "install context, no Dockerfile to check"}, ` +
        `${installed ? `candidate exports confirmed on ${confirmed} of ${owed} declared resolutions` : "no install to inspect yet"}\n`,
);
