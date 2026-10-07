import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = fileURLToPath(new URL(".", import.meta.url));
const vectors = resolve(here, "../v2-vectors.json");
const ref = process.argv[2] ?? JSON.parse(readFileSync(vectors, "utf8")).engine;
const dir = resolve(".reference/emulator-engine");

const run = (cmd, args, options = {}) => execFileSync(cmd, args, { stdio: "inherit", ...options });
const present = () => {
    try {
        execFileSync("git", ["cat-file", "-e", `${ref}^{commit}`], { cwd: dir, stdio: "ignore" });
        return true;
    } catch {
        return false;
    }
};

if (!existsSync(dir))
    run("git", ["clone", "-q", "--filter=blob:none", "https://github.com/arkade-os/emulator", dir]);
if (!present()) run("git", ["fetch", "-q", "origin", ref], { cwd: dir });
run("git", ["checkout", "-q", ref], { cwd: dir });
mkdirSync(resolve(dir, "taxiv2"), { recursive: true });
copyFileSync(resolve(here, "engine_test.go"), resolve(dir, "taxiv2/engine_test.go"));
run("go", ["test", "-count=1", "./taxiv2"], {
    cwd: dir,
    env: { ...process.env, TAXI_V2_VECTORS: vectors },
});
