import { describe, expect, it } from "vitest";
import { base64, hex } from "@scure/base";
import {
    asset,
    Extension,
    Transaction,
    type IndexerProvider,
    type VirtualCoin,
} from "@arkade-os/sdk";
import type { SwapFill, SwapFillGraph } from "@arkade-taxi/db";
import { createSwapFillReconciler } from "../src/swapFillReconciler.js";
import { fundingCoin, NOW } from "./fixtures.js";
import { MemorySwapFills } from "./swapFillFixtures.js";

const OFFER = { txid: "dd".repeat(32), vout: 3 };
const SOLVER_IN = { txid: "ee".repeat(32), vout: 1 };
const TAXI_IN = { txid: "cc".repeat(32), vout: 0 };
const OTHER_TX = "ff".repeat(32);
const TAXI_SCRIPT = new Uint8Array([0x52]);
const FARE_INTERNAL = Uint8Array.from(Buffer.from("1234".repeat(16), "hex")).reverse();
const FARE_SWAP_ID = asset.AssetId.create("1234".repeat(16), 0).toString();

const key = (o: { txid: string; vout: number }): string => `${o.txid}:${o.vout}`;

const OUTPUT_SPECS = [
    { script: "51", sats: 5000, assets: [] as { assetId: string; amount: bigint }[] },
    { script: "53", sats: 1000, assets: [] as { assetId: string; amount: bigint }[] },
    {
        script: "52",
        sats: 330,
        assets: [{ assetId: FARE_SWAP_ID, amount: 5n }],
    },
    { script: "52", sats: 1670, assets: [] as { assetId: string; amount: bigint }[] },
];

const TRUSTED_ARK_TX = (() => {
    const tx = new Transaction({ version: 3, lockTime: 0 });
    tx.addInput({ txid: OFFER.txid, index: OFFER.vout });
    tx.addInput({ txid: SOLVER_IN.txid, index: SOLVER_IN.vout });
    tx.addInput({ txid: TAXI_IN.txid, index: TAXI_IN.vout });
    for (const o of OUTPUT_SPECS)
        tx.addOutput({ script: hex.decode(o.script), amount: BigInt(o.sats) });
    const packet = asset.Packet.create([
        asset.AssetGroup.create(
            asset.AssetId.fromString(FARE_SWAP_ID),
            null,
            [asset.AssetInput.create(1, 5n)],
            [asset.AssetOutput.create(2, 5n)],
            [],
        ),
    ]);
    const extOut = Extension.create([packet]).txOut();
    tx.addOutput({ script: extOut.script, amount: extOut.amount });
    return base64.encode(tx.toPSBT());
})();

const trustedGraph = (): SwapFillGraph => ({
    arkTx: TRUSTED_ARK_TX,
    checkpoints: [OFFER, SOLVER_IN, TAXI_IN].map((o) => {
        const cp = new Transaction({ version: 3, lockTime: 0 });
        cp.addInput({ txid: o.txid, index: o.vout });
        cp.addOutput({ script: new Uint8Array([0x51]), amount: 1000n });
        return base64.encode(cp.toPSBT());
    }),
    graphId: new Uint8Array(32).fill(7),
    inputOwners: [null, "solver", "sponsor"],
});

const preparedTx = () => {
    const tx = new Transaction({ version: 3, lockTime: 0 });
    tx.addInput({ txid: OFFER.txid, index: OFFER.vout });
    tx.addOutput({ amount: 5000n, script: new Uint8Array([0x51]) });
    tx.addOutput({ amount: 1000n, script: new Uint8Array([0x53]) });
    tx.addOutput({ amount: 330n, script: TAXI_SCRIPT });
    tx.addOutput({ amount: 1670n, script: TAXI_SCRIPT });
    return tx;
};

