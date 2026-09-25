import { afterEach, describe, expect, it } from "vitest";
import {
    AdvanceRepository,
    openDatabase,
    PolicyRepository,
    ProceedsRepository,
    ReservationRepository,
    SwapFillRepository,
    type Database,
} from "@arkade-taxi/db";
import { ArkAddress } from "@arkade-os/sdk";
import { bytesToHex } from "@arkade-taxi/protocol";
import { unionReservedOutpoints } from "../src/arkade/reservedOutpoints.js";
import { selectOperatorFunding } from "../src/arkade/inventory.js";
import { createProceedsCollector, planProceeds } from "../src/proceeds.js";
import { createQuote, FakeLockupBuilder, type QuoteDeps } from "../src/quotes.js";
import {
    createSponsoredQuote,
    FakeSponsoredLockupBuilder,
    type SponsoredQuoteDeps,
} from "../src/sponsoredQuotes.js";
import {
    config,
    fundingCoin,
    MemoryAdvances,
    NOW,
    operatorKey,
    operatorTree,
    providerEmulatorKey,
    policy as basePolicy,
    quoteBody,
    quoteInfrastructure,
    receiverKey,
    runtimeSafety,
    senderKey,
    serverKey,
    serverUnroll,
} from "./fixtures.js";
import { arkInfo } from "./arkade/fixtures.js";

const COIN_A = { txid: "aa".repeat(32), vout: 0 };
const COIN_B = { txid: "bb".repeat(32), vout: 7 };
const COIN_C = { txid: "cc".repeat(32), vout: 0 };

let db: Database;
let reservations: ReservationRepository;
let swapFills: SwapFillRepository;

const GRAPH = {
    arkTx: "aGVsbG8=",
    checkpoints: ["d29ybGQ="],
    graphId: new Uint8Array(32).fill(0xab),
    inputOwners: [null, "solver", "sponsor"] as (string | null)[],
};

function setup(): void {
    db = openDatabase(":memory:");
    new PolicyRepository(db).update(
        {
            paused: false,
            maxOutstandingSats: 1_000_000n,
            maxPerPaymentTopupSats: 100_000n,
            maxConcurrentAdvances: 10,
            assetRules: [
                { assetId: null, enabled: true, claim: "either", maxTopupSats: null, fares: [] },
            ],
        },
        "test",
    );
    reservations = new ReservationRepository(db);
    swapFills = new SwapFillRepository(db);
    reservations.reserveQuote({
        advance: {
            id: "adv-1",
            state: "quoted",
            receiverKey: new Uint8Array(32).fill(1),
            senderKey: new Uint8Array(32).fill(2),
            operatorKey: new Uint8Array(32).fill(3),
            dust: 330n,
            topup: 300n,
            locktime: 100n,
            recoveryLocktime: { kind: "height", value: 100n },
            batchExpiry: { kind: "height", value: 300n },
            operatorInputs: [COIN_A],
            unsignedLockupTx: "unsigned",
            unsignedLockupId: "ff".repeat(32),
            covenantAddress: "tark1qexample",
            fare: { currency: "sats", units: 10n },
            createdAt: 1,
            updatedAt: 1,
            expiresAt: NOW + 60,
        },
        expectedPolicyRevision: new PolicyRepository(db).getSnapshot().revision,
        recoveryExecutionBudget: { kind: "height", value: 1n },
    });
    swapFills.insert({
        id: "fill-1",
        operationId: "op-1",
        state: "quoted",
        offerHex: "deadbeef",
        solverInputs: [{ txid: "ee".repeat(32), vout: 1, value: 5000n }],
        solverProceedsScript: new Uint8Array([0x51]),
        solverKeys: ["ab".repeat(32)],
        taxiInputs: [COIN_B],
        contributionSats: 330n,
        sponsorScript: new Uint8Array([0x51]),
        fare: { currency: "sats", units: 10n },
        maxFare: { currency: "sats", units: 50n },
        graph: structuredClone(GRAPH),
        graphId: new Uint8Array(32).fill(0xab),
        submitInvoked: false,
        attempts: 0,
        createdAt: NOW,
        updatedAt: NOW,
        expiresAt: NOW + 60,
    });
}

afterEach(() => db.close());

