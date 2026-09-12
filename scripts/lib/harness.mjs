import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join, posix, win32 } from "node:path";

const ACTORS = ["operator", "sender", "receiverWithAsset", "receiverSats", "emptyReceiver"];
const SECRET_KEY =
    /(?:secret|private.?key|privkey|mnemonic|seed|password|token|credential|authorization|cookie|wif)/i;

const stableJson = (value) =>
    JSON.stringify(value, (_, item) => (typeof item === "bigint" ? item.toString() : item));

export function routeProviderFetch(fetcher, routes) {
    const mappings = routes
        .map(([advertised, reachable]) => ({
            source: new URL(advertised),
            target: new URL(reachable),
            prefix: new URL(advertised).pathname.replace(/\/$/, ""),
        }))
        .sort((a, b) => b.prefix.length - a.prefix.length);
    return (input, init) => {
        const url = new URL(input instanceof Request ? input.url : input);
        const mapping = mappings.find(
            ({ source, prefix }) =>
                source.origin === url.origin &&
                (url.pathname === prefix || url.pathname.startsWith(`${prefix}/`)),
        );
        if (!mapping) return fetcher(input, init);
        const target = new URL(mapping.target);
        target.pathname =
            mapping.target.pathname.replace(/\/$/, "") + url.pathname.slice(mapping.prefix.length);
        target.search = url.search;
        return fetcher(input instanceof Request ? new Request(target, input) : target, init);
    };
}

export async function pollUntil({
    label,
    timeoutMs,
    intervalMs = 250,
    read,
    ready,
    now = Date.now,
    delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    signal,
}) {
    if (!label || !Number.isFinite(timeoutMs) || timeoutMs < 0)
        throw new Error("pollUntil requires a label and non-negative timeout");
    if (!Number.isFinite(intervalMs) || intervalMs <= 0)
        throw new Error("pollUntil requires a positive retry interval");
    const start = now();
    let attempts = 0;
    let last;
    for (;;) {
        signal?.throwIfAborted();
        attempts += 1;
        try {
            last = await read();
            if (ready(last)) return last;
        } catch (error) {
            signal?.throwIfAborted();
            last = { error: error instanceof Error ? error.message : String(error) };
        }
        const elapsed = now() - start;
        if (elapsed >= timeoutMs) {
            throw new Error(
                `timed out waiting for ${label} after ${elapsed}ms; attempts=${attempts}; last=${stableJson(last)}`,
            );
        }
        await delay(Math.min(intervalMs, timeoutMs - elapsed));
    }
}

export const isTaxiReadyResponse = (response) =>
    response?.status === 200 &&
    response?.body?.status === "ok" &&
    Array.isArray(response.body.blockers) &&
    response.body.blockers.length === 0 &&
    response.body.startup?.complete === true;

export function canonicalVtxoSnapshot(vtxos, normalizeExpiry) {
    if (!Array.isArray(vtxos) || typeof normalizeExpiry !== "function")
        throw new Error("VTXO snapshot requires an array and expiry normalizer");
    const seen = new Set();
    return vtxos
        .map((coin) => {
            if (
                typeof coin?.txid !== "string" ||
                !/^[0-9a-f]{64}$/i.test(coin.txid) ||
                !Number.isSafeInteger(coin.vout) ||
                coin.vout < 0
            )
                throw new Error("invalid VTXO outpoint");
            const key = `${coin.txid.toLowerCase()}:${coin.vout}`;
            if (seen.has(key)) throw new Error(`duplicate VTXO ${key}`);
            seen.add(key);
            const expiry = normalizeExpiry(coin);
            if (
                !["height", "time"].includes(expiry?.kind) ||
                typeof expiry?.value !== "bigint" ||
                expiry.value <= 0n
            )
                throw new Error(`invalid VTXO expiry ${key}`);
            return {
                txid: coin.txid.toLowerCase(),
                vout: coin.vout,
                expiry: { kind: expiry.kind, value: expiry.value.toString() },
            };
        })
        .sort((left, right) =>
            `${left.txid}:${left.vout}`.localeCompare(`${right.txid}:${right.vout}`),
        );
}

export function assertVtxoSnapshotContains(durable, observed) {
    const byOutpoint = new Map(durable.map((coin) => [`${coin.txid}:${coin.vout}`, coin]));
    for (const coin of observed) {
        const key = `${coin.txid}:${coin.vout}`;
        const saved = byOutpoint.get(key);
        if (!saved) throw new Error(`durable snapshot lost observed VTXO ${key}`);
        if (stableJson(saved) !== stableJson(coin))
            throw new Error(`durable snapshot changed observed VTXO ${key}`);
    }
    return durable;
}

export async function explicitMine(blocks, run) {
    if (!Number.isSafeInteger(blocks) || blocks <= 0)
        throw new Error("mining requires an explicit positive integer block count");
    const result = await run(["mine", String(blocks)]);
    if (result.code !== 0) {
        throw new Error(
            `explicit mining of ${blocks} block(s) failed: ${result.stderr || result.stdout || `exit ${result.code}`}`,
        );
    }
    return { blocks, stdout: result.stdout ?? "" };
}

const EVENT_SOURCE_NODE_FLAG = "--experimental-eventsource";
const TASK12_TESTS = [
    "e2e/provider-contract.e2e.test.ts",
    "e2e/claim.e2e.test.ts",
    "e2e/exposure.e2e.test.ts",
    "e2e/verify-quote.e2e.test.ts",
    "e2e/refund-recovery.e2e.test.ts",
    "e2e/resilience.e2e.test.ts",
    "e2e/suite-integrity.e2e.test.ts",
];

export const nodeEventSourceArgs = (script, args = []) => [EVENT_SOURCE_NODE_FLAG, script, ...args];

