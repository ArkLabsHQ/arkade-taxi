import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";

const REF = "49ae96d0241e7672e40b25543875538d4373fb80";
const BRANCH = "test/dust-free-transfer-covenant";
const DIR = ".reference/emulator";
const OUT = resolve("packages/covenant/test/vectors.json");

const run = (cmd, args, cwd) => execFileSync(cmd, args, { cwd, stdio: "inherit" });

if (!existsSync(DIR)) {
    mkdirSync(".reference", { recursive: true });
    run("git", [
        "clone",
        "--filter=blob:none",
        "--branch",
        BRANCH,
        "https://github.com/arkade-os/emulator",
        DIR,
    ]);
}
run("git", ["checkout", "-q", REF], DIR);

// Run inside the reference checkout so the generator resolves against the
// emulator's own module graph. A separate module would need a replace directive
// and a duplicated dependency set.
mkdirSync(`${DIR}/genvectors`, { recursive: true });
copyFileSync("tools/gen-vectors/main.go", `${DIR}/genvectors/main.go`);
run("go", ["run", "./genvectors", OUT], DIR);

console.log(`wrote ${OUT}`);
