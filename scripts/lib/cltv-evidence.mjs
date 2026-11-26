import { spawnSync } from "node:child_process";
import { assertCleanupCandidates } from "./harness.mjs";

function windowOf(value) {
    if (
        !/^taxi12-[a-f0-9]{12}$/.test(value.project) ||
        !Number.isSafeInteger(value.startedAt) ||
        !Number.isSafeInteger(value.endedAt) ||
        value.startedAt <= 0 ||
        value.endedAt <= value.startedAt ||
        value.endedAt - value.startedAt > 10000
    )
        throw new Error("invalid owned recovery observation window");
}

function records(raw, window) {
    const lines = raw.split(/\r?\n/).filter(Boolean);
    if (lines.length >= 1000) throw new Error("recovery log window may be truncated");
    const start = new Date(window.startedAt).toISOString().replace("Z", "000000Z");
    const end = new Date(window.endedAt).toISOString().replace("Z", "000000Z");
    return lines.map((line) => {
        const match = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{9}Z) (.+)$/.exec(line);
        const at = match?.[1];
        const parsed = at ? Date.parse(at) : NaN;
        if (
            !Number.isFinite(parsed) ||
            new Date(parsed).toISOString().slice(0, 23) !== at.slice(0, 23) ||
            at < start ||
            at > end
        )
            throw new Error("recovery log is outside its exact observation window");
        return { line, body: match[2], at };
    });
}

function exactInteger(text, expected) {
    if (
        typeof text !== "string" ||
        text.length > 32 ||
        !/^(?:0|[1-9]\d*)(?:\.\d+)?(?:e[+-]?\d+)?$/i.test(text)
    )
        return false;
    const [mantissa, exponent = "0"] = text.toLowerCase().split("e");
    const [whole, fraction = ""] = mantissa.split(".");
    const scale = Number(exponent) - fraction.length;
    if (Math.abs(scale) > 32) return false;
    const digits = BigInt(whole + fraction);
    const factor = 10n ** BigInt(Math.abs(scale));
    if (scale < 0 && digits % factor !== 0n) return false;
    return (scale < 0 ? digits / factor : digits * factor) === BigInt(expected);
}

export function matchRecoveryEvidence(value) {
    windowOf(value);
    if (
        value.logs.project !== value.project ||
        !/^[a-f0-9]{64}$/.test(value.txid) ||
        !/^[1-9]\d*$/.test(value.locktime) ||
        !/^[1-9]\d*$/.test(value.currentBlocktime) ||
        !/^v[0-9][0-9A-Za-z.-]*$/.test(value.emulatorSdkVersion ?? "") ||
        BigInt(value.locktime) <= BigInt(value.currentBlocktime)
    )
        throw new Error("recovery evidence has different run, graph or clock bounds");
    const prefix = "Failed to submit tx to emulator: ";
    if (!(value.error instanceof Error) || !value.error.message.startsWith(prefix))
        throw new Error("missing public emulator refusal");
    const response = JSON.parse(value.error.message.slice(prefix.length));
    const detail = `FORFEIT_CLOSURE_LOCKED (11): closure is CLTV locked, ${value.locktime} > ${value.currentBlocktime} (block time)`;
    const reason = response.details?.[0];
    if (
        response.code !== 9 ||
        response.message !== detail ||
        Object.keys(response).some((key) => !["code", "message", "details"].includes(key)) ||
        !Array.isArray(response.details) ||
        response.details.length !== 1 ||
        reason?.["@type"] !== "type.googleapis.com/ark.v1.ErrorDetails" ||
        reason?.code !== 11 ||
        reason?.name !== "FORFEIT_CLOSURE_LOCKED" ||
        reason?.message !== detail ||
        Object.keys(reason).some(
            (key) => !["@type", "code", "name", "message", "metadata"].includes(key),
        ) ||
        reason?.metadata?.type !== "time" ||
        Object.keys(reason.metadata).some(
            (key) => !["type", "locktime", "current_locktime"].includes(key),
        ) ||
        !exactInteger(reason?.metadata?.locktime, value.locktime) ||
        !exactInteger(reason?.metadata?.current_locktime, value.currentBlocktime)
    )
        throw new Error("unexpected public emulator error classification");

    const emulator = records(value.logs.emulator, value);
    const arkd = records(value.logs.arkd, value);
    const rpcSubmissions = emulator.filter(({ body }) =>
        body.includes('msg="gRPC method: /emulator.v1.EmulatorService/Submit'),
    );
    const emuErrors = emulator.filter(
        ({ body }) =>
            body.includes("level=error") ||
            body.includes(" error=") ||
            body.includes('msg="failed to process transaction"') ||
            body.includes('msg="finalizing tx"'),
    );
    const executing = emulator.filter(({ body }) => body.includes('msg="executing arkade script:'));
    const executed = emulator.filter(({ body }) => body.includes('msg="execution of '));
    const finalizers = emulator.filter(({ body }) =>
        body.includes('msg="finalizer role analysis completed"'),
    );
    const submissions = arkd.filter(({ body }) =>
        body.includes("method=/ark.v1.ArkService/SubmitTx"),
    );
    const audits = arkd.filter(({ body }) => body.includes("added or updated offchain tx"));
    if (
        [rpcSubmissions, emuErrors, submissions, executing, executed, finalizers].some(
            (items) => items.length > 1,
        ) ||
        audits.length
    )
        throw new Error("ambiguous recovery observation contains another transaction");
    if (
        rpcSubmissions.length &&
        !rpcSubmissions[0].body.endsWith(
            'level=debug msg="gRPC method: /emulator.v1.EmulatorService/SubmitTx"',
        )
    )
        throw new Error("unexpected emulator submission record");
    if (
        emuErrors.length &&
        !emuErrors[0].body.endsWith(
            `level=debug msg="failed to process transaction" error="failed to submit tx on arkd: rpc error: code = FailedPrecondition desc = ${detail}"`,
        )
    )
        throw new Error("emulator refusal is not the exact expected CLTV rejection");
    if (
        submissions.length &&
        (!submissions[0].body.includes('level=warning msg="method=/ark.v1.ArkService/SubmitTx ') ||
            // Arkd reports its own build alongside the caller, so pin by key.
            !submissions[0].body.includes(
                `\\"x-sdk-version\\":\\"emulator/${value.emulatorSdkVersion}\\"`,
            ) ||
            !submissions[0].body.endsWith(` error="${detail}"`))
    )
        throw new Error("Arkd refusal is not the exact expected emulator CLTV rejection");
    const start = executing[0]?.body.match(
        /level=debug msg="executing arkade script: ([a-f0-9]+)" ark_txid=([a-f0-9]{64}) input_index=0$/,
    );
    const finish = executed[0]?.body.match(
        /level=debug msg="execution of ([a-f0-9]+) succeeded" ark_txid=([a-f0-9]{64}) input_index=0$/,
    );
    if (
        (executing.length && (!start || start[2] !== value.txid || start[1].length % 2)) ||
        (executed.length && (!finish || finish[2] !== value.txid)) ||
        (start && finish && start[1] !== finish[1]) ||
        (finalizers.length &&
            !finalizers[0].body.endsWith(
                'level=debug msg="finalizer role analysis completed" is_finalizer=true',
            ))
    )
        throw new Error("recovery execution belongs to another graph or role");
    const ordered = [rpcSubmissions, executing, executed, finalizers, submissions, emuErrors];
    if (ordered.some((items) => !items.length)) return undefined;
    if (ordered.some((items, index) => index && items[0].at < ordered[index - 1][0].at))
        throw new Error("recovery observation has incorrect execution order");
    return {
        project: value.project,
        txid: value.txid,
        locktime: value.locktime,
        currentBlocktime: value.currentBlocktime,
        startedAt: value.startedAt,
        endedAt: value.endedAt,
        publicError: response,
        emulator: emuErrors[0].line,
        arkd: submissions[0].line,
        executionStarted: executing[0].line,
        execution: executed[0].line,
        finalizer: finalizers[0].line,
    };
}

