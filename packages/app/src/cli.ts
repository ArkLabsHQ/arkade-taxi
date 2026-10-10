#!/usr/bin/env node
import { serve } from "@hono/node-server";
import { randomUUID } from "node:crypto";
import { writeSync } from "node:fs";
import { pino } from "pino";
import {
    AdvanceRepository,
    CustodyRepository,
    openDatabase,
    PolicyRepository,
    ReservationRepository,
    ProceedsRepository,
    ReceiveQuoteRepository,
    FillRepository,
} from "@arkade-taxi/db";
import { loadConfig, resolveRuntimeConfig } from "./config.js";
import { sanitizeOperationalError, ServiceError } from "./errors.js";
import { ProductionLockupBuilder } from "./arkade/lockupBuilder.js";
import { ProductionSponsoredLockupBuilder } from "./sponsoredQuotes.js";
import { createSweeper } from "./sweeper.js";
import { createAdminApp, createApp, type ServerDeps } from "./server.js";
import { createOperatorRuntime } from "./arkade/operatorWallet.js";
import { SingleKey } from "@arkade-os/sdk";
import { advanceKind, computeReceivables } from "@arkade-taxi/core";
import { createSubmissionResumer, productionLockupSubmitter } from "./arkade/submit.js";
import { createLockupReconciler } from "./reconciler.js";
import { custodySolvencyView } from "./custody.js";
import { DelegateeClient } from "./delegatee.js";
import { createFillReconciler } from "./fillReconciler.js";
import { createSpendWatcher } from "./watcher.js";
import { assertRecoveryStartupInvariants, createRecoveryRunner } from "./arkade/recovery.js";
import { createServiceLifecycle, shutdownFatalDiagnostic } from "./lifecycle.js";
import { createProceedsCollector } from "./proceeds.js";
import { createBoarding } from "./boarding.js";
import { unionReservedOutpoints } from "./arkade/reservedOutpoints.js";

const seconds = () => Math.floor(Date.now() / 1000);

