import { isDeepStrictEqual } from "node:util";
import {
    MultisigTapscript,
    P2A,
    Transaction,
    VtxoScript,
    VtxoTaprootTree,
    getArkPsbtFields,
    scriptFromTapLeafScript,
    type CSVMultisigTapscript,
    type VirtualCoin,
} from "@arkade-os/sdk";
import { hex } from "@scure/base";
import { assertDefaultTapScriptSigs, tapLeavesOfInput } from "@arkade-taxi/client";
import { ServiceError } from "../errors.js";

const fail = (detail: string): never => {
    throw new ServiceError("fill_foreign_input_invalid", 400, `fill graph ${detail}`);
};

export function assertTaxiUnsigned(tx: Transaction, index: number): void {
    const input = tx.getInput(index);
    if (
        input.tapKeySig?.length ||
        input.tapScriptSig?.length ||
        input.partialSig?.length ||
        input.finalScriptSig?.length ||
        input.finalScriptWitness?.length ||
        (input.sighashType !== undefined && input.sighashType !== 0)
    )
        throw new ServiceError(
            "fill_taxi_input_signed",
            400,
            `Taxi input ${index} arrives already signed`,
        );
}

export function assertForeignInput(args: {
    arkTx: Transaction;
    checkpoint: Transaction;
    index: number;
    coin: VirtualCoin;
    serverKey: Uint8Array;
    serverUnroll: CSVMultisigTapscript.Type;
    emulatorCosigner?: string;
}): void {
    const { arkTx, checkpoint, index, coin } = args;
    let spendLeaf: Uint8Array;
    try {
        const input = checkpoint.getInput(0);
        const leaves = input.tapLeafScript;
        const [encoded] = getArkPsbtFields(checkpoint, 0, VtxoTaprootTree);
        if (!encoded || leaves?.length !== 1)
            fail(`foreign input ${index} has no unique tree and leaf`);
        const tree = VtxoScript.decode(encoded!);
        spendLeaf = scriptFromTapLeafScript(leaves![0]!);
        if (
            !isDeepStrictEqual(input.witnessUtxo, {
                amount: BigInt(coin.value),
                script: hex.decode(coin.script),
            }) ||
            hex.encode(tree.pkScript) !== coin.script.toLowerCase() ||
            !isDeepStrictEqual(leaves![0], tree.findLeaf(hex.encode(spendLeaf)))
        )
            fail(`foreign input ${index} differs from its observed coin`);
        const next = new VtxoScript([args.serverUnroll.script, spendLeaf]);
        if (
            checkpoint.version !== 3 ||
            checkpoint.lockTime !== 0 ||
            input.sequence !== 0xffffffff ||
            checkpoint.outputsLength !== 2 ||
            !isDeepStrictEqual(checkpoint.getOutput(0), {
                amount: BigInt(coin.value),
                script: next.pkScript,
            }) ||
            !isDeepStrictEqual(checkpoint.getOutput(1), P2A)
        )
            fail(`foreign checkpoint ${index} has invalid outputs`);
        const edge = arkTx.getInput(index);
        if (
            !isDeepStrictEqual(edge.witnessUtxo, checkpoint.getOutput(0)) ||
            !isDeepStrictEqual(edge.tapLeafScript, [next.findLeaf(hex.encode(spendLeaf))])
        )
            fail(`foreign ark input ${index} differs from its checkpoint`);
    } catch (cause) {
        if (cause instanceof ServiceError) throw cause;
        throw new ServiceError(
            "fill_foreign_input_invalid",
            400,
            `foreign input ${index} has invalid taproot evidence`,
            { cause },
        );
    }
    try {
        const keys = MultisigTapscript.decode(spendLeaf!).params.pubkeys.map((key) =>
            hex.encode(key),
        );
        const server = hex.encode(args.serverKey);
        const providerOnly =
            args.emulatorCosigner !== undefined &&
            keys.length === 2 &&
            new Set(keys).size === 2 &&
            keys.includes(server) &&
            keys.includes(args.emulatorCosigner);
        const required = keys.filter((key) => key !== server);
        if (!providerOnly && required.length === 0) throw new Error("no caller signer in leaf");
        for (const [tx, vin] of [
            [arkTx, index],
            [checkpoint, 0],
        ] as const) {
            const input = tx.getInput(vin);
            if (
                input.tapKeySig?.length ||
                input.partialSig?.length ||
                input.finalScriptSig?.length ||
                input.finalScriptWitness?.length ||
                (input.sighashType !== undefined && input.sighashType !== 0)
            )
                throw new Error("unsupported signature or sighash");
            if (providerOnly && input.tapScriptSig?.length)
                throw new Error("provider-only input arrives signed");
            const hash = hex.decode(tapLeavesOfInput(tx, vin)[0]!.leafHashHex);
            if (providerOnly && !input.tapScriptSig?.length) continue;
            assertDefaultTapScriptSigs(tx, vin, {
                allowedPubKeys: keys,
                requiredPubKeys: providerOnly ? [] : required,
                leafHash: hash,
                context: `foreign input ${index}`,
            });
        }
    } catch (cause) {
        throw new ServiceError(
            "fill_foreign_signature_invalid",
            400,
            `foreign input ${index} lacks valid caller authorization`,
            { cause },
        );
    }
}
