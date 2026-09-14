import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Transaction, type IndexerProvider, type VirtualCoin } from "@arkade-os/sdk";
import { ArkAddress } from "@arkade-os/sdk";
import { base64, hex } from "@scure/base";
import {
    AdvanceRepository,
    PolicyRepository,
    ReservationRepository,
    openDatabase,
    type Database,
} from "@arkade-taxi/db";
import type { Advance } from "@arkade-taxi/core";
import { buildLockupEnvelope } from "../src/arkade/lockupBuilder.js";
import {
    buildSponsoredEnvelope,
    type SponsoredBuildRequest,
} from "../src/arkade/sponsoredBuilder.js";
import { decodeLockupEnvelope } from "../src/arkade/psbt.js";
import { createLockupReconciler } from "../src/reconciler.js";
import {
    config,
    fundingCoin,
    NOW,
    policy as basePolicy,
    receiverKey,
    senderKey,
} from "./fixtures.js";
import { buildRequest, senderTree, unroll } from "./arkade/lockupFixtures.js";

const directories: string[] = [];
afterEach(() => {
    while (directories.length) rmSync(directories.pop()!, { recursive: true, force: true });
});

const persistedQuote = (): Advance => {
    const request = buildRequest();
    const unsignedLockupTx = buildLockupEnvelope(request, config(), unroll);
    const envelope = decodeLockupEnvelope(unsignedLockupTx);
    return {
        id: request.advanceId,
        state: "quoted",
        ...request.params,
        batchExpiry: request.funding.batchExpiry,
        recoveryLocktime: {
            kind: request.funding.batchExpiry.kind,
            value: request.params.locktime,
        },
        operatorInputs: request.funding.inputs.map(({ txid, vout }) => ({ txid, vout })),
        unsignedLockupTx,
        unsignedLockupId: envelope.unsignedTxId,
        covenantAddress: request.covenantAddress,
        fare: request.fare,
        createdAt: NOW,
        updatedAt: NOW,
        expiresAt: NOW + 60,
    };
};

const setup = (path = ":memory:") => {
    const db = openDatabase(path);
    const advances = new AdvanceRepository(db);
    const policy = new PolicyRepository(db);
    policy.update(basePolicy(), "test");
    const reservations = new ReservationRepository(db);
    const quote = persistedQuote();
    reservations.reserveQuote({
        advance: quote,
        expectedPolicyRevision: policy.getSnapshot().revision,
        recoveryExecutionBudget: { kind: quote.batchExpiry.kind, value: 1n },
    });
    reservations.claimLockup(
        quote.id,
        quote.unsignedLockupId,
        "cc".repeat(32),
        "signed-envelope",
        () => NOW + 1,
    );
    const envelope = decodeLockupEnvelope(quote.unsignedLockupTx);
    const tx = Transaction.fromPSBT(base64.decode(envelope.arkTx));
    return { db, advances, policy, reservations, quote, outpoint: { txid: tx.id, vout: 0 }, tx };
};

const observedCoin = (
    txid: string,
    script: string,
    over: Partial<VirtualCoin> = {},
): VirtualCoin => ({
    ...fundingCoin({ txid, vout: 0, script }),
    ...over,
});

const indexer = (read: IndexerProvider["getVtxos"]): Pick<IndexerProvider, "getVtxos"> => ({
    getVtxos: read,
});

