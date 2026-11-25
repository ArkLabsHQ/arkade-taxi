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

// The other directed contracts' compiler fingerprints, as the vendored swap 0.1.16 manifest declared them.
const DIRECTED_FINGERPRINTS = {
    "asset-swap-directed-nonce":
        "sha256:2f73e3cff1728678b084400eec2cac058c6f4ba5fe131859d31a2723a75c56a6",
    "sats-swap-directed": "sha256:6ca61bf7ed8d8f65af3141da4e95fcc896863650127dd20949a84e72258053f4",
    "sats-swap-directed-nonce":
        "sha256:833b559dc05031b170c4376f2a894f59986ae0f815bdc8a63e97de6feccec8cb",
};

it("bundles every directed contract the Taxi fills against in the installed swap", () => {
    const fixture = join(root, "packages/app/test/fixtures/asset-swap-directed.json");
    const { fingerprint } = JSON.parse(readFileSync(fixture, "utf8"));
    const dist = dirname(require.resolve("@arkade-os/swap"));
    const bundled = readdirSync(dist)
        .filter((file) => file.endsWith(".js"))
        .map((file) => readFileSync(join(dist, file), "utf8"))
        .join("\n");
    for (const expected of [fingerprint, ...Object.values(DIRECTED_FINGERPRINTS)])
        expect(bundled).toContain(expected);
});
