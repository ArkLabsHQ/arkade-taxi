import { describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { join, resolve } from "node:path";
import {
    assertArtifactSafe,
    assertCleanupCandidates,
    assertLocalConsumerResolution,
    assertProjectNetwork,
    assertProjectVolumes,
    assertPackResult,
    assertPortBindingContract,
    assertConfiguredArkDelays,
    assertOwnedServiceEnvironment,
    assertVolumeDeletionCandidates,
    assertRenderedCompose,
    buildStackManifest,
    buildTaxiRunArgs,
    acquireNewAssetFreePreconfirmed,
    buildArkFundingArgs,
    buildConsumerManifest,
    captureOwnedTaxiLogs,
    canonicalVtxoSnapshot,
    ensureActorSecrets,
    ensureAssetFreeFunding,
    ensureFreshAssetFreeFunding,
    ensureMintedAsset,
    eventSourceNodeEnvironment,
    explicitMine,
    formatProcessFailure,
    isTaxiReadyResponse,
    discoverProfileClosure,
    discoverPortBindings,
    namespaceRegtestSources,
    nodeEventSourceArgs,
    pollUntil,
    parsePublishedPort,
    packageManagerInvocation,
    packageManagerEnvironment,
    assertResolvedPorts,
    assertTarballIntegrity,
    assertVtxoSnapshotContains,
    contextualizeFailure,
    resolvePortRefresh,
    resolveMasterSha,
    resolveTask12Tests,
    resolveInstalledClientEntry,
    renewalFundingAmount,
    removeStaleFailureDiagnostics,
    sanitizeError,
    taxiLogArgs,
} from "../lib/harness.mjs";
import { settleSelectedFunding } from "../e2e-settle.mjs";
import { ARKD_DELAYS } from "../e2e-stack.mjs";
import { expiryOf } from "../e2e-wallets.mjs";

it("refreshes both rebound arkd ports until the current real HTTP admin endpoint is ready", async () => {
    const readyServer = createServer((_request, response) => response.writeHead(200).end("ready"));
    let current = readyServer;
    const oldServer = createServer((_request, response) => {
        current = readyServer;
        response.writeHead(503).end("restarting");
    });
    for (const server of [oldServer, readyServer])
        await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    current = oldServer;
    const bindings = [
        ["ARKD_PORT", "arkd", 7070],
        ["ARKD_ADMIN_PORT", "arkd", 7071],
    ];
    const environment: Record<string, string> = {
        TAXI_E2E_PROJECT: "taxi12-123456789abc",
        TAXI_E2E_PORT_BINDINGS: JSON.stringify(bindings),
    };
    const sources = {
        base: "services:\n  bitcoin:\n    image: bitcoin\n",
        ark: "services:\n  arkd:\n    image: arkd\n",
        compose: "'compose',",
        proc: "return docker(['exec', container, ...argv], opts);",
        arkdSetup:
            "const arkdUrl = () => `http://localhost:${env('ARKD_PORT', '7070')}`;\nconst arkdAdminUrl = () => `http://localhost:${env('ARKD_ADMIN_PORT', '7071')}`;",
        regtest: [
            "import { ROOT, composeUp, composeStop, composeDown } from './lib/compose.mjs';",
            "async function startEmulator() {}",
            "async function unused() {",
            "if (firstWave.code !== 0) fail('docker compose up failed');",
            "if (appWave.code !== 0) fail('docker compose up failed');",
            "docker(['exec', 'arkd', ...argv]); docker(['exec', 'bitcoin', ...argv]);",
            "}",
            "if (active.has('ark')) await setupArkd();",
        ].join("\n"),
    };
    const transformed = namespaceRegtestSources(sources, environment.TAXI_E2E_PROJECT, bindings);
    const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
    const run = new AsyncFunction(
        "process",
        "composePort",
        "sleep",
        "log",
        "fail",
        "active",
        "waveProfiles",
        "setupArkd",
        transformed.regtest.replace(/^import .*;$/m, ""),
    );
    let setupCalls = 0;
    try {
        await run(
            { env: environment },
            () => ({ code: 0, stdout: `127.0.0.1:${(current.address() as AddressInfo).port}` }),
            (ms: number) => new Promise((resolve) => setTimeout(resolve, ms)),
            () => {},
            (message: string) => {
                throw new Error(message);
            },
            new Set(["ark"]),
            ["base", "ark"],
            async () => {
                setupCalls++;
                const response = await fetch(
                    `http://127.0.0.1:${environment.ARKD_ADMIN_PORT}/v1/admin/wallet/status`,
                );
                await response.body?.cancel();
                if (!response.ok)
                    throw new Error(
                        `setup used an unready stale admin binding: HTTP ${response.status}`,
                    );
            },
        );
        expect(setupCalls).toBe(1);
        const port = String((readyServer.address() as AddressInfo).port);
        expect(environment.ARKD_ADMIN_PORT).toBe(port);
        expect(environment.ARKD_PORT).toBe(port);
    } finally {
        for (const server of [oldServer, readyServer]) {
            server.closeAllConnections();
            await new Promise<void>((resolve) => server.close(() => resolve()));
        }
    }
}, 15_000);

describe("bounded polling", () => {
    it("propagates interruption instead of retrying an aborted read", async () => {
        const controller = new AbortController();
        const interruption = new Error("stop polling for cleanup");
        let reads = 0;
        let delays = 0;
        let now = 0;
        await expect(
            pollUntil({
                label: "interruptible state",
                timeoutMs: 60_000,
                signal: controller.signal,
                read: async () => {
                    reads++;
                    controller.abort(interruption);
                    throw new Error("aborted socket");
                },
                ready: () => false,
                now: () => now,
                delay: async (milliseconds) => {
                    delays++;
                    now += milliseconds;
                },
            }),
        ).rejects.toBe(interruption);
        expect({ reads, delays }).toEqual({ reads: 1, delays: 0 });
    });

    it("reports the last observed state when its deadline expires", async () => {
        let now = 0;
        let attempt = 0;
        await expect(
            pollUntil({
                label: "indexed covenant outpoint",
                timeoutMs: 20,
                intervalMs: 10,
                now: () => now,
                delay: async (ms: number) => {
                    now += ms;
                },
                read: async () => ({ height: 40 + attempt++, spendable: false }),
                ready: (state: { spendable: boolean }) => state.spendable,
            }),
        ).rejects.toThrow(
            'timed out waiting for indexed covenant outpoint after 20ms; attempts=3; last={"height":42,"spendable":false}',
        );
    });
});

describe("Taxi readiness response", () => {
    const healthy = {
        status: 200,
        body: {
            status: "ok",
            startup: { phase: "ready", complete: true, blocker: null },
            blockers: [],
            runtime: { inventory: { usableSats: "500000" } },
        },
    };

    it("accepts the production service contract without a body.ready field", () => {
        expect(isTaxiReadyResponse(healthy)).toBe(true);
    });

    it.each([
        [{ ...healthy, status: 503 }, "HTTP 503"],
        [{ ...healthy, body: { ...healthy.body, status: "degraded" } }, "degraded"],
        [{ ...healthy, body: { ...healthy.body, blockers: ["operator_reserve_low"] } }, "blocked"],
        [{ ...healthy, body: { ...healthy.body, blockers: null } }, "malformed blockers"],
        [{ ...healthy, body: { ...healthy.body, startup: undefined } }, "missing startup"],
        [
            {
                ...healthy,
                body: { ...healthy.body, startup: { phase: "syncing", complete: false } },
            },
            "incomplete startup",
        ],
        [{ status: 200, body: null }, "malformed body"],
    ])("rejects %s readiness state (%s)", (response) => {
        expect(isTaxiReadyResponse(response)).toBe(false);
    });
});

describe("durable VTXO snapshots", () => {
    const expiry = (coin: { expiry: { kind: "height" | "time"; value: bigint } }) => coin.expiry;
    const coin = (txByte: string, vout: number, value: bigint) => ({
        txid: txByte.repeat(64),
        vout,
        expiry: { kind: "time" as const, value },
    });

    it("canonicalizes outpoints and allows late durable additions without losing observations", () => {
        const first = coin("a", 1, 900n);
        const second = coin("b", 0, 901n);
        const late = coin("c", 2, 902n);
        const observed = canonicalVtxoSnapshot([second, first], expiry);
        const durable = canonicalVtxoSnapshot([late, first, second], expiry);

        expect(observed.map(({ txid }) => txid)).toEqual([first.txid, second.txid]);
        expect(assertVtxoSnapshotContains(durable, observed)).toBe(durable);
        expect(canonicalVtxoSnapshot([second, late, first], expiry)).toEqual(durable);
    });

    it("rejects durable loss, changed expiry, duplicate outpoints, and invalid expiry", () => {
        const first = coin("d", 0, 1_000n);
        const second = coin("e", 1, 1_001n);
        const observed = canonicalVtxoSnapshot([first, second], expiry);
        expect(() =>
            assertVtxoSnapshotContains(canonicalVtxoSnapshot([second], expiry), observed),
        ).toThrow(/lost observed VTXO/);
        expect(() =>
            assertVtxoSnapshotContains(
                canonicalVtxoSnapshot(
                    [{ ...first, expiry: { kind: "time", value: 2_000n } }, second],
                    expiry,
                ),
                observed,
            ),
        ).toThrow(/changed observed VTXO/);
        expect(() => canonicalVtxoSnapshot([first, first], expiry)).toThrow(/duplicate VTXO/);
        expect(() => canonicalVtxoSnapshot([{ ...first, txid: "not-a-txid" }], expiry)).toThrow(
            /invalid VTXO outpoint/,
        );
        expect(() =>
            canonicalVtxoSnapshot(
                [{ ...first, expiry: { kind: "time" as const, value: 0n } }],
                expiry,
            ),
        ).toThrow(/invalid VTXO expiry/);
    });
});

describe("explicit mining", () => {
    it("passes a positive block count to the discovered regtest CLI", async () => {
        let observed: string[] = [];
        const result = await explicitMine(3, async (args: string[]) => {
            observed = args;
            return { code: 0, stdout: '["a","b","c"]', stderr: "" };
        });
        expect(observed).toEqual(["mine", "3"]);
        expect(result.blocks).toBe(3);
    });

    it.each([undefined, 0, -1, 1.5])("rejects a non-positive explicit count: %s", async (count) => {
        await expect(explicitMine(count as number, async () => ({ code: 0 }))).rejects.toThrow(
            "explicit positive integer block count",
        );
    });
});

describe("dynamic stack credentials", () => {
    it("passes the run password to ark funding without a fixed fallback", () => {
        const password = "run-specific-password";
        const args = buildArkFundingArgs({ address: "tark1fixture", amount: 100_000, password });
        expect(args).toEqual([
            "ark",
            "send",
            "--to",
            "tark1fixture",
            "--amount",
            "100000",
            "--password",
            password,
        ]);
        expect(args).not.toContain("secret");
    });
});

describe("SDK runtime", () => {
    it("enables Node's EventSource for live wallet streams", () => {
        expect(nodeEventSourceArgs("scripts/e2e-bootstrap.mjs", ["--fixture"])).toEqual([
            "--experimental-eventsource",
            "scripts/e2e-bootstrap.mjs",
            "--fixture",
        ]);
    });

    it("enables EventSource in the production Taxi process", () => {
        const dockerfile = readFileSync(new URL("../../Dockerfile", import.meta.url), "utf8");
        expect(dockerfile).toContain(
            'CMD ["node", "--experimental-eventsource", "--enable-source-maps", "dist/cli.js", "serve"]',
        );
    });

    it("enables EventSource for Vitest without discarding existing Node options", () => {
        expect(
            eventSourceNodeEnvironment({
                NODE_OPTIONS: "--max-old-space-size=2048",
                TAXI_E2E_BASE_URL: "http://127.0.0.1:49152",
            }),
        ).toEqual({
            NODE_OPTIONS: "--max-old-space-size=2048 --experimental-eventsource",
            TAXI_E2E_BASE_URL: "http://127.0.0.1:49152",
        });
        expect(
            eventSourceNodeEnvironment({ NODE_OPTIONS: "--experimental-eventsource" }).NODE_OPTIONS,
        ).toBe("--experimental-eventsource");
        const stack = readFileSync(new URL("../e2e-stack.mjs", import.meta.url), "utf8");
        expect(stack).toContain("const testEnv = eventSourceNodeEnvironment({");
        expect(stack).toContain("env: testEnv");
    });
});

describe("package manager process boundary", () => {
    const task12Tests = [
        "e2e/provider-contract.e2e.test.ts",
        "e2e/claim.e2e.test.ts",
        "e2e/exposure.e2e.test.ts",
        "e2e/verify-quote.e2e.test.ts",
        "e2e/refund-recovery.e2e.test.ts",
        "e2e/resilience.e2e.test.ts",
        "e2e/suite-integrity.e2e.test.ts",
    ];

    it("resolves only the exact Task 12 live test pair before orchestration", () => {
        expect(resolveTask12Tests([])).toEqual(task12Tests);
        expect(resolveTask12Tests(task12Tests)).toEqual(task12Tests);
        expect(resolveTask12Tests([...task12Tests].reverse())).toEqual(task12Tests);
    });

    it.each([
        [[task12Tests[0]], "missing test"],
        [[task12Tests[0], task12Tests[0]], "duplicate"],
        [[...task12Tests, "e2e/unknown.e2e.test.ts"], "unknown"],
        [[...task12Tests, "--config=attacker.ts"], "leading option"],
        [[...task12Tests, "../outside.test.ts"], "traversal"],
        [[...task12Tests, "/tmp/outside.test.ts"], "POSIX absolute"],
        [[...task12Tests, "C:\\outside.test.ts"], "Windows absolute"],
    ])("rejects %s Task 12 test arguments", (args) => {
        expect(() => resolveTask12Tests(args)).toThrow("exactly the two approved test paths");
    });

    it("invokes pnpm's JavaScript entrypoint directly on win32", () => {
        const node = "C:\\node\\node.exe";
        const entry = "C:\\node\\node_modules\\corepack\\dist\\pnpm.js";
        const npmEntry = "C:\\node\\node_modules\\npm\\bin\\npm-cli.js";
        const testArg = "e2e/name; Remove-Item -Recurse C:\\unrelated";
        expect(
            packageManagerInvocation(["exec", "vitest", "run", testArg], {
                platform: "win32",
                execPath: node,
                npmExecPath: npmEntry,
                exists: (candidate: string) => candidate === npmEntry || candidate === entry,
            }),
        ).toEqual({ command: node, args: [entry, "exec", "vitest", "run", testArg] });
    });

    it("uses shell-free pnpm argv on non-win32 platforms", () => {
        const testArg = "e2e/name; rm -rf /unrelated";
        expect(
            packageManagerInvocation(["exec", "vitest", "run", testArg], {
                platform: "linux",
                execPath: "/usr/bin/node",
                exists: () => false,
            }),
        ).toEqual({ command: "pnpm", args: ["exec", "vitest", "run", testArg] });
    });

    it("builds a consumer manifest from exactly three local Taxi tarballs", () => {
        const tarballs = [
            "/tmp/run/packs/arkade-taxi-covenant-0.0.0.tgz",
            "/tmp/run/packs/arkade-taxi-protocol-0.0.0.tgz",
            "/tmp/run/packs/arkade-taxi-client-0.0.0.tgz",
        ];
        const manifest = buildConsumerManifest(tarballs, "/tmp/run/consumer", "linux");
        expect(manifest.dependencies).toEqual({
            "@arkade-taxi/client": "file:../packs/arkade-taxi-client-0.0.0.tgz",
            "@arkade-taxi/covenant": "file:../packs/arkade-taxi-covenant-0.0.0.tgz",
            "@arkade-taxi/protocol": "file:../packs/arkade-taxi-protocol-0.0.0.tgz",
        });
        expect(manifest.pnpm.overrides).toEqual({
            "@arkade-taxi/covenant@0.0.0": "$@arkade-taxi/covenant",
            "@arkade-taxi/protocol@0.0.0": "$@arkade-taxi/protocol",
        });
        expect(JSON.stringify(manifest)).not.toContain('"0.0.0"');
        const lock = Object.values(manifest.dependencies).join("\n");
        const listed = {
            dependencies: Object.fromEntries(
                Object.entries(manifest.dependencies).map(([name, resolved]) => [
                    name,
                    { resolved, version: "0.0.0" },
                ]),
            ),
        };
        expect(assertLocalConsumerResolution(manifest, lock, listed)).toBe(listed);
        expect(() =>
            assertLocalConsumerResolution(manifest, lock, {
                ...listed,
                dependencies: {
                    ...listed.dependencies,
                    "@arkade-taxi/protocol": {
                        resolved: "https://registry.npmjs.org/@arkade-taxi/protocol",
                        version: "0.0.0",
                    },
                },
            }),
        ).toThrow("did not resolve from its local tarball");
        expect(() =>
            buildConsumerManifest(tarballs.slice(1), "/tmp/run/consumer", "linux"),
        ).toThrow("exactly three");
        expect(() =>
            buildConsumerManifest([...tarballs, tarballs[0]], "/tmp/run/consumer", "linux"),
        ).toThrow("exactly three");
    });

    it("isolates package-manager configuration and removes credential environment keys", () => {
        const clean = packageManagerEnvironment(
            {
                PATH: "C:\\bin",
                NPM_TOKEN: "npm-secret",
                NODE_AUTH_TOKEN: "node-secret",
                "npm_config_//registry.npmjs.org/:_authToken": "config-secret",
                YARN_NPM_AUTH_TOKEN: "yarn-secret",
                NPM_CONFIG_USERCONFIG: "C:\\user\\.npmrc",
                TAXI_OPERATOR_PRIVKEY: "actor-secret-that-pnpm-child-needs",
            },
            "C:\\run\\empty.npmrc",
        );
        expect(clean).toMatchObject({
            PATH: "C:\\bin",
            NPM_CONFIG_USERCONFIG: "C:\\run\\empty.npmrc",
            NPM_CONFIG_GLOBALCONFIG: "C:\\run\\empty.npmrc",
        });
        expect(clean).not.toHaveProperty("TAXI_OPERATOR_PRIVKEY");
        expect(
            Object.keys(clean).filter((key) => /^(?:npm|node|yarn).*?(?:auth|token)/i.test(key)),
        ).toEqual([]);
        expect(Object.values(clean)).not.toContain("npm-secret");
        expect(Object.values(clean)).not.toContain("node-secret");
        expect(Object.values(clean)).not.toContain("config-secret");
        expect(Object.values(clean)).not.toContain("yarn-secret");
    });

    it("validates pack identity and detects tarball mutation", () => {
        const packDir = join("tmp", "packs");
        const filename = resolve(packDir, "arkade-taxi-client-0.0.0.tgz");
        expect(
            assertPackResult(
                JSON.stringify({
                    name: "@arkade-taxi/client",
                    version: "0.0.0",
                    filename,
                }),
                { name: "@arkade-taxi/client", packDir },
                (candidate: string) => candidate === filename,
            ),
        ).toBe(filename);
        expect(() =>
            assertPackResult(
                JSON.stringify({ name: "@arkade-taxi/client", version: "1.0.0", filename }),
                { name: "@arkade-taxi/client", packDir },
                () => true,
            ),
        ).toThrow("pack result changed");
        expect(assertTarballIntegrity({ [filename]: "abc" }, { [filename]: "abc" })).toEqual({
            [filename]: "abc",
        });
        expect(() => assertTarballIntegrity({ [filename]: "abc" }, { [filename]: "def" })).toThrow(
            "tarball changed",
        );
    });

    it("requires the installed packed client entry", () => {
        const consumer = join("tmp", "consumer");
        const expected = join(
            consumer,
            "node_modules",
            "@arkade-taxi",
            "client",
            "dist",
            "index.js",
        );
        expect(
            resolveInstalledClientEntry(consumer, (candidate: string) => candidate === expected),
        ).toBe(expected);
        expect(() => resolveInstalledClientEntry(consumer, () => false)).toThrow(
            "packed client entry is missing",
        );
    });

    it("routes every stack build, pack, install, and Vitest call through the safe helper", () => {
        const stack = readFileSync(new URL("../e2e-stack.mjs", import.meta.url), "utf8");
        expect(stack).toMatch(
            /async function main\(\) \{\s*const tests = resolveTask12Tests\(process\.argv\.slice\(2\)\);/,
        );
        expect(stack).not.toContain('run("pnpm"');
        expect(stack.match(/await runPnpm\(/g)).toHaveLength(4);
        expect(stack).toContain("packageManagerEnvironment(options.env");
        expect(stack).toContain(
            '["--store-dir", storeDir, "install", "--ignore-scripts", "--frozen-lockfile=false"]',
        );
        expect(stack).toContain("pathToFileURL(entry).href");
        expect(stack).toContain("nodeEventSourceArgs(vitestEntry");
    });
});

describe("master provenance", () => {
    it("accepts one exact resolved commit and rejects decorated output", () => {
        const sha = "d9e08ac0552aa12a23b688642aa9a82cf5dc1b7d";
        expect(resolveMasterSha(` ${sha}\n`)).toBe(sha);
        expect(() => resolveMasterSha(`HEAD ${sha}`)).toThrow("exact 40-character master SHA");
    });
});

describe("isolated regtest sources", () => {
    it("requires the exact five rendered seconds-domain Ark delays", () => {
        const expected = {
            ARKD_VTXO_TREE_EXPIRY: "172800",
            ARKD_UNILATERAL_EXIT_DELAY: "86400",
            ARKD_PUBLIC_UNILATERAL_EXIT_DELAY: "86400",
            ARKD_BOARDING_EXIT_DELAY: "7776000",
            ARKD_CHECKPOINT_EXIT_DELAY: "86400",
        };
        expect(ARKD_DELAYS).toEqual(expected);
        expect(assertConfiguredArkDelays(expected, expected)).toEqual(expected);
        expect(() =>
            assertConfiguredArkDelays({ ...expected, ARKD_VTXO_TREE_EXPIRY: "500" }, expected),
        ).toThrow(/ARKD_VTXO_TREE_EXPIRY.*seconds-domain.*at least 512/);
        expect(() =>
            assertConfiguredArkDelays(
                { ...expected, ARKD_CHECKPOINT_EXIT_DELAY: undefined },
                expected,
            ),
        ).toThrow(/ARKD_CHECKPOINT_EXIT_DELAY.*missing/);
        expect(() =>
            assertConfiguredArkDelays(
                { ...expected, ARKD_BOARDING_EXIT_DELAY: "7776001" },
                expected,
            ),
        ).toThrow(/expected ARKD_BOARDING_EXIT_DELAY=7776000, received 7776001/);
    });

    it("proves the running owned arkd container has the exact isolated delay environment", () => {
        const arkd = {
            Id: "arkd-container",
            Name: "/taxi12-a1b2c3d4-arkd-1",
            State: { Running: true },
            Config: {
                Env: [],
                Labels: {
                    "com.docker.compose.project": "taxi12-a1b2c3d4",
                    "com.docker.compose.service": "arkd",
                },
            },
        };
        const expected = {
            project: "taxi12-a1b2c3d4",
            service: "arkd",
            environment: {
                ARKD_VTXO_TREE_EXPIRY: "172800",
                ARKD_UNILATERAL_EXIT_DELAY: "86400",
                ARKD_PUBLIC_UNILATERAL_EXIT_DELAY: "86400",
                ARKD_BOARDING_EXIT_DELAY: "7776000",
                ARKD_CHECKPOINT_EXIT_DELAY: "86400",
            },
        };
        arkd.Config.Env = [
            "ARKD_LOG_LEVEL=5",
            ...Object.entries(expected.environment).map(([key, value]) => `${key}=${value}`),
        ];

        expect(assertOwnedServiceEnvironment([arkd], expected)).toEqual(expected.environment);
        expect(() =>
            assertOwnedServiceEnvironment([{ ...arkd, State: { Running: false } }], expected),
        ).toThrow(/arkd container is not running/);
        expect(() =>
            assertOwnedServiceEnvironment(
                [
                    {
                        ...arkd,
                        Config: {
                            ...arkd.Config,
                            Labels: {
                                ...arkd.Config.Labels,
                                "com.docker.compose.project": "arkade-regtest",
                            },
                        },
                    },
                ],
                expected,
            ),
        ).toThrow(/wrong project label/);
        expect(() =>
            assertOwnedServiceEnvironment(
                [
                    {
                        ...arkd,
                        Config: {
                            ...arkd.Config,
                            Env: [
                                ...arkd.Config.Env.filter(
                                    (entry) => !entry.startsWith("ARKD_VTXO_TREE_EXPIRY="),
                                ),
                                "ARKD_VTXO_TREE_EXPIRY=500",
                            ],
                        },
                    },
                ],
                expected,
            ),
        ).toThrow(/expected ARKD_VTXO_TREE_EXPIRY=172800, received 500/);
    });

    it("discovers the smallest emulator closure from the checked-out CLI", () => {
        const cli = `const PROFILE_DEPS = {
          base: [],
          ark: ['base'],
          emulator: ['ark'],
          solver: ['ark', 'emulator'],
        };`;
        expect(discoverProfileClosure(cli, "emulator", "d9e08ac")).toEqual([
            "base",
            "ark",
            "emulator",
        ]);
        expect(() => discoverProfileClosure(cli, "asset", "d9e08ac")).toThrow(
            'arkade-regtest d9e08ac has no "asset" profile',
        );
    });

    it("discovers selected published-port bindings from the checked-out Compose files", () => {
        const source = `services:
  bitcoin:
    ports:
      - '127.0.0.1:\${BITCOIN_RPC_PORT:-18443}:18443'
  arkd:
    ports:
      - '\${ARKD_PORT:-7070}:7070'
  excluded:
    ports:
      - '\${OTHER_PORT:-9999}:9999'
`;
        expect(
            discoverPortBindings(
                source,
                ["bitcoin", "arkd"],
                ["BITCOIN_RPC_PORT", "ARKD_PORT"],
                "d9e08ac",
            ),
        ).toEqual([
            ["BITCOIN_RPC_PORT", "bitcoin", 18443],
            ["ARKD_PORT", "arkd", 7070],
        ]);
    });

    it("removes global names and adds an explicit unique project to every compose call", () => {
        const sources = {
            base: "name: arkade-regtest\nservices:\n  bitcoin:\n    container_name: bitcoin\n    ports:\n      - '${BITCOIN_RPC_PORT:-18443}:18443'\n      - ${BITCOIN_P2P_PORT:-18444}:18444\n",
            ark: "name: arkade-regtest\nservices:\n  arkd:\n    container_name: arkd\n",
            arkdSetup:
                "const arkdUrl = () => `http://localhost:${env('ARKD_PORT', '7070')}`;\nconst arkdAdminUrl = () => `http://localhost:${env('ARKD_ADMIN_PORT', '7071')}`;\n",
            compose:
                "function baseArgs(profiles = []) { return ['compose', '-f', BASE, '-f', ARK]; }",
            proc: "export function dockerExec(container, argv, opts = {}) { return docker(['exec', container, ...argv], opts); }",
            regtest: [
                "import { ROOT, composeUp, composeStop, composeDown } from './lib/compose.mjs';",
                "async function startEmulator() {}",
                "if (firstWave.code !== 0) fail('docker compose up failed');",
                "if (appWave.code !== 0) fail('docker compose up failed');",
                "if (active.has('ark')) await setupArkd();",
                "const probe = `http://localhost:${env('MEMPOOL_WEB_PORT', '3000')}`;",
                "const a = docker(['exec', 'arkd', ...argv]); const b = docker(['exec', 'bitcoin', 'bitcoin-cli', ...argv.slice(1)]);",
            ].join("\n"),
        };
        const expectedBindings = [
            ["BITCOIN_RPC_PORT", "bitcoin", 18443],
            ["BITCOIN_P2P_PORT", "bitcoin", 18444],
        ];
        const transformed = namespaceRegtestSources(sources, "taxi12-a1b2c3d4", expectedBindings);
        expect(transformed.base).not.toMatch(/^(?:name|\s+container_name):/m);
        expect(transformed.base).toContain("127.0.0.1::18443");
        expect(transformed.base).toContain("127.0.0.1::18444");
        expect(transformed.base).not.toContain("BITCOIN_RPC_PORT");
        expect(transformed.ark).not.toMatch(/^(?:name|\s+container_name):/m);
        expect(transformed.compose).toContain("'-p', 'taxi12-a1b2c3d4'");
        expect(transformed.proc).toContain("'compose', '-p', 'taxi12-a1b2c3d4'");
        expect(transformed.regtest).not.toContain("docker(['exec'");
        expect(transformed.regtest).toContain("dockerExec('arkd'");
        expect(transformed.regtest).toContain("dockerExec('bitcoin'");
        expect(transformed.regtest).toContain(
            "await refreshPublishedPorts(['base'], taxiE2eBaseServices)",
        );
        expect(transformed.regtest).toContain("await refreshPublishedPorts(waveProfiles)");
        expect(transformed.compose).toContain("composePort(service, internalPort, profiles)");
        expect(transformed.regtest).toContain("published-port refresh timed out");
        expect(transformed.regtest).toContain("Resolved published ports:");
        expect(transformed.regtest).toContain("TAXI_E2E_REGTEST_SHA");
        expect(transformed.regtest).toContain("TAXI_E2E_PROJECT");
        expect(transformed.regtest).toContain("published-port binding contract changed");
        expect(transformed.regtest).toContain(
            "await refreshPublishedPorts(profiles, undefined, ['ARKD_PORT', 'ARKD_ADMIN_PORT'])",
        );
        expect(transformed.regtest).toContain("await waitForCurrentArkdAdmin(waveProfiles)");
        expect(transformed.regtest).toContain("for (let attempt = 1; attempt <= 40; attempt++)");
        expect(transformed.regtest).toContain("await sleep(250)");
        expect(transformed.regtest).toContain("last=${JSON.stringify(last)}");
        expect(transformed.regtest).not.toContain("http://localhost:${");
        expect(transformed.arkdSetup).not.toContain("http://localhost:${");
        expect(JSON.stringify(transformed)).not.toContain("container_name");
        const previous = process.env.BITCOIN_RPC_PORT;
        process.env.BITCOIN_RPC_PORT = "49152";
        try {
            expect(namespaceRegtestSources(sources, "taxi12-a1b2c3d4", expectedBindings).base).toBe(
                transformed.base,
            );
        } finally {
            if (previous === undefined) delete process.env.BITCOIN_RPC_PORT;
            else process.env.BITCOIN_RPC_PORT = previous;
        }
    });

    it.each(["arkade-regtest", "taxi_12", "taxi12", "taxi12-TOOLOUD"])(
        "rejects a non-isolated project name: %s",
        (name) =>
            expect(() =>
                namespaceRegtestSources(
                    { base: "", ark: "", compose: "", proc: "", regtest: "" },
                    name,
                ),
            ).toThrow("unique project name"),
    );

    it("fails a wave immediately when a required daemon binding cannot be resolved", () => {
        const bindings = [
            ["MEMPOOL_WEB_PORT", "mempool_web", 80],
            ["ARKD_ADMIN_PORT", "arkd", 7071],
        ];
        expect(() =>
            resolvePortRefresh(
                bindings,
                [
                    { name: "MEMPOOL_WEB_PORT", code: 0, stdout: "127.0.0.1:49152" },
                    {
                        name: "ARKD_ADMIN_PORT",
                        code: 1,
                        stdout: "",
                        stderr: "service arkd is disabled",
                    },
                ],
                new Set(["arkd"]),
            ),
        ).toThrow(
            "published-port refresh failed: ARKD_ADMIN_PORT(service=arkd,target=7071,code=1)",
        );
    });

    it("rejects a reordered or changed runtime binding contract before wave one", () => {
        const expected = [
            ["ARKD_PORT", "arkd", 7070],
            ["ARKD_ADMIN_PORT", "arkd", 7071],
        ];
        expect(() => assertPortBindingContract(expected, expected)).not.toThrow();
        expect(() =>
            assertPortBindingContract(
                [
                    ["ARKD_ADMIN_PORT", "arkd", 7071],
                    ["ARKD_PORT", "arkd", 7070],
                ],
                expected,
            ),
        ).toThrow("published-port binding contract changed");
    });

    it("rejects a rendered stack that can collide or silently changes service coverage", () => {
        const rendered = {
            name: "taxi12-a1b2c3d4",
            networks: { default: { name: "taxi12-a1b2c3d4_default" } },
            services: {
                bitcoin: { ports: [{ published: "41001", host_ip: "127.0.0.1" }] },
                "bitcoin-miner": {
                    environment: { AUTOMINE_INTERVAL: "0" },
                    ports: [{ published: "41002", host_ip: "127.0.0.1" }],
                },
            },
        };
        expect(() =>
            assertRenderedCompose(rendered, {
                project: "taxi12-a1b2c3d4",
                services: ["bitcoin", "bitcoin-miner"],
                publishedPorts: 2,
                network: "taxi12-a1b2c3d4_default",
            }),
        ).not.toThrow();
        expect(() =>
            assertRenderedCompose(
                {
                    ...rendered,
                    services: {
                        bitcoin: { ports: [{ host_ip: "127.0.0.1", target: 18443 }] },
                        "bitcoin-miner": {
                            environment: { AUTOMINE_INTERVAL: "0" },
                            ports: [{ host_ip: "127.0.0.1", target: 18444 }],
                        },
                    },
                },
                {
                    project: "taxi12-a1b2c3d4",
                    services: ["bitcoin", "bitcoin-miner"],
                    publishedPorts: 2,
                    network: "taxi12-a1b2c3d4_default",
                    daemonAssigned: true,
                },
            ),
        ).not.toThrow();
        expect(() =>
            assertRenderedCompose(
                {
                    ...rendered,
                    services: {
                        ...rendered.services,
                        bitcoin: {
                            container_name: "bitcoin",
                            ports: [{ published: "41001", host_ip: "127.0.0.1" }],
                        },
                    },
                },
                {
                    project: "taxi12-a1b2c3d4",
                    services: ["bitcoin", "bitcoin-miner"],
                    publishedPorts: 2,
                    network: "taxi12-a1b2c3d4_default",
                },
            ),
        ).toThrow("container_name");
        expect(() =>
            assertRenderedCompose(
                {
                    ...rendered,
                    services: {
                        ...rendered.services,
                        bitcoin: { ports: [{ published: "41001", host_ip: "0.0.0.0" }] },
                    },
                },
                {
                    project: "taxi12-a1b2c3d4",
                    services: ["bitcoin", "bitcoin-miner"],
                    publishedPorts: 2,
                    network: "taxi12-a1b2c3d4_default",
                },
            ),
        ).toThrow("127.0.0.1");
    });

    it("pins Taxi to the owned project network and internal service DNS", () => {
        const project = "taxi12-a1b2c3d4";
        const network = `${project}_default`;
        expect(() =>
            assertProjectNetwork(
                {
                    Name: network,
                    Labels: { "com.docker.compose.project": project },
                },
                { project, network },
            ),
        ).not.toThrow();
        expect(() =>
            assertProjectNetwork(
                {
                    Name: "arkade-regtest_default",
                    Labels: { "com.docker.compose.project": "arkade-regtest" },
                },
                { project, network },
            ),
        ).toThrow("network");
        const args = buildTaxiRunArgs({
            container: `${project}-taxi`,
            project,
            network,
            envFile: "C:/temp/taxi.env",
            volume: `${project}-taxi-data`,
            port: 0,
            image: `arkade-taxi:e2e-a1b2c3d4`,
        });
        expect(args).toContain(network);
        expect(args).not.toContain("host.docker.internal");
        expect(args).toContain("127.0.0.1::8080");
    });

    it("accepts only unique daemon-resolved nonzero host ports", () => {
        expect(parsePublishedPort("127.0.0.1:49152\n")).toBe(49152);
        expect(parsePublishedPort("[::1]:49153\n")).toBe(49153);
        expect(() => parsePublishedPort("0.0.0.0:0")).toThrow("published port");
        expect(() => assertResolvedPorts({ arkd: 49152, emulator: 49153 }, 2)).not.toThrow();
        expect(() => assertResolvedPorts({ arkd: 49152, emulator: 49152 }, 2)).toThrow("unique");
    });

    it("allows volume deletion only with the exact Compose project label", () => {
        const project = "taxi12-a1b2c3d4";
        const volumes = [
            {
                Name: "5f4dcc3b5aa765d61d8327deb882cf99",
                Labels: { "com.docker.compose.project": project },
            },
            {
                Name: `${project}_postgres_data`,
                Labels: { "com.docker.compose.project": project },
            },
        ];
        expect(() => assertProjectVolumes(volumes, { project })).not.toThrow();
        expect(() =>
            assertProjectVolumes(
                [
                    {
                        Name: "arkade-regtest_postgres_data",
                        Labels: { "com.docker.compose.project": "arkade-regtest" },
                    },
                ],
                { project },
            ),
        ).toThrow("volume");
    });

    it("accepts an anonymous volume only when every consumer is an owned project container", () => {
        const project = "taxi12-a1b2c3d4";
        const owned = {
            Id: "owned",
            Name: "/taxi12-a1b2c3d4-bitcoin-miner-1",
            Config: {
                Labels: {
                    "com.docker.compose.project": project,
                    "com.docker.compose.service": "bitcoin-miner",
                },
            },
        };
        const anonymous = {
            volume: {
                Name: "5f4dcc3b5aa765d61d8327deb882cf99",
                Labels: { "com.docker.volume.anonymous": "" },
            },
            named: false,
            consumers: [owned],
        };
        expect(() =>
            assertVolumeDeletionCandidates([anonymous], {
                project,
                services: ["bitcoin-miner"],
            }),
        ).not.toThrow();
        expect(() =>
            assertVolumeDeletionCandidates(
                [
                    {
                        ...anonymous,
                        consumers: [{ ...owned, Id: "foreign", Config: { Labels: {} } }],
                    },
                ],
                { project, services: ["bitcoin-miner"] },
            ),
        ).toThrow("project label");
        expect(() =>
            assertVolumeDeletionCandidates([{ ...anonymous, consumers: [] }], {
                project,
                services: ["bitcoin-miner"],
            }),
        ).toThrow("anonymous volume");
    });

    it("allows cleanup only for the exact unique project and known service labels", () => {
        const candidates = [
            {
                Id: "container-a",
                Name: "/taxi12-a1b2c3d4-bitcoin-1",
                Config: {
                    Labels: {
                        "com.docker.compose.project": "taxi12-a1b2c3d4",
                        "com.docker.compose.service": "bitcoin",
                    },
                },
            },
        ];
        expect(() =>
            assertCleanupCandidates(candidates, {
                project: "taxi12-a1b2c3d4",
                services: ["bitcoin"],
            }),
        ).not.toThrow();
        expect(() =>
            assertCleanupCandidates(
                [
                    {
                        ...candidates[0],
                        Config: {
                            Labels: {
                                "com.docker.compose.project": "arkade-regtest",
                                "com.docker.compose.service": "bitcoin",
                            },
                        },
                    },
                ],
                { project: "taxi12-a1b2c3d4", services: ["bitcoin"] },
            ),
        ).toThrow("wrong project label");
        expect(() =>
            assertCleanupCandidates(candidates, {
                project: "arkade-regtest",
                services: ["bitcoin"],
            }),
        ).toThrow("unique project name");
    });
});

describe("wallet bootstrap", () => {
    it("preserves existing actor seeds and creates only missing actors", () => {
        let generated = 0;
        const first = ensureActorSecrets({ operator: "11".repeat(32) }, () =>
            (++generated).toString(16).padStart(64, "0"),
        );
        const second = ensureActorSecrets(first, () => {
            throw new Error("idempotent bootstrap generated a replacement secret");
        });
        expect(first.operator).toBe("11".repeat(32));
        expect(Object.keys(first).sort()).toEqual([
            "emptyReceiver",
            "operator",
            "receiverSats",
            "receiverWithAsset",
            "sender",
        ]);
        expect(generated).toBe(4);
        expect(second).toEqual(first);
    });
});

describe("asset bootstrap", () => {
    it("reuses an indexed mint instead of issuing a second asset", async () => {
        let issues = 0;
        const issue = async () => {
            issues += 1;
            return { assetId: "aa".repeat(32) + ":0" };
        };
        const first = await ensureMintedAsset({
            record: undefined,
            required: 1_000n,
            balance: async () => 0n,
            issue,
        });
        const second = await ensureMintedAsset({
            record: first,
            required: 1_000n,
            balance: async () => 1_000n,
            issue,
        });
        expect(first.reused).toBe(false);
        expect(second).toEqual({ assetId: first.assetId, amount: 1_000n, reused: true });
        expect(issues).toBe(1);
    });

    it("creates a distinct indexed sats VTXO when issuance consumed the sender's plain output", async () => {
        const assetCoin = {
            txid: "aa".repeat(32),
            vout: 0,
            value: 500_000n,
            assets: [{ assetId: `${"bb".repeat(32)}:0`, amount: 9_000n }],
        };
        const satsCoin = {
            txid: "cc".repeat(32),
            vout: 1,
            value: 100_000n,
        };
        let funded = 0;
        let reads = 0;
        const filters: unknown[] = [];
        const result = await ensureAssetFreeFunding({
            minimum: 100_000n,
            list: async (filter: unknown) => {
                filters.push(filter);
                return reads++ === 0 ? [assetCoin] : [assetCoin, satsCoin];
            },
            fund: async (amount: bigint) => {
                funded += 1;
                expect(amount).toBe(100_000n);
            },
            timeoutMs: 10,
            intervalMs: 1,
        });
        expect(result).toEqual({ coin: satsCoin, reused: false });
        expect(funded).toBe(1);
        expect(filters).toEqual([{ withRecoverable: false }, { withRecoverable: false }]);
    });

    it("preserves an existing sufficient asset-free sender VTXO", async () => {
        const satsCoin = {
            txid: "dd".repeat(32),
            vout: 0,
            value: 150_000n,
        };
        const result = await ensureAssetFreeFunding({
            minimum: 100_000n,
            list: async () => [satsCoin],
            fund: async () => {
                throw new Error("existing plain funding must not be replaced");
            },
        });
        expect(result).toEqual({ coin: satsCoin, reused: true });
    });

    it("repairs a recorded-mint retry with only asset-bearing or undersized sender coins", async () => {
        const assetId = `${"ee".repeat(32)}:0`;
        const minted = await ensureMintedAsset({
            record: { assetId },
            required: 10_000n,
            balance: async () => 10_000n,
            issue: async () => {
                throw new Error("recorded mint must not be issued again");
            },
        });
        const rejected = [
            {
                txid: "11".repeat(32),
                vout: 0,
                value: 500_000n,
                assets: [{ assetId, amount: 9_000n }],
            },
            { txid: "22".repeat(32), vout: 0, value: 99_999n, assets: [] },
            { txid: "23".repeat(32), vout: 0, value: 200_000n, assets: {} },
        ];
        const repaired = { txid: "33".repeat(32), vout: 0, value: 100_000n, assets: [] };
        let funded = 0;
        let reads = 0;
        const result = await ensureAssetFreeFunding({
            minimum: 100_000n,
            list: async () => (reads++ < 2 ? rejected : [...rejected, repaired]),
            fund: async () => {
                funded += 1;
            },
            timeoutMs: 10,
            intervalMs: 1,
        });
        expect(minted.reused).toBe(true);
        expect(result).toEqual({ coin: repaired, reused: false });
        expect(funded).toBe(1);
    });

    it("excludes recoverable candidates through the SDK spendable filter", async () => {
        const recoverable = {
            txid: "44".repeat(32),
            vout: 0,
            value: 200_000n,
            assets: [],
        };
        const spendable = { txid: "55".repeat(32), vout: 0, value: 100_000n, assets: [] };
        let funded = 0;
        const result = await ensureAssetFreeFunding({
            minimum: 100_000n,
            list: async (filter: { withRecoverable?: boolean }) =>
                filter.withRecoverable ? [recoverable] : funded ? [spendable] : [],
            fund: async () => {
                funded += 1;
            },
            timeoutMs: 10,
            intervalMs: 1,
        });
        expect(result).toEqual({ coin: spendable, reused: false });
        expect(funded).toBe(1);
    });

    it("reuses an operator VTXO with exact configured time headroom", async () => {
        const tipTime = 1_789_182_698;
        const coin = {
            txid: "66".repeat(32),
            vout: 0,
            value: 500_000n,
            assets: undefined,
            expiresAt: new Date((tipTime + 86_400) * 1000),
        };
        const filters: unknown[] = [];
        const result = await ensureFreshAssetFreeFunding({
            minimum: 500_000n,
            minHeadroomBlocks: 144n,
            minHeadroomSeconds: 86_400n,
            requiredDomain: "time",
            list: async (filter: unknown) => {
                filters.push(filter);
                return [coin];
            },
            tip: async () => ({ height: 198, time: tipTime }),
            renew: async () => {
                throw new Error("qualifying operator VTXO must be reused");
            },
        });
        expect(result).toEqual({
            coin,
            reused: true,
            tip: { height: 198, time: tipTime },
        });
        expect(filters).toEqual([{ withRecoverable: false }]);
    });

    it("exports only exact safe-integer SDK expiry seconds", () => {
        const txid = "65".repeat(32);
        expect(
            expiryOf({
                txid,
                vout: 0,
                expiresAt: new Date(1_789_269_098_000),
            }),
        ).toEqual({ kind: "time", value: "1789269098" });
        expect(() =>
            expiryOf({
                txid,
                vout: 0,
                expiresAt: new Date(1_789_269_098_500),
            }),
        ).toThrow(/has no canonical expiry/);
    });

    it("budgets the one-percent settlement fee and waits for a large-enough renewed VTXO", async () => {
        const tipTime = 1_789_269_098;
        const stale = {
            txid: "77".repeat(32),
            vout: 0,
            value: 900_000n,
            assets: [],
            expiresAt: new Date((tipTime + 60) * 1000),
        };
        const fresh = {
            txid: "88".repeat(32),
            vout: 1,
            assets: [],
            value: 500_000n,
            expiresAt: new Date((tipTime + 100_000) * 1000),
        };
        let reads = 0;
        const renewed: bigint[] = [];
        const result = await ensureFreshAssetFreeFunding({
            minimum: 500_000n,
            minHeadroomBlocks: 144n,
            minHeadroomSeconds: 86_400n,
            requiredDomain: "time",
            list: async () => (reads++ < 2 ? [stale] : [stale, fresh]),
            tip: async () => ({ height: 198 + reads, time: tipTime }),
            renew: async (amount: bigint) => renewed.push(amount),
            timeoutMs: 10,
            intervalMs: 1,
        });
        expect(renewed).toEqual([510_000n]);
        expect(result).toEqual({
            coin: fresh,
            reused: false,
            tip: { height: 201, time: tipTime },
        });
    });

    it("adds the same fee buffer for sender-sized renewal", () => {
        expect(renewalFundingAmount(100_000n)).toBe(102_000n);
        expect((renewalFundingAmount(100_000n) * 99n) / 100n).toBeGreaterThanOrEqual(100_000n);
    });

    it("rejects asset-bearing, undersized, ambiguous-expiry, and short-headroom inventory", async () => {
        const candidates = [
            {
                txid: "91".repeat(32),
                vout: 0,
                value: 500_000n,
                assets: [{ assetId: `${"92".repeat(32)}:0`, amount: 1n }],
                expiresAt: new Date((1_789_182_698 + 100_000) * 1000),
            },
            {
                txid: "93".repeat(32),
                vout: 0,
                value: 499_999n,
                assets: [],
                expiresAt: new Date((1_789_182_698 + 100_000) * 1000),
            },
            {
                txid: "94".repeat(32),
                vout: 0,
                value: 500_000n,
                assets: [],
                expiresAtHeight: 500,
                expiresAt: new Date(1_800_000_000_000),
            },
            {
                txid: "95".repeat(32),
                vout: 0,
                value: 500_000n,
                assets: [],
                expiresAtHeight: 500,
            },
            {
                txid: "96".repeat(32),
                vout: 0,
                value: 500_000n,
                assets: [],
                expiresAt: new Date((1_789_182_698 + 100_000) * 1000 + 500),
            },
            {
                txid: "97".repeat(32),
                vout: 0,
                value: 500_000n,
                assets: [],
                expiresAt: new Date((1_789_182_698 + 60) * 1000),
            },
        ];
        let renewed = 0;
        await expect(
            ensureFreshAssetFreeFunding({
                minimum: 500_000n,
                minHeadroomBlocks: 144n,
                minHeadroomSeconds: 86_400n,
                requiredDomain: "time",
                list: async () => candidates,
                tip: async () => ({ height: 198, time: 1_789_182_698 }),
                renew: async () => {
                    renewed += 1;
                },
                timeoutMs: 0,
                intervalMs: 1,
            }),
        ).rejects.toThrow(/indexed fresh asset-free funding VTXO/);
        expect(renewed).toBe(1);
    });

    it("acquires exactly one new asset-free preconfirmed input without selecting old inventory", async () => {
        const oldPlain = {
            txid: "a1".repeat(32),
            vout: 0,
            value: 102_000n,
            assets: undefined,
            isPreconfirmed: true,
        };
        const assetBearing = {
            txid: "a2".repeat(32),
            vout: 0,
            value: 102_000n,
            assets: [{ assetId: `${"a3".repeat(32)}:0`, amount: 9_000n }],
            isPreconfirmed: true,
        };
        const settled = {
            txid: "a4".repeat(32),
            vout: 0,
            value: 102_000n,
            assets: [],
            isPreconfirmed: false,
        };
        const wrongAmount = {
            txid: "a5".repeat(32),
            vout: 0,
            value: 102_001n,
            assets: [],
            isPreconfirmed: true,
        };
        const exactNew = {
            txid: "a6".repeat(32),
            vout: 1,
            value: 102_000n,
            assets: undefined,
            isPreconfirmed: true,
        };
        const filters: unknown[] = [];
        let reads = 0;
        const sends: bigint[] = [];
        const selected = await acquireNewAssetFreePreconfirmed({
            amount: 102_000n,
            list: async (filter: unknown) => {
                filters.push(filter);
                reads += 1;
                return reads === 1
                    ? [oldPlain, assetBearing]
                    : [oldPlain, assetBearing, settled, wrongAmount, exactNew];
            },
            send: async (amount: bigint) => sends.push(amount),
            timeoutMs: 10,
            intervalMs: 1,
        });
        expect(selected).toBe(exactNew);
        expect(sends).toEqual([102_000n]);
        expect(filters).toEqual([{ withRecoverable: false }, { withRecoverable: false }]);
    });

    it("bounds fresh-funding timeout diagnostics without serializing coin internals", async () => {
        const txid = "b1".repeat(32);
        await expect(
            acquireNewAssetFreePreconfirmed({
                amount: 102_000n,
                list: async () => [
                    {
                        txid,
                        vout: 0,
                        value: 102_000n,
                        assets: [{ assetId: `${"b2".repeat(32)}:0`, amount: 1n }],
                        isPreconfirmed: true,
                        tapTree: "secret-large-tree",
                    },
                ],
                send: async () => undefined,
                timeoutMs: 0,
                intervalMs: 1,
            }),
        ).rejects.toThrow(new RegExp(`${txid}:0`));
        await expect(
            acquireNewAssetFreePreconfirmed({
                amount: 102_000n,
                list: async () => [
                    {
                        txid,
                        vout: 0,
                        value: 102_000n,
                        assets: [],
                        isPreconfirmed: true,
                        tapTree: "secret-large-tree",
                    },
                ],
                send: async () => undefined,
                timeoutMs: 0,
                intervalMs: 1,
            }),
        ).rejects.not.toThrow(/secret-large-tree|tapTree/);

        await expect(
            ensureFreshAssetFreeFunding({
                minimum: 100_000n,
                minHeadroomBlocks: 144n,
                minHeadroomSeconds: 86_400n,
                requiredDomain: "time",
                list: async () => [
                    {
                        txid,
                        vout: 0,
                        value: 100_000n,
                        assets: [],
                        expiresAt: new Date((1_789_182_698 + 60) * 1000),
                        tapTree: "secret-large-tree",
                    },
                ],
                tip: async () => ({ height: 198, time: 1_789_182_698 }),
                renew: async () => undefined,
                timeoutMs: 0,
                intervalMs: 1,
            }),
        ).rejects.not.toThrow(/secret-large-tree|tapTree/);
    });

    it("settles only the exact new funding input to an explicit self-output", async () => {
        const input = {
            txid: "c1".repeat(32),
            vout: 2,
            value: 102_000n,
            assets: undefined,
            isPreconfirmed: true,
        };
        const calls: unknown[] = [];
        const wallet = {
            getAddress: async () => "tark1self",
            getBalance: async () => {
                throw new Error("scoped settlement must not wait for global preconfirmed=0");
            },
            settle: async (params: unknown, callback: (event: { type: string }) => void) => {
                calls.push(params);
                callback({ type: "batch_finalized" });
                return "d1".repeat(32);
            },
        };
        const result = await settleSelectedFunding(wallet, {
            input,
            outputAmount: 100_000n,
            label: "sender-final-renewal",
            timeoutMs: 10,
        });
        expect(calls).toEqual([
            {
                inputs: [input],
                outputs: [{ address: "tark1self", amount: 100_000n }],
            },
        ]);
        expect(result).toEqual({ settled: true, txid: "d1".repeat(32) });
    });

    it("performs no chain-mutating bootstrap work after the operator freshness guard", () => {
        const source = readFileSync(new URL("../e2e-bootstrap.mjs", import.meta.url), "utf8");
        const afterGuard = source.slice(source.indexOf("const operatorFundingResult"));
        expect(afterGuard).not.toMatch(/await (?:sendSats|settleWallet|settleSelectedFunding)\(/);
        expect(source).toContain('requiredDomain: "time"');
        expect(source).toContain("settleSelectedFunding(actor.wallet");
    });
});

describe("artifacts", () => {
    it("removes the stale failure marker while retaining current success diagnostics", () => {
        const directory = mkdtempSync(join(tmpdir(), "taxi12-artifacts-"));
        try {
            for (const name of [
                "stack.json",
                "results.json",
                "taxi.log",
                "failure.log",
                "stack.log",
            ])
                writeFileSync(join(directory, name), name);

            removeStaleFailureDiagnostics(directory);

            expect(existsSync(join(directory, "failure.log"))).toBe(false);
            for (const name of ["stack.json", "results.json", "taxi.log", "stack.log"])
                expect(readFileSync(join(directory, name), "utf8")).toBe(name);
        } finally {
            rmSync(directory, { recursive: true, force: true });
        }
    });

    it("bounds separately-run Taxi diagnostics to the last 300 timestamped lines", () => {
        expect(taxiLogArgs("taxi12-a1b2c3d4-taxi")).toEqual([
            "logs",
            "--timestamps",
            "--tail",
            "300",
            "taxi12-a1b2c3d4-taxi",
        ]);
    });

    it("captures only owned Taxi logs and redacts known secrets", async () => {
        const secret = "operator-private-material";
        let reads = 0;
        const logs = await captureOwnedTaxiLogs({
            container: "taxi12-a1b2c3d4-taxi",
            project: "taxi12-a1b2c3d4",
            knownSecrets: [secret],
            inspect: async () => "taxi12-a1b2c3d4",
            readLogs: async () => {
                reads += 1;
                return { code: 0, stdout: `ready ${secret}`, stderr: "warning" };
            },
        });
        expect(logs).toBe("stdout:\nready [REDACTED]\nstderr:\nwarning\n");
        expect(reads).toBe(1);

        await expect(
            captureOwnedTaxiLogs({
                container: "taxi12-a1b2c3d4-taxi",
                project: "taxi12-a1b2c3d4",
                knownSecrets: [secret],
                inspect: async () => "someone-else",
                readLogs: async () => {
                    reads += 1;
                    return { code: 0, stdout: secret, stderr: "" };
                },
            }),
        ).rejects.toThrow(/ownership/);
        expect(reads).toBe(1);
    });

    it("retains sanitized stdout and stderr in process failure evidence", () => {
        expect(
            formatProcessFailure("node", ["regtest.mjs"], {
                code: 1,
                stdout: "resolved ARKD_ADMIN_PORT=49152",
                stderr: "admin readiness timed out",
            }),
        ).toContain("stdout:\nresolved ARKD_ADMIN_PORT=49152\nstderr:\nadmin readiness timed out");
    });

    it("names the resolved upstream SHA and project in a sanitized failure", () => {
        const secret = "66".repeat(32);
        const safe = contextualizeFailure(
            new Error(`admin probe used ${secret}`),
            {
                sha: "d9e08ac0552aa12a23b688642aa9a82cf5dc1b7d",
                project: "taxi12-a1b2c3d4",
            },
            [secret],
        );
        expect(safe.stack).toContain(
            "arkade-regtest d9e08ac0552aa12a23b688642aa9a82cf5dc1b7d project taxi12-a1b2c3d4",
        );
        expect(safe.stack).toContain("[REDACTED]");
        expect(safe.stack).not.toContain(secret);
    });

    it("sanitizes a thrown secret before the top-level stderr handler sees it", () => {
        const secret = "77".repeat(32);
        const safe = sanitizeError(new Error(`provider failed with password=${secret}`), [secret]);
        const stderr = safe instanceof Error ? (safe.stack ?? safe.message) : String(safe);
        expect(stderr).toContain("[REDACTED]");
        expect(stderr).not.toContain(secret);
    });

    it("records reproducibility facts and excludes secrets recursively", () => {
        const secret = "55".repeat(32);
        const manifest = buildStackManifest({
            startedAtUtc: "2026-09-12T01:00:00.000Z",
            regtest: {
                repository: "https://github.com/ArkLabsHQ/arkade-regtest.git",
                branch: "master",
                sha: "d9e08ac0552aa12a23b688642aa9a82cf5dc1b7d",
            },
            sdkVersion: "0.4.72",
            taxi: {
                commit: "28abee1975ebdcace82ee04f2d3f9a993dd374b5",
                tree: "e914c381c6f0740ca0878e033e3ef1582ac94191",
                dirty: true,
            },
            stack: { project: "taxi12-a1b2c3d4", profiles: ["emulator"], ports: { arkd: 47070 } },
            images: { arkd: "sha256:" + "ab".repeat(32) },
            fixtures: { operator: { address: "tark1public", privateKey: secret } },
            knownSecrets: [secret],
        });
        expect(manifest.regtest.sha).toBe("d9e08ac0552aa12a23b688642aa9a82cf5dc1b7d");
        expect(manifest.fixtures.operator).toEqual({
            address: "tark1public",
            privateKey: "[REDACTED]",
        });
        expect(JSON.stringify(manifest)).not.toContain(secret);
        expect(() => assertArtifactSafe(manifest, [secret])).not.toThrow();
        expect(() => assertArtifactSafe({ mnemonic: "word word word" }, [])).toThrow(
            "artifact contains secret material",
        );
    });
});
