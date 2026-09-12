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
    return lines.map((line) => {
        const match = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{9}Z) (.+)$/.exec(line);
        const at = match ? Date.parse(match[1]) : NaN;
        if (!Number.isFinite(at) || at < window.startedAt || at > window.endedAt)
            throw new Error("recovery log is outside its exact observation window");
        return { line, body: match[2], at };
    });
}

export function matchRecoveryEvidence(value) {
    windowOf(value);
    if (
        value.logs.project !== value.project ||
        !/^[a-f0-9]{64}$/.test(value.txid) ||
        !/^[1-9]\d*$/.test(value.locktime) ||
        !/^[1-9]\d*$/.test(value.currentBlocktime) ||
        BigInt(value.locktime) <= BigInt(value.currentBlocktime)
    )
        throw new Error("recovery evidence has different run, graph or clock bounds");
    const prefix = "Failed to submit tx to emulator: ";
    if (!(value.error instanceof Error) || !value.error.message.startsWith(prefix))
        throw new Error("missing public emulator refusal");
    const response = JSON.parse(value.error.message.slice(prefix.length));
    if (
        response.code !== 13 ||
        response.message !== "internal error" ||
        Object.keys(response).some((key) => !["code", "message", "details"].includes(key)) ||
        (response.details !== undefined &&
            (!Array.isArray(response.details) || response.details.length))
    )
        throw new Error("unexpected public emulator error classification");

    const emulator = records(value.logs.emulator, value);
    const arkd = records(value.logs.arkd, value);
    const emuErrors = emulator.filter(
        ({ body }) => body.includes("level=error") || body.includes('msg="finalizing tx"'),
    );
    const submissions = arkd.filter(({ body }) =>
        body.includes("method=/ark.v1.ArkService/SubmitTx"),
    );
    const audits = arkd.filter(({ body }) => body.includes("added or updated offchain tx"));
    if ([emuErrors, submissions, audits].some((items) => items.length > 1))
        throw new Error("ambiguous recovery observation contains another transaction");
    const detail = `FORFEIT_CLOSURE_LOCKED (11): ${value.locktime} > ${value.currentBlocktime} (blocktime)`;
    if (
        emuErrors.length &&
        !emuErrors[0].body.endsWith(
            `level=error msg="failed to process transaction" error="failed to submit tx on arkd: rpc error: code = FailedPrecondition desc = ${detail}"`,
        )
    )
        throw new Error("emulator refusal is not the exact expected CLTV rejection");
    if (
        submissions.length &&
        (!submissions[0].body.includes('level=warning msg="method=/ark.v1.ArkService/SubmitTx ') ||
            !submissions[0].body.includes('metadata={\\"x-sdk-version\\":\\"emulator/v0.0.7\\"}') ||
            !submissions[0].body.endsWith(` error="${detail}"`))
    )
        throw new Error("Arkd refusal is not the exact expected emulator CLTV rejection");
    if (
        audits.length &&
        !audits[0].body.endsWith(`level=debug msg="added or updated offchain tx ${value.txid}"`)
    )
        throw new Error("recovery audit belongs to another graph");
    if (!emuErrors.length || !submissions.length || !audits.length) return undefined;
    if (audits[0].at < submissions[0].at) throw new Error("recovery audit predates the rejection");
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
        audit: audits[0].line,
    };
}

function docker(args) {
    const result = spawnSync("docker", args, {
        encoding: "utf8",
        timeout: 5000,
        maxBuffer: 2 * 1024 * 1024,
        windowsHide: true,
    });
    if (result.error || result.status !== 0) throw new Error("owned recovery log read failed");
    return result.stdout + result.stderr;
}

export function readOwnedRecoveryLogs(window, run = docker) {
    windowOf(window);
    const ids = {};
    for (const service of ["arkd", "emulator"]) {
        const id = run([
            "ps",
            "-aq",
            "--no-trunc",
            "--filter",
            `label=com.docker.compose.project=${window.project}`,
            "--filter",
            `label=com.docker.compose.service=${service}`,
        ]).trim();
        if (!/^[a-f0-9]{64}$/.test(id)) throw new Error("expected one owned recovery service");
        const inspected = JSON.parse(run(["inspect", id]));
        if (
            !Array.isArray(inspected) ||
            inspected.length !== 1 ||
            inspected[0].Id !== id ||
            !inspected[0].State?.Running
        )
            throw new Error("recovery service identity or running state changed");
        assertCleanupCandidates(inspected, { project: window.project, services: [service] });
        ids[service] = id;
    }
    return Object.fromEntries([
        ["project", window.project],
        ...Object.entries(ids).map(([service, id]) => [
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
