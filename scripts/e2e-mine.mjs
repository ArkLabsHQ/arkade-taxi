#!/usr/bin/env node
import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { explicitMine } from "./lib/harness.mjs";

export async function mineBlocks(blocks, options = {}) {
    const runner = options.runner ?? process.env.ARKADE_REGTEST_CLI;
    const envFile = options.envFile ?? process.env.ARKADE_REGTEST_ENV;
    if (!runner || !envFile)
        throw new Error("ARKADE_REGTEST_CLI and ARKADE_REGTEST_ENV are required");
    return explicitMine(
        blocks,
        (args) =>
            new Promise((resolve) => {
                const child = spawn(process.execPath, [runner, ...args, "--env", envFile], {
                    env: options.env ?? process.env,
                    stdio: ["ignore", "pipe", "pipe"],
                });
                let stdout = "";
                let stderr = "";
                child.stdout.on("data", (chunk) => (stdout += chunk));
                child.stderr.on("data", (chunk) => (stderr += chunk));
                child.on("error", (error) => resolve({ code: 1, stdout, stderr: error.message }));
                child.on("close", (code) => resolve({ code: code ?? 1, stdout, stderr }));
            }),
    );
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
    const blocks = Number(process.argv[2]);
    mineBlocks(blocks)
        .then((result) => process.stdout.write(`mined ${result.blocks} block(s)\n`))
        .catch((error) => {
            process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
            process.exitCode = 1;
        });
}
