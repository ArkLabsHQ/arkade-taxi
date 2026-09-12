import { CSVMultisigTapscript, MultisigTapscript, VtxoScript } from "@arkade-os/sdk";
import { DustCovenantScript } from "@arkade-taxi/covenant";
import {
    config,
    fundingCoin,
    operatorKey,
    receiverKey,
    senderKey,
    serverKey,
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
        dust: 330n,
        topup: 230n,
        locktime: 899856n,
    };
    const covenant = new DustCovenantScript({
        params,
        serverKey,
        emulatorKey: config().emulatorPubkey,
        vtxoMinAmount: 10n,
    });
    return {
        advanceId: "golden",
        params,
        covenantAddress: covenant.address("ark", serverKey).encode(),
        fare: { currency: "sats", units: 10n },
        senderSats: 100n,
        senderInputs: [
            {
                txid: "ab".repeat(32),
                vout: 2,
                value: 100n,
                tapTree: senderTree.encode(),
                spendLeaf: senderTree.scripts[0],
                expiry: { kind: "height", value: 910000n },
            },
        ],
        funding: {
            inputs: [
                fundingCoin({
                    value: 1000,
                    script: Buffer.from(operatorTree.pkScript).toString("hex"),
                    tapTree: operatorTree.encode(),
                    forfeitTapLeafScript: operatorTree.leaves[0],
                    intentTapLeafScript: operatorTree.leaves[0],
                }),
            ],
            totalValue: 1000n,
            batchExpiry: { kind: "height", value: 900000n },
        },
    };
}
