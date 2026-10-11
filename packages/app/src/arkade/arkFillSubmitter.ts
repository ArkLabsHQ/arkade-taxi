import {
    MultisigTapscript,
    Transaction,
    assertSubmittedArkTxid,
    matchServerCheckpoints,
    type ArkProvider,
    type EmulatorProvider,
} from "@arkade-os/sdk";
import {
    assertDefaultTapScriptSigs,
    setTapScriptSigEntries,
    tapLeavesOfInput,
} from "@arkade-taxi/client";
import { base64, hex } from "@scure/base";

const mergeSignatures = (original: Transaction, response: Transaction): Transaction => {
    // arkd rebuilds checkpoint maps, so retain the authenticated request metadata.
    const merged = original.clone();
    for (let i = 0; i < original.inputsLength; i++) {
        const leaves = tapLeavesOfInput(original, i);
        if (leaves.length !== 1) throw new Error(`Ark fill input ${i} has no unique spend leaf`);
        const leaf = leaves[0]!;
        const decoded = MultisigTapscript.decode(leaf.script);
        const keys = decoded.params.pubkeys.map((key) => hex.encode(key));
        if (
            leaf.version !== 0xc0 ||
            keys.length === 0 ||
            new Set(keys).size !== keys.length ||
            hex.encode(MultisigTapscript.encode(decoded.params).script) !== hex.encode(leaf.script)
        )
            throw new Error(`Ark fill input ${i} has no canonical multisig spend leaf`);
        const entries = new Map<
            string,
            { pubKey: Uint8Array; leafHash: Uint8Array; signature: Uint8Array }
        >();
        for (const tx of [original, response]) {
            const input = tx.getInput(i);
            if (
                input.tapKeySig?.length ||
                input.partialSig?.length ||
                input.finalScriptSig?.length ||
                input.finalScriptWitness?.length ||
                (input.sighashType !== undefined && input.sighashType !== 0)
            )
                throw new Error(`Ark fill input ${i} has an unsupported signature`);
            for (const [data, signature] of input.tapScriptSig ?? []) {
                const id = `${hex.encode(data.pubKey)}:${hex.encode(data.leafHash)}`;
                const prior = entries.get(id);
                if (prior && hex.encode(prior.signature) !== hex.encode(signature))
                    throw new Error(`Ark fill input ${i} has conflicting signatures`);
                entries.set(id, { ...data, signature });
            }
        }
        setTapScriptSigEntries(merged, i, [...entries.values()]);
        assertDefaultTapScriptSigs(merged, i, {
            allowedPubKeys: keys,
            leafHash: hex.decode(leaf.leafHashHex),
            context: `Ark fill input ${i}`,
        });
    }
    return merged;
};

export const createArkFillSubmitter = (
    ark: Pick<ArkProvider, "submitTx" | "finalizeTx">,
): Pick<EmulatorProvider, "submitTx"> => ({
    submitTx: async (arkTx: string, checkpointTxs: string[]) => {
        const originalArk = Transaction.fromPSBT(base64.decode(arkTx));
        const originalCheckpoints = checkpointTxs.map((psbt) =>
            Transaction.fromPSBT(base64.decode(psbt)),
        );
        if (new Set(originalCheckpoints.map((cp) => cp.id)).size !== originalCheckpoints.length)
            throw new Error("Ark fill repeats a checkpoint");
        const response = await ark.submitTx(arkTx, checkpointTxs);
        assertSubmittedArkTxid(response, originalArk, "Ark fill submitTx");
        const signedArk = mergeSignatures(
            originalArk,
            Transaction.fromPSBT(base64.decode(response.finalArkTx)),
        );
        const checkpoints = new Map(
            matchServerCheckpoints(
                [...response.signedCheckpointTxs],
                originalCheckpoints,
                "Ark fill submitTx",
            ).map(({ local, server }) => [local.id, mergeSignatures(local, server)]),
        );
        const signedCheckpointTxs = originalCheckpoints.map((cp) =>
            base64.encode(checkpoints.get(cp.id)!.toPSBT()),
        );
        await ark.finalizeTx(response.arkTxid, signedCheckpointTxs);
        return {
            signedArkTx: base64.encode(signedArk.toPSBT()),
            signedCheckpointTxs,
        };
    },
});
