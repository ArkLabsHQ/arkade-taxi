#!/usr/bin/env node
// What proves `verify.mjs` can fail. Injects one fault into a tracked file, runs
// the verifier, restores the bytes, and scores CAUGHT only when the intended
// check reported it. `pnpm verify:artifacts:battery`.
//
// It edits the working tree in place, so it refuses to start unless the files it
// touches are clean, and re-checks them at the end: an interrupted run is then
// recoverable with `git checkout --`.
import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const at = (p) => join(REPO, p);

const CI = ".github/workflows/ci.yml";
const REL = ".github/workflows/release.yml";
const E2E = ".github/workflows/e2e.yml";
const DF = "Dockerfile";
const MAN = "vendor/carrier/manifest.json";
const ROOT = "package.json";
const CLIENT = "packages/client/package.json";
const CORE = "packages/core/package.json";
const WS = "pnpm-workspace.yaml";
const SWAP_TGZ = "vendor/carrier/arkade-os-swap-0.0.20-adc6b329.tgz";
const TOUCHED = [CI, REL, E2E, DF, MAN, ROOT, CLIENT, CORE, WS, SWAP_TGZ];

const text = (p) => readFileSync(at(p), "utf8");
const sub = (p, from, to, all = false) => {
    const body = text(p);
    if (!body.includes(from)) throw new Error(`fixture miss in ${p}: ${JSON.stringify(from)}`);
    writeFileSync(at(p), all ? body.replaceAll(from, to) : body.replace(from, to));
};

const VERIFY_CI = "            - run: node scripts/carrier-artifacts/verify.mjs";
const VERIFY_DF = "RUN node scripts/carrier-artifacts/verify.mjs";

