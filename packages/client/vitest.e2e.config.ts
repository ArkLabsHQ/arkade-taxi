import { defineConfig } from "vitest/config";

export default defineConfig({
    test: {
        include: ["test/e2e/**/*.test.ts"],
        passWithNoTests: false,
        environment: "node",
        fileParallelism: false,
        reporters: ["verbose"],
        poolOptions: { forks: { execArgv: ["--experimental-eventsource"] } },
    },
});
