import { execFileSync, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const regtest = resolve(process.env.ARKADE_REGTEST_DIR ?? join(root, "arkade-regtest"));
const revision = "c364ea8af124ca5f75d62d6cabf6436481e10dcc";
const client = join(root, "packages/client");
const env = join(client, ".env.regtest.example");
const command = process.argv[2];
if (!["up", "down", "reset", "test", "cycle"].includes(command))
    throw new Error("Usage: node scripts/client-regtest.mjs <up|down|reset|test|cycle>");
if (!existsSync(join(regtest, "regtest.mjs")))
    throw new Error(`Checkout ArkLabsHQ/arkade-regtest at ${revision} into ${regtest}`);
const actual = execFileSync("git", ["-C", regtest, "rev-parse", "HEAD"], {
    encoding: "utf8",
}).trim();
if (actual !== revision) throw new Error(`Expected arkade-regtest ${revision}, found ${actual}`);
const run = (args, cwd = root) => {
    const result = spawnSync(process.execPath, args, { cwd, stdio: "inherit", env: process.env });
    if (result.error) throw result.error;
    if (result.status !== 0)
        throw new Error(`Command failed (${result.status}): ${args.join(" ")}`);
};
const stack = (action) => run([join(regtest, "regtest.mjs"), action, "--env", env]);
const test = () =>
    run(
        [
            "--experimental-eventsource",
            join(root, "node_modules/vitest/vitest.mjs"),
            "run",
            "--config",
            "vitest.e2e.config.ts",
        ],
        client,
    );
if (command === "up") stack("start");
if (command === "down") stack("stop");
if (command === "reset") stack("clean");
if (command === "test") test();
if (command === "cycle") {
    stack("clean");
    try {
        stack("start");
        test();
    } finally {
        stack("stop");
    }
}
