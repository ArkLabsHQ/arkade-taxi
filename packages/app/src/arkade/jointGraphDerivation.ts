import { Extension, ExtensionNotFoundError, P2A, Transaction } from "@arkade-os/sdk";
import { base64, hex } from "@scure/base";

export class JointGraphDerivationError extends Error {
    readonly code = "fill_graph_invalid";
}

interface DerivedJointInput {
    readonly owner: string | null;
    readonly txid: string;
    readonly vout: number;
}

export interface DerivedJointOutputAsset {
    readonly assetId: string;
    readonly units: bigint;
}

export interface DerivedJointOutput {
    readonly vout: number;
    readonly script: Uint8Array;
    readonly sats: bigint;
    readonly assets: readonly DerivedJointOutputAsset[];
}

const decodeTx = (psbt: string | Transaction, label: string): Transaction => {
    if (typeof psbt !== "string") return psbt;
    try {
        return Transaction.fromPSBT(base64.decode(psbt));
    } catch (cause) {
        throw new JointGraphDerivationError(`${label} is not a parsable PSBT`, { cause });
    }
};

/** Ark input i spends checkpoint i's output 0; the coin is what that checkpoint spends. */
export function deriveJointInputs(graph: {
    arkTx: string | Transaction;
    checkpoints: readonly (string | Transaction)[];
    inputOwners: readonly (string | null)[];
}): DerivedJointInput[] {
    const tx = decodeTx(graph.arkTx, "graph.arkTx");
    if (
        tx.inputsLength !== graph.inputOwners.length ||
        graph.checkpoints.length !== graph.inputOwners.length
    )
        throw new JointGraphDerivationError(
            "graph inputOwners, checkpoints and arkTx inputs must agree",
        );
    const seen = new Set<string>();
    return graph.inputOwners.map((owner, index) => {
        const checkpoint = decodeTx(graph.checkpoints[index]!, `graph.checkpoints[${index}]`);
        const edge = tx.getInput(index);
        if (!edge?.txid || hex.encode(edge.txid) !== checkpoint.id || edge.index !== 0)
            throw new JointGraphDerivationError(
                `graph.arkTx input ${index} does not spend its checkpoint`,
            );
        const input = checkpoint.inputsLength === 1 ? checkpoint.getInput(0) : undefined;
        if (!input?.txid || input.index === undefined)
            throw new JointGraphDerivationError(
                `graph checkpoint ${index} does not spend exactly one outpoint`,
            );
        const outpoint = `${hex.encode(input.txid)}:${input.index}`;
        if (seen.has(outpoint))
            throw new JointGraphDerivationError(`graph repeats outpoint ${outpoint}`);
        seen.add(outpoint);
        return {
            owner,
            txid: hex.encode(input.txid).toLowerCase(),
            vout: input.index,
        };
    });
}

const assetsByVout = (tx: Transaction): Map<number, DerivedJointOutputAsset[]> => {
    const byVout = new Map<number, DerivedJointOutputAsset[]>();
    let packet;
    try {
        let extensions = 0;
        for (let i = 0; i < tx.outputsLength; i++) {
            const output = tx.getOutput(i);
            if (!output.script || !Extension.isExtension(output.script)) continue;
            if (++extensions > 1 || output.amount !== 0n)
                throw new JointGraphDerivationError(
                    "graph extension must be unique and zero-value",
                );
        }
        packet = Extension.fromTx(tx).getAssetPacket();
    } catch (cause) {
        if (cause instanceof ExtensionNotFoundError) return byVout;
        if (cause instanceof JointGraphDerivationError) throw cause;
        throw new JointGraphDerivationError("graph asset packet is not parsable", { cause });
    }
    if (!packet) return byVout;
    for (const group of packet.groups) {
        if (!group.assetId)
            throw new JointGraphDerivationError("graph asset packet mints an asset without an id");
        const assetId = group.assetId.toString();
        for (const output of group.outputs) {
            const list = byVout.get(output.vout) ?? [];
            list.push({ assetId, units: BigInt(output.amount) });
            byVout.set(output.vout, list);
        }
    }
    return byVout;
};

export function deriveJointOutputs(graph: { arkTx: string | Transaction }): DerivedJointOutput[] {
    const tx = decodeTx(graph.arkTx, "graph.arkTx");
    const assets = assetsByVout(tx);
    const outputs: DerivedJointOutput[] = [];
    for (let vout = 0; vout < tx.outputsLength; vout++) {
        const { amount, script } = tx.getOutput(vout);
        if (amount === undefined || !script)
            throw new JointGraphDerivationError(`graph.arkTx output ${vout} has no value`);
        if (Extension.isExtension(script)) continue;
        const anchor =
            vout === tx.outputsLength - 1 &&
            amount === P2A.amount &&
            hex.encode(script) === hex.encode(P2A.script) &&
            !assets.has(vout);
        if (anchor) continue;
        outputs.push({
            vout,
            script: Uint8Array.from(script),
            sats: BigInt(amount),
            assets: assets.get(vout) ?? [],
        });
    }
    return outputs;
}
