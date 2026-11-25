import { readFileSync, readdirSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

const root = fileURLToPath(new URL("../../", import.meta.url));
const require = createRequire(import.meta.url);

it("resolves one SDK for the swap and every Taxi package that pins it", () => {
    const sdk = realpathSync(require.resolve("@arkade-os/sdk"));
    for (const from of [
        require.resolve("@arkade-os/swap"),
        ...["app", "client", "covenant"].map((name) =>
            join(root, "packages", name, "package.json"),
        ),
    ])
        expect(realpathSync(createRequire(from).resolve("@arkade-os/sdk"))).toBe(sdk);
});

it("bundles the directed contract the fill fixture pins in the installed swap", () => {
    const fixture = join(root, "packages/app/test/fixtures/asset-swap-directed.json");
    const { fingerprint } = JSON.parse(readFileSync(fixture, "utf8"));
    const dist = dirname(require.resolve("@arkade-os/swap"));
    const bundled = readdirSync(dist)
        .filter((file) => file.endsWith(".js"))
        .map((file) => readFileSync(join(dist, file), "utf8"))
        .join("\n");
    expect(bundled).toContain(fingerprint);
});
