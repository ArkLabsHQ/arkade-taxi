import { createServer, type IncomingMessage } from "node:http";
import { once } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TaxiClient, TaxiError, verifyQuote } from "@arkade-taxi/client";
import type { Identity } from "@arkade-os/sdk";
import { args, senderIdentity } from "../../packages/client/test/fixtures.js";
import {
    preEffectRequest,
    submitWithReadiness,
    type AdmissionTiming,
} from "../../e2e/admission.js";

const ready = { status: "ok", paused: false, blockers: [] };

afterEach(() => vi.unstubAllGlobals());

describe("pre-effect timing diagnostics", () => {
    it.each([
        [9999, 1],
        [1000, 5000],
    ])(
        "retains the original %i clock budget and selects a %i ms abort",
        async (requestNow, duration) => {
            vi.useFakeTimers();
            let monotonic = 0;
            const clock = vi.spyOn(performance, "now").mockImplementation(() => monotonic);
            const failure = new DOMException("private transport detail", "TimeoutError");
            const timeout = vi.spyOn(AbortSignal, "timeout").mockImplementation((milliseconds) => {
                const controller = new AbortController();
                setTimeout(() => {
                    monotonic += milliseconds;
                    controller.abort(failure);
                }, milliseconds);
                return controller.signal;
            });
            const entries: AdmissionTiming[] = [];
            const now = vi.fn().mockReturnValueOnce(1000).mockReturnValue(requestNow);
            const fetcher = vi.fn(
                (_url: string, { signal }: RequestInit) =>
                    new Promise((_resolve, reject) => {
                        signal!.addEventListener("abort", () => reject(signal!.reason), {
                            once: true,
                        });
                    }),
            );
            vi.stubGlobal("fetch", fetcher);
            const attempt = vi.fn(async () => {
                throw new TaxiError("not_ready", "runtime_checking");
            });
            const unchanged = vi.fn();
            const failureObserver = vi.fn();
            try {
                const pending = preEffectRequest(
                    attempt,
                    {
                        readyUrl: "http://private-host/ready?secret=hidden",
                        expiresAt: 10,
                        now,
                        onFailure: failureObserver,
                        timing: { operation: "lockup", observe: (entry) => entries.push(entry) },
                    },
                    unchanged,
                );
                const rejected = expect(pending).rejects.toBe(failure);
                await vi.advanceTimersByTimeAsync(duration);
                await rejected;
                expect(timeout).toHaveBeenCalledExactlyOnceWith(duration);
                expect(now).toHaveBeenCalledTimes(2);
                expect(attempt).toHaveBeenCalledTimes(1);
                expect(fetcher).toHaveBeenCalledTimes(1);
                expect(unchanged).not.toHaveBeenCalled();
                expect(failureObserver).toHaveBeenCalledExactlyOnceWith("readiness-headers");
                expect(
                    entries.filter((entry) => entry.phase === "readiness-headers"),
                ).toMatchObject([
                    {
                        operation: "lockup",
                        endpoint: "/ready",
                        event: "start",
                        outcome: "pending",
                        remainingOriginalBudgetMs: 10000 - requestNow,
                        selectedAbortDurationMs: duration,
                        elapsedMs: 0,
                    },
                    {
                        operation: "lockup",
                        endpoint: "/ready",
                        event: "finish",
                        outcome: "timeout",
                        remainingOriginalBudgetMs: 10000 - requestNow,
                        selectedAbortDurationMs: duration,
                        elapsedMs: duration,
                    },
                ]);
                expect(JSON.stringify(entries)).not.toMatch(/private|secret|hidden|transport/);
            } finally {
                timeout.mockRestore();
                clock.mockRestore();
                vi.useRealTimers();
            }
        },
    );

    it("records successful readiness transitions with bounded codes before one effect", async () => {
        const entries: AdmissionTiming[] = [];
        const responses = [
            {
                status: 503,
                body: {
                    status: "degraded",
                    reason: "runtime_stale",
                    blockers: ["runtime_stale", "chain_time_unavailable"],
                },
            },
            {
                status: 503,
                body: {
                    status: "degraded",
                    reason: "runtime_checking",
                    blockers: ["runtime_checking"],
                },
            },
            { status: 200, body: ready },
        ];
        vi.stubGlobal(
            "fetch",
            vi.fn(async () => {
                const response = responses.shift()!;
                return { status: response.status, json: async () => response.body };
            }),
        );
        const attempt = vi
            .fn()
            .mockRejectedValueOnce(new TaxiError("not_ready", "runtime_stale"))
            .mockResolvedValueOnce("one-effect");
        await expect(
            preEffectRequest(attempt, {
                readyUrl: "http://private-host/ready",
                expiresAt: Date.now() / 1000 + 10,
                timing: { operation: "quote", observe: (entry) => entries.push(entry) },
            }),
        ).resolves.toBe("one-effect");
        expect(
            entries.filter((entry) => entry.phase === "readiness-json" && entry.event === "finish"),
        ).toMatchObject([
            {
                operation: "quote",
                endpoint: "/ready",
                status: 503,
                reason: "runtime_stale",
                blockers: ["runtime_stale", "chain_time_unavailable"],
            },
            { status: 503, reason: "runtime_checking", blockers: ["runtime_checking"] },
            { status: 200, blockers: [] },
        ]);
        expect(
            entries.filter((entry) => entry.phase === "attempt" && entry.event === "start"),
        ).toHaveLength(2);
        expect(attempt).toHaveBeenCalledTimes(2);
    });

    it("distinguishes expiry before readiness fetch from a started request", async () => {
        const entries: AdmissionTiming[] = [];
        const fetcher = vi.fn();
        vi.stubGlobal("fetch", fetcher);
        const now = vi.fn().mockReturnValueOnce(1000).mockReturnValueOnce(10000);
        const attempt = vi.fn(async () => {
            throw new TaxiError("not_ready", "runtime_stale");
        });
        const onFailure = vi.fn();
        await expect(
            preEffectRequest(attempt, {
                readyUrl: "http://private-host/ready",
                expiresAt: 10,
                now,
                onFailure,
                timing: { operation: "quote", observe: (entry) => entries.push(entry) },
            }),
        ).rejects.toThrow("pre-effect request reached its original expiry");
        expect(entries.filter((entry) => entry.phase === "readiness-headers")).toMatchObject([
            { event: "blocked", outcome: "rejected", remainingOriginalBudgetMs: 0 },
        ]);
        expect(fetcher).not.toHaveBeenCalled();
        expect(now).toHaveBeenCalledTimes(2);
        expect(onFailure).toHaveBeenCalledExactlyOnceWith("readiness-headers");
        expect(attempt).toHaveBeenCalledTimes(1);
    });

    it.each([
        { reason: "private-reason", blockers: ["private-blocker", "runtime_stale"] },
        { reason: { secret: "private-reason" }, blockers: { secret: "private-blocker" } },
    ])("redacts unknown readiness data while preserving refusal %#", async (unsafe) => {
        const lines: string[] = [];
        const attempt = vi.fn(async () => {
            throw new TaxiError("not_ready", "runtime_stale");
        });
        vi.stubGlobal(
            "fetch",
            vi.fn(async () => ({
                status: 503,
                json: async () => ({
                    status: "degraded",
                    ...unsafe,
                    seed: "private-seed",
                    authorization: "private-auth",
                    id: "private-id",
                    psbt: "private-psbt",
                }),
            })),
        );
        await expect(
            preEffectRequest(attempt, {
                readyUrl: "http://private-host/ready?authorization=private-auth",
                expiresAt: Date.now() / 1000 + 10,
                timing: {
                    operation: "quote",
                    observe: (entry) => lines.push(JSON.stringify(entry)),
                },
            }),
        ).rejects.toThrow("readiness did not confirm the exact transient pre-effect state");
        expect(attempt).toHaveBeenCalledTimes(1);
        expect(lines.join("\n")).not.toMatch(/private|seed|authorization|psbt/);
        const json = lines
            .map((line) => JSON.parse(line))
            .find((entry) => entry.phase === "readiness-json" && entry.event === "finish");
        expect(json).toBeDefined();
        expect(json).not.toHaveProperty("reason");
        expect(json.blockers).toEqual(
            Array.isArray(unsafe.blockers) ? ["runtime_stale"] : undefined,
        );
        expect(
            lines.every((line) =>
                Object.keys(JSON.parse(line)).every((key) =>
                    [
                        "operation",
                        "endpoint",
                        "phase",
                        "event",
                        "outcome",
                        "at",
                        "monotonicMs",
                        "elapsedMs",
                        "remainingOriginalBudgetMs",
                        "selectedAbortDurationMs",
                        "status",
                        "reason",
                        "blockers",
                    ].includes(key),
                ),
            ),
        ).toBe(true);
    });

    it("contains throwing timing observers without replacing failure or adding an effect", async () => {
        const failure = new DOMException("private failure", "TimeoutError");
        const attempt = vi.fn(async () => {
            throw new TaxiError("not_ready", "runtime_checking");
        });
        const fetcher = vi.fn(async () => {
            throw failure;
        });
        vi.stubGlobal("fetch", fetcher);
        const observe = vi.fn(() => {
            throw new Error("private observer failure");
        });
        const onFailure = vi.fn();
        const unchanged = vi.fn();
        await expect(
            preEffectRequest(
                attempt,
                {
                    readyUrl: "http://private-host/ready",
                    expiresAt: Date.now() / 1000 + 10,
                    onFailure,
                    timing: { operation: "lockup", observe },
                },
                unchanged,
            ),
        ).rejects.toBe(failure);
        expect(observe).toHaveBeenCalledTimes(4);
        expect(onFailure).toHaveBeenCalledExactlyOnceWith("readiness-headers");
        expect(attempt).toHaveBeenCalledTimes(1);
        expect(fetcher).toHaveBeenCalledTimes(1);
        expect(unchanged).not.toHaveBeenCalled();
    });
});

