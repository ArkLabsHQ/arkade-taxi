import { describe, expect, it, vi } from "vitest";
import {
    asset,
    Extension,
    Transaction,
    type ExtendedVirtualCoin,
    type IWallet,
} from "@arkade-os/sdk";
import type { FillFunding } from "@arkade-os/swap";
import { base64, hex } from "@scure/base";
import {
    buildSwapFillGraph,
    jointGraphFromWire,
    jointGraphToWire,
    swapIdToTaxiAssetId,
    SwapFillBuilderError,
    taxiAssetIdToSwapId,
    type SwapFillBuildRequest,
} from "../../src/arkade/swapFillBuilder.js";
import { sealGraph } from "../swapFillFixtures.js";
import { operatorKey, receiverKey } from "../fixtures.js";
import type { SwapFillGraphWire } from "@arkade-taxi/protocol";
import { fundingCoin } from "../fixtures.js";
import { type BuildOfferFillPlanOpts, type JointGraph } from "@arkade-taxi/client";

const USDT = asset.AssetId.create("1234".repeat(16), 0);
const USDT_SWAP_ID = USDT.toString();
const USDT_TAXI = {
    txid: Uint8Array.from(USDT.txid).reverse(),
    groupIndex: USDT.groupIndex,
};

const wallet = (over: Partial<IWallet> = {}): IWallet =>
    ({
        identity: { xOnlyPublicKey: () => new Uint8Array(32).fill(7) },
        getAddress: async () => "ark1qexample",
        getContractManager: async () => ({}),
        ...over,
    }) as unknown as IWallet;

const coin = fundingCoin();
const solverCoin: FillFunding = {
    txid: "bb".repeat(32),
    vout: 1,
    value: 5000,
    tapTree: coin.tapTree,
    tapLeafScript: coin.forfeitTapLeafScript,
} as FillFunding;

const RECEIVER_SCRIPT = `5120${hex.encode(receiverKey)}`;
const SOLVER_SCRIPT = "51";
const SPONSOR_SCRIPT = `5120${hex.encode(operatorKey)}`;
const SCRIPTS = {
    receiverScript: hex.decode(RECEIVER_SCRIPT),
    solverScript: hex.decode(SOLVER_SCRIPT),
    sponsorScript: hex.decode(SPONSOR_SCRIPT),
};

const makeGraph = (groups: asset.AssetGroup[]): JointGraph => {
    const tx = new Transaction({ version: 3, lockTime: 0 });
    const inpoints = [
        { txid: "aa".repeat(32), vout: 0 },
        { txid: "bb".repeat(32), vout: 1 },
        { txid: "cc".repeat(32), vout: 2 },
    ];
    for (const o of inpoints) tx.addInput({ txid: o.txid, index: o.vout });
    tx.addOutput({ script: hex.decode(RECEIVER_SCRIPT), amount: 1000n });
    tx.addOutput({ script: hex.decode(SOLVER_SCRIPT), amount: 700n });
    tx.addOutput({ script: hex.decode(SPONSOR_SCRIPT), amount: 330n });
    tx.addOutput({ script: hex.decode(SPONSOR_SCRIPT), amount: 500n });
    if (groups.length) {
        const extOut = Extension.create([asset.Packet.create(groups)]).txOut();
        tx.addOutput({ script: extOut.script, amount: extOut.amount });
    }
    return sealGraph({
        arkTx: base64.encode(tx.toPSBT()),
        checkpoints: inpoints.map((o) => {
            const cp = new Transaction({ version: 3, lockTime: 0 });
            cp.addInput({ txid: o.txid, index: o.vout });
            cp.addOutput({ script: new Uint8Array([0x51]), amount: 1000n });
            return base64.encode(cp.toPSBT());
        }),
        graphId: "",
        inputOwners: [null, "solver", "sponsor"],
    });
};

const GRAPH: JointGraph = makeGraph([
    asset.AssetGroup.create(
        USDT,
        null,
        [asset.AssetInput.create(1, 5n)],
        [asset.AssetOutput.create(2, 5n)],
        [],
    ),
]);

const request = (over: Partial<SwapFillBuildRequest> = {}): SwapFillBuildRequest => ({
    offerHex: "deadbeef",
    solverFund: [{ ...solverCoin }],
    fundingOutpoint: { txid: "aa".repeat(32), vout: 0 },
    swapAddress: "ark1qswapaddress",
    ...over,
});

