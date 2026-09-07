import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const src = (name: string) =>
    fileURLToPath(new URL(`./packages/${name}/src/index.ts`, import.meta.url));

export default defineConfig({
    test: {
        include: ["e2e/**/*.e2e.test.ts"],
        // An empty run is the failure mode this suite exists to prevent: a job
        // that goes green having collected nothing. Never flip this to true.
        passWithNoTests: false,
        // A regtest round trip waits on arkd registering outputs, not on CPU.
        testTimeout: 180_000,
        hookTimeout: 300_000,
        teardownTimeout: 60_000,
        // One shared regtest chain and one operator ledger; files are not
        // independent of each other.
        fileParallelism: false,
        reporters: ["verbose"],
    },
    resolve: {
        // The root has no node_modules link to the workspace packages, so the
        // suite reaches them by path. Source, not dist, so `e2e` runs on a
        // fresh clone without a build and can never assert against stale bytes.
        alias: {
            "@arkade-taxi/covenant": src("covenant"),
            "@arkade-taxi/core": src("core"),
            "@arkade-taxi/protocol": src("protocol"),
            "@arkade-taxi/db": src("db"),
            "@arkade-taxi/client": src("client"),
        },
    },
});
