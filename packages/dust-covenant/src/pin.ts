import { sha256 } from "@noble/hashes/sha2.js";
import { Script } from "@scure/btc-signer";
import type { arkade } from "@arkade-os/sdk";

export function subDustScript(xonlyKey: Uint8Array): Uint8Array {
    return Script.encode(["RETURN", xonlyKey]);
}

/** The scriptPubKey a covenant-pinned payout must use. Must agree with pinOutput. */
export function payoutPkScript(xonlyKey: Uint8Array, value: bigint, dust: bigint): Uint8Array {
    return value >= dust ? Script.encode(["OP_1", xonlyKey]) : subDustScript(xonlyKey);
}

export function pinOutput(
    out: arkade.ArkadeScriptType,
    vout: number,
    xonlyKey: Uint8Array,
    value: bigint,
    dust: bigint,
): void {
    out.push(vout, "INSPECTOUTPUTSCRIPTPUBKEY");
    if (value >= dust) {
        out.push(1, "EQUALVERIFY", xonlyKey, "EQUALVERIFY");
        return;
    }
    out.push(-1, "EQUALVERIFY", sha256(subDustScript(xonlyKey)), "EQUALVERIFY");
}
