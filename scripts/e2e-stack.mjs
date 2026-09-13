#!/usr/bin/env node
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import {
    cpSync,
    existsSync,
    mkdirSync,
    mkdtempSync,
    readFileSync,
    readdirSync,
    rmSync,
    writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
    assertArtifactSafe,
    assertCleanupCandidates,
    assertLocalConsumerResolution,
    assertConfiguredArkDelays,
    assertOwnedServiceEnvironment,
    assertProjectNetwork,
    assertPackResult,
    assertRenderedCompose,
    assertResolvedPorts,
    assertTarballIntegrity,
    assertVolumeDeletionCandidates,
    buildConsumerManifest,
    buildTaxiRunArgs,
    captureOwnedTaxiLogs,
    contextualizeFailure,
    discoverPortBindings,
    discoverProfileClosure,
    eventSourceNodeEnvironment,
    formatProcessFailure,
    isTaxiReadyResponse,
    namespaceRegtestSources,
    nodeEventSourceArgs,
    packageManagerEnvironment,
    packageManagerInvocation,
    parsePublishedPort,
    pollUntil,
    prepareResultPublication,
    redactSecrets,
    resolveMasterSha,
    resolveInstalledClientEntry,
    resolveTask12Tests,
    removeStaleFailureDiagnostics,
    taxiLogArgs,
} from "./lib/harness.mjs";
import { captureTaxiIdentity, writeStackManifest } from "./e2e-artifacts.mjs";
import { createFailureProxy } from "./lib/failure-proxy.mjs";
import { assertTaxiRestartOwnership } from "./lib/taxi-restart.mjs";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const REGTEST_REPOSITORY = "https://github.com/ArkLabsHQ/arkade-regtest.git";
export const ARKD_DELAYS = {
    ARKD_VTXO_TREE_EXPIRY: "172800",
    ARKD_UNILATERAL_EXIT_DELAY: "86400",
    ARKD_PUBLIC_UNILATERAL_EXIT_DELAY: "86400",
    ARKD_BOARDING_EXIT_DELAY: "7776000",
    ARKD_CHECKPOINT_EXIT_DELAY: "86400",
};
export const ARKD_FEES = {
    ARK_OFFCHAIN_INPUT_FEE: "0.0",
    ARK_ONCHAIN_INPUT_FEE: "0.0",
    ARK_OFFCHAIN_OUTPUT_FEE: "0.0",
    ARK_ONCHAIN_OUTPUT_FEE: "0.0",
};
export function assertZeroIntentFees(fees) {
    const intent = fees?.intentFee;
    for (const field of ["offchainInput", "onchainInput", "offchainOutput", "onchainOutput"])
        if (intent?.[field] !== "0.0")
            throw new Error(`zero intent fee fixture mismatch: ${field}`);
    return intent;
}
const MIN_EXPIRY_HEADROOM_BLOCKS = "144";
const MIN_EXPIRY_HEADROOM_SECONDS = "86400";
const RECOVERY_BROADCAST_SECONDS = "43200";
const RECOVERY_CRITICAL_SECONDS = "7200";
const SERVICES = [
    "bitcoin",
    "bitcoin-miner",
    "postgres",
    "nbxplorer",
    "fulcrum",
    "mempool_mariadb",
    "mempool_api",
    "mempool_web",
    "lnd",
    "arkd-wallet",
    "arkd",
    "arkade-wallet",
    "arkade-explorer",
    "emulator",
];
const DIAGNOSTIC_SERVICES = [
    "bitcoin",
    "bitcoin-miner",
    "postgres",
    "nbxplorer",
    "fulcrum",
    "mempool_api",
    "mempool_web",
    "arkd-wallet",
    "arkd",
    "emulator",
];
const PORT_NAMES = [
    "BITCOIN_RPC_PORT",
    "BITCOIN_P2P_PORT",
    "BITCOIN_ZMQ_BLOCK_PORT",
    "BITCOIN_ZMQ_TX_PORT",
    "POSTGRES_PORT",
    "NBXPLORER_PORT",
    "FULCRUM_TCP_PORT",
    "FULCRUM_WS_PORT",
    "MEMPOOL_API_PORT",
    "MEMPOOL_WEB_PORT",
    "LND_P2P_PORT",
    "LND_RPC_PORT",
    "ARKD_WALLET_PORT",
    "ARKD_PORT",
    "ARKD_ADMIN_PORT",
    "WALLET_PORT",
    "EXPLORER_PORT",
    "EMULATOR_PORT",
];

const redactText = (text, secrets) =>
    secrets.reduce((current, secret) => current.replaceAll(secret, "[REDACTED]"), text);
const xOnlyKey = (key) => (/^0[23][0-9a-f]{64}$/i.exec(key) ? key.slice(2) : key);
let activeInterruption;

export function createInterruptionState(cleanupTimeoutMs = 30_000) {
    const controller = new AbortController();
    const operations = new Set();
    const cleanupFailures = [];
    let cleanup = false;
    let error;
    const cleanupFailure = () => {
        if (!cleanupFailures.length) return;
        if (cleanupFailures.length === 1) return cleanupFailures[0];
        return new AggregateError(
            cleanupFailures,
            cleanupFailures.map((failure) => failure.message).join("; "),
        );
    };
    return {
        interrupt(signal) {
            if (error) return false;
            error = new Error(`E2E interrupted by ${signal}`);
            controller.abort(error);
            return true;
        },
        beginCleanup() {
            const failure = cleanupFailure();
            if (failure) throw failure;
            if (operations.size)
                throw new Error("cannot begin cleanup while owned process operations are active");
            cleanup = true;
        },
        blockCleanup(failure) {
            cleanupFailures.push(failure instanceof Error ? failure : new Error(String(failure)));
        },
        trackOperation(operation) {
            operations.add(operation);
            operation.then(
                () => operations.delete(operation),
                () => operations.delete(operation),
            );
            return operation;
        },
        async waitForOperations() {
            while (operations.size) await Promise.allSettled([...operations]);
            const failure = cleanupFailure();
            if (failure) throw failure;
        },
        assertOperationAllowed() {
            if (error && !cleanup) throw error;
        },
        operationSignal() {
            return cleanup ? undefined : controller.signal;
        },
        operationError() {
            return cleanup ? undefined : error;
        },
        interruptionError() {
            return error;
        },
        commandTimeout(timeoutMs) {
            return timeoutMs ?? (cleanup ? cleanupTimeoutMs : undefined);
        },
    };
}

