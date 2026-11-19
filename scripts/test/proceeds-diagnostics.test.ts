import { describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { captureProceedsDiagnostics } from "../lib/proceeds-diagnostics.mjs";

const run = async (options: Record<string, unknown>) => {
    const root = mkdtempSync(join(tmpdir(), "taxi-proceeds-diagnostics-"));
    try {
        const file = join(root, "snapshots.jsonl");
        const snapshot = await captureProceedsDiagnostics({
            adminUrl: "http://127.0.0.1:12345",
            project: "taxi12-a1b2c3d4e5f6",
            phase: "before restart",
            file,
            ...options,
        });
        return { snapshot, saved: JSON.parse(readFileSync(file, "utf8")) };
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
};

describe("proceeds diagnostics", () => {
    it("captures only bounded supported admin status fields and sanitizes details", async () => {
        const fetch = vi.fn(async (_url: URL, _options: unknown) =>
            Response.json({
                configuration: { mnemonic: "never copy" },
                exposure: { outstandingSats: "330", activeCount: 1 },
                readiness: {
                    status: "degraded",
                    blockers: ["proceeds_submission_ambiguous"],
                    proceeds: {
                        jobId: "job-one",
                        state: "quarantined",
                        blocker: 'password="do not copy" private marker',
                        mnemonic: "never copy",
                        rawPsbt: "never copy",
                    },
                },
            }),
        );
        const { snapshot, saved } = await run({ fetch, knownSecrets: ["private marker"] });
        expect(String(fetch.mock.calls[0]?.[0])).toBe("http://127.0.0.1:12345/admin/api/status");
        expect(saved).toEqual(snapshot);
        expect(snapshot.proceeds).toEqual({
            jobId: "job-one",
            state: "quarantined",
            blocker: "password=[REDACTED] [REDACTED]",
        });
        expect(JSON.stringify(saved)).not.toMatch(/never copy|do not copy|private marker|rawPsbt/);
    });

    it("bounds failed observation without changing caller readiness", async () => {
        const fetch = (_url: URL, { signal }: { signal: AbortSignal }) =>
            new Promise((_resolve, reject) => {
                signal.addEventListener("abort", () => reject(signal.reason));
            });
        const { snapshot } = await run({ fetch, timeoutMs: 20 });
        expect(snapshot.error).toBe("timeout");
        expect(snapshot.elapsedMs).toBeLessThan(1000);
    });

    it("does not retain an oversized or non-status response", async () => {
        const { saved } = await run({
            fetch: async () => new Response("x".repeat(256)),
            maxBytes: 64,
        });
        expect(saved.error).toBe("response_too_large");
        expect(saved).not.toHaveProperty("proceeds");
    });

    it("refuses remote or credential-bearing admin URLs before fetching", async () => {
        const fetch = vi.fn();
        const { saved } = await run({ adminUrl: "http://operator:secret@example.com", fetch });
        expect(saved.error).toBe("invalid_admin_url");
        expect(fetch).not.toHaveBeenCalled();
    });
});