function docker(args) {
    const result = spawnSync("docker", args, {
        encoding: "utf8",
        timeout: 5000,
        maxBuffer: 2 * 1024 * 1024,
        windowsHide: true,
    });
    if (result.error || result.status !== 0) throw new Error("owned Docker command failed");
    return result.stdout + result.stderr;
}

export function ownedServiceIds(project, services, run = docker) {
    if (!/^taxi12-[a-f0-9]{12}$/.test(project)) throw new Error("not an isolated E2E project");
    const found = {};
    for (const service of services) {
        const id = run([
            "ps",
            "-aq",
            "--no-trunc",
            "--filter",
            `label=com.docker.compose.project=${project}`,
            "--filter",
            `label=com.docker.compose.service=${service}`,
        ]).trim();
        if (!/^[a-f0-9]{64}$/.test(id)) throw new Error(`expected one owned ${service}`);
        const inspected = JSON.parse(run(["inspect", id]));
        if (!Array.isArray(inspected) || inspected.length !== 1 || inspected[0].Id !== id)
            throw new Error(`${service} identity changed`);
        assertCleanupCandidates(inspected, { project, services: [service] });
        found[service] = {
            id,
            running: inspected[0].State?.Running === true,
            paused: inspected[0].State?.Paused === true,
        };
    }
    return found;
}

// Pause, not stop: a restarted container gets a new ephemeral host port, and
// the Taxi reaches arkd and the emulator through a proxy pinned to the old one.
// Docker errors on a repeat, so a service already in that state is left alone.
export function setOwnedServices(project, services, action, run = docker) {
    if (action !== "pause" && action !== "unpause") throw new Error("unsupported service action");
    const found = ownedServiceIds(project, services, run);
    for (const { id, paused } of Object.values(found))
        if (paused !== (action === "pause")) run([action, id]);
    return found;
}

export function readOwnedRecoveryLogs(window, run = docker) {
    windowOf(window);
    const found = ownedServiceIds(window.project, ["arkd", "emulator"], run);
    if (Object.values(found).some(({ running }) => !running))
        throw new Error("recovery service is not running");
    return Object.fromEntries([
        ["project", window.project],
        ...Object.entries(found).map(([service, { id }]) => [
            service,
            run([
                "logs",
                "--timestamps",
                "--since",
                new Date(window.startedAt).toISOString(),
                "--until",
                new Date(window.endedAt).toISOString(),
                "--tail",
                "1000",
                id,
            ]),
        ]),
    ]);
}
