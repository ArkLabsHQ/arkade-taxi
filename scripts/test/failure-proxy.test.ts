import { createServer, request as httpRequest } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import { afterEach, expect, it, vi } from "vitest";
import { createFailureProxy } from "../lib/failure-proxy.mjs";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
    for (const close of cleanup.splice(0).reverse()) await close();
});

async function setup(serve?: (request: IncomingMessage, response: ServerResponse) => void) {
    let effects = 0;
    const upstream = createServer((request, response) => {
        if (serve) return serve(request, response);
        if (request.method === "POST") effects++;
        response.statusCode = request.url === "/unavailable" ? 503 : 200;
        response.setHeader("content-type", "application/json");
        response.end(JSON.stringify({ signerPubkey: "02" + "11".repeat(32), effects }));
    });
    await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
    cleanup.push(() => new Promise((resolve) => upstream.close(() => resolve())));
    const address = upstream.address() as { port: number };
    const proxy = await createFailureProxy({
        arkd: `http://127.0.0.1:${address.port}`,
        emulator: `http://127.0.0.1:${address.port}`,
    });
    cleanup.push(proxy.close);
    return { proxy, effects: () => effects };
}

it.each([
    ["arkd", "/v1/tx/submit", "emulator"],
    ["emulator", "/v1/tx", "arkd"],
])("retains %s submission counts after event eviction and reset", async (target, path, other) => {
    const { proxy } = await setup();
    const request = async (service: string, endpoint: string, method: string) => {
        const response = await fetch(`${proxy.url}/${service}${endpoint}`, { method });
        expect(response.status).toBe(200);
        await response.json();
    };
    const retainedSubmits = () =>
        proxy.events.filter(
            (event: any) =>
                event.target === target &&
                event.path === path &&
                event.method === "POST" &&
                event.action === "forwarded",
        );
    await request(target, `${path}?probe=1`, "POST");
    expect(retainedSubmits()).toHaveLength(1);
    const first = proxy.submissionCounts;
    for (let index = 1; index < 30000; index++)
        proxy.events.push({ target: "arkd", path: "/read", method: "GET", action: "forwarded" });
    await request(target, path, "GET");
    await request(other, path, "POST");
    await request(target, `${path}/extra`, "POST");
    expect(proxy.events).toHaveLength(30000);
    expect(retainedSubmits()).toHaveLength(0);
    expect(proxy.submissionCounts).toEqual({
        arkd: target === "arkd" ? 1 : 0,
        emulator: target === "emulator" ? 1 : 0,
    });
    proxy.reset();
    expect(proxy.submissionCounts).toEqual(first);
    await request(target, path, "POST");
    expect(proxy.submissionCounts).toEqual({ ...first, [target]: 2 });
    expect(first[target]).toBe(1);
});

it("drops exactly one response after the upstream mutation completed", async () => {
    const { proxy, effects } = await setup();
    proxy.configure({ target: "arkd", path: "/submit", mode: "drop", method: "POST" });
    const first = await fetch(`${proxy.url}/arkd/submit`, { method: "POST" }).then(
        () => "response",
        () => "dropped",
    );
    expect(first).toBe("dropped");
    expect(effects()).toBe(1);
    const next = await fetch(`${proxy.url}/arkd/submit`, { method: "POST" });
    expect(await next.json()).toMatchObject({ effects: 2 });
    expect(proxy.events.filter((event: any) => event.action === "dropped")).toHaveLength(1);
    const unavailable = await fetch(`${proxy.url}/arkd/unavailable`);
    expect(unavailable.status).toBe(503);
    expect(await unavailable.text()).toBe(
        JSON.stringify({ signerPubkey: "02" + "11".repeat(32), effects: 2 }),
    );
    const event = proxy.events.at(-1);
    expect(event).toMatchObject({ action: "forwarded", responseStatus: 503 });
    expect(Number.isFinite(event.responseAt)).toBe(true);
    expect(event.responseAt).toBeGreaterThanOrEqual(event.at);
});

it("distinguishes response headers from body completion and client finish", async () => {
    let finish: () => void = () => {
        throw new Error("upstream response has not started");
    };
    const { proxy } = await setup((_request, response) => {
        response.writeHead(200, { "content-type": "text/plain" });
        response.write("first");
        finish = () => response.end("last");
    });
    const response = await fetch(`${proxy.url}/arkd/stream`);
    const event = proxy.events.at(-1);
    expect(event.responseAt).toEqual(expect.any(Number));
    expect(event.responseEndAt).toBeUndefined();
    expect(event.clientFinishAt).toBeUndefined();
    finish();
    expect(await response.text()).toBe("firstlast");
    await vi.waitFor(() => expect(event.clientFinishAt).toEqual(expect.any(Number)));
    expect(event.responseEndAt).toBeGreaterThanOrEqual(event.responseAt);
    expect(event.clientFinishAt).toBeGreaterThanOrEqual(event.responseEndAt);
    expect(event.responseAbortedAt).toBeUndefined();
    expect(event.clientAbortAt).toBeUndefined();
});

it("records an unfinished client disconnect and upstream body abort without completion", async () => {
    const { proxy } = await setup((_request, response) => {
        response.writeHead(200, { "content-type": "text/event-stream" });
        response.write("data: open\n\n");
    });
    await new Promise<void>((resolve, reject) => {
        const request = httpRequest(`${proxy.url}/arkd/stream`, (response) => {
            response.on("error", () => {});
            response.destroy();
            resolve();
        });
        request.on("error", reject);
        request.end();
    });
    const event = proxy.events.at(-1);
    await vi.waitFor(() => {
        expect(event.clientAbortAt).toEqual(expect.any(Number));
        expect(event.responseAbortedAt).toEqual(expect.any(Number));
    });
    expect(event.clientAbortAt).toBeGreaterThanOrEqual(event.responseAt);
    expect(event.responseAbortedAt).toBeGreaterThanOrEqual(event.clientAbortAt);
    expect(event.responseEndAt).toBeUndefined();
    expect(event.clientFinishAt).toBeUndefined();
});

it("replaces only provider identity while preserving the real response", async () => {
    const { proxy } = await setup();
    proxy.configure({ target: "arkd", path: "/v1/info", mode: "identity" });
    const response = await fetch(`${proxy.url}/arkd/v1/info`);
    expect(await response.json()).toEqual({ signerPubkey: "03" + "22".repeat(32), effects: 0 });
    proxy.reset();
    expect(await fetch(`${proxy.url}/arkd/v1/info`).then((r) => r.json())).toMatchObject({
        signerPubkey: "02" + "11".repeat(32),
    });
});

it("holds real upstream reads until reset releases the waiting response", async () => {
    const { proxy } = await setup();
    proxy.configure({ target: "arkd", path: "/read", mode: "pause" });
    let received = false;
    const pending = fetch(`${proxy.url}/arkd/read`).then(async (response) => {
        received = true;
        return response.json();
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(received).toBe(false);
    proxy.reset();
    expect(await pending).toMatchObject({ effects: 0 });
});

it("pauses request reads without performing a mutation until released", async () => {
    const { proxy, effects } = await setup();
    proxy.configure({
        target: "arkd",
        path: "/submit",
        mode: "pause",
        phase: "request",
        method: "POST",
    });
    const pending = fetch(`${proxy.url}/arkd/submit`, { method: "POST", body: "mutation" });
    await new Promise((resolve) => setTimeout(resolve, 50));
    try {
        expect(effects()).toBe(0);
    } finally {
        proxy.reset();
        expect(await (await pending).json()).toMatchObject({ effects: 1 });
    }
});
