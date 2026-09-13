import { afterEach, describe, expect, it, vi } from "vitest";
import { ArkAddress, Estimator } from "@arkade-os/sdk";
import {
    openDatabase,
    ProceedsRepository,
    ReservationRepository,
    type Database,
} from "@arkade-taxi/db";
import { config, fundingCoin, operatorTree } from "./fixtures.js";
import {
    createProceedsCollector,
    assertProceedsPlan,
    discoverProceeds,
    planProceeds,
    proceedsFee,
    reconcileProceeds,
} from "../src/proceeds.js";
import { arkInfo } from "./arkade/fixtures.js";
import { bytesToHex } from "@arkade-taxi/protocol";

const cfg = config({
    operatorKey: operatorTree.tweakedPublicKey,
    operatorMinReserveSats: 1000n,
    addressHrp: "tark",
});
const receipt = fundingCoin({ value: 1, isSwept: true, txid: "ab".repeat(32) });
const carrier = fundingCoin({ value: 2000 });
const spare = fundingCoin({ value: 1000, vout: 1 });
const address = new ArkAddress(cfg.serverPubkey, cfg.operatorKey, cfg.addressHrp).encode();
const clock = { height: 700000, timestamp: new Date("2026-09-12T00:00:00Z") };
const makePlan = () => planProceeds([receipt], [carrier, spare], [], cfg, {}, address, clock);
const databases: Database[] = [];
afterEach(() => {
    for (const db of databases.splice(0)) db.close();
});

function setup() {
    const db = openDatabase(":memory:");
    databases.push(db);
    const jobs = new ProceedsRepository(db);
    const plan = makePlan();
    jobs.create("job", plan, 100);
    let now = 100;
    let intents: any[] = [];
    let coins = [receipt, spare];
    let outputs = coins;
    const info = arkInfo({ fees: { intentFee: {}, txFeeRate: "0" } });
    const settle = vi.fn(async () => "cc".repeat(32));
    const wallet = {
        getAddress: async () => address,
        getSpendableVtxos: async () => outputs,
        arkProvider: { getInfo: async () => info },
        onchainProvider: {
            getChainTip: async () => ({ height: 700000, time: Math.floor(Date.now() / 1000) }),
        },
        settle,
    };
    const runtime = {
        wallet,
        assertRecovery: async () => {},
        providers: {
            arkProvider: wallet.arkProvider,
            emulatorProvider: {
                getInfo: async () => ({ signerPubkey: bytesToHex(cfg.emulatorPubkey) }),
            },
            indexerProvider: { getVtxos: async () => ({ vtxos: coins }) },
        },
        storage: {
            intentRepository: {
                getIntents: async () => intents,
                getLockedVtxoOutpoints: async () => [],
            },
        },
        withSettlement: async (work: any, guard: any) => {
            guard();
            return work(wallet);
        },
    };
    const deps = {
        config: cfg,
        runtime,
        jobs,
        reservations: new ReservationRepository(db),
        advances: { byState: () => [] },
        now: () => now,
    } as unknown as Parameters<typeof createProceedsCollector>[0];
    return {
        deps,
        jobs,
        settle,
        info,
        setNow(value: number) {
            now = value;
        },
        setIntents(value: any[]) {
            intents = value;
        },
        finish() {
            coins = coins.map((c) => ({ ...c, isSpent: true, settledBy: "cc".repeat(32) }));
            outputs = [
                fundingCoin({
                    value: Number(plan.amount),
                    txid: "dd".repeat(32),
                    commitmentTxIds: ["cc".repeat(32)],
                    assets: [],
                }),
            ];
        },
        setOutputs(value: typeof outputs) {
            outputs = value;
        },
    };
}

