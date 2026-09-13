import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ArkAddress } from "@arkade-os/sdk";
import { SSEStreamingApi } from "hono/streaming";
import { serve } from "@hono/node-server";
import { AdvanceRepository, openDatabase, PolicyRepository } from "@arkade-taxi/db";
import { assetIdKey } from "@arkade-taxi/core";
import { assetIdToWire, bytesToHex, PROTOCOL_VERSION } from "@arkade-taxi/protocol";
import type {
    ErrorResponse,
    InfoResponse,
    LockupResponse,
    QuoteResponse,
    TransferStatusResponse,
} from "@arkade-taxi/protocol";
import { createRoutes, operationalSnapshot, type RouteDeps } from "../src/routes.js";
import { FakeLockupBuilder } from "../src/quotes.js";
import { ServiceError } from "../src/errors.js";
import { createServiceLifecycle } from "../src/lifecycle.js";
import { createApp } from "../src/server.js";
import type { SweeperStatus } from "../src/sweeper.js";
import type { ReconcilerStatus } from "../src/reconciler.js";
import {
    advance,
    config,
    emulatorKey,
    EXPIRY_HEIGHT,
    MemoryAdvances,
    NOW,
    operatorKey,
    policy as basePolicy,
    quoteBody,
    receiverKey,
    senderKey,
    serverKey,
    quoteInfrastructure,
    serverUnroll,
} from "./fixtures.js";
import type { Policy } from "@arkade-taxi/core";

const ASSET = { txid: new Uint8Array(32).fill(0xbe), groupIndex: 1 };
const STALE_AFTER = 120;

let advances: MemoryAdvances;
let lockupBuilder: FakeLockupBuilder;
let sweeperStatus: SweeperStatus;
let reconcilerStatus: ReconcilerStatus;
let clock: number;
let ids: number;

const okSweeper = (): SweeperStatus => ({
    lastTickAt: NOW,
    lastTickHeight: EXPIRY_HEIGHT,
    lastTickMedianTime: BigInt(NOW),
    recoverySubmittedTotal: 3,
    failedTotal: 0,
    lastError: null,
    lastRecoveryError: null,
    lockedCount: 2,
    recoveringCount: 1,
    lastSuccessfulObservationAt: NOW - 2,
    lastSuccessfulRecoveryAt: NOW - 1,
    nearestDeadline: {
        height: {
            advanceId: "adv-height",
            kind: "height",
            locktime: 850_000n,
            batchExpiry: 900_000n,
            remaining: 10_000n,
            severity: "eligible",
            code: "recovery_eligible",
        },
        time: null,
    },
    oldestUnsweptLocktime: { height: 850_000n, time: null },
    blockers: [],
    deadlines: [],
});

const deps = (over: Partial<Policy> = {}): RouteDeps => ({
    ...quoteInfrastructure(advances, () => basePolicy(over)),
    advances,
    config: config(),
    now: () => clock,
    randomId: () => `adv-${++ids}`,
    lockupBuilder,
    lockupSubmitter: lockupBuilder,
    sweeper: { status: () => sweeperStatus },
    reconciler: { status: () => reconcilerStatus },
    sweeperStaleAfterSeconds: STALE_AFTER,
});

const app = (over: Partial<Policy> = {}) => createRoutes(deps(over));

const receiverAddress = new ArkAddress(serverKey, receiverKey, "ark").encode();
const senderAddress = new ArkAddress(serverKey, senderKey, "ark").encode();
const claimsUrl = (path: string, receivers = [receiverAddress]) =>
    `${path}?${new URLSearchParams(receivers.map((receiver) => ["receiver", receiver]))}`;

