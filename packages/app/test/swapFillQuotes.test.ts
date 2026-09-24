import { beforeEach, describe, expect, it } from "vitest";
import { asset, Transaction, type ExtendedVirtualCoin } from "@arkade-os/sdk";
import { base64 } from "@scure/base";
import type { Policy } from "@arkade-taxi/core";
import type { ReceiverFare } from "@arkade-taxi/covenant";
import { hex } from "@scure/base";
import {
    createSwapFillQuote,
    getSwapFill,
    revalidateBoundSwapFill,
    type SwapFillQuoteDeps,
} from "../src/swapFillQuotes.js";
import type { ServiceError } from "../src/errors.js";
import {
    config,
    fundingCoin,
    MemoryAdvances,
    NOW,
    operatorTree,
    policy as basePolicy,
    runtimeSafety,
    senderTree,
    serverUnroll,
} from "./fixtures.js";
import {
    asIndexed,
    FAKE_COVENANT,
    FAKE_COVENANT_SCRIPT,
    FAKE_MAKER_SCRIPT,
    FakeSwapFillGraphBuilder,
    fakeOfferTerms,
    MemorySwapFills,
    offerTaprootOf,
    solverTaproot,
} from "./swapFillFixtures.js";
import {
    createBoundJointFill,
    insertReceiveQuote,
    WANTED_ASSET,
    WANTED_SWAP_ID,
} from "./jointFillFixtures.js";
import { readFundingSource } from "../src/arkade/fundingSource.js";

const DEP = { txid: "dd".repeat(32), vout: 3 };
const SOLVER_COIN = { txid: "ee".repeat(32), vout: 1 };
const TAXI_0 = { txid: "cc".repeat(32), vout: 0 };
const TAXI_1 = { txid: "cc".repeat(32), vout: 1 };
const COVENANT_SCRIPT = FAKE_COVENANT_SCRIPT;
const MAKER_SCRIPT = FAKE_MAKER_SCRIPT;
const PROCEEDS_SCRIPT = "51";
const WANT = 5000n;
const SOLVER_VALUE = 6000;
const CONTRIBUTION = 330n;
const FARE_ASSET = {
    txid: Buffer.from("1234".repeat(16), "hex").reverse().toString("hex"),
    groupIndex: 0,
};
const FARE_SWAP_ID = asset.AssetId.create("1234".repeat(16), 0).toString();
const FARE_UNITS = 5n;
const SOLVER_ASSET_AMOUNT = 100n;

let advances: MemoryAdvances;
let swapFills: MemorySwapFills;
let builder: FakeSwapFillGraphBuilder;
let indexerCoins: Map<string, ExtendedVirtualCoin>;
let taxiCoins: ExtendedVirtualCoin[];
let intentLocks: { txid: string; vout: number }[];
let advanceLocks: { txid: string; vout: number }[];
let testPolicy: Policy;
let ids: number;

const key = (o: { txid: string; vout: number }): string => `${o.txid}:${o.vout}`;

const body = (over: Record<string, unknown> = {}) => ({
    operationId: "op-1",
    offerHex: "ab12",
    solverInputs: [
        {
            txid: SOLVER_COIN.txid,
            vout: SOLVER_COIN.vout,
            value: String(SOLVER_VALUE),
            ...solverTaproot(),
            assets: [{ assetId: FARE_ASSET, amount: String(SOLVER_ASSET_AMOUNT) }],
        },
    ],
    solverProceedsScript: PROCEEDS_SCRIPT,
    solverKeys: ["ab".repeat(32)],
    contributionSats: CONTRIBUTION.toString(),
    maxFare: { currency: "asset", assetId: FARE_ASSET, units: String(FARE_UNITS) },
    fundingTxid: DEP.txid,
    fundingVout: DEP.vout,
    ...over,
});

