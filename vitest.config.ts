import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

export default defineConfig({
    test: { include: ["packages/*/test/**/*.test.ts", "scripts/test/**/*.test.ts"] },
    resolve: {
        alias: {
            "@arkade-taxi/client": fileURLToPath(
                new URL("./packages/client/src/index.ts", import.meta.url),
            ),
        },
    },
});
