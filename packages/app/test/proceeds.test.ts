import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ArkAddress, Estimator, Wallet, SingleKey } from "@arkade-os/sdk";
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
    type CollectionPlan,
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
const makePlan = () => planProceeds([receipt], [carrier, spare], [], cfg, {}, address, clock, -1n);
const localEvidence = { state: "unsubmitted" as const, localIntents: [] };
const sdkIntent = {
    proof: "test-proof",
    message: {
        type: "register" as const,
        expire_at: 0,
        valid_at: 0,
        onchain_output_indexes: [],
        cosigners_public_keys: [],
    },
};
const databases: Database[] = [];
const directories: string[] = [];
afterEach(() => {
    vi.restoreAllMocks();
    for (const db of databases.splice(0)) if (db.open) db.close();
    for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function setup(
    plan: CollectionPlan = makePlan(),
    inventory = [receipt, spare, carrier],
    durable = false,
) {
    const directory = durable ? mkdtempSync(join(tmpdir(), "taxi-proceeds-replay-")) : undefined;
    if (directory) directories.push(directory);
    const dbPath = directory ? join(directory, "taxi.db") : ":memory:";
    let db = openDatabase(dbPath);
    databases.push(db);
    let jobs = new ProceedsRepository(db);
    jobs.create("job", plan, 100);
    let now = 100;
    let intents: any[] = [];
    let sdkLocks: typeof plan.inputs = [];
    let coins = plan.inputs.map((p) =>
        inventory.find((c) => c.txid === p.txid && c.vout === p.vout)!,
    );
    let outputs = inventory;
    let tip = { height: clock.height, time: Math.floor(clock.timestamp.getTime() / 1000) };
    let submitGuard: ((intent: typeof sdkIntent) => Promise<() => void>) | undefined;
    let beforeSubmit = () => {};
    let beforeEntry = () => {};
    const info = arkInfo({ fees: { intentFee: {}, txFeeRate: "0" } });
    const settle = vi.fn(async (_params: unknown) => "cc".repeat(32));
    const wallet = {
        getAddress: async () => address,
        getSpendableVtxos: async () =>
            outputs.filter((c) => !sdkLocks.some((p) => p.txid === c.txid && p.vout === c.vout)),
        getVtxos: async () =>
            outputs.filter((c) => !sdkLocks.some((p) => p.txid === c.txid && p.vout === c.vout)),
        arkProvider: { getInfo: async () => info },
        onchainProvider: {
            getChainTip: async () => tip,
        },
        settle: async (params: unknown) => {
            beforeSubmit();
            const enter = await submitGuard?.(sdkIntent);
            beforeEntry();
            enter?.();
            return settle(params);
        },
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
                getLockedVtxoOutpoints: async () => sdkLocks,
            },
        },
        withSettlement: async (work: any, guard: any) => {
            submitGuard = guard;
            try {
                return await work(wallet);
            } finally {
                submitGuard = undefined;
            }
        },
    };
    const deps = {
        config: cfg,
        runtime,
        get jobs() {
            return jobs;
        },
        reservations: new ReservationRepository(db),
        advances: { byState: () => [] },
        now: () => now,
    } as unknown as Parameters<typeof createProceedsCollector>[0];
    return {
        deps,
        get jobs() {
            return jobs;
        },
        settle,
        info,
        get db() {
            return db;
        },
        useActualSdk(options: { failWrites?: boolean; reject?: () => void } = {}) {
            const save = vi.fn(async (intent: any) => {
                if (options.failWrites) throw new Error("SQLITE_FULL");
                intents = [intent];
            });
            const register = vi.fn(async () => {
                throw new Error("registration response lost");
            });
            const remove = vi.fn(async () => {
                throw new Error("delete unavailable");
            });
            const sdk: any = Object.assign(Object.create(Wallet.prototype), {
                getAddress: wallet.getAddress,
                logUngatedInputs: () => {},
                recipientAddressContext: () => ({
                    hrp: "tark",
                    signerSet: { active: bytesToHex(cfg.serverPubkey), deprecated: [] },
                }),
                identity: SingleKey.fromPrivateKey(cfg.operatorPrivkey),
                makeRegisterIntentSignature: async () => sdkIntent,
                makeDeleteIntentSignature: async () => ({
                    proof: "delete-proof",
                    message: { type: "delete", expire_at: 0 },
                }),
                getContractManager: async () => ({ assertAnnotatable: async () => {} }),
                _addPendingSpends: () => {},
                _removePendingSpends: () => {},
                intentRepository: { getIntents: async () => intents, saveIntent: save },
                arkProvider: {
                    getEventStream: async function* () {},
                    registerIntent: async (intent: typeof sdkIntent) => {
                        options.reject?.();
                        const enter = await submitGuard!(intent);
                        enter?.();
                        return register();
                    },
                    deleteIntent: remove,
                },
            });
            wallet.settle = (params) => sdk._settleImpl(params);
            return { save, register, remove };
        },
        restartDatabase() {
            db.close();
            db = openDatabase(dbPath);
            databases.push(db);
            jobs = new ProceedsRepository(db);
            deps.reservations = new ReservationRepository(db);
        },
        setTip(value: typeof tip) {
            tip = value;
        },
        beforeSubmit(work: () => void) {
            beforeSubmit = work;
        },
        beforeEntry(work: () => void) {
            beforeEntry = work;
        },
        setNow(value: number) {
            now = value;
        },
        setIntents(value: any[]) {
            intents = value;
        },
        setSdkLocks(value: typeof sdkLocks) {
            sdkLocks = value;
        },
        finish() {
            coins = coins.map((c) => ({ ...c, isSpent: true, settledBy: "cc".repeat(32) }));
            outputs = [
                fundingCoin({
                    value: Number(plan.amount),
                    txid: "dd".repeat(32),
                    commitmentTxIds: ["cc".repeat(32)],
                    assets: plan.assets.map((a) => ({ ...a, amount: BigInt(a.amount) })),
                }),
            ];
        },
        setOutputs(value: typeof outputs) {
            outputs = value;
        },
    };
}