describe("cross-flow reservations", () => {
    it("each repository hides the other flow's coins from single-source consumers", () => {
        setup();
        expect(reservations.listReservedOutpoints()).toEqual([COIN_A]);
        expect(swapFills.listReservedOutpoints()).toEqual([COIN_B]);
    });

    it("unions advance and swap-fill reservations without duplicates", () => {
        setup();
        expect(unionReservedOutpoints(reservations, swapFills)).toEqual([COIN_A, COIN_B]);
        expect(unionReservedOutpoints(reservations, reservations)).toEqual([COIN_A]);
        expect(unionReservedOutpoints(undefined, swapFills)).toEqual([COIN_B]);
    });

    it("keeps both flows' coins out of operator funding selection", () => {
        setup();
        const spendable = [
            fundingCoin({ txid: COIN_A.txid, vout: COIN_A.vout }),
            fundingCoin({ txid: COIN_B.txid, vout: COIN_B.vout }),
            fundingCoin({ txid: COIN_C.txid, vout: COIN_C.vout }),
        ];
        const cfg = config();
        const selection = selectOperatorFunding({
            spendable,
            reserved: unionReservedOutpoints(reservations, swapFills),
            requiredSats: 1000n,
            safety: runtimeSafety(),
            nowMs: NOW * 1000,
            maxSnapshotAgeMs: cfg.reconcileIntervalMs,
            minExpiryHeadroomBlocks: cfg.minExpiryHeadroomBlocks,
            minExpiryHeadroomSeconds: cfg.minExpiryHeadroomSeconds,
            minReserveSats: 0n,
            dustSats: cfg.dust,
        });
        expect(selection.inputs.map(({ txid, vout }) => ({ txid, vout }))).toEqual([COIN_C]);
    });

    it("rejects proceeds collection over a swap-fill reservation", () => {
        setup();
        const cfg = config({ operatorKey: operatorTree.tweakedPublicKey });
        const receipt = fundingCoin({ txid: COIN_B.txid, vout: COIN_B.vout });
        const address = new ArkAddress(cfg.serverPubkey, cfg.operatorKey, cfg.addressHrp).encode();
        expect(() =>
            planProceeds(
                [receipt],
                [],
                unionReservedOutpoints(reservations, swapFills),
                cfg,
                {},
                address,
                { height: 700000, timestamp: new Date(NOW * 1000) },
                -1n,
            ),
        ).toThrow("proceeds_input_reserved");
    });
});

