import { vi } from "vitest";
import { base64, hex } from "@scure/base";
import {
    asset,
    MultisigTapscript,
    SingleKey,
    Transaction,
    VtxoScript,
    type ExtendedVirtualCoin,
    type IWallet,
} from "@arkade-os/sdk";
import { buildOfferFillPlan, encodeOffer, offerVtxoScript } from "@arkade-os/swap";
import { ArkAddress } from "@arkade-os/sdk";
import { deriveJointInputs, deriveJointOutputs } from "../src/arkade/jointGraphDerivation.js";
import { fundingCoin, serverKey, serverUnroll } from "./fixtures.js";
import {
    insertReceiveQuote,
    WANTED_SWAP_ID,
    type InsertedReceiveQuote,
} from "./jointFillFixtures.js";
import { asIndexed } from "./graphFixtures.js";

/** The REST reads the production builder makes, served from a test's own state. */
export interface RealBuilderState {
    contractVtxos: unknown[];
    prevTxs: Map<string, string>;
    serverKey: string;
    checkpoint: string;
}

export const solverPrivkey = new Uint8Array(32).fill(21);
export const solverKey = await SingleKey.fromPrivateKey(solverPrivkey).xOnlyPublicKey();
export const solverTree = new VtxoScript([
    MultisigTapscript.encode({ pubkeys: [serverKey, solverKey] }).script,
]);
export const SOLVER_PAYOUT = `5120${hex.encode(solverKey)}`;

let minted = 0;
/** A coin whose txid is a real prev ark tx the stub indexer serves by id. */
const mint = (state: RealBuilderState, script: Uint8Array, value: number): string => {
    const seed = ++minted;
    const tx = new Transaction({ version: 3 });
    tx.addInput({
        txid: new Uint8Array(32).fill(seed),
        index: 0,
        witnessUtxo: { script, amount: BigInt(value) },
    });
    tx.addOutput({ script, amount: BigInt(value) });
    state.prevTxs.set(tx.id, base64.encode(tx.toPSBT()));
    return tx.id;
};

export interface RealFill extends InsertedReceiveQuote {
    buildGraph(): Promise<{
        graph: {
            arkTx: string;
            checkpoints: readonly string[];
            inputs: { owner: string | null }[];
            outputs: { vout: number; script: string; sats: string }[];
        };
    }>;
    offerScript: ReturnType<typeof offerVtxoScript>;
    deposit: ExtendedVirtualCoin;
    solver: ExtendedVirtualCoin;
    operatorCoin: ExtendedVirtualCoin;
}

export function receiverPaidFill(
    state: RealBuilderState,
    depositScript?: (offerScript: Uint8Array) => Uint8Array,
): RealFill {
    const operatorCoin = fundingCoin({
        txid: mint(state, new Uint8Array([0x51]), 20_000),
        value: 20_000,
    });
    const inserted = insertReceiveQuote({
        wantAmount: 5n,
        receiverFare: { currency: "sats", units: 4n },
        operatorCoin,
    });
    const { cfg, covenant, makerKey } = inserted;
    const offer = {
        wantAmount: 5n,
        wantAsset: asset.AssetId.fromString(WANTED_SWAP_ID),
        makerPkScript: covenant.pkScript,
        makerPublicKey: makerKey,
        emulatorPubkey: cfg.emulatorPubkey,
    };
    const offerScript = offerVtxoScript(offer, cfg.serverPubkey);
    const offerHex = hex.encode(encodeOffer({ ...offer, swapPkScript: offerScript.pkScript }));
    const script = depositScript?.(offerScript.pkScript) ?? offerScript.pkScript;
    const deposit = fundingCoin({
        txid: mint(state, script, 1_000),
        value: 1_000,
        script: hex.encode(script),
    });
    const solver = fundingCoin({
        txid: mint(state, solverTree.pkScript, 1_000),
        value: 1_000,
        script: hex.encode(solverTree.pkScript),
        assets: [{ assetId: WANTED_SWAP_ID, amount: 5n }],
    });
    state.serverKey = hex.encode(serverKey);
    state.checkpoint = hex.encode(serverUnroll.script);
    state.contractVtxos = [asIndexed(deposit)];
    const wallet = {
        identity: {
            xOnlyPublicKey: async () => solverKey,
            sign: vi.fn((tx: Transaction, indexes?: number[]) =>
                SingleKey.fromPrivateKey(solverPrivkey).sign(tx, indexes),
            ),
        },
        getContractManager: async () => null,
    } as unknown as IWallet;
    const buildGraph = async () => {
        const operatorScript = new ArkAddress(cfg.serverPubkey, cfg.operatorKey, cfg.addressHrp)
            .pkScript;
        const graph = await buildOfferFillPlan(wallet, "http://ark", offerHex, {
            fund: [
                {
                    txid: solver.txid,
                    vout: solver.vout,
                    value: solver.value,
                    tapTree: solverTree.encode(),
                    tapLeafScript: solverTree.leaves[0]!,
                    assets: [{ assetId: WANTED_SWAP_ID, amount: 5n }],
                },
            ],
            payoutScript: hex.decode(SOLVER_PAYOUT),
            fundingOutpoint: { txid: deposit.txid, vout: deposit.vout },
            fundingTxid: deposit.txid,
            sponsor: {
                fund: [
                    {
                        txid: operatorCoin.txid,
                        vout: operatorCoin.vout,
                        value: operatorCoin.value,
                        tapTree: operatorCoin.tapTree,
                        tapLeafScript: operatorCoin.forfeitTapLeafScript,
                    },
                ],
                netContributionSats: inserted.loan,
                changeScript: operatorScript,
            },
        });
        const solverIndex = graph.inputOwners.indexOf("solver");
        const identity = SingleKey.fromPrivateKey(solverPrivkey);
        const arkTx = await identity.sign(Transaction.fromPSBT(base64.decode(graph.arkTx)), [
            solverIndex,
        ]);
        const checkpoints = [...graph.checkpoints];
        checkpoints[solverIndex] = base64.encode(
            (
                await identity.sign(
                    Transaction.fromPSBT(base64.decode(checkpoints[solverIndex]!)),
                    [0],
                )
            ).toPSBT(),
        );
        const signed = { ...graph, arkTx: base64.encode(arkTx.toPSBT()), checkpoints };
        return {
            graph: {
                ...signed,
                inputs: deriveJointInputs(signed),
                outputs: deriveJointOutputs(signed).map((output) => ({
                    ...output,
                    script: hex.encode(output.script),
                    sats: output.sats.toString(),
                })),
            },
        };
    };
    return { ...inserted, buildGraph, offerScript, deposit, solver, operatorCoin };
}