const deps = (over: Partial<SwapFillQuoteDeps> = {}): SwapFillQuoteDeps => ({
    runtime: {
        assertAdmission: async () => {},
        withAdmission: async (work) => work(() => {}),
        safety: () => runtimeSafety(),
    },
    policy: {
        get: () => testPolicy,
        getSnapshot: () => ({ policy: testPolicy, revision: 1n }),
    },
    advances,
    reservations: { listReservedOutpoints: () => advanceLocks, expireQuotes: () => 0 },
    swapFills,
    inventory: {
        getSpendableVtxos: async () => taxiCoins,
        getLockedVtxoOutpoints: async () => intentLocks,
    },
    senderInventory: {
        getVtxos: async (opts) => ({
            vtxos:
                opts?.outpoints
                    ?.map((o) => indexerCoins.get(key(o))!)
                    .filter(Boolean)
                    .map(asIndexed) ?? [],
        }),
    },
    config: config(),
    now: () => NOW,
    nowMs: () => NOW * 1000,
    randomId: () => `fill-${++ids}`,
    swapFillBuilder: builder,
    offerCodec: { decodeOffer: () => fakeOfferTerms() },
    providerLimits: async () => ({ vtxoMaxAmount: 10_000_000n }),
    ...over,
});

const caught = async (fn: () => Promise<unknown>): Promise<ServiceError> => {
    try {
        await fn();
    } catch (e) {
        return e as ServiceError;
    }
    throw new Error("expected a rejection");
};

/** Thin wrapper over `insertReceiveQuote`: adds the deps wiring and indexer
 * coins a receiver-paid `createSwapFillQuote` guard test needs. */
function quotedReceiverPaid(
    receiverFare: ReceiverFare,
    wantAmount: bigint,
): { d: SwapFillQuoteDeps; quoteId: string; close: () => void } {
    const {
        db,
        cfg,
        quoteId,
        policies,
        quotes,
        swapFills,
        advances,
        reservations,
        covenant,
        operatorCoin,
        depositCoin,
        makerKey,
    } = insertReceiveQuote({ wantAmount, receiverFare });
    builder = new FakeSwapFillGraphBuilder(hex.encode(covenant.pkScript), 330n, {
        id: WANTED_SWAP_ID,
        amount: wantAmount,
    });
    const d = deps({
        policy: policies,
        advances,
        reservations,
        swapFills,
        receiveQuotes: quotes,
        inventory: {
            getSpendableVtxos: async () => [operatorCoin],
            getLockedVtxoOutpoints: async () => [],
        },
        config: cfg,
        getServerUnroll: () => serverUnroll,
        offerCodec: {
            decodeOffer: () =>
                fakeOfferTerms({
                    ...offerTaprootOf(depositCoin),
                    makerProceedsScript: covenant.pkScript,
                    makerPublicKey: makerKey,
                    wantAsset: WANTED_ASSET,
                    wantAmount,
                }),
        },
    });
    indexerCoins.set(key(DEP), depositCoin);
    indexerCoins.set(
        key(SOLVER_COIN),
        fundingCoin({
            txid: SOLVER_COIN.txid,
            vout: SOLVER_COIN.vout,
            value: SOLVER_VALUE,
            assets: [{ assetId: WANTED_SWAP_ID, amount: wantAmount }],
        }),
    );
    return { d, quoteId, close: () => db.close() };
}

beforeEach(() => {
    advances = new MemoryAdvances();
    swapFills = new MemorySwapFills();
    builder = new FakeSwapFillGraphBuilder(MAKER_SCRIPT, WANT);
    indexerCoins = new Map([
        [
            key(DEP),
            fundingCoin({
                txid: DEP.txid,
                vout: DEP.vout,
                value: 10000,
                script: COVENANT_SCRIPT,
            }),
        ],
        [
            key(SOLVER_COIN),
            fundingCoin({
                txid: SOLVER_COIN.txid,
                vout: SOLVER_COIN.vout,
                value: SOLVER_VALUE,
                assets: [{ assetId: FARE_SWAP_ID, amount: SOLVER_ASSET_AMOUNT }],
            }),
        ],
    ]);
    taxiCoins = [
        fundingCoin({ txid: TAXI_0.txid, vout: TAXI_0.vout }),
        fundingCoin({ txid: TAXI_1.txid, vout: TAXI_1.vout }),
    ];
    intentLocks = [];
    advanceLocks = [];
    testPolicy = basePolicy();
    ids = 0;
});

