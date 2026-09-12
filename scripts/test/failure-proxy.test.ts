import { createServer } from "node:http";
import { afterEach, expect, it } from "vitest";
import { createFailureProxy } from "../lib/failure-proxy.mjs";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
    for (const close of cleanup.splice(0).reverse()) await close();
});

async function setup() {
    let effects = 0;
    const upstream = createServer((request, response) => {
        if (request.method === "POST") effects++;
        response.setHeader("content-type", "application/json");
        response.end(JSON.stringify({ signerPubkey: "02" + "11".repeat(32), effects }));
    });
    await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
    cleanup.push(() => new Promise((resolve) => upstream.close(() => resolve())));
    const address = upstream.address() as { port: number };
    const proxy = await createFailureProxy({ arkd: `http://127.0.0.1:${address.port}` });
    cleanup.push(proxy.close);
    return { proxy, effects: () => effects };
}

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
