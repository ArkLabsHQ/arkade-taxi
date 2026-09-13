import { afterEach, describe, expect, it, vi } from "vitest";
import { base64, hex } from "@scure/base";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import {
    arkade,
    ArkAddress,
    Extension,
    SingleKey,
    Transaction,
    type ExtendedVirtualCoin,
    type Wallet,
} from "@arkade-os/sdk";
import { DustCovenantScript } from "@arkade-taxi/covenant";
import type { Advance } from "@arkade-taxi/core";
import type { Database } from "@arkade-taxi/db";
import { createOperatorRuntime } from "../src/arkade/operatorWallet.js";
import { buildLockupEnvelope } from "../src/arkade/lockupBuilder.js";
import { decodeLockupEnvelope } from "../src/arkade/psbt.js";
import { buildRecoveryIntent } from "../src/arkade/recovery.js";
import { createServiceLifecycle } from "../src/lifecycle.js";
import type { ServerDeps } from "../src/server.js";
import { createRoutes } from "../src/routes.js";
import { arkInfo } from "./arkade/fixtures.js";
import { buildRequest, unroll } from "./arkade/lockupFixtures.js";
import { config, emulatorKey, fundingCoin, NOW, policy, quoteBody } from "./fixtures.js";

const current = vi.hoisted(() => ({ value: undefined as Harness | undefined }));
vi.mock("../src/config.js", async (original) => ({
    ...(await original<typeof import("../src/config.js")>()),
    loadConfig: () => current.value!.config,
    resolveRuntimeConfig: async () => current.value!.config,
}));
vi.mock("../src/arkade/operatorWallet.js", async (original) => {
    const actual = await original<typeof import("../src/arkade/operatorWallet.js")>();
    return {
        ...actual,
        createOperatorRuntime: (
            cfg: Parameters<typeof createOperatorRuntime>[0],
            db: Database,
            options: Parameters<typeof createOperatorRuntime>[2],
        ) => {
            const h = current.value!;
            h.db = db;
            const runtime = actual.createOperatorRuntime(cfg, db, {
                ...options,
                now: () => h.now,
                providers: h.providers,
                walletFactory: async () => {
                    if (h.failure === "key") throw new Error("operator key unavailable");
                    return h.wallet;
                },
            });
            Object.assign(runtime.providers.indexerProvider, h.indexer);
            runtime.providers.emulatorProvider.submitTx = h.submit;
            h.runtime = runtime;
            return runtime;
        },
    };
});
vi.mock("../src/server.js", async (original) => {
    const actual = await original<typeof import("../src/server.js")>();
    return {
        ...actual,
        createApp: (deps: ServerDeps) => {
            const h = current.value!;
            h.deps = deps;
            deps.policy.update(policy(), "test");
            if (h.failure === "artifact") {
                const intent = buildRecoveryIntent(h.advance, h.config);
                deps.advances.insert({
                    ...h.advance,
                    state: "recovering",
                    recoveryPhase: "prepared",
                    recoveryGraphDigest: "00".repeat(32),
                    recoveryExpectedTxid: intent.expectedTxid,
                    recoveryPreparedArkTx: intent.arkTx,
                    recoveryPreparedCheckpoints: intent.checkpoints,
                });
            } else deps.advances.insert(h.advance);
            if (h.failure === "unrelated")
                deps.advances.insert({
                    ...h.advance,
                    id: "unrelated-quarantine",
                    outpoint: { txid: "ff".repeat(32), vout: 0 },
                    failureCode: "covenant_spend_unknown",
                    failureDetail: "unrelated observation unavailable",
                });
            return actual.createApp(deps);
        },
    };
});
vi.mock("../src/watcher.js", async (original) => {
    const actual = await original<typeof import("../src/watcher.js")>();
    return {
        ...actual,
        createSpendWatcher: (deps: Parameters<typeof actual.createSpendWatcher>[0]) =>
            actual.createSpendWatcher({ ...deps, arkProvider: undefined }),
    };
});
vi.mock("../src/lifecycle.js", async (original) => {
    const actual = await original<typeof import("../src/lifecycle.js")>();
    return {
        ...actual,
        createServiceLifecycle: (deps: Parameters<typeof createServiceLifecycle>[0]) => {
            const h = current.value!;
            const lifecycle = actual.createServiceLifecycle({
                ...deps,
                listen: async () => ({ stopAccepting() {}, finished: async () => {} }),
                startBackground() {},
                stopBackground() {},
            });
            h.lifecycle = lifecycle;
            return {
                ...lifecycle,
                async start() {
                    await lifecycle.start();
                    await lifecycle.refresh();
                    h.started();
                },
            };
        },
    };
});
vi.mock("pino", () => ({ pino: () => ({ info() {}, error() {} }) }));