describe("proceeds planning", () => {
    it("quotes height-based expiry with the same fee parameters as SDK 0.4.72", () => {
        const fee = vi.spyOn(Estimator.prototype, "evalOffchainInput");
        try {
            proceedsFee([spare], {}, spare.script);
            expect(fee).toHaveBeenCalledWith(
                expect.objectContaining({ expiry: new Date(spare.expiresAtHeight! * 1000) }),
            );
        } finally {
            fee.mockRestore();
        }
    });
    it("combines proven receipts with one unreserved ordinary coin and keeps reserve", () => {
        const plan = makePlan();
        expect(plan.inputs).toEqual([
            { txid: receipt.txid, vout: 0 },
            { txid: spare.txid, vout: 1 },
        ]);
        expect(plan.amount).toBe("1001");
        expect(plan.fee).toBe("0");
        expect(plan.maxFee).toBe("0");
    });
    it("never spends reserved or foreign sponsors", () => {
        expect(() => planProceeds([receipt], [spare], [spare], cfg, {}, address, clock)).toThrow(
            /reserve/,
        );
        expect(() =>
            planProceeds(
                [receipt],
                [fundingCoin({ script: "5120" + "00".repeat(32) })],
                [],
                cfg,
                {},
                address,
                clock,
            ),
        ).toThrow(/reserve/);
    });
    it("prefers an existing asset carrier and preserves all old and new asset groups", () => {
        const existing = fundingCoin({ value: 2000, assets: [{ assetId: "a", amount: 2n }] });
        const received = {
            ...receipt,
            assets: [
                { assetId: "b", amount: 3n },
                { assetId: "a", amount: 5n },
            ],
        };
        const plan = planProceeds([received], [spare, existing], [], cfg, {}, address, clock);
        expect(plan.inputs).toEqual([
            { txid: receipt.txid, vout: 0 },
            { txid: existing.txid, vout: 0 },
        ]);
        expect(plan.assets).toEqual([
            { assetId: "a", amount: "7" },
            { assetId: "b", amount: "3" },
        ]);
        expect(plan.amount).toBe("2001");
    });
    it.each(["height", "time"])(
        "keeps quote-eligible reserve instead of counting short %s headroom",
        (kind) => {
            const safe = fundingCoin({ value: 1500, txid: "11".repeat(32) });
            const expiring = fundingCoin({
                value: 2000,
                txid: "22".repeat(32),
                ...(kind === "height"
                    ? { expiresAtHeight: clock.height + Number(cfg.minExpiryHeadroomBlocks) - 1 }
                    : {
                          expiresAtHeight: undefined,
                          expiresAt: new Date(
                              clock.timestamp.getTime() +
                                  Number(cfg.minExpiryHeadroomSeconds) * 1000 -
                                  1000,
                          ),
                      }),
            });
            const plan = planProceeds([receipt], [safe, expiring], [], cfg, {}, address, clock);
            expect(plan.inputs).toEqual([
                { txid: receipt.txid, vout: 0 },
                { txid: expiring.txid, vout: 0 },
            ]);
            expect(plan.amount).toBe("2001");
        },
    );
    it("can collect with an asset carrier without consuming an already depleted quote reserve", () => {
        const existing = fundingCoin({ value: 1000, assets: [{ assetId: "a", amount: 2n }] });
        const plan = planProceeds([receipt], [existing], [], cfg, {}, address, clock);
        expect(plan.amount).toBe("1001");
        expect(plan.assets).toEqual([{ assetId: "a", amount: "2" }]);
    });
    it("rejects duplicate ordinary inventory instead of inflating the spare reserve", () => {
        expect(() => planProceeds([receipt], [spare, spare], [], cfg, {}, address, clock)).toThrow(
            /duplicate/,
        );
    });
    it("preserves every asset group exactly and rejects unexpected payout ownership", () => {
        const assets = [
            { assetId: "b", amount: 2n },
            { assetId: "a", amount: 3n },
        ];
        const plan = planProceeds(
            [{ ...receipt, assets }],
            [carrier, spare],
            [],
            cfg,
            {},
            address,
            clock,
        );
        expect(plan.assets).toEqual([
            { assetId: "a", amount: "3" },
            { assetId: "b", amount: "2" },
        ]);
        expect(() =>
            planProceeds(
                [{ ...receipt, script: "bad" }],
                [carrier, spare],
                [],
                cfg,
                {},
                address,
                clock,
            ),
        ).toThrow(/ownership/);
    });
    it("fails closed on fees above the explicit cap", () => {
        expect(() =>
            planProceeds(
                [receipt],
                [carrier, spare],
                [],
                cfg,
                { offchainInput: "1.0" },
                address,
                clock,
            ),
        ).toThrow(/fee_cap/);
        const plan = planProceeds(
            [receipt],
            [carrier, spare],
            [],
            { ...cfg, proceedsMaxFeeSats: 2n },
            { offchainInput: "1.0" },
            address,
            clock,
        );
        expect(plan.fee).toBe("2");
        expect(plan.amount).toBe("999");
    });
});

describe("proceeds restart reconciliation", () => {
    it("rejects persisted destination, accounting and fee authorization corruption before any signing", () => {
        const plan = makePlan();
        expect(() => assertProceedsPlan(plan, [receipt, spare], cfg)).not.toThrow();
        for (const mutation of [
            { address: "foreign" },
            { amount: "1000" },
            { fee: "-1" },
            { fee: "1", maxFee: "0", amount: "1000" },
            { assets: [{ assetId: "a", amount: "1" }] },
            { receipts: [] },
        ])
            expect(() =>
                assertProceedsPlan({ ...plan, ...mutation }, [receipt, spare], cfg),
            ).toThrow(/plan_invalid/);
    });
    it("retries only unspent inputs without a live intent", () => {
        expect(reconcileProceeds([receipt, spare], [], 100)).toEqual({ kind: "retry" });
        expect(reconcileProceeds([receipt, spare], [{ validUntil: 99 }], 100)).toEqual({
            kind: "retry",
        });
        expect(reconcileProceeds([receipt, spare], [{ validUntil: 101 }], 100)).toEqual({
            kind: "pending",
        });
        expect(reconcileProceeds([receipt, spare], [{}], 100)).toEqual({
            kind: "quarantined",
            blocker: "proceeds_ambiguous_intent",
        });
    });
    it("accepts only all inputs settled by the same commitment", () => {
        const id = "cc".repeat(32);
        expect(
            reconcileProceeds(
                [receipt, spare].map((c) => ({ ...c, isSpent: true, settledBy: id })),
                [],
                100,
            ),
        ).toEqual({ kind: "verify", commitmentTxid: id });
        expect(
            reconcileProceeds([{ ...receipt, isSpent: true, spentBy: id }, spare], [], 100),
        ).toEqual({ kind: "quarantined", blocker: "proceeds_input_conflict" });
    });
});

