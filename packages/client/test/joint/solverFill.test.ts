import { describe, expect, it } from "vitest";
import { base64, hex } from "@scure/base";
import { schnorr } from "@noble/curves/secp256k1.js";
import {
    CSVMultisigTapscript,
    MultisigTapscript,
    SingleKey,
    VtxoScript,
    buildOffchainTx,
    type Identity,
} from "@arkade-os/sdk";
import { digestJointGraph, type JointGraph } from "../../src/joint/jointGraph.js";
import { OFFER_FILL_TEMPLATE } from "../../src/joint/offerFillPlan.js";
import { signSwapFillAsSolver, solverInputIndices } from "../../src/joint/solverFill.js";
import { tapScriptSigEntries } from "../../src/joint/arkTransaction.js";
import { Transaction } from "@arkade-os/sdk";

const SOLVER_SEED = new Uint8Array(32).fill(31);
const SERVER_SEED = new Uint8Array(32).fill(32);
const solverX = schnorr.getPublicKey(SOLVER_SEED);
const serverX = schnorr.getPublicKey(SERVER_SEED);

const tree = new VtxoScript([MultisigTapscript.encode({ pubkeys: [solverX, serverX] }).script]);
const unroll = CSVMultisigTapscript.encode({
    timelock: { type: "blocks", value: BigInt(10) },
    pubkeys: [serverX],
});
const coin = (txid: string) => ({
    txid,
    vout: 0,
    value: 5_000,
    tapLeafScript: tree.leaves[0],
    tapTree: tree.encode(),
});

/** Covenant at 0, solver at 1 and 2 — two owned inputs, so indices matter. */
const graph = (owners: JointGraph["inputOwners"]): JointGraph => {
    const { arkTx, checkpoints } = buildOffchainTx(
        owners.map((_, i) =>
            coin(
                String(i + 10)
                    .repeat(32)
                    .slice(0, 64),
            ),
        ),
        [{ script: new Uint8Array([0x51, 0x20, ...solverX]), amount: BigInt(9_000) }],
        unroll,
    );
    const base = {
        arkTx: base64.encode(arkTx.toPSBT()),
        checkpoints: checkpoints.map((c) => base64.encode(c.toPSBT())),
        inputOwners: owners,
    };
    return { ...base, graphId: digestJointGraph(base, OFFER_FILL_TEMPLATE) };
};

const signedIndices = (g: JointGraph): number[] => {
    const tx = Transaction.fromPSBT(base64.decode(g.arkTx));
    return g.inputOwners.flatMap((_, i) => (tapScriptSigEntries(tx, i).length ? [i] : []));
};

describe("signSwapFillAsSolver", () => {
    const identity = SingleKey.fromPrivateKey(SOLVER_SEED);

    it("signs exactly the inputs the solver owns", async () => {
        const expected = graph([null, "solver", "sponsor"]);
        const signed = await signSwapFillAsSolver({ expected, identity });
        expect(signedIndices(signed)).toEqual([1]);
    });

    it("signs every owned input when the solver holds several", async () => {
        const expected = graph([null, "solver", "solver"]);
        const signed = await signSwapFillAsSolver({ expected, identity });
        expect(signedIndices(signed)).toEqual([1, 2]);
    });

    it("asks the identity source for each owned index", async () => {
        const expected = graph([null, "solver", "solver"]);
        const asked: number[] = [];
        await signSwapFillAsSolver({
            expected,
            identity: (inputIndex): Identity => {
                asked.push(inputIndex);
                return identity;
            },
        });
        expect(asked).toEqual([1, 2]);
    });

    it("refuses a fill that assigns the solver nothing", async () => {
        const expected = graph([null, "sponsor"]);
        await expect(signSwapFillAsSolver({ expected, identity })).rejects.toThrow(
            /assigns no inputs to the solver/,
        );
    });

    it("reports owned indices without signing", () => {
        expect(solverInputIndices(graph([null, "solver", "sponsor", "solver"]))).toEqual([1, 3]);
    });
});