const faults = [
    [
        "A",
        "one byte appended to the swap archive",
        [SWAP_TGZ],
        () => {
            writeFileSync(
                at(SWAP_TGZ),
                Buffer.concat([readFileSync(at(SWAP_TGZ)), Buffer.from([0])]),
            );
        },
    ],
    [
        "B",
        "root override of swap back to a registry coordinate",
        [ROOT],
        () =>
            sub(
                ROOT,
                '"@arkade-os/swap": "file:./vendor/carrier/arkade-os-swap-0.0.20-adc6b329.tgz"',
                '"@arkade-os/swap": "0.0.20"',
            ),
    ],
    [
        "C",
        "manifest commit replaced with a well-formed 40-hex",
        [MAN],
        () =>
            sub(
                MAN,
                "adc6b32958c36a7f9c39d6e30efdd945af874f84",
                "0123456789abcdef0123456789abcdef01234567",
            ),
    ],
    [
        "D",
        "root devDependency sdk back to a registry coordinate",
        [ROOT],
        () =>
            sub(
                ROOT,
                '"@arkade-os/sdk": "file:./vendor/carrier/arkade-os-sdk-0.4.74-adc6b329.tgz",\n        "@noble/curves"',
                '"@arkade-os/sdk": "0.4.74",\n        "@noble/curves"',
            ),
    ],
    [
        "E",
        "packages/client given a file: path again",
        [CLIENT],
        () =>
            sub(
                CLIENT,
                '"@arkade-os/swap": "0.0.20"',
                '"@arkade-os/swap": "file:../../.reference/vendor/arkade-os-swap-0.0.20.tgz"',
            ),
    ],
    ["F", "ci.yml gates verify step deleted", [CI], () => sub(CI, `${VERIFY_CI}\n`, "")],
    [
        "G",
        "the same step commented out",
        [CI],
        () => sub(CI, VERIFY_CI, "            # - run: node scripts/carrier-artifacts/verify.mjs"),
    ],
    [
        "H",
        "the same step given a dash-line if:",
        [CI],
        () =>
            sub(
                CI,
                VERIFY_CI,
                "            - if: false\n              run: node scripts/carrier-artifacts/verify.mjs",
            ),
    ],
    [
        "I",
        "install respelled pnpm i, verify gone",
        [CI],
        () => {
            sub(CI, `${VERIFY_CI}\n`, "");
            sub(
                CI,
                "            - run: pnpm install --frozen-lockfile",
                "            - run: pnpm i",
            );
        },
    ],
    [
        "J",
        "Dockerfile COPY vendor/carrier deleted",
        [DF],
        () => sub(DF, "COPY vendor/carrier/ vendor/carrier/\n", ""),
    ],
    [
        "K",
        "Dockerfile pre-install verify rewritten as echo",
        [DF],
        () => sub(DF, VERIFY_DF, "RUN echo scripts/carrier-artifacts/verify.mjs"),
    ],
    [
        "L",
        "an install added to the runtime stage",
        [DF],
        () => sub(DF, "USER 10001:10001", "RUN pnpm add -g something\nUSER 10001:10001"),
    ],
    ["M", "ci.yml jobs: key made unreadable", [CI], () => sub(CI, "\njobs:\n", "\njobs :\n")],
    [
        "N",
        "an install attributed to no job",
        [CI],
        () => sub(CI, "on:\n", "on:\n    - run: pnpm install --frozen-lockfile\n"),
    ],
    [
        "O",
        "the build stage FROM made unreadable",
        [DF],
        () =>
            sub(DF, "FROM node:22-bookworm-slim AS build", "FROMX node:22-bookworm-slim AS build"),
    ],
    [
        "P",
        "two install opt-out markers",
        [CI],
        () =>
            sub(
                CI,
                "            - run: pnpm install --frozen-lockfile",
                "            # carrier-artifacts: not a dependency install\n            - run: pnpm install --frozen-lockfile",
                true,
            ),
    ],
    [
        "Q",
        "pnpm-workspace.yaml grows an overrides block",
        [WS],
        () => writeFileSync(at(WS), `${text(WS)}\noverrides:\n    '@arkade-os/swap': 0.0.20\n`),
    ],
    [
        "Q2",
        "the same, behind a trailing comment",
        [WS],
        () =>
            writeFileSync(
                at(WS),
                `${text(WS)}\noverrides: # pinned upstream\n    '@arkade-os/swap': 0.0.20\n`,
            ),
    ],
    [
        "R",
        "a job delegates to an unscanned local file",
        [CI],
        () => sub(CI, "uses: ./.github/workflows/e2e.yml", "uses: ./.github/actions/elsewhere.yml"),
    ],
    [
        "R2",
        "the same, with a trailing comment",
        [CI],
        () =>
            sub(
                CI,
                "uses: ./.github/workflows/e2e.yml",
                "uses: ./.github/actions/elsewhere.yml # reusable",
            ),
    ],
    ["S", "vendor/carrier/manifest.json deleted", [MAN], () => rmSync(at(MAN))],
    [
        "T",
        ".reference/vendor reintroduced in the root manifest",
        [ROOT],
        () =>
            sub(
                ROOT,
                "file:./vendor/carrier/arkade-os-swap-0.0.20-adc6b329.tgz",
                "file:./.reference/vendor/arkade-os-swap-0.0.20.tgz",
                true,
            ),
    ],
    [
        "U",
        "run_install on action-setup before the verify",
        [CI],
        () =>
            sub(
                CI,
                "            - uses: pnpm/action-setup@v4\n            - uses: actions/setup-node@v5\n              with:\n                  node-version: 22\n                  cache: pnpm\n            - run: node",
                "            - uses: pnpm/action-setup@v4\n              with:\n                  run_install: true\n            - uses: actions/setup-node@v5\n              with:\n                  node-version: 22\n                  cache: pnpm\n            - run: node",
            ),
    ],
    [
        "V",
        "a declared candidate that does not resolve",
        [CORE],
        () =>
            sub(
                CORE,
                '"@arkade-taxi/covenant": "workspace:*"',
                '"@arkade-taxi/covenant": "workspace:*",\n        "@arkade-os/swap": "0.0.20"',
            ),
    ],

    // --- consequence: the verify runs and its failure stops nothing ---
    [
        "W",
        "gates verify step given continue-on-error",
        [CI],
        () =>
            sub(
                CI,
                VERIFY_CI,
                "            - name: gate\n              continue-on-error: true\n              run: node scripts/carrier-artifacts/verify.mjs",
            ),
    ],
    [
        "X",
        "the same written on the dash line",
        [CI],
        () =>
            sub(
                CI,
                VERIFY_CI,
                "            - continue-on-error: 'true'\n              run: node scripts/carrier-artifacts/verify.mjs",
            ),
    ],
    [
        "Y",
        "the whole vectors job told to continue on error",
        [CI],
        () =>
            sub(
                CI,
                "    vectors:\n        runs-on: ubuntu-latest",
                "    vectors:\n        continue-on-error: true\n        runs-on: ubuntu-latest",
            ),
    ],
    [
        "Z",
        "Dockerfile pre-install verify chained past failure",
        [DF],
        () => sub(DF, VERIFY_DF, `${VERIFY_DF} || true`),
    ],
    [
        "AA",
        "the same, swallowed by a semicolon",
        [DF],
        () => sub(DF, VERIFY_DF, `${VERIFY_DF} ; true`),
    ],
    [
        "AB",
        "the same, piped so the status is tee's",
        [DF],
        () => sub(DF, VERIFY_DF, `${VERIFY_DF} | tee /tmp/verify.log`),
    ],
    [
        "AC",
        "the install chained ahead of the verify on one line",
        [DF],
        () => {
            sub(DF, `${VERIFY_DF}\nRUN pnpm install --frozen-lockfile\n`, "");
            sub(DF, `${VERIFY_DF}\n`, "");
            sub(
                DF,
                "COPY . .",
                "RUN pnpm install --frozen-lockfile && node scripts/carrier-artifacts/verify.mjs\nCOPY . .",
            );
        },
    ],
    [
        "AD",
        "release verify given an expression this scan cannot read as false",
        [REL],
        () =>
            sub(
                REL,
                "            - run: node scripts/carrier-artifacts/verify.mjs",
                "            - continue-on-error: ${{ github.event_name == 'push' }}\n              run: node scripts/carrier-artifacts/verify.mjs",
            ),
    ],

    // --- selector, census and ceiling ---
    [
        "AE",
        "a quoted delegation to an unscanned local file",
        [CI],
        () => sub(CI, "uses: ./.github/workflows/e2e.yml", 'uses: "./.github/actions/elsewhere"'),
    ],
    [
        "AF",
        "a published coordinate widened to a range",
        [CLIENT],
        () => sub(CLIENT, '"@arkade-os/swap": "0.0.20"', '"@arkade-os/swap": "^0.0.20"'),
    ],
    [
        "AG",
        "a candidate moved to peerDependencies with a path",
        [CLIENT],
        () =>
            sub(
                CLIENT,
                '"@arkade-os/swap": "0.0.20",',
                '"@noble/hashes": "^2.0.1"\n    },\n    "peerDependencies": {\n        "@arkade-os/swap": "file:../../vendor/carrier/arkade-os-swap-0.0.20-adc6b329.tgz",',
            ),
    ],
    // --- the scan unit: a `- ` line is not always a step ---
    [
        "AI",
        "a job told to continue on error below its steps",
        [CI],
        () =>
            sub(
                CI,
                ["            - run: pnpm format:check", ""].join("\n"),
                [
                    "            - run: pnpm format:check",
                    "        continue-on-error: true",
                    "",
                ].join("\n"),
            ),
    ],
    [
        "AJ",
        "the same below a block-style needs: list",
        [REL],
        () =>
            sub(
                REL,
                "        needs: [e2e, image]",
                [
                    "        needs:",
                    "            - e2e",
                    "            - image",
                    "        continue-on-error: true",
                ].join("\n"),
            ),
    ],
    [
        "AK",
        "the same below a strategy.matrix list",
        [CI],
        () =>
            sub(
                CI,
                ["    vectors:", "        runs-on: ubuntu-latest"].join("\n"),
                [
                    "    vectors:",
                    "        runs-on: ubuntu-latest",
                    "        strategy:",
                    "            matrix:",
                    "                node:",
                    "                    - 22",
                    "        continue-on-error: true",
                ].join("\n"),
            ),
    ],

    // --- shell scope: the construct sits above the verify, not on it ---
    [
        "AL",
        "errexit switched off above the verify",
        [E2E],
        () =>
            sub(
                E2E,
                "            - run: node scripts/carrier-artifacts/verify.mjs",
                [
                    "            - run: |",
                    "                  set +e",
                    "                  node scripts/carrier-artifacts/verify.mjs",
                ].join("\n"),
            ),
    ],
    [
        "AM",
        "a heredoc RUN, whose status is its last command",
        [DF],
        () =>
            sub(
                DF,
                [VERIFY_DF, "RUN pnpm install --frozen-lockfile", ""].join("\n"),
                [
                    "RUN <<EOF",
                    "node scripts/carrier-artifacts/verify.mjs",
                    "pnpm install --frozen-lockfile",
                    "EOF",
                    "",
                ].join("\n"),
            ),
    ],
    [
        "AN",
        "a shell template that drops errexit",
        [CI],
        () =>
            sub(
                CI,
                VERIFY_CI,
                [
                    "            - name: gate",
                    "              shell: bash {0}",
                    "              run: |",
                    "                  node scripts/carrier-artifacts/verify.mjs",
                ].join("\n"),
            ),
    ],

    // --- selector grammar, one form further out ---
    [
        "AO",
        "a delegation whose target sits on the next line",
        [CI],
        () =>
            sub(
                CI,
                "        uses: ./.github/workflows/e2e.yml",
                ["        uses:", "            ./.github/actions/elsewhere"].join("\n"),
            ),
    ],

    // --- the unit again: a command is a LOGICAL line ---
    [
        "AP",
        "a backslash carrying the swallow to the next line",
        [DF],
        () => sub(DF, VERIFY_DF, [`${VERIFY_DF} \\`, "    || true"].join("\n")),
    ],
    [
        "AQ",
        "a folded scalar whose block swallows it",
        [CI],
        () =>
            sub(
                CI,
                VERIFY_CI,
                [
                    "            - run: >-",
                    "                  node scripts/carrier-artifacts/verify.mjs",
                    "                  || true",
                ].join("\n"),
            ),
    ],
    [
        "AR",
        "a backslash inside a literal block",
        [E2E],
        () =>
            sub(
                E2E,
                "            - run: node scripts/carrier-artifacts/verify.mjs",
                [
                    "            - run: |",
                    "                  node scripts/carrier-artifacts/verify.mjs \\",
                    "                    | tee /tmp/v.log",
                ].join("\n"),
            ),
    ],

    // --- round 4: the fold's own regression, and the levels below it ---
    [
        "AS",
        "a comment ending in a backslash, hiding the install",
        [DF],
        () => {
            sub(DF, VERIFY_DF, "RUN echo scripts/carrier-artifacts/verify.mjs");
            sub(
                DF,
                "RUN pnpm install --frozen-lockfile",
                ["# the lockfile note above \\", "RUN pnpm install --frozen-lockfile"].join("\n"),
            );
        },
    ],
    [
        "AT",
        "a folded scalar written >2-",
        [CI],
        () =>
            sub(
                CI,
                VERIFY_CI,
                [
                    "            - run: >2-",
                    "                  node scripts/carrier-artifacts/verify.mjs",
                    "                  || true",
                ].join("\n"),
            ),
    ],
    [
        "AU",
        "a verify nested inside a conditional",
        [CI],
        () =>
            sub(
                CI,
                VERIFY_CI,
                [
                    "            - run: |",
                    '                  if [ "$SKIP" != 1 ]; then',
                    "                    node scripts/carrier-artifacts/verify.mjs",
                    "                  fi",
                ].join("\n"),
            ),
    ],
    [
        "AV",
        "a workflow-level defaults shell this scan cannot prove",
        [CI],
        () =>
            sub(
                CI,
                "\njobs:\n",
                ["", "defaults:", "    run:", "        shell: bash {0}", "", "jobs:", ""].join(
                    "\n",
                ),
            ),
    ],
    [
        "AW",
        "a step continue-on-error with its value on the next line",
        [CI],
        () =>
            sub(
                CI,
                VERIFY_CI,
                [
                    "            - name: gate",
                    "              continue-on-error:",
                    "                  true",
                    "              run: node scripts/carrier-artifacts/verify.mjs",
                ].join("\n"),
            ),
    ],
    [
        "AX",
        "a folded step label that only names the verify",
        [CI],
        () =>
            sub(
                CI,
                VERIFY_CI,
                [
                    "            - name: >-",
                    "                  node scripts/carrier-artifacts/verify.mjs",
                    "              run: echo gated",
                ].join("\n"),
            ),
    ],

    // --- round 5: the nesting model's own holes, and the two readers beside it ---
    [
        "AY",
        "a loop terminator that is only a word in an echo",
        [CI],
        () =>
            sub(
                CI,
                VERIFY_CI,
                [
                    "            - run: |",
                    '                  if [ -n "$CI" ]; then',
                    "                    echo done",
                    "                    node scripts/carrier-artifacts/verify.mjs",
                    "                  fi",
                ].join("\n"),
            ),
    ],
    [
        "AZ",
        "errexit cleared by a compound set flag",
        [CI],
        () =>
            sub(
                CI,
                VERIFY_CI,
                [
                    "            - run: |",
                    "                  set +eu",
                    "                  node scripts/carrier-artifacts/verify.mjs",
                ].join("\n"),
            ),
    ],
    [
        "BA",
        "a verify inside a subshell group",
        [CI],
        () =>
            sub(
                CI,
                VERIFY_CI,
                [
                    "            - run: |",
                    "                  (",
                    "                    node scripts/carrier-artifacts/verify.mjs",
                    "                  ) || true",
                ].join("\n"),
            ),
    ],
    [
        "BB",
        "a workflow-level defaults shell in flow style",
        [CI],
        () =>
            sub(
                CI,
                "\njobs:\n",
                [
                    "",
                    "defaults:",
                    '    run: { shell: "bash --noprofile --norc {0}" }',
                    "",
                    "jobs:",
                    "",
                ].join("\n"),
            ),
    ],
    [
        "BC",
        "a bare key consuming the install beneath it",
        [CI],
        () =>
            sub(
                CI,
                "            - uses: pnpm/action-setup@v4\n            - uses: actions/setup-node@v5",
                [
                    "            - uses: pnpm/action-setup@v4",
                    "              with:",
                    "                  if:",
                    "                  run_install: true",
                    "            - uses: actions/setup-node@v5",
                ].join("\n"),
            ),
    ],

    // --- round 6: two correct rules that composed, and the env that re-points ---
    [
        "BD",
        "a verify that is only heredoc text",
        [DF],
        () =>
            sub(
                DF,
                VERIFY_DF,
                ["RUN cat <<EOF", "- run: node scripts/carrier-artifacts/verify.mjs", "EOF"].join(
                    "\n",
                ),
            ),
    ],
    [
        "BE",
        "a bullet re-arming from inside a conditional",
        [CI],
        () =>
            sub(
                CI,
                VERIFY_CI,
                [
                    "            - run: |",
                    '                  if [ -n "$CI" ]; then',
                    "                    - item: value",
                    "                    node scripts/carrier-artifacts/verify.mjs",
                    "                  fi",
                ].join("\n"),
            ),
    ],
    [
        "BF",
        "a job re-pointing the shell through SHELLOPTS",
        [CI],
        () =>
            sub(
                CI,
                "    gates:\n        runs-on: ubuntu-latest",
                [
                    "    gates:",
                    "        runs-on: ubuntu-latest",
                    "        env:",
                    "            SHELLOPTS: noexec",
                ].join("\n"),
            ),
    ],
    [
        "BG",
        "a workflow-level env that re-points it",
        [CI],
        () =>
            sub(CI, "\njobs:\n", ["", "env:", "    SHELLOPTS: noexec", "", "jobs:", ""].join("\n")),
    ],

    [
        "AH",
        "one install opt-out marker, the former free bypass",
        [CI],
        () =>
            sub(
                CI,
                "            - run: pnpm install --frozen-lockfile\n            # Run all four",
                "            # carrier-artifacts: not a dependency install\n            - run: pnpm install --frozen-lockfile\n            # Run all four",
            ),
    ],
];

