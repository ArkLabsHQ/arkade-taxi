import { createServer } from "node:net";
import { writeSync } from "node:fs";
import { createServiceLifecycle, shutdownFatalDiagnostic } from "../../src/lifecycle.ts";

const server = createServer();
const activeProviderHandle = setInterval(() => {}, 1_000);
const privateProviderError = "never-settling provider PRIVATE_PROVIDER_CREDENTIAL";
const lifecycle = createServiceLifecycle({
    listen: async () => {
        await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
        process.send?.({ type: "listening", port: server.address().port });
        let closing;
        return {
            stopAccepting() {
                closing ??= new Promise((resolve, reject) =>
                    server.close((error) => (error ? reject(error) : resolve())),
                );
                process.send?.({ type: "stop-accepting" });
            },
            finished: () => closing ?? Promise.resolve(),
        };
    },
    verifyRuntime: () => new Promise(() => void privateProviderError),
    reconcile: async () => {},
    firstRecoveryTick: async () => {},
    startStreams: async () => {},
    startBackground: () => {},
    stopBackground: () => {},
    stopRuntime: () => process.send?.({ type: "runtime-stopped" }),
    abort: () => {},
    drain: async () => {},
    disposeProviders: async () => {},
    closeDatabase: () => process.send?.({ type: "db-closed" }),
    shutdownTimeoutMs: 50,
    forceTerminate(code, reason) {
        writeSync(process.stderr.fd, `${shutdownFatalDiagnostic(reason)}\n`);
        process.exit(code);
    },
});

process.on("message", (message) => {
    if (message === "stop") void lifecycle.stop();
});
await lifecycle.start();