describe("pre-effect failure diagnostics", () => {
    it.each(["attempt", "readiness-headers", "readiness-json"] as const)(
        "reports %s without replacing the original failure",
        async (phase) => {
            const failure = new DOMException("private timeout detail", "TimeoutError");
            const observer = vi.fn();
            const json = vi.fn(() => Promise.reject(failure));
            const fetcher = vi.fn(() =>
                phase === "readiness-headers" ? Promise.reject(failure) : Promise.resolve({ json }),
            );
            vi.stubGlobal("fetch", fetcher);
            const attempt = vi.fn(async () => {
                throw phase === "attempt"
                    ? failure
                    : new TaxiError("not_ready", "runtime_checking");
            });
            await expect(
                preEffectRequest(attempt, {
                    readyUrl: "http://127.0.0.1/ready",
                    expiresAt: Date.now() / 1000 + 5,
                    onFailure: observer,
                }),
            ).rejects.toBe(failure);
            expect(observer).toHaveBeenCalledExactlyOnceWith(phase);
            expect(attempt).toHaveBeenCalledTimes(1);
            expect(fetcher).toHaveBeenCalledTimes(phase === "attempt" ? 0 : 1);
            expect(json).toHaveBeenCalledTimes(phase === "readiness-json" ? 1 : 0);
        },
    );

    it.each(["attempt", "readiness-headers", "readiness-json"] as const)(
        "contains a throwing %s observer",
        async (phase) => {
            const failure = new Error("original failure");
            vi.stubGlobal("fetch", () =>
                phase === "readiness-headers"
                    ? Promise.reject(failure)
                    : Promise.resolve({ json: () => Promise.reject(failure) }),
            );
            const observer = vi.fn(() => {
                throw new Error("diagnostics unavailable");
            });
            await expect(
                preEffectRequest(
                    async () => {
                        throw phase === "attempt"
                            ? failure
                            : new TaxiError("not_ready", "runtime_stale");
                    },
                    {
                        readyUrl: "http://127.0.0.1/ready",
                        expiresAt: Date.now() / 1000 + 5,
                        onFailure: observer,
                    },
                ),
            ).rejects.toBe(failure);
            expect(observer).toHaveBeenCalledExactlyOnceWith(phase);
        },
    );

    it("records only the terminal attempt refusal", async () => {
        vi.stubGlobal("fetch", () => Promise.resolve({ status: 200, json: async () => ready }));
        const observer = vi.fn();
        const failure = new TaxiError("not_ready", "runtime_checking");
        const attempt = vi.fn(async () => {
            throw failure;
        });
        await expect(
            preEffectRequest(attempt, {
                readyUrl: "http://127.0.0.1/ready",
                expiresAt: Date.now() / 1000 + 5,
                onFailure: observer,
            }),
        ).rejects.toMatchObject({ cause: failure });
        expect(attempt).toHaveBeenCalledTimes(3);
        expect(observer).toHaveBeenCalledExactlyOnceWith("attempt");
    });

    it("does not diagnose a transient refusal that reaches one successful effect", async () => {
        vi.stubGlobal("fetch", () => Promise.resolve({ status: 200, json: async () => ready }));
        const observer = vi.fn();
        const attempt = vi
            .fn()
            .mockRejectedValueOnce(new TaxiError("not_ready", "proceeds_collecting"))
            .mockResolvedValueOnce("one-effect");
        await expect(
            preEffectRequest(attempt, {
                readyUrl: "http://127.0.0.1/ready",
                expiresAt: Date.now() / 1000 + 5,
                onFailure: observer,
            }),
        ).resolves.toBe("one-effect");
        expect(attempt).toHaveBeenCalledTimes(2);
        expect(observer).not.toHaveBeenCalled();
    });
});

