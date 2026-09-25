import { describe, expect, it, vi } from "vitest";
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
    createSwapFillQuote,
    ProductionSwapFillGraphBuilder,
    revalidateBoundSwapFill,
    type SwapFillQuoteDeps,
} from "../src/swapFillQuotes.js";
import { readFundingSource } from "../src/arkade/fundingSource.js";
import type { ServiceError } from "../src/errors.js";
import { fundingCoin, NOW, runtimeSafety, serverKey, serverUnroll } from "./fixtures.js";
import { insertReceiveQuote, WANTED_ASSET, WANTED_SWAP_ID } from "./jointFillFixtures.js";
import { asIndexed, solverTaproot } from "./swapFillFixtures.js";

// Only the SDK's REST providers are stubbed: the Taxi's own checks, the offer
// codec, the swap library's assembly and the fill builder all run for real.
const state = vi.hoisted(() => ({
    contractVtxos: [] as unknown[],
    prevTxs: new Map<string, string>(),
    serverKey: "",
    checkpoint: "",
}));

vi.mock("@arkade-os/sdk", async (importOriginal) => {
    const mod = await importOriginal<typeof import("@arkade-os/sdk")>();
    return {
        ...mod,
        RestArkProvider: class {
            async getInfo() {
                return {
                    signerPubkey: `02${state.serverKey}`,
                    checkpointTapscript: state.checkpoint,
                };
            }
        },
        RestIndexerProvider: class {
            async getVtxos() {
                return { vtxos: state.contractVtxos };
            }
            async getVirtualTxs(txids: string[]) {
                return {
                    txs: txids
                        .map((t) => state.prevTxs.get(t))
                        .filter((p): p is string => p !== undefined),
                };
            }
        },
    };
});

const solverKey = await SingleKey.fromPrivateKey(new Uint8Array(32).fill(21)).xOnlyPublicKey();
const solverTree = new VtxoScript([
    MultisigTapscript.encode({ pubkeys: [serverKey, solverKey] }).script,
]);
const SOLVER_PAYOUT = `5120${hex.encode(solverKey)}`;

let minted = 0;
/** A coin whose txid is a real prev ark tx the stub indexer serves by id. */
const mint = (script: Uint8Array, value: number): string => {
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

const key = (o: { txid: string; vout: number }): string => `${o.txid}:${o.vout}`;

function receiverPaidFill(depositScript?: (offerScript: Uint8Array) => Uint8Array) {
    const operatorCoin = fundingCoin({ txid: mint(new Uint8Array([0x51]), 20_000), value: 20_000 });
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
        txid: mint(script, 1_000),
        value: 1_000,
        script: hex.encode(script),
    });
    const solver = fundingCoin({
        txid: mint(solverTree.pkScript, 1_000),
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
    return { ...inserted, deps, body, offerScript };
}

describe("a receiver-paid swap fill through the real graph builder", () => {
    it("builds and binds a zero-fare fill from indexer data that carries no taproot tree", async () => {
        const fill = receiverPaidFill();
        try {
            const quote = await createSwapFillQuote(fill.deps, fill.body);
            expect(quote.fare).toEqual({ currency: "sats", units: "0" });
            expect(quote.graph.outputs.map(({ role, sats }) => ({ role, sats }))).toEqual([
                { role: "receiver", sats: "330" },
                { role: "sponsor-change", sats: "19670" },
                { role: "solver", sats: "2000" },
            ]);
            expect(quote.graph.outputs[0]!.assets).toEqual([
                { assetId: { txid: hex.encode(WANTED_ASSET.txid), groupIndex: 0 }, units: "5" },
            ]);
            expect(fill.quotes.get(fill.quoteId)).toMatchObject({
                state: "bound",
                boundFillId: "fill-real",
            });
            const advance = fill.advances.get(fill.quoteId)!;
            const source = readFundingSource(advance.unsignedLockupTx);
            const deposit = source.kind === "joint-fill" ? source.source.inputs[0] : undefined;
            expect(deposit).toMatchObject({
                role: "offer-covenant",
                tapTree: hex.encode(fill.offerScript.encode()),
                spendLeaf: hex.encode(fill.offerScript.functionByName("fulfill")!.leafScript),
            });
            const stored = fill.swapFills.get(quote.fillId)!;
            await expect(revalidateBoundSwapFill(fill.deps, stored)).resolves.toBeUndefined();
        } finally {
            fill.db.close();
        }
    });

    it("refuses a deposit whose indexed script the offer's covenant does not rebuild", async () => {
        const fill = receiverPaidFill(() => solverTree.pkScript);
        try {
            const refused = (await createSwapFillQuote(fill.deps, fill.body).then(
                () => undefined,
                (e: unknown) => e,
            )) as ServiceError;
            expect(refused.status).toBe(400);
            expect(refused.code).toBe("swap_fill_deposit_mismatch");
            expect(fill.quotes.get(fill.quoteId)!.state).toBe("quoted");
        } finally {
            fill.db.close();
        }
    });
});