const run = () => {
    const r = spawnSync(process.execPath, [at("scripts/carrier-artifacts/verify.mjs")], {
        cwd: REPO,
        encoding: "utf8",
    });
    return { code: r.status, out: `${r.stdout ?? ""}${r.stderr ?? ""}` };
};

// Restore from bytes read before injection, NOT from git: the working tree
// carries the fixes under test and `git checkout --` would discard them.
const snapshot = (files) => files.map((p) => [p, existsSync(at(p)) ? readFileSync(at(p)) : null]);
const restore = (saved) =>
    saved.forEach(([p, bytes]) =>
        bytes === null ? rmSync(at(p), { force: true }) : writeFileSync(at(p), bytes),
    );
// A fault that changes no bytes cannot be caught, and scoring it MISSED hides
// that it is inert while making the totals look worse.
const assertMutated = (id, saved) => {
    const changed = saved.some(([p, bytes]) => {
        const now = existsSync(at(p)) ? readFileSync(at(p)) : null;
        return now === null || bytes === null ? now !== bytes : !now.equals(bytes);
    });
    if (!changed) throw new Error(`fault ${id} is inert: it changed no bytes`);
};

// Exit != 0 proves the run failed, not that the INTENDED check fired. A fault
// that trips an unrelated assertion is a false CAUGHT — the same cannot-fail
// shape, moved into the instrument.
// The line number is already in the message and is the only token separating
// two faults on the same unit, so it is pinned too. It takes the largest
// collision group from 10 to 4; unit+line is the finest grain the scan reports.
const EXPECTED = {
    A: "manifest says",
    B: "which is not a frozen archive",
    C: "not the pinned",
    D: "which is not the frozen archive",
    E: "still names .reference/vendor",
    F: "job gates installs at line 21",
    G: "job gates installs at line 22",
    H: "job gates installs at line 23",
    I: "job gates installs at line 21",
    J: "installs before it copies",
    K: "stage build installs at line 22",
    L: "stage runtime installs at line 57",
    M: "yielded no jobs",
    N: "attributes to no job",
    O: "attributes to no stage",
    P: "2 install exemptions",
    Q: "declares overrides",
    Q2: "declares overrides",
    R: "which this scan does not read",
    R2: "which this scan does not read",
    S: "is missing; the frozen archives",
    T: "which is not a frozen archive",
    U: "job gates installs at line 18",
    V: "declared candidate resolutions were confirmed",
    W: "job gates installs at line 24",
    X: "job gates installs at line 23",
    Y: "job vectors installs at line 47",
    Z: "stage build installs at line 22",
    AA: "stage build installs at line 22",
    AB: "stage build installs at line 22",
    AC: "stage build installs at line 23",
    AD: "job packages installs at line 77",
    AE: "which this scan does not read",
    AF: "the registry answers that coordinate",
    AG: "a published manifest must not carry a path",
    AH: "1 install exemptions",
    AI: "job gates installs at line 22",
    AJ: "job packages installs at line 79",
    AK: "job vectors installs at line 51",
    AL: "job e2e installs at line 66",
    AM: "stage build installs at line 23",
    AN: "job gates installs at line 25",
    AO: "which this scan does not read",
    AP: "stage build installs at line 23",
    AQ: "job gates installs at line 24",
    AR: "job e2e installs at line 66",
    AS: "stage build installs at line 23",
    AT: "job gates installs at line 24",
    AU: "job gates installs at line 25",
    AV: "defaults every run to a shell or environment",
    AW: "job gates installs at line 25",
    AX: "job gates installs at line 24",
    AY: "job gates installs at line 26",
    AZ: "job gates installs at line 24",
    BA: "job gates installs at line 25",
    BB: "defaults every run to a shell or environment",
    BC: "job gates installs at line 19",
    BD: "stage build installs at line 24",
    BE: "job gates installs at line 26",
    BF: "job gates installs at line 24",
    BG: "defaults every run to a shell or environment",
};

