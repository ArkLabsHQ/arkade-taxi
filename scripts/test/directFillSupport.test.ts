import { describe, expect, it, vi } from "vitest";
import {
    CSVMultisigTapscript,
    DefaultVtxo,
    Extension,
    SingleKey,
    Transaction,
    type ArkProvider,
    type ExtendedVirtualCoin,
    type Wallet,
} from "@arkade-os/sdk";
import { base64, hex } from "@scure/base";
import { buildDirectFillGraph, finalizeAcceptedDirectFill } from "../../e2e/directFillGraph.js";

const identities = [1, 2, 3].map((fill) => SingleKey.fromPrivateKey(new Uint8Array(32).fill(fill)));
const assetId = "aa".repeat(32) + "0000";
const otherAsset = "bb".repeat(32) + "0000";
const encode = (tx: Transaction) => base64.encode(tx.toPSBT());
const parse = (psbt: string) => Transaction.fromPSBT(base64.decode(psbt));

const fixture = async () => {
    const [callerKey, operatorKey, serverKey] = await Promise.all(
        identities.map((identity) => identity.xOnlyPublicKey()),
    );
    const trees = [callerKey!, operatorKey!].map(
        (pubKey) =>
            new DefaultVtxo.Script({
                pubKey,
                serverPubKey: serverKey!,
                csvTimelock: { type: "blocks", value: 10n },
            }),
    );
    const coin = (index: number, value: number) => ({
        txid: hex.encode(new Uint8Array(32).fill(index + 10)),
        vout: 0,
        value,
        tapTree: trees[index]!.encode(),
        tapLeafScript: trees[index]!.forfeit(),
    });
    const args = {
        callerInputs: [
            {
                ...coin(0, 2_000),
                assets: [
                    { assetId, amount: 10_000n },
                    { assetId: otherAsset, amount: 200n },
                ],
            },
        ],
        taxiInputs: [coin(1, 5_000)],
        callerScript: trees[0]!.pkScript,
        covenantScript: trees[0]!.pkScript,
        operatorScript: trees[1]!.pkScript,
        callerKey: callerKey!,
        operatorKey: operatorKey!,
        serverKey: serverKey!,
        assetId,
        assetUnits: 1_000n,
        covenantSats: 330n,
        loanSats: 330n,
        senderFareSats: 0n,
        dust: 330n,
        vtxoMinAmount: 330n,
        unroll: CSVMultisigTapscript.encode({
            pubkeys: [serverKey!],
            timelock: { type: "blocks", value: 10n },
        }),
    };
    return { args, callerKey, operatorKey, serverKey };
};

describe("ordinary direct fill graph", () => {
    it("aggregates every caller input before deriving Taxi checkpoint indexes", async () => {
        const { args } = await fixture();
        const original = args.callerInputs[0]!;
        original.value = 1_500;
        original.assets[0]!.amount = 9_000n;
        args.callerInputs.push({
            ...original,
            txid: "cc".repeat(32),
            value: 500,
            assets: [{ assetId, amount: 1_000n }],
        });
        const graph = buildDirectFillGraph(args);
        expect(graph.callerInputIndexes).toEqual([0, 1]);
        expect(graph.taxiInputIndexes).toEqual([2]);
        expect(graph.checkpoints).toHaveLength(3);
        expect(graph.callerChange).toBe(2_000n);
        const group = Extension.fromTx(graph.arkTx).getAssetPacket()!.groups[0]!;
        expect(group.inputs.map((input) => [input.vin, input.amount])).toEqual([
            [0, 9_000n],
            [1, 1_000n],
        ]);
        expect(group.outputs.map((output) => [output.vout, output.amount])).toEqual([
            [0, 1_000n],
            [1, 9_000n],
        ]);
    });
    it("conserves every asset and sats while funding exactly the quoted loan", async () => {
        const { args } = await fixture();
        const graph = buildDirectFillGraph(args);
        expect(graph.taxiInputIndexes).toEqual([1]);
        expect(graph.arkTx.getOutput(0).amount).toBe(330n);
        expect(graph.arkTx.getOutput(1).amount).toBe(2_000n);
        expect(graph.arkTx.getOutput(2).amount).toBe(4_670n);
        const packet = Extension.fromTx(graph.arkTx).getAssetPacket()!;
        const groups = packet.groups.map((group) => ({
            id: group.assetId!.toString(),
            inputs: group.inputs.map((input) => [input.vin, input.amount]),
            outputs: group.outputs.map((output) => [output.vout, output.amount]),
        }));
        expect(groups).toEqual([
            {
                id: assetId,
                inputs: [[0, 10_000n]],
                outputs: [
                    [0, 1_000n],
                    [1, 9_000n],
                ],
            },
            { id: otherAsset, inputs: [[0, 200n]], outputs: [[1, 200n]] },
        ]);
        expect(Extension.fromTx(graph.arkTx).getPackets()).toHaveLength(1);
        expect(Extension.fromTx(graph.arkTx).getEmulatorPacket()).toBeNull();
        expect(graph.checkpoints).toHaveLength(2);
    });

    it.each([
        ["caller shortfall", "caller change is below its floor"],
        ["wrong owner", "is not canonical owner/server multisig"],
        ["asset shortfall", "asset shortfall"],
    ])("refuses %s before signing", async (change, reason) => {
        const { args } = await fixture();
        if (change === "caller shortfall") args.senderFareSats = 1_900n;
        if (change === "wrong owner") args.callerKey = args.operatorKey;
        if (change === "asset shortfall") args.assetUnits = 10_001n;
        expect(() => buildDirectFillGraph(args)).toThrow(reason);
    });
});

