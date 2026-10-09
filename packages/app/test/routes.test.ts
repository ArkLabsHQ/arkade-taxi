import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ArkAddress, asset } from "@arkade-os/sdk";
import { SSEStreamingApi } from "hono/streaming";
import { serve } from "@hono/node-server";
import {
    AdvanceRepository,
    openDatabase,
    PolicyRepository,
    ReceiveQuoteRepository,
    ReservationRepository,
    SwapFillRepository,
    totalExposure,
    type InsertReceiveQuoteRequest,
    type ReceiveQuote,
} from "@arkade-taxi/db";
import { assetIdKey } from "@arkade-taxi/core";
import { assetIdToWire, bytesToHex, PROTOCOL_VERSION } from "@arkade-taxi/protocol";
import type {
    ErrorResponse,
    InfoResponse,
    LockupResponse,
    QuoteResponse,
    ReceiveQuoteResponse,
    SponsoredQuoteResponse,
    SwapFillQuoteResponse,
    SwapFillStatusResponse,
    TransferStatusResponse,
} from "@arkade-taxi/protocol";
import {
    decodeClaimsChanged,
    decodeClaimsSnapshot,
    decodeInfo,
    decodeLockup,
    decodeQuote,
    decodeReceiveQuote,
    decodeSponsoredQuote,
    decodeStatus,
    decodeSwapFillQuote,
    decodeSwapFillStatus,
} from "@arkade-taxi/client";
import { openApiDocument, type Schema } from "../src/openapi.js";
import { createRoutes, operationalSnapshot, type RouteDeps } from "../src/routes.js";
import { FakeLockupBuilder } from "../src/quotes.js";
import { FakeSponsoredLockupBuilder } from "../src/sponsoredQuotes.js";
import type { SwapFillJointOps } from "../src/swapFillSubmit.js";
import { ServiceError } from "../src/errors.js";
import { createServiceLifecycle } from "../src/lifecycle.js";
import { createAdminApp, createApp, type ServerDeps } from "../src/server.js";
import { INDEX_HTML } from "../src/admin/static.js";
import { boardingView } from "./admin/fixtures.js";
import type { SweeperStatus } from "../src/sweeper.js";
import { createLockupReconciler, type ReconcilerStatus } from "../src/reconciler.js";
import { createSpendWatcher } from "../src/watcher.js";
import {
    advance,
    config,
    emulatorKey,
    EXPIRY_HEIGHT,
    fundingCoin,
    MemoryAdvances,
    NOW,
    operatorKey,
    policy as basePolicy,
    quoteBody,
    receiverKey,
    registerSenderCoin,
    runtimeSafety,
    senderKey,
    senderTree,
    serverKey,
    quoteInfrastructure,
    serverUnroll,
    signedEnvelope,
} from "./fixtures.js";
import type { Policy } from "@arkade-taxi/core";
import {
    asIndexed,
    FAKE_COVENANT_SCRIPT,
    FAKE_MAKER_SCRIPT,
    FakeSwapFillGraphBuilder,
    fakeOfferTerms,
    MemorySwapFills,
    solverCoin,
    solverTaproot,
} from "./swapFillFixtures.js";

const ASSET = { txid: new Uint8Array(32).fill(0xbe), groupIndex: 1 };
const STALE_AFTER = 120;

const submitJointStub = (): SwapFillJointOps => ({
    verifyPlan: () => true,
    signForTaxi: async (args) => args.partial,
    prepare: (args) => ({
        arkTx: args.partial.arkTx,
        checkpointTxs: [...args.partial.checkpoints],
        txid: "dd".repeat(32),
    }),
    covenantKey: () => "cc".repeat(32),
    submit: async (args) => {
        const response = await args.provider.submitTx(args.prepared.arkTx, [
            ...args.prepared.checkpointTxs,
        ]);
        return {
            txid: args.prepared.txid,
            signedArkTx: response.signedArkTx,
            signedCheckpointTxs: [...response.signedCheckpointTxs],
        };
    },
});

const submitEmulatorStub = () => ({
    submitTx: async (arkTx: string, checkpoints: string[]) => ({
        signedArkTx: arkTx,
        signedCheckpointTxs: [...checkpoints],
    }),
});

const submitIdentityStub = {
    xOnlyPublicKey: async () => operatorKey,
    sign: async (tx: unknown) => tx,
} as unknown as import("@arkade-os/sdk").Identity;

let advances: MemoryAdvances;
let lockupBuilder: FakeLockupBuilder;
let sponsoredBuilder: FakeSponsoredLockupBuilder;
let swapFills: MemorySwapFills;
let swapFillBuilder: FakeSwapFillGraphBuilder;
let receiveQuotes: MemoryReceiveQuotes;
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

const deps = (over: Partial<Policy> = {}): RouteDeps & Pick<ServerDeps, "runtime"> => ({
    ...quoteInfrastructure(advances, () => basePolicy(over)),
    advances,
    config: config(),
    now: () => clock,
    randomId: () => `adv-${++ids}`,
    lockupBuilder,
    lockupSubmitter: lockupBuilder,
    sponsoredBuilder,
    swapFills,
    receiveQuotes,
    swapFillBuilder,
    swapFillSubmit: {
        swapFills,
        taxiIdentity: () => submitIdentityStub,
        emulator: submitEmulatorStub(),
        config: config(),
        now: () => clock,
        randomId: () => `lease-${++ids}`,
        leaseSeconds: 60,
        joint: submitJointStub(),
        assertSolverAuthorised: () => {},
    },
    offerCodec: { decodeOffer: () => fakeOfferTerms() },
    sweeper: { status: () => sweeperStatus },
    reconciler: { status: () => reconcilerStatus },
    sweeperStaleAfterSeconds: STALE_AFTER,
});

const app = (over: Partial<Policy> = {}) => createRoutes(deps(over));