describe("receiver claim routes", () => {
    beforeEach(() => vi.useFakeTimers());
    afterEach(() => {
        const timers = vi.getTimerCount();
        vi.restoreAllMocks();
        vi.useRealTimers();
        expect(timers).toBe(0);
    });

    it("drains a real HTTP receiver stream during service shutdown without client abort", async () => {
        vi.useRealTimers();
        vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
        const db = openDatabase(":memory:");
        const store = new AdvanceRepository(db);
        const shutdown = new AbortController();
        const client = new AbortController();
        const forced = vi.fn();
        const reads = vi.spyOn(store, "byReceiverKeys");
        const router = createApp({
            ...deps(),
            advances: store,
            policy: new PolicyRepository(db),
            sweeperIntervalMs: 1_000,
            sweeperRunning: () => true,
            rescan: async () => {},
            shutdownSignal: shutdown.signal,
        });
        let server: ReturnType<typeof serve> | undefined;
        let closeServer: Promise<void> | undefined;
        let origin = "";
        let finished = false;
        let databaseClosed = false;
        const lifecycle = createServiceLifecycle({
            listen: () =>
                new Promise((resolve) => {
                    server = serve(
                        { fetch: router.fetch, hostname: "127.0.0.1", port: 0 },
                        (info) => {
                            origin = `http://127.0.0.1:${info.port}`;
                            resolve({
                                stopAccepting() {
                                    closeServer = new Promise<void>((done, reject) =>
                                        server!.close((error) => (error ? reject(error) : done())),
                                    );
                                },
                                async finished() {
                                    await closeServer;
                                    finished = true;
                                },
                            });
                        },
                    );
                }),
            verifyRuntime: async () => {},
            reconcile: async () => {},
            firstRecoveryTick: async () => {},
            startStreams: async () => {},
            startBackground() {},
            stopBackground: () => shutdown.abort(),
            stopRuntime() {},
            abort() {},
            drain: async () => {},
            disposeProviders: async () => {},
            closeDatabase() {
                db.close();
                databaseClosed = true;
            },
            shutdownTimeoutMs: 1_000,
            forceTerminate: forced,
        });
        let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
        try {
            await lifecycle.start();
            await lifecycle.refresh();
            const response = await fetch(`${origin}${claimsUrl("/v1/claims/events")}`, {
                signal: client.signal,
            });
            expect(response.status).toBe(200);
            reader = response.body!.getReader();
            expect(new TextDecoder().decode((await reader.read()).value)).toContain(
                "event: claims-snapshot",
            );
            reads.mockClear();
            await vi.advanceTimersByTimeAsync(250);
            expect(reads).toHaveBeenCalledTimes(1);
            const ended = reader.read();
            void ended.catch(() => {});
            expect(await lifecycle.stop()).toEqual({ ok: true, code: "stopped" });
            expect(await ended).toEqual({ done: true, value: undefined });
            expect(client.signal.aborted).toBe(false);
            expect(finished).toBe(true);
            expect(databaseClosed).toBe(true);
            expect(forced).not.toHaveBeenCalled();
            reads.mockClear();
            expect((await router.request(claimsUrl("/v1/claims/events"))).status).toBe(503);
            await vi.advanceTimersByTimeAsync(15_000);
            expect(reads).not.toHaveBeenCalled();
            expect(vi.getTimerCount()).toBe(0);
        } finally {
            shutdown.abort();
            client.abort();
            await reader?.cancel().catch(() => {});
            if (!closeServer) server?.close();
            await closeServer;
            if (!databaseClosed) db.close();
        }
    });

    it("returns one active snapshot for repeated and deduplicated receivers", async () => {
        advances.insert(advance({ id: "alice", receiverKey: senderKey, state: "recovering" }));
        advances.insert(advance({ id: "bob", state: "locking" }));
        advances.insert(advance({ id: "spent", state: "purchased" }));
        const reads = vi.spyOn(advances, "byReceiverKeys");
        const response = await app().request(
            claimsUrl("/v1/claims", [receiverAddress, senderAddress, receiverAddress]),
        );
        expect(response.status).toBe(200);
        expect(await response.json()).toEqual({
            claims: [
                {
                    transferId: "alice",
                    receiverAddress: senderAddress,
                    state: "recovering",
                    claimable: false,
                    updatedAt: NOW,
                },
                {
                    transferId: "bob",
                    receiverAddress,
                    state: "locking",
                    claimable: false,
                    updatedAt: NOW,
                },
            ],
        });
        expect(reads).toHaveBeenCalledTimes(1);
        expect(reads.mock.calls[0]![0]).toHaveLength(2);
    });

    it("returns an empty snapshot when the receiver has no active claims", async () => {
        advances.insert(advance({ state: "purchased" }));
        const response = await app().request(claimsUrl("/v1/claims"));
        expect(response.status).toBe(200);
        expect(await response.json()).toEqual({ claims: [] });
    });

    describe.each(["/v1/claims", "/v1/claims/events"])("%s validation", (path) => {
        it.each([
            ["no receivers", []],
            ["empty receiver", [""]],
            ["malformed receiver", ["ark1broken"]],
            ["noncanonical address", [receiverAddress.toUpperCase()]],
            ["wrong network", [new ArkAddress(serverKey, receiverKey, "tark").encode()]],
            ["wrong server", [new ArkAddress(senderKey, receiverKey, "ark").encode()]],
            [
                "more than 64 unique addresses",
                Array.from({ length: 65 }, (_, i) =>
                    new ArkAddress(serverKey, new Uint8Array(32).fill(i + 1), "ark").encode(),
                ),
            ],
        ])("rejects %s with a stable JSON error before streaming", async (_name, receivers) => {
            const response = await app().request(claimsUrl(path, receivers));
            expect(response.status).toBe(400);
            expect(response.headers.get("content-type")).toContain("application/json");
            expect(await response.json()).toMatchObject({ code: "invalid_receiver_batch" });
        });

        it("does not expose persisted invariant details", async () => {
            advances.insert(advance({ unsignedLockupTx: "private invariant detail" }));
            const response = await app().request(claimsUrl(path));
            expect(response.status).toBe(500);
            expect(await response.json()).toEqual({
                code: "internal_error",
                error: "internal error",
            });
        });
    });

    it("immediately snapshots a locked claim, batches changes and includes its terminal transition", async () => {
        const quote = (await (await post("/v1/transfers", quoteBody())).json()) as QuoteResponse;
        const lockup = await post(`/v1/transfers/${quote.transferId}/lockup`, {
            signedLockupTx: "signed",
        });
        expect(lockup.status).toBe(202);
        advances.update({
            ...advances.get(quote.transferId)!,
            state: "locked",
            outpoint: { txid: "cd".repeat(32), vout: 0 },
        });
        const controller = new AbortController();
        const response = await app().request(claimsUrl("/v1/claims/events"), {
            signal: controller.signal,
        });
        const reader = response.body!.getReader();
        const read = async () => new TextDecoder().decode((await reader.read()).value);
        try {
            expect(response.status).toBe(200);
            expect(response.headers.get("content-type")).toBe("text/event-stream");
            expect(await read()).toContain(
                'event: claims-snapshot\ndata: {"claims":[{"transferId":"adv-1"',
            );
            advances.update({
                ...advances.get(quote.transferId)!,
                state: "purchased",
                spentTxid: "ef".repeat(32),
            });
            advances.insert(advance({ id: "adv-2", state: "locking" }));
            const changed = read();
            await vi.advanceTimersByTimeAsync(250);
            const frame = await changed;
            expect(frame).toContain("event: claims-changed\n");
            const body = JSON.parse(frame.split("data: ")[1]!);
            expect(body.claims).toEqual([
                expect.objectContaining({
                    transferId: "adv-1",
                    state: "purchased",
                    spentTxid: "ef".repeat(32),
                    claimable: false,
                }),
                expect.objectContaining({ transferId: "adv-2", state: "locking" }),
            ]);
            expect(body.claims[0]).not.toHaveProperty("claim");
        } finally {
            controller.abort();
            await reader.cancel();
        }
    });

    it("shares one sampler across open streams and removes aborted receivers", async () => {
        const router = app();
        const a = new AbortController();
        const b = new AbortController();
        const responseA = await router.request(
            claimsUrl("/v1/claims/events", [receiverAddress, senderAddress]),
            { signal: a.signal },
        );
        const responseB = await router.request(claimsUrl("/v1/claims/events"), {
            signal: b.signal,
        });
        const readerA = responseA.body!.getReader();
        const readerB = responseB.body!.getReader();
        const reads = vi.spyOn(advances, "byReceiverKeys");
        try {
            expect(responseA.status).toBe(200);
            expect(responseB.status).toBe(200);
            await readerA.read();
            await readerB.read();
            await vi.advanceTimersByTimeAsync(250);
            expect(reads).toHaveBeenCalledTimes(1);
            expect(reads.mock.calls[0]![0]).toHaveLength(2);
            a.abort();
            await readerA.cancel();
            reads.mockClear();
            await vi.advanceTimersByTimeAsync(250);
            expect(reads).toHaveBeenCalledTimes(1);
            expect(reads.mock.calls[0]![0]).toEqual([receiverKey]);
        } finally {
            a.abort();
            b.abort();
            await readerA.cancel();
            await readerB.cancel();
        }
    });

    it("does not repeat the snapshot on an unchanged first tick", async () => {
        advances.insert(advance({ state: "locking" }));
        const controller = new AbortController();
        const response = await app().request(claimsUrl("/v1/claims/events"), {
            signal: controller.signal,
        });
        const reader = response.body!.getReader();
        try {
            expect(response.status).toBe(200);
            await reader.read();
            const frames: string[] = [];
            const next = reader
                .read()
                .then((chunk) => frames.push(new TextDecoder().decode(chunk.value)));
            await vi.advanceTimersByTimeAsync(250);
            expect(frames).toEqual([]);
            advances.update(advance({ state: "purchased" }));
            await vi.advanceTimersByTimeAsync(250);
            await next;
            expect(frames).toHaveLength(1);
            expect(frames[0]).toContain('"state":"purchased"');
        } finally {
            controller.abort();
            await reader.cancel();
        }
    });

    it("writes heartbeat comments at 15 seconds and cleans up on reader cancellation", async () => {
        const response = await app().request(claimsUrl("/v1/claims/events"));
        const reader = response.body!.getReader();
        try {
            expect(response.status).toBe(200);
            await reader.read();
            const heartbeat = reader.read();
            await vi.advanceTimersByTimeAsync(15_000);
            expect(new TextDecoder().decode((await heartbeat).value)).toBe(": heartbeat\n\n");
        } finally {
            await reader.cancel();
        }
    });

    it("does not replay pre-existing terminal history on connection", async () => {
        advances.insert(advance({ id: "history", state: "purchased" }));
        const controller = new AbortController();
        const response = await app().request(claimsUrl("/v1/claims/events"), {
            signal: controller.signal,
        });
        const reader = response.body!.getReader();
        try {
            const initial = new TextDecoder().decode((await reader.read()).value);
            expect(initial).toBe('event: claims-snapshot\ndata: {"claims":[]}\n\n');
            const frames: string[] = [];
            const next = reader
                .read()
                .then((chunk) => frames.push(new TextDecoder().decode(chunk.value)));
            await vi.advanceTimersByTimeAsync(250);
            expect(frames).toEqual([]);
            advances.insert(advance({ id: "new", state: "locking" }));
            await vi.advanceTimersByTimeAsync(250);
            await next;
            expect(frames).toHaveLength(1);
            expect(frames[0]).toContain('"transferId":"new"');
            expect(frames[0]).not.toContain('"transferId":"history"');
        } finally {
            controller.abort();
            await reader.cancel();
        }
    });

    it.each(["before request", "before initial read"])(
        "cleans up when aborted %s",
        async (when) => {
            const controller = new AbortController();
            if (when === "before request") controller.abort();
            const response = await app().request(claimsUrl("/v1/claims/events"), {
                signal: controller.signal,
            });
            controller.abort();
            expect(response.status).toBe(200);
            await vi.advanceTimersByTimeAsync(0);
            const reads = vi.spyOn(advances, "byReceiverKeys");
            await vi.advanceTimersByTimeAsync(15_000);
            expect(reads).not.toHaveBeenCalled();
            await response.body!.cancel();
        },
    );

    it("closes an established stream when a later claim cannot be projected", async () => {
        const controller = new AbortController();
        const response = await app().request(claimsUrl("/v1/claims/events"), {
            signal: controller.signal,
        });
        const reader = response.body!.getReader();
        try {
            expect(response.status).toBe(200);
            await reader.read();
            advances.insert(advance({ unsignedLockupTx: "private invariant detail" }));
            const ended = reader.read();
            await vi.advanceTimersByTimeAsync(250);
            expect(await ended).toEqual({ done: true, value: undefined });
        } finally {
            controller.abort();
            await reader.cancel();
        }
    });

    it.each(["snapshot", "change", "heartbeat"])("cleans up a failed %s write", async (stage) => {
        const controller = new AbortController();
        const fail = () =>
            vi
                .spyOn(SSEStreamingApi.prototype, "pipe")
                .mockRejectedValueOnce(new Error("private writer failure"));
        if (stage === "snapshot") fail();
        const response = await app().request(claimsUrl("/v1/claims/events"), {
            signal: controller.signal,
        });
        const reader = response.body!.getReader();
        try {
            expect(response.status).toBe(200);
            if (stage !== "snapshot") {
                await reader.read();
                fail();
                if (stage === "change") advances.insert(advance({ state: "locking" }));
            }
            const ended = reader.read();
            await vi.advanceTimersByTimeAsync(stage === "heartbeat" ? 15_000 : 250);
            expect(await ended).toEqual({ done: true, value: undefined });
            expect(vi.getTimerCount()).toBe(0);
        } finally {
            controller.abort();
            await reader.cancel();
        }
    });
});

