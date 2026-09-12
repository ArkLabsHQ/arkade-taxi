import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Transaction, type IndexerProvider, type VirtualCoin } from "@arkade-os/sdk";
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
import { decodeLockupEnvelope } from "../src/arkade/psbt.js";
import { createLockupReconciler } from "../src/reconciler.js";
import { config, fundingCoin, NOW, policy as basePolicy } from "./fixtures.js";
import { buildRequest, unroll } from "./arkade/lockupFixtures.js";

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
