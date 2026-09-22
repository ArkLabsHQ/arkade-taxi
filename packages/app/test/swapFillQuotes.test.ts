import { beforeEach, describe, expect, it } from "vitest";
import { ArkAddress, asset, Transaction, type ExtendedVirtualCoin } from "@arkade-os/sdk";
import { base64 } from "@scure/base";
import type { Policy } from "@arkade-taxi/core";
import { DustCovenantScript } from "@arkade-taxi/covenant";
import {
    AdvanceRepository,
    openDatabase,
    PolicyRepository,
    ReceiveQuoteRepository,
    ReservationRepository,
    SwapFillRepository,
} from "@arkade-taxi/db";
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
    policy as basePolicy,
    runtimeSafety,
    receiverKey,
    serverUnroll,
} from "./fixtures.js";
import {
    FAKE_MAKER_SCRIPT,
    FakeSwapFillGraphBuilder,
    fakeOfferTerms,
    MemorySwapFills,
} from "./swapFillFixtures.js";
import { operatorFundingInput } from "../src/arkade/lockupBuilder.js";
import { readFundingSource } from "../src/arkade/fundingSource.js";

const DEP = { txid: "dd".repeat(32), vout: 3 };
const SOLVER_COIN = { txid: "ee".repeat(32), vout: 1 };
const TAXI_0 = { txid: "cc".repeat(32), vout: 0 };
const TAXI_1 = { txid: "cc".repeat(32), vout: 1 };
const COVENANT_SCRIPT = "ac".repeat(34);
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
            vtxos: opts?.outpoints?.map((o) => indexerCoins.get(key(o))!).filter(Boolean) ?? [],
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
        const db = openDatabase(":memory:");
        try {
            const cfg = config({ vtxoMinAmount: 1n });
            const wantedAsset = { txid: hex.decode(FARE_ASSET.txid), groupIndex: 0 };
            const policies = new PolicyRepository(db);
            policies.update(
                {
                    ...testPolicy,
                    assetRules: [
                        ...testPolicy.assetRules,
                        {
                            assetId: wantedAsset,
                            enabled: true,
                            claim: "either",
                            maxTopupSats: null,
                            fares: [
                                {
                                    id: "receive",
                                    currency: { kind: "sats" },
                                    pricing: { kind: "flat", units: 4n },
                                },
                            ],
                        },
                    ],
                },
                "test",
            );
            const revision = policies.getSnapshot().revision;
            const quotes = new ReceiveQuoteRepository(db);
            const storedFills = new SwapFillRepository(db);
            const storedAdvances = new AdvanceRepository(db);
            const reservations = new ReservationRepository(db);
            const operatorCoin = fundingCoin({
                txid: TAXI_0.txid,
                vout: TAXI_0.vout,
                value: 20_000,
            });
            const depositCoin = fundingCoin({
                txid: DEP.txid,
                vout: DEP.vout,
                value: 10_000,
            });
            const makerKey = new Uint8Array(32).fill(9);
            const params = {
                receiverKey,
                senderKey: makerKey,
                operatorKey: cfg.operatorKey,
                dust: 330n,
                topup: 329n,
                assetId: wantedAsset,
                locktime: 899_856n,
                claimMode: "recycle" as const,
                recoveryRecipient: "receiver" as const,
            };
            const covenant = new DustCovenantScript({
                serverKey: cfg.serverPubkey,
                emulatorKey: cfg.emulatorPubkey,
                vtxoMinAmount: cfg.vtxoMinAmount,
                params,
            });
            quotes.insert({
                quote: {
                    id: "receive-1",
                    state: "quoted",
                    receiverAddress: new ArkAddress(
                        cfg.serverPubkey,
                        receiverKey,
                        cfg.addressHrp,
                    ).encode(),
                    makerPublicKey: hex.encode(makerKey),
                    params,
                    covenantAddress: covenant.address(cfg.addressHrp, cfg.serverPubkey).encode(),
                    fare: { currency: "sats", units: 4n },
                    batchExpiry: { kind: "height", value: 900_000n },
                    inputExpiryFloor: { kind: "height", value: 900_000n },
                    recoveryLocktime: { kind: "height", value: 899_856n },
                    loanSats: 329n,
                    createdAt: NOW,
                    expiresAt: NOW + 60,
                    policyRevision: revision,
                    operatorInputs: [operatorFundingInput(operatorCoin)],
                },
                expectedPolicyRevision: revision,
                recoveryExecutionBudget: { kind: "height", value: 72n },
            });
            builder = new FakeSwapFillGraphBuilder(hex.encode(covenant.pkScript), 330n, {
                id: FARE_SWAP_ID,
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
                            covenantScript: hex.decode(depositCoin.script),
                            makerProceedsScript: covenant.pkScript,
                            makerPublicKey: makerKey,
                            wantAsset: wantedAsset,
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
                    assets: [{ assetId: FARE_SWAP_ID, amount: 5n }],
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
            expect(readFundingSource(advance.unsignedLockupTx)).toMatchObject({
                kind: "joint-fill",
                source: {
                    fillId: fill.id,
                    recoveryPreflight: { expectedTxid: expect.any(String) },
                },
            });
            await expect(revalidateBoundSwapFill(d, fill)).resolves.toBeUndefined();
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
                    { txid: SOLVER_COIN.txid, vout: SOLVER_COIN.vout, value: String(SOLVER_VALUE) },
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

    it("fails fast when solver coins lack taproot evidence", async () => {
        const { tapTree: _dropped, ...bare } = indexerCoins.get(key(SOLVER_COIN))!;
        indexerCoins.set(key(SOLVER_COIN), bare as ExtendedVirtualCoin);
        const rejected = await caught(() => createSwapFillQuote(deps(), body()));
        expect(rejected.code).toBe("swap_fill_solver_evidence_missing");
        expect(builder.built).toHaveLength(0);
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
});