describe("runtime admission and readiness", () => {
    it("blocks new quotes until an active collection output is verified", () => {
        const d = deps();
        d.proceeds = () => ({
            running: true,
            jobId: "collection",
            state: "settling",
            blocker: null,
            maxFeeSats: "0",
            authorizedFeeSats: "0",
            commitmentTxid: null,
        });
        const result = operationalSnapshot(d);
        expect(result.ready).toBe(false);
        expect(result.body.blockers).toContain("proceeds_collecting");
    });
    it("exposes a fee-blocked proceeds collector without hiding its authorization", () => {
        const d = deps();
        d.proceeds = () => ({
            running: false,
            jobId: null,
            state: "idle",
            blocker: "proceeds_fee_cap_exceeded",
            maxFeeSats: "0",
            authorizedFeeSats: null,
            commitmentTxid: null,
        });
        const result = operationalSnapshot(d);
        expect(result.ready).toBe(false);
        expect(result.body.blockers).toContain("proceeds_fee_cap_exceeded");
        expect(result.body.proceeds).toEqual(d.proceeds());
    });
    it.each([
        { blockers: [] },
        { blockers: ["runtime_checking"] },
        { blockers: ["runtime_stale"] },
        { blockers: ["server_identity_mismatch"] },
    ])(
        "gates readiness and quotes on provider safety $blockers during a routine stream refresh",
        async ({ blockers }) => {
            let refreshing = false;
            let enter!: () => void;
            let release!: () => void;
            const entered = new Promise<void>((resolve) => (enter = resolve));
            const gate = new Promise<void>((resolve) => (release = resolve));
            const lifecycle = createServiceLifecycle({
                listen: async () => ({ stopAccepting() {}, finished: async () => {} }),
                verifyRuntime: async () => {},
                reconcile: async () => {},
                firstRecoveryTick: async () => {},
                startStreams: async () => {
                    if (refreshing) {
                        enter();
                        await gate;
                    }
                },
                startBackground() {},
                stopBackground() {},
                stopRuntime() {},
                abort() {},
                drain: async () => {},
                disposeProviders: async () => {},
                closeDatabase() {},
                shutdownTimeoutMs: 50,
                forceTerminate() {},
            });
            const routeDeps = deps();
            const router = createRoutes({
                ...routeDeps,
                startup: lifecycle.status,
                runtime: {
                    ...routeDeps.runtime,
                    assertAdmission: routeDeps.runtime!.assertAdmission,
                    safety: () => ({ ...routeDeps.runtime!.safety(), blockers }),
                },
            });
            await lifecycle.start();
            await lifecycle.refresh();
            refreshing = true;
            const refresh = lifecycle.refresh();
            await entered;
            try {
                const ready = await router.request("/ready");
                expect(ready.status).toBe(blockers.length ? 503 : 200);
                expect((await ready.json()).blockers).toEqual(blockers);
                const quote = await router.request("/v1/transfers", {
                    method: "POST",
                    headers: { "content-type": "application/json" },
                    body: JSON.stringify(quoteBody()),
                });
                expect(quote.status).toBe(blockers.length ? 503 : 200);
                expect(advances.rows.size).toBe(blockers.length ? 0 : 1);
                expect(lockupBuilder.built).toHaveLength(blockers.length ? 0 : 1);
            } finally {
                release();
                await refresh;
            }
        },
    );

    it("denies lockup admission after a provider becomes unsafe", async () => {
        const quoteResponse = (await (
            await post("/v1/transfers", quoteBody())
        ).json()) as QuoteResponse;
        const router = createRoutes({
            ...deps(),
            runtime: {
                ...deps().runtime,
                safety: () => ({
                    checkedAt: 1000,
                    chainHeight: null,
                    chainTime: null,
                    walletSynced: false,
                    providerIdentityOk: false,
                    blockers: ["server_identity_mismatch"],
                }),
                assertAdmission: async () => {
                    throw new ServiceError("runtime_unsafe", 503, "server_identity_mismatch");
                },
            },
        });
        const response = await router.request(`/v1/transfers/${quoteResponse.transferId}/lockup`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ signedLockupTx: "signed" }),
        });
        expect(response.status).toBe(503);
        expect(advances.get(quoteResponse.transferId)?.state).toBe("quoted");
        expect(lockupBuilder.submitted).toHaveLength(0);
    });
    it("serves liveness but denies readiness and quotes while provider safety is unknown", async () => {
        const router = createRoutes({
            ...deps(),
            runtime: {
                ...deps().runtime,
                safety: () => ({
                    checkedAt: 1000,
                    chainHeight: null,
                    chainTime: null,
                    walletSynced: false,
                    providerIdentityOk: false,
                    blockers: ["runtime_unchecked"],
                }),
                assertAdmission: async () => {
                    throw new ServiceError("runtime_unsafe", 503, "runtime_unchecked");
                },
            },
        });
        expect((await router.request("/health")).status).toBe(200);
        expect((await router.request("/ready")).status).toBe(503);
        expect((await router.request("/v1/info")).status).toBe(200);
        const quote = await router.request("/v1/transfers", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(quoteBody()),
        });
        expect(quote.status).toBe(503);
        expect(advances.rows.size).toBe(0);
        expect(lockupBuilder.built).toHaveLength(0);
    });

    it("denies a previously quoted lockup before startup completes without any effect", async () => {
        const quoteResponse = (await (
            await post("/v1/transfers", quoteBody())
        ).json()) as QuoteResponse;
        const router = createRoutes({
            ...deps(),
            startup: () => ({
                phase: "reconciliation",
                complete: false,
                blocker: "startup_reconciliation_pending",
            }),
        });

        const response = await router.request(`/v1/transfers/${quoteResponse.transferId}/lockup`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ signedLockupTx: "psbt" }),
        });

        expect(response.status).toBe(503);
        expect((await response.json()) as ErrorResponse).toMatchObject({ code: "not_ready" });
        expect(advances.get(quoteResponse.transferId)?.state).toBe("quoted");
        expect(lockupBuilder.submitted).toHaveLength(0);
    });
});

