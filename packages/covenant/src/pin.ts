import { Script } from "@scure/btc-signer";

const subDustScript = (xonlyKey: Uint8Array): Uint8Array => Script.encode(["RETURN", xonlyKey]);

/** The scriptPubKey a covenant-pinned payout must use. */
export function payoutPkScript(xonlyKey: Uint8Array, value: bigint, dust: bigint): Uint8Array {
    return value >= dust ? Script.encode(["OP_1", xonlyKey]) : subDustScript(xonlyKey);
}