class MemoryReceiveQuotes {
    readonly rows = new Map<string, ReceiveQuote>();
    insert(request: InsertReceiveQuoteRequest): void {
        this.rows.set(request.quote.id, structuredClone(request.quote));
    }
    get(id: string): ReceiveQuote | undefined {
        const row = this.rows.get(id);
        return row && structuredClone(row);
    }
    bind(request: Parameters<ReceiveQuoteRepository["bind"]>[0]): void {
        const row = this.rows.get(request.quoteId);
        if (!row || row.state !== "quoted") throw new Error("receive quote is not bindable");
        this.rows.set(row.id, { ...row, state: "bound", boundFillId: request.fill.id });
        swapFills.insert(request.fill);
        advances.insert(request.advance);
    }
    expireQuotes(at: number): number {
        let count = 0;
        for (const row of this.rows.values())
            if (row.state === "quoted" && row.expiresAt <= at) {
                row.state = "expired";
                count++;
            }
        return count;
    }
    listReservedOutpoints() {
        return [...this.rows.values()]
            .filter((row) => row.state === "quoted")
            .flatMap((row) => row.operatorInputs.map(({ txid, vout }) => ({ txid, vout })));
    }
    exposureTotals() {
        const active = [...this.rows.values()].filter((row) => row.state === "quoted");
        return {
            outstandingSats: active.reduce((sum, row) => sum + row.loanSats, 0n),
            activeCount: active.length,
        };
    }
}

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

    it("wires the production application logger into background receiver sampling", async () => {
        const db = openDatabase(":memory:");
        const store = new AdvanceRepository(db);
        const shutdown = new AbortController();
        const logger = { error: vi.fn() };
        const router = createApp({
            ...deps(),
            advances: store,
            policy: new PolicyRepository(db),
            sweeperIntervalMs: 1000,
            sweeperRunning: () => true,
            rescan: async () => {},
            shutdownSignal: shutdown.signal,
            claimFeedLogger: logger,
        });
        const response = await router.request(claimsUrl("/v1/claims/events"));
        const reader = response.body!.getReader();
        try {
            expect(new TextDecoder().decode((await reader.read()).value)).toContain(
                "claims-snapshot",
            );
            vi.spyOn(store, "byReceiverKeys").mockImplementation(() => {
                throw Object.assign(new Error("private proof material"), { code: "SQLITE_FULL" });
            });
            await vi.advanceTimersByTimeAsync(250);
            expect(logger.error).toHaveBeenCalledExactlyOnceWith(
                { stage: "sampling", errorCode: "SQLITE_FULL" },
                "receiver claim feed failed",
            );
            expect(await reader.read()).toEqual({ done: true, value: undefined });
        } finally {
            shutdown.abort();
            await reader.cancel();
            db.close();
        }
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
    const collecting = () => ({
        running: true,
        jobId: "collection",
        state: "settling",
        blocker: null,
        maxFeeSats: "0",
        authorizedFeeSats: "0",
        commitmentTxid: null,
    });

    it("keeps readiness open while a collection job runs, and still reports the job", () => {
        const d = deps();
        d.proceeds = collecting;
        const result = operationalSnapshot(d);
        expect(result.ready).toBe(true);
        expect(result.body.blockers).toEqual([]);
        expect(result.body.proceeds).toEqual(collecting());
    });

    it("admits a financial POST while a collection job is in flight", async () => {
        const res = await createRoutes({ ...deps(), proceeds: collecting }).request(
            "/v1/transfers",
            {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify(quoteBody()),
            },
        );
        expect(res.status).toBe(200);
        expect(advances.rows.size).toBe(1);
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
        const signedLockupTx = await signedEnvelope(quoteResponse.unsignedLockupTx);
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
                withAdmission: async () => {
                    throw new ServiceError("runtime_unsafe", 503, "server_identity_mismatch");
                },
            },
        });
        const response = await router.request(`/v1/transfers/${quoteResponse.transferId}/lockup`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ signedLockupTx }),
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
        const signedLockupTx = await signedEnvelope(quoteResponse.unsignedLockupTx);
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
            body: JSON.stringify({ signedLockupTx }),
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
    sponsoredBuilder = new FakeSponsoredLockupBuilder(config(), serverUnroll);
    swapFills = new MemorySwapFills();
    swapFillBuilder = new FakeSwapFillGraphBuilder(FAKE_MAKER_SCRIPT, 5000n);
    receiveQuotes = new MemoryReceiveQuotes();
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
                        { id: "sats", currency: "sats", pricing: { kind: "flat", units: "0" } },
                    ],
                    claim: "either",
                    maxTopupSats: null,
                    unclaimedMode: "reclaim",
                },
            ],
            maxPerPaymentTopupSats: "1000",
            paused: false,
        });
        const publicEndpoints = createRoutes({
            ...deps(),
            config: {
                ...config(),
                publicArkdUrl: "http://localhost:7070",
                publicEmulatorUrl: "http://localhost:7073",
            },
        });
        const advertised = await (await publicEndpoints.request("/v1/info")).json();
        expect(advertised).toEqual({
            ...body,
            arkdUrl: "http://localhost:7070",
            emulatorUrl: "http://localhost:7073",
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

const receivePolicy = {
    assetRules: [
        {
            assetId: ASSET,
            enabled: true,
            fares: [
                {
                    id: "receive",
                    currency: { kind: "sats" as const },
                    pricing: { kind: "flat" as const, units: 3n },
                },
            ],
            claim: "either" as const,
            maxTopupSats: null,
        },
    ],
};

const receiveQuoteBody = () => ({
    receiverAddress,
    makerPublicKey: bytesToHex(senderKey),
    assetId: assetIdToWire(ASSET),
    fundingExpiry: { kind: "height", value: "850000" },
});

describe("receive quote routes", () => {
    it("POSTs a reserved quote and GET returns its saved state without renewing TTL", async () => {
        const response = await post("/v1/receive-quotes", receiveQuoteBody(), receivePolicy);
        expect(response.status).toBe(200);
        const created = (await response.json()) as ReceiveQuoteResponse;
        expect(created).toMatchObject({
            quoteId: "adv-1",
            state: "quoted",
            batchExpiry: { kind: "height", value: "900000" },
            inputExpiryFloor: { kind: "height", value: "850000" },
            recoveryLocktime: { kind: "time", value: String(BigInt(clock) + 8_640_000n) },
        });
        expect(advances.rows.size).toBe(0);

        clock = created.expiresAt;
        const read = await app(receivePolicy).request(`/v1/receive-quotes/${created.quoteId}`);
        expect(read.status).toBe(200);
        expect(await read.json()).toEqual({ ...created, state: "expired" });
    });
});

describe("POST /v1/transfers", () => {
    it("returns 200 and a quote whose amounts are decimal strings", async () => {
        const res = await post("/v1/transfers", quoteBody());
        expect(res.status).toBe(200);

        const body = (await res.json()) as QuoteResponse;
        expect(body.transferId).toBe("adv-1");
        expect(body.params.topup).toBe("330");
        expect(body.fare.units).toBe("0");
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

    it("quotes an exact paymentSats beside a whole-dust advance", async () => {
        const res = await post(
            "/v1/transfers",
            quoteBody({ senderSats: "1000", paymentSats: "100" }),
        );
        expect(res.status).toBe(200);
        const body = (await res.json()) as QuoteResponse;
        expect(body.params).toMatchObject({ dust: "330", topup: "330", paymentSats: "100" });
    });

    it("returns 400 invalid_request for an unsendable paymentSats", async () => {
        const res = await post(
            "/v1/transfers",
            quoteBody({ senderSats: "1000", paymentSats: "330" }),
        );
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
        const res = await post(
            `/v1/transfers/${id}/lockup`,
            { signedLockupTx: "psbt" },
            { paused: true },
        );

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

    it("returns 202 for an exact duplicate while locking and retains HTTP readiness", async () => {
        const id = await quoted();
        await post(`/v1/transfers/${id}/lockup`, { signedLockupTx: "psbt" });
        const duplicate = await post(`/v1/transfers/${id}/lockup`, { signedLockupTx: "psbt" });
        expect(duplicate.status).toBe(202);
        expect(((await duplicate.json()) as LockupResponse).outpoint).toEqual(
            lockupBuilder.outpoint,
        );
        const d = deps();
        const router = createRoutes({
            ...d,
            runtime: {
                ...d.runtime,
                safety: () => ({ ...d.runtime.safety(), blockers: ["runtime_stopped"] }),
                withAdmission: async () => {
                    throw new Error("runtime offline");
                },
            },
        });
        const res = await router.request(`/v1/transfers/${id}/lockup`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ signedLockupTx: "psbt" }),
        });
        expect(res.status).toBe(503);
        expect((await res.json()) as ErrorResponse).toMatchObject({ code: "not_ready" });
        expect(advances.get(id)?.state).toBe("locking");
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

const sponsoredBody = (over: Record<string, unknown> = {}) => {
    const txid = "ab".repeat(32);
    const vout = 2;
    registerSenderCoin(
        txid,
        vout,
        fundingCoin({
            txid,
            vout,
            value: 0,
            script: bytesToHex(senderTree.pkScript),
            expiresAtHeight: 910000,
        }),
    );
    return {
        receiverAddress,
        senderKey: bytesToHex(senderKey),
        senderSats: "0",
        senderInputs: [
            {
                txid,
                vout,
                value: "0",
                tapTree: bytesToHex(senderTree.encode()),
                spendLeaf: bytesToHex(senderTree.scripts[0]),
                expiry: { kind: "height", value: "910000" },
            },
        ],
        ...over,
    };
};

describe("sponsored direct-send routes", () => {
    it("quotes a direct payment on POST /v1/sponsored-transfers", async () => {
        const res = await post("/v1/sponsored-transfers", sponsoredBody());
        expect(res.status).toBe(200);
        const body = (await res.json()) as SponsoredQuoteResponse;
        expect(body.transferId).toBe("adv-1");
        expect(body.receiverAddress).toBe(receiverAddress);
        expect(body.params.contribution).toBe("330");
        expect(body.commitment.paymentOutputIndex).toBe(0);
    });

    it("returns 400 for a receiver address outside this service", async () => {
        const res = await post(
            "/v1/sponsored-transfers",
            sponsoredBody({ receiverAddress: "ark1qwrong" }),
        );
        expect(res.status).toBe(400);
        expect(((await res.json()) as ErrorResponse).code).toBe("invalid_request");
    });

    it("locks and reports a sponsored transfer", async () => {
        const d = deps();
        d.lockupSubmitter = sponsoredBuilder;
        const sponsored = createRoutes(d);
        const quoted = await sponsored.request("/v1/sponsored-transfers", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(sponsoredBody()),
        });
        expect(quoted.status).toBe(200);
        const quote = (await quoted.json()) as SponsoredQuoteResponse;
        const lockup = await sponsored.request(
            `/v1/sponsored-transfers/${quote.transferId}/lockup`,
            {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ signedLockupTx: "psbt" }),
            },
        );
        expect(lockup.status).toBe(202);
        const status = await sponsored.request(`/v1/sponsored-transfers/${quote.transferId}`);
        expect(status.status).toBe(200);
        expect(((await status.json()) as TransferStatusResponse).state).toBe("locking");
    });

    it("returns 404 for an unknown sponsored transfer", async () => {
        const res = await app().request("/v1/sponsored-transfers/nope");
        expect(res.status).toBe(404);
        expect(((await res.json()) as ErrorResponse).code).toBe("not_found");
    });
});

const USDT_DISPLAY = "1234".repeat(16);
const USDT_INTERNAL = Buffer.from(USDT_DISPLAY, "hex").reverse().toString("hex");
const swapBody = (over: Record<string, unknown> = {}) => {
    registerSenderCoin(
        "dd".repeat(32),
        3,
        asIndexed(
            fundingCoin({
                txid: "dd".repeat(32),
                vout: 3,
                value: 10000,
                script: FAKE_COVENANT_SCRIPT,
            }),
        ),
    );
    registerSenderCoin(
        "ee".repeat(32),
        1,
        asIndexed(
            solverCoin({
                txid: "ee".repeat(32),
                vout: 1,
                value: 6000,
                assets: [
                    {
                        assetId: asset.AssetId.create(USDT_DISPLAY, 0).toString(),
                        amount: 100n,
                    },
                ],
            }),
        ),
    );
    return {
        operationId: "op-1",
        offerHex: "ab12",
        solverInputs: [
            {
                txid: "ee".repeat(32),
                vout: 1,
                value: "6000",
                ...solverTaproot(),
                assets: [
                    {
                        assetId: { txid: USDT_INTERNAL, groupIndex: 0 },
                        amount: "100",
                    },
                ],
            },
        ],
        solverProceedsScript: "51",
        solverKeys: ["ab".repeat(32)],
        contributionSats: "330",
        maxFare: {
            currency: "asset",
            assetId: { txid: USDT_INTERNAL, groupIndex: 0 },
            units: "5",
        },
        fundingTxid: "dd".repeat(32),
        fundingVout: 3,
        ...over,
    };
};

describe("swap-fill routes", () => {
    const legacySwapApp = () => createRoutes({ ...deps(), receiveQuotes: undefined as never });
    const legacySwapPost = (path: string, body: unknown) =>
        legacySwapApp().request(path, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(body),
        });

    it("requires a receive quote for a new public positive-contribution fill", async () => {
        const response = await post("/v1/swap-fills", swapBody());
        expect(response.status).toBe(400);
        expect(((await response.json()) as ErrorResponse).code).toBe("receive_quote_required");
    });

    it("keeps the legacy unbound fill harness readable and replayable", async () => {
        const first = await legacySwapPost("/v1/swap-fills", swapBody());
        expect(first.status).toBe(200);
        const quote = (await first.json()) as SwapFillQuoteResponse;
        expect(quote.operationId).toBe("op-1");
        expect(quote.template).toBe("taxi-fill/1");
        expect(quote.graph.inputs).toEqual([
            { owner: "offer-covenant", txid: "dd".repeat(32), vout: 3 },
            { owner: "solver", txid: "ee".repeat(32), vout: 1 },
            { owner: "sponsor", txid: "bb".repeat(32), vout: 0 },
        ]);
        const replay = await legacySwapPost("/v1/swap-fills", swapBody());
        expect(replay.status).toBe(200);
        expect(await replay.json()).toEqual(quote);
        const conflict = await legacySwapPost(
            "/v1/swap-fills",
            swapBody({ contributionSats: "331" }),
        );
        expect(conflict.status).toBe(409);
        const status = await legacySwapApp().request(`/v1/swap-fills/${quote.fillId}`);
        expect(status.status).toBe(200);
        expect(((await status.json()) as SwapFillStatusResponse).state).toBe("quoted");
    });

    it("returns 404 for an unknown swap fill", async () => {
        const res = await app().request("/v1/swap-fills/nope");
        expect(res.status).toBe(404);
        expect(((await res.json()) as ErrorResponse).code).toBe("not_found");
    });

    it("submits a quoted fill with 202 and fences a replay", async () => {
        const first = await legacySwapPost("/v1/swap-fills", swapBody());
        const quote = (await first.json()) as SwapFillQuoteResponse;
        const submit = await legacySwapPost(`/v1/swap-fills/${quote.fillId}/submit`, {
            solverGraph: quote.graph,
        });
        expect(submit.status).toBe(202);
        const status = (await submit.json()) as SwapFillStatusResponse;
        expect(status).toMatchObject({
            fillId: quote.fillId,
            operationId: "op-1",
            state: "submitting",
        });
        expect(typeof status.txid).toBe("string");
        const replay = await legacySwapPost(`/v1/swap-fills/${quote.fillId}/submit`, {
            solverGraph: quote.graph,
        });
        expect(replay.status).toBe(409);
        expect(((await replay.json()) as ErrorResponse).code).toBe("invalid_state");
    });

    it("returns 404 for an unknown fill submit and 400 for a malformed solver graph", async () => {
        const quoted = (await (
            await legacySwapPost("/v1/swap-fills", swapBody())
        ).json()) as SwapFillQuoteResponse;
        const missing = await legacySwapPost("/v1/swap-fills/nope/submit", {
            solverGraph: quoted.graph,
        });
        expect(missing.status).toBe(404);
        const first = await legacySwapPost("/v1/swap-fills", swapBody({ operationId: "op-2" }));
        const quote = (await first.json()) as SwapFillQuoteResponse;
        const malformed = await legacySwapPost(`/v1/swap-fills/${quote.fillId}/submit`, {
            solverGraph: { template: "taxi-fill/9" },
        });
        expect(malformed.status).toBe(400);
    });

    it("returns 409 when the solver graph differs from the quoted fill", async () => {
        const first = await legacySwapPost("/v1/swap-fills", swapBody());
        const quote = (await first.json()) as SwapFillQuoteResponse;
        const diverted = structuredClone(quote.graph);
        const change = diverted.outputs.find((o) => o.role === "sponsor-change")!;
        change.script = "dd".repeat(34);
        const rejected = await legacySwapPost(`/v1/swap-fills/${quote.fillId}/submit`, {
            solverGraph: diverted,
        });
        expect(rejected.status).toBe(409);
        expect(((await rejected.json()) as ErrorResponse).code).toBe("swap_fill_graph_conflict");
        const status = await legacySwapApp().request(`/v1/swap-fills/${quote.fillId}`);
        expect(((await status.json()) as SwapFillStatusResponse).state).toBe("quoted");
    });
});

type ProviderCall = { name: string; outpoints?: number };

/** Counts every provider read a request makes and how many sequential waves
 * they cost: a read started while another is in flight shares its latency. */
const counting = (base: RouteDeps) => {
    const calls: ProviderCall[] = [];
    let inFlight = 0;
    let waves = 0;
    const observe = async <R>(entry: ProviderCall, read: () => Promise<R>): Promise<R> => {
        calls.push(entry);
        if (inFlight === 0) waves++;
        inFlight++;
        try {
            await new Promise((resolve) => setImmediate(resolve));
            return await read();
        } finally {
            inFlight--;
        }
    };
    return {
        names: () => calls.map(({ name }) => name).sort(),
        outpoints: () => calls.flatMap((c) => (c.outpoints === undefined ? [] : [c.outpoints])),
        waves: () => waves,
        inFlight: () => inFlight,
        deps: {
            ...base,
            senderInventory: {
                getVtxos: (filter?: Parameters<RouteDeps["senderInventory"]["getVtxos"]>[0]) =>
                    observe(
                        { name: "indexer.getVtxos", outpoints: filter?.outpoints?.length ?? 0 },
                        () => base.senderInventory.getVtxos(filter),
                    ),
            },
            inventory: {
                getSpendableVtxos: () =>
                    observe({ name: "wallet.getSpendableVtxos" }, () =>
                        base.inventory.getSpendableVtxos(),
                    ),
                getLockedVtxoOutpoints: () =>
                    observe({ name: "storage.lockedOutpoints" }, () =>
                        base.inventory.getLockedVtxoOutpoints(),
                    ),
            },
            providerLimits: () =>
                observe({ name: "arkd.getInfo" }, async () => ({ vtxoMaxAmount: 10_000_000n })),
        },
    };
};

describe("provider read budget", () => {
    const prepared = (policyOver: Partial<Policy> = {}, depsOver: Partial<RouteDeps> = {}) =>
        counting({ ...deps(policyOver), ...depsOver });
    const send = (counter: ReturnType<typeof counting>, path: string, body: unknown) =>
        createRoutes(counter.deps).request(path, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(body),
        });
    const run = async (
        path: string,
        body: unknown,
        policyOver: Partial<Policy> = {},
        depsOver: Partial<RouteDeps> = {},
    ) => {
        const counter = prepared(policyOver, depsOver);
        return { counter, response: await send(counter, path, body) };
    };

    it("spends three waves of six reads on POST /v1/transfers", async () => {
        const { counter, response } = await run("/v1/transfers", quoteBody());
        expect(response.status).toBe(200);
        expect(counter.names()).toEqual([
            "indexer.getVtxos",
            "indexer.getVtxos",
            "storage.lockedOutpoints",
            "storage.lockedOutpoints",
            "wallet.getSpendableVtxos",
            "wallet.getSpendableVtxos",
        ]);
        expect(counter.outpoints()).toEqual([1, 1]);
        expect(counter.waves()).toBe(3);
    });

    it("reads no provider on a lockup submission", async () => {
        const quoted = await run("/v1/transfers", quoteBody());
        const id = ((await quoted.response.json()) as QuoteResponse).transferId;
        const { counter, response } = await run(`/v1/transfers/${id}/lockup`, {
            signedLockupTx: "signed",
        });
        expect(response.status).toBe(202);
        expect(counter.names()).toEqual([]);
        expect(counter.waves()).toBe(0);
    });

    it("spends two waves of four reads on POST /v1/receive-quotes", async () => {
        const { counter, response } = await run(
            "/v1/receive-quotes",
            receiveQuoteBody(),
            receivePolicy,
        );
        expect(response.status).toBe(200);
        expect(counter.names()).toEqual([
            "storage.lockedOutpoints",
            "storage.lockedOutpoints",
            "wallet.getSpendableVtxos",
            "wallet.getSpendableVtxos",
        ]);
        expect(counter.waves()).toBe(2);
    });

    it("spends three waves of six reads on POST /v1/sponsored-transfers", async () => {
        const { counter, response } = await run("/v1/sponsored-transfers", sponsoredBody());
        expect(response.status).toBe(200);
        expect(counter.names()).toEqual([
            "indexer.getVtxos",
            "indexer.getVtxos",
            "storage.lockedOutpoints",
            "storage.lockedOutpoints",
            "wallet.getSpendableVtxos",
            "wallet.getSpendableVtxos",
        ]);
        expect(counter.outpoints()).toEqual([1, 1]);
        expect(counter.waves()).toBe(3);
    });

    it("spends five waves of eight reads on POST /v1/swap-fills", async () => {
        const { counter, response } = await run(
            "/v1/swap-fills",
            swapBody(),
            {},
            { receiveQuotes: undefined as never },
        );
        expect(response.status).toBe(200);
        expect(counter.names()).toEqual([
            "arkd.getInfo",
            "indexer.getVtxos",
            "indexer.getVtxos",
            "indexer.getVtxos",
            "storage.lockedOutpoints",
            "storage.lockedOutpoints",
            "wallet.getSpendableVtxos",
            "wallet.getSpendableVtxos",
        ]);
        // The deposit and every solver input share the closing re-read.
        expect(counter.outpoints()).toEqual([1, 1, 2]);
        expect(counter.waves()).toBe(5);
    });

    it("reads the provider limits while the fill graph is being built", async () => {
        const counter = prepared({}, { receiveQuotes: undefined as never });
        const build = swapFillBuilder.buildSwapFillGraph.bind(swapFillBuilder);
        let duringBuild = 0;
        counter.deps.swapFillBuilder = {
            buildSwapFillGraph: (req: Parameters<typeof build>[0]) => {
                duringBuild = counter.inFlight();
                return build(req);
            },
        };
        const response = await send(counter, "/v1/swap-fills", swapBody());
        expect(response.status).toBe(200);
        expect(duringBuild).toBe(1);
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
                    code: "covenant_renewal_missing",
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

    it("merges swap-fill reconciler blockers into readiness and health", async () => {
        const router = createRoutes({
            ...deps(),
            swapFillReconciler: {
                status: () => ({
                    lastTickAt: NOW,
                    submitting: 1,
                    blockers: ["swap_fill_unexpected_spend"],
                }),
            },
        });
        const res = await router.request("/ready");
        expect(res.status).toBe(503);
        expect(await res.json()).toMatchObject({
            status: "degraded",
            reconciler: {
                swapFills: {
                    lastTickAt: NOW,
                    submitting: 1,
                    blockers: ["swap_fill_unexpected_spend"],
                },
            },
            reason: "swap_fill_unexpected_spend",
        });
    });

    it("is 503 before the swap-fill reconciler has completed catch-up", async () => {
        const router = createRoutes({
            ...deps(),
            swapFillReconciler: {
                status: () => ({ lastTickAt: null, submitting: 1, blockers: [] }),
            },
        });
        const res = await router.request("/ready");
        expect(res.status).toBe(503);
        expect(await res.json()).toMatchObject({
            status: "degraded",
            reason: "the swap-fill reconciler has not completed a tick",
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

describe("CORS", () => {
    const wallet = { origin: "https://wallet.example" };

    const serverDeps = () => {
        const db = openDatabase(":memory:");
        return {
            ...deps(),
            advances: new AdvanceRepository(db),
            policy: new PolicyRepository(db),
            sweeperIntervalMs: 1_000,
            sweeperRunning: () => true,
            rescan: async () => {},
            boarding: {
                address: async () => "bcrt1pboarding",
                deposits: async () => boardingView().deposits!,
            },
        };
    };
    const corsApp = () => createApp(serverDeps());

    it("stamps Access-Control-Allow-Origin on a /v1 GET, with no credentials header", async () => {
        const res = await corsApp().request("/v1/info", { headers: wallet });
        expect(res.status).toBe(200);
        expect(res.headers.get("access-control-allow-origin")).toBe("*");
        expect(res.headers.get("access-control-allow-credentials")).toBeNull();
    });

    it("answers a /v1 preflight with 204 and the CORS headers, not 404", async () => {
        const res = await corsApp().request("/v1/receive-quotes", {
            method: "OPTIONS",
            headers: {
                ...wallet,
                "Access-Control-Request-Method": "POST",
                "Access-Control-Request-Headers": "content-type",
            },
        });
        expect(res.status).toBe(204);
        expect(res.headers.get("access-control-allow-origin")).toBe("*");
        expect(res.headers.get("access-control-allow-methods")).toContain("POST");
        expect(res.headers.get("access-control-allow-headers")).toContain("content-type");
        expect(res.headers.get("access-control-max-age")).toBeTruthy();
        expect(res.headers.get("access-control-allow-credentials")).toBeNull();
    });

    it("stamps the header on a /v1 error response, so the browser doesn't hide it", async () => {
        const res = await corsApp().request("/v1/transfers/nope", { headers: wallet });
        expect(res.status).toBe(404);
        expect(res.headers.get("access-control-allow-origin")).toBe("*");
    });

    it("stamps the header on the /v1/claims/events stream a browser EventSource opens", async () => {
        const res = await corsApp().request(claimsUrl("/v1/claims/events"), { headers: wallet });
        try {
            expect(res.status).toBe(200);
            expect(res.headers.get("content-type")).toContain("text/event-stream");
            expect(res.headers.get("access-control-allow-origin")).toBe("*");
        } finally {
            await res.body?.cancel();
        }
    });

    it("serves the admin only from the admin app, behind the same shutdown guard", async () => {
        const app = corsApp();
        expect((await app.request("/v1/info")).status).toBe(200);
        expect((await app.request("/admin/api/status")).status).toBe(404);

        const admin = createAdminApp(serverDeps());
        expect((await admin.request("/api/status")).status).toBe(200);
        expect((await admin.request("/admin/api/status")).status).toBe(200);
        expect(await (await admin.request("/")).text()).toBe(INDEX_HTML);
        const closing = createAdminApp({ ...serverDeps(), accepting: () => false });
        expect((await closing.request("/api/status")).status).toBe(503);
    });

    it("hands the configured admin operator to the console it serves", async () => {
        const base = serverDeps();
        const admin = createAdminApp({
            ...base,
            config: { ...base.config, adminOperator: "taxi-ops" },
        });

        const res = await admin.request("/api/rescan", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: "{}",
        });

        expect(res.status).toBe(202);
        expect(base.policy.history(10).map((row) => row.actor)).toEqual(["taxi-ops"]);
    });

    it("lists watcher warnings on the admin status only, never in public readiness", async () => {
        const warning = { advanceId: "adv-unrolled", code: "covenant_unrolled", detail: "d" };
        reconcilerStatus = { ...reconcilerStatus, warnings: [warning] };
        let reads = 0;
        const deps = {
            ...serverDeps(),
            reconciler: {
                status: () => {
                    reads++;
                    return reconcilerStatus;
                },
            },
        };
        deps.policy.update({ paused: false }, "test");

        const status = await (await createAdminApp(deps).request("/api/status")).json();
        expect(reads).toBe(1);
        const health = await (await createApp(deps).request("/health")).json();

        expect(status.warnings).toEqual([warning]);
        expect(status.readiness).toMatchObject({ status: "ok", blockers: [] });
        expect(health).not.toHaveProperty("warnings");
        expect(JSON.stringify(health)).not.toContain("covenant_unrolled");
    });

    it("resumes an operator pause once an unrolled covenant is only a warning", async () => {
        const db = openDatabase(":memory:");
        const advances = new AdvanceRepository(db);
        const policy = new PolicyRepository(db);
        const unrolled = advance({ outpoint: { txid: "cc".repeat(32), vout: 0 } });
        const tip = { hash: "41".repeat(32), height: 700000, time: NOW };
        advances.insert(unrolled);
        advances.recordCovenantUnrolled(unrolled.id, "covenant outpoint was unrolled", NOW, tip);
        const indexer = {
            getVtxos: async () => ({
                vtxos: [fundingCoin({ ...unrolled.outpoint!, isUnrolled: true })],
            }),
            getVirtualTxs: async () => ({ txs: [] }),
        };
        const watcher = createSpendWatcher({
            advances,
            policy,
            indexer,
            config: config(),
            now: () => clock,
            tip: async () => tip,
        });
        const reconciler = createLockupReconciler({
            advances,
            reservations: new ReservationRepository(db),
            policy,
            indexer,
            submission: { resume: async () => false },
            watcher,
            now: () => clock,
            clock: () => ({ height: tip.height, timestamp: new Date(NOW * 1000) }),
        });
        await reconciler.tick();
        policy.update({ paused: false }, "setup");
        policy.update({ paused: true }, "alice");
        const deps = {
            ...serverDeps(),
            advances,
            policy,
            reconciler,
            rescan: () => reconciler.tick(),
        };
        const admin = createAdminApp(deps);

        const resumed = await admin.request("/admin/api/resume", {
            method: "POST",
            headers: { "content-type": "application/json", "x-taxi-operator": "alice" },
            body: "{}",
        });
        const status = await (await admin.request("/admin/api/status")).json();
        const health = await (await createApp(deps).request("/health")).json();

        expect(resumed.status).toBe(200);
        expect(policy.get().paused).toBe(false);
        expect(status.warnings).toEqual([
            expect.objectContaining({ advanceId: unrolled.id, code: "covenant_unrolled" }),
        ]);
        expect(health.blockers).not.toContain("covenant_unrolled");
    });

    it("settles the runtime check a rescan leaves in flight before judging resume", async () => {
        const base = serverDeps();
        let checking = true;
        const admin = createAdminApp({
            ...base,
            runtime: {
                ...base.runtime,
                safety: () =>
                    checking
                        ? runtimeSafety({
                              chainHeight: null,
                              chainTime: null,
                              walletSynced: false,
                              providerIdentityOk: false,
                              blockers: ["runtime_checking"],
                          })
                        : runtimeSafety(),
                refresh: async () => {
                    checking = false;
                    return runtimeSafety();
                },
            },
        });

        const res = await admin.request("/api/policy/resume", {
            method: "POST",
            headers: { "content-type": "application/json", "x-taxi-operator": "taxi-ops" },
            body: "{}",
        });

        expect(await res.json()).toMatchObject({ paused: false });
        expect(res.status).toBe(200);
        expect(base.policy.get().paused).toBe(false);
    });

    it("shares one funding wallet read for 10 s and does not cache a failed one", async () => {
        let nowMs = 1_000_000;
        let reads = 0;
        let addressReads = 0;
        let failing = false;
        let addressFailing = false;
        let release!: () => void;
        const gate = new Promise<void>((resolve) => (release = resolve));
        const base = serverDeps();
        const admin = createAdminApp({
            ...base,
            nowMs: () => nowMs,
            inventory: {
                getLockedVtxoOutpoints: async () => [],
                getSpendableVtxos: async () => {
                    reads++;
                    await gate;
                    if (failing) throw new Error("wallet unavailable");
                    return [fundingCoin()];
                },
            },
            boarding: {
                ...base.boarding,
                address: async () => {
                    addressReads++;
                    if (addressFailing) throw new Error("wallet unavailable");
                    return "bcrt1pboarding";
                },
            },
        });
        const funding = async () => (await admin.request("/api/funding")).status;

        const concurrent = [funding(), funding()];
        await new Promise((resolve) => setTimeout(resolve, 10));
        expect(reads).toBe(1);
        release();
        expect(await Promise.all(concurrent)).toEqual([200, 200]);
        nowMs += 9_999;
        expect(await funding()).toBe(200);
        expect([reads, addressReads]).toEqual([1, 1]);
        nowMs += 1;
        expect(await funding()).toBe(200);
        expect([reads, addressReads]).toEqual([2, 2]);

        nowMs += 10_000;
        failing = true;
        expect(await funding()).toBe(503);
        failing = false;
        expect(await funding()).toBe(200);
        expect(reads).toBe(4);

        nowMs += 10_000;
        addressFailing = true;
        const degraded = await admin.request("/api/funding");
        expect(degraded.status).toBe(200);
        expect((await degraded.json()).boarding.address).toBeNull();
    });

    it("gives /admin no CORS headers and does not answer its preflight", async () => {
        const app = createAdminApp(serverDeps());
        const get = await app.request("/admin", { headers: wallet });
        expect(get.status).toBe(200);
        expect(get.headers.get("access-control-allow-origin")).toBeNull();

        const preflight = await app.request("/admin", {
            method: "OPTIONS",
            headers: { ...wallet, "Access-Control-Request-Method": "GET" },
        });
        expect(preflight.status).not.toBe(204);
        expect(preflight.headers.get("access-control-allow-origin")).toBeNull();
        expect(preflight.headers.get("access-control-allow-credentials")).toBeNull();
    });
});

describe("exposure cap across flows", () => {
    const RECEIVE_RULE = {
        assetId: ASSET,
        enabled: true,
        claim: "either" as const,
        maxTopupSats: null,
        fares: [],
    };

    const receiveRow = (policyRevision: bigint): ReceiveQuote => ({
        id: "rcv-cap",
        state: "quoted",
        receiverAddress,
        makerPublicKey: bytesToHex(senderKey),
        params: {
            receiverKey,
            senderKey,
            operatorKey,
            operatorSignerKey: config().operatorSignerKey,
            exitDelay: config().exitDelay,
            dust: 330n,
            topup: 330n,
            assetId: ASSET,
            locktime: BigInt(NOW) + 8_640_000n,
            claimMode: "recycle",
            recoveryRecipient: "receiver",
        },
        covenantAddress: "tark1qreceivecap",
        fare: { currency: "sats", units: 0n },
        batchExpiry: { kind: "height", value: 850_000n },
        inputExpiryFloor: { kind: "height", value: 850_000n },
        recoveryLocktime: { kind: "time", value: BigInt(NOW) + 8_640_000n },
        loanSats: 330n,
        createdAt: NOW,
        expiresAt: NOW + 600,
        policyRevision,
        operatorInputs: [
            {
                txid: "7e".repeat(32),
                vout: 0,
                value: 20_000n,
                tapTree: new Uint8Array([1]),
                spendLeaf: new Uint8Array([2]),
                expiry: { kind: "height", value: 850_000n },
            },
        ],
    });

    /** The memory stores carry no cap fence, so only the real repositories can
     * show admission and the fence disagreeing. */
    const realStores = (over: Partial<Policy> = {}) => {
        const db = openDatabase(":memory:");
        const terms = new PolicyRepository(db);
        terms.update(basePolicy({ ...over }), "test");
        const ledger = new AdvanceRepository(db);
        const quotes = new ReceiveQuoteRepository(db);
        return {
            db,
            ledger,
            quotes,
            terms,
            router: createRoutes({
                ...deps(),
                advances: ledger,
                policy: terms,
                reservations: new ReservationRepository(db),
                receiveQuotes: quotes,
            }),
        };
    };

    const openReceive = (quotes: ReceiveQuoteRepository, terms: PolicyRepository) => {
        const revision = terms.getSnapshot().revision;
        quotes.insert({
            quote: receiveRow(revision),
            expectedPolicyRevision: revision,
            recoveryExecutionBudget: { kind: "time", value: config().recoveryBroadcastSeconds },
        });
    };

    const postTransfer = (router: ReturnType<typeof createRoutes>) =>
        router.request("/v1/transfers", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(quoteBody()),
        });

    const capped = (over: Partial<Policy> = {}) =>
        realStores({
            maxOutstandingSats: 500n,
            assetRules: [...basePolicy().assetRules, RECEIVE_RULE],
            ...over,
        });

    it("refuses an advance quote with a typed 409 when open receive quotes fill the cap", async () => {
        const { db, ledger, quotes, terms, router } = capped();
        try {
            openReceive(quotes, terms);
            const res = await postTransfer(router);

            expect(res.status).toBe(409);
            expect(((await res.json()) as ErrorResponse).code).toBe("exceeds_max_outstanding");
            expect(ledger.byState("quoted")).toEqual([]);
        } finally {
            db.close();
        }
    });

    it("refuses on the concurrent-advance count the fence sees, not the advance count", async () => {
        const { db, quotes, terms, router } = capped({
            maxOutstandingSats: 100_000n,
            maxConcurrentAdvances: 1,
        });
        try {
            openReceive(quotes, terms);
            const res = await postTransfer(router);

            expect(res.status).toBe(409);
            expect(((await res.json()) as ErrorResponse).code).toBe("max_concurrent_advances");
        } finally {
            db.close();
        }
    });

    it("reports the operator's exposure as the fence counts it, not advances alone", async () => {
        const { db, ledger, quotes, terms } = capped();
        try {
            openReceive(quotes, terms);
            const admin = createAdminApp({
                ...deps(),
                advances: ledger,
                policy: terms,
                reservations: new ReservationRepository(db),
                swapFills: new SwapFillRepository(db),
                receiveQuotes: quotes,
                sweeperIntervalMs: 1_000,
                sweeperRunning: () => true,
                rescan: async () => {},
                boarding: {
                    address: async () => "bcrt1pboarding",
                    deposits: async () => boardingView().deposits!,
                },
            });

            const { exposure } = (await (await admin.request("/api/status")).json()) as {
                exposure: { outstandingSats: string; activeCount: number };
            };
            const fence = totalExposure(db);

            expect(fence.total).toBe(330n);
            expect(exposure.outstandingSats).toBe(String(fence.total));
            expect(exposure.activeCount).toBe(Number(fence.count));
        } finally {
            db.close();
        }
    });

    it("maps a fence refusal raced in after admission to the same typed 409", async () => {
        const { db, ledger, router } = capped();
        const build = lockupBuilder.buildUnsigned.bind(lockupBuilder);
        try {
            // Admission has already passed when this lands, and an advance row
            // reserves no outpoint, so only the cap fence can refuse.
            lockupBuilder.buildUnsigned = async (request) => {
                const funding = await build(request);
                ledger.insert(
                    advance({
                        id: "adv-raced",
                        state: "locked",
                        topup: 330n,
                        outpoint: { txid: "5c".repeat(32), vout: 0 },
                        operatorInputs: [{ txid: "5d".repeat(32), vout: 0 }],
                    }),
                );
                return funding;
            };
            const res = await postTransfer(router);

            expect(res.status).toBe(409);
            expect(((await res.json()) as ErrorResponse).code).toBe("exceeds_max_outstanding");
            expect(ledger.byState("quoted")).toEqual([]);
        } finally {
            db.close();
        }
    });
});

describe("API documentation", () => {
    const mismatches = (value: unknown, schema: Schema, at = "$"): string[] => {
        if (schema.$ref)
            return mismatches(
                value,
                openApiDocument.components.schemas[schema.$ref.split("/").pop()!]!,
                at,
            );
        if (schema.oneOf)
            return schema.oneOf.some((branch) => !mismatches(value, branch, at).length)
                ? []
                : [`${at} matches no oneOf branch`];
        const type =
            value === null
                ? "null"
                : Array.isArray(value)
                  ? "array"
                  : Number.isInteger(value)
                    ? "integer"
                    : typeof value;
        const allowed = [schema.type ?? type].flat() as string[];
        if (!allowed.includes(type) && !(type === "integer" && allowed.includes("number")))
            return [`${at} is ${type}, not ${allowed.join(" | ")}`];
        if (schema.const !== undefined && value !== schema.const)
            return [`${at} is not ${schema.const}`];
        if (schema.enum && !schema.enum.includes(value as string))
            return [`${at} is outside its enum`];
        if (schema.pattern && typeof value === "string" && !new RegExp(schema.pattern).test(value))
            return [`${at} does not match ${schema.pattern}`];
        if (Array.isArray(value))
            return value.flatMap((item, i) => mismatches(item, schema.items!, `${at}[${i}]`));
        if (type !== "object") return [];
        const record = value as Record<string, unknown>;
        return [
            ...(schema.required ?? [])
                .filter((key) => !(key in record))
                .map((key) => `${at}.${key} is missing`),
            ...Object.entries(record).flatMap(([key, item]) =>
                schema.properties?.[key]
                    ? mismatches(item, schema.properties[key], `${at}.${key}`)
                    : schema.additionalProperties === false
                      ? [`${at}.${key} is undocumented`]
                      : [],
            ),
        ];
    };

    it("documents the any-asset rule exactly as /v1/info serves it", async () => {
        const any = { ...basePolicy().assetRules[0]!, assetId: "*" as const };
        const body = await (await app({ assetRules: [any] }).request("/v1/info")).json();
        expect(body.assetRules[0].assetId).toBe("*");
        expect(mismatches(body, { $ref: "#/components/schemas/InfoResponse" })).toEqual([]);
    });

    it("documents the exit delay as positive, as POST /v1/transfers serves it", async () => {
        const quote = (await (await post("/v1/transfers", quoteBody())).json()) as QuoteResponse;
        const schema: Schema = { $ref: "#/components/schemas/QuoteParams" };
        expect(mismatches(quote.params, schema)).toEqual([]);
        for (const value of ["0", "00"])
            expect(
                mismatches(
                    { ...quote.params, exitDelay: { ...quote.params.exitDelay, value } },
                    schema,
                ),
            ).toEqual([expect.stringContaining("$.exitDelay.value")]);
    });

    it("documents exactly the public routes the app registers", () => {
        const registered = app()
            .routes.map(({ method, path }) => `${method} ${path.replace(/:(\w+)/g, "{$1}")}`)
            .filter((route) => route !== "GET /" && route !== "GET /openapi.json");
        const documented = Object.entries(openApiDocument.paths).flatMap(([path, item]) =>
            Object.keys(item).map((method) => `${method.toUpperCase()} ${path}`),
        );
        expect(documented.sort()).toEqual(registered.sort());
    });

    it("gives every success response a real example that its schema and the client decoder accept", () => {
        const decoders: Record<string, (body: never) => unknown> = {
            "GET /v1/info 200": decodeInfo,
            "POST /v1/transfers 200": decodeQuote,
            "POST /v1/transfers/{id}/lockup 200": decodeLockup,
            "POST /v1/transfers/{id}/lockup 202": decodeLockup,
            "GET /v1/transfers/{id} 200": decodeStatus,
            "POST /v1/receive-quotes 200": decodeReceiveQuote,
            "GET /v1/receive-quotes/{id} 200": decodeReceiveQuote,
            "POST /v1/sponsored-transfers 200": decodeSponsoredQuote,
            "POST /v1/sponsored-transfers/{id}/lockup 200": decodeLockup,
            "POST /v1/sponsored-transfers/{id}/lockup 202": decodeLockup,
            "GET /v1/sponsored-transfers/{id} 200": decodeStatus,
            "POST /v1/swap-fills 200": decodeSwapFillQuote,
            "GET /v1/swap-fills/{id} 200": decodeSwapFillStatus,
            "POST /v1/swap-fills/{id}/submit 202": decodeSwapFillStatus,
            "GET /v1/claims 200": decodeClaimsSnapshot,
            "GET /v1/claims/events 200 claims-snapshot": decodeClaimsSnapshot,
            "GET /v1/claims/events 200 claims-changed": decodeClaimsChanged,
        };
        const decoded: string[] = [];
        for (const [path, item] of Object.entries(openApiDocument.paths))
            for (const [method, operation] of Object.entries(item))
                for (const [status, response] of Object.entries(operation!.responses)) {
                    if (!status.startsWith("2")) continue;
                    const key = `${method.toUpperCase()} ${path} ${status}`;
                    for (const [type, { schema, example }] of Object.entries(response.content!)) {
                        expect(example, key).toBeDefined();
                        const bodies: [string, unknown, Schema][] =
                            type === "text/event-stream"
                                ? [...String(example).matchAll(/^event: (\S+)\ndata: (.+)$/gm)].map(
                                      ([, event, data]) => [
                                          `${key} ${event}`,
                                          JSON.parse(data!),
                                          { $ref: "#/components/schemas/ClaimsSnapshot" },
                                      ],
                                  )
                                : [[key, example, schema]];
                        for (const [name, body, bodySchema] of bodies) {
                            expect(mismatches(body, bodySchema), name).toEqual([]);
                            if (!decoders[name]) continue;
                            expect(() => decoders[name]!(body as never), name).not.toThrow();
                            decoded.push(name);
                        }
                    }
                }
        expect(decoded.sort()).toEqual(Object.keys(decoders).sort());
    });

    it("serves the document as JSON and a Redoc page that loads it with a pinned integrity", async () => {
        const spec = await app().request("/openapi.json");
        expect(spec.status).toBe(200);
        expect(spec.headers.get("content-type")).toMatch(/^application\/json/);
        expect(await spec.json()).toEqual(openApiDocument);
        expect(openApiDocument.info.title).toBe("Arkade Taxi API");

        const page = await app().request("/");
        expect(page.status).toBe(200);
        expect(page.headers.get("content-type")).toMatch(/^text\/html/);
        const html = await page.text();
        expect(html).toContain("<title>Arkade Taxi API</title>");
        expect(html).toContain('spec-url="/openapi.json"');
        expect(html).toMatch(
            /<script\s+src="https:\/\/cdn\.jsdelivr\.net\/npm\/redoc@2\.\d+\.\d+\/bundles\/redoc\.standalone\.js"\s+integrity="sha384-[A-Za-z0-9+/]{64}"\s+crossorigin="anonymous"\s*><\/script>/,
        );
    });
});
