import { describe, expect, it } from "vitest";
import {
    matchRecoveryEvidence,
    ownedServiceIds,
    readOwnedRecoveryLogs,
    setOwnedServices,
} from "../lib/cltv-evidence.mjs";

const project = "taxi12-0123456789ab";
const labels = (owner: string, service: string) => ({
    "com.docker.compose.project": owner,
    "com.docker.compose.service": service,
});
const txid = "81f12e37e367d35f8e98c5c07f62336e436fca546ba90f4548d5b91af34de553";
const at = Date.parse("2026-09-12T06:28:29Z");
const internal = new Error(
    'Failed to submit tx to emulator: {"code":13,"message":"internal error","details":[]}',
);
const cltv =
    "FORFEIT_CLOSURE_LOCKED (11): closure is CLTV locked, 1789280546 > 1789194383 (block time)";
const refusal = {
    code: 9,
    message: cltv,
    details: [
        {
            "@type": "type.googleapis.com/ark.v1.ErrorDetails",
            code: 11,
            name: "FORFEIT_CLOSURE_LOCKED",
            message: cltv,
            metadata: {
                current_locktime: "1.789194383e+09",
                locktime: "1.789280546e+09",
                type: "time",
            },
        },
    ],
};
const publicError = (response = refusal) =>
    new Error(`Failed to submit tx to emulator: ${JSON.stringify(response)}`);
