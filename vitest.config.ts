import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

export default defineConfig({
    test: {
        include: ["packages/*/test/**/*.test.ts", "scripts/test/**/*.test.ts"],
        // The fill planner calls into @arkade-os/swap, which imports the SDK
        // itself. Left external, that import bypasses vi.mock and the builder
        // tests reach the network.
        server: { deps: { inline: ["@arkade-os/swap"] } },
    },
    resolve: {
        alias: {
            "@arkade-taxi/client": fileURLToPath(
                new URL("./packages/client/src/index.ts", import.meta.url),
            ),
        },
    },
});