const fill = (txid: string, over: Partial<SwapFill> = {}): SwapFill => ({
    id: "fill-1",
    operationId: "op-1",
    state: "submitting",
    offerHex: "ab12",
    offerTxid: OFFER.txid,
    offerVout: OFFER.vout,
    solverInputs: [{ txid: SOLVER_IN.txid, vout: SOLVER_IN.vout, value: 6000n }],
    solverProceedsScript: new Uint8Array([0x51]),
    solverKeys: ["ab".repeat(32)],
    taxiInputs: [{ ...TAXI_IN }],
    contributionSats: 2000n,
    sponsorScript: TAXI_SCRIPT,
    fare: { currency: "asset", assetId: { txid: FARE_INTERNAL, groupIndex: 0 }, units: 5n },
    maxFare: { currency: "asset", assetId: { txid: FARE_INTERNAL, groupIndex: 0 }, units: 5n },
    graph: trustedGraph(),
    graphId: new Uint8Array(32).fill(7),
    preparedArkTx: base64.encode(preparedTx().toPSBT()),
    preparedCheckpoints: ["Y2hr"],
    submitInvoked: true,
    leaseOwner: "swap-fill-submit",
    leaseToken: "lease-1",
    leaseUntil: NOW - 1,
    attempts: 1,
    createdAt: NOW,
    updatedAt: NOW,
    expiresAt: NOW + 600,
    ...over,
});

const outputCoin = (txid: string, vout: number): VirtualCoin => {
    const out = OUTPUT_SPECS[vout]!;
    return fundingCoin({
        txid,
        vout,
        value: out.sats,
        script: out.script,
        assets: out.assets.map((a) => ({ assetId: a.assetId, amount: a.amount })),
    });
};

const setup = (rows: SwapFill[], coins: Map<string, VirtualCoin>, fail?: Error) => {
    const store = new MemorySwapFills();
    for (const row of rows) store.rows.set(row.id, structuredClone(row));
    const indexer: Pick<IndexerProvider, "getVtxos"> = {
        getVtxos: async (opts) => {
            if (fail) throw fail;
            return {
                vtxos: opts?.outpoints?.map((o) => coins.get(key(o))!).filter(Boolean) ?? [],
            };
        },
    };
    const reconciler = createSwapFillReconciler({ swapFills: store, indexer, now: () => NOW });
    return { store, indexer, reconciler };
};

const ourTxid = (): string => preparedTx().id.toLowerCase();

