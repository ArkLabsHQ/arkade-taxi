import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";
import { BaseSequencer } from "vitest/node";

class LiveSequencer extends BaseSequencer {
    async sort(files: Parameters<BaseSequencer["sort"]>[0]) {
        const order = [
            "provider-contract",
            "claim",
            "sponsored",
            // After the scenarios that pin fixture inventory, before the ones
            // that jump chain time past every wallet's expiry headroom.
            "joint-fill",
            "receiver-paid",
            "exposure",
            "verify-quote",
            "refund-recovery",
            "resilience",
            "suite-integrity",
        ];
        return [...files].sort(
            (a, b) =>
                order.findIndex((name) => a.moduleId.endsWith(`/${name}.e2e.test.ts`)) -
                order.findIndex((name) => b.moduleId.endsWith(`/${name}.e2e.test.ts`)),
        );
    }
}

const src = (name: string) =>
    fileURLToPath(new URL(`./packages/${name}/src/index.ts`, import.meta.url));
const clientEntry = process.env.TAXI_E2E_CLIENT_ENTRY || src("client");
// A dependency of the client package, not of the workspace root; same artifact.
const swapEntry = fileURLToPath(
    new URL("./packages/client/node_modules/@arkade-os/swap/dist/index.js", import.meta.url),
);

export default defineConfig({
    test: {
        include: ["e2e/**/*.e2e.test.ts"],
        // An empty run is the failure mode this suite exists to prevent: a job
        // that goes green having collected nothing. Never flip this to true.
        passWithNoTests: false,
        // A regtest round trip waits on arkd registering outputs, not on CPU.
        testTimeout: 300_000,
        hookTimeout: 300_000,
        teardownTimeout: 60_000,
        // One shared regtest chain and one operator ledger; files are not
        // independent of each other.
        fileParallelism: false,
        sequence: { sequencer: LiveSequencer },
        reporters: ["verbose"],
    },
    resolve: {
        // Pure checks use workspace source. The stack harness overrides only
        // the public client entry with its temporary consumer installation.
        alias: {
            "@arkade-taxi/covenant": src("covenant"),
            "@arkade-taxi/core": src("core"),
            "@arkade-taxi/protocol": src("protocol"),
            "@arkade-taxi/db": src("db"),
            "@arkade-taxi/client": clientEntry,
            "@arkade-os/swap": swapEntry,
        },
    },
});