describe("locking reconciliation", () => {
    it("serializes submission resumption and canonical spend catch-up", async () => {
        const state = setup();
        const order: string[] = [];
        let release!: () => void;
        const gate = new Promise<void>((resolve) => (release = resolve));
        const reconciler = createLockupReconciler({
            submission: {
                resume: async () => {
                    order.push("submission");
                    return false;
                },
            },
            watcher: {
                catchUp: async () => {
                    order.push("watcher");
                    await gate;
                },
                status: () => ({
                    lastScanAt: NOW,
                    watching: 1,
                    blockers: [
                        { advanceId: state.quote.id, code: "watcher_block", detail: "detail" },
                    ],
                }),
            },
            advances: state.advances,
            reservations: state.reservations,
            policy: state.policy,
            indexer: indexer(async () => ({ vtxos: [] })),
            now: () => NOW + 2,
            clock: () => ({ height: 700000, timestamp: new Date(NOW * 1000) }),
        });

        const first = reconciler.tick();
        const second = reconciler.tick();
        await Promise.resolve();
        expect(order).toEqual(["submission"]);
        await vi.waitFor(() => expect(order).toEqual(["submission", "watcher"]));
        release();
        await Promise.all([first, second]);
        expect(order).toEqual(["submission", "watcher"]);
        expect(reconciler.status()).toMatchObject({
            watching: 1,
            blockers: ["watcher_block"],
            blockerDetails: [{ advanceId: state.quote.id, detail: "detail" }],
        });
        state.db.close();
    });

    it("blocks readiness for an absent legacy row but still promotes exact observation", async () => {
        const state = setup();
        state.advances.update({
            ...state.advances.get(state.quote.id)!,
            submissionPhase: "legacy",
            failureCode: "lockup_submission_legacy_unresumable",
            failureDetail: "legacy row has no signed envelope",
        });
        let visible = false;
        const script = hex.encode(state.tx.getOutput(0).script!);
        const reconciler = createLockupReconciler({
            submission: { resume: async () => false },
            advances: state.advances,
            reservations: state.reservations,
            policy: state.policy,
            indexer: indexer(async (filter) => ({
                vtxos:
                    visible && filter?.outpoints?.[0]?.txid === state.outpoint.txid
                        ? [observedCoin(state.outpoint.txid, script)]
                        : [],
            })),
            now: () => NOW + 2,
            clock: () => ({ height: 700000, timestamp: new Date(NOW * 1000) }),
        });

        await reconciler.tick();
        expect(reconciler.status().blockers).toEqual(["lockup_submission_legacy_unresumable"]);
        visible = true;
        await reconciler.tick();
        expect(state.advances.get(state.quote.id)?.state).toBe("locked");
        expect(reconciler.status().blockers).toEqual([]);
        state.db.close();
    });

    it("retains an absent lockup and promotes only an exact spendable observation", async () => {
        const state = setup();
        let visible = false;
        const script = hex.encode(state.tx.getOutput(0).script!);
        const reconciler = createLockupReconciler({
            submission: { resume: async () => false },
            advances: state.advances,
            reservations: state.reservations,
            policy: state.policy,
            indexer: indexer(async (filter) => ({
                vtxos:
                    visible && filter?.outpoints?.[0]?.txid === state.outpoint.txid
                        ? [observedCoin(state.outpoint.txid, script)]
                        : [],
            })),
            now: () => NOW + 2,
            clock: () => ({ height: 700000, timestamp: new Date(NOW * 1000) }),
        });

        await reconciler.tick();
        expect(state.advances.get(state.quote.id)?.state).toBe("locking");
        visible = true;
        await reconciler.tick();
        expect(state.advances.get(state.quote.id)).toMatchObject({
            state: "locked",
            outpoint: state.outpoint,
            lastObservedAt: NOW + 2,
        });
        state.db.close();
    });

    it("catches up a persisted locking row after restart", async () => {
        const directory = mkdtempSync(join(tmpdir(), "taxi-reconcile-"));
        directories.push(directory);
        const path = join(directory, "taxi.sqlite");
        const first = setup(path);
        const script = hex.encode(first.tx.getOutput(0).script!);
        first.db.close();
        const second: Database = openDatabase(path);
        const advances = new AdvanceRepository(second);
        const reconciler = createLockupReconciler({
            submission: { resume: async () => false },
            advances,
            reservations: new ReservationRepository(second),
            policy: new PolicyRepository(second),
            indexer: indexer(async () => ({
                vtxos: [observedCoin(first.outpoint.txid, script)],
            })),
            now: () => NOW + 3,
            clock: () => ({ height: 700000, timestamp: new Date(NOW * 1000) }),
        });
        await reconciler.tick();
        expect(advances.get(first.quote.id)?.state).toBe("locked");
        second.close();
    });

    it("keeps ambiguity locking on indexer failure", async () => {
        const state = setup();
        const reconciler = createLockupReconciler({
            submission: { resume: async () => false },
            advances: state.advances,
            reservations: state.reservations,
            policy: state.policy,
            indexer: indexer(async () => {
                throw new Error("offline");
            }),
            now: () => NOW + 2,
            clock: () => ({ height: 700000, timestamp: new Date(NOW * 1000) }),
        });
        await reconciler.tick();
        expect(state.advances.get(state.quote.id)?.state).toBe("locking");
        expect(reconciler.status().blockers).toEqual([]);
        state.db.close();
    });

    it("records a proved reserved-input conflict, keeps reservations, and pauses readiness", async () => {
        const state = setup();
        const operator = state.quote.operatorInputs[0]!;
        const reconciler = createLockupReconciler({
            submission: { resume: async () => false },
            advances: state.advances,
            reservations: state.reservations,
            policy: state.policy,
            indexer: indexer(async (filter) => ({
                vtxos:
                    filter?.outpoints?.[0]?.txid === operator.txid
                        ? [
                              observedCoin(operator.txid, fundingCoin().script, {
                                  isSpent: true,
                                  spentBy: "dd".repeat(32),
                                  arkTxId: "ee".repeat(32),
                              }),
                          ]
                        : [],
            })),
            now: () => NOW + 2,
            clock: () => ({ height: 700000, timestamp: new Date(NOW * 1000) }),
        });
        await reconciler.tick();
        expect(state.advances.get(state.quote.id)).toMatchObject({
            state: "locking",
            failureCode: "reserved_input_conflict",
        });
        expect(state.reservations.listForAdvance(state.quote.id)).toEqual([operator]);
        expect(state.policy.get().paused).toBe(true);
        expect(reconciler.status().blockers).toEqual(["reserved_input_conflict"]);
        state.db.close();
    });
});