const emulator = `2026-09-12T06:28:29.100000000Z time="2026-09-12T06:28:29Z" level=debug msg="failed to process transaction" error="failed to submit tx on arkd: rpc error: code = FailedPrecondition desc = ${cltv}"`;
const arkd = `2026-09-12T06:28:29.090000000Z time="2026-09-12T06:28:29Z" level=warning msg="method=/ark.v1.ArkService/SubmitTx duration=5ms metadata={\\"x-build-version\\":\\"0.9.9\\",\\"x-sdk-version\\":\\"emulator/v0.0.10-rc.0\\"}" error="${cltv}"`;
const executing = `2026-09-12T06:28:29.010000000Z time="2026-09-12T06:28:29Z" level=debug msg="executing arkade script: 00e0" ark_txid=${txid} input_index=0`;
const executed = `2026-09-12T06:28:29.020000000Z time="2026-09-12T06:28:29Z" level=debug msg="execution of 00e0 succeeded" ark_txid=${txid} input_index=0`;
const finalizer = `2026-09-12T06:28:29.030000000Z time="2026-09-12T06:28:29Z" level=debug msg="finalizer role analysis completed" is_finalizer=true`;
const rpc = `2026-09-12T06:28:29.001000000Z time="2026-09-12T06:28:29Z" level=debug msg="gRPC method: /emulator.v1.EmulatorService/SubmitTx"`;
const emulatorLogs = `${rpc}\n${executing}\n${executed}\n${finalizer}\n${emulator}`;
const fixture = () => ({
    project,
    txid,
    emulatorSdkVersion: "v0.0.10-rc.0",
    locktime: "1789280546",
    currentBlocktime: "1789194383",
    startedAt: at,
    endedAt: at + 2000,
    error: publicError(),
    logs: { project, emulator: emulatorLogs, arkd },
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
            v.error = internal;
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
            v.logs.emulator = emulatorLogs.replace("(11)", "(110)");
        },
        (v: any) => {
            v.logs.arkd = v.logs.arkd.replace("(block time)", "(block height)");
        },
        (v: any) => {
            v.logs.arkd = v.logs.arkd.replace("emulator/v0.0.10-rc.0", "other-client");
        },
        (v: any) => {
            v.logs.arkd += `\n${arkd}`;
        },
        (v: any) => {
            v.logs.emulator += `\n${emulator}`;
        },
        (v: any) => {
            v.logs.emulator += `\n${executed.replace(txid, "22".repeat(32))}`;
        },
        (v: any) => {
            v.logs.emulator = emulatorLogs.replaceAll(txid, "22".repeat(32));
        },
        (v: any) => {
            v.logs.emulator = "unstructured " + emulatorLogs;
        },
    ])("rejects foreign, ambiguous or incorrect evidence %#", (mutate) => {
        const value = fixture();
        mutate(value);
        expect(() => matchRecoveryEvidence(value)).toThrow();
    });

    it("waits only for absent log records, never accepts incomplete evidence", () => {
        const value = fixture();
        value.logs.emulator = "";
        expect(matchRecoveryEvidence(value)).toBeUndefined();
    });

    it("accepts exact integral decimal metadata alongside Go scientific notation", () => {
        const value = fixture();
        const response = structuredClone(refusal);
        response.details[0].metadata.locktime = "1789280546.000";
        response.details[0].metadata.current_locktime = "1789194383";
        value.error = publicError(response);
        expect(matchRecoveryEvidence(value)).toMatchObject({ txid });
    });

    it.each([
        (r: any) => {
            r.code = 13;
        },
        (r: any) => {
            r.details = [];
        },
        (r: any) => {
            r.details.push(r.details[0]);
        },
        (r: any) => {
            r.details[0]["@type"] = "type.googleapis.com/other.ErrorDetails";
        },
        (r: any) => {
            r.details[0].code = 12;
        },
        (r: any) => {
            r.details[0].name = "OTHER_ERROR";
        },
        (r: any) => {
            r.details[0].message = "CLTV locked";
        },
        (r: any) => {
            r.details[0].extra = true;
        },
        (r: any) => {
            r.details[0].metadata.extra = true;
        },
        (r: any) => {
            r.details[0].metadata.type = "height";
        },
        (r: any) => {
            r.details[0].metadata.locktime = "1789280547";
        },
        (r: any) => {
            r.details[0].metadata.current_locktime = "1789194384";
        },
        (r: any) => {
            r.details[0].metadata.locktime = "1789280546.000000001";
        },
        (r: any) => {
            r.details[0].metadata.locktime = "1.789280546e+99";
        },
        (r: any) => {
            r.details[0].metadata.locktime = "NaN";
        },
    ])("rejects incorrect typed error details %#", (mutate) => {
        const value = fixture();
        const response = structuredClone(refusal);
        mutate(response);
        value.error = publicError(response);
        expect(() => matchRecoveryEvidence(value)).toThrow();
    });

    it.each([
        (v: any) => {
            v.logs.emulator = emulatorLogs.replace("input_index=0", "input_index=1");
        },
        (v: any) => {
            v.logs.emulator = emulatorLogs.replace("execution of 00e0", "execution of 00e1");
        },
        (v: any) => {
            v.logs.emulator = emulatorLogs.replace("is_finalizer=true", "is_finalizer=false");
        },
        (v: any) => {
            v.logs.emulator += `\n${finalizer}`;
        },
        (v: any) => {
            v.logs.emulator += `\n${rpc}`;
        },
        (v: any) => {
            v.logs.emulator = emulatorLogs.replace("29.020000000Z", "29.009999999Z");
        },
        (v: any) => {
            v.logs.emulator = emulatorLogs.replace("29.010000000Z", "29.020000001Z");
        },
        (v: any) => {
            v.endedAt = at + 100;
            v.logs.emulator = emulatorLogs.replace("29.100000000Z", "29.100000001Z");
        },
        (v: any) => {
            v.logs.arkd += `\n2026-09-12T06:28:29.120000000Z level=debug msg="added or updated offchain tx ${txid}"`;
        },
    ])("rejects mismatched execution and precise log ordering %#", (mutate) => {
        const value = fixture();
        mutate(value);
        expect(() => matchRecoveryEvidence(value)).toThrow();
    });

    it("rejects an unrelated debug failure or additional financial RPC in the window", () => {
        for (const extra of [
            'level=debug msg="failed to process intent" error="another typed failure"',
            'level=debug msg="gRPC method: /emulator.v1.EmulatorService/SubmitIntent"',
        ]) {
            const value = fixture();
            value.logs.emulator += `\n2026-09-12T06:28:29.120000000Z ${extra}`;
            expect(() => matchRecoveryEvidence(value)).toThrow();
        }
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
            if (args[0] === "logs") return args.at(-1) === "a".repeat(64) ? arkd : emulatorLogs;
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

it("resolves only containers this run owns", () => {
    const run = (args: string[]) =>
        args[0] === "ps"
            ? "a".repeat(64)
            : JSON.stringify([
                  {
                      Id: "a".repeat(64),
                      State: { Running: true },
                      Config: { Labels: labels(project, "arkd") },
                  },
              ]);
    expect(ownedServiceIds(project, ["arkd"], run)).toEqual({
        arkd: { id: "a".repeat(64), running: true, paused: false },
    });
    const foreign = (args: string[]) =>
        args[0] === "ps"
            ? "a".repeat(64)
            : JSON.stringify([
                  {
                      Id: "a".repeat(64),
                      State: { Running: true },
                      Config: { Labels: labels("taxi12-ffffffffffff", "arkd") },
                  },
              ]);
    expect(() => ownedServiceIds(project, ["arkd"], foreign)).toThrow();
    expect(() => ownedServiceIds("not-a-project", ["arkd"], run)).toThrow();
    const calls: string[][] = [];
    const recorded = (args: string[]) => (calls.push(args), run(args));
    setOwnedServices(project, ["arkd"], "pause", recorded);
    expect(calls.at(-1)).toEqual(["pause", "a".repeat(64)]);
    expect(() => setOwnedServices(project, ["arkd"], "rm", recorded)).toThrow();
});

it("pauses or unpauses only a service not already in that state", () => {
    for (const [paused, action, issued] of [
        [false, "unpause", false],
        [true, "pause", false],
        [true, "unpause", true],
        [false, "pause", true],
    ] as const) {
        const calls: string[][] = [];
        setOwnedServices(project, ["arkd"], action, (args: string[]) => {
            calls.push(args);
            return args[0] === "ps"
                ? "a".repeat(64)
                : JSON.stringify([
                      {
                          Id: "a".repeat(64),
                          State: { Running: true, Paused: paused },
                          Config: { Labels: labels(project, "arkd") },
                      },
                  ]);
        });
        expect(calls.some((args) => args[0] === action)).toBe(issued);
    }
});