const post = (path: string, body: unknown, over: Partial<Policy> = {}) =>
    app(over).request(path, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
    });

beforeEach(() => {
    advances = new MemoryAdvances();
    lockupBuilder = new FakeLockupBuilder(config(), serverUnroll);
    sweeperStatus = okSweeper();
    reconcilerStatus = { lastTickAt: NOW, locking: 0, blockers: [] };
    clock = NOW;
    ids = 0;
});

describe("GET /v1/info", () => {
    it("advertises the keys and endpoints a client needs to re-derive the address", async () => {
        const res = await app().request("/v1/info");
        expect(res.status).toBe(200);

        const body = (await res.json()) as InfoResponse;
        expect(body).toEqual({
            protocolVersion: PROTOCOL_VERSION,
            operatorKey: bytesToHex(operatorKey),
            serverKey: bytesToHex(serverKey),
            emulatorKey: bytesToHex(emulatorKey),
            arkdUrl: "https://arkd.example",
            emulatorUrl: "https://emulator.example",
            dust: "330",
            vtxoMinAmount: "10",
            assetRules: [
                {
                    assetId: null,
                    enabled: true,
                    fares: [
                        { id: "sats", currency: "sats", pricing: { kind: "flat", units: "10" } },
                    ],
                    claim: "either",
                    maxTopupSats: null,
                },
            ],
            maxPerPaymentTopupSats: "1000",
            paused: false,
        });
    });

    it("advertises no rules when the operator has stated none", async () => {
        const res = await app({ assetRules: [] }).request("/v1/info");
        expect(((await res.json()) as InfoResponse).assetRules).toEqual([]);
    });

    it("reflects a paused operator without refusing the request", async () => {
        const res = await app({ paused: true }).request("/v1/info");
        expect(res.status).toBe(200);
        expect(((await res.json()) as InfoResponse).paused).toBe(true);
    });
});

