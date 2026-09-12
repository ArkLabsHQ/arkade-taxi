import { Hono } from "hono";
import type { Advance } from "@arkade-taxi/core";
import { AdvanceRepository, PolicyRepository, openDatabase, type Database } from "@arkade-taxi/db";
import { createAdminRouter, type SweeperStatus } from "../../src/admin/index.js";
import type { OperationalSnapshot } from "../../src/routes.js";

export const key = (b: number): Uint8Array => new Uint8Array(32).fill(b);

let seq = 0;

export function advance(over: Partial<Advance> = {}): Advance {
    seq++;
    const result: Advance = {
        id: `adv-${seq}`,
        state: "locked",
        receiverKey: key(0x11),
        senderKey: key(0x22),
        operatorKey: key(0x33),
        dust: 330n,
        topup: 300n,
        locktime: 800_000n,
        batchExpiry: { kind: "height", value: 9_223_372_036_854_775_807n },
        operatorInputs: [{ txid: "aa".repeat(32), vout: 0 }],
        unsignedLockupTx: "unsigned",
        unsignedLockupId: "bb".repeat(32),
        covenantAddress: `tark1qcovenant${seq}`,
        fare: { currency: "sats" as const, units: 0n },
        createdAt: 1_700_000_000_000 + seq,
        updatedAt: 1_700_000_000_000 + seq,
        expiresAt: 1_700_000_060_000 + seq,
        ...over,
    };
    result.recoveryLocktime ??= { kind: result.batchExpiry.kind, value: result.locktime };
    return result;
}

export const healthySweeper = (now = Date.now()): SweeperStatus => ({
    running: true,
    lastTickAt: now,
    intervalMs: 60_000,
    lastHeight: 800_123n,
    recoverySubmittedTotal: 3,
    lastError: null,
});

export interface Harness {
    db: Database;
    advances: AdvanceRepository;
    policy: PolicyRepository;
    app: Hono;
    setSweeper(patch: Partial<SweeperStatus>): void;
    json(path: string, init?: RequestInit): Promise<{ status: number; body: any }>;
    send(
        path: string,
        method: string,
        body: unknown,
        actor?: string,
    ): Promise<{ status: number; body: any }>;
}

export function harness(
    opts: {
        sweeper?: () => SweeperStatus;
        mount?: "prefix" | "root";
        rescan?: () => Promise<void>;
        operationalSnapshot?: (options?: { ignoreManualPause?: boolean }) => OperationalSnapshot;
        now?: () => number;
    } = {},
): Harness {
    const db = openDatabase(":memory:");
    const advances = new AdvanceRepository(db);
    const policy = new PolicyRepository(db);
    let sweeper = healthySweeper();

    const router = createAdminRouter({
        advances,
        policy,
        recoveryExecutionBudget: { height: 72n, time: 43_200n },
        sweeperStatus: opts.sweeper ?? (() => sweeper),
        rescan: opts.rescan ?? (async () => {}),
        operationalSnapshot:
            opts.operationalSnapshot ??
            (() =>
                ({
                    ready: true,
                    body: { blockers: [], status: "ok" },
                }) as unknown as OperationalSnapshot),
        now: opts.now ?? (() => 100),
    });

    const app = new Hono();
    if (opts.mount === "root") app.route("/", router);
    else app.route("/admin", router);

    const json = async (path: string, init?: RequestInit) => {
        const res = await app.request(path, init);
        const text = await res.text();
        try {
            return { status: res.status, body: text === "" ? null : JSON.parse(text) };
        } catch {
            return { status: res.status, body: text };
        }
    };

    return {
        db,
        advances,
        policy,
        app,
        setSweeper: (patch) => {
            sweeper = { ...sweeper, ...patch };
        },
        json,
        send: (path, method, body, actor = "test-operator") =>
            json(path, {
                method,
                headers: {
                    "content-type": "application/json",
                    "x-taxi-operator": actor,
                },
                body: JSON.stringify(body),
            }),
    };
}