export function recordFailClosedInterruption({ artifacts, error, knownSecrets, root, state }) {
    const cause = error instanceof Error ? error : new Error(String(error));
    const reported = contextualizeFailure(
        new Error(
            `${cause.message}; resource deletion was skipped because owned process drain was not confirmed; retained run root: ${root}`,
            { cause },
        ),
        state,
        knownSecrets,
    );
    const failure = reported.stack ?? reported.message;
    assertArtifactSafe({ failure }, knownSecrets);
    writeFileSync(join(artifacts, "failure.log"), `${failure}\n`);
    return reported;
}

const processGroupExists = (pid) => {
    try {
        process.kill(-pid, 0);
        return true;
    } catch (error) {
        if (error?.code === "ESRCH") return false;
        throw error;
    }
};

const waitForProcessGroupExit = async (pid, timeoutMs) => {
    const deadline = Date.now() + timeoutMs;
    while (processGroupExists(pid) && Date.now() < deadline)
        await new Promise((resolve) => setTimeout(resolve, 25));
    return !processGroupExists(pid);
};

const signalProcessGroup = (pid, signal) => {
    try {
        process.kill(-pid, signal);
    } catch (error) {
        if (error?.code !== "ESRCH") throw error;
    }
};

const terminateWindowsProcessTree = (pid) =>
    new Promise((resolve, reject) => {
        const killer = spawn("taskkill.exe", ["/PID", String(pid), "/T", "/F"], {
            stdio: "ignore",
            windowsHide: true,
        });
        let settled = false;
        const finish = (error) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            if (error) reject(error);
            else resolve();
        };
        const timer = setTimeout(() => {
            killer.kill();
            finish(new Error(`taskkill for owned process ${pid} exceeded 5000ms`));
        }, 5_000);
        killer.once("error", finish);
        killer.once("close", (code) =>
            finish(code === 0 ? undefined : new Error(`taskkill exited with code ${code}`)),
        );
    });

const terminateOwnedProcessTree = async (child) => {
    if (!child.pid) return;
    if (process.platform === "win32") {
        await terminateWindowsProcessTree(child.pid);
        return;
    }
    signalProcessGroup(child.pid, "SIGTERM");
    if (await waitForProcessGroupExit(child.pid, 2_000)) return;
    signalProcessGroup(child.pid, "SIGKILL");
    if (!(await waitForProcessGroupExit(child.pid, 5_000)))
        throw new Error(`owned process group ${child.pid} did not drain after SIGKILL`);
};

const withTimeout = (operation, timeoutMs, message) =>
    new Promise((resolve, reject) => {
        let settled = false;
        const finish = (error, value) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            if (error) reject(error);
            else resolve(value);
        };
        const timer = setTimeout(() => finish(new Error(message)), timeoutMs);
        operation.then(
            (value) => finish(undefined, value),
            (error) => finish(error),
        );
    });

export function monitorOwnedProcess({
    command,
    args,
    child,
    interruption,
    terminate,
    terminationTimeoutMs = 10_000,
    options = {},
}) {
    let stdout = "";
    let stderr = "";
    let closeCode;
    let closed = false;
    let settled = false;
    let termination;
    let terminationReason;
    let resolveCompletion;
    let rejectCompletion;
    let resolveClose;
    const closeObserved = new Promise((resolve) => (resolveClose = resolve));
    const completion = new Promise((resolve, reject) => {
        resolveCompletion = resolve;
        rejectCompletion = reject;
    });
    const operationSignal = interruption?.operationSignal();
    const timeoutMs = interruption?.commandTimeout(options.timeoutMs) ?? options.timeoutMs;
    let timer;
    const finish = (error) => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        operationSignal?.removeEventListener("abort", onAbort);
        const safeOut = redactText(stdout, options.secrets ?? []);
        const safeError = redactText(stderr, options.secrets ?? []);
        if (options.print !== false) {
            if (safeOut) process.stdout.write(safeOut);
            if (safeError) process.stderr.write(safeError);
        }
        if (error) {
            rejectCompletion(error);
            return;
        }
        const result = {
            code: closeCode ?? 1,
            stdout: safeOut.trim(),
            stderr: safeError.trim(),
        };
        if (result.code !== 0 && options.check !== false)
            rejectCompletion(new Error(formatProcessFailure(command, args, result)));
        else resolveCompletion(result);
    };
    const requestTermination = (reason) => {
        if (termination) return;
        terminationReason = reason;
        termination = (async () => {
            try {
                await withTimeout(
                    Promise.resolve().then(terminate),
                    terminationTimeoutMs,
                    `owned process tree termination did not finish within ${terminationTimeoutMs}ms`,
                );
                if (!closed)
                    await Promise.race([
                        closeObserved,
                        new Promise((resolve) => setTimeout(resolve, 100)),
                    ]);
                if (!closed) {
                    child.stdout?.destroy();
                    child.stderr?.destroy();
                    child.unref?.();
                }
                finish(interruption?.operationError() ?? terminationReason);
            } catch (error) {
                const cause = error instanceof Error ? error : new Error(String(error));
                const failure = new Error(
                    `${terminationReason.message}; owned process drain was not confirmed: ${cause.message}`,
                    { cause },
                );
                interruption?.blockCleanup(failure);
                child.stdout?.destroy();
                child.stderr?.destroy();
                child.unref?.();
                finish(failure);
            }
        })();
        termination.catch(() => {});
    };
    const onAbort = () =>
        requestTermination(
            interruption?.operationError() ?? new Error("owned process interrupted"),
        );
    child.stdout?.on("data", (chunk) => (stdout += chunk));
    child.stderr?.on("data", (chunk) => (stderr += chunk));
    child.once("error", (error) => {
        if (!termination) finish(error);
    });
    child.once("close", (code) => {
        closed = true;
        closeCode = code;
        resolveClose();
        if (!termination) finish();
    });
    if (operationSignal?.aborted) onAbort();
    else operationSignal?.addEventListener("abort", onAbort, { once: true });
    if (timeoutMs)
        timer = setTimeout(
            () => requestTermination(new Error(`${command} timed out after ${timeoutMs}ms`)),
            timeoutMs,
        );
    return interruption?.trackOperation(completion) ?? completion;
}