describe("POST /v1/transfers", () => {
    it("returns 200 and a quote whose amounts are decimal strings", async () => {
        const res = await post("/v1/transfers", quoteBody());
        expect(res.status).toBe(200);

        const body = (await res.json()) as QuoteResponse;
        expect(body.transferId).toBe("adv-1");
        expect(body.params.topup).toBe("330");
        expect(body.fare.units).toBe("10");
        expect(body.expiresAt).toBe(NOW + 60);
    });

    it("returns 503 with code paused when the operator is not quoting", async () => {
        const res = await post("/v1/transfers", quoteBody(), { paused: true });
        expect(res.status).toBe(503);
        expect((await res.json()) as ErrorResponse).toMatchObject({ code: "paused" });
    });

    it("returns 409 with the admission reason verbatim", async () => {
        const res = await post("/v1/transfers", quoteBody(), { maxPerPaymentTopupSats: 1n });
        expect(res.status).toBe(409);
        expect(((await res.json()) as ErrorResponse).code).toBe("topup_exceeds_max_per_payment");
    });

    it("returns 400 for a malformed body", async () => {
        const res = await post("/v1/transfers", quoteBody({ receiverKey: "nothex" }));
        expect(res.status).toBe(400);
        expect(((await res.json()) as ErrorResponse).code).toBe("invalid_request");
    });

    it("returns 400 for a body that is not JSON", async () => {
        const res = await app().request("/v1/transfers", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: "{not json",
        });
        expect(res.status).toBe(400);
        expect(((await res.json()) as ErrorResponse).code).toBe("invalid_request");
    });
});