interface Harness {
    config: ReturnType<typeof config>;
    now: number;
    chainTime: number;
    failure?: string;
    coins: ExtendedVirtualCoin[];
    advance: Advance;
    visible: boolean;
    providerGate?: Promise<void>;
    onObservation?: () => void;
    wallet: Wallet;
    providers: NonNullable<Parameters<typeof createOperatorRuntime>[2]>["providers"];
    indexer: {
        getVtxos(options?: { outpoints?: { txid: string; vout: number }[] }): Promise<{
            vtxos: ExtendedVirtualCoin[];
        }>;
        getVirtualTxs(ids: string[]): Promise<{ txs: string[] }>;
    };
    submit(
        arkTx: string,
        checkpoints: string[],
    ): Promise<{
        signedArkTx: string;
        signedCheckpointTxs: string[];
    }>;
    submissions: number;
    started(): void;
    db?: Database;
    runtime?: ReturnType<typeof createOperatorRuntime>;
    deps?: ServerDeps;
    lifecycle?: ReturnType<typeof createServiceLifecycle>;
}

let listeners: NodeJS.SignalsListener[] = [];
afterEach(async () => {
    await current.value?.lifecycle?.stop();
    for (const signal of ["SIGINT", "SIGTERM"] as const)
        for (const listener of process.listeners(signal))
            if (!listeners.includes(listener)) process.removeListener(signal, listener);
    current.value = undefined;
    vi.useRealTimers();
    vi.restoreAllMocks();
});

