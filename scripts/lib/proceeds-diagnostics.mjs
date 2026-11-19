import { appendFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { assertArtifactSafe, redactSecrets } from "./harness.mjs";

const fields = (value, names) =>
    Object.fromEntries(
        names.flatMap((name) => {
            const item = value?.[name];
            if (item === null || ["number", "boolean"].includes(typeof item)) return [[name, item]];
            if (typeof item === "string")
                return [
                    [
                        name,
                        item
                            .slice(0, 4096)
                            .replace(
                                /((?:mnemonic|private.?key|privkey|secret.?key|password|seed)\s*["']?\s*[:=]\s*)(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s,;}]+)/gi,
                                "$1[REDACTED]",
                            ),
                    ],
                ];
            if (Array.isArray(item))
                return [[name, item.filter((entry) => typeof entry === "string").slice(0, 64)]];
            return [];
        }),
    );

async function boundedJson(response, maxBytes) {
    const reader = response.body?.getReader();
    if (!reader) throw new Error("missing_body");
    const chunks = [];
    let size = 0;
    while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.length;
        if (size > maxBytes) {
            await reader.cancel();
            throw new Error("response_too_large");
        }
        chunks.push(value);
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

export async function captureProceedsDiagnostics({
    adminUrl,
    project,
    phase,
    file,
    knownSecrets = [],
    fetch: fetcher = globalThis.fetch,
    timeoutMs = 2000,
    maxBytes = 65536,
}) {
    const startedAt = Date.now();
    const snapshot = { project, phase, at: startedAt };
    try {
        const url = new URL("/admin/api/status", adminUrl);
        if (
            url.protocol !== "http:" ||
            !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) ||
            url.username ||
            url.password
        )
            throw new Error("invalid_admin_url");
        const response = await fetcher(url, {
            signal: AbortSignal.timeout(timeoutMs),
            headers: { "x-taxi-operator": "e2e-diagnostics" },
        });
        snapshot.status = response.status;
        if (!response.ok) throw new Error("status_unavailable");
        const body = redactSecrets(await boundedJson(response, maxBytes), knownSecrets);
        const readiness = body.readiness;
        snapshot.proceeds = fields(readiness?.proceeds, [
            "running",
            "jobId",
            "state",
            "blocker",
            "maxFeeSats",
            "authorizedFeeSats",
            "commitmentTxid",
        ]);
        snapshot.readiness = fields(readiness, ["status", "now", "reason", "blockers"]);
        snapshot.exposure = fields(body.exposure, ["outstandingSats", "activeCount"]);
        snapshot.runtime = fields(readiness?.runtime, [
            "checkedAt",
            "chainHeight",
            "chainTime",
            "walletSynced",
            "providerIdentityOk",
            "blockers",
        ]);
        snapshot.inventory = fields(readiness?.runtime?.inventory, [
            "usableSats",
            "reservedSats",
            "usableVtxos",
            "reservedVtxos",
        ]);
    } catch (error) {
        snapshot.error = [
            "missing_body",
            "response_too_large",
            "invalid_admin_url",
            "status_unavailable",
        ].includes(error?.message)
            ? error.message
            : ["TimeoutError", "AbortError"].includes(error?.name)
              ? "timeout"
              : "request_failed";
    }
    snapshot.elapsedMs = Date.now() - startedAt;
    const safe = redactSecrets(snapshot, knownSecrets);
    try {
        assertArtifactSafe(safe, knownSecrets);
        appendFileSync(file, `${JSON.stringify(safe)}\n`);
    } catch {
        return { project, phase, at: startedAt, error: "diagnostic_write_failed" };
    }
    return safe;
}

export async function captureScenarioProceeds(phase) {
    const adminUrl = process.env.TAXI_E2E_ADMIN_URL;
    const artifacts = process.env.TAXI_E2E_ARTIFACTS;
    if (!adminUrl || !artifacts) return;
    let knownSecrets = [];
    try {
        knownSecrets = Object.values(
            JSON.parse(readFileSync(process.env.TAXI_E2E_SECRET_FILE, "utf8")),
        );
    } catch {}
    return captureProceedsDiagnostics({
        adminUrl,
        project: process.env.TAXI_E2E_PROJECT,
        phase,
        file: join(artifacts, "proceeds-diagnostics.jsonl"),
        knownSecrets,
    });
}
