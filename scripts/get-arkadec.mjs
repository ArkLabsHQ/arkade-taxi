import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

export const TAG = "v0.1.0-test";
const STEM = `arkade-compiler-${TAG}`;

export const ASSETS = {
    "darwin-arm64": `${STEM}-aarch64-apple-darwin.tar.gz`,
    "darwin-x64": `${STEM}-x86_64-apple-darwin.tar.gz`,
    "linux-arm64": `${STEM}-aarch64-unknown-linux-musl.tar.gz`,
    "linux-x64": `${STEM}-x86_64-unknown-linux-musl.tar.gz`,
    "win32-x64": `${STEM}-x86_64-pc-windows-msvc.zip`,
};

/**
 * Verbatim from the release's SHA256SUMS. `-test` is a pre-release tag with no
 * semver channel behind it, so the tag can be moved and the asset replaced; the
 * digest is what actually pins the compiler.
 */
export const DIGESTS = {
    [ASSETS["darwin-arm64"]]: "661cecc2338ca30f3cd546c0a7e9c76a5e91c76223c4514d4d55a19b0a0c023e",
    [ASSETS["darwin-x64"]]: "33a9c6b8de06dca396771489ff0e5c177d00492d8b1fdc6b0fed41c9c6bbcacc",
    [ASSETS["linux-arm64"]]: "e1e2d7008caa618cffb97008925e7c3659b20aef330066ea5e67451b4a18650c",
    [ASSETS["linux-x64"]]: "d4a1264e905eb5395d57247f819ab2ddb6a830c0b60f8fecc9c800d6f2fb5187",
    [ASSETS["win32-x64"]]: "911b3634770ce2ef64878d1fd02699f1975f03dc510cb332c0b25633246a6e10",
};

const DIR = ".reference/arkadec";
const EXE = process.platform === "win32" ? "arkadec.exe" : "arkadec";
export const BIN = resolve(DIR, EXE);

export function assetFor(platform = process.platform, arch = process.arch) {
    const asset = ASSETS[`${platform}-${arch}`];
    if (!asset) throw new Error(`arkadec: no pinned binary for ${platform}-${arch}`);
    return asset;
}

export function verifyAsset(asset, bytes) {
    const want = DIGESTS[asset];
    if (!want) throw new Error(`arkadec: no pinned digest for ${asset}`);
    const got = createHash("sha256").update(bytes).digest("hex");
    if (got !== want) throw new Error(`arkadec: ${asset} is ${got}, pinned at ${want}`);
}

export async function fetchArkadec() {
    if (existsSync(BIN)) return BIN;
    const asset = assetFor();
    const url = `https://github.com/arkade-os/compiler/releases/download/${TAG}/${asset}`;
    const response = await fetch(url);
    if (!response.ok) throw new Error(`arkadec: ${url} returned ${response.status}`);
    const bytes = new Uint8Array(await response.arrayBuffer());
    verifyAsset(asset, bytes);

    rmSync(DIR, { recursive: true, force: true });
    mkdirSync(DIR, { recursive: true });
    const archive = resolve(DIR, asset);
    writeFileSync(archive, bytes);
    // bsdtar on Windows reads the zip, GNU tar auto-detects the gzip.
    execFileSync("tar", ["-xf", archive, "-C", DIR], { stdio: "inherit" });
    renameSync(resolve(DIR, asset.replace(/\.(zip|tar\.gz)$/, ""), EXE), BIN);
    return BIN;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
    console.log(await fetchArkadec());