async function boot(blocker = "vtxo_expiry_headroom", failure?: string, chainTime = NOW + 1) {
    vi.resetModules();
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW * 1000);
    listeners = [...process.listeners("SIGINT"), ...process.listeners("SIGTERM")];
    const cfg = config({ addressHrp: "tark" });
    const request = buildRequest();
    request.params.locktime = BigInt(NOW);
    request.funding.batchExpiry = { kind: "time", value: BigInt(NOW + 86400) };
    request.funding.inputs = request.funding.inputs.map((coin) => ({
        ...coin,
        expiresAtHeight: undefined,
        expiresAt: new Date((NOW + 86400) * 1000),
    }));
    request.senderInputs = request.senderInputs.map((coin) => ({
        ...coin,
        expiry: { kind: "time", value: BigInt(NOW + 86400) },
    }));
    const covenant = new DustCovenantScript({
        params: request.params,
        serverKey: cfg.serverPubkey,
        emulatorKey: cfg.emulatorPubkey,
        vtxoMinAmount: cfg.vtxoMinAmount,
    });
    request.covenantAddress = covenant.address(cfg.addressHrp, cfg.serverPubkey).encode();
    const unsignedLockupTx = buildLockupEnvelope(request, cfg, unroll);
    const envelope = decodeLockupEnvelope(unsignedLockupTx);
    const source = Transaction.fromPSBT(base64.decode(envelope.arkTx));
    const row: Advance = {
        id: request.advanceId,
        state: "locked",
        ...request.params,
        batchExpiry: request.funding.batchExpiry,
        recoveryLocktime: { kind: "time", value: BigInt(NOW) },
        operatorInputs: request.funding.inputs.map(({ txid, vout }) => ({ txid, vout })),
        unsignedLockupTx,
        unsignedLockupId: envelope.unsignedTxId,
        covenantAddress: request.covenantAddress,
        fare: request.fare,
        outpoint: { txid: source.id, vout: 0 },
        submissionPhase: "finalized",
        createdAt: NOW - 100,
        updatedAt: NOW,
        expiresAt: NOW - 40,
    };
    const txs = new Map<string, string>();
    let response: { signedArkTx: string; signedCheckpointTxs: string[] } | undefined;
    let started!: () => void;
    const startup = new Promise<void>((resolve) => (started = resolve));
    const h: Harness = {
        config: cfg,
        now: NOW * 1000,
        chainTime,
        failure,
        advance: row,
        visible: false,
        coins:
            blocker === "operator_reserve_low"
                ? []
                : [
                      fundingCoin({ value: 500000 }),
                      fundingCoin({
                          vout: 1,
                          expiresAtHeight: undefined,
                          expiresAt:
                              blocker === "vtxo_expiry_unknown"
                                  ? undefined
                                  : new Date((NOW + 86400) * 1000),
                      }),
                  ],
        providers: {
            arkProvider: {
                getInfo: async () => {
                    await h.providerGate;
                    if (h.failure === "server") throw new Error("operator unavailable");
                    return arkInfo({
                        ...(h.failure === "identity"
                            ? { signerPubkey: hex.encode(emulatorKey) }
                            : {}),
                    });
                },
            },
            emulatorProvider: {
                getInfo: async () => {
                    if (h.failure === "emulator") throw new Error("emulator unavailable");
                    return { signerPubkey: hex.encode(emulatorKey) };
                },
            },
        },
        wallet: {
            getAddress: async () =>
                new ArkAddress(cfg.serverPubkey, cfg.operatorKey, cfg.addressHrp).encode(),
            getSpendableVtxos: async () => {
                if (h.failure === "inventory") throw new Error("wallet unavailable");
                if (h.failure === "stale") h.now += cfg.reconcileIntervalMs;
                return h.coins;
            },
            getContractManager: async () => ({
                getSyncState: () => ({
                    mode: h.failure === "sync" ? "degraded" : "online",
                    lastSyncedAt: h.now,
                }),
            }),
            getProviderConnectionState: () => ({ mode: "online" }),
            onchainProvider: {
                getChainTip: async () => ({
                    height: h.failure === "height" ? NaN : 700000,
                    time: h.failure === "time" ? NaN : h.chainTime,
                    hash: "41".repeat(32),
                }),
            },
            dispose: async () => {},
        } as unknown as Wallet,
        indexer: {
            getVtxos: async (options) => {
                h.onObservation?.();
                return {
                    vtxos: options?.outpoints?.some((o) => o.txid === row.outpoint!.txid)
                        ? [
                              fundingCoin({
                                  ...row.outpoint!,
                                  value: Number(row.dust),
                                  script: hex.encode(covenant.pkScript),
                                  ...(h.visible && response
                                      ? {
                                            isSpent: true,
                                            spentBy: Transaction.fromPSBT(
                                                base64.decode(response.signedCheckpointTxs[0]!),
                                            ).id,
                                            arkTxId: Transaction.fromPSBT(
                                                base64.decode(response.signedArkTx),
                                            ).id,
                                        }
                                      : {}),
                              }),
                          ]
                        : [],
                };
            },
            getVirtualTxs: async (ids) => ({ txs: ids.flatMap((id) => txs.get(id) ?? []) }),
        },
        submissions: 0,
        submit: async (arkTx, checkpoints) => {
            h.submissions++;
            if (h.failure === "recovery") throw new Error("emulator submission failed");
            const unsigned = Transaction.fromPSBT(base64.decode(arkTx));
            const script = Extension.fromTx(unsigned).getEmulatorPacket()!.entries[0]!.script;
            const integer = (bytes: Uint8Array) => BigInt(`0x${hex.encode(bytes)}`);
            const original = integer(new Uint8Array(32).fill(5));
            const curve = secp256k1.Point.CURVE();
            const point = secp256k1.Point.BASE.multiply(original);
            const normalized = point.y & 1n ? curve.n - original : original;
            const privateKey = (normalized + integer(arkade.arkadeScriptHash(script))) % curve.n;
            const emulator = SingleKey.fromPrivateKey(
                hex.decode(privateKey.toString(16).padStart(64, "0")),
            );
            const server = SingleKey.fromPrivateKey(new Uint8Array(32).fill(4));
            const sign = async (encoded: string) => {
                let tx = await server.sign(Transaction.fromPSBT(base64.decode(encoded)), [0]);
                tx = await emulator.sign(tx, [0]);
                const signed = base64.encode(tx.toPSBT());
                txs.set(tx.id, signed);
                return signed;
            };
            response = {
                signedArkTx: await sign(arkTx),
                signedCheckpointTxs: await Promise.all(checkpoints.map(sign)),
            };
            return response;
        },
        started,
    };
    current.value = h;
    const argv = process.argv;
    process.argv = [argv[0]!, "cli", "serve"];
    try {
        await import("../src/cli.js");
        await startup;
    } finally {
        process.argv = argv;
    }
    return h;
}

