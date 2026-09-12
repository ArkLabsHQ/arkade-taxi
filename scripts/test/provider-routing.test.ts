import { createServer } from "node:http";
import { once } from "node:events";
import { describe, expect, it } from "vitest";
import { routeProviderFetch } from "../lib/harness.mjs";

describe("isolated provider routing", () => {
    it("routes providers sharing one proxy origin by their exact path prefixes", async () => {
        const servers = ["arkd", "emulator"].map((name) =>
            createServer((request, response) => {
                response.setHeader("content-type", "application/json");
                response.end(JSON.stringify({ name, path: request.url }));
            }),
        );
        for (const server of servers) {
            server.listen(0, "127.0.0.1");
            await once(server, "listening");
        }
        try {
            const fetcher = routeProviderFetch(
                fetch,
                servers.map((server, index) => [
                    `http://proxy:4000/${index === 0 ? "arkd" : "emulator"}`,
                    `http://127.0.0.1:${(server.address() as { port: number }).port}`,
                ]),
            );
            expect(
                await fetcher("http://proxy:4000/arkd/v1/info?exact=1").then((r: Response) =>
                    r.json(),
                ),
            ).toEqual({ name: "arkd", path: "/v1/info?exact=1" });
            expect(
                await fetcher("http://proxy:4000/emulator/v1/info").then((r: Response) => r.json()),
            ).toEqual({ name: "emulator", path: "/v1/info" });
        } finally {
            for (const server of servers) {
                server.closeAllConnections();
                await new Promise<void>((resolve) => server.close(() => resolve()));
            }
        }
    });

    it.each(["/v1/tx?exact=1", "//127.0.0.1:1/v1/tx?exact=1"])(
        "routes %s to real HTTP while preserving requests and responses",
        async (path) => {
            const server = createServer(async (request, response) => {
                const chunks = [];
                for await (const chunk of request) chunks.push(chunk);
                response.writeHead(202, { "content-type": "application/json" });
                response.end(
                    JSON.stringify({
                        method: request.method,
                        path: request.url,
                        body: Buffer.concat(chunks).toString(),
                        marker: request.headers["x-provider-test"],
                    }),
                );
            });
            server.listen(0, "127.0.0.1");
            await once(server, "listening");
            const address = server.address() as { port: number };
            const host = `http://127.0.0.1:${address.port}`;
            try {
                const fetcher = routeProviderFetch(fetch, [["http://emulator:7073", host]]);
                const pending = fetcher(
                    new Request(`http://emulator:7073${path}`, {
                        method: "POST",
                        headers: { "x-provider-test": "retained" },
                        body: '{"arkTx":"original"}',
                    }),
                );
                await expect(pending).resolves.toHaveProperty("status", 202);
                const response = await pending;
                expect(await response.json()).toEqual({
                    method: "POST",
                    path,
                    body: '{"arkTx":"original"}',
                    marker: "retained",
                });
                const direct = await fetcher(`${host}/v1/info`);
                expect((await direct.json()).path).toBe("/v1/info");
            } finally {
                server.closeAllConnections();
                await new Promise<void>((resolve, reject) =>
                    server.close((error) => (error ? reject(error) : resolve())),
                );
            }
        },
    );
});
