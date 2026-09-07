#!/usr/bin/env node
import { serve } from "@hono/node-server";
import { randomUUID } from "node:crypto";
import { pino } from "pino";
import { AdvanceRepository, openDatabase, PolicyRepository } from "@arkade-taxi/db";
import { loadConfig, resolveRuntimeConfig, ConfigError } from "./config.js";
import { ErrorCode, ServiceError } from "./errors.js";
import type { LockupBuilder, LockupBuildRequest } from "./quotes.js";
import { createSweeper, type RecoveryRunner } from "./sweeper.js";
import { createApp } from "./server.js";
import type { Advance } from "@arkade-taxi/core";

const SWEEP_INTERVAL_MS = 60_000;
/** Three missed ticks. Recovery is the only thing bounding exposure. */
const HEALTH_STALE_SECONDS = (SWEEP_INTERVAL_MS / 1000) * 3;

const seconds = () => Math.floor(Date.now() / 1000);

const pending = (what: string): never => {
    throw new ServiceError(
        ErrorCode.NotImplemented,
        503,
        `${what} is not wired to a live arkd and emulator yet`,
    );
};

/** Placeholders for the three seams that need a live stack. Each throws rather
 * than inventing a value: a fake outpoint would mark an advance `locked` that
 * holds no covenant, and the loss would only surface at recovery. */
const pendingLockupBuilder: LockupBuilder = {
    async buildUnsigned(_req: LockupBuildRequest) {
        return pending("lockup construction");
    },
    async cosignAndSubmit(_signedPsbt: string) {
        return pending("lockup submission");
    },
};

const pendingRecovery: RecoveryRunner = {
    async recover(_a: Advance) {
        return pending("covenant recovery");
    },
};

const pendingChainHeight = async (): Promise<bigint> => pending("the chain tip");

async function runServe(): Promise<void> {
    const config = await resolveRuntimeConfig(loadConfig(process.env));
    const log = pino({ level: config.logLevel });

    const db = openDatabase(config.dbPath);
    const advances = new AdvanceRepository(db);
    const policy = new PolicyRepository(db);

    const sweeper = createSweeper({
        advances,
        recovery: pendingRecovery,
        now: seconds,
        onError: (id, error) => log.error({ advanceId: id, err: error }, "recovery failed"),
    });

    const app = createApp({
        advances,
        policy,
        config,
        now: seconds,
        randomId: () => randomUUID(),
        covenantExpiry: async () => pending("the covenant VTXO expiry"),
        lockupBuilder: pendingLockupBuilder,
        sweeper,
        sweeperStaleAfterSeconds: HEALTH_STALE_SECONDS,
        sweeperIntervalMs: SWEEP_INTERVAL_MS,
        sweeperRunning: () => running,
    });

    let running = true;
    const tick = async () => {
        try {
            const result = await sweeper.tick(await pendingChainHeight());
            if (result.considered > 0) log.info(result, "sweep");
        } catch (err) {
            log.error({ err }, "sweep tick failed");
        }
    };
    void tick();
    const timer = setInterval(() => void tick(), SWEEP_INTERVAL_MS);

    const server = serve({ fetch: app.fetch, port: config.httpPort }, (info) =>
        log.info({ port: info.port }, "taxi listening"),
    );

    for (const signal of ["SIGINT", "SIGTERM"] as const) {
        process.once(signal, () => {
            running = false;
            clearInterval(timer);
            server.close(() => db.close());
        });
    }
}

const COMMANDS: Record<string, () => Promise<void>> = { serve: runServe };

const command = process.argv[2] ?? "serve";
const run = COMMANDS[command];
if (!run) {
    process.stderr.write(`usage: taxi <${Object.keys(COMMANDS).join("|")}>\n`);
    process.exit(2);
}

run().catch((err: unknown) => {
    process.stderr.write(`${err instanceof ConfigError ? err.message : String(err)}\n`);
    process.exit(1);
});
