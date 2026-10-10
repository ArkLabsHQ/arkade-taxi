import { describe, expect, it, vi } from "vitest";
import { hex } from "@scure/base";
import { createSwapFillQuote, revalidateBoundSwapFill } from "../src/swapFillQuotes.js";
import { readFundingSource } from "../src/arkade/fundingSource.js";
import type { ServiceError } from "../src/errors.js";
import { WANTED_ASSET } from "./jointFillFixtures.js";
import { receiverPaidFill, solverTree } from "./realFillFixtures.js";

const state = vi.hoisted(() => ({
    contractVtxos: [] as unknown[],
    prevTxs: new Map<string, string>(),
    serverKey: "",
    checkpoint: "",
}));

// Only the SDK's REST providers are stubbed: the Taxi's own checks, the offer
// codec, the swap library's assembly and the fill builder all run for real.
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

describe("a receiver-paid swap fill through the real graph builder", () => {
    it("builds and binds a zero-fare fill from indexer data that carries no taproot tree", async () => {
        const fill = receiverPaidFill(state);
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
        const fill = receiverPaidFill(state, () => solverTree.pkScript);
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
