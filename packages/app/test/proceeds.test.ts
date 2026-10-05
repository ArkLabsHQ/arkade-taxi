import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
    ArkAddress,
    Estimator,
    Extension,
    Wallet,
    SingleKey,
    Transaction,
    asset,
} from "@arkade-os/sdk";
import { base64 } from "@scure/base";
import type { Outpoint } from "@arkade-taxi/core";
import {
    openDatabase,
    AdvanceRepository,
    ProceedsRepository,
    ReservationRepository,
    PolicyRepository,
    type Database,
} from "@arkade-taxi/db";
import {
    config,
    advance,
    fundingCoin,
    intentProof,
    operatorTree,
    providerEmulatorKey,
    receiverKey,
    runtimeSafety,
    senderKey,
    senderTree,
    serverUnroll,
} from "./fixtures.js";
import { selectOperatorFunding } from "../src/arkade/inventory.js";
import {
    createProceedsCollector,
    assertProceedsPlan,
    discoverProceeds,
    planProceeds,
    planInventorySplit,
    proceedsFee,
    reconcileProceeds,
    type CollectionPlan,
} from "../src/proceeds.js";
import { arkInfo } from "./arkade/fixtures.js";
import { bytesToHex } from "@arkade-taxi/protocol";
import { buildSponsoredEnvelope } from "../src/arkade/sponsoredBuilder.js";
import { decodeLockupEnvelope } from "../src/arkade/psbt.js";

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
    let intentInputs = (inputs: Outpoint[]) => inputs;
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
        settle: async (params: { inputs: Outpoint[] }) => {
            beforeSubmit();
            const enter = await submitGuard?.({
                ...sdkIntent,
                proof: intentProof(intentInputs(params.inputs)),
            });
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
                getInfo: async () => ({ signerPubkey: bytesToHex(providerEmulatorKey) }),
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
            const sign = vi.fn(async (coins: Outpoint[], ..._args: unknown[]) => ({
                ...sdkIntent,
                proof: intentProof(coins),
            }));
            const sdk: any = Object.assign(Object.create(Wallet.prototype), {
                getAddress: wallet.getAddress,
                logUngatedInputs: () => {},
                recipientAddressContext: () => ({
                    hrp: "tark",
                    signerSet: { active: bytesToHex(cfg.serverPubkey), deprecated: [] },
                }),
                identity: SingleKey.fromPrivateKey(cfg.operatorPrivkey),
                makeRegisterIntentSignature: sign,
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
            return { save, register, remove, sign };
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
        tamperIntentInputs(change: (inputs: Outpoint[]) => Outpoint[]) {
            intentInputs = change;
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
            const amounts =
                plan.kind === "inventory-split"
                    ? plan.outputs!
                    : [
                          (BigInt(plan.amount) - BigInt(plan.plainChange ?? "0")).toString(),
                          ...(plan.plainChange === undefined ? [] : [plan.plainChange]),
                      ];
            outputs = amounts.map((amount, vout) =>
                fundingCoin({
                    value: Number(amount),
                    txid: "dd".repeat(32),
                    vout,
                    commitmentTxIds: ["cc".repeat(32)],
                    assets:
                        vout === 0
                            ? plan.assets.map((a) => ({ ...a, amount: BigInt(a.amount) }))
                            : [],
                }),
            );
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
    it("never takes a sponsor the SDK is about to renew", () => {
        const renewingSoon = fundingCoin({
            txid: "cd".repeat(32),
            value: 900,
            expiresAtHeight: undefined,
            expiresAt: new Date((Math.floor(Date.now() / 1000) + 2 * 86_400) * 1000),
        });
        const plan = planProceeds(
            [receipt],
            [renewingSoon, carrier, spare],
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
    it("returns an asset fare and plain working balance so the next quote keeps its reserve", () => {
        const protectedCfg = { ...cfg, operatorMinReserveSats: 10000n };
        const received = { ...receipt, assets: [{ assetId: "a", amount: 1000000n }] };
        const working = { ...carrier, value: 489669 };
        const reserve = { ...spare, value: 10000 };
        const plan = planProceeds(
            [received],
            [working, reserve],
            [],
            protectedCfg,
            {},
            address,
            clock,
            -1n,
        );
        expect(plan.inputs).toEqual([
            { txid: received.txid, vout: received.vout },
            { txid: working.txid, vout: working.vout },
        ]);
        expect(plan).toMatchObject({ amount: "489670", plainChange: "489340", fee: "0" });
        const assetCarrier = fundingCoin({
            txid: "dd".repeat(32),
            value: 330,
            assets: received.assets,
        });
        const plainChange = fundingCoin({
            txid: "dd".repeat(32),
            vout: 1,
            value: Number(plan.plainChange),
        });
        const nowMs = clock.timestamp.getTime();
        expect(
            selectOperatorFunding({
                spendable: [assetCarrier, plainChange, reserve],
                reserved: [],
                requiredSats: 330n,
                safety: runtimeSafety({
                    checkedAt: nowMs,
                    chainHeight: BigInt(clock.height),
                    chainTime: BigInt(nowMs / 1000),
                }),
                nowMs,
                maxSnapshotAgeMs: 1000,
                minExpiryHeadroomBlocks: cfg.minExpiryHeadroomBlocks,
                minExpiryHeadroomSeconds: cfg.minExpiryHeadroomSeconds,
                renewalThresholdSeconds: cfg.vtxoRenewalThresholdSeconds,
                minReserveSats: protectedCfg.operatorMinReserveSats,
                dustSats: cfg.dust,
            }).totalValue,
        ).toBe(10000n);
        expect(() => assertProceedsPlan(plan, [received, working], protectedCfg)).not.toThrow();
        for (const plainChange of [null, "0", "-1", "01", "989340", "9899"])
            expect(() =>
                assertProceedsPlan(
                    { ...plan, plainChange } as CollectionPlan,
                    [received, working],
                    protectedCfg,
                ),
            ).toThrow(/plan_invalid/);
        expect(() =>
            planProceeds([received], [working], [], protectedCfg, {}, address, clock, -1n),
        ).toThrow(/reserve_unavailable/);
        const paid = planProceeds(
            [received],
            [working, reserve],
            [],
            { ...protectedCfg, proceedsMaxFeeSats: 6n },
            { offchainInput: "1.0", offchainOutput: "2.0" },
            address,
            clock,
            -1n,
        );
        expect(paid).toMatchObject({ amount: "489664", plainChange: "489334", fee: "6" });
        expect(() =>
            planProceeds(
                [received],
                [working, reserve],
                [],
                { ...protectedCfg, proceedsMaxFeeSats: 6n },
                { offchainOutput: "amount >= 489340 ? 2.0 : 1.0" },
                address,
                clock,
                -1n,
            ),
        ).toThrow(/fee_authorization_changed/);
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
            { plainChange: "1" },
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
    it.each([false, true])(
        "keeps settlement counts, blockers and cleanup with a throwing logger: %s",
        async (throws) => {
            const s = setup();
            const debug = vi.fn(
                (
                    _fields: {
                        phase: string;
                        elapsedMs: number;
                        outcome: "start" | "ok" | "error";
                    },
                    _message: string,
                ) => {
                    if (throws) throw new Error("diagnostics unavailable");
                },
            );
            s.deps.phaseLogger = { debug };
            const recovery = vi.spyOn(s.deps.runtime, "assertRecovery");
            const collector = createProceedsCollector(s.deps);
            await collector.tick();
            expect(s.settle).toHaveBeenCalledTimes(1);
            expect(collector.status().blocker).toBe("proceeds_output_pending");
            expect(s.deps.reservations.listReservedOutpoints()).toHaveLength(2);
            s.finish();
            await collector.tick();
            expect(recovery).toHaveBeenCalledTimes(2);
            expect(s.settle).toHaveBeenCalledTimes(1);
            expect(s.jobs.active()).toBeUndefined();
            expect(s.deps.reservations.listReservedOutpoints()).toEqual([]);
            expect(collector.status().blocker).toBeNull();
            expect(debug).toHaveBeenCalledTimes(4);
            for (const [fields, message] of debug.mock.calls) {
                expect(Object.keys(fields).sort()).toEqual(["elapsedMs", "outcome", "phase"]);
                expect(fields.phase).toBe("proceeds.assertRecovery");
                expect(fields.elapsedMs).toBeGreaterThanOrEqual(0);
                expect(["start", "ok"]).toContain(fields.outcome);
                expect(message).toBe("operational phase");
            }
            expect(s.jobs.claim("job", "another-worker", 100, 60_100)).toBe(false);
            expect(collector.status().running).toBe(false);
        },
    );

    it.each([false, true])(
        "observes a pre-job provider rejection before the generic blocker with a throwing logger: %s",
        async (throws) => {
            const s = setup();
            s.jobs.complete("job", "cc".repeat(32));
            const failure = new TypeError("private provider detail");
            const events: { phase: string; elapsedMs: number; outcome: string }[] = [];
            s.deps.phaseLogger = {
                debug(fields) {
                    events.push(fields);
                    if (throws) throw new Error("diagnostics unavailable");
                },
            };
            const tip = vi
                .spyOn(s.deps.runtime.wallet!.onchainProvider, "getChainTip")
                .mockRejectedValue(failure);
            await expect(discoverProceeds(s.deps, [receipt])).rejects.toBe(failure);
            events.length = 0;
            const collector = createProceedsCollector(s.deps);
            await expect(collector.tick()).resolves.toBeUndefined();
            expect(tip).toHaveBeenCalledTimes(2);
            expect(
                events.filter((event) => event.outcome === "error").map((event) => event.phase),
            ).toEqual(["proceeds.discovery.chainTip", "proceeds.discovery"]);
            expect(events.every((fields) => Object.keys(fields).length === 3)).toBe(true);
            expect(collector.status()).toMatchObject({
                blocker: "proceeds_collection_failed",
                jobId: null,
                state: "idle",
            });
            expect(s.settle).not.toHaveBeenCalled();
            expect(s.deps.reservations.listReservedOutpoints()).toEqual([]);
        },
    );

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
    it("refuses to register an intent that spends anything but the plan's inputs", async () => {
        const s = setup();
        s.tamperIntentInputs((inputs) => [...inputs, { txid: "ee".repeat(32), vout: 0 }]);
        const collector = createProceedsCollector(s.deps);
        await collector.tick();
        expect(collector.status().blocker).toBe("proceeds_intent_inputs_changed");
        expect(s.settle).not.toHaveBeenCalled();
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
            const sponsor = { ...spare, value: 1500 };
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
                [sponsor, expiring],
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
            const s = setup(plan, [assetReceipt, sponsor, expiring], true);
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
                sponsor,
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
    it("has the SDK put all fare assets on the first output and preserve plain change", async () => {
        vi.spyOn(console, "warn").mockImplementation(() => {});
        const fare = asset.AssetId.create("12".repeat(32), 7).toString();
        const assetReceipt = { ...receipt, assets: [{ assetId: fare, amount: 9n }] };
        const plan = planProceeds(
            [assetReceipt],
            [carrier, spare],
            [],
            cfg,
            {},
            address,
            clock,
            -1n,
        );
        const s = setup(plan, [assetReceipt, spare, carrier]);
        vi.spyOn(console, "warn").mockImplementation(() => {});
        const sdk = s.useActualSdk();
        await createProceedsCollector(s.deps).tick();
        const outputs = sdk.sign.mock.calls[0]![1] as { script: Uint8Array; amount: bigint }[];
        expect(outputs).toHaveLength(3);
        expect(outputs[0]).toEqual({ amount: 330n, script: ArkAddress.decode(address).pkScript });
        expect(outputs[1]).toEqual({ amount: 1671n, script: ArkAddress.decode(address).pkScript });
        const group = Extension.fromBytes(outputs[2]!.script).getAssetPacket()!.groups[0]!;
        expect(group.assetId!.toString()).toBe(fare);
        expect(group.outputs).toMatchObject([{ vout: 0, amount: 9n }]);
        const legacy = { ...plan };
        delete legacy.plainChange;
        const old = setup(legacy, [assetReceipt, spare, carrier], true);
        old.restartDatabase();
        const oldSdk = old.useActualSdk();
        await createProceedsCollector(old.deps).tick();
        const oldOutputs = oldSdk.sign.mock.calls[0]![1] as typeof outputs;
        expect(oldOutputs).toHaveLength(2);
        expect(oldOutputs[0]).toEqual({
            amount: 2001n,
            script: ArkAddress.decode(address).pkScript,
        });
        expect(
            Extension.fromBytes(oldOutputs[1]!.script).getAssetPacket()!.groups[0]!.outputs,
        ).toMatchObject([{ vout: 0, amount: 9n }]);
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
    it("holds split proceeds across restart until exact asset and plain outputs are indexed", async () => {
        const received = { ...receipt, assets: [{ assetId: "a", amount: 9n }] };
        const plan = planProceeds([received], [carrier, spare], [], cfg, {}, address, clock, -1n);
        const s = setup(plan, [received, carrier, spare], true);
        s.finish();
        s.restartDatabase();
        const carrierOutput = fundingCoin({
            value: 330,
            txid: "dd".repeat(32),
            assets: received.assets,
            commitmentTxIds: ["cc".repeat(32)],
        });
        const changeOutput = fundingCoin({
            value: 1671,
            txid: "dd".repeat(32),
            vout: 1,
            commitmentTxIds: ["cc".repeat(32)],
        });
        const collector = createProceedsCollector(s.deps);
        for (const outputs of [
            [carrierOutput],
            [{ ...carrierOutput, assets: [] }, changeOutput],
            [
                { ...carrierOutput, value: 331 },
                { ...changeOutput, value: 1670 },
            ],
            [
                { ...carrierOutput, assets: [] },
                { ...changeOutput, assets: received.assets },
            ],
            [carrierOutput, { ...changeOutput, commitmentTxIds: ["ee".repeat(32)] }],
            [carrierOutput, { ...changeOutput, script: "5120" + "00".repeat(32) }],
            [carrierOutput, changeOutput, { ...changeOutput, vout: 2 }],
        ]) {
            s.setOutputs(outputs);
            await collector.tick();
            expect(s.jobs.active()?.blocker).toBe("proceeds_output_pending");
            expect(s.deps.reservations.listReservedOutpoints()).toHaveLength(2);
        }
        s.setOutputs([changeOutput, carrierOutput]);
        await collector.tick();
        expect(s.jobs.active()).toBeUndefined();
        expect(s.deps.reservations.listReservedOutpoints()).toEqual([]);
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
        const received = { ...receipt, assets: [{ assetId: "a", amount: 9n }] };
        const split = planProceeds([received], [carrier, spare], [], cfg, {}, address, clock, -1n);
        const changed = setup(split, [received, carrier, spare]);
        changed.beforeSubmit(() => {
            changed.info.fees!.intentFee.offchainOutput = "amount == 1671.0 ? 1.0 : 0.0";
        });
        const splitCollector = createProceedsCollector(changed.deps);
        await splitCollector.tick();
        expect(splitCollector.status().blocker).toBe("proceeds_fee_authorization_changed");
        expect(changed.settle).not.toHaveBeenCalled();
        expect(changed.jobs.submissionEvidence("job").state).toBe("unsubmitted");
    });
    it("discovers only the unspent fare from a verified sponsored lockup", async () => {
        const s = setup();
        expect(await discoverProceeds(s.deps, [receipt])).toEqual([]);
        const receiverAddress = new ArkAddress(
            cfg.serverPubkey,
            receiverKey,
            cfg.addressHrp,
        ).encode();
        const fare = { currency: "sats" as const, units: 10n };
        const encoded = buildSponsoredEnvelope(
            {
                advanceId: "sponsored-1",
                senderInputs: [
                    {
                        txid: "ac".repeat(32),
                        vout: 0,
                        value: 1000n,
                        tapTree: senderTree.encode(),
                        spendLeaf: senderTree.scripts[0],
                        expiry: { kind: "height", value: 900000n },
                    },
                ],
                senderSats: 1000n,
                funding: {
                    inputs: [carrier],
                    totalValue: 2000n,
                    batchExpiry: { kind: "height", value: 900000n },
                },
                params: {
                    receiverKey,
                    senderKey,
                    operatorKey: cfg.operatorKey,
                    dust: cfg.dust,
                    contribution: 10n,
                },
                receiverAddress,
                fare,
                satsFarePayer: "sender",
            },
            cfg,
            serverUnroll,
        );
        const envelope = decodeLockupEnvelope(encoded);
        const tx = Transaction.fromPSBT(base64.decode(envelope.arkTx));
        const locked = advance({
            id: "sponsored-1",
            kind: "sponsored",
            operatorKey: cfg.operatorKey,
            topup: 10n,
            locktime: 0n,
            batchExpiry: { kind: "height", value: 900000n },
            operatorInputs: [{ txid: carrier.txid, vout: carrier.vout }],
            unsignedLockupTx: encoded,
            unsignedLockupId: envelope.unsignedTxId,
            covenantAddress: receiverAddress,
            fare,
            arkTxid: tx.id,
            outpoint: { txid: tx.id, vout: envelope.covenantOutputIndex },
        });
        const advances = new AdvanceRepository(s.db);
        s.deps.advances = advances;
        advances.insert(locked);
        const fareCoin = fundingCoin({
            txid: tx.id,
            vout: 1,
            value: Number(tx.getOutput(1).amount),
            isSwept: true,
        });
        let observed = fareCoin;
        s.deps.runtime.providers.indexerProvider.getVtxos = async () => ({ vtxos: [observed] });
        expect(await discoverProceeds(s.deps, [fareCoin])).toEqual([fareCoin]);
        for (const [changed, code] of [
            [{ ...locked, operatorKey: receiverKey }, "proceeds_payout_key_changed"],
            [{ ...locked, arkTxid: "ee".repeat(32) }, "proceeds_lockup_mismatch"],
            [
                { ...locked, outpoint: { txid: "ee".repeat(32), vout: 0 } },
                "proceeds_lockup_mismatch",
            ],
            [{ ...locked, outpoint: { txid: tx.id, vout: 1 } }, "proceeds_lockup_mismatch"],
        ] as const) {
            advances.update(changed);
            await expect(
                discoverProceeds(s.deps, [{ ...fareCoin, txid: changed.arkTxid! }]),
            ).rejects.toThrow(code);
        }
        advances.update(locked);
        observed = { ...fareCoin, vout: 2 };
        expect(await discoverProceeds(s.deps, [fareCoin])).toEqual([]);
        observed = { ...fareCoin, isSpent: true };
        expect(await discoverProceeds(s.deps, [fareCoin])).toEqual([]);
        expect(s.settle).not.toHaveBeenCalled();
    });
});

describe("plain inventory bootstrap", () => {
    it("splits the real singleton balance into a reserve and eight working coins", () => {
        const c = fundingCoin({ value: 100000 });
        const protectedCfg = { ...cfg, operatorMinReserveSats: 10000n };
        const plan = planInventorySplit([c], [], protectedCfg, {}, address, clock, -1n)!;
        expect(plan.kind).toBe("inventory-split");
        expect(plan.outputs).toHaveLength(8);
        expect(plan.outputs!.reduce((sum, n) => sum + BigInt(n), 0n)).toBe(100000n);
        expect(BigInt(plan.outputs![0]!)).toBeGreaterThanOrEqual(10330n);
        assertProceedsPlan(plan, [c], protectedCfg);
        const outputs = plan.outputs!.map((value, vout) =>
            fundingCoin({ value: Number(value), vout }),
        );
        for (const requiredSats of [1n, 280n, 284n]) {
            const selected = selectOperatorFunding({
                spendable: outputs,
                reserved: [],
                requiredSats,
                safety: runtimeSafety(),
                nowMs: runtimeSafety().checkedAt,
                maxSnapshotAgeMs: 30000,
                minExpiryHeadroomBlocks: 1n,
                minExpiryHeadroomSeconds: 1n,
                renewalThresholdSeconds: 0n,
                minReserveSats: 10000n,
                dustSats: 330n,
            });
            expect(selected.totalValue - requiredSats).toBeGreaterThanOrEqual(330n);
        }
    });
    it("automatically prepares a split when receipt discovery finds nothing", async () => {
        const c = fundingCoin({ value: 100000 });
        const s = setup(makePlan(), [c]);
        s.jobs.complete("job", "cc".repeat(32));
        s.deps.config = { ...cfg, operatorMinReserveSats: 10000n };
        s.deps.runtime.providers.indexerProvider.getVtxos = async () => ({ vtxos: [c] }) as any;
        const collector = createProceedsCollector(s.deps);
        await collector.tick();
        expect(s.settle).toHaveBeenCalledTimes(1);
        expect(s.jobs.active()?.plan.kind).toBe("inventory-split");
        expect(s.deps.reservations.listReservedOutpoints()).toEqual([
            { txid: c.txid, vout: c.vout },
        ]);
    });
});

describe("inventory split safety", () => {
    const singleton = fundingCoin({ value: 100000 });
    const protectedCfg = { ...cfg, operatorMinReserveSats: 10000n };
    const split = () => planInventorySplit([singleton], [], protectedCfg, {}, address, clock, -1n)!;
    const splitSetup = (durable = false) => {
        const s = setup(split(), [singleton], durable);
        s.deps.config = protectedCfg;
        return s;
    };
    it("reduces the pool size when only a reserve and one working coin fit", () => {
        const small = fundingCoin({ value: 10990 });
        const plan = planInventorySplit([small], [], protectedCfg, {}, address, clock, -1n)!;
        expect(plan.outputs).toEqual(["10330", "660"]);
        expect(
            planInventorySplit(
                [{ ...small, value: 10989 }],
                [],
                protectedCfg,
                {},
                address,
                clock,
                -1n,
            ),
        ).toBeUndefined();
    });
    it("leaves a sufficiently parallel pool alone", () => {
        const coins = Array.from({ length: 8 }, (_, vout) => fundingCoin({ value: 20000, vout }));
        expect(
            planInventorySplit(coins, [], protectedCfg, {}, address, clock, -1n),
        ).toBeUndefined();
        const plan = planInventorySplit(
            coins.slice(0, 7),
            [],
            protectedCfg,
            {},
            address,
            clock,
            -1n,
        )!;
        expect(plan.outputs).toHaveLength(2);
    });
    it.each([
        { assets: [{ assetId: "a", amount: 1n }] },
        { isSpent: true },
        { isUnrolled: true },
        { isSwept: true },
        { expiresAtHeight: clock.height + 1 },
        { txid: "bad" },
        { value: NaN },
        { vout: -1 },
        { tapTree: senderTree.encode(), script: bytesToHex(senderTree.pkScript) },
        { expiresAtHeight: undefined, expiresAt: new Date(Date.now() + 1000) },
    ])("ignores unsafe or non-plain inventory case %#", (over) => {
        expect(
            planInventorySplit(
                [{ ...singleton, ...over }],
                [],
                protectedCfg,
                {},
                address,
                clock,
                -1n,
            ),
        ).toBeUndefined();
    });
    it("excludes reservations and duplicate inventory", () => {
        expect(
            planInventorySplit([singleton], [singleton], protectedCfg, {}, address, clock, -1n),
        ).toBeUndefined();
        expect(() =>
            planInventorySplit([singleton, singleton], [], protectedCfg, {}, address, clock, -1n),
        ).toThrow("proceeds_duplicate_inventory");
    });
    it("bounds the provider maximum and solves the authorized output fee exactly", () => {
        expect(
            planInventorySplit([singleton], [], protectedCfg, {}, address, clock, 10000n),
        ).toBeUndefined();
        expect(
            planInventorySplit(
                [singleton],
                [],
                protectedCfg,
                { offchainOutput: "1.0" },
                address,
                clock,
                -1n,
            ),
        ).toBeUndefined();
        const plan = planInventorySplit(
            [singleton],
            [],
            { ...protectedCfg, proceedsMaxFeeSats: 8n },
            { offchainOutput: "1.0" },
            address,
            clock,
            -1n,
        )!;
        expect(plan.fee).toBe("8");
        expect(plan.outputs!.reduce((sum, n) => sum + BigInt(n), 0n)).toBe(99992n);
        expect(
            proceedsFee(
                [singleton],
                { offchainOutput: "1.0" },
                singleton.script,
                plan.outputs!.map(BigInt),
            ),
        ).toBe(8n);
    });
    it.each([
        { kind: "unknown" },
        { kind: undefined },
        { receipts: [singleton] },
        { assets: [{ assetId: "a", amount: "1" }] },
        { plainChange: "10000" },
        { outputs: ["10330"] },
        { outputs: Array(9).fill("10000") },
        { outputs: ["10000", "90000"] },
        { outputs: ["99999", "1"] },
        { outputs: ["10330", "660"] },
        { fee: "01" },
        { fee: "1" },
        { maxFee: "1" },
        { address: "wrong" },
        { extra: true },
    ])("rejects corrupted persisted split plans before signing case %#", (change) => {
        expect(() =>
            assertProceedsPlan({ ...split(), ...change } as any, [singleton], protectedCfg),
        ).toThrow("proceeds_plan_invalid");
    });
    it("confirms exact output multiplicity and unique outpoints before releasing a durable reservation", async () => {
        const s = splitSetup(true);
        const plan = split();
        s.finish();
        s.restartDatabase();
        const valid = plan.outputs!.map((amount, vout) =>
            fundingCoin({
                value: Number(amount),
                txid: "dd".repeat(32),
                vout,
                commitmentTxIds: ["cc".repeat(32)],
            }),
        );
        const collector = createProceedsCollector(s.deps);
        for (const outputs of [
            [...valid.slice(0, -1), { ...valid.at(-1)!, value: 12811 }],
            [...valid.slice(0, -1), valid[1]!],
            valid.map((c, index) =>
                index === 1 ? { ...c, assets: [{ assetId: "a", amount: 1n }] } : c,
            ),
        ]) {
            s.setOutputs(outputs);
            await collector.tick();
            expect(s.jobs.active()?.blocker).toBe("proceeds_output_pending");
            expect(s.deps.reservations.listReservedOutpoints()).toHaveLength(1);
        }
        s.setOutputs([...valid].reverse());
        await collector.tick();
        expect(s.jobs.active()).toBeUndefined();
        expect(s.deps.reservations.listReservedOutpoints()).toEqual([]);
        expect(s.settle).not.toHaveBeenCalled();
    });
    it.each(["fee", "maximum", "expiry", "reservation", "stopped"])(
        "revalidates %s at registration",
        async (change) => {
            const s = splitSetup();
            const collector = createProceedsCollector(s.deps);
            s.beforeSubmit(() => {
                if (change === "fee") s.info.fees!.intentFee.offchainOutput = "1.0";
                if (change === "maximum") s.info.vtxoMaxAmount = 10000n;
                if (change === "expiry")
                    s.setTip({
                        height: singleton.expiresAtHeight! - 1,
                        time: Math.floor(clock.timestamp.getTime() / 1000),
                    });
                if (change === "reservation")
                    s.deps.receiveQuotes = { listReservedOutpoints: () => [singleton] } as any;
                if (change === "stopped") collector.stop();
            });
            await collector.tick();
            expect(s.settle).not.toHaveBeenCalled();
            expect(s.jobs.submissionEvidence("job").state).toBe("unsubmitted");
            expect(s.deps.reservations.listReservedOutpoints()).toHaveLength(1);
        },
    );
    it("fences a conflicting reservation at synchronous network entry", async () => {
        const s = splitSetup();
        s.beforeEntry(() => {
            s.deps.receiveQuotes = { listReservedOutpoints: () => [singleton] } as any;
        });
        const collector = createProceedsCollector(s.deps);
        await collector.tick();
        expect(s.settle).not.toHaveBeenCalled();
        expect(collector.status().blocker).toBe("proceeds_input_reserved");
        expect(s.jobs.submissionEvidence("job").state).toBe("unsubmitted");
    });
    it("retains an ambiguous entered submission through a database restart without resubmitting", async () => {
        const s = splitSetup(true);
        vi.spyOn(console, "error").mockImplementation(() => {});
        vi.spyOn(console, "warn").mockImplementation(() => {});
        const sdk = s.useActualSdk({ failWrites: true });
        const collector = createProceedsCollector(s.deps);
        await collector.tick();
        expect(sdk.register).toHaveBeenCalledTimes(1);
        expect(s.jobs.submissionEvidence("job").state).toBe("entered");
        s.restartDatabase();
        s.setNow(60200);
        const recovered = createProceedsCollector(s.deps);
        await recovered.tick();
        expect(sdk.register).toHaveBeenCalledTimes(1);
        expect(recovered.status().blocker).toBe("proceeds_submission_ambiguous");
        expect(s.deps.reservations.listReservedOutpoints()).toHaveLength(1);
    });
    it("uses SDK settlement with explicit same-owner plain outputs and holds the input before registration", async () => {
        const s = splitSetup();
        vi.spyOn(console, "warn").mockImplementation(() => {});
        const sdk = s.useActualSdk();
        await createProceedsCollector(s.deps).tick();
        const outputs = sdk.sign.mock.calls[0]![1] as { script: Uint8Array; amount: bigint }[];
        expect(outputs).toHaveLength(8);
        expect(outputs.map((o) => o.amount.toString())).toEqual(split().outputs);
        expect(outputs.every((o) => bytesToHex(o.script) === singleton.script)).toBe(true);
        expect(s.deps.reservations.listReservedOutpoints()).toHaveLength(1);
    });
});

describe("inventory split coordination", () => {
    const singleton = fundingCoin({ value: 100000 });
    const protectedCfg = { ...cfg, operatorMinReserveSats: 10000n };
    const makeSplit = () =>
        planInventorySplit([singleton], [], protectedCfg, {}, address, clock, -1n)!;
    it("defers a fee estimator that cannot converge within its bounded attempts", () => {
        let call = 0;
        const quoted = vi
            .spyOn(Estimator.prototype, "evalOffchainOutput")
            .mockImplementation(() => ({ satoshis: ++call, weight: 0 }) as any);
        expect(
            planInventorySplit(
                [singleton],
                [],
                { ...protectedCfg, proceedsMaxFeeSats: 10000n },
                {},
                address,
                clock,
                -1n,
            ),
        ).toBeUndefined();
        expect(quoted.mock.calls.length).toBeLessThanOrEqual(280);
    });
    it("serializes concurrent ticks and competitors while reserving the singleton before submission", async () => {
        const s = setup(makeSplit(), [singleton]);
        s.deps.config = protectedCfg;
        let release!: () => void;
        const gate = new Promise<void>((resolve) => {
            release = resolve;
        });
        s.settle.mockImplementation(async () => {
            await gate;
            return "cc".repeat(32);
        });
        const collector = createProceedsCollector(s.deps);
        const tick = collector.tick();
        expect(collector.tick()).toBe(tick);
        await vi.waitFor(() => expect(s.settle).toHaveBeenCalledTimes(1));
        expect(s.deps.reservations.listReservedOutpoints()).toEqual([
            { txid: singleton.txid, vout: singleton.vout },
        ]);
        const competitor = createProceedsCollector(s.deps);
        await competitor.tick();
        expect(competitor.status().blocker).toBe("proceeds_worker_active");
        collector.stop();
        release();
        await collector.drain();
        await collector.tick();
        expect(s.settle).toHaveBeenCalledTimes(1);
    });
    it("never creates an automatic split after stop or while an SDK intent locks the input", async () => {
        for (const stopped of [false, true]) {
            const s = setup(makePlan(), [singleton]);
            s.deps.config = protectedCfg;
            s.jobs.complete("job", "cc".repeat(32));
            s.deps.runtime.providers.indexerProvider.getVtxos = async () =>
                ({ vtxos: [singleton] }) as any;
            const collector = createProceedsCollector(s.deps);
            if (stopped) collector.stop();
            else s.setSdkLocks([singleton]);
            await collector.tick();
            expect(s.jobs.active()).toBeUndefined();
            expect(s.settle).not.toHaveBeenCalled();
        }
    });
});

describe("inventory split database fencing", () => {
    const singleton = fundingCoin({ value: 100000 });
    const protectedCfg = { ...cfg, operatorMinReserveSats: 10000n };
    const split = () => planInventorySplit([singleton], [], protectedCfg, {}, address, clock, -1n)!;
    const reserve = (s: ReturnType<typeof setup>) => {
        const policy = new PolicyRepository(s.db);
        policy.update(
            {
                paused: false,
                maxOutstandingSats: 1000n,
                maxPerPaymentTopupSats: 330n,
                maxConcurrentAdvances: 3,
                assetRules: [
                    {
                        assetId: null,
                        enabled: true,
                        claim: "either",
                        maxTopupSats: null,
                        fares: [],
                    },
                ],
            },
            "test",
        );
        new ReservationRepository(s.db).reserveQuote({
            advance: advance({
                state: "quoted",
                operatorInputs: [{ txid: singleton.txid, vout: singleton.vout }],
                createdAt: 100,
                expiresAt: 160,
            }),
            expectedPolicyRevision: policy.getSnapshot().revision,
            recoveryExecutionBudget: { kind: "height", value: 0n },
        });
    };
    it("prevents a quote from acquiring an input owned by a durable split job", () => {
        const s = setup(split(), [singleton]);
        expect(() => reserve(s)).toThrow("operator input already reserved");
        expect(new AdvanceRepository(s.db).get("adv-1")).toBeUndefined();
        expect(s.deps.reservations.listReservedOutpoints()).toHaveLength(1);
    });
    it("refuses a new split job when a quote changes the reservation snapshot after planning begins", async () => {
        const s = setup(makePlan(), [singleton]);
        s.deps.config = protectedCfg;
        s.jobs.complete("job", "cc".repeat(32));
        s.deps.runtime.providers.indexerProvider.getVtxos = async () =>
            ({ vtxos: [singleton] }) as any;
        vi.spyOn(s.deps.runtime.wallet!.arkProvider, "getInfo").mockImplementation(async () => {
            reserve(s);
            return s.info;
        });
        const collector = createProceedsCollector(s.deps);
        await collector.tick();
        expect(s.jobs.active()).toBeUndefined();
        expect(s.settle).not.toHaveBeenCalled();
        expect(s.deps.reservations.listReservedOutpoints()).toEqual([
            { txid: singleton.txid, vout: singleton.vout },
        ]);
    });
    it("keeps exact but unsafe newly settled outputs fenced", async () => {
        const plan = split();
        const s = setup(plan, [singleton]);
        s.deps.config = protectedCfg;
        s.finish();
        s.setOutputs(
            plan.outputs!.map((value, vout) =>
                fundingCoin({
                    value: Number(value),
                    txid: "dd".repeat(32),
                    vout,
                    commitmentTxIds: ["cc".repeat(32)],
                    expiresAtHeight: clock.height + 1,
                }),
            ),
        );
        await createProceedsCollector(s.deps).tick();
        expect(s.jobs.active()?.blocker).toBe("proceeds_output_pending");
        expect(s.deps.reservations.listReservedOutpoints()).toHaveLength(1);
    });
});

describe("inventory split replenishment progress", () => {
    it("counts every new output as a working coin with a zero reserve and stops at eight", () => {
        const zero = { ...cfg, operatorMinReserveSats: 0n };
        const singleton = fundingCoin({ value: 100000 });
        const plan = planInventorySplit([singleton], [], zero, {}, address, clock, -1n)!;
        expect(plan.outputs).toHaveLength(8);
        expect(plan.outputs!.every((n) => BigInt(n) >= 660n)).toBe(true);
        const outputs = plan.outputs!.map((n, vout) => fundingCoin({ value: Number(n), vout }));
        expect(planInventorySplit(outputs, [], zero, {}, address, clock, -1n)).toBeUndefined();
        const seven = outputs.slice(0, 7);
        const refill = planInventorySplit(seven, [], zero, {}, address, clock, -1n)!;
        expect(refill.outputs).toHaveLength(2);
        expect(refill.outputs!.every((n) => BigInt(n) >= 660n)).toBe(true);
    });
    it.each([100000, 10000])(
        "preserves receipt collection or its blocker while bootstrapping a %s-sat pool",
        async (value) => {
            const singleton = fundingCoin({ value });
            const protectedCfg = { ...cfg, operatorMinReserveSats: 10000n };
            const s = setup();
            s.jobs.complete("job", "cc".repeat(32));
            s.deps.config = protectedCfg;
            const receiverAddress = new ArkAddress(
                cfg.serverPubkey,
                receiverKey,
                cfg.addressHrp,
            ).encode();
            const fare = { currency: "sats" as const, units: 10n };
            const encoded = buildSponsoredEnvelope(
                {
                    advanceId: "sponsored-1",
                    senderInputs: [
                        {
                            txid: "ac".repeat(32),
                            vout: 0,
                            value: 1000n,
                            tapTree: senderTree.encode(),
                            spendLeaf: senderTree.scripts[0],
                            expiry: { kind: "height", value: 900000n },
                        },
                    ],
                    senderSats: 1000n,
                    funding: {
                        inputs: [carrier],
                        totalValue: 2000n,
                        batchExpiry: { kind: "height", value: 900000n },
                    },
                    params: {
                        receiverKey,
                        senderKey,
                        operatorKey: cfg.operatorKey,
                        dust: cfg.dust,
                        contribution: 10n,
                    },
                    receiverAddress,
                    fare,
                    satsFarePayer: "sender",
                },
                cfg,
                serverUnroll,
            );
            const envelope = decodeLockupEnvelope(encoded);
            const tx = Transaction.fromPSBT(base64.decode(envelope.arkTx));
            const locked = advance({
                id: "sponsored-1",
                kind: "sponsored",
                operatorKey: cfg.operatorKey,
                topup: 10n,
                locktime: 0n,
                batchExpiry: { kind: "height", value: 900000n },
                operatorInputs: [{ txid: carrier.txid, vout: carrier.vout }],
                unsignedLockupTx: encoded,
                unsignedLockupId: envelope.unsignedTxId,
                covenantAddress: receiverAddress,
                fare,
                arkTxid: tx.id,
                outpoint: { txid: tx.id, vout: envelope.covenantOutputIndex },
            });
            const advances = new AdvanceRepository(s.db);
            s.deps.advances = advances;
            advances.insert(locked);
            const fareCoin = fundingCoin({
                txid: tx.id,
                vout: 1,
                value: Number(tx.getOutput(1).amount),
                isSwept: true,
            });
            s.setOutputs([fareCoin, singleton]);
            s.deps.runtime.providers.indexerProvider.getVtxos = async ({ outpoints }: any) => ({
                vtxos: outpoints.map((p: Outpoint) =>
                    p.txid === singleton.txid ? singleton : fareCoin,
                ),
            });
            expect(await discoverProceeds(s.deps, [fareCoin, singleton])).toEqual([fareCoin]);
            expect(() =>
                planProceeds(
                    [fareCoin],
                    [fareCoin, singleton],
                    [],
                    protectedCfg,
                    {},
                    address,
                    clock,
                    -1n,
                ),
            ).toThrow("proceeds_reserve_unavailable");
            const collector = createProceedsCollector(s.deps);
            await collector.tick();
            if (value === 10000) {
                expect(s.settle).not.toHaveBeenCalled();
                expect(s.jobs.active()).toBeUndefined();
                expect(collector.status().blocker).toBe("proceeds_reserve_unavailable");
                return;
            }
            expect(s.settle).toHaveBeenCalledTimes(1);
            expect(s.jobs.active()?.plan.kind).toBe("inventory-split");
            expect(s.jobs.active()?.plan.inputs).toEqual([
                { txid: singleton.txid, vout: singleton.vout },
            ]);
            expect(s.jobs.active()?.plan.receipts).toEqual([]);
        },
    );
});
