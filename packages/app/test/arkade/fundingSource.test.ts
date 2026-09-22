import { describe, expect, it } from "vitest";
import {
    Extension,
    MultisigTapscript,
    Transaction,
    VtxoScript,
    asset,
    scriptFromTapLeafScript,
} from "@arkade-os/sdk";
import { schnorr } from "@noble/curves/secp256k1.js";
import { createHash } from "node:crypto";
import { base64, hex } from "@scure/base";
import { sealGraph } from "../swapFillFixtures.js";
import {
    encodeJointFillSource,
    readFundingSource,
    type JointFillFundingSource,
} from "../../src/arkade/fundingSource.js";

const graph = () => {
    const tx = new Transaction({ version: 3 });
    for (const [txid, index] of [
        ["aa".repeat(32), 0],
        ["bb".repeat(32), 1],
        ["cc".repeat(32), 2],
    ] as const)
        tx.addInput({ txid, index });
    const script = (seed: number) =>
        new Uint8Array([0x51, 0x20, ...schnorr.getPublicKey(new Uint8Array(32).fill(seed))]);
    tx.addOutput({ script: script(1), amount: 330n });
    tx.addOutput({ script: script(2), amount: 675n });
    tx.addOutput({ script: script(3), amount: 996n });
    tx.addOutput(
        Extension.create([
            asset.Packet.create([
                asset.AssetGroup.create(
                    asset.AssetId.create("44".repeat(32), 7),
                    null,
                    [asset.AssetInput.create(1, 5n)],
                    [asset.AssetOutput.create(0, 5n)],
                    [],
                ),
            ]),
        ]).txOut(),
    );
    const checkpoints = [0, 1, 2].map((index) => {
        const cp = new Transaction({ version: 3 });
        cp.addInput({ txid: `${["aa", "bb", "cc"][index]}`.repeat(32), index });
        cp.addOutput({ script: new Uint8Array([0x51]), amount: 1_000n });
        return base64.encode(cp.toPSBT());
    });
    return sealGraph({
        arkTx: base64.encode(tx.toPSBT()),
        checkpoints,
        graphId: "",
        inputOwners: [null, "solver", "sponsor"],
    });
};

const operatorScript = hex.encode(
    new Uint8Array([0x51, 0x20, ...schnorr.getPublicKey(new Uint8Array(32).fill(2))]),
);
const fundingTree = new VtxoScript([
    MultisigTapscript.encode({
        pubkeys: [
            schnorr.getPublicKey(new Uint8Array(32).fill(4)),
            schnorr.getPublicKey(new Uint8Array(32).fill(5)),
        ],
    }).script,
]);
const fundingProof = {
    script: hex.encode(fundingTree.pkScript),
    tapTree: hex.encode(fundingTree.encode()),
    spendLeaf: hex.encode(scriptFromTapLeafScript(fundingTree.leaves[0])),
};

const recoveryPreflight = () => {
    const tx = new Transaction({ version: 3 });
    tx.addInput({ txid: "77".repeat(32), index: 0 });
    tx.addOutput({ script: new Uint8Array([0x51]), amount: 1n });
    const arkTx = base64.encode(tx.toPSBT());
    const checkpoints: string[] = [];
    return {
        digest: createHash("sha256").update(JSON.stringify({ arkTx, checkpoints })).digest("hex"),
        expectedTxid: tx.id,
        arkTx,
        checkpoints,
    };
};

const source = (): JointFillFundingSource => ({
    tag: "joint-fill",
    version: 1,
    receiveQuoteId: "receive-1",
    fillId: "fill-1",
    operationId: "op-1",
    offerHex: "abcd",
    offerOutpoint: { txid: "aa".repeat(32), vout: 0 },
    graph: graph(),
    covenantOutputIndex: 0,
    covenantSats: "330",
    assetId: { txid: "44".repeat(32), groupIndex: 7 },
    assetUnits: "5",
    inputExpiryFloor: { kind: "height", value: "900000" },
    inputs: [
        {
            role: "offer-covenant",
            txid: "aa".repeat(32),
            vout: 0,
            value: "1000",
            ...fundingProof,
            assets: [],
            expiry: { kind: "height", value: "900001" },
        },
        {
            role: "solver",
            txid: "bb".repeat(32),
            vout: 1,
            value: "1",
            ...fundingProof,
            assets: [
                {
                    assetId: asset.AssetId.create("44".repeat(32), 7).toString(),
                    amount: "5",
                },
            ],
            expiry: { kind: "height", value: "900002" },
        },
        {
            role: "sponsor",
            txid: "cc".repeat(32),
            vout: 2,
            value: "1000",
            ...fundingProof,
            assets: [],
            expiry: { kind: "height", value: "900000" },
        },
    ],
    serverUnrollScript: "51",
    operatorScript,
    operatorPayouts: [{ vout: 1, sats: "675", fareSats: "4" }],
    recoveryPreflight: recoveryPreflight(),
});

describe("joint-fill funding source", () => {
    it("round-trips a tagged source and revalidates graph-derived facts", () => {
        const decoded = readFundingSource(encodeJointFillSource(source()));
        expect(decoded.kind).toBe("joint-fill");
        if (decoded.kind === "joint-fill") {
            expect(decoded.source.fillId).toBe("fill-1");
            expect(decoded.covenantOutpoint.vout).toBe(0);
            expect(decoded.operatorPayouts).toEqual([{ vout: 1, sats: 675n, fareSats: 4n }]);
        }
    });

    it("fails closed for unknown tags and graph/output tampering", () => {
        expect(() => readFundingSource('taxi-source:{"tag":"future","version":2}')).toThrow(
            /unsupported/,
        );
        const changed = source();
        changed.operatorPayouts[0]!.sats = "676";
        expect(() => readFundingSource(encodeJointFillSource(changed))).toThrow(/payout/);
        const reidentified = source();
        reidentified.graph = { ...reidentified.graph, graphId: "00".repeat(32) };
        expect(() => readFundingSource(encodeJointFillSource(reidentified))).toThrow(/graph/);
        const recovery = source();
        recovery.recoveryPreflight.digest = "00".repeat(32);
        expect(() => readFundingSource(encodeJointFillSource(recovery))).toThrow(/preflight/);
    });

    it("classifies untouched legacy envelopes without trying a joint fallback", () => {
        expect(readFundingSource("bGVnYWN5")).toEqual({ kind: "legacy" });
    });
});
