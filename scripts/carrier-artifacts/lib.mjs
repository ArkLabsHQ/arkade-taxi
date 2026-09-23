// Built-in Node only: `verify.mjs` runs in the Docker layer BEFORE
// `pnpm install`, so there is no node_modules for it to import from.

import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { existsSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { gunzipSync } from "node:zlib";

export const VENDOR_DIR = "vendor/carrier";
export const MANIFEST_PATH = `${VENDOR_DIR}/manifest.json`;
export const WORKSPACE_FILE = "pnpm-workspace.yaml";

const TS_SDK = "https://github.com/arkade-os/ts-sdk.git";
const SDK_COMMIT = "adc6b32958c36a7f9c39d6e30efdd945af874f84";

// Moving to a new candidate is an edit HERE, so `verify.mjs` refuses an archive
// whose manifest names any other source.
export const PINNED_SOURCES = {
    "@arkade-os/sdk": { repository: TS_SDK, commit: SDK_COMMIT, directory: "packages/ts-sdk" },
    "@arkade-os/swap": { repository: TS_SDK, commit: SDK_COMMIT, directory: "packages/swap" },
};

export const PINNED_PACKAGES = Object.keys(PINNED_SOURCES);

// `release.yml` runs `pnpm publish -r`, so a `file:` spec in any packages/*
// manifest would ship a path no registry consumer can resolve. Only the private
// root may name an archive; everywhere else the root override does the work.
export const ARCHIVE_DECLARER = "package.json";

export const SUPERSEDED_VENDOR = ".reference/vendor";

/** Why this archive is not the pinned source, or `undefined` when it is. */
export function pinnedSourceMismatch(artifact) {
    const pinned = PINNED_SOURCES[artifact?.package];
    const name = artifact?.file ?? "an unnamed archive";
    if (!pinned) return `${name} records ${artifact?.package}, which is not a pinned package`;
    for (const field of ["repository", "commit", "directory"])
        if (artifact.source?.[field] !== pinned[field])
            return `${name} records ${field} ${artifact.source?.[field]}, not the pinned ${pinned[field]}`;
    return undefined;
}

export const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

// What separates each candidate from the REGISTRY build, and from the stale
// pre-adc6b329 archives this directory replaces: both symbols were added in
// adc6b329 and neither older build exports one.
export const CANDIDATE_SDK_SYMBOL = "SendDeadlineExceededError";
export const CANDIDATE_SWAP_SYMBOL = "FundingOutputMismatchError";

export const CANDIDATE_SYMBOLS = {
    "@arkade-os/sdk": CANDIDATE_SDK_SYMBOL,
    "@arkade-os/swap": CANDIDATE_SWAP_SYMBOL,
};

// A gzipped tar without a tar dependency: decode the POSIX ustar fields, skip the rest by size.
export function readTarMember(archivePath, member) {
    const buffer = gunzipSync(readFileSync(archivePath));
    let offset = 0;
    while (offset + 512 <= buffer.length) {
        const header = buffer.subarray(offset, offset + 512);
        if (header.every((byte) => byte === 0)) break;
        const prefix = header.subarray(345, 500).toString("utf8").replace(/\0.*$/, "");
        const name = header.subarray(0, 100).toString("utf8").replace(/\0.*$/, "");
        const path = prefix ? `${prefix}/${name}` : name;
        const size =
            Number.parseInt(
                header.subarray(124, 136).toString("ascii").replace(/\0.*$/, "").trim(),
                8,
            ) || 0;
        offset += 512;
        if (path === member) return buffer.subarray(offset, offset + size).toString("utf8");
        offset += Math.ceil(size / 512) * 512;
    }
    return undefined;
}

export const archiveManifest = (archivePath) => {
    const source = readTarMember(archivePath, "package/package.json");
    if (source === undefined)
        throw new Error(`${archivePath}: archive carries no package/package.json`);
    return JSON.parse(source);
};

export const readJson = (path) => JSON.parse(readFileSync(path, "utf8"));

// All four install the candidate, so peer or optional must not escape the scan.
export const declaredSpec = (manifest, name) =>
    manifest.dependencies?.[name] ??
    manifest.devDependencies?.[name] ??
    manifest.peerDependencies?.[name] ??
    manifest.optionalDependencies?.[name];

export const isComment = (line) => /^\s*#/.test(line);

const PACKAGE_MANAGERS = new Set(["pnpm", "npm", "yarn", "bun"]);
const INSTALL_SUBCOMMANDS = new Set(["install", "i", "ci", "add"]);
const INVOKERS = new Set(["node", "pnpm", "npm", "corepack", "bash", "sh"]);

// A comment on the line IMMEDIATELY above the install it excuses. The ceiling is
// what is written, not a spare one: a first bypass is an edit here as well as there.
export const OPT_OUT = "carrier-artifacts: not a dependency install";
export const EXEMPT_INSTALLS = 0;

// `pnpm/action-setup` installs with no command line at all when its step says so.
const ACTION_INSTALL = /^\s*run_install:\s*(?!false\b|'false'|"false")\S/;

// Any spelling a drifting edit might reach for. `pnpm exec playwright install`
// matches too: an exemption is written with OPT_OUT, not guessed at here.
export function installsDependencies(line) {
    if (ACTION_INSTALL.test(line)) return true;
    const tokens = line.trim().split(/\s+/);
    const at = tokens.findIndex((token) => PACKAGE_MANAGERS.has(token));
    if (at === -1) return false;
    const rest = tokens.slice(at + 1);
    if (!rest.some((token) => !token.startsWith("-"))) return tokens[at] === "yarn";
    return rest.some((token) => INSTALL_SUBCOMMANDS.has(token));
}

export const isOptOut = (line) => line !== undefined && isComment(line) && line.includes(OPT_OUT);

const commandBody = (line) =>
    line
        .replace(/^\s*(?:RUN|-)\s+/, "")
        .replace(/^\s*run:\s*/, "")
        .trim();

// A pipe's status is its last stage's and a bare `&` discards one; `;` and `&&` are read below.
const swallowsStatus = (command) => /[|&]/.test(command.replaceAll("&&", " "));

const VERIFY_COMMAND = /carrier-artifacts\/verify\.mjs|verify:artifacts/;

// `echo …verify.mjs` names the command without running it; only the last `;` group's
// status survives; and a prefix disqualifies only if it INSTALLED, not if it was `cd`.
export const invokesVerify = (line) => {
    const command = commandBody(line);
    if (swallowsStatus(command)) return false;
    const groups = command.split(";");
    const parts = groups.flatMap((group, index) =>
        group
            .split("&&")
            .map((part) => ({ part: part.trim(), fatal: index === groups.length - 1 })),
    );
    const at = parts.findIndex(
        ({ part }) => VERIFY_COMMAND.test(part) && INVOKERS.has(part.split(/\s+/)[0]),
    );
    return (
        at !== -1 &&
        parts[at].fatal &&
        !parts.slice(0, at).some(({ part }) => installsDependencies(part))
    );
};

// Both are idiom on the dash line as well as under it; `release.yml` writes `if:`
// both ways.
const KEPT_FROM_RUNNING = /^\s*(?:-\s+)?if:\s/;
const NON_FATAL = /^\s*(?:-\s+)?continue-on-error:\s*(?!false\b|'false'|"false")\S/;
const JOB_NON_FATAL = /^( *)continue-on-error:\s*(?!false\b|'false'|"false")\S/;

// Actions' default `run` shell carries `-e`; a custom template drops it. The two
// named are the ones PROVABLY fatal, and everything else — template, other
// interpreter, anything unread — disqualifies rather than being enumerated.
const UNPROVEN_SHELL = /^\s*(?:-\s+)?shell:\s*(?!(['"]?)(?:bash|sh)\1\s*(?:#.*)?$)\S/;

// `set +e`, an ERR trap and a heredoc RUN (whose status is its last command) all
// discard failures from the lines below them in that same shell.
const RELAXES_SHELL = /^\s*set\s+\+(?:e\b|o\s+errexit\b)|^\s*trap\s.*\bERR\b|^\s*RUN\s.*<</;
const OPENS_SHELL = /^\s*-\s|^\s*RUN\s/;

// A `- ` line belongs to whatever list it is under, and `needs:` and
// `strategy.matrix` write them too, so position cannot say whether a key is the
// job's or a step's. Indentation can: a job key is never deeper than that list.
const JOB_DEFAULTS = /^( *)defaults:/;
const jobWideGuard = (lines) => {
    const listAt = lines.reduce(
        (found, line) => found ?? /^( *)-\s/.exec(line)?.[1].length,
        undefined,
    );
    if (listAt === undefined) return false;
    const jobLevel = (pattern) => (line) => pattern.exec(line)?.[1].length <= listAt;
    // `defaults.run.shell` sits deeper than the job's keys, so its own indent says
    // nothing; the job declaring one is what makes an unsafe shell job-wide.
    return (
        lines.some(jobLevel(JOB_NON_FATAL)) ||
        (lines.some(jobLevel(JOB_DEFAULTS)) && lines.some((line) => UNPROVEN_SHELL.test(line)))
    );
};

/** Indices whose verify must not count towards a later install. */
export function guardedLines(lines) {
    const guarded = new Set();
    if (jobWideGuard(lines)) return new Set(lines.keys());
    let start = 0;
    const close = (end) => {
        const block = lines.slice(start, end);
        if (
            block.some(
                (line) =>
                    KEPT_FROM_RUNNING.test(line) ||
                    NON_FATAL.test(line) ||
                    UNPROVEN_SHELL.test(line),
            )
        )
            for (let index = start; index < end; index++) guarded.add(index);
    };
    lines.forEach((line, index) => {
        if (!/^\s*-\s/.test(line)) return;
        close(index);
        start = index;
    });
    close(lines.length);
    let relaxed = false;
    lines.forEach((line, index) => {
        if (OPENS_SHELL.test(line)) relaxed = false;
        if (RELAXES_SHELL.test(line)) relaxed = true;
        if (relaxed) guarded.add(index);
    });
    return guarded;
}

// A command is a LOGICAL line. A Dockerfile continues one past a trailing
// backslash and a YAML folded scalar is one command across its whole block, so
// reading the physical line lets `…verify.mjs \` and `|| true` pass as two
// harmless halves. Fold first; every other reader here stays physical.
const FOLDED_SCALAR = /^( *)(?:-\s+)?[A-Za-z_][\w-]*:\s*>[-+]?\d*\s*(?:#.*)?$/;

export function logicalLines(lines) {
    const folded = [];
    let open;
    let blockAt;
    const close = () => {
        if (open) folded.push({ text: open.parts.join(" "), at: open.at, span: open.span });
        open = undefined;
    };
    const add = (index, line) => {
        const part = line.trim().replace(/\\$/, "");
        if (open) {
            open.parts.push(part);
            open.span.push(index);
        } else open = { parts: [part], at: index, span: [index] };
    };
    lines.forEach((line, index) => {
        const indent = /^ */.exec(line)[0].length;
        if (blockAt !== undefined) {
            if (line.trim() && indent > blockAt) return add(index, line);
            close();
            blockAt = undefined;
        }
        const scalar = FOLDED_SCALAR.exec(line);
        if (scalar) {
            close();
            folded.push({ text: line.trim(), at: index, span: [index] });
            blockAt = scalar[1].length;
            return;
        }
        add(index, line);
        if (!/\\$/.test(line.trim())) close();
    });
    close();
    return folded;
}

/** 1-based line of the first install no executable verify precedes, or `undefined`. */
export function unverifiedInstall(lines) {
    const guarded = guardedLines(lines);
    let verified = false;
    for (const { text, at, span } of logicalLines(lines)) {
        if (isComment(text)) continue;
        if (invokesVerify(text)) verified ||= !span.some((index) => guarded.has(index));
        else if (installsDependencies(text) && !verified && !isOptOut(lines[at - 1])) return at + 1;
    }
    return undefined;
}

// A later stage is a fresh filesystem: the build stage's verify never ran there
// and vendor/carrier was never copied, so a stage is the scan unit, not the file.
export function dockerfileStages(lines) {
    const stages = new Map();
    let stage;
    lines.forEach((line, index) => {
        const from = !isComment(line) && /^\s*FROM\s+(\S+)(?:\s+AS\s+(\S+))?/i.exec(line);
        if (from) {
            stage = from[2] ?? from[1];
            stages.set(stages.has(stage) ? (stage = `${stage}#${index + 1}`) : stage, []);
        }
        if (stage) stages.get(stage).push(line);
    });
    return stages;
}

// Headings take their indent from the first, so this repository's four-space
// workflows read the same as a two-space file and a nested key never passes.
export function workflowJobs(yaml) {
    const jobs = new Map();
    let inJobs = false;
    let indent;
    let job;
    for (const line of yaml.split(/\r?\n/)) {
        if (/^\S/.test(line)) {
            inJobs = /^jobs:\s*(?:#.*)?$/.test(line);
            indent = job = undefined;
            continue;
        }
        if (!inJobs) continue;
        const heading = /^( +)([A-Za-z_][\w-]*):\s*(?:#.*)?$/.exec(line);
        if (heading && (indent === undefined || heading[1].length === indent)) {
            indent = heading[1].length;
            jobs.set((job = heading[2]), []);
        }
        if (job) jobs.get(job).push(line);
    }
    return jobs;
}

// Anything local a job delegates to selects the file that installs, so match any
// `./` target rather than only the ones already scanned — a check that can only
// fail for what it already accepts cannot fail at all. Quoted, bare, or on the
// line beneath the key: none of those is a reason not to read it.
export const localWorkflowCalls = (lines) => {
    const targets = [];
    lines.forEach((line, index) => {
        if (isComment(line)) return;
        const key = /^\s*-?\s*uses:\s*(\S.*)?$/.exec(line);
        if (!key) return;
        const value = key[1] ?? lines.slice(index + 1).find((next) => next.trim()) ?? "";
        const target = /^\s*(['"]?)\.\/(\S+?)\/*\1\s*(?:#.*)?$/.exec(value)?.[2];
        if (target) targets.push(target);
    });
    return targets;
};

// An override resolves against the workspace root, a dependency against the
// declaring directory, so callers pass the one they write in.
export const fileSpec = (from, filename) =>
    `file:${from}${from.endsWith("/") ? "" : "/"}${filename}`;

const yamlBlock = (yaml, key) => {
    const lines = yaml.split(/\r?\n/);
    // A trailing comment on the key line must not hide the block beneath it.
    const heading = new RegExp(`^${key}:\\s*(?:#.*)?$`);
    const start = lines.findIndex((line) => heading.test(line));
    if (start === -1) return undefined;
    const body = [];
    for (const line of lines.slice(start + 1)) {
        if (!line.trim()) continue;
        if (!line.startsWith(" ")) break;
        if (!isComment(line)) body.push(line);
    }
    return body;
};

// A YAML dependency cannot reach a pre-install Docker layer, so read the two
// flat blocks this repository needs by hand and fail closed on anything else.
export function readFlatMapping(yaml, key) {
    const body = yamlBlock(yaml, key);
    if (body === undefined) return undefined;
    const mapping = {};
    for (const line of body) {
        const pair = /^ +(?:'([^']+)'|([^\s:'][^:]*)):\s+(?:'([^']*)'|(\S.*?))\s*$/.exec(line);
        if (!pair)
            throw new Error(`${key} contains a line this reader will not interpret: ${line}`);
        mapping[pair[1] ?? pair[2]] = pair[3] ?? pair[4];
    }
    return mapping;
}

export function readFlatSequence(yaml, key) {
    const body = yamlBlock(yaml, key);
    if (body === undefined) return undefined;
    return body.map((line) => {
        const item = /^ +-\s+(?:"([^"]*)"|'([^']*)'|(\S.*?))\s*$/.exec(line);
        if (!item)
            throw new Error(`${key} contains a line this reader will not interpret: ${line}`);
        return item[1] ?? item[2] ?? item[3];
    });
}

// Derived from the workspace file rather than listed here: a package added to
// `packages/` must not be able to declare a candidate without being scanned.
export function workspaceManifests(repo) {
    const patterns = readFlatSequence(readFileSync(join(repo, WORKSPACE_FILE), "utf8"), "packages");
    if (!patterns?.length) throw new Error(`${WORKSPACE_FILE} declares no packages to scan`);
    const manifests = ["package.json"];
    for (const pattern of patterns) {
        const parts = pattern.split("/");
        if (parts.length !== 2 || parts[1] !== "*" || parts[0].includes("*"))
            throw new Error(
                `${WORKSPACE_FILE} pattern ${pattern} is one this reader cannot expand`,
            );
        const directory = join(repo, parts[0]);
        if (!existsSync(directory)) continue;
        for (const entry of readdirSync(directory, { withFileTypes: true }))
            if (entry.isDirectory() && existsSync(join(directory, entry.name, "package.json")))
                manifests.push(`${parts[0]}/${entry.name}/package.json`);
    }
    return manifests;
}

// Under pnpm's strict layout only the importer's own question is the real one.
export function packageRootFrom(fromFile, name) {
    // realpath: pnpm links packages into `.pnpm/`, and deps are siblings THERE.
    let directory = dirname(createRequire(realpathSync(fromFile)).resolve(name));
    for (;;) {
        const manifest = join(directory, "package.json");
        if (existsSync(manifest) && readJson(manifest).name === name) return directory;
        const parent = dirname(directory);
        if (parent === directory) throw new Error(`${name} is not resolvable from ${fromFile}`);
        directory = parent;
    }
}

// Load what actually resolved and require the named export. An import that
// merely succeeds does not separate a candidate from the registry build.
export async function assertCandidateExport(packageRoot, name, symbol) {
    const manifest = readJson(join(packageRoot, "package.json"));
    const entry = manifest.exports?.["."]?.import?.default ?? manifest.module ?? manifest.main;
    if (!entry) throw new Error(`${name} at ${packageRoot} declares no ESM entry`);
    const namespace = await import(pathToFileURL(join(packageRoot, entry)).href);
    if (!(symbol in namespace))
        throw new Error(
            `${name} resolved to ${packageRoot}, which does not export ${symbol}: that is not the candidate`,
        );
    return packageRoot;
}

/** Each frozen artifact as one importer's resolver answers, for an install tree
 * outside this workspace, which the census over `pnpm-workspace.yaml` cannot see. */
export async function assertFrozenResolutions(fromFile, artifacts) {
    if (!artifacts?.length) throw new Error(`${MANIFEST_PATH} freezes no archives to resolve`);
    for (const { package: name, version } of artifacts) {
        const root = packageRootFrom(fromFile, name);
        const resolved = readJson(join(root, "package.json")).version;
        if (resolved !== version)
            throw new Error(
                `${name} resolved to ${resolved} at ${root}, not the frozen ${version}`,
            );
        await assertCandidateExport(root, name, CANDIDATE_SYMBOLS[name]);
    }
    return artifacts.length;
}
