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
import { encodeOffer, offerVtxoScript } from "@arkade-os/swap";
import {
    ProductionSwapFillGraphBuilder,
    type createSwapFillQuote,
    type SwapFillQuoteDeps,
} from "../src/swapFillQuotes.js";
import { fundingCoin, NOW, runtimeSafety, serverKey, serverUnroll } from "./fixtures.js";
import {
    insertReceiveQuote,
    WANTED_ASSET,
    WANTED_SWAP_ID,
    type InsertedReceiveQuote,
} from "./jointFillFixtures.js";
import { asIndexed, solverTaproot } from "./swapFillFixtures.js";

/** The REST reads the production builder makes, served from a test's own state. */
export interface RealBuilderState {
    contractVtxos: unknown[];
    prevTxs: Map<string, string>;
    serverKey: string;
    checkpoint: string;
}

export const solverKey = await SingleKey.fromPrivateKey(
    new Uint8Array(32).fill(21),
).xOnlyPublicKey();
export const solverTree = new VtxoScript([
    MultisigTapscript.encode({ pubkeys: [serverKey, solverKey] }).script,
]);
export const SOLVER_PAYOUT = `5120${hex.encode(solverKey)}`;

const key = (o: { txid: string; vout: number }): string => `${o.txid}:${o.vout}`;

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
    deps: SwapFillQuoteDeps;
    body: Parameters<typeof createSwapFillQuote>[1];
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
    const indexed = new Map([deposit, solver].map((coin) => [key(coin), asIndexed(coin)]));
    const wallet = {
        identity: {
            xOnlyPublicKey: async () => solverKey,
            sign: vi.fn(async (tx: Transaction) => tx),
        },
        getContractManager: async () => null,
    } as unknown as IWallet;
    const deps: SwapFillQuoteDeps = {
        runtime: {
            assertAdmission: async () => {},
            withAdmission: async (work) => work(() => {}),
            safety: () => runtimeSafety(),
        },
        policy: inserted.policies,
        advances: inserted.advances,
        reservations: inserted.reservations,
        swapFills: inserted.swapFills,
        receiveQuotes: inserted.quotes,
        inventory: {
            getSpendableVtxos: async () => [operatorCoin as ExtendedVirtualCoin],
            getLockedVtxoOutpoints: async () => [],
        },
        senderInventory: {
            getVtxos: async (opts) => ({
                vtxos: opts?.outpoints?.map((o) => indexed.get(key(o))!).filter(Boolean) ?? [],
            }),
        },
        config: cfg,
        now: () => NOW,
        nowMs: () => NOW * 1000,
        randomId: () => "fill-real",
        swapFillBuilder: new ProductionSwapFillGraphBuilder(() => wallet, "http://ark"),
        providerLimits: async () => ({ vtxoMaxAmount: 10_000_000n }),
        getServerUnroll: () => serverUnroll,
    };
    const body = {
        operationId: "op-real",
        receiveQuoteId: inserted.quoteId,
        offerHex,
        solverInputs: [
            {
                txid: solver.txid,
                vout: solver.vout,
                value: "1000",
                ...solverTaproot(solverTree),
                assets: [
                    {
                        assetId: { txid: hex.encode(WANTED_ASSET.txid), groupIndex: 0 },
                        amount: "5",
                    },
                ],
            },
        ],
        solverProceedsScript: SOLVER_PAYOUT,
        solverKeys: [hex.encode(solverKey)],
        contributionSats: "330",
        maxFare: { currency: "sats", units: "0" },
        fundingTxid: deposit.txid,
        fundingVout: deposit.vout,
    };
    return { ...inserted, deps, body, offerScript, deposit, solver, operatorCoin };
}
