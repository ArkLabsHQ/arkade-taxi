#!/usr/bin/env node
import { serve } from "@hono/node-server";
import { randomUUID } from "node:crypto";
import { writeSync } from "node:fs";
import { pino } from "pino";
import {
    AdvanceRepository,
    openDatabase,
    PolicyRepository,
    ReservationRepository,
} from "@arkade-taxi/db";
import { loadConfig, resolveRuntimeConfig } from "./config.js";
import { sanitizeOperationalError, ServiceError } from "./errors.js";
import { ProductionLockupBuilder } from "./arkade/lockupBuilder.js";
import { createSweeper } from "./sweeper.js";
import { createApp } from "./server.js";
import { createOperatorRuntime } from "./arkade/operatorWallet.js";
import { SingleKey } from "@arkade-os/sdk";
import { createSubmissionResumer, productionLockupSubmitter } from "./arkade/submit.js";
import { createLockupReconciler } from "./reconciler.js";
import { createSpendWatcher } from "./watcher.js";
import { assertRecoveryStartupInvariants, createRecoveryRunner } from "./arkade/recovery.js";
import { createServiceLifecycle, shutdownFatalDiagnostic } from "./lifecycle.js";

const seconds = () => Math.floor(Date.now() / 1000);

async function runServe(): Promise<void> {
    const config = await resolveRuntimeConfig(loadConfig(process.env));
    const log = pino({ level: config.logLevel });

    const db = openDatabase(config.dbPath);
    const advances = new AdvanceRepository(db);
    const policy = new PolicyRepository(db);
    const reservations = new ReservationRepository(db);
    assertRecoveryStartupInvariants(
        ["locking", "locked", "recovering"].flatMap((state) =>
            advances.byState(state as "locking" | "locked" | "recovering"),
        ),
        config,
    );
    const runtime = createOperatorRuntime(config, db, {
        reservedOutpoints: () => reservations.listReservedOutpoints(),
    });
    const lockupSubmitter = productionLockupSubmitter(
        config,
        SingleKey.fromPrivateKey(config.operatorPrivkey),
        runtime.providers.arkProvider,
    );
    const submission = createSubmissionResumer({
        advances,
        submitter: lockupSubmitter,
        workerId: randomUUID(),
        now: seconds,
        leaseSeconds: Math.max(30, Math.ceil(config.reconcileIntervalMs / 1000) * 2),
        backoffSeconds: Math.max(1, Math.ceil(config.reconcileIntervalMs / 1000)),
    });
    let reconciler: ReturnType<typeof createLockupReconciler>;
    const watcher = createSpendWatcher({
        advances,
        policy,
        indexer: runtime.providers.indexerProvider,
        config,
        now: seconds,
        tip: async () => {
            if (!runtime.wallet) throw new Error("on-chain provider unavailable");
            return runtime.wallet.onchainProvider.getChainTip();
        },
        arkProvider: runtime.providers.arkProvider,
        onPrompt: () => reconciler.tick(),
    });

    const intervalSeconds = Math.max(1, Math.ceil(config.reconcileIntervalMs / 1000));
    const recovery = createRecoveryRunner({
        advances,
        emulator: runtime.providers.emulatorProvider,
        config,
        workerId: randomUUID(),
        now: seconds,
        leaseSeconds: Math.max(30, intervalSeconds * 2),
        backoffSeconds: intervalSeconds,
    });
    const sweeper = createSweeper({
        advances,
        recovery,
        now: seconds,
        config,
        policy,
        canRecover: (advance) => watcher.isRecoverable(advance.id),
        onError: (id, error) =>
            log.error(
                { advanceId: id, error: sanitizeOperationalError(error, "recovery failed") },
                "recovery failed",
            ),
    });
    reconciler = createLockupReconciler({
        advances,
        reservations,
        policy,
        indexer: runtime.providers.indexerProvider,
        submission,
        watcher,
        now: seconds,
        clock: () => {
            const safety = runtime.safety();
            const height = Number(safety.chainHeight);
            const timestamp = Number(safety.chainTime);
            if (!Number.isSafeInteger(height) || !Number.isSafeInteger(timestamp))
                throw new Error("chain clock unavailable");
            return { height, timestamp: new Date(timestamp * 1000) };
        },
    });

    let lifecycle: ReturnType<typeof createServiceLifecycle>;
    let running = false;
    let timer: ReturnType<typeof setInterval> | undefined;
    let watcherStop: Promise<void> | undefined;
    let closeServer: Promise<void> | undefined;
    let server: ReturnType<typeof serve> | undefined;
    let accepting = true;

    const app = createApp({
        advances,
        policy,
        config,
        runtime,
        now: seconds,
        randomId: () => randomUUID(),
        nowMs: Date.now,
        reservations,
        inventory: {
            getSpendableVtxos: async () => {
                if (!runtime.wallet)
                    throw new ServiceError("runtime_unsafe", 503, "operator wallet unavailable");
                return runtime.wallet.getSpendableVtxos();
            },
            getLockedVtxoOutpoints: () => runtime.storage.intentRepository.getLockedVtxoOutpoints(),
        },
        lockupBuilder: new ProductionLockupBuilder(config, runtime.getServerUnroll),
        lockupSubmitter,
        getServerUnroll: runtime.getServerUnroll,
        senderInventory: runtime.providers.indexerProvider,
        sweeper,
        reconciler,
        sweeperStaleAfterSeconds: intervalSeconds * 3,
        sweeperIntervalMs: config.reconcileIntervalMs,
        sweeperRunning: () => running,
        rescan: () => lifecycle.refresh(),
        startup: () => lifecycle.status(),
        accepting: () => accepting,
    });

    lifecycle = createServiceLifecycle({
        listen: async () => {
            server = serve({ fetch: app.fetch, port: config.httpPort }, (info) =>
                log.info({ port: info.port }, "taxi listening"),
            );
            return {
                stopAccepting() {
                    accepting = false;
                    closeServer ??= new Promise<void>((resolve, reject) =>
                        server!.close((error) => (error ? reject(error) : resolve())),
                    );
                },
                finished: () => closeServer ?? Promise.resolve(),
            };
        },
        verifyRuntime: async () => {
            await runtime.assertRecovery();
        },
        reconcile: async () => {
            await reconciler.tick();
            return reconciler.status();
        },
        firstRecoveryTick: async () => {
            reservations.expireQuotes(seconds());
            const safety = await runtime.assertRecovery();
            const result = await sweeper.tick(safety.chainHeight, safety.chainTime);
            if (result.considered > 0)
                log.info(
                    {
                        considered: result.considered,
                        recoverySubmitted: result.recoverySubmitted,
                        failed: result.failed,
                    },
                    "sweep",
                );
            if (result.failed > 0) throw new Error("recovery_tick_failed");
        },
        startStreams: () => watcher.start(),
        startBackground(prompt) {
            running = true;
            timer = setInterval(
                () =>
                    void prompt().catch((error) =>
                        log.error(
                            { error: sanitizeOperationalError(error, "operational tick failed") },
                            "operational tick failed",
                        ),
                    ),
                config.reconcileIntervalMs,
            );
        },
        stopBackground() {
            running = false;
            if (timer) clearInterval(timer);
            timer = undefined;
        },
        stopRuntime: () => runtime.stop(),
        abort() {
            submission.stop();
            sweeper.stop();
            watcherStop ??= watcher.stop();
        },
        async drain() {
            await Promise.all([watcherStop, submission.drain()]);
        },
        disposeProviders: () => runtime.dispose(),
        closeDatabase: () => db.close(),
        shutdownTimeoutMs: Math.max(5_000, intervalSeconds * 2_000),
        forceTerminate: (code, reason) => {
            writeSync(process.stderr.fd, `${shutdownFatalDiagnostic(reason)}\n`);
            process.exit(code);
        },
    });

    const stop = () => void lifecycle.stop();
    for (const signal of ["SIGINT", "SIGTERM"] as const) {
        process.once(signal, stop);
    }
    await lifecycle.start();
}

const COMMANDS: Record<string, () => Promise<void>> = { serve: runServe };

const command = process.argv[2] ?? "serve";
const run = COMMANDS[command];
if (!run) {
    process.stderr.write(`usage: taxi <${Object.keys(COMMANDS).join("|")}>\n`);
    process.exit(2);
}

run().catch((err: unknown) => {
    process.stderr.write(`${sanitizeOperationalError(err, "startup failed")}\n`);
    process.exit(1);
});