describe("durable proceeds collector", () => {
    it("verifies an immediately indexed self-output before returning from settlement", async () => {
        const s = setup();
        s.settle.mockImplementation(async () => {
            s.finish();
            return "cc".repeat(32);
        });
        const collector = createProceedsCollector(s.deps);
        await collector.tick();
        expect(s.settle).toHaveBeenCalledTimes(1);
        expect(s.jobs.active()).toBeUndefined();
        expect(collector.status().blocker).toBeNull();
        expect(s.deps.reservations.listReservedOutpoints()).toEqual([]);
    });
    it("settles explicit reserved inputs to one exact wallet output", async () => {
        const s = setup();
        const collector = createProceedsCollector(s.deps);
        await collector.tick();
        expect(s.settle).toHaveBeenCalledExactlyOnceWith({
            inputs: [receipt, spare],
            outputs: [{ address, amount: 1001n }],
        });
        expect(s.jobs.active()?.state).toBe("settling");
        s.finish();
        await collector.tick();
        expect(s.jobs.active()).toBeUndefined();
        expect(s.deps.reservations.listReservedOutpoints()).toEqual([]);
        expect(collector.status().blocker).toBeNull();
    });
    it("reconciles an ambiguous cancelled SDK intent across restart without resubmitting", async () => {
        const s = setup();
        s.jobs.update("job", "settling", null, null);
        s.setIntents([{ state: "cancelled" }]);
        let collector = createProceedsCollector(s.deps);
        await collector.tick();
        expect(collector.status().blocker).toBe("proceeds_ambiguous_intent");
        expect(s.deps.reservations.listReservedOutpoints()).toHaveLength(2);
        s.finish();
        s.setNow(60101);
        collector = createProceedsCollector(s.deps);
        await collector.tick();
        expect(s.jobs.active()).toBeUndefined();
        expect(s.settle).not.toHaveBeenCalled();
    });
    it("holds reservations if the settlement output has missing assets or wrong sats", async () => {
        const s = setup();
        s.finish();
        s.setOutputs([fundingCoin({ value: 1000, commitmentTxIds: ["cc".repeat(32)] })]);
        await createProceedsCollector(s.deps).tick();
        expect(s.jobs.active()?.blocker).toBe("proceeds_output_pending");
        expect(s.deps.reservations.listReservedOutpoints()).toHaveLength(2);
        expect(s.settle).not.toHaveBeenCalled();
    });
    it("serializes ticks and competing collectors and drains an in-flight settlement", async () => {
        const s = setup();
        let release!: () => void;
        const gate = new Promise<void>((resolve) => {
            release = resolve;
        });
        s.settle.mockImplementation(async () => {
            await gate;
            return "cc".repeat(32);
        });
        const first = createProceedsCollector(s.deps);
        const pending = first.tick();
        expect(first.tick()).toBe(pending);
        await vi.waitFor(() => expect(s.settle).toHaveBeenCalledTimes(1));
        const second = createProceedsCollector(s.deps);
        await second.tick();
        expect(second.status().blocker).toBe("proceeds_worker_active");
        first.stop();
        let drained = false;
        const drain = first.drain().then(() => {
            drained = true;
        });
        await Promise.resolve();
        expect(drained).toBe(false);
        release();
        await drain;
        await first.tick();
        expect(s.settle).toHaveBeenCalledTimes(1);
    });
    it("cannot widen an existing zero-fee job through a higher runtime cap", async () => {
        const s = setup();
        s.deps.config = { ...cfg, proceedsMaxFeeSats: 100n };
        s.info.fees!.intentFee.offchainInput = "1.0";
        const collector = createProceedsCollector(s.deps);
        await collector.tick();
        expect(collector.status().blocker).toBe("proceeds_fee_authorization_changed");
        expect(s.jobs.active()?.plan.maxFee).toBe("0");
        expect(s.settle).not.toHaveBeenCalled();
    });
    it("does not discover unknown recoverable wallet receipts", async () => {
        const s = setup();
        expect(await discoverProceeds(s.deps, [receipt])).toEqual([]);
    });
});
