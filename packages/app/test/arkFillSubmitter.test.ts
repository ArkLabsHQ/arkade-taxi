import { describe, expect, it, vi } from "vitest";
import {
    buildOffchainTx,
    CSVMultisigTapscript,
    MultisigTapscript,
    SingleKey,
    Transaction,
    VtxoScript,
    type ArkProvider,
} from "@arkade-os/sdk";
import { base64, hex } from "@scure/base";
import { createArkFillSubmitter } from "../src/arkade/arkFillSubmitter.js";

const seeds = [1, 2, 3].map((n) => new Uint8Array(32).fill(n));
const identities = seeds.map((seed) => SingleKey.fromPrivateKey(seed));
const parse = (psbt: string) => Transaction.fromPSBT(base64.decode(psbt));
const encode = (tx: Transaction) => base64.encode(tx.toPSBT());

const fixture = async () => {
    const keys = await Promise.all(identities.map((identity) => identity.xOnlyPublicKey()));
    const trees = keys
        .slice(0, 2)
        .map(
            (owner) =>
                new VtxoScript([MultisigTapscript.encode({ pubkeys: [owner, keys[2]!] }).script]),
        );
    const unroll = CSVMultisigTapscript.encode({
        timelock: { type: "blocks", value: 10n },
        pubkeys: [keys[2]!],
    });
    const graph = buildOffchainTx(
        trees.map((tree, i) => ({
            txid: hex.encode(new Uint8Array(32).fill(i + 10)),
            vout: 0,
            value: 1_000,
            tapLeafScript: tree.leaves[0]!,
            tapTree: tree.encode(),
        })),
        [{ script: trees[0]!.pkScript, amount: 2_000n }],
        unroll,
    );
    let ark = graph.arkTx;
    const owners = [] as Transaction[];
    for (let i = 0; i < 2; i++) {
        ark = await identities[i]!.sign(ark, [i]);
        owners.push(await identities[i]!.sign(graph.checkpoints[i]!, [0]));
    }
    const finalArk = await identities[2]!.sign(ark.clone());
    const serverCheckpoints = await Promise.all(
        graph.checkpoints.map(async (checkpoint) => {
            const rebuilt = checkpoint.clone();
            rebuilt.updateInput(0, { unknown: undefined });
            return identities[2]!.sign(rebuilt);
        }),
    );
    const response = {
        arkTxid: ark.id,
        finalArkTx: encode(finalArk),
        signedCheckpointTxs: serverCheckpoints.map(encode),
    };
    const submitTx = vi.fn(async () => response);
    const finalizeTx = vi.fn(async () => {});
    const provider = { submitTx, finalizeTx } as Pick<ArkProvider, "submitTx" | "finalizeTx">;
    return { ark, owners, response, serverCheckpoints, submitTx, finalizeTx, provider };
};