describe("proceeds planning", () => {
    it("does not create a plan when every otherwise valid sponsor exceeds the output maximum", () => {
        expect(() =>
            planProceeds(
                [receipt],
                [{ ...carrier, value: 1000 }, spare],
                [],
                cfg,
                {},
                address,
                clock,
                1000n,
            ),
        ).toThrow("proceeds_output_limit_exceeded");
    });
    it("selects a fitting sponsor when the preferred asset carrier would exceed the maximum", () => {
        const existing = { ...carrier, value: 1000, assets: [{ assetId: "a", amount: 5n }] };
        const fitting = { ...spare, value: 999 };
        const reserve = fundingCoin({ txid: "ee".repeat(32), value: 1000 });
        const plan = planProceeds(
            [receipt],
            [existing, fitting, reserve],
            [],
            cfg,
            {},
            address,
            clock,
            1000n,
        );
        expect(plan.amount).toBe("1000");
        expect(plan.inputs).toEqual([
            { txid: receipt.txid, vout: 0 },
            { txid: spare.txid, vout: 1 },
        ]);
        expect(plan.assets).toEqual([]);
    });
    it("defers excess receipts to keep individually valid inputs within one output's maximum", () => {
        const first = { ...receipt, value: 600, assets: [{ assetId: "a", amount: 7n }] };
        const second = { ...receipt, vout: 1, value: 600, assets: [{ assetId: "b", amount: 8n }] };
        const plan = planProceeds([first, second], [], [], cfg, {}, address, clock, 1000n);
        expect(plan.amount).toBe("600");
        expect(plan.receipts).toEqual([{ txid: first.txid, vout: 0 }]);
        expect(plan.inputs).toEqual(plan.receipts);
        expect(plan.assets).toEqual([{ assetId: "a", amount: "7" }]);
        const next = planProceeds([second], [], [], cfg, {}, address, clock, 1000n);
        expect(next.amount).toBe("600");
        expect(next.assets).toEqual([{ assetId: "b", amount: "8" }]);
    });
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
        expect(() =>
            planProceeds([receipt], [spare], [spare], cfg, {}, address, clock, -1n),
        ).toThrow(/reserve/);
        expect(() =>
            planProceeds(
                [receipt],
                [fundingCoin({ script: "5120" + "00".repeat(32) })],
                [],
                cfg,
                {},
                address,
                clock,
                -1n,
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
        const plan = planProceeds([received], [spare, existing], [], cfg, {}, address, clock, -1n);
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
            const plan = planProceeds(
                [receipt],
                [safe, expiring],
                [],
                cfg,
                {},
                address,
                clock,
                -1n,
            );
            expect(plan.inputs).toEqual([
                { txid: receipt.txid, vout: 0 },
                { txid: expiring.txid, vout: 0 },
            ]);
            expect(plan.amount).toBe("2001");
        },
    );
    it("can collect with an asset carrier without consuming an already depleted quote reserve", () => {
        const existing = fundingCoin({ value: 1000, assets: [{ assetId: "a", amount: 2n }] });
        const plan = planProceeds([receipt], [existing], [], cfg, {}, address, clock, -1n);
        expect(plan.amount).toBe("1001");
        expect(plan.assets).toEqual([{ assetId: "a", amount: "2" }]);
    });
    it("rejects duplicate ordinary inventory instead of inflating the spare reserve", () => {
        expect(() =>
            planProceeds([receipt], [spare, spare], [], cfg, {}, address, clock, -1n),
        ).toThrow(/duplicate/);
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
            -1n,
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
                -1n,
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
                -1n,
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
            -1n,
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
        expect(reconcileProceeds([receipt, spare], [], 100, localEvidence)).toEqual({
            kind: "retry",
        });
        expect(
            reconcileProceeds([receipt, spare], [{ validUntil: 99 }], 100, localEvidence),
        ).toEqual({
            kind: "retry",
        });
        expect(
            reconcileProceeds([receipt, spare], [{ validUntil: 101 }], 100, localEvidence),
        ).toEqual({
            kind: "pending",
        });
        expect(reconcileProceeds([receipt, spare], [{}], 100, localEvidence)).toEqual({
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
                localEvidence,
            ),
        ).toEqual({ kind: "verify", commitmentTxid: id });
        expect(
            reconcileProceeds(
                [{ ...receipt, isSpent: true, spentBy: id }, spare],
                [],
                100,
                localEvidence,
            ),
        ).toEqual({ kind: "quarantined", blocker: "proceeds_input_conflict" });
    });
});

