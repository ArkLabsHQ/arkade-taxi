import { afterEach, expect, it, vi } from "vitest";
import type { RuntimeConfig } from "../src/config.js";
import { renewalTemplateId } from "../src/delegatee.js";
import { config } from "./fixtures.js";

const h = vi.hoisted(() => ({
    config: undefined as RuntimeConfig | undefined,
    logged: [] as unknown[][],
    keeper: () => undefined,
    renewal: undefined as unknown,
}));
vi.mock("../src/config.js", async (original) => ({
    ...(await original<typeof import("../src/config.js")>()),
    loadConfig: () => h.config!,
    resolveRuntimeConfig: async () => h.config!,
}));
vi.mock("pino", () => {
    const at =
        (level: string) =>
        (...args: unknown[]) =>
            void h.logged.push([level, ...args]);
    return { pino: () => ({ isLevelEnabled: () => false, info: at("info"), error: at("error") }) };
});
vi.mock("../src/arkade/operatorWallet.js", async (original) => ({
    ...(await original<typeof import("../src/arkade/operatorWallet.js")>()),
    createOperatorRuntime: () => ({ providers: {} }),
}));
vi.mock("../src/arkade/renewal.js", async (original) => ({
    ...(await original<typeof import("../src/arkade/renewal.js")>()),
    covenantKeeper: () => h.keeper,
}));
vi.mock("../src/sweeper.js", async (original) => ({
    ...(await original<typeof import("../src/sweeper.js")>()),
    createSweeper: (deps: { renewal: unknown }) => {
        h.renewal = deps.renewal;
        throw new Error("startup reached the sweeper");
    },
}));

afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
});

it("renews in process when the Executor refuses the template upload", async () => {
    h.config = config({ delegateeUrl: "https://executor.example" });
    vi.stubGlobal("fetch", async (_url: unknown, init?: RequestInit) =>
        init?.method === "POST"
            ? new Response('{"code":7,"message":"served on the admin port only"}', { status: 403 })
            : new Response('{"code":5,"message":"template not found"}', { status: 404 }),
    );
    const exit = vi.spyOn(process, "exit").mockImplementation(() => undefined as never);
    const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    const argv = process.argv;
    process.argv = [argv[0]!, "cli", "serve"];
    try {
        await import("../src/cli.js");
        await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(1), { timeout: 10_000 });
    } finally {
        process.argv = argv;
    }
    expect(stderr).toHaveBeenCalledWith("startup reached the sweeper\n");
    expect(h.renewal).toBe(h.keeper);
    expect(h.logged).toContainEqual([
        "error",
        { error: expect.stringMatching(`${renewalTemplateId()}.*EXECUTOR_PUBLIC_REGISTRY=true`) },
        "delegatee unavailable, covenants renew in process",
    ]);
}, 30_000);