export function startOwnedProcess(command, args, options = {}) {
    const interruption = options.interruption ?? activeInterruption;
    interruption?.assertOperationAllowed();
    const child = spawn(command, args, {
        cwd: options.cwd,
        env: options.env ?? process.env,
        stdio: ["ignore", "pipe", "pipe"],
        detached: process.platform !== "win32",
        windowsHide: true,
    });
    return {
        child,
        completion: monitorOwnedProcess({
            command,
            args,
            child,
            interruption,
            terminate: () => terminateOwnedProcessTree(child),
            options,
        }),
    };
}

const run = (command, args, options = {}) => {
    try {
        return startOwnedProcess(command, args, options).completion;
    } catch (error) {
        return Promise.reject(error);
    }
};

const operationFetchSignal = (timeoutMs) => {
    activeInterruption?.assertOperationAllowed();
    const timeout = AbortSignal.timeout(timeoutMs);
    const operation = activeInterruption?.operationSignal();
    return operation ? AbortSignal.any([operation, timeout]) : timeout;
};

const jsonRun = async (command, args, options = {}) =>
    JSON.parse((await run(command, args, { ...options, print: false })).stdout);

const runPnpm = (args, options = {}) => {
    const invocation = packageManagerInvocation(args);
    const npmUserConfig = options.npmUserConfig;
    const safeOptions = {
        ...options,
        env: packageManagerEnvironment(options.env ?? process.env, npmUserConfig),
    };
    delete safeOptions.npmUserConfig;
    return run(invocation.command, invocation.args, safeOptions);
};

const tarballHashes = (tarballs) =>
    Object.fromEntries(
        tarballs.map((path) => [
            path,
            createHash("sha256").update(readFileSync(path)).digest("hex"),
        ]),
    );

const writeEnv = (path, values) =>
    writeFileSync(
        path,
        `${Object.entries(values)
            .map(([key, value]) => `${key}=${value}`)
            .join("\n")}\n`,
    );

const publicInfo = async (url, label) =>
    pollUntil({
        label,
        timeoutMs: 60_000,
        intervalMs: 500,
        signal: activeInterruption?.operationSignal(),
        read: async () => {
            const response = await fetch(url, { signal: operationFetchSignal(5_000) });
            if (!response.ok) throw new Error(`HTTP ${response.status}`);
            return response.json();
        },
        ready: (value) => Boolean(value?.signerPubkey),
    });

const composeArgs = (state, tail = []) => [
    "compose",
    "-p",
    state.project,
    "-f",
    state.base,
    "-f",
    state.ark,
    "--env-file",
    state.envFile,
    "--profile",
    "base",
    "--profile",
    "ark",
    "--profile",
    "emulator",
    ...tail,
];

export const stackDiagnosticRequests = () => [
    ["compose ps", ["ps", "--all", "--format", "json"]],
    ...DIAGNOSTIC_SERVICES.map((service) => [
        service,
        ["logs", "--no-color", "--tail", "300", service],
    ]),
];

const captureStackDiagnostics = async (state, artifacts, knownSecrets) => {
    const sections = [];
    for (const [label, args] of stackDiagnosticRequests()) {
        const result = await run("docker", composeArgs(state, args), {
            env: state.childEnv,
            print: false,
            check: false,
            secrets: knownSecrets,
        });
        sections.push(`## ${label}\n${result.stdout}\n${result.stderr}`);
    }
    const diagnostics = redactText(sections.join("\n"), knownSecrets);
    assertArtifactSafe({ diagnostics }, knownSecrets);
    writeFileSync(join(artifacts, "stack.log"), `${diagnostics}\n`);
};

const captureTaxiDiagnostics = async (container, project, artifacts, knownSecrets) => {
    const logs = await captureOwnedTaxiLogs({
        container,
        project,
        knownSecrets,
        inspect: async (name) =>
            (
                await run(
                    "docker",
                    [
                        "inspect",
                        name,
                        "--format",
                        '{{index .Config.Labels "dev.arkade-taxi.e2e-project"}}',
                    ],
                    { print: false, check: false, secrets: knownSecrets },
                )
            ).stdout,
        readLogs: (name) =>
            run("docker", taxiLogArgs(name), {
                print: false,
                check: false,
                secrets: knownSecrets,
            }),
    });
    writeFileSync(join(artifacts, "taxi.log"), logs);
};

const cleanSourceEnvironment = (source, values) => {
    const env = { ...process.env };
    for (const line of readFileSync(join(source, ".env.defaults"), "utf8").split(/\r?\n/)) {
        const key = /^([A-Z][A-Z0-9_]*)=/.exec(line)?.[1];
        if (key) delete env[key];
    }
    return Object.assign(env, values);
};

const assertProjectLabels = async (project, expectedServices) => {
    const ids = (
        await run(
            "docker",
            ["ps", "-aq", "--filter", `label=com.docker.compose.project=${project}`],
            { print: false },
        )
    ).stdout
        .split(/\s+/)
        .filter(Boolean);
    if (!ids.length) throw new Error(`no containers carry project label ${project}`);
    const details = await jsonRun("docker", ["inspect", ...ids]);
    return assertCleanupCandidates(details, { project, services: expectedServices });
};