describe("POST /v1/transfers/:id/lockup", () => {
    const quoted = async () => {
        const res = await post("/v1/transfers", quoteBody());
        return ((await res.json()) as QuoteResponse).transferId;
    };

    it("returns 202 with the candidate txid and covenant outpoint until observed", async () => {
        const id = await quoted();
        const res = await post(`/v1/transfers/${id}/lockup`, { signedLockupTx: "psbt" });

        expect(res.status).toBe(202);
        expect((await res.json()) as LockupResponse).toEqual({
            txid: lockupBuilder.outpoint.txid,
            outpoint: lockupBuilder.outpoint,
        });
    });

    it("returns 404 for an unknown transfer", async () => {
        const res = await post("/v1/transfers/nope/lockup", { signedLockupTx: "psbt" });
        expect(res.status).toBe(404);
        expect(((await res.json()) as ErrorResponse).code).toBe("not_found");
    });

    it("returns 202 for an exact duplicate while locking", async () => {
        const id = await quoted();
        await post(`/v1/transfers/${id}/lockup`, { signedLockupTx: "psbt" });

        const res = await post(`/v1/transfers/${id}/lockup`, { signedLockupTx: "psbt" });
        expect(res.status).toBe(202);
        expect(((await res.json()) as LockupResponse).outpoint).toEqual(lockupBuilder.outpoint);
    });

    it("returns 400 when signedLockupTx is missing", async () => {
        const id = await quoted();
        const res = await post(`/v1/transfers/${id}/lockup`, {});
        expect(res.status).toBe(400);
        expect(((await res.json()) as ErrorResponse).code).toBe("invalid_request");
    });

    it("returns 202 when submission is ambiguous and keeps the advance locking", async () => {
        const id = await quoted();
        lockupBuilder.failSubmit = new Error("arkd refused");

        const res = await post(`/v1/transfers/${id}/lockup`, { signedLockupTx: "psbt" });
        expect(res.status).toBe(202);
        expect(((await res.json()) as LockupResponse).outpoint).toEqual(lockupBuilder.outpoint);
        expect(advances.get(id)!.state).toBe("locking");
    });

    it("decodes a url-encoded transfer id", async () => {
        const res = await post("/v1/transfers/a%2Fb/lockup", { signedLockupTx: "psbt" });
        expect(res.status).toBe(404);
        expect(((await res.json()) as ErrorResponse).error).toMatch(/a\/b/);
    });
});