type PlanMock = ReturnType<
    typeof vi.fn<
        (
            _wallet: IWallet,
            _url: string,
            _offer: string,
            _opts: BuildOfferFillPlanOpts,
        ) => Promise<JointGraph>
    >
>;

const planMock = (): PlanMock =>
    vi.fn(
        async (
            _wallet: IWallet,
            _url: string,
            _offer: string,
            _opts: BuildOfferFillPlanOpts,
        ): Promise<JointGraph> => GRAPH,
    );

const deps = (buildPlan?: PlanMock) => ({
    wallet: wallet(),
    arkServerUrl: "https://arkd.example",
    ...(buildPlan ? { buildPlan } : {}),
});

describe("buildSwapFillGraph", () => {
    it("passes the operator wallet through untouched and forwards exact deposit binding", async () => {
        const buildPlan = planMock();
        const w = wallet();
        const graph = await buildSwapFillGraph(
            { wallet: w, arkServerUrl: "https://arkd.example", buildPlan },
            request(),
        );
        expect(graph).toBe(GRAPH);
        expect(buildPlan).toHaveBeenCalledOnce();
        const call = buildPlan.mock.calls[0]!;
        const [gotWallet, gotUrl, gotOffer, opts] = call;
        expect(gotWallet).toBe(w);
        expect(gotUrl).toBe("https://arkd.example");
        expect(gotOffer).toBe("deadbeef");
        expect(opts.fundingOutpoint).toEqual({ txid: "aa".repeat(32), vout: 0 });
        expect(opts.fund).toEqual([solverCoin]);
    });

    it("rejects a fundingTxid that disagrees with the exact outpoint before building", async () => {
        const buildPlan = planMock();
        await expect(
            buildSwapFillGraph(deps(buildPlan), request({ fundingTxid: "ff".repeat(32) })),
        ).rejects.toThrow(/fundingTxid.*does not match/);
        expect(buildPlan).not.toHaveBeenCalled();
    });

    it("refuses a wallet without a signing identity instead of minting one", async () => {
        const buildPlan = planMock();
        await expect(
            buildSwapFillGraph(
                { wallet: {} as IWallet, arkServerUrl: "https://arkd.example", buildPlan },
                request(),
            ),
        ).rejects.toThrow(SwapFillBuilderError);
        expect(buildPlan).not.toHaveBeenCalled();
    });

    it("rejects solver funding without taproot evidence before reaching the swap package", async () => {
        const buildPlan = planMock();
        const { tapTree: _drop, ...bare } = solverCoin as unknown as Record<string, unknown>;
        await expect(
            buildSwapFillGraph(
                deps(buildPlan),
                request({ solverFund: [bare as unknown as FillFunding] }),
            ),
        ).rejects.toThrow(/solverFund\[0\] is missing taproot evidence/);
        expect(buildPlan).not.toHaveBeenCalled();
    });

    it("converts a Taxi fare asset id to the swap asset string", async () => {
        const buildPlan = planMock();
        await buildSwapFillGraph(
            deps(buildPlan),
            request({
                sponsor: {
                    coins: [fundingCoin(), fundingCoin({ txid: "dd".repeat(32), vout: 3 })],
                    netContributionSats: 1000n,
                    changeScript: new Uint8Array([1, 2, 3]),
                    fare: {
                        assetId: USDT_TAXI,
                        amount: 5n,
                        script: new Uint8Array([4, 5, 6]),
                    },
                },
            }),
        );
        const opts = buildPlan.mock.calls[0]![3]!;
        const sponsor = opts.sponsor!;
        expect(sponsor.fare!.assetId).toBe(USDT_SWAP_ID);
        expect(sponsor.fund[0]).toMatchObject({
            txid: "bb".repeat(32),
            vout: 0,
            value: 20000,
        });
        expect(sponsor.fund[0]!.tapTree).toStrictEqual(coin.tapTree);
        expect(sponsor.fund).toHaveLength(2);
    });

    it("rejects asset-bearing sponsor inventory explicitly instead of dropping it", async () => {
        const buildPlan = planMock();
        const assetCoin = fundingCoin({
            assets: [{ assetId: USDT_SWAP_ID, amount: 100n }],
        }) as ExtendedVirtualCoin;
        await expect(
            buildSwapFillGraph(
                deps(buildPlan),
                request({
                    sponsor: {
                        coins: [assetCoin],
                        netContributionSats: 1000n,
                        changeScript: new Uint8Array([1]),
                    },
                }),
            ),
        ).rejects.toThrow(/sponsor\.fund\[0\] carries assets/);
        expect(buildPlan).not.toHaveBeenCalled();
    });
});

