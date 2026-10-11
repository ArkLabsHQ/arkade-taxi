import { base64, hex } from "@scure/base";
import {
    DefaultVtxo,
    Transaction,
    VtxoScript,
    type ExtendedVirtualCoin,
    type VirtualCoin,
} from "@arkade-os/sdk";
import { digestJointGraph, FILL_TEMPLATE, type JointGraph } from "@arkade-taxi/client";
import { fundingCoin, serverKey } from "./fixtures.js";

export const asIndexed = (coin: ExtendedVirtualCoin): VirtualCoin => {
    const indexed: Partial<ExtendedVirtualCoin> = { ...coin };
    delete indexed.tapTree;
    delete indexed.forfeitTapLeafScript;
    delete indexed.intentTapLeafScript;
    return indexed as VirtualCoin;
};

export const SOLVER_KEY = hex.decode("ab".repeat(32));
export const solverTreeOf = (blocks = 144n) =>
    new DefaultVtxo.Script({
        pubKey: SOLVER_KEY,
        serverPubKey: serverKey,
        csvTimelock: { type: "blocks", value: blocks },
    });
export const SOLVER_TREE = solverTreeOf();

export const solverCoin = (
    over: Partial<ExtendedVirtualCoin> = {},
    tree: DefaultVtxo.Script = SOLVER_TREE,
): ExtendedVirtualCoin =>
    fundingCoin({
        script: hex.encode(tree.pkScript),
        tapTree: tree.encode(),
        forfeitTapLeafScript: tree.forfeit(),
        intentTapLeafScript: tree.forfeit(),
        ...over,
    });

export const solverTaproot = (tree: VtxoScript = SOLVER_TREE) => ({
    tapTree: hex.encode(tree.encode()),
    spendLeaf: hex.encode(tree.scripts[0]!),
});

export const checkpointSpending = (coin: { txid: string; vout: number }): Transaction => {
    const cp = new Transaction({ version: 3, lockTime: 0 });
    cp.addInput({ txid: coin.txid, index: coin.vout });
    cp.addOutput({ script: new Uint8Array([0x51]), amount: 1000n });
    return cp;
};

export const sealGraph = (graph: JointGraph): JointGraph => ({
    ...graph,
    graphId: digestJointGraph(
        {
            arkTx: graph.arkTx,
            checkpoints: [...graph.checkpoints],
            inputOwners: [...graph.inputOwners],
        },
        FILL_TEMPLATE,
    ),
});
