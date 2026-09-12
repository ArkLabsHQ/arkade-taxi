import { copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { assertArtifactSafe, buildStackManifest } from "./lib/harness.mjs";

const git = (repo, args, options = {}) =>
    execFileSync("git", ["-C", repo, ...args], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        ...options,
    }).trim();

export function captureTaxiIdentity(repo) {
    const commit = git(repo, ["rev-parse", "HEAD"]);
    const realIndex = git(repo, ["rev-parse", "--git-path", "index"]);
    const index = join(tmpdir(), `taxi-e2e-index-${randomUUID()}`);
    copyFileSync(resolve(repo, realIndex), index);
    try {
        const env = { ...process.env, GIT_INDEX_FILE: index };
        git(repo, ["add", "-A"], { env });
        const tree = git(repo, ["write-tree"], { env });
        if (!/^[0-9a-f]{40}$/.test(commit) || !/^[0-9a-f]{40}$/.test(tree))
            throw new Error("Taxi Git identity is malformed");
        return { commit, tree, dirty: git(repo, ["status", "--porcelain"]).length > 0 };
    } finally {
        const target = resolve(index);
        if (!target.startsWith(resolve(tmpdir()) + sep))
            throw new Error("refusing to remove a non-temporary alternate index");
        rmSync(target, { force: true });
    }
}

export function writeStackManifest(path, input) {
    const manifest = buildStackManifest(input);
    assertArtifactSafe(manifest, input.knownSecrets);
    mkdirSync(resolve(path, ".."), { recursive: true });
    writeFileSync(path, `${JSON.stringify(manifest, null, 2)}\n`, { encoding: "utf8" });
    const persisted = JSON.parse(readFileSync(path, "utf8"));
    assertArtifactSafe(persisted, input.knownSecrets);
    return persisted;
}