it.each([
    "runtime_checking",
    "runtime_stale",
    "wallet inventory or intent locks changed or unavailable",
    "intent locks changed during construction",
])("retries only the exact pre-effect runtime_unsafe %s refusal", async (reason) => {
    const service = await localService(() => [200, ready]);
    let attempts = 0;
    try {
        await expect(
            preEffectRequest(
                async () => {
                    if (++attempts === 1) throw new TaxiError("runtime_unsafe", reason);
                    return "one-effect";
                },
                { readyUrl: `${service.url}/ready`, expiresAt: Date.now() / 1000 + 5 },
            ),
        ).resolves.toBe("one-effect");
        expect(attempts).toBe(2);
    } finally {
        await service.close();
    }
});

async function localService(
    respond: (
        request: IncomingMessage,
        body: string,
    ) => Promise<[number, unknown]> | [number, unknown],
) {
    const server = createServer(async (request, response) => {
        const chunks = [];
        for await (const chunk of request) chunks.push(chunk);
        const [status, body] = await respond(request, Buffer.concat(chunks).toString());
        response.writeHead(status, { "content-type": "application/json" });
        response.end(JSON.stringify(body));
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    return {
        url: `http://127.0.0.1:${(server.address() as { port: number }).port}`,
        close: async () => {
            server.closeAllConnections();
            await new Promise<void>((resolve, reject) =>
                server.close((error) => (error ? reject(error) : resolve())),
            );
        },
    };
}

describe.each([
    "runtime_checking",
    "runtime_stale",
    "proceeds_collecting",
    "proceeds_output_pending",
])("live pre-effect admission: %s", (reason) => {
    const checking = () => new TaxiError("not_ready", reason);
    it("waits for real readiness after an exact typed refusal, then applies one effect", async () => {
        const events: string[] = [];
        let reads = 0;
        let attempts = 0;
        let effects = 0;
        const service = await localService(() => {
            events.push("ready");
            return ++reads === 1
                ? [
                      503,
                      {
                          status: "degraded",
                          reason,
                          blockers: [reason],
                      },
                  ]
                : [200, ready];
        });
        try {
            await expect(
                preEffectRequest(
                    async () => {
                        events.push("attempt");
                        if (++attempts === 1) throw checking();
                        return ++effects;
                    },
                    { readyUrl: `${service.url}/ready`, expiresAt: Date.now() / 1000 + 5 },
                    async () => {
                        events.push("unchanged");
                    },
                ),
            ).resolves.toBe(1);
            expect(events).toEqual(["attempt", "ready", "ready", "unchanged", "attempt"]);
            expect(effects).toBe(1);
        } finally {
            await service.close();
        }
    });

    it.each([
        new TaxiError("not_ready", "server_identity_mismatch"),
        new TaxiError("not_ready", "runtime_checking "),
        new TaxiError("not_ready", "runtime_stale "),
        new TaxiError("not_ready", "proceeds_fee_cap_exceeded"),
        new TaxiError("not_ready", "proceeds_ambiguous_intent"),
        new TaxiError("runtime_unsafe", "proceeds_collecting"),
        new TaxiError("runtime_unsafe", "proceeds_output_pending"),
        new TaxiError("runtime_unsafe", "wallet inventory changed or unavailable"),
        new TaxiError("NETWORK_ERROR", reason),
        new TaxiError("HTTP_ERROR", reason),
        new TaxiError("ambiguous_submission", reason),
        Object.assign(new Error(reason), { code: "not_ready" }),
        new TypeError("fetch failed"),
    ])("never retries a nonmatching or ambiguous error %#", async (failure) => {
        let attempts = 0;
        await expect(
            preEffectRequest(
                async () => {
                    attempts++;
                    throw failure;
                },
                {
                    readyUrl: "http://127.0.0.1:1/ready",
                    expiresAt: Date.now() / 1000 + 5,
                },
            ),
        ).rejects.toBe(failure);
        expect(attempts).toBe(1);
    });

    it("never sends an expired request", async () => {
        let attempts = 0;
        await expect(
            preEffectRequest(async () => ++attempts, {
                readyUrl: "http://127.0.0.1:1/ready",
                expiresAt: 10,
                now: () => 10_000,
            }),
        ).rejects.toThrow(/expiry/);
        expect(attempts).toBe(0);
    });

    it("caps explicit refusals at three attempts without an effect", async () => {
        let attempts = 0;
        const service = await localService(() => [200, ready]);
        try {
            await expect(
                preEffectRequest(
                    async () => {
                        attempts++;
                        throw checking();
                    },
                    {
                        readyUrl: `${service.url}/ready`,
                        expiresAt: Date.now() / 1000 + 5,
                    },
                ),
            ).rejects.toThrow(/attempt/);
            expect(attempts).toBe(3);
        } finally {
            await service.close();
        }
    });

    it("does not extend expiry while waiting for readiness", async () => {
        let now = 1_000;
        let attempts = 0;
        const service = await localService(() => {
            now = 2_000;
            return [200, ready];
        });
        try {
            await expect(
                preEffectRequest(
                    async () => {
                        attempts++;
                        throw checking();
                    },
                    {
                        readyUrl: `${service.url}/ready`,
                        expiresAt: 2,
                        now: () => now,
                    },
                ),
            ).rejects.toThrow(/expiry/);
            expect(attempts).toBe(1);
        } finally {
            await service.close();
        }
    });

    it("fails at the original expiry when runtime remains stale without another submission", async () => {
        let now = 1_000;
        let attempts = 0;
        let reads = 0;
        const service = await localService(() => {
            reads++;
            now += 500;
            return [
                503,
                { status: "degraded", reason: "runtime_stale", blockers: ["runtime_stale"] },
            ];
        });
        try {
            await expect(
                preEffectRequest(
                    async () => {
                        attempts++;
                        throw checking();
                    },
                    { readyUrl: `${service.url}/ready`, expiresAt: 2, now: () => now },
                ),
            ).rejects.toThrow(/original expiry/);
            expect(attempts).toBe(1);
            expect(reads).toBe(2);
        } finally {
            await service.close();
        }
    });

    it("requires a healthy response after stale and checking readiness transitions", async () => {
        let attempts = 0;
        let reads = 0;
        const service = await localService(() => {
            reads++;
            if (reads === 3) return [200, ready];
            const reason = reads === 1 ? "runtime_stale" : "runtime_checking";
            return [
                503,
                {
                    status: "degraded",
                    reason,
                    blockers: [reason, "chain_height_unavailable", "chain_time_unavailable"],
                },
            ];
        });
        try {
            await expect(
                preEffectRequest(
                    async () => {
                        if (++attempts === 1) throw checking();
                        expect(reads).toBe(3);
                        return "submitted";
                    },
                    { readyUrl: `${service.url}/ready`, expiresAt: Date.now() / 1000 + 5 },
                ),
            ).resolves.toBe("submitted");
            expect(attempts).toBe(2);
        } finally {
            await service.close();
        }
    });

    it("does not submit after the no-effect check consumes the remaining expiry", async () => {
        let now = 1_000;
        let attempts = 0;
        const service = await localService(() => [200, ready]);
        try {
            await expect(
                preEffectRequest(
                    async () => {
                        attempts++;
                        throw checking();
                    },
                    {
                        readyUrl: `${service.url}/ready`,
                        expiresAt: 2,
                        now: () => now,
                    },
                    async () => {
                        now = 2_000;
                    },
                ),
            ).rejects.toThrow(/expiry/);
            expect(attempts).toBe(1);
        } finally {
            await service.close();
        }
    });

    it.each([
        [
            503,
            {
                status: "degraded",
                reason: "server_identity_mismatch",
                blockers: ["server_identity_mismatch"],
            },
        ],
        [200, { status: "ok", blockers: ["runtime_checking"] }],
        [200, { status: "degraded", blockers: [] }],
        [500, { error: "broken" }],
        [503, { status: "degraded", reason: "runtime_stale", blockers: ["runtime_checking"] }],
        [
            503,
            {
                status: "degraded",
                reason: "runtime_stale",
                blockers: ["runtime_stale", "server_identity_mismatch"],
            },
        ],
        [200, { ...ready, paused: true }],
    ] as const)(
        "does not hide an invalid or unsafe readiness response %#",
        async (status, body) => {
            let attempts = 0;
            const service = await localService(() => [status, body]);
            try {
                await expect(
                    preEffectRequest(
                        async () => {
                            attempts++;
                            throw checking();
                        },
                        {
                            readyUrl: `${service.url}/ready`,
                            expiresAt: Date.now() / 1000 + 5,
                        },
                    ),
                ).rejects.toThrow(/readiness/);
                expect(attempts).toBe(1);
            } finally {
                await service.close();
            }
        },
    );

    it.each([
        { state: "quoted" },
        { state: "locking" },
        { state: "quoted", submissionPhase: "prepared" },
        { state: "quoted", outpoint: { txid: "11".repeat(32), vout: 0 } },
        { state: "quoted", failureCode: "submission_failed" },
        { state: "quoted", failureDetail: "submission may have started" },
        { state: "quoted", spentTxid: "11".repeat(32) },
        { state: "quoted", transferId: "another-transfer" },
    ])("reuses one signed envelope only for unchanged quoted state %#", async (status) => {
        const offered = args();
        offered.quote.expiresAt = Math.floor(Date.now() / 1000) + 60;
        const verified = verifyQuote(offered);
        const posts: string[] = [];
        let effects = 0;
        let signatures = 0;
        let stateReads = 0;
        const identity: Identity = {
            signerSession: () => senderIdentity.signerSession(),
            compressedPublicKey: () => senderIdentity.compressedPublicKey(),
            xOnlyPublicKey: () => senderIdentity.xOnlyPublicKey(),
            signMessage: senderIdentity.signMessage.bind(senderIdentity),
            sign: async (...args) => {
                signatures++;
                return senderIdentity.sign(...args);
            },
        };
        const txid = "11".repeat(32);
        const service = await localService((request, body) => {
            if (request.url === "/ready") return [200, ready];
            if (request.method === "GET") {
                stateReads++;
                return [200, { transferId: offered.quote.transferId, updatedAt: 1, ...status }];
            }
            posts.push(body);
            if (posts.length < 3) return [503, { code: "not_ready", error: reason }];
            effects++;
            return [200, { txid, outpoint: { txid, vout: 0 } }];
        });
        try {
            const pending = submitWithReadiness(
                new TaxiClient({ baseUrl: service.url }),
                verified,
                identity,
                {
                    readyUrl: `${service.url}/ready`,
                },
            );
            if (Object.keys(status).length === 1 && status.state === "quoted") {
                await expect(pending).resolves.toEqual({ txid, outpoint: { txid, vout: 0 } });
                expect(posts).toHaveLength(3);
                expect(posts[1]).toBe(posts[0]);
                expect(posts[2]).toBe(posts[0]);
                expect(effects).toBe(1);
                expect(stateReads).toBe(2);
            } else {
                await expect(pending).rejects.toThrow(/quoted|effect/);
                expect(posts).toHaveLength(1);
                expect(effects).toBe(0);
                expect(stateReads).toBe(1);
            }
            expect(signatures).toBe(2);
        } finally {
            await service.close();
        }
    });
});
