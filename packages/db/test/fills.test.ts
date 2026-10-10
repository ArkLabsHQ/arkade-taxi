import { afterEach, describe, expect, it } from "vitest";
import DatabaseCtor from "better-sqlite3";
import type { Advance } from "@arkade-taxi/core";
import { AdvanceRepository, applyMigrations, FillRepository, type Fill } from "../src/index.js";

const NOW = 100;
const INPUT = { txid: "aa".repeat(32), vout: 1 };
const TXID = "bb".repeat(32);
const row = (over: Partial<Fill> = {}): Fill => ({
    id: "f1",
    quoteId: "q1",
    operationId: "op1",
    state: "submitting",
    taxiInputs: [INPUT],
    covenantOutputIndex: 2,
    assetUnits: 5n,
    contributionSats: 330n,
    fare: { currency: "sats", units: 4n },
    graph: { arkTx: "graph", checkpoints: [] },
    graphId: new Uint8Array(32),
    submitInvoked: true,
    leaseToken: "t1",
    leaseUntil: 99,
    attempts: 1,
    createdAt: 1,
    updatedAt: 1,
    expiresAt: 60,
    ...over,
});
const databases: InstanceType<typeof DatabaseCtor>[] = [];
afterEach(() => databases.splice(0).forEach((db) => db.close()));
const setup = (over: Partial<Fill> = {}) => {
    const db = new DatabaseCtor(":memory:");
    databases.push(db);
    applyMigrations(db);
    const fills = new FillRepository(db);
    fills.insert(row(over));
    const advances = new AdvanceRepository(db);
    const advance: Advance = {
        id: "q1",
        state: "locking",
        receiverKey: new Uint8Array(32),
        senderKey: new Uint8Array(32),
        operatorKey: new Uint8Array(32),
        operatorSignerKey: new Uint8Array(32),
        exitDelay: { value: 5n, type: "blocks" },
        dust: 330n,
        topup: 330n,
        assetId: { txid: new Uint8Array(32), groupIndex: 0 },
        assetUnits: 5n,
        locktime: 1_800_000_000n,
        recoveryLocktime: { kind: "time", value: 1_800_000_000n },
        operatorInputs: [INPUT],
        unsignedLockupTx: "source",
        unsignedLockupId: TXID,
        covenantAddress: "ark1example",
        fare: { currency: "sats", units: 4n },
        createdAt: 1,
        updatedAt: 1,
        expiresAt: 60,
    };
    advances.insert(advance);
    db.prepare(
        `INSERT INTO receive_quotes (id, state, receiver_address, sender_key, params_json,
        covenant_address, fare_json, batch_expiry_kind, batch_expiry_value, input_expiry_floor_kind,
        input_expiry_floor_value, recovery_locktime_kind, recovery_locktime_value, loan_sats,
        created_at, expires_at, policy_revision, operator_inputs_json, bound_fill_id)
        VALUES ('q1', 'bound', 'ark1example', ?, '{}', 'ark1example', '{}', 'time', 1900000000,
        'time', 1900000000, 'time', 1800000000, 330, 1, 60, 1, ?, 'f1')`,
    ).run("aa".repeat(32), JSON.stringify([INPUT]));
    db.prepare(
        "INSERT INTO operator_input_reservations (outpoint_txid, outpoint_vout, advance_id, batch_expiry_kind, batch_expiry_value, created_at) VALUES (?, ?, ?, ?, ?, ?)",
    ).run(INPUT.txid, INPUT.vout, "q1", "time", 2000, 1);
    const reservations = () =>
        db.prepare("SELECT count(*) AS n FROM operator_input_reservations").get() as { n: number };
    return { db, fills, advances, reservations };
};

