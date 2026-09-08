import { beforeEach, describe, expect, it } from "vitest";
import { assetIdKey } from "@arkade-taxi/core";
import { assetIdToWire, bytesToHex, PROTOCOL_VERSION } from "@arkade-taxi/protocol";
import type {
    ErrorResponse,
    InfoResponse,
    LockupResponse,
    QuoteResponse,
    TransferStatusResponse,
} from "@arkade-taxi/protocol";
import { createRoutes, type RouteDeps } from "../src/routes.js";
import { FakeLockupBuilder } from "../src/quotes.js";
import type { SweeperStatus } from "../src/sweeper.js";
import {
    config,
    emulatorKey,
    EXPIRY_HEIGHT,
    MemoryAdvances,
    NOW,
    operatorKey,
    policy as basePolicy,
    quoteBody,
    serverKey,
} from "./fixtures.js";
import type { Policy } from "@arkade-taxi/core";

const ASSET = { txid: new Uint8Array(32).fill(0xbe), groupIndex: 1 };
const STALE_AFTER = 120;

let advances: MemoryAdvances;
let lockupBuilder: FakeLockupBuilder;
let sweeperStatus: SweeperStatus;
let clock: number;
let ids: number;

const okSweeper = (): SweeperStatus => ({
    lastTickAt: NOW,
    lastTickHeight: EXPIRY_HEIGHT,
    recoveredTotal: 3,
    failedTotal: 0,
    lastError: null,
});

const deps = (over: Partial<Policy> = {}): RouteDeps => ({
    advances,
    policy: { get: () => basePolicy(over) },
    config: config(),
    now: () => clock,
    randomId: () => `adv-${++ids}`,
    covenantExpiry: async () => EXPIRY_HEIGHT,
    lockupBuilder,
    sweeper: { status: () => sweeperStatus },
    sweeperStaleAfterSeconds: STALE_AFTER,
});

const app = (over: Partial<Policy> = {}) => createRoutes(deps(over));

const post = (path: string, body: unknown, over: Partial<Policy> = {}) =>
    app(over).request(path, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
    });

beforeEach(() => {
    advances = new MemoryAdvances();
    lockupBuilder = new FakeLockupBuilder();
    sweeperStatus = okSweeper();
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
                        { id: "sats", currency: "sats", pricing: { kind: "flat", units: "8" } },
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
        expect(body.fare.units).toBe("8");
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

    it("returns the txid and covenant outpoint", async () => {
        const id = await quoted();
        const res = await post(`/v1/transfers/${id}/lockup`, { signedLockupTx: "psbt" });

        expect(res.status).toBe(200);
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

    it("returns 409 for a transfer that is not quoted", async () => {
        const id = await quoted();
        await post(`/v1/transfers/${id}/lockup`, { signedLockupTx: "psbt" });

        const res = await post(`/v1/transfers/${id}/lockup`, { signedLockupTx: "psbt" });
        expect(res.status).toBe(409);
        expect(((await res.json()) as ErrorResponse).code).toBe("invalid_state");
    });

    it("returns 400 when signedLockupTx is missing", async () => {
        const id = await quoted();
        const res = await post(`/v1/transfers/${id}/lockup`, {});
        expect(res.status).toBe(400);
        expect(((await res.json()) as ErrorResponse).code).toBe("invalid_request");
    });

    it("returns 502 when the submission fails, leaving the quote usable", async () => {
        const id = await quoted();
        lockupBuilder.failSubmit = new Error("arkd refused");

        const res = await post(`/v1/transfers/${id}/lockup`, { signedLockupTx: "psbt" });
        expect(res.status).toBe(502);
        expect(((await res.json()) as ErrorResponse).code).toBe("lockup_failed");
        expect(advances.get(id)!.state).toBe("quoted");
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
});