describe("swap-fill reconciliation", () => {
    it("keeps an ambiguous fill submitting while the offer is unspent, writing nothing", async () => {
        const coins = new Map([[key(OFFER), fundingCoin({ ...OFFER, script: "ac".repeat(34) })]]);
        const { store, reconciler } = setup([fill(ourTxid())], coins);
        await reconciler.tick();
        expect(store.get("fill-1")!.state).toBe("submitting");
        expect(store.events).toEqual([]);
        expect(store.listReservedOutpoints()).toEqual([TAXI_IN]);
        expect(reconciler.status()).toEqual({ lastTickAt: NOW, submitting: 1, blockers: [] });
    });

    it("never settles on the submit txid claim alone", async () => {
        const claimed = "ee".repeat(32);
        const coins = new Map([
            [key(OFFER), fundingCoin({ ...OFFER, script: "ac".repeat(34) })],
            [key({ txid: claimed, vout: 0 }), outputCoin(claimed, 0)],
        ]);
        const { store, reconciler } = setup([fill(ourTxid(), { txid: claimed })], coins);
        await reconciler.tick();
        const row = store.get("fill-1")!;
        expect(row.state).toBe("submitting");
        expect(row.txid).toBe(claimed);
        expect(store.events).toEqual([]);
    });

    it("cancels when the offer was spent by the claimed submit txid instead of the derived one", async () => {
        const claimed = "ee".repeat(32);
        const txid = ourTxid();
        expect(claimed).not.toBe(txid);
        const coins = new Map([
            [
                key(OFFER),
                fundingCoin({ ...OFFER, script: "ac".repeat(34), isSpent: true, arkTxId: claimed }),
            ],
            [key({ txid: claimed, vout: 0 }), outputCoin(claimed, 0)],
            [key({ txid: claimed, vout: 2 }), outputCoin(claimed, 2)],
            [key({ txid: claimed, vout: 3 }), outputCoin(claimed, 3)],
        ]);
        const { store, reconciler } = setup([fill(txid, { txid: claimed })], coins);
        await reconciler.tick();
        const row = store.get("fill-1")!;
        expect(row.state).toBe("cancelled");
        expect(row.spentTxid).toBe(claimed);
        expect(row.outpoint).toBeUndefined();
        expect(store.events).toEqual(["recordCancelled"]);
    });

    it("settles when the offer was consumed by the prepared tx and every receiver and taxi output matches", async () => {
        const txid = ourTxid();
        const coins = new Map([
            [
                key(OFFER),
                fundingCoin({
                    ...OFFER,
                    script: "ac".repeat(34),
                    isSpent: true,
                    spentBy: "bb".repeat(32),
                    arkTxId: txid,
                }),
            ],
            [key({ txid, vout: 0 }), outputCoin(txid, 0)],
            [key({ txid, vout: 2 }), outputCoin(txid, 2)],
            [key({ txid, vout: 3 }), outputCoin(txid, 3)],
        ]);
        const { store, reconciler } = setup([fill(txid)], coins);
        await reconciler.tick();
        const row = store.get("fill-1")!;
        expect(row.state).toBe("settled");
        expect(row.txid).toBe(txid);
        expect(row.outpoint).toEqual({ txid, vout: 0 });
        expect(store.events).toEqual(["reconcileSettled"]);
        expect(store.listReservedOutpoints()).toEqual([]);
        expect(reconciler.status()).toEqual({ lastTickAt: NOW, submitting: 0, blockers: [] });
    });

    it("settles without observing the solver output", async () => {
        const txid = ourTxid();
        const coins = new Map([
            [
                key(OFFER),
                fundingCoin({ ...OFFER, script: "ac".repeat(34), isSpent: true, arkTxId: txid }),
            ],
            [key({ txid, vout: 0 }), outputCoin(txid, 0)],
            [key({ txid, vout: 2 }), outputCoin(txid, 2)],
            [key({ txid, vout: 3 }), outputCoin(txid, 3)],
        ]);
        const { store, reconciler } = setup([fill(txid)], coins);
        await reconciler.tick();
        expect(store.get("fill-1")!.state).toBe("settled");
    });

    it("waits instead of settling partially when only some expected outputs are indexed", async () => {
        const txid = ourTxid();
        const coins = new Map([
            [
                key(OFFER),
                fundingCoin({ ...OFFER, script: "ac".repeat(34), isSpent: true, arkTxId: txid }),
            ],
            [key({ txid, vout: 0 }), outputCoin(txid, 0)],
        ]);
        const { store, reconciler } = setup([fill(txid)], coins);
        await reconciler.tick();
        expect(store.get("fill-1")!.state).toBe("submitting");
        expect(store.events).toEqual([]);
    });

    it("waits when our spend landed but its outputs are not yet indexed", async () => {
        const txid = ourTxid();
        const coins = new Map([
            [
                key(OFFER),
                fundingCoin({ ...OFFER, script: "ac".repeat(34), isSpent: true, arkTxId: txid }),
            ],
        ]);
        const { store, reconciler } = setup([fill(txid)], coins);
        await reconciler.tick();
        expect(store.get("fill-1")!.state).toBe("submitting");
        expect(store.events).toEqual([]);
    });

    it("cancels when the offer was spent elsewhere, recording no settlement", async () => {
        const coins = new Map([
            [
                key(OFFER),
                fundingCoin({
                    ...OFFER,
                    script: "ac".repeat(34),
                    isSpent: true,
                    spentBy: "bb".repeat(32),
                    arkTxId: OTHER_TX,
                }),
            ],
        ]);
        const { store, reconciler } = setup([fill(ourTxid())], coins);
        await reconciler.tick();
        const row = store.get("fill-1")!;
        expect(row.state).toBe("cancelled");
        expect(row.spentTxid).toBe(OTHER_TX);
        expect(row.txid).toBeUndefined();
        expect(row.outpoint).toBeUndefined();
        expect(store.events).toEqual(["recordCancelled"]);
        expect(store.listReservedOutpoints()).toEqual([]);
    });

    it("cancel race: a decoy receiver output at another txid never causes any payout", async () => {
        const txid = ourTxid();
        const coins = new Map([
            [
                key(OFFER),
                fundingCoin({
                    ...OFFER,
                    script: "ac".repeat(34),
                    isSpent: true,
                    arkTxId: OTHER_TX,
                }),
            ],
            [key({ txid: OTHER_TX, vout: 0 }), outputCoin(OTHER_TX, 0)],
            [key({ txid: OTHER_TX, vout: 3 }), outputCoin(OTHER_TX, 3)],
        ]);
        const { store, reconciler } = setup([fill(txid)], coins);
        await reconciler.tick();
        const row = store.get("fill-1")!;
        expect(row.state).toBe("cancelled");
        expect(row.spentTxid).toBe(OTHER_TX);
        expect(row.txid).toBeUndefined();
        expect(row.outpoint).toBeUndefined();
        expect(store.events).toEqual(["recordCancelled"]);
        expect(store.listReservedOutpoints()).toEqual([]);
    });

    it("settles at our txid when both our and a foreign spend linkage are present", async () => {
        const txid = ourTxid();
        const coins = new Map([
            [
                key(OFFER),
                fundingCoin({
                    ...OFFER,
                    script: "ac".repeat(34),
                    isSpent: true,
                    arkTxId: txid,
                    spentBy: OTHER_TX,
                }),
            ],
            [key({ txid, vout: 0 }), outputCoin(txid, 0)],
            [key({ txid, vout: 2 }), outputCoin(txid, 2)],
            [key({ txid, vout: 3 }), outputCoin(txid, 3)],
        ]);
        const { store, reconciler } = setup([fill(txid)], coins);
        await reconciler.tick();
        const row = store.get("fill-1")!;
        expect(row.state).toBe("settled");
        expect(row.txid).toBe(txid);
        expect(row.outpoint).toEqual({ txid, vout: 0 });
        expect(store.events).toEqual(["reconcileSettled"]);
    });

    it("requeues a never-invoked prepared fill to quoted without touching the network", async () => {
        const coins = new Map([[key(OFFER), fundingCoin({ ...OFFER, script: "ac".repeat(34) })]]);
        const { store, reconciler } = setup([fill(ourTxid(), { submitInvoked: false })], coins);
        await reconciler.tick();
        const row = store.get("fill-1")!;
        expect(row.state).toBe("quoted");
        expect(row.failureCode).toBe("swap_fill_submit_never_invoked");
        expect(row.submitInvoked).toBe(false);
        expect(store.events).toEqual(["reconcileRequeue"]);
        expect(store.listReservedOutpoints()).toEqual([TAXI_IN]);
    });

    it("leaves a live-lease row alone until its lease expires", async () => {
        const coins = new Map([[key(OFFER), fundingCoin({ ...OFFER, script: "ac".repeat(34) })]]);
        const row = fill(ourTxid(), { submitInvoked: false, leaseUntil: NOW + 60 });
        const { store, indexer } = setup([row], coins);
        await createSwapFillReconciler({ swapFills: store, indexer, now: () => NOW }).tick();
        expect(store.get("fill-1")!.state).toBe("submitting");
        expect(store.events).toEqual([]);
        await createSwapFillReconciler({ swapFills: store, indexer, now: () => NOW + 61 }).tick();
        const back = store.get("fill-1")!;
        expect(back.state).toBe("quoted");
        expect(back.failureCode).toBe("swap_fill_submit_never_invoked");
        expect(store.events).toEqual(["reconcileRequeue"]);
    });

    it("cancels a never-invoked fill whose offer was spent elsewhere", async () => {
        const coins = new Map([
            [
                key(OFFER),
                fundingCoin({
                    ...OFFER,
                    script: "ac".repeat(34),
                    isSpent: true,
                    arkTxId: OTHER_TX,
                }),
            ],
        ]);
        const { store, reconciler } = setup([fill(ourTxid(), { submitInvoked: false })], coins);
        await reconciler.tick();
        const row = store.get("fill-1")!;
        expect(row.state).toBe("cancelled");
        expect(row.spentTxid).toBe(OTHER_TX);
        expect(store.events).toEqual(["recordCancelled"]);
    });

    it("never settles a never-invoked fill even when its prepared txid matches the spend", async () => {
        const txid = ourTxid();
        const coins = new Map([
            [
                key(OFFER),
                fundingCoin({ ...OFFER, script: "ac".repeat(34), isSpent: true, arkTxId: txid }),
            ],
            [key({ txid, vout: 0 }), outputCoin(txid, 0)],
            [key({ txid, vout: 2 }), outputCoin(txid, 2)],
            [key({ txid, vout: 3 }), outputCoin(txid, 3)],
        ]);
        const { store, reconciler } = setup([fill(txid, { submitInvoked: false })], coins);
        await reconciler.tick();
        expect(store.get("fill-1")!.state).toBe("submitting");
        expect(store.events).toEqual([]);
        expect(reconciler.status().blockers).toEqual(["swap_fill_unexpected_spend"]);
        expect(store.listReservedOutpoints()).toEqual([TAXI_IN]);
    });

    it("waits when the offer spend carries no identifying txid", async () => {
        const coins = new Map([
            [key(OFFER), fundingCoin({ ...OFFER, script: "ac".repeat(34), isSpent: true })],
        ]);
        const { store, reconciler } = setup([fill(ourTxid())], coins);
        await reconciler.tick();
        expect(store.get("fill-1")!.state).toBe("submitting");
        expect(store.events).toEqual([]);
    });

    it("keeps ambiguity on indexer failure", async () => {
        const coins = new Map();
        const { store, reconciler } = setup([fill(ourTxid())], coins, new Error("offline"));
        await reconciler.tick();
        expect(store.get("fill-1")!.state).toBe("submitting");
        expect(store.events).toEqual([]);
        expect(reconciler.status().lastTickAt).toBe(NOW);
    });

    it("ignores stale prepared bytes on quoted rows", async () => {
        const coins = new Map([
            [
                key(OFFER),
                fundingCoin({
                    ...OFFER,
                    script: "ac".repeat(34),
                    isSpent: true,
                    arkTxId: OTHER_TX,
                }),
            ],
        ]);
        const quoted = fill(ourTxid(), {
            id: "fill-quoted",
            operationId: "op-quoted",
            state: "quoted",
            leaseToken: undefined,
            leaseOwner: undefined,
        });
        const { store, reconciler } = setup([quoted], coins);
        await reconciler.tick();
        const row = store.get("fill-quoted")!;
        expect(row.state).toBe("quoted");
        expect(row.preparedArkTx).toBe(quoted.preparedArkTx);
        expect(store.events).toEqual([]);
    });

    it("keys settlement off the trusted graph, never the attacker solver graph", async () => {
        const txid = ourTxid();
        const lyingTx = Transaction.fromPSBT(base64.decode(TRUSTED_ARK_TX));
        const current = lyingTx.getOutput(0);
        lyingTx.updateOutput(0, { script: hex.decode("ff".repeat(34)), amount: current.amount! });
        const lying = { ...trustedGraph(), arkTx: base64.encode(lyingTx.toPSBT()) };
        const coins = new Map([
            [
                key(OFFER),
                fundingCoin({ ...OFFER, script: "ac".repeat(34), isSpent: true, arkTxId: txid }),
            ],
            [key({ txid, vout: 0 }), outputCoin(txid, 0)],
            [key({ txid, vout: 2 }), outputCoin(txid, 2)],
            [key({ txid, vout: 3 }), outputCoin(txid, 3)],
        ]);
        const { store, reconciler } = setup([fill(txid, { solverGraph: lying })], coins);
        await reconciler.tick();
        const row = store.get("fill-1")!;
        expect(row.state).toBe("settled");
        expect(row.outpoint).toEqual({ txid, vout: 0 });
    });

    it("serializes concurrent ticks", async () => {
        const coins = new Map([[key(OFFER), fundingCoin({ ...OFFER, script: "ac".repeat(34) })]]);
        const { store, reconciler } = setup([fill(ourTxid())], coins);
        await Promise.all([reconciler.tick(), reconciler.tick()]);
        expect(store.get("fill-1")!.state).toBe("submitting");
        expect(reconciler.status().lastTickAt).toBe(NOW);
    });
});