describe("generic fill liability lifecycle", () => {
    it("atomically settles the linked advance with the declared covenant index", () => {
        const { fills, advances, reservations } = setup();
        expect(fills.reconcileSettled(fills.get("f1")!, TXID, { txid: TXID, vout: 2 }, NOW)).toBe(
            true,
        );
        expect(fills.get("f1")!.state).toBe("settled");
        expect(advances.get("q1")!.state).toBe("locked");
        expect(advances.get("q1")!.outpoint).toEqual({ txid: TXID, vout: 2 });
        expect(reservations().n).toBe(1);
    });
    it("cancels a conflicting fill and terminalizes its liability before releasing coins", () => {
        const { fills, advances, reservations } = setup();
        expect(fills.reconcileCancelled(fills.get("f1")!, "fill_input_conflict", NOW, TXID)).toBe(
            true,
        );
        expect(fills.get("f1")!.state).toBe("cancelled");
        expect(advances.get("q1")!.state).toBe("expired");
        expect(reservations().n).toBe(0);
    });
    it("releases never-invoked signing failures atomically", () => {
        const { fills, advances, reservations } = setup({ submitInvoked: false });
        fills.recordSigningFailure("f1", "t1", "fill_signing_failed", "refused", NOW);
        expect(fills.get("f1")!.state).toBe("cancelled");
        expect(advances.get("q1")!.state).toBe("expired");
        expect(reservations().n).toBe(0);
    });
    it("cannot turn an invoked submit into a signing failure", () => {
        const { fills, advances, reservations } = setup();
        fills.recordSigningFailure("f1", "t1", "fill_signing_failed", "late", NOW);
        expect(fills.get("f1")!.state).toBe("submitting");
        expect(advances.get("q1")!.state).toBe("locking");
        expect(reservations().n).toBe(1);
    });
    it("does not expire a never-invoked row while its handler lease is active", () => {
        const { fills, advances } = setup({ submitInvoked: false, leaseUntil: NOW + 20 });
        expect(fills.expire(NOW)).toBe(0);
        expect(advances.get("q1")!.state).toBe("locking");
    });
    it("expires inactive never-invoked rows without leaving a locking advance", () => {
        const { fills, advances, reservations } = setup({ submitInvoked: false });
        expect(fills.expire(NOW)).toBe(1);
        expect(advances.get("q1")!.state).toBe("expired");
        expect(reservations().n).toBe(0);
    });
    it.each(["reconcileSettled", "reconcileCancelled"] as const)(
        "%s rejects a stale snapshot after a lease change",
        (method) => {
            const { fills, db, reservations } = setup();
            const snapshot = fills.get("f1")!;
            db.prepare(
                "UPDATE fills SET lease_token = 'new', lease_until = 200 WHERE id = 'f1'",
            ).run();
            const changed =
                method === "reconcileSettled"
                    ? fills.reconcileSettled(snapshot, TXID, { txid: TXID, vout: 2 }, NOW)
                    : fills.reconcileCancelled(snapshot, "fill_input_conflict", NOW, TXID);
            expect(changed).toBe(false);
            expect(reservations().n).toBe(1);
        },
    );
    it("rolls back fill settlement when linked liability cannot be updated", () => {
        const { fills, db, reservations } = setup();
        db.prepare("UPDATE advances SET state = 'expired' WHERE id = 'q1'").run();
        expect(() =>
            fills.reconcileSettled(fills.get("f1")!, TXID, { txid: TXID, vout: 2 }, NOW),
        ).toThrow();
        expect(fills.get("f1")!.state).toBe("submitting");
        expect(reservations().n).toBe(1);
    });
    it("preserves an inconsistent bound row without releasing its liability", () => {
        const { fills, db, reservations, advances } = setup({ submitInvoked: false });
        db.prepare(
            "UPDATE receive_quotes SET state = 'expired', bound_fill_id = NULL WHERE id = 'q1'",
        ).run();
        expect(fills.expire(NOW)).toBe(0);
        expect(fills.get("f1")!.failureCode).toBe("fill_bound_expiry_unsafe");
        expect(advances.get("q1")!.state).toBe("locking");
        expect(reservations().n).toBe(1);
    });
    it("settles after the observed advance has already entered recovery", () => {
        const { fills, db, advances } = setup();
        db.prepare(
            "UPDATE advances SET state = 'recovering', ark_txid = ?, outpoint_txid = ?, outpoint_vout = 2 WHERE id = 'q1'",
        ).run(TXID, TXID);
        expect(fills.reconcileSettled(fills.get("f1")!, TXID, { txid: TXID, vout: 2 }, NOW)).toBe(
            true,
        );
        expect(advances.get("q1")!.state).toBe("recovering");
    });
});