describe("taxi asset id conversion", () => {
    it("round-trips Taxi refs through swap asset strings", () => {
        for (const groupIndex of [0, 1, 255]) {
            const id = asset.AssetId.create("ab".repeat(32), groupIndex);
            const ref = {
                txid: Uint8Array.from(id.txid).reverse(),
                groupIndex: id.groupIndex,
            };
            expect(taxiAssetIdToSwapId(ref)).toBe(id.toString());
            expect(swapIdToTaxiAssetId(id.toString())).toEqual(ref);
        }
    });

    it("rejects malformed asset ids with a clear error", () => {
        expect(() => swapIdToTaxiAssetId("not-an-asset-id")).toThrow(SwapFillBuilderError);
        expect(() =>
            taxiAssetIdToSwapId({ txid: new Uint8Array([1, 2, 3]), groupIndex: 0 }),
        ).toThrow(SwapFillBuilderError);
    });
});

describe("wire translation", () => {
    it("round-trips a JointGraph through the protocol wire shape both ways", () => {
        const wire = jointGraphToWire(GRAPH, SCRIPTS);
        expect(wire.template).toBe("taxi-fill/1");
        expect(wire.inputs).toEqual([
            { owner: "offer-covenant", txid: "aa".repeat(32), vout: 0 },
            { owner: "solver", txid: "bb".repeat(32), vout: 1 },
            { owner: "sponsor", txid: "cc".repeat(32), vout: 2 },
        ]);
        expect(wire.graphId).toBe(GRAPH.graphId);
        expect(wire.outputs.map((o) => o.role)).toEqual([
            "receiver",
            "solver",
            "sponsor-fare",
            "sponsor-change",
        ]);
        expect(wire.outputs[2]?.assets).toEqual([
            { assetId: { txid: hex.encode(USDT_TAXI.txid), groupIndex: 0 }, units: "5" },
        ]);
        expect(jointGraphFromWire(wire)).toEqual(GRAPH);
        const back: SwapFillGraphWire = jointGraphToWire(jointGraphFromWire(wire), SCRIPTS);
        expect(back).toEqual(wire);
    });

    it("rejects a wire whose outputs disagree with the transaction", () => {
        const wire = jointGraphToWire(GRAPH, SCRIPTS);
        const diverted = structuredClone(wire);
        diverted.outputs[3] = { ...diverted.outputs[3]!, sats: "1" };
        expect(() => jointGraphFromWire(diverted)).toThrow(/disagrees with the transaction/);
    });

    it("rejects mismatched parallel arrays and a wrong template", () => {
        expect(() =>
            jointGraphToWire(
                {
                    ...GRAPH,
                    inputOwners: [null],
                },
                SCRIPTS,
            ),
        ).toThrow(/must agree/);
        expect(() =>
            jointGraphFromWire({
                ...jointGraphToWire(GRAPH, SCRIPTS),
                template: "taxi-fill/2",
            } as unknown as SwapFillGraphWire),
        ).toThrow(/template/);
    });

    it("keeps same-genesis assets with different group indices distinct on the wire", () => {
        const sibling = asset.AssetId.create("1234".repeat(16), 1);
        const graph = makeGraph([
            asset.AssetGroup.create(
                USDT,
                null,
                [asset.AssetInput.create(1, 5n)],
                [asset.AssetOutput.create(2, 5n)],
                [],
            ),
            asset.AssetGroup.create(
                sibling,
                null,
                [asset.AssetInput.create(1, 9n)],
                [asset.AssetOutput.create(2, 9n)],
                [],
            ),
        ]);
        const wire = jointGraphToWire(graph, SCRIPTS);
        const fareAssets = wire.outputs[2]?.assets;
        expect(fareAssets).toEqual([
            { assetId: { txid: hex.encode(USDT_TAXI.txid), groupIndex: 0 }, units: "5" },
            {
                assetId: { txid: hex.encode(USDT_TAXI.txid), groupIndex: 1 },
                units: "9",
            },
        ]);
        expect(fareAssets?.[0]?.assetId).not.toEqual(fareAssets?.[1]?.assetId);
        expect(jointGraphFromWire(wire)).toEqual(graph);
    });
});