export function eventSourceNodeEnvironment(environment) {
    const current = String(environment.NODE_OPTIONS ?? "").trim();
    const options = current.split(/\s+/).filter(Boolean);
    if (!options.includes(EVENT_SOURCE_NODE_FLAG)) options.push(EVENT_SOURCE_NODE_FLAG);
    return { ...environment, NODE_OPTIONS: options.join(" ") };
}

export function resolveTask12Tests(args) {
    if (!Array.isArray(args) || args.some((arg) => typeof arg !== "string"))
        throw new Error("Task 12 requires exactly the two approved test paths");
    if (args.length === 0) return [...TASK12_TESTS];
    if (
        args.length !== TASK12_TESTS.length ||
        new Set(args).size !== TASK12_TESTS.length ||
        args.some((arg) => !TASK12_TESTS.includes(arg))
    )
        throw new Error("Task 12 requires exactly the two approved test paths");
    return [...TASK12_TESTS];
}

export function packageManagerInvocation(
    args,
    {
        platform = process.platform,
        execPath = process.execPath,
        npmExecPath = process.env.npm_execpath,
        exists = existsSync,
    } = {},
) {
    if (!Array.isArray(args) || args.some((arg) => typeof arg !== "string"))
        throw new Error("pnpm arguments must be an array of strings");
    const paths = platform === "win32" ? win32 : posix;
    const candidates = [
        npmExecPath,
        paths.join(paths.dirname(execPath), "node_modules", "corepack", "dist", "pnpm.js"),
    ];
    const entry = candidates.find(
        (candidate) =>
            typeof candidate === "string" &&
            paths.isAbsolute(candidate) &&
            /^pnpm\.(?:c?js|mjs)$/i.test(paths.basename(candidate)) &&
            exists(candidate),
    );
    if (entry) return { command: execPath, args: [entry, ...args] };
    if (platform === "win32")
        throw new Error("cannot resolve a shell-free pnpm JavaScript entrypoint on win32");
    return { command: "pnpm", args: [...args] };
}

const localTarballSpec = (path, consumer, paths) => {
    const relative = paths.relative(consumer, path).replaceAll("\\", "/");
    return `file:${relative.startsWith(".") ? relative : `./${relative}`}`;
};

export function buildConsumerManifest(tarballs, consumer, platform = process.platform) {
    if (!Array.isArray(tarballs) || tarballs.length !== 3)
        throw new Error("consumer requires exactly three Taxi tarballs");
    const paths = platform === "win32" ? win32 : posix;
    const packages = {};
    for (const tarball of tarballs) {
        const name = /arkade-taxi-(client|covenant|protocol)-[^/\\]+\.tgz$/.exec(tarball)?.[1];
        if (!name || packages[name])
            throw new Error("consumer requires exactly three distinct Taxi tarballs");
        packages[name] = localTarballSpec(tarball, consumer, paths);
    }
    if (!["client", "covenant", "protocol"].every((name) => packages[name]))
        throw new Error("consumer requires exactly three distinct Taxi tarballs");
    return {
        name: "taxi-e2e-consumer",
        private: true,
        type: "module",
        dependencies: {
            "@arkade-taxi/client": packages.client,
            "@arkade-taxi/covenant": packages.covenant,
            "@arkade-taxi/protocol": packages.protocol,
        },
        pnpm: {
            overrides: {
                "@arkade-taxi/covenant@0.0.0": "$@arkade-taxi/covenant",
                "@arkade-taxi/protocol@0.0.0": "$@arkade-taxi/protocol",
            },
        },
    };
}

export function packageManagerEnvironment(environment, npmUserConfig) {
    if (!npmUserConfig) throw new Error("package manager requires an isolated npm config");
    const allow = new Set([
        "APPDATA",
        "CI",
        "COMSPEC",
        "COREPACK_HOME",
        "HOME",
        "LOCALAPPDATA",
        "NODE_EXTRA_CA_CERTS",
        "PATH",
        "PATHEXT",
        "PNPM_HOME",
        "SSL_CERT_FILE",
        "SYSTEMROOT",
        "TEMP",
        "TMP",
        "TMPDIR",
        "USERPROFILE",
    ]);
    const safe = {};
    for (const [key, value] of Object.entries(environment)) {
        if (allow.has(key.toUpperCase())) safe[key] = value;
    }
    safe.NPM_CONFIG_USERCONFIG = npmUserConfig;
    safe.NPM_CONFIG_GLOBALCONFIG = npmUserConfig;
    return safe;
}

export function assertPackResult(output, expected, exists = existsSync) {
    let result;
    try {
        result = JSON.parse(output);
    } catch {
        throw new Error(`${expected.name} pack result changed: invalid JSON`);
    }
    const paths = process.platform === "win32" ? win32 : posix;
    const filename = typeof result?.filename === "string" ? paths.resolve(result.filename) : "";
    if (
        result?.name !== expected.name ||
        result?.version !== "0.0.0" ||
        paths.dirname(filename) !== paths.resolve(expected.packDir) ||
        !exists(filename)
    )
        throw new Error(`${expected.name} pack result changed`);
    return filename;
}

export function assertTarballIntegrity(before, after) {
    if (stableJson(before) !== stableJson(after)) throw new Error("packed tarball changed");
    return after;
}

export function assertLocalConsumerResolution(manifest, lock, listed) {
    for (const name of ["@arkade-taxi/client", "@arkade-taxi/covenant", "@arkade-taxi/protocol"]) {
        const spec = manifest?.dependencies?.[name];
        const dependency = listed?.dependencies?.[name];
        if (
            typeof spec !== "string" ||
            !spec.startsWith("file:") ||
            !lock.includes(spec) ||
            dependency?.resolved !== spec ||
            dependency?.version !== "0.0.0"
        )
            throw new Error(`${name} did not resolve from its local tarball`);
    }
    return listed;
}