async function runServe(): Promise<void> {
    const config = await resolveRuntimeConfig(loadConfig(process.env));
    const log = pino({ level: config.logLevel });
    const timed = <T>(phase: string, work: () => Promise<T>): Promise<T> => {
        if (!log.isLevelEnabled("debug")) return work();
        const started = performance.now();
        const emit = (outcome: "start" | "ok" | "error") => {
            try {
                log.debug(
                    { phase, elapsedMs: performance.now() - started, outcome },
                    "operational phase",
                );
            } catch {}
        };
        emit("start");
        try {
            const result = work();
            void result.then(
                () => emit("ok"),
                () => emit("error"),
            );
            return result;
        } catch (error) {
            emit("error");
            throw error;
        }
    };

    const db = openDatabase(config.dbPath);
    const advances = new AdvanceRepository(db, {
        custodyWindowSeconds: Number(config.custodyWindowSeconds),
    });
    const policy = new PolicyRepository(db);
    const reservations = new ReservationRepository(db);
    const fills = new FillRepository(db);
    const receiveQuotes = new ReceiveQuoteRepository(db);
    const custody = new CustodyRepository(db);
    advances.assertExitParamsPresent();
    receiveQuotes.assertExitParamsPresent();
    assertRecoveryStartupInvariants(
        ["locking", "locked", "recovering"]
            .flatMap((state) => advances.byState(state as "locking" | "locked" | "recovering"))
            .filter((advance) => advanceKind(advance) === "covenant"),
        config,
    );
    const jobs = new ProceedsRepository(db);
    // The reconciler's own last pass, verbatim: one solvency view per tick, so
    // quoting and the operator surface never disagree about what is owed.
    const lendingGate = () => {
        const solvency = reconciler?.status().custody;
        return solvency ? { solvency } : undefined;
    };
    const runtime = createOperatorRuntime(config, db, {
        phaseLogger: log.isLevelEnabled("debug") ? log : undefined,
        reservedOutpoints: () => unionReservedOutpoints(reservations, receiveQuotes),
        // A `held` custody row binds no coin: the reclaimed coin is inventory,
        // which the SDK renews by merging. Only the coins an in-flight release
        // graph already spends are withheld from background settlement.
        heldOutpoints: () => [
            ...unionReservedOutpoints(reservations, receiveQuotes),
            ...custody.listHeldOutpoints(),
            ...(jobs.active()?.plan.inputs ?? []),
        ],
    });
    const proceeds = createProceedsCollector({
        config,
        runtime,
        advances,
        reservations,
        receiveQuotes,
        jobs,
        phaseLogger: log.isLevelEnabled("debug") ? log : undefined,
    });
    const boarding = createBoarding(runtime);
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
        onPromptComplete: () => timed("submission.reconcile", () => reconciler.tick(true)),
        onPromptError: (id, error) =>
            log.error(
                {
                    advanceId: id,
                    error: sanitizeOperationalError(error, "submission prompt failed"),
                },
                "submission prompt failed",
            ),
    });
    let reconciler: ReturnType<typeof createLockupReconciler>;
    const watcher = createSpendWatcher({
        advances,
        policy,
        indexer: runtime.providers.indexerProvider,
        config,
        now: seconds,
        tip: runtime.getChainTip,
        wallet: () => runtime.wallet,
        onPrompt: () => timed("watcher.reconcile", () => reconciler.tick()),
        onScanMetrics: (metrics) => log.debug(metrics, "watcher indexer round trips"),
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
        observed: (advance) => watcher.observedCovenant(advance.id),
        onError: (id, error) =>
            log.error(
                { advanceId: id, error: sanitizeOperationalError(error, "recovery failed") },
                "recovery failed",
            ),
        onRenewalWarning: ({ delegation, deadline }) =>
            log.warn(
                {
                    advanceId: deadline.advanceId,
                    delegation,
                    code: deadline.code,
                    remaining: deadline.remaining?.toString(),
                },
                "v2 covenant renewal is overdue",
            ),
    });
    reconciler = createLockupReconciler({
        advances,
        reservations,
        policy,
        indexer: runtime.providers.indexerProvider,
        submission,
        watcher,
        custody: {
            repo: custody,
            // One snapshot for the whole pass: the lendable figure and the coins
            // behind the per-asset view must not disagree about "now".
            solvency: async (liabilities) => {
                const safety = runtime.safety();
                // Reports coverage and raises alarms, never a gate, so it reuses
                // the runtime's window — which also brings it nearer lendableSats.
                const coins = runtime.wallet
                    ? await runtime.wallet.getSpendableVtxos({
                          ...runtime.inventoryRead,
                          withRecoverable: false,
                      })
                    : [];
                return custodySolvencyView({
                    liabilities,
                    coins,
                    lendableSats: safety.inventory?.usableSats ?? 0n,
                    receivableSats: computeReceivables(
                        ["locking", "locked", "recovering"].flatMap((state) =>
                            advances.byState(state as "locking" | "locked" | "recovering"),
                        ),
                    ),
                });
            },
            // Nothing can be waiting until the API pass wires a releaser.
            waiting: () => [],
            alarmSeconds: 7 * 86_400,
        },
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
    const fillReconciler = createFillReconciler({
        fills,
        advances,
        indexer: runtime.providers.indexerProvider,
        now: seconds,
    });

    let lifecycle: ReturnType<typeof createServiceLifecycle>;
    let running = false;
    let timer: ReturnType<typeof setInterval> | undefined;
    let watcherStop: Promise<void> | undefined;
    let closeServer: Promise<void> | undefined;
    const servers: ReturnType<typeof serve>[] = [];
    let accepting = true;
    const shutdown = new AbortController();

    const inventory = {
        getSpendableVtxos: async () => {
            if (!runtime.wallet)
                throw new ServiceError("runtime_unsafe", 503, "operator wallet unavailable");
            return runtime.wallet.getSpendableVtxos();
        },
        getLockedVtxoOutpoints: () => runtime.storage.intentRepository.getLockedVtxoOutpoints(),
    };
    // Once, before any quote; both calls are idempotent on their derived id.
    const delegatee = config.delegateeUrl
        ? await (async () => {
              const client = new DelegateeClient({ baseUrl: config.delegateeUrl! });
              const registration = await client.register();
              log.info({ ...registration }, "delegatee renewal template registered");
              return { client, registration };
          })()
        : undefined;
    const providerLimits = async () => {
        const info = await runtime.providers.arkProvider.getInfo();
        return { vtxoMaxAmount: info.vtxoMaxAmount };
    };
    const deps: ServerDeps = {
        advances,
        policy,
        config,
        runtime,
        now: seconds,
        randomId: () => randomUUID(),
        nowMs: Date.now,
        phaseLogger: log.isLevelEnabled("debug") ? log : undefined,
        reservations,
        receiveQuotes,
        lending: () => lendingGate(),
        onLendingWarning: (warnings) => {
            for (const w of warnings) {
                if (w.code === "exposure_nearing_cap")
                    log.warn(
                        { code: w.code, headroomSats: w.headroomSats.toString() },
                        "outstanding lending is nearing its cap",
                    );
                else
                    log.warn(
                        { code: w.code, coverageSats: w.coverageSats.toString() },
                        "lending dipped into custody liabilities",
                    );
            }
        },
        inventory,
        lockupBuilder: new ProductionLockupBuilder(config, runtime.getServerUnroll),
        sponsoredBuilder: new ProductionSponsoredLockupBuilder(config, runtime.getServerUnroll),
        ...(delegatee ? { delegatee } : {}),
        fill: {
            runtime,
            policy,
            fills,
            receiveQuotes,
            inventory,
            senderInventory: runtime.providers.indexerProvider,
            config,
            now: seconds,
            nowMs: () => Date.now(),
            randomId: () => randomUUID(),
            taxiIdentity: () => {
                const wallet = runtime.wallet;
                if (!wallet)
                    throw new ServiceError("runtime_unsafe", 503, "operator wallet unavailable");
                return wallet.identity;
            },
            emulator: runtime.providers.emulatorProvider,
            arkProvider: runtime.providers.arkProvider,
            providerLimits,
            getServerUnroll: runtime.getServerUnroll,
            leaseSeconds: Math.max(30, intervalSeconds * 2),
        },
        providerLimits,
        lockupSubmitter,
        onLockupClaimed: (id) => submission.prompt(id),
        getServerUnroll: runtime.getServerUnroll,
        senderInventory: runtime.providers.indexerProvider,
        sweeper,
        reconciler,
        fillReconciler,
        sweeperStaleAfterSeconds: intervalSeconds * 3,
        sweeperIntervalMs: config.reconcileIntervalMs,
        sweeperRunning: () => running,
        rescan: () => lifecycle.refresh(),
        startup: () => lifecycle.status(),
        proceeds: () => proceeds.status(),
        boarding,
        accepting: () => accepting,
        shutdownSignal: shutdown.signal,
        claimFeedLogger: log,
    };
    const app = createApp(deps);

    lifecycle = createServiceLifecycle({
        listen: async () => {
            servers.push(
                serve({ fetch: app.fetch, port: config.httpPort }, (info) =>
                    log.info({ port: info.port }, "taxi listening"),
                ),
            );
            if (config.adminPort !== undefined)
                servers.push(
                    serve({ fetch: createAdminApp(deps).fetch, port: config.adminPort }, (info) =>
                        log.info({ port: info.port }, "taxi admin listening"),
                    ),
                );
            return {
                stopAccepting() {
                    accepting = false;
                    closeServer ??= Promise.all(
                        servers.map(
                            (server) =>
                                new Promise<void>((resolve, reject) =>
                                    server.close((error) => (error ? reject(error) : resolve())),
                                ),
                        ),
                    ).then(() => {});
                },
                finished: () => closeServer ?? Promise.resolve(),
            };
        },
        verifyRuntime: async () => {
            await timed("lifecycle.verifyRuntime", () => runtime.assertRecovery());
        },
        reconcile: async () => {
            await timed("lifecycle.reconcile", () => reconciler.tick());
            await timed("lifecycle.fills", () => fillReconciler.tick());
            return {
                blockers: [...reconciler.status().blockers, ...fillReconciler.status().blockers],
            };
        },
        firstRecoveryTick: async () => {
            reservations.expireQuotes(seconds());
            receiveQuotes.expireQuotes(seconds());
            const safety = await timed("lifecycle.recoveryRuntime", () => runtime.assertRecovery());
            const result = await timed("lifecycle.sweep", () =>
                sweeper.tick(safety.chainHeight, safety.chainTime),
            );
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
            void timed("lifecycle.proceeds", () => proceeds.tick());
        },
        startStreams: () => timed("lifecycle.streams", () => watcher.start()),
        startBackground(prompt) {
            running = true;
            timer = setInterval(
                () =>
                    void timed("lifecycle.refresh", prompt).catch((error) =>
                        log.error(
                            { error: sanitizeOperationalError(error, "operational tick failed") },
                            "operational tick failed",
                        ),
                    ),
                config.reconcileIntervalMs,
            );
        },
        stopBackground() {
            shutdown.abort();
            running = false;
            if (timer) clearInterval(timer);
            timer = undefined;
        },
        stopRuntime: () => runtime.stop(),
        abort() {
            submission.stop();
            proceeds.stop();
            sweeper.stop();
            watcherStop ??= watcher.stop();
        },
        async drain() {
            await Promise.all([watcherStop, submission.drain(), proceeds.drain()]);
        },
        disposeProviders: () => timed("lifecycle.dispose", () => runtime.dispose()),
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