describe("cross-flow wiring through production quote paths", () => {
    const FILL_TX = "11".repeat(32);
    const ALT_TX = "22".repeat(32);
    const EXTRA_TX = "33".repeat(32);

    function setupWiring(): { terms: PolicyRepository; ledger: AdvanceRepository } {
        db = openDatabase(":memory:");
        const terms = new PolicyRepository(db);
        terms.update(basePolicy(), "test");
        reservations = new ReservationRepository(db);
        swapFills = new SwapFillRepository(db);
        return { terms, ledger: new AdvanceRepository(db) };
    }

    function insertFill(taxiInputs: { txid: string; vout: number }[]): void {
        const tag = taxiInputs[0]!.txid.slice(0, 2);
        swapFills.insert({
            id: `fill-${tag}`,
            operationId: `op-${tag}`,
            state: "quoted",
            offerHex: "deadbeef",
            solverInputs: [{ txid: "ee".repeat(32), vout: 1, value: 5000n }],
            solverProceedsScript: new Uint8Array([0x51]),
            solverKeys: ["ab".repeat(32)],
            taxiInputs,
            contributionSats: 330n,
            sponsorScript: new Uint8Array([0x51]),
            fare: { currency: "sats", units: 10n },
            maxFare: { currency: "sats", units: 50n },
            graph: {
                arkTx: "aGVsbG8=",
                checkpoints: ["d29ybGQ="],
                graphId: new Uint8Array(32).fill(0xab),
                inputOwners: ["sponsor"] as (string | null)[],
            },
            graphId: new Uint8Array(32).fill(0xab),
            submitInvoked: false,
            attempts: 0,
            createdAt: NOW,
            updatedAt: NOW,
            expiresAt: NOW + 60,
        });
    }

    function operatorInventory(
        fill: { txid: string; vout: number },
        alt: { txid: string; vout: number },
        extra: { txid: string; vout: number },
    ): {
        getSpendableVtxos(): Promise<ReturnType<typeof fundingCoin>[]>;
        getLockedVtxoOutpoints(): Promise<{ txid: string; vout: number }[]>;
    } {
        return {
            getSpendableVtxos: async () => [
                fundingCoin({ txid: fill.txid, vout: fill.vout }),
                fundingCoin({ txid: alt.txid, vout: alt.vout }),
                fundingCoin({ txid: extra.txid, vout: extra.vout }),
            ],
            getLockedVtxoOutpoints: async () => [],
        };
    }

    it("advance quote selection skips a swap-fill coin through createQuote", async () => {
        const { terms, ledger } = setupWiring();
        const fill = { txid: FILL_TX, vout: 0 };
        const alt = { txid: ALT_TX, vout: 0 };
        const extra = { txid: EXTRA_TX, vout: 0 };
        insertFill([fill]);
        const builder = new FakeLockupBuilder(config(), serverUnroll);
        const d: QuoteDeps = {
            ...quoteInfrastructure(new MemoryAdvances(), () => basePolicy()),
            advances: ledger,
            policy: terms,
            reservations,
            swapFills,
            config: config(),
            now: () => NOW,
            randomId: () => "adv-wiring-1",
            inventory: operatorInventory(fill, alt, extra),
            lockupBuilder: builder,
            lockupSubmitter: builder,
        };
        const response = await createQuote(d, quoteBody());
        expect(ledger.get(response.transferId)?.operatorInputs).toEqual([alt]);
        expect(builder.built[0]?.funding.inputs.map(({ txid, vout }) => ({ txid, vout }))).toEqual([
            alt,
        ]);
    });

    it("sponsored quote selection skips a swap-fill coin through createSponsoredQuote", async () => {
        const { terms, ledger } = setupWiring();
        const fill = { txid: FILL_TX, vout: 0 };
        const alt = { txid: ALT_TX, vout: 0 };
        const extra = { txid: EXTRA_TX, vout: 0 };
        insertFill([fill]);
        const sponsoredBuilder = new FakeSponsoredLockupBuilder(config(), serverUnroll);
        const d: SponsoredQuoteDeps = {
            ...quoteInfrastructure(new MemoryAdvances(), () => basePolicy()),
            advances: ledger,
            policy: terms,
            reservations,
            swapFills,
            config: config(),
            now: () => NOW,
            randomId: () => "spn-wiring-1",
            inventory: operatorInventory(fill, alt, extra),
            sponsoredBuilder,
        };
        const sender = quoteBody();
        const response = await createSponsoredQuote(d, {
            receiverAddress: new ArkAddress(serverKey, receiverKey, "ark").encode(),
            senderKey: sender.senderKey,
            senderSats: sender.senderSats,
            senderInputs: sender.senderInputs,
        });
        expect(ledger.get(response.transferId)?.operatorInputs).toEqual([alt]);
        expect(
            sponsoredBuilder.built[0]?.funding.inputs.map(({ txid, vout }) => ({ txid, vout })),
        ).toEqual([alt]);
    });

    it("proceeds collector guard treats a swap-fill coin as locked reserve", async () => {
        const carrier = fundingCoin({ value: 2000 });
        const spare = fundingCoin({ value: 1000, vout: 1 });
        const receipt = fundingCoin({ value: 1, isSwept: true, txid: "ab".repeat(32) });
        const cfg = config({
            operatorKey: operatorTree.tweakedPublicKey,
            operatorMinReserveSats: 1000n,
            addressHrp: "tark",
        });
        const address = new ArkAddress(cfg.serverPubkey, cfg.operatorKey, cfg.addressHrp).encode();
        const clock = { height: 700000, timestamp: new Date(NOW * 1000) };
        const plan = planProceeds([receipt], [carrier, spare], [], cfg, {}, address, clock, -1n);
        db = openDatabase(":memory:");
        const jobs = new ProceedsRepository(db);
        jobs.create("job", plan, 100);
        reservations = new ReservationRepository(db);
        swapFills = new SwapFillRepository(db);
        insertFill([{ txid: carrier.txid, vout: carrier.vout }]);
        const coins = plan.inputs.map((p) =>
            [receipt, spare, carrier].find((c) => c.txid === p.txid && c.vout === p.vout)!,
        );
        const info = arkInfo({ fees: { intentFee: {}, txFeeRate: "0" } });
        let settled = 0;
        const wallet = {
            getAddress: async () => address,
            getSpendableVtxos: async () => [receipt, spare, carrier],
            arkProvider: { getInfo: async () => info },
            onchainProvider: {
                getChainTip: async () => ({
                    height: clock.height,
                    time: Math.floor(clock.timestamp.getTime() / 1000),
                }),
            },
            settle: async () => {
                settled++;
                return "cc".repeat(32);
            },
        };
        const deps = {
            config: cfg,
            runtime: {
                wallet,
                assertRecovery: async () => {},
                providers: {
                    arkProvider: wallet.arkProvider,
                    emulatorProvider: {
                        getInfo: async () => ({ signerPubkey: bytesToHex(providerEmulatorKey) }),
                    },
                    indexerProvider: { getVtxos: async () => ({ vtxos: coins }) },
                },
                storage: {
                    intentRepository: {
                        getIntents: async () => [],
                        getLockedVtxoOutpoints: async () => [],
                    },
                },
                withSettlement: async (work: (w: typeof wallet) => Promise<unknown>) =>
                    work(wallet),
            },
            advances: { byState: () => [] },
            reservations,
            swapFills,
            jobs,
            now: () => 100,
        } as unknown as Parameters<typeof createProceedsCollector>[0];
        const collector = createProceedsCollector(deps);
        await collector.tick();
        expect(settled).toBe(0);
        expect(collector.status().blocker).toBe("proceeds_reserve_unavailable");
        collector.stop();
    });
});
