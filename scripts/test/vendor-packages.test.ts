import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

const root = fileURLToPath(new URL("../../", import.meta.url));
const require = createRequire(import.meta.url);
const manifest = (path: string) => JSON.parse(readFileSync(path, "utf8"));
const packageRoot = (name: string, from = require): string => {
    let path = dirname(from.resolve(name));
    for (;;) {
        const file = join(path, "package.json");
        if (existsSync(file) && manifest(file).name === name) return path;
        const parent = dirname(path);
        if (parent === path) throw new Error(`Package manifest not found: ${name}`);
        path = parent;
    }
};

it.each(["sdk", "swap"])(
    "authenticates the installed %s vendor and its resolved entry",
    (directory) => {
        const declared = manifest(join(root, "vendor", directory, "manifest.json"));
        expect(declared.file).toMatch(new RegExp(`-${declared.source.commit.slice(0, 8)}\\.tgz$`));
        const archive = join(root, "vendor", directory, declared.file);
        const bytes = readFileSync(archive);
        expect(bytes.length).toBe(declared.bytes);
        expect(createHash("sha256").update(bytes).digest("hex")).toBe(declared.sha256);
        expect(`sha512-${createHash("sha512").update(bytes).digest("base64")}`).toBe(
            declared.integrity,
        );
        const packed = JSON.parse(
            execFileSync("tar", ["-xOf", archive, "package/package.json"], {
                encoding: "utf8",
                timeout: 10_000,
            }),
        );
        expect(packed.name).toBe(declared.package);
        expect(packed.version).toBe(declared.version);
        expect(packed.version).toMatch(/-taxi\.\d+$/);
        const installed = packageRoot(declared.package);
        expect(manifest(join(installed, "package.json"))).toEqual(packed);
        const entry = realpathSync(require.resolve(declared.package));
        const member = relative(installed, entry).replaceAll("\\", "/");
        expect(member.startsWith("dist/")).toBe(true);
        expect(readFileSync(entry)).toEqual(
            execFileSync("tar", ["-xOf", archive, `package/${member}`], {
                timeout: 10_000,
                maxBuffer: 16 * 1024 * 1024,
            }),
        );
        const sdk = realpathSync(require.resolve("@arkade-os/sdk"));
        for (const consumer of [
            installed,
            join(root, "packages/app"),
            join(root, "packages/client"),
        ])
            expect(
                realpathSync(
                    createRequire(join(consumer, "package.json")).resolve("@arkade-os/sdk"),
                ),
            ).toBe(sdk);
    },
);

it("retains the declared compiler fingerprints in the sealed swap", () => {
    const declared = manifest(join(root, "vendor/swap/manifest.json"));
    const dist = join(packageRoot("@arkade-os/swap"), "dist");
    const bundled = readdirSync(dist)
        .filter((file) => file.endsWith(".js"))
        .map((file) => readFileSync(join(dist, file), "utf8"))
        .join("\n");
    for (const artifact of declared.compiler.artifacts)
        expect(bundled).toContain(artifact.fingerprint);
});