export function resolveInstalledClientEntry(consumer, exists = existsSync) {
    const paths = process.platform === "win32" ? win32 : posix;
    const entry = paths.join(
        consumer,
        "node_modules",
        "@arkade-taxi",
        "client",
        "dist",
        "index.js",
    );
    if (!exists(entry)) throw new Error("packed client entry is missing after local install");
    return entry;
}

export function buildArkFundingArgs({ address, amount, password }) {
    if (!address || !Number.isSafeInteger(amount) || amount <= 0 || !password)
        throw new Error("Ark funding requires address, positive amount, and run password");
    return ["ark", "send", "--to", address, "--amount", String(amount), "--password", password];
}

export function resolveMasterSha(output) {
    const value = String(output).trim();
    if (!/^[0-9a-f]{40}$/.test(value))
        throw new Error("git rev-parse did not return one exact 40-character master SHA");
    return value;
}

const isolatedProject = (project) => {
    if (!/^taxi12-[a-z0-9]{8,32}$/.test(project) || project === "arkade-regtest")
        throw new Error("Task 12 requires a unique project name matching taxi12-[a-z0-9]{8,32}");
};

export function discoverProfileClosure(source, requested, sha) {
    const body = /const PROFILE_DEPS\s*=\s*\{([\s\S]*?)^\s*\};/m.exec(source)?.[1];
    if (!body)
        throw new Error(`arkade-regtest ${sha} CLI changed: PROFILE_DEPS was not discovered`);
    const profiles = new Map();
    for (const line of body.split(/\r?\n/)) {
        const match = /^\s*(?:'([^']+)'|([a-z][a-z0-9-]*)):\s*\[([^\]]*)\]/.exec(line);
        if (!match) continue;
        profiles.set(
            match[1] ?? match[2],
            [...match[3].matchAll(/'([^']+)'/g)].map((m) => m[1]),
        );
    }
    if (!profiles.has(requested))
        throw new Error(`arkade-regtest ${sha} has no "${requested}" profile`);
    const ordered = [];
    const seen = new Set();
    const visit = (name) => {
        if (seen.has(name)) return;
        const dependencies = profiles.get(name);
        if (!dependencies)
            throw new Error(`arkade-regtest ${sha} profile "${name}" has an unknown dependency`);
        for (const dependency of dependencies) visit(dependency);
        seen.add(name);
        ordered.push(name);
    };
    visit(requested);
    return ordered;
}

export function discoverPortBindings(source, selectedServices, expectedNames, sha) {
    const selected = new Set(selectedServices);
    const found = new Map();
    let service = "";
    for (const line of source.split(/\r?\n/)) {
        const serviceMatch = /^  ([a-zA-Z0-9_-]+):\s*$/.exec(line);
        if (serviceMatch) service = serviceMatch[1];
        const port = /\$\{([A-Z][A-Z0-9_]*_PORT)(?::-[^}]+)?\}:(\d+)/.exec(line);
        if (port && selected.has(service)) found.set(port[1], [port[1], service, Number(port[2])]);
    }
    const actual = [...found.keys()].sort();
    const expected = [...expectedNames].sort();
    if (stableJson(actual) !== stableJson(expected))
        throw new Error(
            `arkade-regtest ${sha} published-port interface changed: ${actual.join(",")}`,
        );
    return expectedNames.map((name) => found.get(name));
}

export function assertPortBindingContract(actual, expected) {
    if (stableJson(actual) !== stableJson(expected))
        throw new Error("published-port binding contract changed");
    return actual;
}