describe("GET /v1/transfers/:id", () => {
    it("reports the ledger state", async () => {
        const quote = (await (await post("/v1/transfers", quoteBody())).json()) as QuoteResponse;
        const res = await app().request(`/v1/transfers/${quote.transferId}`);

        expect(res.status).toBe(200);
        expect((await res.json()) as TransferStatusResponse).toEqual({
            transferId: quote.transferId,
            state: "quoted",
            updatedAt: NOW,
        });
    });

    it("returns 404 for an unknown transfer", async () => {
        const res = await app().request("/v1/transfers/nope");
        expect(res.status).toBe(404);
        expect(((await res.json()) as ErrorResponse).code).toBe("not_found");
    });

    it("redacts persisted failure detail while preserving safe status identifiers", async () => {
        const quote = (await (await post("/v1/transfers", quoteBody())).json()) as QuoteResponse;
        const current = advances.get(quote.transferId)!;
        const txid = "ab".repeat(32);
        advances.update({
            ...current,
            state: "locking",
            outpoint: { txid, vout: 2 },
            failureCode: "lockup_submission_ambiguous",
            failureDetail: "client_secret=never-reveal access_token=short-access-value",
        });

        const body = (await (
            await app().request(`/v1/transfers/${quote.transferId}`)
        ).json()) as TransferStatusResponse;

        expect(body).toMatchObject({
            state: "locking",
            failureCode: "lockup_submission_ambiguous",
            outpoint: { txid, vout: 2 },
        });
        expect(JSON.stringify(body)).not.toMatch(/never-reveal|short-access-value/);
        expect(body.failureDetail).toContain("[redacted]");
    });
});

describe("GET /health", () => {
    it("is 200 while the sweeper is ticking", async () => {
        const res = await app().request("/health");
        expect(res.status).toBe(200);
        expect(await res.json()).toMatchObject({
            status: "ok",
            sweeper: { lastTickAt: NOW, lastTickHeight: EXPIRY_HEIGHT.toString() },
        });
    });

    // Liveness stays 200 even when the sweeper is stale. Restarting cannot make
    // arkd reachable, so a liveness probe that fails here churns the container
    // and hides the cause; /ready carries that signal instead.
    it("stays 200 when the sweeper is stale, reporting it in the body", async () => {
        clock = NOW + STALE_AFTER + 1;
        const res = await app().request("/health");
        expect(res.status).toBe(200);
        expect(await res.json()).toMatchObject({ status: "degraded" });
    });

    it("stays 200 before the sweeper has ever ticked", async () => {
        sweeperStatus = { ...okSweeper(), lastTickAt: null, lastTickHeight: null };
        const res = await app().request("/health");
        expect(res.status).toBe(200);
        expect(await res.json()).toMatchObject({ sweeper: { lastTickAt: null } });
    });
});

