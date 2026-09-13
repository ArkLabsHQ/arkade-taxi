import { afterEach, expect, it, vi } from "vitest";
import { ArkAddress, SingleKey } from "@arkade-os/sdk";
import { fundingCoin, serverKey } from "../../packages/app/test/fixtures.js";
import { lock, quoteFor, type Live } from "../../e2e/fixtures.js";

const failures = vi.hoisted(() => ({ original: new Error("original refusal"), artifact: false }));
vi.mock("@arkade-taxi/protocol", () => import("../../packages/protocol/src/index.js"));
vi.mock("../../e2e/admission.js", () => ({
    preEffectRequest: async () => {
        throw failures.original;
    },
    submitWithReadiness: async () => {
        throw failures.original;
    },
}));
vi.mock("node:fs", async (original) => ({
    ...(await original<typeof import("node:fs")>()),
    appendFileSync: () => {
        if (failures.artifact) throw new Error("artifact unavailable");
    },
}));
afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
});

it.each([
    ["health", "quote"],
    ["artifact", "quote"],
    ["health", "submission"],
    ["artifact", "submission"],
])("preserves the exact %s failure during %s diagnostics", async (failure, operation) => {
    vi.stubEnv("TAXI_E2E_BASE_URL", "http://localhost:12345");
    vi.stubEnv("TAXI_E2E_PROJECT", "taxi-test");
    failures.artifact = failure === "artifact";
    vi.stubGlobal("fetch", async (url: string) => {
        if (url.endsWith("/ready"))
            return new Response(
                JSON.stringify({
                    status: "ok",
                    blockers: [],
                    sweeper: { lastTickAt: Math.floor(Date.now() / 1000) },
                }),
            );
        if (failure === "health") throw new Error("health unavailable");
        return new Response("{}");
    });
    const identity = SingleKey.fromPrivateKey(new Uint8Array(32).fill(2));
    const live = {
        actors: {
            sender: { identity },
            receiver: {
                wallet: {
                    getAddress: async () =>
                        new ArkAddress(serverKey, await identity.xOnlyPublicKey(), "ark").encode(),
                },
            },
        },
    } as unknown as Live;
    const result =
        operation === "quote"
            ? quoteFor(live, "receiver", fundingCoin())
            : lock(live, { verified: {} } as Awaited<ReturnType<typeof quoteFor>>);
    await expect(result).rejects.toBe(failures.original);
});
