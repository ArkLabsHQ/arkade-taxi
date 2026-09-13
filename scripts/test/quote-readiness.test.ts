import { createServer } from "node:http";
import { once } from "node:events";
import { afterEach, expect, it, vi } from "vitest";
import { ArkAddress } from "@arkade-os/sdk";
import { quoteFor, type Live } from "../../e2e/fixtures.js";
import { config, fundingCoin, receiverKey, senderKey } from "../../packages/app/test/fixtures.js";

vi.mock("@arkade-taxi/protocol", () => import("../../packages/protocol/src/index.js"));
vi.mock("node:fs", async (original) => ({
    ...(await original<typeof import("node:fs")>()),
    appendFileSync: vi.fn(),
}));
afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
});

it.each([false, true])(
    "waits for a newly completed ready sweep before a new quote window (initially ready: %s)",
    async (initiallyReady) => {
        let release!: () => void;
        const gate = new Promise<void>((resolve) => {
            release = resolve;
        });
        let reads = 0;
        let now = Date.now();
        const preparedAt = Math.floor(now / 1000);
        const server = createServer(async (request, response) => {
            if (request.url === "/ready") {
                reads++;
                await gate;
                const degraded = reads === 1 && !initiallyReady;
                response.writeHead(degraded ? 503 : 200, { "content-type": "application/json" });
                response.end(
                    JSON.stringify({
                        status: degraded ? "degraded" : "ok",
                        blockers: degraded ? ["sweeper_stale"] : [],
                        now: Math.floor(now / 1000),
                        sweeper: {
                            lastTickAt: reads === 1 ? preparedAt - 12 : Math.floor(now / 1000),
                        },
                    }),
                );
            } else {
                response.writeHead(200, { "content-type": "application/json" });
                response.end("{}");
            }
        });
        server.listen(0, "127.0.0.1");
        await once(server, "listening");
        vi.stubEnv(
            "TAXI_E2E_BASE_URL",
            `http://127.0.0.1:${(server.address() as { port: number }).port}`,
        );
        vi.stubEnv("TAXI_E2E_PROJECT", "unit-quote-readiness");
        const requestError = new Error("first quote request reached");
        const requestQuote = vi.fn(async () => {
            throw requestError;
        });
        const cfg = config();
        const live = {
            client: { requestQuote },
            actors: {
                sender: { identity: { xOnlyPublicKey: async () => senderKey } },
                receiverSats: {
                    wallet: {
                        getAddress: async () =>
                            new ArkAddress(cfg.serverPubkey, receiverKey, cfg.addressHrp).encode(),
                    },
                },
            },
        } as unknown as Live;
        vi.spyOn(Date, "now").mockImplementation(() => now);
        const quote = quoteFor(live, "receiverSats", fundingCoin()).catch((error) => error);
        try {
            await vi.waitFor(() => expect(reads).toBe(1));
            expect(requestQuote).not.toHaveBeenCalled();
            if (!initiallyReady) now += 15_000;
            release();
            expect(await quote).toBe(requestError);
            expect(reads).toBe(2);
            expect(requestQuote).toHaveBeenCalledTimes(1);
        } finally {
            release();
            server.closeAllConnections();
            await new Promise<void>((resolve, reject) =>
                server.close((error) => (error ? reject(error) : resolve())),
            );
        }
    },
);