describe("sponsored settlement", () => {
    const sponsoredRequest = (): SponsoredBuildRequest => {
        const cfg = config();
        return {
            advanceId: "sponsored-1",
            senderInputs: [
                {
                    txid: "ab".repeat(32),
                    vout: 2,
                    value: 100n,
                    tapTree: senderTree.encode(),
                    spendLeaf: senderTree.scripts[0],
                    expiry: { kind: "height", value: 910_000n },
                },
            ],
            senderSats: 100n,
            funding: {
                inputs: [fundingCoin()],
                totalValue: 20_000n,
                batchExpiry: { kind: "height", value: 900_000n },
            },
            params: {
                receiverKey,
                senderKey,
                operatorKey: cfg.operatorKey,
                dust: 330n,
                contribution: 230n,
            },
            receiverAddress: new ArkAddress(cfg.serverPubkey, receiverKey, cfg.addressHrp).encode(),
            fare: { currency: "sats", units: 10n },
        };
    };

    const setupSponsored = () => {
        const db = openDatabase(":memory:");
        const advances = new AdvanceRepository(db);
        const policy = new PolicyRepository(db);
        policy.update(basePolicy(), "test");
        const reservations = new ReservationRepository(db);
        const request = sponsoredRequest();
        const unsignedSponsoredTx = buildSponsoredEnvelope(request, config(), unroll);
        const envelope = decodeLockupEnvelope(unsignedSponsoredTx);
        const quote: Advance = {
            id: request.advanceId,
            kind: "sponsored",
            state: "quoted",
            receiverKey: request.params.receiverKey,
            senderKey: request.params.senderKey,
            operatorKey: request.params.operatorKey,
            dust: request.params.dust,
            topup: request.params.contribution,
            locktime: 0n,
            batchExpiry: request.funding.batchExpiry,
            operatorInputs: request.funding.inputs.map(({ txid, vout }) => ({ txid, vout })),
            unsignedLockupTx: unsignedSponsoredTx,
            unsignedLockupId: envelope.unsignedTxId,
            covenantAddress: request.receiverAddress,
            fare: request.fare,
            createdAt: NOW,
            updatedAt: NOW,
            expiresAt: NOW + 60,
        };
        reservations.reserveQuote({
            advance: quote,
            expectedPolicyRevision: policy.getSnapshot().revision,
            recoveryExecutionBudget: { kind: quote.batchExpiry.kind, value: 0n },
        });
        reservations.claimLockup(
            quote.id,
            quote.unsignedLockupId,
            "cc".repeat(32),
            "signed-envelope",
            () => NOW + 1,
        );
        const tx = Transaction.fromPSBT(base64.decode(envelope.arkTx));
        return {
            db,
            advances,
            policy,
            reservations,
            quote,
            outpoint: { txid: tx.id, vout: 0 },
            script: hex.encode(tx.getOutput(0).script!),
        };
    };

    const sponsoredReconciler = (
        state: ReturnType<typeof setupSponsored>,
        read: IndexerProvider["getVtxos"],
    ) =>
        createLockupReconciler({
            submission: { resume: async () => false },
            advances: state.advances,
            reservations: state.reservations,
            policy: state.policy,
            indexer: indexer(read),
            now: () => NOW + 2,
            clock: () => ({ height: 700000, timestamp: new Date(NOW * 1000) }),
        });

    it("settles an observed payment outpoint and releases its reservation", async () => {
        const state = setupSponsored();
        const reconciler = sponsoredReconciler(state, async (filter) => ({
            vtxos:
                filter?.outpoints?.[0]?.txid === state.outpoint.txid
                    ? [observedCoin(state.outpoint.txid, state.script)]
                    : [],
        }));
        await reconciler.tick();
        expect(state.advances.get(state.quote.id)).toMatchObject({
            state: "locked",
            outpoint: state.outpoint,
        });
        expect(state.reservations.listForAdvance(state.quote.id)).toEqual([]);
        state.db.close();
    });

    it("settles even when the receiver already spent onwards", async () => {
        const state = setupSponsored();
        const reconciler = sponsoredReconciler(state, async () => ({
            vtxos: [
                observedCoin(state.outpoint.txid, state.script, {
                    isSpent: true,
                    spentBy: "cc".repeat(32),
                    arkTxId: "dd".repeat(32),
                }),
            ],
        }));
        await reconciler.tick();
        expect(state.advances.get(state.quote.id)?.state).toBe("locked");
        expect(state.reservations.listForAdvance(state.quote.id)).toEqual([]);
        state.db.close();
    });

    it("settles from operator inputs spent by the joint transaction", async () => {
        const state = setupSponsored();
        const operator = state.quote.operatorInputs[0]!;
        const reconciler = sponsoredReconciler(state, async (filter) => {
            if (filter?.outpoints?.[0]?.txid === state.outpoint.txid) return { vtxos: [] };
            return {
                vtxos: [
                    observedCoin(operator.txid, fundingCoin().script, {
                        isSpent: true,
                        spentBy: state.outpoint.txid,
                        arkTxId: state.outpoint.txid,
                    }),
                ],
            };
        });
        await reconciler.tick();
        expect(state.advances.get(state.quote.id)?.state).toBe("locked");
        expect(state.reservations.listForAdvance(state.quote.id)).toEqual([]);
        state.db.close();
    });

    it("re-releases a settled row whose reservation survived a crash", async () => {
        const state = setupSponsored();
        const reconciler = sponsoredReconciler(state, async () => ({ vtxos: [] }));
        state.advances.recordLockupObserved(state.quote.id, state.outpoint, NOW + 2);
        expect(state.reservations.listForAdvance(state.quote.id)).toHaveLength(1);
        await reconciler.tick();
        expect(state.reservations.listForAdvance(state.quote.id)).toEqual([]);
        state.db.close();
    });
});