describe("durable proceeds collector", () => {
    it("fences a lease takeover between asynchronous validation and synchronous network entry", async () => {
        const s = setup();
        s.beforeEntry(() => {
            s.setNow(60200);
            expect(s.jobs.claim("job", "replacement", 60200, 120200)).toBe(true);
        });
        const collector = createProceedsCollector(s.deps);
        await collector.tick();
        expect(s.settle).not.toHaveBeenCalled();
        expect(collector.status().blocker).toBe("proceeds_lease_lost");
        expect(s.jobs.submissionEvidence("job").state).toBe("unsubmitted");
        expect(s.deps.reservations.listReservedOutpoints()).toHaveLength(2);
    });
    it("does not turn an expired SDK record into retry authority after Taxi entered submission", async () => {
        const s = setup();
        const collector = createProceedsCollector(s.deps);
        await collector.tick();
        expect(s.settle).toHaveBeenCalledTimes(1);
        s.setIntents([{ state: "cancelled", validUntil: 99 }]);
        await collector.tick();
        expect(s.settle).toHaveBeenCalledTimes(1);
        expect(collector.status().blocker).toBe("proceeds_submission_ambiguous");
        expect(s.deps.reservations.listReservedOutpoints()).toHaveLength(2);
    });
    it("does not retry a cancelled record with an unrecognized proof after a known local refusal", async () => {
        vi.spyOn(console, "warn").mockImplementation(() => {});
        const s = setup();
        const sdk = s.useActualSdk({ reject: () => s.setOutputs([receipt, spare]) });
        const collector = createProceedsCollector(s.deps);
        await collector.tick();
        expect(sdk.register).not.toHaveBeenCalled();
        const records = await s.deps.runtime.storage.intentRepository.getIntents();
        s.setIntents([{ ...records[0], registerProof: "unknown-proof" }]);
        s.setOutputs([receipt, spare, carrier]);
        await collector.tick();
        expect(sdk.register).not.toHaveBeenCalled();
        expect(collector.status().blocker).toBe("proceeds_ambiguous_intent");
    });
    it.each(["reserve", "maximum"])(
        "resumes an SDK-cancelled, definitely unsubmitted %s refusal after restart",
        async (reason) => {
            vi.spyOn(console, "warn").mockImplementation(() => {});
            const s = setup(makePlan(), [receipt, spare, carrier], true);
            let reject = true;
            const sdk = s.useActualSdk({
                reject: () => {
                    if (!reject) return;
                    if (reason === "reserve") s.setOutputs([receipt, spare]);
                    else s.info.vtxoMaxAmount = 1000n;
                },
            });
            let collector = createProceedsCollector(s.deps);
            await collector.tick();
            expect(collector.status().blocker).toBe(
                reason === "reserve"
                    ? "proceeds_reserve_unavailable"
                    : "proceeds_output_limit_exceeded",
            );
            expect(sdk.register).not.toHaveBeenCalled();
            expect(sdk.save).toHaveBeenCalledTimes(2);
            const records = await s.deps.runtime.storage.intentRepository.getIntents();
            expect(records).toHaveLength(1);
            expect(records[0]).toMatchObject({ state: "cancelled" });
            expect(records[0]!.validUntil).toBeUndefined();
            collector.stop();
            s.restartDatabase();
            reject = false;
            s.setOutputs([receipt, spare, carrier]);
            s.info.vtxoMaxAmount = -1n;
            s.setNow(365 * 86400000);
            collector = createProceedsCollector(s.deps);
            await collector.tick();
            expect(sdk.register).toHaveBeenCalledTimes(1);
            expect(s.deps.reservations.listReservedOutpoints()).toHaveLength(2);
            s.finish();
            await collector.tick();
            expect(s.jobs.active()).toBeUndefined();
        },
    );
    it("never retries a network-entered SDK settlement whose failed writes left no intent records", async () => {
        vi.spyOn(console, "warn").mockImplementation(() => {});
        const errors = vi.spyOn(console, "error").mockImplementation(() => {});
        const s = setup(makePlan(), [receipt, spare, carrier], true);
        const sdk = s.useActualSdk({ failWrites: true });
        let collector = createProceedsCollector(s.deps);
        await collector.tick();
        expect(sdk.register).toHaveBeenCalledTimes(1);
        expect(sdk.remove).toHaveBeenCalledTimes(1);
        expect(sdk.save).toHaveBeenCalledTimes(2);
        expect(errors).toHaveBeenCalledTimes(2);
        expect(await s.deps.runtime.storage.intentRepository.getIntents()).toEqual([]);
        collector.stop();
        s.restartDatabase();
        s.setNow(365 * 86400000);
        collector = createProceedsCollector(s.deps);
        await collector.tick();
        expect(sdk.register).toHaveBeenCalledTimes(1);
        expect(collector.status().blocker).toBe("proceeds_submission_ambiguous");
        expect(s.deps.reservations.listReservedOutpoints()).toHaveLength(2);
        s.finish();
        await collector.tick();
        expect(s.jobs.active()).toBeUndefined();
    });
    it("prevents registration if Taxi cannot durably write its boundary marker", async () => {
        vi.spyOn(console, "warn").mockImplementation(() => {});
        const s = setup();
        const sdk = s.useActualSdk();
        s.db.exec(
            "CREATE TRIGGER deny_proceeds_entry BEFORE UPDATE OF submission_state ON proceeds_jobs BEGIN SELECT RAISE(ABORT, 'SQLITE_FULL'); END",
        );
        const collector = createProceedsCollector(s.deps);
        await collector.tick();
        expect(sdk.register).not.toHaveBeenCalled();
        expect(sdk.save).toHaveBeenCalledTimes(2);
        expect(s.deps.reservations.listReservedOutpoints()).toHaveLength(2);
        s.db.exec("DROP TRIGGER deny_proceeds_entry");
        await collector.tick();
        expect(sdk.register).toHaveBeenCalledTimes(1);
    });
    it.each(["sponsor", "accumulated receipts"])(
        "does not call SDK settlement for a persisted %s plan exceeding the current maximum",
        async (kind) => {
            const receipts = [
                { ...receipt, value: 600 },
                { ...receipt, value: 600, vout: 1 },
            ];
            const plan =
                kind === "sponsor"
                    ? makePlan()
                    : planProceeds(receipts, [], [], cfg, {}, address, clock, -1n);
            const s = kind === "sponsor" ? setup(plan) : setup(plan, receipts);
            s.info.vtxoMaxAmount = 1000n;
            const collector = createProceedsCollector(s.deps);
            await collector.tick();
            expect(collector.status().blocker).toBe("proceeds_output_limit_exceeded");
            expect(s.settle).not.toHaveBeenCalled();
            expect(
                await s.deps.runtime.storage.intentRepository.getIntents({
                    containingInputs: plan.inputs,
                }),
            ).toEqual([]);
            expect(s.jobs.active()?.plan).toEqual(plan);
            expect(s.deps.reservations.listReservedOutpoints()).toHaveLength(2);
        },
    );
    it("blocks registration if the advertised maximum shrinks after preflight", async () => {
        const s = setup();
        s.beforeSubmit(() => {
            s.info.vtxoMaxAmount = 1000n;
        });
        const collector = createProceedsCollector(s.deps);
        await collector.tick();
        expect(collector.status().blocker).toBe("proceeds_output_limit_exceeded");
        expect(s.settle).not.toHaveBeenCalled();
        expect(s.deps.reservations.listReservedOutpoints()).toHaveLength(2);
    });
    it("revalidates exact canonical inputs when the SDK pending spend hides them from wallet reads", async () => {
        const s = setup();
        s.beforeSubmit(() => s.setSdkLocks(makePlan().inputs));
        const collector = createProceedsCollector(s.deps);
        await collector.tick();
        expect(s.settle).toHaveBeenCalledTimes(1);
        expect(collector.status().blocker).toBe("proceeds_output_pending");
    });
    it.each(["height", "time"])(
        "rechecks protected sponsor reserve after persisted %s headroom crosses on restart",
        async (kind) => {
            const assetReceipt = { ...receipt, assets: [{ assetId: "a", amount: 1000000n }] };
            const expiring = {
                ...carrier,
                ...(kind === "height"
                    ? { expiresAtHeight: 700144 }
                    : {
                          expiresAtHeight: undefined,
                          expiresAt: new Date(clock.timestamp.getTime() + 86400000),
                      }),
            };
            const plan = planProceeds(
                [assetReceipt],
                [spare, expiring],
                [],
                cfg,
                {},
                address,
                clock,
                -1n,
            );
            expect(plan.inputs).toEqual([
                { txid: receipt.txid, vout: 0 },
                { txid: spare.txid, vout: 1 },
            ]);
            const s = setup(plan, [assetReceipt, spare, expiring], true);
            createProceedsCollector(s.deps).stop();
            s.restartDatabase();
            s.setTip({ height: 700001, time: Math.floor(clock.timestamp.getTime() / 1000) + 1 });
            const collector = createProceedsCollector(s.deps);
            await collector.tick();
            expect(collector.status().blocker).toBe("proceeds_reserve_unavailable");
            expect(s.jobs.active()?.plan).toEqual(plan);
            expect(s.deps.reservations.listReservedOutpoints()).toHaveLength(2);
            expect(s.settle).not.toHaveBeenCalled();
            s.setOutputs([
                assetReceipt,
                spare,
                expiring,
                fundingCoin({ value: 1000, txid: "ee".repeat(32) }),
            ]);
            await collector.tick();
            expect(s.settle).toHaveBeenCalledTimes(1);
        },
    );
    it("rechecks reserve at the registration boundary after the preflight was safe", async () => {
        const expiring = { ...carrier, expiresAtHeight: 700144 };
        const s = setup(makePlan(), [receipt, spare, expiring]);
        s.beforeSubmit(() =>
            s.setTip({ height: 700001, time: Math.floor(clock.timestamp.getTime() / 1000) }),
        );
        const collector = createProceedsCollector(s.deps);
        await collector.tick();
        expect(collector.status().blocker).toBe("proceeds_reserve_unavailable");
        expect(s.deps.reservations.listReservedOutpoints()).toHaveLength(2);
        expect(s.settle).not.toHaveBeenCalled();
    });
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
