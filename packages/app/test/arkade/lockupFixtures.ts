import { CSVMultisigTapscript, MultisigTapscript, VtxoScript } from "@arkade-os/sdk";
import { DustCovenantScript, type ReceiverFare } from "@arkade-taxi/covenant";
import {
    config,
    fundingCoin,
    operatorKey,
    receiverKey,
    senderKey,
    serverKey,
    V2_DEADLINE,
} from "../fixtures.js";
import type { LockupBuildRequest } from "../../src/quotes.js";

export const senderTree = new VtxoScript([
    MultisigTapscript.encode({ pubkeys: [serverKey, senderKey] }).script,
]);
export const operatorTree = new VtxoScript([
    MultisigTapscript.encode({ pubkeys: [serverKey, operatorKey] }).script,
]);
export const unroll = CSVMultisigTapscript.encode({
    pubkeys: [serverKey],
    timelock: { type: "blocks", value: 144n },
});
export function buildRequest(): LockupBuildRequest {
    const params = {
        senderKey,
        receiverKey,
        operatorKey,
        operatorSignerKey: config().operatorSignerKey,
        exitDelay: config().exitDelay,
        dust: 330n,
        topup: 330n,
        locktime: V2_DEADLINE,
        claimMode: "recycle" as const,
    };
    const covenant = new DustCovenantScript({
        params,
        serverKey,
        emulatorKey: config().emulatorPubkey,
        vtxoMinAmount: 10n,
    });
    const expiry = V2_DEADLINE + 86_401n;
    return {
        advanceId: "golden",
        params,
        covenantAddress: covenant.address("ark", serverKey).encode(),
        fare: { currency: "sats", units: 330n },
        senderSats: 660n,
        senderInputs: [
            {
                txid: "ab".repeat(32),
                vout: 2,
                value: 660n,
                tapTree: senderTree.encode(),
                spendLeaf: senderTree.scripts[0],
                expiry: { kind: "time", value: expiry + 10_000n },
            },
        ],
        funding: {
            inputs: [
                fundingCoin({
                    value: 1000,
                    expiresAtHeight: undefined,
                    expiresAt: new Date(Number(expiry) * 1000),
                    script: Buffer.from(operatorTree.pkScript).toString("hex"),
                    tapTree: operatorTree.encode(),
                    forfeitTapLeafScript: operatorTree.leaves[0],
                    intentTapLeafScript: operatorTree.leaves[0],
                }),
            ],
            totalValue: 1000n,
            batchExpiry: { kind: "time", value: expiry },
        },
    };
}

/** The sender's sats return as change, which must reach dust: a sub-dust change
 * would be the lockup's third OP_RETURN. */
export function receiverPays(request: LockupBuildRequest, receiverFare: ReceiverFare): void {
    request.params.receiverFare = receiverFare;
    request.senderInputs[0]!.value = request.senderSats = request.params.dust;
}