describe("GET /ready", () => {
    it("is 503 without both verified chain clocks even when providers report no other blocker", async () => {
        const router = createRoutes({
            ...deps(),
            runtime: {
                ...deps().runtime,
                safety: () => ({
                    checkedAt: NOW * 1000,
                    chainHeight: null,
                    chainTime: BigInt(NOW),
                    walletSynced: true,
                    providerIdentityOk: true,
                    blockers: [],
                }),
                assertAdmission: async () => {},
            },
        });
        expect((await router.request("/ready")).status).toBe(503);
        expect((await router.request("/health")).status).toBe(200);
    });

    it("publishes tagged deadlines and blocks readiness on a critical covenant", async () => {
        sweeperStatus = {
            ...okSweeper(),
            blockers: [
                {
                    advanceId: "critical",
                    kind: "time",
                    locktime: BigInt(NOW),
                    batchExpiry: BigInt(NOW + 7_200),
                    remaining: 7_200n,
                    severity: "critical",
                    code: "recovery_deadline_critical",
                },
            ],
        };
        const response = await app().request("/ready");
        expect(response.status).toBe(503);
        expect(await response.json()).toMatchObject({
            sweeper: {
                lockedCount: 2,
                recoveringCount: 1,
                lastTickMedianTime: NOW.toString(),
                nearestDeadline: {
                    height: { kind: "height", batchExpiry: "900000" },
                    time: null,
                },
                oldestUnsweptLocktime: { height: "850000", time: null },
                blockers: [
                    {
                        advanceId: "critical",
                        kind: "time",
                        batchExpiry: String(NOW + 7_200),
                        severity: "critical",
                    },
                ],
            },
        });
        expect((await app().request("/health")).status).toBe(200);
    });

    it("publishes null remaining when the matching chain clock is unavailable", async () => {
        const unavailable = {
            ...okSweeper().nearestDeadline.height!,
            remaining: null,
            code: "chain_height_unavailable",
        };
        sweeperStatus = {
            ...okSweeper(),
            nearestDeadline: { height: unavailable, time: null },
            blockers: [unavailable],
        };
        expect(await (await app().request("/health")).json()).toMatchObject({
            sweeper: {
                nearestDeadline: { height: { remaining: null } },
                blockers: [{ remaining: null }],
            },
        });
    });

    it("is 503 before the startup reconciler has completed catch-up", async () => {
        reconcilerStatus = { lastTickAt: null, locking: 1, blockers: [] };
        const res = await app().request("/ready");
        expect(res.status).toBe(503);
        expect(await res.json()).toMatchObject({
            status: "degraded",
            reconciler: { lastTickAt: null, locking: 1 },
            reason: "the lockup reconciler has not completed a tick",
        });
    });

    it("publishes cached watcher catch-up state with the reconciler", async () => {
        reconcilerStatus = {
            lastTickAt: NOW,
            locking: 2,
            blockers: [],
            lastWatcherScanAt: NOW - 1,
            watching: 3,
        };

        const body = await (await app().request("/health")).json();

        expect(body.reconciler).toMatchObject({
            lastTickAt: NOW,
            locking: 2,
            lastWatcherScanAt: NOW - 1,
            watching: 3,
        });
    });

    it("is 503 while a proved reserved-input conflict pauses lockup admission", async () => {
        reconcilerStatus = {
            lastTickAt: NOW,
            locking: 1,
            blockers: ["reserved_input_conflict"],
        };
        const res = await app().request("/ready");
        expect(res.status).toBe(503);
        expect(await res.json()).toMatchObject({
            status: "degraded",
            reconciler: { locking: 1, blockers: ["reserved_input_conflict"] },
            reason: "reserved_input_conflict",
        });
    });

    it("is 503 once the last tick is older than the staleness bar", async () => {
        clock = NOW + STALE_AFTER + 1;
        const res = await app().request("/ready");
        expect(res.status).toBe(503);
        expect(await res.json()).toMatchObject({ status: "degraded" });
    });

    it("is 200 exactly at the staleness bar", async () => {
        clock = NOW + STALE_AFTER;
        expect((await app().request("/ready")).status).toBe(200);
    });

    it("is 503 before the sweeper has ever ticked", async () => {
        sweeperStatus = { ...okSweeper(), lastTickAt: null, lastTickHeight: null };
        const res = await app().request("/ready");
        expect(res.status).toBe(503);
        expect(await res.json()).toMatchObject({ sweeper: { lastTickAt: null } });
    });

    it("stays 200 but surfaces the last recovery failure", async () => {
        sweeperStatus = { ...okSweeper(), failedTotal: 2, lastError: "emulator unreachable" };
        const res = await app().request("/health");
        expect(res.status).toBe(200);
        expect(await res.json()).toMatchObject({
            sweeper: { lastError: "emulator unreachable", failedTotal: 2 },
        });
    });

    it("sanitizes provider metadata and recovery failures at health boundaries", async () => {
        const secret = "22".repeat(32);
        sweeperStatus = { ...okSweeper(), lastError: `signed transaction=${secret}` };
        const router = createRoutes({
            ...deps(),
            runtime: {
                ...deps().runtime,
                assertAdmission: async () => {},
                safety: () => ({
                    checkedAt: NOW,
                    chainHeight: EXPIRY_HEIGHT,
                    chainTime: BigInt(NOW),
                    walletSynced: true,
                    providerIdentityOk: true,
                    blockers: [],
                    provider: {
                        network: `seed phrase=${secret}`,
                        identityOk: true,
                        serverPubkey: "aa".repeat(32),
                        emulatorPubkey: "bb".repeat(32),
                    },
                }),
            },
        });

        const body = await (await router.request("/health")).text();

        expect(body).not.toContain(secret);
        expect(body).toContain("[redacted]");
    });
});
