#!/usr/bin/env node
// Refuse `pnpm publish -r` while a published manifest declares a vendored package
// at a registry coordinate the candidate also claims: npm answers it with the
// registry build, not the candidate this tree was tested against.
// Built-in Node only. `node scripts/carrier-artifacts/release-gate.mjs [repo]`.
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { MANIFEST_PATH, readJson, workspaceManifests } from "./lib.mjs";

const REPO = resolve(process.argv[2] ?? join(dirname(fileURLToPath(import.meta.url)), "..", ".."));
// devDependencies never reach a consumer's install.
const CONSUMED = ["dependencies", "peerDependencies", "optionalDependencies"];
const EXACT = /^=?v?(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)(?:\+[0-9A-Za-z.-]+)?$/;

const manifestPath = join(REPO, MANIFEST_PATH);
const artifacts = existsSync(manifestPath) ? (readJson(manifestPath).artifacts ?? []) : [];
const commits = [...new Set(artifacts.map((artifact) => artifact.source?.commit))];

const conflicts = [];
for (const relative of workspaceManifests(REPO)) {
    const manifest = readJson(join(REPO, ...relative.split("/")));
    if (manifest.private === true) continue;
    for (const field of CONSUMED)
        for (const { package: name, version } of artifacts) {
            const spec = manifest[field]?.[name];
            if (spec === undefined) continue;
            const exact = EXACT.exec(String(spec).trim())?.[1];
            if (exact === undefined)
                conflicts.push(
                    `${relative} ${field} ${name}@${spec} is not an exact version, so nothing shows it excludes the candidate's ${version}`,
                );
            else if (exact === version.replace(/\+.*$/, ""))
                conflicts.push(
                    `${relative} ${field} ${name}@${spec} is the coordinate the vendored candidate claims, and the registry serves it from another build`,
                );
        }
}

const ack = (process.env.CARRIER_RELEASE_ACK ?? "").trim();
if (conflicts.length && ack !== "" && commits.length === 1 && ack === commits[0]) {
    process.stdout.write(
        `release gate OVERRIDDEN by CARRIER_RELEASE_ACK=${ack}; publishing anyway:\n  - ${conflicts.join("\n  - ")}\n`,
    );
    process.exit(0);
}
if (conflicts.length) {
    process.stderr.write(
        `release gate FAILED: the published packages would resolve registry builds, not the vendored candidates from ${commits.join(", ")}:\n  - ${conflicts.join("\n  - ")}\n` +
            `Declare a registry version built from that commit (or later) and drop ${MANIFEST_PATH}, ` +
            `or set the repository variable CARRIER_RELEASE_ACK to ${commits.join(", ")} to publish anyway` +
            `${ack ? ` (it is set to ${ack})` : ""}.\n`,
    );
    process.exit(1);
}
process.stdout.write(
    `release gate passed: ${artifacts.length ? `no published manifest declares ${artifacts.map((a) => `${a.package}@${a.version}`).join(" or ")}` : "no vendored candidates"}\n`,
);