const acceptedFixture = async () => {
    const { args } = await fixture();
    const graph = buildDirectFillGraph(args);
    graph.arkTx = await identities[0]!.sign(graph.arkTx, [0]);
    graph.checkpoints[0] = await identities[0]!.sign(graph.checkpoints[0]!, [0]);
    let finalArk = await identities[1]!.sign(graph.arkTx.clone(), [1]);
    finalArk = await identities[2]!.sign(finalArk);
    const serverCheckpoints = await Promise.all(
        graph.checkpoints.map(async (checkpoint) => {
            const rebuilt = checkpoint.clone();
            rebuilt.updateInput(0, { tapScriptSig: undefined, unknown: undefined });
            return identities[2]!.sign(rebuilt);
        }),
    );
    const pending = {
        arkTxid: graph.arkTx.id,
        finalArkTx: encode(finalArk),
        signedCheckpointTxs: serverCheckpoints.map(encode).reverse(),
    };
    const getPendingTxs = vi.fn(async () => [pending]);
    const finalizeTx = vi.fn(async () => {});
    const makeGetPendingTxIntentSignature = vi.fn(async () => ({
        proof: "retained caller coin ownership proof",
        message: { type: "get-pending-tx" as const, expire_at: 0 },
    }));
    return {
        graph,
        pending,
        serverCheckpoints,
        getPendingTxs,
        finalizeTx,
        makeGetPendingTxIntentSignature,
        cleanup: {
            graph,
            callerCoins: args.callerInputs as unknown as ExtendedVirtualCoin[],
            pendingWallet: { makeGetPendingTxIntentSignature } as unknown as Pick<
                Wallet,
                "makeGetPendingTxIntentSignature"
            >,
            provider: { getPendingTxs, finalizeTx } as Pick<
                ArkProvider,
                "getPendingTxs" | "finalizeTx"
            >,
            operatorIdentity: identities[1]!,
        },
    };
};

describe("same accepted direct fill cleanup", () => {
    it("refuses duplicate accepted provider entries before finalizing", async () => {
        const f = await acceptedFixture();
        f.getPendingTxs.mockResolvedValue([f.pending, f.pending]);
        await expect(finalizeAcceptedDirectFill(f.cleanup)).rejects.toThrow("not uniquely pending");
        expect(f.finalizeTx).not.toHaveBeenCalled();
    });
    it("retrieves by retained caller inputs and restores both owners onto matched server checkpoints", async () => {
        const f = await acceptedFixture();
        await finalizeAcceptedDirectFill(f.cleanup);
        expect(f.makeGetPendingTxIntentSignature).toHaveBeenCalledWith(f.cleanup.callerCoins);
        expect(f.getPendingTxs).toHaveBeenCalledOnce();
        expect(f.finalizeTx).toHaveBeenCalledOnce();
        const [txid, checkpoints] = f.finalizeTx.mock.calls[0]! as unknown as [string, string[]];
        expect(txid).toBe(f.graph.arkTx.id);
        checkpoints.map(parse).forEach((checkpoint, index) => {
            expect(checkpoint.id).toBe(f.graph.checkpoints[index]!.id);
            expect(checkpoint.getInput(0).unknown).toEqual(
                f.graph.checkpoints[index]!.getInput(0).unknown,
            );
            expect(checkpoint.getInput(0).tapScriptSig).toHaveLength(2);
        });
        expect(parse(checkpoints[0]!).getInput(0).tapScriptSig).toEqual(
            expect.arrayContaining(f.graph.checkpoints[0]!.getInput(0).tapScriptSig!),
        );
    });

    it.each(["wrong txid", "missing checkpoint", "invalid server signature", "missing Ark server"])(
        "refuses %s before finalizing",
        async (change) => {
            const f = await acceptedFixture();
            if (change === "wrong txid") f.pending.arkTxid = "ff".repeat(32);
            if (change === "missing checkpoint") f.pending.signedCheckpointTxs.pop();
            if (change === "invalid server signature") {
                const checkpoint = f.serverCheckpoints[0]!.clone();
                const entries = checkpoint.getInput(0).tapScriptSig!;
                entries[0]![1][0] ^= 1;
                checkpoint.updateInput(0, { tapScriptSig: undefined });
                checkpoint.updateInput(0, { tapScriptSig: entries });
                f.pending.signedCheckpointTxs[1] = encode(checkpoint);
            }
            if (change === "missing Ark server") {
                const ark = parse(f.pending.finalArkTx);
                ark.updateInput(0, { tapScriptSig: undefined });
                ark.updateInput(0, { tapScriptSig: f.graph.arkTx.getInput(0).tapScriptSig });
                f.pending.finalArkTx = encode(ark);
            }
            await expect(finalizeAcceptedDirectFill(f.cleanup)).rejects.toThrow();
            expect(f.finalizeTx).not.toHaveBeenCalled();
        },
    );
});
