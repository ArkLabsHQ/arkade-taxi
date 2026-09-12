import { describe, expect, it } from "vitest";
import { matchRecoveryEvidence, readOwnedRecoveryLogs } from "../lib/cltv-evidence.mjs";

const project = "taxi12-0123456789ab";
const txid = "81f12e37e367d35f8e98c5c07f62336e436fca546ba90f4548d5b91af34de553";
const at = Date.parse("2026-09-12T06:28:29Z");
const internal = new Error(
    'Failed to submit tx to emulator: {"code":13,"message":"internal error","details":[]}',
);
const cltv = "FORFEIT_CLOSURE_LOCKED (11): 1789280546 > 1789194383 (blocktime)";
const emulator = `2026-09-12T06:28:29.100000000Z time="2026-09-12T06:28:29Z" level=error msg="failed to process transaction" error="failed to submit tx on arkd: rpc error: code = FailedPrecondition desc = ${cltv}"`;
const arkd = `2026-09-12T06:28:29.090000000Z time="2026-09-12T06:28:29Z" level=warning msg="method=/ark.v1.ArkService/SubmitTx duration=5ms metadata={\\"x-sdk-version\\":\\"emulator/v0.0.7\\"}" error="${cltv}"`;
const audit = `2026-09-12T06:28:29.120000000Z time="2026-09-12T06:28:29Z" level=debug msg="added or updated offchain tx ${txid}"`;
const fixture = () => ({
    project,
    txid,
    locktime: "1789280546",
    currentBlocktime: "1789194383",
    startedAt: at,
    endedAt: at + 2000,
    error: internal,
    logs: { project, emulator, arkd: `${arkd}\n${audit}` },
});

describe("owned recovery rejection evidence", () => {
    it("binds the public refusal to exact owned-run graph and CLTV clocks", () => {
        expect(matchRecoveryEvidence(fixture())).toMatchObject({
            project,
            txid,
            locktime: "1789280546",
            currentBlocktime: "1789194383",
        });
    });

    it.each([
        (v: any) => {
            v.project = "arkade-regtest";
        },
        (v: any) => {
            v.logs.project = "taxi12-ffffffffffff";
        },
        (v: any) => {
            v.txid = "22".repeat(32);
        },
        (v: any) => {
            v.locktime = "1789280547";
        },
        (v: any) => {
            v.currentBlocktime = "1789194384";
        },
        (v: any) => {
            v.endedAt = v.startedAt + 10001;
        },
        (v: any) => {
            v.endedAt = v.startedAt - 1;
        },
        (v: any) => {
            v.startedAt = at + 500;
        },
        (v: any) => {
            v.error = new Error("internal error");
        },
        (v: any) => {
            v.error = new Error(
                'Failed to submit tx to emulator: {"code":3,"message":"internal error"}',
            );
        },
        (v: any) => {
            v.error = new Error(
                'Failed to submit tx to emulator: {"code":13,"message":"different error"}',
            );
        },
        (v: any) => {
            v.error = new Error(
                'Failed to submit tx to emulator: {"code":13,"message":"internal error","details":[{}]}',
            );
        },
        (v: any) => {
            v.logs.emulator = emulator.replace("(11)", "(110)");
        },
        (v: any) => {
            v.logs.arkd = v.logs.arkd.replace("(blocktime)", "(blockheight)");
        },
        (v: any) => {
            v.logs.arkd = v.logs.arkd.replace("emulator/v0.0.7", "other-client");
        },
        (v: any) => {
            v.logs.arkd += `\n${arkd}`;
        },
        (v: any) => {
            v.logs.emulator += `\n${emulator}`;
        },
        (v: any) => {
            v.logs.arkd += `\n${audit.replace(txid, "22".repeat(32))}`;
        },
        (v: any) => {
            v.logs.arkd = `${arkd}\n${audit.replace(txid, "22".repeat(32))}`;
        },
        (v: any) => {
            v.logs.emulator = "unstructured " + emulator;
        },
    ])("rejects foreign, ambiguous or incorrect evidence %#", (mutate) => {
        const value = fixture();
        mutate(value);
        expect(() => matchRecoveryEvidence(value)).toThrow();
    });

    it("waits only for absent log records, never accepts incomplete evidence", () => {
        const value = fixture();
        value.logs.arkd = arkd;
        expect(matchRecoveryEvidence(value)).toBeUndefined();
    });
});

describe("owned bounded Docker log reads", () => {
    const owned = (service: string) => ({
        Id: service === "arkd" ? "a".repeat(64) : "b".repeat(64),
        Name: `/${project}-${service}-1`,
        State: { Running: true },
        Config: {
            Labels: {
                "com.docker.compose.project": project,
                "com.docker.compose.service": service,
            },
        },
    });
    const reader = (mutate?: (value: any) => void) => {
        const calls: string[][] = [];
        const run = (args: string[]) => {
            calls.push(args);
            if (args[0] === "ps")
                return args.at(-1)!.endsWith("arkd") ? "a".repeat(64) : "b".repeat(64);
            if (args[0] === "inspect") {
                const value = owned(args[1] === "a".repeat(64) ? "arkd" : "emulator");
                mutate?.(value);
                return JSON.stringify([value]);
            }
            if (args[0] === "logs")
                return args.at(-1) === "a".repeat(64) ? `${arkd}\n${audit}` : emulator;
            throw new Error("unexpected Docker command");
        };
        return { run, calls };
    };

    it("reads only inspected exact IDs with explicit bounded timestamps and tail", () => {
        const io = reader();
        const result = readOwnedRecoveryLogs(
            { project, startedAt: at, endedAt: at + 2000 },
            io.run,
        );
        expect(matchRecoveryEvidence({ ...fixture(), logs: result })).toMatchObject({ txid });
        const reads = io.calls.filter((args) => args[0] === "logs");
        expect(reads).toHaveLength(2);
        for (const args of reads)
            expect(args.slice(0, -1)).toEqual([
                "logs",
                "--timestamps",
                "--since",
                "2026-09-12T06:28:29.000Z",
                "--until",
                "2026-09-12T06:28:31.000Z",
                "--tail",
                "1000",
            ]);
        expect(reads.map((args) => args.at(-1)).sort()).toEqual(["a".repeat(64), "b".repeat(64)]);
    });

    it.each([
        (v: any) => {
            v.Config.Labels["com.docker.compose.project"] = "arkade-regtest";
        },
        (v: any) => {
            v.Config.Labels["com.docker.compose.service"] = "bitcoin";
        },
        (v: any) => {
            v.Id = "c".repeat(64);
        },
        (v: any) => {
            v.State.Running = false;
        },
    ])("refuses log access after an ownership mismatch %#", (mutate) => {
        const io = reader(mutate);
        expect(() =>
            readOwnedRecoveryLogs({ project, startedAt: at, endedAt: at + 2000 }, io.run),
        ).toThrow();
        expect(io.calls.some((args) => args[0] === "logs")).toBe(false);
    });
});
