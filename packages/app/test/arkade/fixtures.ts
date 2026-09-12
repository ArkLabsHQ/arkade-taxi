import { CSVMultisigTapscript, type ArkInfo } from "@arkade-os/sdk";
import { bytesToHex } from "@arkade-taxi/protocol";
import { serverKey } from "../fixtures.js";

export const arkInfo = (over: Partial<ArkInfo> = {}): ArkInfo => ({
    signerPubkey: "02" + bytesToHex(serverKey),
    forfeitPubkey: "02" + bytesToHex(serverKey),
    checkpointTapscript: bytesToHex(
        CSVMultisigTapscript.encode({
            pubkeys: [serverKey],
            timelock: { type: "blocks", value: 5n },
        }).script,
    ),
    network: "regtest",
    boardingExitDelay: 180n,
    unilateralExitDelay: 5n,
    dust: 330n,
    vtxoMinAmount: 10n,
    vtxoMaxAmount: -1n,
    utxoMinAmount: 330n,
    utxoMaxAmount: -1n,
    vtxoTreeExpiry: 180n,
    sessionDuration: 1n,
    deprecatedSigners: [],
    digest: "digest",
    fees: {
        intentFee: {
            offchainInput: "0",
            onchainInput: "0",
            offchainOutput: "0",
            onchainOutput: "0",
        },
        txFeeRate: "0",
    },
    forfeitAddress: "bcrt1p",
    serviceStatus: {},
    version: "test",
    ...over,
});