export const packClient = async (root, env) => {
    const packDir = join(root, "packs");
    const consumer = join(root, "consumer");
    const npmUserConfig = join(root, "package-manager.npmrc");
    const storeDir = join(root, "pnpm-store");
    mkdirSync(packDir);
    mkdirSync(consumer);
    writeFileSync(
        npmUserConfig,
        "registry=https://registry.npmjs.org/\n@arkade-taxi:registry=http://127.0.0.1:9/\nalways-auth=false\n",
    );
    await runPnpm(["-r", "build"], { cwd: REPO, env, npmUserConfig });
    const tarballs = [];
    for (const name of ["@arkade-taxi/covenant", "@arkade-taxi/protocol", "@arkade-taxi/client"])
        tarballs.push(
            assertPackResult(
                (
                    await runPnpm(
                        ["--filter", name, "pack", "--json", "--pack-destination", packDir],
                        {
                            cwd: REPO,
                            env,
                            npmUserConfig,
                            print: false,
                        },
                    )
                ).stdout,
                { name, packDir },
            ),
        );
    if (readdirSync(packDir).filter((name) => name.endsWith(".tgz")).length !== 3)
        throw new Error("pack directory does not contain exactly three tarballs");
    const beforeInstall = tarballHashes(tarballs);
    const manifest = buildConsumerManifest(tarballs, consumer);
    writeFileSync(join(consumer, "package.json"), `${JSON.stringify(manifest, null, 2)}\n`);
    await runPnpm(
        ["--store-dir", storeDir, "install", "--ignore-scripts", "--frozen-lockfile=false"],
        {
            cwd: consumer,
            env,
            npmUserConfig,
        },
    );
    assertTarballIntegrity(beforeInstall, tarballHashes(tarballs));
    const entry = resolveInstalledClientEntry(consumer);
    const installed = JSON.parse(
        readFileSync(
            join(consumer, "node_modules", "@arkade-taxi", "client", "package.json"),
            "utf8",
        ),
    );
    if (installed.name !== "@arkade-taxi/client" || installed.version !== "0.0.0")
        throw new Error("installed packed client identity changed");
    const listed = JSON.parse(
        (
            await runPnpm(["list", "--json", "--depth=0"], {
                cwd: consumer,
                env,
                npmUserConfig,
                print: false,
            })
        ).stdout,
    )[0];
    const lock = readFileSync(join(consumer, "pnpm-lock.yaml"), "utf8");
    assertLocalConsumerResolution(manifest, lock, listed);
    await import(pathToFileURL(entry).href);
    return { consumer, entry, tarballs, npmUserConfig, manifest, lock, listed, installed };
};

const patchPolicy = async (baseUrl) => {
    const body = {
        paused: false,
        maxOutstandingSats: "10000000",
        maxPerPaymentTopupSats: "100000",
        maxConcurrentAdvances: 20,
        locktimeMarginBlocks: 144,
        locktimeMarginSeconds: 86400,
        assetRules: [
            {
                assetId: null,
                enabled: true,
                fares: [
                    {
                        id: "sats",
                        currency: { kind: "sats" },
                        pricing: { kind: "flat", units: "1" },
                    },
                ],
                claim: "either",
                maxTopupSats: null,
            },
        ],
        quoteTtlSeconds: 120,
    };
    const response = await fetch(`${baseUrl}/admin/api/policy`, {
        method: "PATCH",
        headers: { "content-type": "application/json", "x-taxi-operator": "task12-harness" },
        body: JSON.stringify(body),
        signal: operationFetchSignal(5_000),
    });
    if (!response.ok)
        throw new Error(`policy bootstrap failed: ${response.status} ${await response.text()}`);
};

