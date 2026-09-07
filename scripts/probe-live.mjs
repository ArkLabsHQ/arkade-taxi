/**
 * Derive a covenant against a LIVE arkd and emulator, and check the parameters
 * this deployment would actually be quoted under. Read-only: it opens no
 * wallet, signs nothing and submits nothing.
 *
 *   node scripts/probe-live.mjs [arkdUrl] [emulatorUrl]
 */

import { DustCovenantScript, buildScripts, emitArtifact } from "../packages/covenant/dist/index.js";
import { arkade } from "@arkade-os/sdk";
import { schnorr } from "@noble/curves/secp256k1.js";
import { hex } from "@scure/base";

const ARKD = process.argv[2] ?? "http://127.0.0.1:7070";
const EMULATOR = process.argv[3] ?? "http://127.0.0.1:7073";

const get = async (url) => {
    const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
    if (!res.ok) throw new Error(`${url} -> ${res.status}`);
    return res.json();
};

// arkd and the emulator publish COMPRESSED keys; every covenant leaf takes
// x-only. Dropping the parity byte is the conversion, not a truncation.
const xonly = (compressed) => hex.decode(compressed).slice(1);

const key = (seed) => schnorr.getPublicKey(new Uint8Array(32).fill(seed));

const info = await get(`${ARKD}/v1/info`);
const emu = await get(`${EMULATOR}/v1/info`);

const serverKey = xonly(info.signerPubkey);
const emulatorKey = xonly(emu.signerPubkey);
const dust = BigInt(info.dust);
const vtxoMinAmount = BigInt(info.vtxoMinAmount);

console.log(`arkd      ${info.version}  network=${info.network}`);
console.log(`emulator  ${emu.version}`);
console.log(
    `dust=${dust}  vtxoMinAmount=${vtxoMinAmount}  subDustWindowOpen=${vtxoMinAmount < dust}`,
);
console.log(`serverKey   ${hex.encode(serverKey)}`);
console.log(`emulatorKey ${hex.encode(emulatorKey)}\n`);

const params = {
    receiverKey: key(1),
    senderKey: key(2),
    operatorKey: key(3),
    dust,
    topup: dust,
    locktime: 800_000n,
};

for (const [label, p] of [
    ["bitcoin", params],
    ["asset", { ...params, assetId: { txid: new Uint8Array(32).fill(0x11), groupIndex: 0 } }],
]) {
    const script = new DustCovenantScript({ serverKey, emulatorKey, params: p, vtxoMinAmount });
    const scripts = buildScripts(p, vtxoMinAmount);
    const artifact = emitArtifact(p, vtxoMinAmount);

    console.log(`--- ${label} variant ---`);
    console.log(`  leaves       ${script.scripts.length}`);
    console.log(`  address      ${script.address("tark", serverKey).encode()}`);
    console.log(`  pkScript     ${hex.encode(script.pkScript)}`);
    console.log(`  recycle      ${scripts.recycle.length} bytes`);
    console.log(`  purchase     ${scripts.purchase.length} bytes`);
    console.log(`  refund       ${scripts.refund.length} bytes`);
    console.log(`  artifact fns ${Object.keys(artifact.functions).join(", ")}`);

    // Decoding proves the bytes are a well-formed Arkade script under the same
    // opcode table the emulator runs, not merely a buffer we produced.
    const decoded = arkade.ArkadeScript.decode(scripts.recycle);
    console.log(`  recycle asm  ${decoded.length} tokens, first=${decoded[0]}\n`);
}

console.log("read-only: nothing was signed, funded or submitted.");