async function expectAdmissionClosed(h: Harness, blocker: string, code = "runtime_unsafe") {
    const routes = createRoutes(h.deps!);
    const ready = await routes.request("/ready");
    expect(ready.status).toBe(503);
    expect((await ready.json()).blockers).toContain(blocker);
    const quote = await routes.request("/v1/transfers", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(quoteBody()),
    });
    expect(quote.status).toBe(503);
    expect(await quote.json()).toMatchObject({ code });
    expect(h.deps!.advances.byState("quoted")).toEqual([]);
}

describe("CLI recovery under admission inventory degradation", () => {
    it("recovers a verified due covenant beside an unrelated quarantined row", async () => {
        const h = await boot("vtxo_expiry_headroom", "unrelated");
        await vi.waitFor(() => expect(h.submissions).toBe(1));
        expect(h.deps!.advances.get(h.advance.id)?.recoveryPhase).toBe("submitted");
        expect(h.deps!.advances.get("unrelated-quarantine")?.state).toBe("locked");
        expect(h.lifecycle!.status().complete).toBe(false);
        h.visible = true;
        await h.lifecycle!.refresh();
        expect(h.deps!.advances.get(h.advance.id)?.state).toBe("recovered");
        expect(h.submissions).toBe(1);
    });
    it("does not retain a null sweep clock when admission refresh starts during reconciliation", async () => {
        const h = await boot("vtxo_expiry_headroom", undefined, NOW - 1);
        let release!: () => void;
        let started!: () => void;
        const entered = new Promise<void>((resolve) => (started = resolve));
        let admission: Promise<void> | undefined;
        h.onObservation = () => {
            h.onObservation = undefined;
            h.providerGate = new Promise<void>((resolve) => (release = resolve));
            admission = h.runtime!.withAdmission(async () => {});
            started();
        };
        const refresh = h.lifecycle!.refresh();
        try {
            await entered;
            await new Promise((resolve) => setTimeout(resolve, 20));
            const during = await createRoutes(h.deps!).request("/ready");
            const body = await during.json();
            expect(during.status).toBe(503);
            expect(body.runtime.blockers).toContain("runtime_checking");
            expect(body.runtime.chainTime).toBeNull();
            expect(body.sweeper.lastTickMedianTime).toBe(String(NOW - 1));
            expect(body.sweeper.blockers).toEqual([]);
        } finally {
            release();
            await admission;
            await refresh;
        }
        const ready = await createRoutes(h.deps!).request("/ready");
        expect(ready.status).toBe(200);
        expect((await ready.json()).blockers).toEqual([]);
        expect(h.submissions).toBe(0);
    });

    it.each(["vtxo_expiry_headroom", "vtxo_expiry_unknown", "operator_reserve_low"])(
        "recovers before batch expiry while %s keeps HTTP admission closed",
        async (blocker) => {
            const h = await boot(blocker);
            expect(h.runtime!.safety().blockers).toEqual([blocker]);
            expect(h.lifecycle!.status()).toEqual({
                phase: "ready",
                complete: true,
                blocker: null,
            });
            await vi.waitFor(() =>
                expect(h.deps!.advances.get(h.advance.id)).toMatchObject({
                    state: "recovering",
                    recoveryPhase: "submitted",
                }),
            );
            expect(h.submissions).toBe(1);
            expect(h.runtime!.safety().chainTime).toBe(BigInt(NOW + 1));
            expect(h.advance.batchExpiry.value - h.runtime!.safety().chainTime!).toBe(86399n);
            const recovering = await createRoutes(h.deps!).request(`/v1/transfers/${h.advance.id}`);
            expect(await recovering.json()).toMatchObject({ state: "recovering" });
            await expectAdmissionClosed(h, blocker);
            h.visible = true;
            await h.lifecycle!.refresh();
            expect(h.deps!.advances.get(h.advance.id)).toMatchObject({
                state: "recovered",
                recoveryPhase: "submitted",
                spentTxid: h.deps!.advances.get(h.advance.id)!.recoveryTxid,
            });
            const status = await createRoutes(h.deps!).request(`/v1/transfers/${h.advance.id}`);
            expect(await status.json()).toMatchObject({ state: "recovered" });
            expect(h.deps!.sweeper.status().recoverySubmittedTotal).toBe(1);
            await expectAdmissionClosed(h, blocker);
        },
    );

    it("continues recovery when a running lifecycle crosses the admission headroom boundary", async () => {
        const h = await boot("vtxo_expiry_headroom", undefined, NOW - 1);
        expect(h.lifecycle!.status().complete).toBe(true);
        expect(h.runtime!.safety().blockers).toEqual([]);
        expect((await createRoutes(h.deps!).request("/ready")).status).toBe(200);
        expect(h.deps!.advances.get(h.advance.id)?.state).toBe("locked");
        expect(h.submissions).toBe(0);
        h.chainTime = NOW + 1;

        await h.lifecycle!.refresh();

        await vi.waitFor(() =>
            expect(h.deps!.advances.get(h.advance.id)).toMatchObject({
                state: "recovering",
                recoveryPhase: "submitted",
            }),
        );
        expect(h.deps!.sweeper.status().lastTickMedianTime).toBe(BigInt(NOW + 1));
        expect(h.submissions).toBe(1);
        await expectAdmissionClosed(h, "vtxo_expiry_headroom");
    });

    it.each([
        ["identity", "server_identity_mismatch"],
        ["server", "server_unavailable"],
        ["emulator", "emulator_unavailable"],
        ["height", "chain_tip_unavailable"],
        ["time", "chain_tip_unavailable"],
        ["sync", "wallet_unsynced"],
        ["inventory", "wallet_unsynced"],
        ["key", "wallet_unavailable"],
        ["stale", "runtime_stale"],
    ])("stops recovery for a genuine %s dependency failure", async (failure, code) => {
        const h = await boot("vtxo_expiry_headroom", failure);
        expect(h.runtime!.safety().blockers).toContain(code);
        expect(h.lifecycle!.status()).toEqual({
            phase: "provider",
            complete: false,
            blocker: "startup_provider_failed",
        });
        expect(h.deps!.reconciler.status().lastTickAt).toBeNull();
        expect(h.deps!.sweeper.status().lastTickAt).toBeNull();
        expect(h.deps!.advances.get(h.advance.id)?.state).toBe("locked");
        expect(h.submissions).toBe(0);
        await expectAdmissionClosed(h, code);
    });

    it("persists and exposes recovery failure despite an admission headroom blocker", async () => {
        const h = await boot("vtxo_expiry_headroom", "recovery");
        await vi.waitFor(() =>
            expect(h.deps!.advances.get(h.advance.id)).toMatchObject({
                state: "recovering",
                recoveryPhase: "prepared",
                failureCode: "recovery_submission_ambiguous",
                recoveryAttempts: 1,
            }),
        );
        expect(h.lifecycle!.status()).toEqual({
            phase: "recovery",
            complete: false,
            blocker: "startup_recovery_failed",
        });
        expect(h.deps!.sweeper.status()).toMatchObject({
            failedTotal: 1,
            lastRecoveryError: { advanceId: h.advance.id, code: "recovery_submission_ambiguous" },
        });
        await h.lifecycle!.refresh();
        expect(h.submissions).toBe(1);
        const response = await createRoutes(h.deps!).request("/ready");
        expect((await response.json()).sweeper.lastRecoveryError).toMatchObject({
            advanceId: h.advance.id,
            code: "recovery_submission_ambiguous",
        });
        await expectAdmissionClosed(h, "vtxo_expiry_headroom");
    });

    it("keeps admission closed during backoff after inventory recovers and resumes recovery", async () => {
        const h = await boot("vtxo_expiry_headroom", "recovery");
        const failed = h.deps!.advances.get(h.advance.id)!;
        expect(failed).toMatchObject({
            state: "recovering",
            recoveryPhase: "prepared",
            failureCode: "recovery_submission_ambiguous",
            recoveryAttempts: 1,
        });
        const retryAt = failed.recoveryNextAttemptAt!;
        expect(retryAt).toBeGreaterThan(NOW + 1);
        h.coins = [fundingCoin({ value: 500000 })];
        h.failure = undefined;

        for (const at of [NOW + 1, retryAt - 1]) {
            h.now = at * 1000;
            h.chainTime = at;
            vi.setSystemTime(h.now);
            await h.lifecycle!.refresh();

            expect(h.runtime!.safety().blockers).toEqual([]);
            expect(h.lifecycle!.status().complete).toBe(true);
            expect(h.deps!.advances.get(h.advance.id)).toMatchObject({
                state: "recovering",
                recoveryPhase: "prepared",
                failureCode: "recovery_submission_ambiguous",
                recoveryAttempts: 1,
                recoveryNextAttemptAt: retryAt,
            });
            expect(h.deps!.reconciler.status().lastTickAt).toBe(at);
            expect(h.deps!.sweeper.status()).toMatchObject({
                lastTickAt: at,
                failedTotal: 1,
                lastRecoveryError: {
                    advanceId: h.advance.id,
                    code: "recovery_submission_ambiguous",
                    at: NOW,
                },
            });
            expect(h.submissions).toBe(1);
            expect(h.deps!.policy.get().paused).toBe(false);
            await expectAdmissionClosed(h, "recovery_submission_ambiguous", "not_ready");
        }

        h.now = retryAt * 1000;
        h.chainTime = retryAt;
        vi.setSystemTime(h.now);
        await h.lifecycle!.refresh();
        await vi.waitFor(() =>
            expect(h.deps!.advances.get(h.advance.id)).toMatchObject({
                state: "recovering",
                recoveryPhase: "submitted",
            }),
        );
        expect(h.deps!.advances.get(h.advance.id)?.failureCode).toBeUndefined();
        expect(h.submissions).toBe(2);
        h.visible = true;
        await h.lifecycle!.refresh();

        expect(h.deps!.advances.get(h.advance.id)?.state).toBe("recovered");
        expect(h.deps!.sweeper.status()).toMatchObject({
            blockers: [],
            recoverySubmittedTotal: 1,
            failedTotal: 1,
        });
        expect(h.deps!.policy.get().paused).toBe(false);
        expect((await createRoutes(h.deps!).request("/ready")).status).toBe(200);
    });

    it("quarantines a corrupted persisted recovery graph without submission", async () => {
        const h = await boot("vtxo_expiry_headroom", "artifact");
        expect(h.deps!.advances.get(h.advance.id)).toMatchObject({
            state: "recovering",
            recoveryPhase: "failed",
            failureCode: "recovery_artifact_invalid",
        });
        expect(h.submissions).toBe(0);
        expect(h.lifecycle!.status()).toEqual({
            phase: "recovery",
            complete: false,
            blocker: "startup_recovery_failed",
        });
        const response = await createRoutes(h.deps!).request("/ready");
        expect(response.status).toBe(503);
        expect(await response.json()).toMatchObject({
            blockers: expect.arrayContaining(["vtxo_expiry_headroom", "recovery_artifact_invalid"]),
            sweeper: {
                failedTotal: 1,
                lastRecoveryError: { advanceId: h.advance.id, code: "recovery_artifact_invalid" },
            },
        });
        await expectAdmissionClosed(h, "vtxo_expiry_headroom");
    });
});
