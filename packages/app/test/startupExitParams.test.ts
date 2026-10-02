import { afterEach, expect, it, vi } from "vitest";
import { AdvanceRepository, type Database } from "@arkade-taxi/db";
import type { RuntimeConfig } from "../src/config.js";
import { advance, config } from "./fixtures.js";

const current = vi.hoisted(() => ({
    config: undefined as RuntimeConfig | undefined,
    seed: undefined as ((db: Database) => void) | undefined,
}));
vi.mock("../src/config.js", async (original) => ({
    ...(await original<typeof import("../src/config.js")>()),
    loadConfig: () => current.config!,
    resolveRuntimeConfig: async () => current.config!,
}));
vi.mock("@arkade-taxi/db", async (original) => {
    const actual = await original<typeof import("@arkade-taxi/db")>();
    return {
        ...actual,
        openDatabase: (path: string) => {
            const db = actual.openDatabase(path);
            current.seed?.(db);
            return db;
        },
    };
});
vi.mock("../src/arkade/operatorWallet.js", async (original) => ({
    ...(await original<typeof import("../src/arkade/operatorWallet.js")>()),
    createOperatorRuntime: () => {
        throw new Error("startup got past the exit params check");
    },
}));

afterEach(() => vi.restoreAllMocks());

it("refuses to start on a terminal advance written before the exit leaf", async () => {
    current.config = config();
    current.seed = (db) => {
        new AdvanceRepository(db).insert(advance({ state: "recycled" }));
        db.prepare(
            "UPDATE advances SET exit_signer_key = NULL, exit_delay_type = NULL, exit_delay_value = NULL",
        ).run();
    };
    const exit = vi.spyOn(process, "exit").mockImplementation(() => undefined as never);
    const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    const argv = process.argv;
    process.argv = [argv[0]!, "cli", "serve"];
    try {
        await import("../src/cli.js");
        await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(1));
    } finally {
        process.argv = argv;
    }
    expect(stderr).toHaveBeenCalledWith(
        expect.stringMatching(/written before the covenant exit leaf.*recreate the database/),
    );
}, 30_000);
