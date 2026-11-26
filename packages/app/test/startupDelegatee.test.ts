import { afterEach, expect, it, vi } from "vitest";
import type { RuntimeConfig } from "../src/config";
import { renewalTemplateId } from "../src/delegatee";
import { config } from "./fixtures";

const h = vi.hoisted(() => ({
    config: undefined as RuntimeConfig | undefined,
    logged: [] as unknown[][],
    keeper: () => undefined,
    renewal: undefined as unknown,
}));
vi.mock("../src/config", async (original) => ({
    ...(await original<typeof import("../src/config")>()),
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
vi.mock("../src/arkade/operatorWallet", async (original) => ({
    ...(await original<typeof import("../src/arkade/operatorWallet")>()),
    createOperatorRuntime: () => ({ providers: {} }),
}));
vi.mock("../src/arkade/renewal", async (original) => ({
    ...(await original<typeof import("../src/arkade/renewal")>()),
    covenantKeeper: () => h.keeper,
}));
vi.mock("../src/sweeper", async (original) => ({
    ...(await original<typeof import("../src/sweeper")>()),
    createSweeper: (deps: { renewal: unknown }) => {
        h.renewal = deps.renewal;
        throw new Error("startup reached the sweeper");
    },
}));

afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
});

const adminOnly = () =>
    new Response('{"code":7,"message":"served on the admin port only"}', { status: 403 });

it.each([
    [
        "refuses the template upload",
        (init?: RequestInit) =>
            init?.method === "POST"
                ? adminOnly()
                : new Response('{"code":5,"message":"template not found"}', { status: 404 }),
        `${renewalTemplateId()}.*EXECUTOR_PUBLIC_REGISTRY=true`,
    ],
    ["refuses the template read", adminOnly, `/v1/template/${renewalTemplateId()} answered 403`],
    [
        "holds the template under another id",
        () => Response.json({ template: { id: "ff".repeat(32), status: "active" } }),
        `template ${"ff".repeat(32)} for renewal template ${renewalTemplateId()}`,
    ],
])(
    "renews in process when the Executor %s",
    async (_, answer, logged) => {
        vi.resetModules();
        h.logged = [];
        h.renewal = undefined;
        h.config = config({ delegateeUrl: "https://executor.example" });
        vi.stubGlobal("fetch", async (_url: unknown, init?: RequestInit) => answer(init));
        const exit = vi.spyOn(process, "exit").mockImplementation(() => undefined as never);
        const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
        const argv = process.argv;
        process.argv = [argv[0]!, "cli", "serve"];
        try {
            await import("../src/cli");
            await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(1), { timeout: 10_000 });
        } finally {
            process.argv = argv;
        }
        expect(stderr).toHaveBeenCalledWith("startup reached the sweeper\n");
        expect(h.renewal).toBe(h.keeper);
        expect(h.logged).toContainEqual([
            "error",
            { error: expect.stringMatching(logged) },
            "delegatee unavailable, covenants renew in process",
        ]);
    },
    30_000,
);