const dirty = execFileSync("git", ["-C", REPO, "status", "--porcelain", "--", ...TOUCHED], {
    encoding: "utf8",
}).trim();
if (dirty) {
    console.error(`refusing to inject into a dirty tree:
${dirty}`);
    process.exit(9);
}

const clean = run();
console.log(`clean tree before: exit ${clean.code}`);
if (clean.code !== 0) process.exit(9);

const ONLY = process.argv[2] ? new Set(process.argv[2].split(",")) : undefined;
// A typo'd id must not read as a clean run: it filtered the loop to nothing and
// still exited 0.
for (const id of ONLY ?? [])
    if (!faults.some(([known]) => known === id)) throw new Error(`no such fault: ${id}`);
let caught = 0;
const missed = [];
const misattributed = [];
for (const [id, label, files, inject] of faults) {
    if (ONLY && !ONLY.has(id)) continue;
    const expected = EXPECTED[id];
    if (!expected) throw new Error(`fault ${id} declares no expected message`);
    const saved = snapshot(files);
    let result;
    try {
        inject();
        assertMutated(id, saved);
        result = run();
    } finally {
        restore(saved);
    }
    const red = result.code !== 0;
    const attributed = red && result.out.includes(expected);
    if (attributed) caught++;
    else if (red) misattributed.push(id);
    else missed.push(id);
    const first = (result.out.split("\n").find((l) => l.trim().startsWith("- ")) ?? result.out)
        .trim()
        .slice(0, 88);
    const verdict = attributed ? "RED " : red ? "WRONG" : "GREEN";
    console.log(`${verdict} ${id.padEnd(3)} ${label.padEnd(56)} ${red ? first : "(missed)"}`);
}

const after = run();
console.log(`clean tree after: exit ${after.code}`);
const total = ONLY ? ONLY.size : faults.length;
console.log(
    `caught ${caught}/${total}${missed.length ? ` — missed ${missed.join(",")}` : ""}` +
        `${misattributed.length ? ` — misattributed ${misattributed.join(",")}` : ""}`,
);
const left = execFileSync("git", ["-C", REPO, "status", "--porcelain", "--", ...TOUCHED], {
    encoding: "utf8",
}).trim();
if (left)
    console.error(`RESTORE FAILED, run git checkout --:
${left}`);
process.exit(missed.length || misattributed.length || after.code !== 0 || left ? 1 : 0);