describe("direct Ark fill submission", () => {
    it("restores caller and Taxi signatures onto server-only rebuilt checkpoints", async () => {
        const f = await fixture();
        expect(f.serverCheckpoints.every((cp) => cp.getInput(0).tapScriptSig!.length === 1)).toBe(
            true,
        );
        expect(f.serverCheckpoints.every((cp) => cp.getInput(0).unknown === undefined)).toBe(true);
        expect(f.owners.every((cp) => cp.getInput(0).unknown!.length > 0)).toBe(true);
        const result = await createArkFillSubmitter(f.provider).submitTx(
            encode(f.ark),
            f.owners.map(encode),
        );
        expect(f.submitTx).toHaveBeenCalledOnce();
        expect(f.finalizeTx).toHaveBeenCalledOnce();
        expect(f.finalizeTx).toHaveBeenCalledWith(f.ark.id, result.signedCheckpointTxs);
        result.signedCheckpointTxs.forEach((psbt, index) => {
            const merged = parse(psbt);
            expect(merged.id).toBe(f.owners[index]!.id);
            expect(merged.getInput(0).tapScriptSig).toHaveLength(2);
            expect(merged.getInput(0).tapScriptSig).toEqual(
                expect.arrayContaining(f.owners[index]!.getInput(0).tapScriptSig!),
            );
            expect(merged.getInput(0).unknown).toEqual(f.owners[index]!.getInput(0).unknown);
        });
    });

    it("matches reordered checkpoints by txid", async () => {
        const f = await fixture();
        f.response.signedCheckpointTxs.reverse();
        const result = await createArkFillSubmitter(f.provider).submitTx(
            encode(f.ark),
            f.owners.map(encode),
        );
        expect(result.signedCheckpointTxs.map((psbt) => parse(psbt).id)).toEqual(
            f.owners.map((cp) => cp.id),
        );
        expect(f.finalizeTx).toHaveBeenCalledOnce();
    });

    it.each([
        "reported txid",
        "Ark output",
        "checkpoint missing",
        "checkpoint duplicate",
        "checkpoint extra",
        "checkpoint output",
        "server signature invalid",
        "server signature missing",
        "server signature wrong leaf",
        "server signature non-default",
        "owner signature conflict",
        "owner signature missing",
        "owner signature invalid",
        "Ark server signature invalid",
        "Ark server signature missing",
        "server signature wrong amount",
    ])("refuses %s before finalization", async (change) => {
        const f = await fixture();
        const checkpoint = f.serverCheckpoints[0]!.clone();
        const ark = parse(f.response.finalArkTx);
        if (change === "reported txid") f.response.arkTxid = "ff".repeat(32);
        if (change === "Ark output") {
            ark.updateOutput(0, { amount: 1_999n }, true);
            f.response.finalArkTx = encode(ark);
        }
        if (change === "checkpoint missing") f.response.signedCheckpointTxs.pop();
        if (change === "checkpoint duplicate")
            f.response.signedCheckpointTxs[1] = f.response.signedCheckpointTxs[0]!;
        if (change === "checkpoint extra")
            f.response.signedCheckpointTxs.push(f.response.signedCheckpointTxs[0]!);
        if (change === "checkpoint output") checkpoint.updateOutput(0, { amount: 999n }, true);
        const entries = checkpoint.getInput(0).tapScriptSig!;
        if (change === "server signature invalid") entries[0]![1][0] ^= 1;
        if (change === "server signature missing")
            checkpoint.updateInput(0, { tapScriptSig: undefined });
        if (change === "server signature wrong leaf") entries[0]![0].leafHash[0] ^= 1;
        if (change === "server signature non-default") entries[0]![1] = new Uint8Array(65);
        if (change === "owner signature conflict") {
            const owner = structuredClone(f.owners[0]!.getInput(0).tapScriptSig![0]!);
            owner[1][0] ^= 1;
            entries.push(owner);
        }
        if (change === "owner signature missing")
            f.owners[0]!.updateInput(0, { tapScriptSig: undefined });
        if (change === "owner signature invalid") {
            const ownerEntries = f.owners[0]!.getInput(0).tapScriptSig!;
            ownerEntries[0]![1][0] ^= 1;
            f.owners[0]!.updateInput(0, { tapScriptSig: undefined });
            f.owners[0]!.updateInput(0, { tapScriptSig: ownerEntries });
        }
        if (change === "Ark server signature invalid") {
            const input = ark.getInput(0);
            input.tapScriptSig!.at(-1)![1][0] ^= 1;
            ark.updateInput(0, { tapScriptSig: undefined });
            ark.updateInput(0, { tapScriptSig: input.tapScriptSig });
            f.response.finalArkTx = encode(ark);
        }
        if (change === "Ark server signature missing") {
            const ownerEntries = f.ark.getInput(0).tapScriptSig;
            ark.updateInput(0, { tapScriptSig: undefined });
            ark.updateInput(0, { tapScriptSig: ownerEntries });
            f.response.finalArkTx = encode(ark);
        }
        if (change === "server signature wrong amount") {
            checkpoint.updateInput(0, { tapScriptSig: undefined });
            checkpoint.updateInput(
                0,
                { witnessUtxo: { ...checkpoint.getInput(0).witnessUtxo!, amount: 999n } },
                true,
            );
            const incorrectlySigned = await identities[2]!.sign(checkpoint);
            f.response.signedCheckpointTxs[0] = encode(incorrectlySigned);
        }
        if (
            (change.startsWith("server signature") && change !== "server signature wrong amount") ||
            change === "checkpoint output" ||
            change === "owner signature conflict"
        ) {
            checkpoint.updateInput(0, { tapScriptSig: undefined });
            if (change !== "server signature missing")
                checkpoint.updateInput(0, { tapScriptSig: entries });
            f.response.signedCheckpointTxs[0] = encode(checkpoint);
        }
        await expect(
            createArkFillSubmitter(f.provider).submitTx(encode(f.ark), f.owners.map(encode)),
        ).rejects.toThrow();
        expect(f.finalizeTx).not.toHaveBeenCalled();
    });

    it("propagates finalization failure without another submit or finalize", async () => {
        const f = await fixture();
        const failure = new Error("finalization reply lost");
        f.finalizeTx.mockRejectedValueOnce(failure);
        await expect(
            createArkFillSubmitter(f.provider).submitTx(encode(f.ark), f.owners.map(encode)),
        ).rejects.toBe(failure);
        expect(f.submitTx).toHaveBeenCalledOnce();
        expect(f.finalizeTx).toHaveBeenCalledOnce();
    });
});