async function main() {
    const tests = resolveTask12Tests(process.argv.slice(2));
    const interruption = createInterruptionState();
    activeInterruption = interruption;
    const signalHandlers = {
        SIGINT: () => interruption.interrupt("SIGINT"),
        SIGTERM: () => interruption.interrupt("SIGTERM"),
    };
    process.on("SIGINT", signalHandlers.SIGINT);
    process.on("SIGTERM", signalHandlers.SIGTERM);
    const startedAtUtc = new Date().toISOString();
    const id = randomUUID().replaceAll("-", "").slice(0, 12);
    const project = `taxi12-${id}`;
    const network = `${project}_default`;
    const root = mkdtempSync(join(tmpdir(), `taxi12-${id}-`));
    const source = join(root, "source");
    const runner = join(root, "runner");
    const artifacts = join(REPO, "e2e-artifacts");
    const secretDir = join(root, "secrets");
    const secretFile = join(secretDir, "actors.json");
    const fixtureFile = join(root, "fixtures.json");
    const envFile = join(root, "regtest.env");
    const resultsFile = join(root, "results.json");
    const secrets = [
        randomBytes(32).toString("hex"),
        randomBytes(32).toString("hex"),
        randomBytes(32).toString("hex"),
    ];
    const knownSecrets = [...secrets];
    const runAndPublishResults = prepareResultPublication({
        source: resultsFile,
        destinations: [join(REPO, "e2e-results.json"), join(artifacts, "results.json")],
        knownSecrets,
    });
    const taxi = captureTaxiIdentity(REPO);
    let actorSecrets = {};
    let state;
    let taxiContainer;
    let failureProxy;
    let controlServer;
    let taxiVolume;
    let taxiImage;
    let failure;
    let cleanupFailure;
    mkdirSync(artifacts, { recursive: true });
    for (const name of [
        "boundary-diagnostics.jsonl",
        "proxy-events.json",
        "cltv-evidence.json",
        "failure.log",
        "stack.log",
        "taxi.log",
    ])
        rmSync(join(artifacts, name), { force: true });
    mkdirSync(secretDir, { recursive: true });
    try {
        await run("git", [
            "clone",
            "--depth",
            "1",
            "--branch",
            "master",
            "--single-branch",
            REGTEST_REPOSITORY,
            source,
        ]);
        const sha = resolveMasterSha(
            (await run("git", ["-C", source, "rev-parse", "HEAD"], { print: false })).stdout,
        );
        const sourceStatus = (
            await run("git", ["-C", source, "status", "--porcelain"], { print: false })
        ).stdout;
        if (sourceStatus) throw new Error(`fresh arkade-regtest ${sha} clone is dirty`);
        const cliSource = readFileSync(join(source, "regtest.mjs"), "utf8");
        const profiles = discoverProfileClosure(cliSource, "emulator", sha);
        if (JSON.stringify(profiles) !== JSON.stringify(["base", "ark", "emulator"]))
            throw new Error(
                `arkade-regtest ${sha} emulator profile closure changed: ${profiles.join(",")}`,
            );
        cpSync(source, runner, {
            recursive: true,
            filter: (path) => !path.split(/[\\/]/).includes(".git"),
        });
        const base = join(runner, "docker", "compose.base.yml");
        const ark = join(runner, "docker", "compose.ark.yml");
        const baseSource = readFileSync(base, "utf8");
        const arkSource = readFileSync(ark, "utf8");
        const portBindings = discoverPortBindings(
            `${baseSource}\n${arkSource}`,
            SERVICES,
            PORT_NAMES,
            sha,
        );
        const transformed = namespaceRegtestSources(
            {
                base: baseSource,
                ark: arkSource,
                compose: readFileSync(join(runner, "lib", "compose.mjs"), "utf8"),
                proc: readFileSync(join(runner, "lib", "proc.mjs"), "utf8"),
                regtest: readFileSync(join(runner, "regtest.mjs"), "utf8"),
                arkdSetup: readFileSync(join(runner, "lib", "setup", "arkd.mjs"), "utf8"),
            },
            project,
            portBindings,
        );
        writeFileSync(base, transformed.base);
        writeFileSync(ark, transformed.ark);
        writeFileSync(join(runner, "lib", "compose.mjs"), transformed.compose);
        writeFileSync(join(runner, "lib", "proc.mjs"), transformed.proc);
        writeFileSync(join(runner, "regtest.mjs"), transformed.regtest);
        writeFileSync(join(runner, "lib", "setup", "arkd.mjs"), transformed.arkdSetup);
        const ports = Object.fromEntries(PORT_NAMES.map((name) => [name, 0]));
        const values = {
            REGTEST_PROFILES: "emulator",
            AUTOMINE_INTERVAL: "0",
            ...ARKD_DELAYS,
            ...ARKD_FEES,
            ARKD_PASSWORD: secrets[0],
            ARKD_WALLET_SIGNER_KEY: secrets[1],
            EMULATOR_SECRET_KEY: secrets[2],
            ...ports,
        };
        writeEnv(envFile, values);
        const childEnv = cleanSourceEnvironment(source, {
            ...values,
            TAXI_E2E_PORT_BINDINGS: JSON.stringify(portBindings),
            TAXI_E2E_PROJECT: project,
            TAXI_E2E_REGTEST_SHA: sha,
            TAXI_E2E_COMPOSE_BASE: base,
            TAXI_E2E_COMPOSE_ARK: ark,
            ARKADE_REGTEST_ENV: envFile,
        });
        state = {
            project,
            base,
            ark,
            envFile,
            runner: join(runner, "regtest.mjs"),
            childEnv,
            sha,
            profiles,
            ports,
        };
        process.stdout.write(
            `arkade-regtest master ${sha}; project ${project}; profiles ${profiles.join(",")}; UTC start ${startedAtUtc}\n`,
        );
        const rendered = await jsonRun(
            "docker",
            composeArgs(state, ["config", "--format", "json"]),
            { env: childEnv },
        );
        assertRenderedCompose(rendered, {
            project,
            services: SERVICES,
            publishedPorts: 18,
            network,
            daemonAssigned: true,
        });
        assertConfiguredArkDelays(rendered.services?.arkd?.environment, ARKD_DELAYS);
        state.volumeNames = Object.values(rendered.volumes ?? {})
            .map((volume) => volume.name)
            .filter(Boolean);
        const packs = await packClient(root, childEnv);
        taxiImage = `arkade-taxi:e2e-${id}`;
        await run(
            "docker",
            [
                "build",
                "-f",
                join(REPO, "Dockerfile"),
                "--build-arg",
                `OCI_REVISION=${taxi.tree}`,
                "--label",
                `dev.arkade-taxi.e2e-project=${project}`,
                "-t",
                taxiImage,
                REPO,
            ],
            { env: childEnv, timeoutMs: 900_000 },
        );
        const taxiImageDetails = (await jsonRun("docker", ["image", "inspect", taxiImage]))[0];
        if (taxiImageDetails?.Config?.Labels?.["dev.arkade-taxi.e2e-project"] !== project)
            throw new Error("Taxi image lacks the exact run ownership label");
        await run(
            process.execPath,
            [state.runner, "start", "--env", envFile, "--profile", "emulator"],
            {
                env: childEnv,
                timeoutMs: 900_000,
                secrets,
            },
        );
        for (const [name, service, internal] of portBindings) {
            const published = await run(
                "docker",
                composeArgs(state, ["port", service, String(internal)]),
                { env: childEnv, print: false },
            );
            ports[name] = parsePublishedPort(published.stdout);
        }
        assertResolvedPorts(ports, portBindings.length);
        const labels = await assertProjectLabels(project, SERVICES);
        const configuredArkDelays = assertConfiguredArkDelays(
            assertOwnedServiceEnvironment(labels, {
                project,
                service: "arkd",
                environment: ARKD_DELAYS,
            }),
            ARKD_DELAYS,
        );
        const networkDetails = await jsonRun("docker", ["network", "inspect", network]);
        assertProjectNetwork(networkDetails[0], { project, network });
        const arkdUrl = `http://127.0.0.1:${ports.ARKD_PORT}`;
        const esploraUrl = `http://127.0.0.1:${ports.MEMPOOL_WEB_PORT}/api`;
        const emulatorUrl = `http://127.0.0.1:${ports.EMULATOR_PORT}`;
        const [arkInfo, emulatorInfo] = await Promise.all([
            publicInfo(`${arkdUrl}/v1/info`, `arkade-regtest ${sha} arkd info`),
            publicInfo(`${emulatorUrl}/v1/info`, `arkade-regtest ${sha} emulator info`),
        ]);
        const intentFees = assertZeroIntentFees(arkInfo.fees);
        const bootstrapEnv = {
            ...childEnv,
            TAXI_E2E_SECRET_FILE: secretFile,
            TAXI_E2E_FIXTURE_FILE: fixtureFile,
            TAXI_E2E_ARKD_URL: arkdUrl,
            TAXI_E2E_ESPLORA_URL: esploraUrl,
            TAXI_MIN_EXPIRY_HEADROOM_BLOCKS: MIN_EXPIRY_HEADROOM_BLOCKS,
            TAXI_MIN_EXPIRY_HEADROOM_SECONDS: MIN_EXPIRY_HEADROOM_SECONDS,
        };
        await run(
            process.execPath,
            nodeEventSourceArgs(join(REPO, "scripts", "e2e-bootstrap.mjs")),
            {
                env: bootstrapEnv,
                secrets,
                timeoutMs: 600_000,
            },
        );
        const fixtures = JSON.parse(readFileSync(fixtureFile, "utf8"));
        actorSecrets = JSON.parse(readFileSync(secretFile, "utf8"));
        knownSecrets.push(...Object.values(actorSecrets));
        taxiVolume = `${project}-taxi-data`;
        taxiContainer = `${project}-taxi`;
        await run(
            "docker",
            ["volume", "create", "--label", `dev.arkade-taxi.e2e-project=${project}`, taxiVolume],
            { print: false },
        );
        const taxiEnv = join(secretDir, "taxi.env");
        failureProxy = await createFailureProxy({
            arkd: arkdUrl,
            indexer: arkdUrl,
            emulator: emulatorUrl,
            esplora: esploraUrl,
        });
        const proxyOrigin = `http://host.docker.internal:${failureProxy.port}`;
        writeEnv(taxiEnv, {
            TAXI_DB_PATH: "/data/taxi.db",
            TAXI_HTTP_PORT: "8080",
            TAXI_ARKD_URL: `${proxyOrigin}/arkd`,
            TAXI_INDEXER_URL: `${proxyOrigin}/indexer`,
            TAXI_ESPLORA_URL: `${proxyOrigin}/esplora`,
            TAXI_EMULATOR_URL: `${proxyOrigin}/emulator`,
            TAXI_OPERATOR_PRIVKEY: actorSecrets.operator,
            TAXI_SERVER_PUBKEY: xOnlyKey(arkInfo.signerPubkey),
            TAXI_EMULATOR_PUBKEY: xOnlyKey(emulatorInfo.signerPubkey),
            TAXI_DUST: String(arkInfo.dust),
            TAXI_VTXO_MIN_AMOUNT: String(arkInfo.vtxoMinAmount),
            TAXI_ADDRESS_HRP: "tark",
            TAXI_OPERATOR_MIN_RESERVE_SATS: "10000",
            TAXI_MIN_EXPIRY_HEADROOM_BLOCKS: MIN_EXPIRY_HEADROOM_BLOCKS,
            TAXI_MIN_EXPIRY_HEADROOM_SECONDS: MIN_EXPIRY_HEADROOM_SECONDS,
            TAXI_RECOVERY_BROADCAST_SECONDS: RECOVERY_BROADCAST_SECONDS,
            TAXI_RECOVERY_CRITICAL_SECONDS: RECOVERY_CRITICAL_SECONDS,
            TAXI_RECONCILE_INTERVAL_MS: "5000",
            TAXI_LOG_LEVEL: "debug",
        });
        await run(
            "docker",
            buildTaxiRunArgs({
                container: taxiContainer,
                project,
                network,
                envFile: taxiEnv,
                volume: taxiVolume,
                port: 0,
                image: taxiImage,
            }),
            { env: childEnv, print: false },
        );
        ports.TAXI_E2E_HTTP_PORT = parsePublishedPort(
            (
                await run("docker", ["port", taxiContainer, "8080/tcp"], {
                    print: false,
                })
            ).stdout,
        );
        assertResolvedPorts(ports, portBindings.length + 1);
        const taxiUrl = `http://127.0.0.1:${ports.TAXI_E2E_HTTP_PORT}`;
        controlServer = createServer(async (request, response) => {
            try {
                if (request.method !== "POST") throw new Error("POST required");
                const chunks = [];
                for await (const chunk of request) chunks.push(chunk);
                const command = JSON.parse(Buffer.concat(chunks).toString());
                let result = { ok: true };
                if (command.action === "configure") failureProxy.configure(command.rule);
                else if (command.action === "reset") failureProxy.reset();
                else if (command.action === "events") result = { events: failureProxy.events };
                else if (command.action === "restart") {
                    const [container] = await jsonRun("docker", ["inspect", taxiContainer]);
                    const [volume] = await jsonRun("docker", ["volume", "inspect", taxiVolume]);
                    const [image] = await jsonRun("docker", ["image", "inspect", taxiImage]);
                    const { port } = assertTaxiRestartOwnership(container, volume, image, project);
                    await run("docker", ["stop", "--time", "10", taxiContainer], { print: false });
                    await captureTaxiDiagnostics(taxiContainer, project, artifacts, knownSecrets);
                    await run("docker", ["rm", taxiContainer], { print: false });
                    const args = buildTaxiRunArgs({
                        container: taxiContainer,
                        project,
                        network,
                        envFile: taxiEnv,
                        volume: taxiVolume,
                        port: 0,
                        image: taxiImage,
                    });
                    args[args.indexOf("-p") + 1] = `127.0.0.1:${port}:8080`;
                    await run("docker", args, { print: false });
                    const [recreated] = await jsonRun("docker", ["inspect", taxiContainer]);
                    assertTaxiRestartOwnership(recreated, volume, image, project);
                    result = {
                        previousId: container.Id,
                        id: recreated.Id,
                        volume: taxiVolume,
                        image: recreated.Image,
                    };
                } else throw new Error("unknown harness control");
                response
                    .writeHead(200, { "content-type": "application/json" })
                    .end(JSON.stringify(result));
            } catch (error) {
                response
                    .writeHead(500, { "content-type": "application/json" })
                    .end(JSON.stringify({ error: error.message }));
            }
        });
        await new Promise((resolve) => controlServer.listen(0, "127.0.0.1", resolve));
        await pollUntil({
            label: "Taxi production /health",
            timeoutMs: 60_000,
            intervalMs: 500,
            signal: activeInterruption?.operationSignal(),
            read: async () =>
                fetch(`${taxiUrl}/health`, { signal: operationFetchSignal(5_000) }).then(
                    async (response) => ({
                        status: response.status,
                        body: await response.json(),
                    }),
                ),
            ready: (value) => value.status === 200,
        });
        await patchPolicy(taxiUrl);
        await pollUntil({
            label: "Taxi production /ready",
            timeoutMs: 120_000,
            intervalMs: 500,
            signal: activeInterruption?.operationSignal(),
            read: async () =>
                fetch(`${taxiUrl}/ready`, { signal: operationFetchSignal(5_000) }).then(
                    async (response) => ({
                        status: response.status,
                        body: await response.json(),
                    }),
                ),
            ready: isTaxiReadyResponse,
        });
        const imageIds = [...new Set(labels.map((item) => item.Image))];
        const imageDetails = await jsonRun("docker", ["image", "inspect", ...imageIds]);
        const byId = new Map(imageDetails.map((item) => [item.Id, item]));
        const images = Object.fromEntries(
            labels.map((item) => {
                const detail = byId.get(item.Image);
                return [
                    item.Config.Labels["com.docker.compose.service"],
                    {
                        reference: item.Config.Image,
                        id: item.Image,
                        digests: detail?.RepoDigests ?? [],
                    },
                ];
            }),
        );
        images.taxi = {
            reference: taxiImage,
            id: taxiImageDetails.Id,
            digests: taxiImageDetails.RepoDigests ?? [],
        };
        writeStackManifest(join(artifacts, "stack.json"), {
            startedAtUtc,
            regtest: { repository: REGTEST_REPOSITORY, branch: "master", sha },
            sdkVersion: "0.4.72",
            taxi,
            stack: {
                project,
                profiles,
                ports: redactSecrets(ports),
                arkdDelays: configuredArkDelays,
                intentFees,
            },
            images,
            fixtures,
            knownSecrets,
        });
        const testEnv = eventSourceNodeEnvironment({
            ...childEnv,
            ARKADE_E2E: "1",
            ARKADE_REGTEST_SHA: sha,
            ARKADE_REGTEST_CLI: state.runner,
            ARKADE_REGTEST_ENV: envFile,
            ARKADE_ESPLORA_URL: esploraUrl,
            TAXI_E2E_BASE_URL: taxiUrl,
            TAXI_E2E_CONTROL_URL: `http://127.0.0.1:${controlServer.address().port}`,
            TAXI_E2E_ARKD_URL: arkdUrl,
            TAXI_E2E_EMULATOR_URL: emulatorUrl,
            TAXI_E2E_FIXTURE_FILE: fixtureFile,
            TAXI_E2E_SECRET_FILE: secretFile,
            TAXI_E2E_CLIENT_ENTRY: packs.entry,
            TAXI_DB_PATH: ":memory:",
            TAXI_ARKD_URL: arkdUrl,
            TAXI_INDEXER_URL: arkdUrl,
            TAXI_ESPLORA_URL: esploraUrl,
            TAXI_EMULATOR_URL: emulatorUrl,
            TAXI_OPERATOR_PRIVKEY: actorSecrets.operator,
            TAXI_SERVER_PUBKEY: xOnlyKey(arkInfo.signerPubkey),
            TAXI_EMULATOR_PUBKEY: xOnlyKey(emulatorInfo.signerPubkey),
            TAXI_DUST: String(arkInfo.dust),
            TAXI_VTXO_MIN_AMOUNT: String(arkInfo.vtxoMinAmount),
            TAXI_ADDRESS_HRP: "tark",
            TAXI_OPERATOR_MIN_RESERVE_SATS: "10000",
            TAXI_MIN_EXPIRY_HEADROOM_BLOCKS: MIN_EXPIRY_HEADROOM_BLOCKS,
            TAXI_MIN_EXPIRY_HEADROOM_SECONDS: MIN_EXPIRY_HEADROOM_SECONDS,
            TAXI_RECOVERY_BROADCAST_SECONDS: RECOVERY_BROADCAST_SECONDS,
            TAXI_RECOVERY_CRITICAL_SECONDS: RECOVERY_CRITICAL_SECONDS,
            TAXI_RECONCILE_INTERVAL_MS: "5000",
        });
        const vitestEntry = join(REPO, "node_modules", "vitest", "vitest.mjs");
        await runAndPublishResults(() =>
            run(
                process.execPath,
                nodeEventSourceArgs(vitestEntry, [
                    "run",
                    "--config",
                    "vitest.e2e.config.ts",
                    ...tests,
                    "--reporter=json",
                    `--outputFile=${resultsFile}`,
                ]),
                {
                    cwd: REPO,
                    env: testEnv,
                    secrets: knownSecrets,
                    timeoutMs: 900_000,
                },
            ),
        );
        const results = JSON.parse(readFileSync(resultsFile, "utf8"));
        await run(process.execPath, [join(REPO, "e2e", "assert-ran.mjs"), resultsFile], {
            cwd: REPO,
            env: testEnv,
            secrets: knownSecrets,
        });
        const skipped = results.numPendingTests + results.numTodoTests;
        if (results.numFailedTests || skipped || results.numPassedTests < tests.length)
            throw new Error(
                `E2E result invalid: ${results.numPassedTests} passed, ${skipped} skipped, ${results.numFailedTests} failed`,
            );
        await captureTaxiDiagnostics(taxiContainer, project, artifacts, knownSecrets);
        await captureStackDiagnostics(state, artifacts, knownSecrets);
        process.stdout.write(
            `arkade-regtest master ${sha}; ${results.numPassedTests} passed, zero skipped\n`,
        );
    } catch (error) {
        failure = error;
        if (existsSync(secretFile)) {
            try {
                const recovered = Object.values(JSON.parse(readFileSync(secretFile, "utf8")));
                for (const secret of recovered)
                    if (!knownSecrets.includes(secret)) knownSecrets.push(secret);
            } catch {}
        }
        if (interruption.interruptionError()) {
            try {
                await interruption.waitForOperations();
                interruption.beginCleanup();
            } catch (error) {
                cleanupFailure = error;
                throw error;
            }
        }
        if (taxiContainer) {
            try {
                await captureTaxiDiagnostics(taxiContainer, project, artifacts, knownSecrets);
            } catch (diagnosticError) {
                const safeDiagnosticError = contextualizeFailure(
                    diagnosticError,
                    state ?? { project },
                    knownSecrets,
                );
                const safeTaxiFailure = safeDiagnosticError.stack ?? safeDiagnosticError.message;
                assertArtifactSafe({ taxiLogs: safeTaxiFailure }, knownSecrets);
                writeFileSync(join(artifacts, "taxi.log"), `${safeTaxiFailure}\n`);
            }
        }
        if (state) {
            try {
                await captureStackDiagnostics(state, artifacts, knownSecrets);
            } catch (diagnosticError) {
                const safeDiagnosticError = contextualizeFailure(
                    diagnosticError,
                    state,
                    knownSecrets,
                );
                writeFileSync(
                    join(artifacts, "stack.log"),
                    `${safeDiagnosticError.stack ?? safeDiagnosticError.message}\n`,
                );
            }
        }
        const sanitizedError = contextualizeFailure(error, state ?? { project }, knownSecrets);
        const safeFailure = sanitizedError.stack ?? sanitizedError.message;
        assertArtifactSafe({ failure: safeFailure }, knownSecrets);
        writeFileSync(join(artifacts, "failure.log"), `${safeFailure}\n`);
        throw sanitizedError;
    } finally {
        if (!cleanupFailure) {
            try {
                await interruption.waitForOperations();
                interruption.beginCleanup();
            } catch (error) {
                cleanupFailure = error;
            }
        }
        if (controlServer) {
            controlServer.closeAllConnections();
            await new Promise((resolve) => controlServer.close(resolve));
        }
        if (failureProxy) {
            assertArtifactSafe({ events: failureProxy.events }, knownSecrets);
            writeFileSync(
                join(artifacts, "proxy-events.json"),
                JSON.stringify(failureProxy.events, null, 2),
            );
            await failureProxy.close();
        }
        if (cleanupFailure) {
            const causes = [...new Set([failure, cleanupFailure])].filter(Boolean);
            const reportedCause =
                causes.length === 1
                    ? causes[0]
                    : new AggregateError(
                          causes,
                          causes
                              .map((cause) =>
                                  cause instanceof Error ? cause.message : String(cause),
                              )
                              .join("; "),
                      );
            process.removeListener("SIGINT", signalHandlers.SIGINT);
            process.removeListener("SIGTERM", signalHandlers.SIGTERM);
            activeInterruption = undefined;
            failure = recordFailClosedInterruption({
                artifacts,
                error: reportedCause,
                knownSecrets,
                root,
                state: state ?? { project },
            });
            throw failure;
        }
        if (taxiContainer) {
            const inspected = await run(
                "docker",
                [
                    "inspect",
                    taxiContainer,
                    "--format",
                    '{{index .Config.Labels "dev.arkade-taxi.e2e-project"}}',
                ],
                { print: false, check: false },
            );
            if (inspected.stdout === project)
                await run("docker", ["rm", "-f", taxiContainer], { print: false, check: false });
        }
        if (taxiVolume) {
            const inspected = await run(
                "docker",
                [
                    "volume",
                    "inspect",
                    taxiVolume,
                    "--format",
                    '{{index .Labels "dev.arkade-taxi.e2e-project"}}',
                ],
                { print: false, check: false },
            );
            if (inspected.stdout === project)
                await run("docker", ["volume", "rm", taxiVolume], { print: false, check: false });
        }
        if (state) {
            let hasOwnedResources = false;
            let projectContainers = [];
            const containers = await run(
                "docker",
                ["ps", "-aq", "--filter", `label=com.docker.compose.project=${project}`],
                { print: false, check: false },
            );
            if (containers.stdout) {
                projectContainers = await assertProjectLabels(project, SERVICES);
                hasOwnedResources = true;
            }
            const networkInspection = await run("docker", ["network", "inspect", network], {
                print: false,
                check: false,
            });
            if (networkInspection.code === 0) {
                assertProjectNetwork(JSON.parse(networkInspection.stdout)[0], {
                    project,
                    network,
                });
                hasOwnedResources = true;
            }
            const labeledVolumeNames = (
                await run(
                    "docker",
                    [
                        "volume",
                        "ls",
                        "-q",
                        "--filter",
                        `label=com.docker.compose.project=${project}`,
                    ],
                    { print: false, check: false },
                )
            ).stdout
                .split(/\s+/)
                .filter(Boolean);
            const mountedVolumeNames = projectContainers.flatMap((container) =>
                (container.Mounts ?? [])
                    .filter((mount) => mount.Type === "volume")
                    .map((mount) => mount.Name),
            );
            const volumeNames = new Set([
                ...labeledVolumeNames,
                ...(state.volumeNames ?? []),
                ...mountedVolumeNames,
            ]);
            const volumeCandidates = [];
            for (const volumeName of volumeNames) {
                const inspection = await run("docker", ["volume", "inspect", volumeName], {
                    print: false,
                    check: false,
                });
                if (inspection.code !== 0) continue;
                const consumerIds = (
                    await run("docker", ["ps", "-aq", "--filter", `volume=${volumeName}`], {
                        print: false,
                        check: false,
                    })
                ).stdout
                    .split(/\s+/)
                    .filter(Boolean);
                const consumers = consumerIds.length
                    ? await jsonRun("docker", ["inspect", ...consumerIds])
                    : [];
                volumeCandidates.push({
                    volume: JSON.parse(inspection.stdout)[0],
                    named: (state.volumeNames ?? []).includes(volumeName),
                    consumers,
                });
            }
            if (volumeCandidates.length) {
                assertVolumeDeletionCandidates(volumeCandidates, {
                    project,
                    services: SERVICES,
                });
                hasOwnedResources = true;
            }
            if (hasOwnedResources)
                await run("docker", composeArgs(state, ["down", "--remove-orphans"]), {
                    env: state.childEnv,
                    print: false,
                    check: false,
                });
            for (const { volume } of volumeCandidates)
                await run("docker", ["volume", "rm", volume.Name], {
                    print: false,
                    check: false,
                });
        }
        if (taxiImage) {
            const inspected = await run(
                "docker",
                [
                    "image",
                    "inspect",
                    taxiImage,
                    "--format",
                    '{{index .Config.Labels "dev.arkade-taxi.e2e-project"}}',
                ],
                { print: false, check: false },
            );
            if (inspected.stdout === project)
                await run("docker", ["image", "rm", taxiImage], {
                    print: false,
                    check: false,
                });
        }
        const target = resolve(root);
        if (!target.startsWith(resolve(tmpdir()) + sep) || !target.includes(`taxi12-${id}-`))
            throw new Error(`refusing temporary cleanup outside the run root: ${target}`);
        rmSync(target, { recursive: true, force: true });
        if (!failure) removeStaleFailureDiagnostics(artifacts);
        process.removeListener("SIGINT", signalHandlers.SIGINT);
        process.removeListener("SIGTERM", signalHandlers.SIGTERM);
        activeInterruption = undefined;
        if (!failure && interruption.interruptionError()) throw interruption.interruptionError();
    }
}

const mainPath = process.argv[1] ? resolve(process.argv[1]) : "";
if (mainPath && fileURLToPath(import.meta.url) === mainPath)
    main().catch((error) => {
        process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
        process.exitCode = 1;
    });