const stripComposeNames = (source) =>
    source
        .replace(/^name:\s*[^\r\n]+\r?\n/gm, "")
        .replace(/^\s+container_name:\s*[^\r\n]+\r?\n/gm, "")
        .replace(
            /^(\s*-\s*)(['"]?)[^\r\n]*_PORT[^\r\n]*:(\d+)\2\s*$/gm,
            (_match, prefix, quote, internal) => `${prefix}${quote}127.0.0.1::${internal}${quote}`,
        );

const composeServiceNames = (source) => {
    const section = /^services:\s*\r?\n([\s\S]*?)(?=^\S|$(?![\s\S]))/m.exec(source)?.[1] ?? "";
    return [...section.matchAll(/^  ([a-zA-Z0-9_-]+):\s*$/gm)].map((match) => match[1]);
};

export function namespaceRegtestSources(sources, project, expectedPortBindings) {
    isolatedProject(project);
    if (!Array.isArray(expectedPortBindings) || !expectedPortBindings.length)
        throw new Error("arkade-regtest published-port binding contract is missing");
    const composeNeedle = "'compose',";
    const composeReplacement = `'compose', '-p', '${project}',`;
    if (!sources.compose.includes(composeNeedle))
        throw new Error("arkade-regtest compose interface changed: compose argv was not found");
    const execNeedle = "return docker(['exec', container, ...argv], opts);";
    const execReplacement =
        `return docker(['compose', '-p', '${project}', '-f', process.env.TAXI_E2E_COMPOSE_BASE, ` +
        "'-f', process.env.TAXI_E2E_COMPOSE_ARK, 'exec', '-T', container, ...argv], opts);";
    if (!sources.proc.includes(execNeedle))
        throw new Error(
            "arkade-regtest exec interface changed: dockerExec implementation was not found",
        );
    const arkExec = "docker(['exec', 'arkd', ...argv])";
    const bitcoinExec = "docker(['exec', 'bitcoin',";
    if (!sources.regtest.includes(arkExec) || !sources.regtest.includes(bitcoinExec))
        throw new Error("arkade-regtest CLI interface changed: direct service exec was not found");
    const composeImport =
        "import { ROOT, composeUp, composeStop, composeDown } from './lib/compose.mjs';";
    const firstWave = "if (firstWave.code !== 0) fail('docker compose up failed');";
    const appWave = "if (appWave.code !== 0) fail('docker compose up failed');";
    const emulatorStart = "async function startEmulator() {";
    const setupArkd = "if (active.has('ark')) await setupArkd();";
    const arkdUrl = "const arkdUrl = () => `http://localhost:${env('ARKD_PORT', '7070')}`;";
    const arkdAdminUrl =
        "const arkdAdminUrl = () => `http://localhost:${env('ARKD_ADMIN_PORT', '7071')}`;";
    if (
        !sources.regtest.includes(composeImport) ||
        !sources.regtest.includes(firstWave) ||
        !sources.regtest.includes(appWave) ||
        !sources.regtest.includes(emulatorStart) ||
        !sources.regtest.includes(setupArkd) ||
        !sources.arkdSetup?.includes(arkdUrl) ||
        !sources.arkdSetup?.includes(arkdAdminUrl)
    )
        throw new Error(
            "arkade-regtest start interface changed: dynamic port hooks were not found",
        );
    const baseServices = composeServiceNames(sources.base);
    if (!baseServices.length)
        throw new Error("arkade-regtest compose interface changed: base services were not found");
    const portRefresh = `const taxiE2eProvenance = \`arkade-regtest ${"${process.env.TAXI_E2E_REGTEST_SHA || 'SHA-unresolved'}"} project ${"${process.env.TAXI_E2E_PROJECT || 'project-unresolved'}"}\`;
const taxiE2eExpectedPortBindings = ${JSON.stringify(expectedPortBindings)};
let taxiE2ePortBindings;
try {
  taxiE2ePortBindings = JSON.parse(process.env.TAXI_E2E_PORT_BINDINGS || '[]');
} catch {
  fail(\`${"${taxiE2eProvenance}"} published-port binding contract changed: invalid JSON\`);
}
if (JSON.stringify(taxiE2ePortBindings) !== JSON.stringify(taxiE2eExpectedPortBindings)) {
  fail(\`${"${taxiE2eProvenance}"} published-port binding contract changed\`);
}
const taxiE2eBaseServices = ${JSON.stringify(baseServices)};
async function refreshPublishedPorts(profiles, requiredServices, requiredNames) {
  const required = new Set(requiredServices || taxiE2ePortBindings.map(([, service]) => service));
  const names = requiredNames ? new Set(requiredNames) : undefined;
  const selected = taxiE2ePortBindings.filter(([name, service]) => required.has(service) && (!names || names.has(name)));
  const pending = new Map(selected.map((binding) => [binding[0], binding]));
  const resolved = [];
  let last = {};
  for (let attempt = 1; attempt <= 40; attempt++) {
    last = {};
    for (const [name, [, service, internal]] of pending) {
      const result = composePort(service, internal, profiles);
      const port = /:(\\d+)\\s*$/.exec(result.stdout || '')?.[1];
      if (result.code !== 0 || !port || port === '0') {
        last[name] = { service, internal, code: result.code, stdout: result.stdout || '', stderr: result.stderr || '' };
        continue;
      }
      process.env[name] = port;
      resolved.push({ name, service, internal, resolvedPort: Number(port) });
      pending.delete(name);
    }
    if (!pending.size) {
      log(\`${"${taxiE2eProvenance}"} Resolved published ports: ${"${JSON.stringify(resolved)}"}\`);
      return;
    }
    if (attempt < 40) await sleep(250);
  }
  fail(\`${"${taxiE2eProvenance}"} published-port refresh timed out after 40 attempts; last=${"${JSON.stringify(last)}"}\`);
}

async function waitForCurrentArkdAdmin(profiles) {
  let last;
  for (let attempt = 1; attempt <= 120; attempt++) {
    await refreshPublishedPorts(profiles, undefined, ['ARKD_PORT', 'ARKD_ADMIN_PORT']);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5000);
    try {
      const response = await fetch('http://127.0.0.1:' + process.env.ARKD_ADMIN_PORT + '/v1/admin/wallet/status', { signal: controller.signal });
      await response.body?.cancel();
      if (response.ok) return;
      last = 'HTTP ' + response.status;
    } catch (error) {
      last = error instanceof Error ? error.message : String(error);
    } finally {
      clearTimeout(timer);
    }
    if (attempt < 120) await sleep(3000);
  }
  fail(\`${"${taxiE2eProvenance}"} current arkd admin endpoint did not become ready; last=${"${last}"}\`);
}

`;
    const base = stripComposeNames(sources.base);
    const ark = stripComposeNames(sources.ark);
    if (
        `${base}\n${ark}`
            .split(/\r?\n/)
            .some((line) => /^\s*-\s*['"]?[^\r\n]*_PORT[^\r\n]*:\d+['"]?\s*$/.exec(line))
    )
        throw new Error("arkade-regtest port isolation failed: host-port interpolation survived");
    return {
        base,
        ark,
        compose:
            sources.compose.replace(composeNeedle, composeReplacement) +
            `\nexport function composePort(service, internalPort, profiles) {\n  return compose(['port', service, String(internalPort)], { profiles, capture: true });\n}\n`,
        proc: sources.proc.replace(execNeedle, execReplacement),
        regtest: sources.regtest
            .replace(composeImport, composeImport.replace(" }", ", composePort }"))
            .replace(emulatorStart, portRefresh + emulatorStart)
            .replace(
                firstWave,
                `${firstWave}\n  await refreshPublishedPorts(['base'], taxiE2eBaseServices);`,
            )
            .replace(appWave, `${appWave}\n    await refreshPublishedPorts(waveProfiles);`)
            .replace(
                setupArkd,
                `if (active.has('ark')) {\n    await waitForCurrentArkdAdmin(waveProfiles);\n    await setupArkd();\n  }`,
            )
            .replace(arkExec, "dockerExec('arkd', argv)")
            .replace(bitcoinExec, "dockerExec('bitcoin', [")
            .replaceAll("http://localhost:${", "http://127.0.0.1:${"),
        arkdSetup: sources.arkdSetup
            .replace(arkdUrl, arkdUrl.replace("localhost", "127.0.0.1"))
            .replace(arkdAdminUrl, arkdAdminUrl.replace("localhost", "127.0.0.1")),
    };
}

export function assertRenderedCompose(rendered, expected) {
    isolatedProject(expected.project);
    if (rendered?.name !== expected.project)
        throw new Error(`rendered Compose project is ${rendered?.name ?? "missing"}`);
    const services = rendered?.services;
    if (!services || typeof services !== "object")
        throw new Error("rendered Compose services are missing");
    const actual = Object.keys(services).sort();
    const wanted = [...expected.services].sort();
    if (stableJson(actual) !== stableJson(wanted))
        throw new Error(`rendered Compose service set changed: ${stableJson(actual)}`);
    for (const [name, service] of Object.entries(services)) {
        if (Object.hasOwn(service, "container_name"))
            throw new Error(`rendered service ${name} retained container_name`);
    }
    const portEntries = Object.values(services).flatMap((service) => service.ports ?? []);
    const ports = portEntries.map((port) => String(port.published));
    const hostIps = portEntries.map((port) => port.host_ip);
    if (hostIps.some((hostIp) => hostIp !== "127.0.0.1"))
        throw new Error("rendered published port is not bound to 127.0.0.1");
    const validPorts = expected.daemonAssigned
        ? portEntries.every(
              (port) => !Object.hasOwn(port, "published") || String(port.published) === "0",
          )
        : new Set(ports).size === ports.length;
    if (ports.length !== expected.publishedPorts || !validPorts)
        throw new Error(
            `rendered published ports are not ${expected.publishedPorts} ${expected.daemonAssigned ? "daemon-assigned" : "unique"} values`,
        );
    const interval = services["bitcoin-miner"]?.environment?.AUTOMINE_INTERVAL;
    if (String(interval) !== "0") throw new Error("rendered bitcoin miner is not disabled");
    if (expected.network && rendered?.networks?.default?.name !== expected.network)
        throw new Error(
            `rendered default network is ${rendered?.networks?.default?.name ?? "missing"}`,
        );
}

export function assertProjectNetwork(candidate, expected) {
    isolatedProject(expected.project);
    if (
        expected.network !== `${expected.project}_default` ||
        candidate?.Name !== expected.network ||
        candidate?.Labels?.["com.docker.compose.project"] !== expected.project
    )
        throw new Error("Compose network is not owned by the isolated project");
    return candidate;
}

export function assertProjectVolumes(candidates, expected) {
    isolatedProject(expected.project);
    for (const candidate of candidates)
        if (
            !candidate?.Name ||
            candidate?.Labels?.["com.docker.compose.project"] !== expected.project
        )
            throw new Error("Compose volume is not owned by the isolated project");
    return candidates;
}

export function assertVolumeDeletionCandidates(candidates, expected) {
    isolatedProject(expected.project);
    for (const candidate of candidates) {
        if (candidate.named) {
            assertProjectVolumes([candidate.volume], expected);
            continue;
        }
        if (!candidate.consumers?.length)
            throw new Error(`anonymous volume ${candidate.volume?.Name ?? "unknown"} has no owner`);
        assertCleanupCandidates(candidate.consumers, expected);
    }
    return candidates;
}

export function buildTaxiRunArgs({ container, project, network, envFile, volume, port, image }) {
    isolatedProject(project);
    if (network !== `${project}_default`)
        throw new Error("Taxi requires the project default network");
    if (!container.startsWith(`${project}-`) || !volume.startsWith(`${project}-`))
        throw new Error("Taxi container and volume must be run-scoped");
    if (port !== 0) throw new Error("Taxi host port must be daemon-assigned");
    return [
        "run",
        "-d",
        "--name",
        container,
        "--network",
        network,
        "--label",
        `dev.arkade-taxi.e2e-project=${project}`,
        "--env-file",
        envFile,
        "-v",
        `${volume}:/data`,
        "-p",
        "127.0.0.1::8080",
        image,
    ];
}

export function parsePublishedPort(output) {
    const port = Number(/:(\d+)\s*$/.exec(String(output))?.[1]);
    if (!Number.isSafeInteger(port) || port <= 0 || port > 65535)
        throw new Error(`invalid daemon-published port: ${String(output).trim()}`);
    return port;
}

export function resolvePortRefresh(bindings, results, requiredServices) {
    const byName = new Map(results.map((result) => [result.name, result]));
    const resolved = {};
    const failures = [];
    for (const [name, service, internal] of bindings) {
        if (requiredServices && !requiredServices.has(service)) continue;
        const result = byName.get(name);
        try {
            if (!result || result.code !== 0) throw new Error("unresolved");
            resolved[name] = parsePublishedPort(result.stdout);
        } catch {
            failures.push(
                `${name}(service=${service},target=${internal},code=${result?.code ?? "missing"})`,
            );
        }
    }
    if (failures.length) throw new Error(`published-port refresh failed: ${failures.join(", ")}`);
    return resolved;
}

export function assertResolvedPorts(ports, expectedCount) {
    const values = Object.values(ports);
    if (
        values.length !== expectedCount ||
        values.some((port) => !Number.isSafeInteger(port) || port <= 0 || port > 65535) ||
        new Set(values).size !== values.length
    )
        throw new Error(`resolved ports must contain ${expectedCount} unique nonzero values`);
    return ports;
}

export function assertConfiguredArkDelays(environment, expected) {
    if (!expected || typeof expected !== "object")
        throw new Error("expected Ark delay environment is missing");
    const verified = {};
    for (const [key, expectedValue] of Object.entries(expected)) {
        if (environment?.[key] === undefined) throw new Error(`${key} is missing`);
        let wanted;
        let actual;
        try {
            wanted = BigInt(expectedValue);
            actual = BigInt(environment[key]);
        } catch {
            throw new Error(`${key} is malformed`);
        }
        if (wanted < 512n || actual < 512n)
            throw new Error(`${key} must use the seconds-domain value at least 512`);
        if (actual !== wanted) throw new Error(`expected ${key}=${wanted}, received ${actual}`);
        verified[key] = String(actual);
    }
    return verified;
}

export function assertOwnedServiceEnvironment(candidates, expected) {
    isolatedProject(expected.project);
    const matches = candidates.filter(
        (candidate) =>
            candidate?.Config?.Labels?.["com.docker.compose.service"] === expected.service,
    );
    if (matches.length !== 1)
        throw new Error(
            `expected exactly one ${expected.service} container, received ${matches.length}`,
        );
    const candidate = matches[0];
    const labels = candidate.Config.Labels;
    if (labels["com.docker.compose.project"] !== expected.project)
        throw new Error(`${expected.service} container has wrong project label`);
    if (candidate?.State?.Running !== true)
        throw new Error(`${expected.service} container is not running`);
    const verified = {};
    for (const [key, value] of Object.entries(expected.environment ?? {})) {
        const prefix = `${key}=`;
        const values = (candidate?.Config?.Env ?? [])
            .filter((entry) => entry.startsWith(prefix))
            .map((entry) => entry.slice(prefix.length));
        if (values.length !== 1)
            throw new Error(
                `${expected.service} container must have exactly one ${key} environment entry`,
            );
        if (values[0] !== value) throw new Error(`expected ${key}=${value}, received ${values[0]}`);
        verified[key] = values[0];
    }
    return verified;
}

export function formatProcessFailure(command, args, result) {
    const sections = [];
    if (result.stdout) sections.push(`stdout:\n${result.stdout}`);
    if (result.stderr) sections.push(`stderr:\n${result.stderr}`);
    return `${command} ${args[0] ?? ""} exited ${result.code}${sections.length ? `:\n${sections.join("\n")}` : ""}`;
}

export function removeStaleFailureDiagnostics(directory) {
    rmSync(join(directory, "failure.log"), { force: true });
}

export function prepareResultPublication({ source, destinations, knownSecrets = [] }) {
    for (const path of [source, ...destinations]) rmSync(path, { force: true });
    return async (run) => {
        try {
            return await run();
        } finally {
            if (existsSync(source)) {
                const safe = redactSecrets(JSON.parse(readFileSync(source, "utf8")), knownSecrets);
                assertArtifactSafe(safe, knownSecrets);
                const json = `${JSON.stringify(safe, null, 2)}\n`;
                for (const path of destinations) {
                    const temporary = `${path}.${randomUUID()}.tmp`;
                    try {
                        writeFileSync(temporary, json, { flag: "wx" });
                        renameSync(temporary, path);
                    } finally {
                        rmSync(temporary, { force: true });
                    }
                }
            }
        }
    };
}

export function assertCleanupCandidates(candidates, expected) {
    isolatedProject(expected.project);
    const services = new Set(expected.services);
    for (const candidate of candidates) {
        const labels = candidate?.Config?.Labels ?? {};
        if (labels["com.docker.compose.project"] !== expected.project)
            throw new Error(
                `cleanup candidate ${candidate?.Id ?? "unknown"} has wrong project label`,
            );
        const service = labels["com.docker.compose.service"];
        if (!services.has(service))
            throw new Error(`cleanup candidate ${candidate?.Id ?? "unknown"} has unknown service`);
        if (candidate?.Name?.replace(/^\//, "") === service)
            throw new Error(`cleanup candidate ${candidate.Id} retained a bare upstream name`);
    }
    return candidates;
}

const validSeed = (value) => /^[0-9a-f]{64}$/.test(value) && !/^0{64}$/.test(value);

export function ensureActorSecrets(existing = {}, generate) {
    const result = {};
    for (const actor of ACTORS) {
        const seed = existing[actor] ?? generate(actor);
        if (!validSeed(seed)) throw new Error(`invalid 32-byte secret for ${actor}`);
        result[actor] = seed;
    }
    return result;
}

export async function ensureMintedAsset({ record, required, balance, issue }) {
    if (typeof required !== "bigint" || required <= 0n)
        throw new Error("asset amount must be a positive bigint");
    if (record) {
        const available = await balance(record.assetId);
        if (available < required)
            throw new Error(
                `recorded asset ${record.assetId} has ${available}, requires ${required}`,
            );
        return { assetId: record.assetId, amount: required, reused: true };
    }
    const minted = await issue(required);
    if (!minted?.assetId) throw new Error("asset issuance returned no assetId");
    return { assetId: minted.assetId, amount: required, reused: false };
}

const selectAssetFreeFunding = (vtxos, minimum) =>
    [...vtxos]
        .filter(
            (coin) =>
                (coin.assets === undefined ||
                    (Array.isArray(coin.assets) && (coin.assets?.length ?? 0) === 0)) &&
                BigInt(coin.value) >= minimum,
        )
        .sort((left, right) => {
            const valueDifference = BigInt(left.value) - BigInt(right.value);
            if (valueDifference !== 0n) return valueDifference < 0n ? -1 : 1;
            return `${left.txid}:${left.vout}`.localeCompare(`${right.txid}:${right.vout}`);
        })[0];

export async function ensureAssetFreeFunding({
    minimum,
    list,
    fund,
    timeoutMs = 60_000,
    intervalMs = 500,
}) {
    if (typeof minimum !== "bigint" || minimum <= 0n)
        throw new Error("asset-free funding minimum must be a positive bigint");
    const spendableFilter = { withRecoverable: false };
    const existing = selectAssetFreeFunding(await list(spendableFilter), minimum);
    if (existing) return { coin: existing, reused: true };
    await fund(minimum);
    const vtxos = await pollUntil({
        label: `indexed asset-free funding VTXO >= ${minimum}`,
        timeoutMs,
        intervalMs,
        read: () => list(spendableFilter),
        ready: (coins) => Boolean(selectAssetFreeFunding(coins, minimum)),
    });
    return { coin: selectAssetFreeFunding(vtxos, minimum), reused: false };
}

const fundingOutpoint = (coin) =>
    typeof coin?.txid === "string" &&
    /^[0-9a-f]{64}$/i.test(coin.txid) &&
    Number.isSafeInteger(coin?.vout) &&
    coin.vout >= 0
        ? `${coin.txid}:${coin.vout}`
        : undefined;

const assetCount = (coin) =>
    coin?.assets === undefined ? 0 : Array.isArray(coin.assets) ? coin.assets.length : "malformed";

const summarizeFundingInventory = (coins, baseline = new Set()) => ({
    count: Array.isArray(coins) ? coins.length : 0,
    candidates: (Array.isArray(coins) ? coins : [])
        .map((coin) => {
            const outpoint = fundingOutpoint(coin) ?? "malformed";
            let value = "malformed";
            try {
                value = BigInt(coin?.value).toString();
            } catch {
                // Keep diagnostics structural; never serialize the complete SDK coin.
            }
            return {
                outpoint,
                value,
                assetCount: assetCount(coin),
                isPreconfirmed: coin?.isPreconfirmed === true,
                isNew: outpoint !== "malformed" && !baseline.has(outpoint),
            };
        })
        .sort((left, right) => left.outpoint.localeCompare(right.outpoint))
        .slice(0, 8),
});

const selectNewAssetFreePreconfirmed = (coins, baseline, amount) => {
    const matches = (Array.isArray(coins) ? coins : []).filter((coin) => {
        const outpoint = fundingOutpoint(coin);
        if (!outpoint || baseline.has(outpoint) || coin.isPreconfirmed !== true) return false;
        if (!(
            coin.assets === undefined ||
            (Array.isArray(coin.assets) && coin.assets.length === 0)
        ))
            return false;
        try {
            return BigInt(coin.value) === amount;
        } catch {
            return false;
        }
    });
    if (matches.length > 1)
        throw new Error(
            `multiple new asset-free preconfirmed VTXOs matched exact amount ${amount}`,
        );
    return matches[0];
};

export async function acquireNewAssetFreePreconfirmed({
    amount,
    list,
    send,
    timeoutMs = 60_000,
    intervalMs = 500,
}) {
    if (typeof amount !== "bigint" || amount <= 0n)
        throw new Error("new preconfirmed funding amount must be a positive bigint");
    const spendableFilter = { withRecoverable: false };
    const before = await list(spendableFilter);
    const baseline = new Set(
        (Array.isArray(before) ? before : []).map(fundingOutpoint).filter(Boolean),
    );
    await send(amount);
    const indexed = await pollUntil({
        label: `new indexed asset-free preconfirmed VTXO = ${amount}`,
        timeoutMs,
        intervalMs,
        read: async () => {
            const coins = await list(spendableFilter);
            return {
                coin: selectNewAssetFreePreconfirmed(coins, baseline, amount),
                observed: summarizeFundingInventory(coins, baseline),
            };
        },
        ready: ({ coin }) => Boolean(coin),
    });
    return indexed.coin;
}

const normalizeFundingTip = (tip) => {
    if (
        !Number.isSafeInteger(tip?.height) ||
        tip.height < 0 ||
        !Number.isSafeInteger(tip?.time) ||
        tip.time <= 0
    )
        throw new Error("fresh funding requires a valid live chain tip");
    return { height: tip.height, time: tip.time };
};

const hasFundingHeadroom = (coin, tip, minHeadroomBlocks, minHeadroomSeconds, requiredDomain) => {
    const hasHeight = coin.expiresAtHeight !== undefined;
    const hasTime = coin.expiresAt !== undefined;
    if (hasHeight === hasTime) return false;
    if (requiredDomain && requiredDomain !== (hasHeight ? "height" : "time")) return false;
    if (hasHeight)
        return (
            Number.isSafeInteger(coin.expiresAtHeight) &&
            coin.expiresAtHeight > 0 &&
            BigInt(coin.expiresAtHeight) - BigInt(tip.height) >= minHeadroomBlocks
        );
    if (!(coin.expiresAt instanceof Date)) return false;
    const milliseconds = coin.expiresAt.getTime();
    if (!Number.isSafeInteger(milliseconds) || milliseconds <= 0 || milliseconds % 1000 !== 0)
        return false;
    const seconds = milliseconds / 1000;
    return (
        Number.isSafeInteger(seconds) && BigInt(seconds) - BigInt(tip.time) >= minHeadroomSeconds
    );
};

export function renewalFundingAmount(minimum) {
    if (typeof minimum !== "bigint" || minimum <= 0n)
        throw new Error("renewal minimum must be a positive bigint");
    return minimum + (minimum + 49n) / 50n;
}

const selectFreshAssetFreeFunding = (
    vtxos,
    tip,
    minimum,
    minHeadroomBlocks,
    minHeadroomSeconds,
    requiredDomain,
) =>
    [...vtxos]
        .filter((coin) => {
            let value;
            try {
                value = BigInt(coin.value);
            } catch {
                return false;
            }
            return (
                (coin.assets === undefined ||
                    (Array.isArray(coin.assets) && coin.assets.length === 0)) &&
                value >= minimum &&
                hasFundingHeadroom(coin, tip, minHeadroomBlocks, minHeadroomSeconds, requiredDomain)
            );
        })
        .sort((left, right) => {
            const valueDifference = BigInt(left.value) - BigInt(right.value);
            if (valueDifference !== 0n) return valueDifference < 0n ? -1 : 1;
            return `${left.txid}:${left.vout}`.localeCompare(`${right.txid}:${right.vout}`);
        })[0];

export async function ensureFreshAssetFreeFunding({
    minimum,
    minHeadroomBlocks,
    minHeadroomSeconds,
    requiredDomain,
    list,
    tip,
    renew,
    timeoutMs = 60_000,
    intervalMs = 500,
}) {
    if (typeof minimum !== "bigint" || minimum <= 0n)
        throw new Error("fresh asset-free funding minimum must be a positive bigint");
    if (typeof minHeadroomBlocks !== "bigint" || minHeadroomBlocks <= 0n)
        throw new Error("fresh funding block headroom must be a positive bigint");
    if (typeof minHeadroomSeconds !== "bigint" || minHeadroomSeconds <= 0n)
        throw new Error("fresh funding time headroom must be a positive bigint");
    if (requiredDomain !== undefined && !["height", "time"].includes(requiredDomain))
        throw new Error("fresh funding domain must be height or time");
    const spendableFilter = { withRecoverable: false };
    const read = async () => {
        const [coins, currentTip] = await Promise.all([list(spendableFilter), tip()]);
        return { coins, tip: normalizeFundingTip(currentTip) };
    };
    const existing = await read();
    const selected = selectFreshAssetFreeFunding(
        existing.coins,
        existing.tip,
        minimum,
        minHeadroomBlocks,
        minHeadroomSeconds,
        requiredDomain,
    );
    if (selected) return { coin: selected, reused: true, tip: existing.tip };
    await renew(renewalFundingAmount(minimum));
    const indexed = await pollUntil({
        label: `indexed fresh asset-free funding VTXO >= ${minimum}`,
        timeoutMs,
        intervalMs,
        read: async () => {
            const current = await read();
            return {
                coin: selectFreshAssetFreeFunding(
                    current.coins,
                    current.tip,
                    minimum,
                    minHeadroomBlocks,
                    minHeadroomSeconds,
                    requiredDomain,
                ),
                tip: current.tip,
                observed: summarizeFundingInventory(current.coins),
            };
        },
        ready: ({ coin }) => Boolean(coin),
    });
    return {
        coin: indexed.coin,
        reused: false,
        tip: indexed.tip,
    };
}

export async function captureOwnedTaxiLogs({
    container,
    project,
    knownSecrets = [],
    inspect,
    readLogs,
}) {
    const owner = String(await inspect(container)).trim();
    if (owner !== project) throw new Error(`Taxi log ownership mismatch for ${container}`);
    const result = await readLogs(container);
    const raw = `stdout:\n${String(result.stdout ?? "").trim()}\nstderr:\n${String(result.stderr ?? "").trim()}\n`;
    const safe = redactSecrets(raw, knownSecrets);
    assertArtifactSafe({ logs: safe }, knownSecrets);
    return safe;
}

export function taxiLogArgs(container) {
    if (typeof container !== "string" || !/^taxi12-[a-z0-9]+-taxi$/.test(container))
        throw new Error("invalid run-scoped Taxi container name");
    return ["logs", "--timestamps", "--tail", "300", container];
}

export function redactSecrets(value, knownSecrets = [], key = "") {
    if (SECRET_KEY.test(key)) return "[REDACTED]";
    if (Array.isArray(value)) return value.map((item) => redactSecrets(item, knownSecrets));
    if (value && typeof value === "object") {
        return Object.fromEntries(
            Object.entries(value).map(([name, item]) => [
                name,
                redactSecrets(item, knownSecrets, name),
            ]),
        );
    }
    if (typeof value !== "string") return value;
    return knownSecrets.reduce(
        (text, secret) =>
            typeof secret === "string" && secret.length > 0
                ? text.replaceAll(secret, "[REDACTED]")
                : text,
        value,
    );
}

export function sanitizeError(error, knownSecrets = []) {
    const unsafe = error instanceof Error ? (error.stack ?? error.message) : String(error);
    const safe = redactSecrets(unsafe, knownSecrets);
    const sanitized = new Error(safe);
    sanitized.name = "SanitizedError";
    sanitized.stack = safe;
    return sanitized;
}

export function contextualizeFailure(error, context, knownSecrets = []) {
    const detail = error instanceof Error ? (error.stack ?? error.message) : String(error);
    return sanitizeError(
        new Error(
            `arkade-regtest ${context?.sha ?? "SHA-unresolved"} project ${context?.project ?? "project-unresolved"}: ${detail}`,
        ),
        knownSecrets,
    );
}

export function assertArtifactSafe(value, knownSecrets = []) {
    const encoded = stableJson(value);
    const unsafeKey = (item, key = "") => {
        if (SECRET_KEY.test(key)) return item !== "[REDACTED]";
        if (Array.isArray(item)) return item.some((child) => unsafeKey(child));
        if (item && typeof item === "object")
            return Object.entries(item).some(([name, child]) => unsafeKey(child, name));
        return false;
    };
    if (knownSecrets.some((secret) => secret && encoded.includes(secret)) || unsafeKey(value))
        throw new Error("artifact contains secret material");
}

export function buildStackManifest(input) {
    const manifest = redactSecrets(
        {
            schemaVersion: 1,
            startedAtUtc: input.startedAtUtc,
            regtest: input.regtest,
            sdkVersion: input.sdkVersion,
            taxi: input.taxi,
            stack: input.stack,
            images: input.images,
            fixtures: input.fixtures,
        },
        input.knownSecrets,
    );
    assertArtifactSafe(manifest, input.knownSecrets);
    return manifest;
}