describe("createSwapFillQuote", () => {
    it("atomically binds a live receive quote with its actual fare and recovery source", async () => {
        const {
            db,
            cfg,
            policies,
            quotes,
            swapFills: storedFills,
            advances: storedAdvances,
            reservations,
            covenant,
            operatorCoin,
            depositCoin,
            makerKey,
        } = insertReceiveQuote({ wantAmount: 5n });
        try {
            builder = new FakeSwapFillGraphBuilder(hex.encode(covenant.pkScript), 330n, {
                id: WANTED_SWAP_ID,
                amount: 5n,
            });
            const d = deps({
                policy: policies,
                advances: storedAdvances,
                reservations,
                swapFills: storedFills,
                receiveQuotes: quotes,
                inventory: {
                    getSpendableVtxos: async () => [operatorCoin],
                    getLockedVtxoOutpoints: async () => [],
                },
                config: cfg,
                getServerUnroll: () => serverUnroll,
                offerCodec: {
                    decodeOffer: () =>
                        fakeOfferTerms({
                            ...offerTaprootOf(depositCoin),
                            makerProceedsScript: covenant.pkScript,
                            makerPublicKey: makerKey,
                            wantAsset: WANTED_ASSET,
                            wantAmount: 5n,
                        }),
                },
            });
            indexerCoins.set(key(DEP), depositCoin);
            indexerCoins.set(
                key(SOLVER_COIN),
                fundingCoin({
                    txid: SOLVER_COIN.txid,
                    vout: SOLVER_COIN.vout,
                    value: SOLVER_VALUE,
                    assets: [{ assetId: WANTED_SWAP_ID, amount: 5n }],
                }),
            );
            const result = await createSwapFillQuote(
                d,
                body({
                    receiveQuoteId: "receive-1",
                    contributionSats: "329",
                    maxFare: { currency: "sats", units: "30" },
                    solverInputs: [
                        {
                            txid: SOLVER_COIN.txid,
                            vout: SOLVER_COIN.vout,
                            value: String(SOLVER_VALUE),
                            ...solverTaproot(),
                            assets: [{ assetId: FARE_ASSET, amount: "5" }],
                        },
                    ],
                }),
            );
            expect(result.fare).toEqual({ currency: "sats", units: "4" });
            expect(result.graph.outputs.some((output) => output.role === "sponsor-fare")).toBe(
                false,
            );
            expect(
                result.graph.outputs.find((output) => output.role === "sponsor-change")?.sats,
            ).toBe("19675");
            expect(builder.built[0]!.sponsor).toMatchObject({
                netContributionSats: 329n,
                combineSatsFareWithChange: true,
                fare: { sats: 4n },
            });
            const fill = storedFills.get(result.fillId)!;
            const advance = storedAdvances.get("receive-1")!;
            expect(fill.receiveQuoteId).toBe("receive-1");
            expect(quotes.get("receive-1")).toMatchObject({ state: "bound", boundFillId: fill.id });
            expect(advance).toMatchObject({ state: "locking", topup: 329n, assetUnits: 5n });
            expect(advance.outpoint).toBeUndefined();
            expect(reservations.listForAdvance("receive-1")).toEqual([TAXI_0]);
            const source = readFundingSource(advance.unsignedLockupTx);
            expect(source).toMatchObject({
                kind: "joint-fill",
                source: {
                    fillId: fill.id,
                    recoveryPreflight: { expectedTxid: expect.any(String) },
                },
            });
            const derived = offerTaprootOf(depositCoin);
            const recorded = source.kind === "joint-fill" ? source.source.inputs : [];
            expect(
                recorded.map(({ role, tapTree, spendLeaf }) => ({ role, tapTree, spendLeaf })),
            ).toEqual([
                {
                    role: "offer-covenant",
                    tapTree: hex.encode(derived.covenantTapTree),
                    spendLeaf: hex.encode(derived.covenantSpendLeaf),
                },
                { role: "solver", ...solverTaproot() },
                { role: "sponsor", ...solverTaproot(operatorTree) },
            ]);
            await expect(revalidateBoundSwapFill(d, fill)).resolves.toBeUndefined();
            indexerCoins.set(key(DEP), { ...depositCoin, script: FAKE_COVENANT_SCRIPT });
            await expect(revalidateBoundSwapFill(d, fill)).rejects.toThrow(/bound input/);
            indexerCoins.set(key(DEP), depositCoin);
            indexerCoins.set(key(SOLVER_COIN), {
                ...indexerCoins.get(key(SOLVER_COIN))!,
                isSpent: true,
            });
            await expect(revalidateBoundSwapFill(d, fill)).rejects.toThrow(/bound input/);
        } finally {
            db.close();
        }
    });

    it("quotes a sponsored fill, persists the reservation and replays identical retries", async () => {
        const d = deps();
        const first = await createSwapFillQuote(d, body());
        expect(first.fillId).toBe("fill-1");
        expect(first.operationId).toBe("op-1");
        expect(first.expiresAt).toBe(NOW + 60);
        expect(first.template).toBe("taxi-fill/1");
        expect(first.contributionSats).toBe(CONTRIBUTION.toString());
        expect(first.fare).toEqual({
            currency: "asset",
            assetId: FARE_ASSET,
            units: FARE_UNITS.toString(),
        });
        expect(first.graph.inputs).toEqual([
            { owner: "offer-covenant", txid: DEP.txid, vout: DEP.vout },
            { owner: "solver", txid: SOLVER_COIN.txid, vout: SOLVER_COIN.vout },
            { owner: "sponsor", txid: TAXI_0.txid, vout: TAXI_0.vout },
        ]);
        const stored = swapFills.get("fill-1")!;
        expect(stored.state).toBe("quoted");
        expect(stored.taxiInputs).toEqual([TAXI_0]);
        expect(stored.offerTxid).toBe(DEP.txid);
        expect(stored.offerVout).toBe(DEP.vout);
        expect(swapFills.listReservedOutpoints()).toEqual([TAXI_0]);
        expect(builder.built).toHaveLength(1);
        const solverFund = builder.built[0]!.solverFund;
        expect(solverFund[0]!.tapTree).toBeTruthy();
        expect(solverFund[0]!.tapLeafScript).toBeTruthy();
        const builtFare = builder.built[0]!.sponsor!.fare!;
        expect(builtFare.amount).toBe(FARE_UNITS);
        expect(builtFare.assetId).toEqual({ txid: expect.any(Uint8Array), groupIndex: 0 });
        expect(first.graph.outputs.find((o) => o.role === "sponsor-fare")?.assets).toEqual([
            { assetId: FARE_ASSET, units: FARE_UNITS.toString() },
        ]);

        const second = await createSwapFillQuote(d, body());
        expect(second).toEqual(first);
        expect(builder.built).toHaveLength(1);
        expect(swapFills.rows.size).toBe(1);
    });

    it("charges a sats fare when maxFare names no asset", async () => {
        const d = deps();
        indexerCoins.set(
            key(SOLVER_COIN),
            fundingCoin({ txid: SOLVER_COIN.txid, vout: SOLVER_COIN.vout, value: SOLVER_VALUE }),
        );
        const quote = await createSwapFillQuote(
            d,
            body({
                solverInputs: [
                    {
                        txid: SOLVER_COIN.txid,
                        vout: SOLVER_COIN.vout,
                        value: String(SOLVER_VALUE),
                        ...solverTaproot(),
                    },
                ],
                maxFare: { currency: "sats", units: "1000" },
            }),
        );
        // Sats fares used to be unpriceable: the builder required an assetId, so
        // the fill took none and disclosed zero.
        expect(builder.built[0]!.sponsor!.fare).toEqual({
            script: expect.any(Uint8Array),
            sats: 1000n,
        });
        expect(quote.fare).toEqual({ currency: "sats", units: "1000" });
        expect(quote.graph.outputs.some((o) => o.role === "sponsor-fare")).toBe(true);
    });

    it("conflicts when the same operation id carries different terms", async () => {
        const d = deps();
        await createSwapFillQuote(d, body());
        const conflict = await caught(() =>
            createSwapFillQuote(d, body({ contributionSats: "331" })),
        );
        expect(conflict.status).toBe(409);
        expect(conflict.code).toBe("operation_conflict");
        expect(swapFills.rows.size).toBe(1);
    });

    it("mints the fill deadline on the caller ceiling when it is under the operator TTL", async () => {
        const quote = await createSwapFillQuote(deps(), body({ validUntil: NOW + 25 }));
        expect(quote.expiresAt).toBe(NOW + 25);
        expect(swapFills.get(quote.fillId)!.validUntil).toBe(NOW + 25);
    });

    it("keeps the operator TTL when the caller ceiling is later", async () => {
        const late = await createSwapFillQuote(deps(), body({ validUntil: NOW + 6000 }));
        expect(late.expiresAt).toBe(NOW + 60);
        expect(swapFills.get(late.fillId)!.validUntil).toBe(NOW + 6000);
    });

    it("leaves a request without a ceiling on the operator TTL alone", async () => {
        const legacy = await createSwapFillQuote(deps(), body());
        expect(legacy.expiresAt).toBe(NOW + 60);
        expect(swapFills.get(legacy.fillId)!.validUntil).toBeUndefined();
    });

    it("floors a bound fill and its advance together on the caller ceiling", async () => {
        const tight = await createBoundJointFill({ validUntil: NOW + 25 });
        try {
            expect(tight.receiveQuotes.get("receive-1")!.expiresAt).toBe(NOW + 60);
            expect(tight.quote.expiresAt).toBe(NOW + 25);
            expect(tight.fill.expiresAt).toBe(NOW + 25);
            expect(tight.fill.validUntil).toBe(NOW + 25);
            // bind() refuses an advance whose deadline drifts from its fill's.
            expect(tight.advance.expiresAt).toBe(NOW + 25);
        } finally {
            tight.close();
        }
        const loose = await createBoundJointFill({ validUntil: NOW + 6000 });
        try {
            expect(loose.fill.expiresAt).toBe(NOW + 60);
            expect(loose.advance.expiresAt).toBe(NOW + 60);
        } finally {
            loose.close();
        }
    });

    it("treats a changed caller ceiling as a conflict, not a mutable extension", async () => {
        const d = deps();
        const first = await createSwapFillQuote(d, body({ validUntil: NOW + 25 }));
        expect(await createSwapFillQuote(d, body({ validUntil: NOW + 25 }))).toEqual(first);
        for (const validUntil of [NOW + 26, undefined]) {
            const conflict = await caught(() => createSwapFillQuote(d, body({ validUntil })));
            expect(conflict.status).toBe(409);
            expect(conflict.code).toBe("operation_conflict");
        }
        expect(swapFills.rows.size).toBe(1);
        expect(builder.built).toHaveLength(1);
    });

    it("refuses a ceiling already reached without reserving or building anything", async () => {
        for (const validUntil of [NOW, NOW - 1]) {
            const refused = await caught(() => createSwapFillQuote(deps(), body({ validUntil })));
            expect(refused.status).toBe(409);
            expect(refused.code).toBe("swap_fill_deadline_expired");
        }
        expect(swapFills.rows.size).toBe(0);
        expect(swapFills.listReservedOutpoints()).toEqual([]);
        expect(builder.built).toHaveLength(0);
    });

    it("refuses a ceiling the clock crosses while the graph is being built", async () => {
        let clock = NOW;
        builder.mutate = (graph) => {
            clock = NOW + 25;
            return graph;
        };
        const refused = await caught(() =>
            createSwapFillQuote(
                deps({ now: () => clock, nowMs: () => clock * 1000 }),
                body({ validUntil: NOW + 25 }),
            ),
        );
        expect(refused.status).toBe(409);
        expect(refused.code).toBe("swap_fill_deadline_expired");
        expect(builder.built).toHaveLength(1);
        expect(swapFills.rows.size).toBe(0);
        expect(swapFills.listReservedOutpoints()).toEqual([]);
    });

    it("refuses to quote while paused or below reserve", async () => {
        testPolicy = basePolicy({ paused: true });
        const refused = await caught(() => createSwapFillQuote(deps(), body()));
        expect(refused.status).toBe(503);
        expect(refused.code).toBe("paused");
        testPolicy = basePolicy();
        const low = await caught(() =>
            createSwapFillQuote(
                deps({ config: config({ operatorMinReserveSats: 1_000_000n }) }),
                body(),
            ),
        );
        expect(low.status).toBe(503);
    });

    it("binds the exact offer outpoint, never a txid alone", async () => {
        const missing = await caught(() =>
            createSwapFillQuote(deps(), body({ fundingVout: undefined })),
        );
        expect(missing.status).toBe(400);
        const lone = await caught(() =>
            createSwapFillQuote(deps(), {
                ...body(),
                fundingTxid: undefined,
                fundingVout: undefined,
            }),
        );
        expect(lone.status).toBe(400);
    });

    it("rejects a deposit the indexer does not serve at the bound outpoint", async () => {
        indexerCoins.delete(key(DEP));
        const unknown = await caught(() => createSwapFillQuote(deps(), body()));
        expect(unknown.status).toBe(400);
        expect(unknown.code).toBe("swap_fill_deposit_unknown");
    });

    it("rejects a deposit whose script differs from the offer covenant", async () => {
        indexerCoins.set(
            key(DEP),
            fundingCoin({ txid: DEP.txid, vout: DEP.vout, value: 10000, script: "00".repeat(34) }),
        );
        const mismatch = await caught(() => createSwapFillQuote(deps(), body()));
        expect(mismatch.status).toBe(400);
        expect(mismatch.code).toBe("swap_fill_deposit_mismatch");
    });

    it("never spends a coin an advance already reserved, and skips intent locks", async () => {
        advanceLocks = [{ ...TAXI_0 }];
        intentLocks = [{ ...TAXI_1 }];
        taxiCoins = [
            fundingCoin({ txid: TAXI_0.txid, vout: TAXI_0.vout }),
            fundingCoin({ txid: TAXI_1.txid, vout: TAXI_1.vout }),
            fundingCoin({ txid: "dd".repeat(32), vout: 9 }),
            fundingCoin({ txid: "ff".repeat(32), vout: 0 }),
        ];
        const quote = await createSwapFillQuote(deps(), body());
        const taxiInputs = quote.graph.inputs.filter((i) => i.owner === "sponsor");
        expect(taxiInputs).toEqual([{ owner: "sponsor", txid: "dd".repeat(32), vout: 9 }]);
    });

    it("rejects asset-bearing sponsor inventory explicitly instead of an empty-inventory mystery", async () => {
        const USDT = asset.AssetId.create("1234".repeat(16), 0).toString();
        taxiCoins = [
            fundingCoin({
                txid: "af".repeat(32),
                vout: 0,
                value: 50000,
                assets: [{ assetId: USDT, amount: 100n }],
            }),
        ];
        const rejected = await caught(() => createSwapFillQuote(deps(), body()));
        expect(rejected.code).toBe("sponsor_assets_unsupported");
        expect(builder.built).toHaveLength(0);
    });

    describe("taproot build data the indexer cannot serve", () => {
        const withSolverTaproot = (taproot: Record<string, unknown>) =>
            body({
                solverInputs: [
                    {
                        ...body().solverInputs[0],
                        tapTree: undefined,
                        spendLeaf: undefined,
                        ...taproot,
                    },
                ],
            });

        it("serves no taproot data, as the production indexer does", async () => {
            const { vtxos } = await deps().senderInventory.getVtxos({
                outpoints: [DEP, SOLVER_COIN],
            });
            expect(vtxos).toHaveLength(2);
            for (const coin of vtxos) {
                expect(coin).not.toHaveProperty("tapTree");
                expect(coin).not.toHaveProperty("forfeitTapLeafScript");
                expect(coin).not.toHaveProperty("intentTapLeafScript");
            }
        });

        it("quotes a deposit whose script the offer's derived covenant rebuilds", async () => {
            await expect(createSwapFillQuote(deps(), body())).resolves.toMatchObject({
                fillId: "fill-1",
            });
        });

        it("refuses a deposit the offer's derived covenant does not rebuild", async () => {
            const refused = await caught(() =>
                createSwapFillQuote(
                    deps({
                        offerCodec: {
                            decodeOffer: () => fakeOfferTerms(offerTaprootOf(fundingCoin())),
                        },
                    }),
                    body(),
                ),
            );
            expect(refused.status).toBe(400);
            expect(refused.code).toBe("swap_fill_deposit_mismatch");
            expect(builder.built).toHaveLength(0);
        });

        it("hands the builder the solver's tree and leaf once the tree rebuilds the indexed script", async () => {
            await createSwapFillQuote(deps(), body());
            const [fund] = builder.built[0]!.solverFund;
            expect(fund!.tapTree).toEqual(operatorTree.encode());
            expect(fund!.tapLeafScript).toEqual(
                operatorTree.findLeaf(hex.encode(operatorTree.scripts[0]!)),
            );
        });

        const refusals: [string, Record<string, unknown>, number, string, RegExp][] = [
            [
                "a tree whose key is not the coin's script",
                solverTaproot(senderTree),
                400,
                "swap_fill_solver_taproot_mismatch",
                /solver input 0/,
            ],
            [
                "a spend leaf outside the tree",
                { ...solverTaproot(), spendLeaf: solverTaproot(senderTree).spendLeaf },
                400,
                "swap_fill_solver_leaf_unknown",
                /solver input 0/,
            ],
            [
                "a tree that does not decode",
                { ...solverTaproot(), tapTree: "0102" },
                400,
                "swap_fill_solver_taproot_invalid",
                /solver input 0/,
            ],
            [
                "no tree",
                { spendLeaf: solverTaproot().spendLeaf },
                400,
                "invalid_request",
                /solverInputs\[0\]\.tapTree/,
            ],
            [
                "no spend leaf",
                { tapTree: solverTaproot().tapTree },
                400,
                "invalid_request",
                /solverInputs\[0\]\.spendLeaf/,
            ],
        ];
        for (const [name, taproot, status, code, message] of refusals)
            it(`refuses solver taproot data with ${name}`, async () => {
                const refused = await caught(() =>
                    createSwapFillQuote(deps(), withSolverTaproot(taproot)),
                );
                expect(refused.status).toBe(status);
                expect(refused.code).toBe(code);
                expect(refused.message).toMatch(message);
                expect(builder.built).toHaveLength(0);
                expect(swapFills.rows.size).toBe(0);
            });

        it("checks the solver tree against the indexed coin, never against the request", async () => {
            indexerCoins.set(
                key(SOLVER_COIN),
                fundingCoin({
                    ...indexerCoins.get(key(SOLVER_COIN))!,
                    script: FAKE_COVENANT_SCRIPT,
                }),
            );
            const refused = await caught(() => createSwapFillQuote(deps(), body()));
            expect(refused.code).toBe("swap_fill_solver_taproot_mismatch");
            const accepted = await createSwapFillQuote(
                deps(),
                withSolverTaproot(solverTaproot(FAKE_COVENANT)),
            );
            expect(accepted.fillId).toBe("fill-1");
        });
    });

    it("rejects solver funding whose value differs from the claim", async () => {
        indexerCoins.set(
            key(SOLVER_COIN),
            fundingCoin({ txid: SOLVER_COIN.txid, vout: SOLVER_COIN.vout, value: 1 }),
        );
        const mismatch = await caught(() => createSwapFillQuote(deps(), body()));
        expect(mismatch.status).toBe(400);
        expect(mismatch.code).toBe("swap_fill_solver_mismatch");
        expect(builder.built).toHaveLength(0);
    });

    it("refuses a graph whose sponsor change differs from the reservation", async () => {
        builder.mutate = (graph) => {
            const tx = Transaction.fromPSBT(base64.decode(graph.arkTx));
            const current = tx.getOutput(3);
            tx.updateOutput(3, { script: current.script, amount: 1n });
            return { ...graph, arkTx: base64.encode(tx.toPSBT()) };
        };
        const bad = await caught(() => createSwapFillQuote(deps(), body()));
        expect(bad.status).toBe(503);
        expect(bad.code).toBe("swap_fill_graph_mismatch");
        expect(swapFills.rows.size).toBe(0);
    });

    it("reports quoted fills with exact state and 404s unknown ids", async () => {
        const d = deps();
        await createSwapFillQuote(d, body());
        expect(getSwapFill(d, "fill-1")).toMatchObject({
            fillId: "fill-1",
            operationId: "op-1",
            state: "quoted",
        });
        const missing = await caught(async () => getSwapFill(d, "nope"));
        expect(missing.status).toBe(404);
    });

    it("expires quoted fills without a submit transition", async () => {
        const d = deps();
        await createSwapFillQuote(d, body());
        const expired = getSwapFill({ ...d, now: () => NOW + 61 }, "fill-1");
        expect(expired.state).toBe("expired");
        expect(swapFills.listReservedOutpoints()).toEqual([]);
    });

    describe("receiver-paid receive quotes", () => {
        it("binds a receiver-paid quote with the contribution set to the whole dust", async () => {
            const { d, quoteId, close } = quotedReceiverPaid({ currency: "sats", units: 4n }, 5n);
            try {
                const fill = await createSwapFillQuote(
                    d,
                    body({
                        receiveQuoteId: quoteId,
                        contributionSats: "330",
                        maxFare: { currency: "sats", units: "0" },
                        solverInputs: [
                            {
                                txid: SOLVER_COIN.txid,
                                vout: SOLVER_COIN.vout,
                                value: String(SOLVER_VALUE),
                                ...solverTaproot(),
                                assets: [{ assetId: FARE_ASSET, amount: "5" }],
                            },
                        ],
                    }),
                );
                expect(fill.contributionSats).toBe("330");
                expect(fill.fare).toEqual({ currency: "sats", units: "0" });
                expect(fill.graph.outputs.some((o) => o.role === "sponsor-fare")).toBe(false);
            } finally {
                close();
            }
        });

        it("refuses a contribution short of the whole dust on a receiver-paid quote", async () => {
            const { d, quoteId, close } = quotedReceiverPaid({ currency: "sats", units: 4n }, 5n);
            try {
                await expect(
                    createSwapFillQuote(
                        d,
                        body({
                            receiveQuoteId: quoteId,
                            contributionSats: "329",
                            maxFare: { currency: "sats", units: "0" },
                        }),
                    ),
                ).rejects.toThrow(/differs from the receive quote/);
            } finally {
                close();
            }
        });

        it("refuses a delivery smaller than the receiver's asset fare", async () => {
            const { d, quoteId, close } = quotedReceiverPaid({ currency: "asset", units: 9n }, 8n);
            try {
                await expect(
                    createSwapFillQuote(
                        d,
                        body({
                            receiveQuoteId: quoteId,
                            contributionSats: "330",
                            maxFare: { currency: "sats", units: "0" },
                            solverInputs: [
                                {
                                    txid: SOLVER_COIN.txid,
                                    vout: SOLVER_COIN.vout,
                                    value: String(SOLVER_VALUE),
                                    ...solverTaproot(),
                                    assets: [{ assetId: FARE_ASSET, amount: "8" }],
                                },
                            ],
                        }),
                    ),
                ).rejects.toThrow(/fare is not smaller than the delivered units/);
            } finally {
                close();
            }
        });

        it("refuses a delivery exactly equal to the asset fare", async () => {
            // At equality out[1] carries zero units, and the leaf's out[1] lookup is
            // required, so the claim would succeed only for a Bob who already held the asset.
            const { d, quoteId, close } = quotedReceiverPaid({ currency: "asset", units: 9n }, 9n);
            try {
                await expect(
                    createSwapFillQuote(
                        d,
                        body({
                            receiveQuoteId: quoteId,
                            contributionSats: "330",
                            maxFare: { currency: "sats", units: "0" },
                            solverInputs: [
                                {
                                    txid: SOLVER_COIN.txid,
                                    vout: SOLVER_COIN.vout,
                                    value: String(SOLVER_VALUE),
                                    ...solverTaproot(),
                                    assets: [{ assetId: FARE_ASSET, amount: "9" }],
                                },
                            ],
                        }),
                    ),
                ).rejects.toThrow(/fare is not smaller than the delivered units/);
            } finally {
                close();
            }
        });

        it("admits a delivery one unit above the asset fare", async () => {
            const { d, quoteId, close } = quotedReceiverPaid({ currency: "asset", units: 9n }, 10n);
            try {
                await expect(
                    createSwapFillQuote(
                        d,
                        body({
                            receiveQuoteId: quoteId,
                            contributionSats: "330",
                            maxFare: { currency: "sats", units: "0" },
                            solverInputs: [
                                {
                                    txid: SOLVER_COIN.txid,
                                    vout: SOLVER_COIN.vout,
                                    value: String(SOLVER_VALUE),
                                    ...solverTaproot(),
                                    assets: [{ assetId: FARE_ASSET, amount: "10" }],
                                },
                            ],
                        }),
                    ),
                ).resolves.toBeDefined();
            } finally {
                close();
            }
        });
    });
});
