import { afterEach, describe, expect, it } from "vitest";
import { openDatabase, ProceedsRepository, ReservationRepository } from "../src/index.js";

const db = openDatabase(":memory:");
afterEach(() => db.exec("DELETE FROM proceeds_inputs; DELETE FROM proceeds_jobs"));
const input = { txid: "aa".repeat(32), vout: 0 };
const plan = { inputs: [input], amount: "1001", assets: [], fee: "0", maxFee: "0" };

describe("proceeds reservations", () => {
    it("rejects a changed reservation snapshot even when selected inputs do not overlap", () => {
        const repo = new ProceedsRepository(db);
        expect(() => repo.create("a", plan, 10, [{ txid: "bb".repeat(32), vout: 1 }])).toThrow(
            /reservation_changed/,
        );
        expect(repo.active()).toBeUndefined();
        expect(new ReservationRepository(db).listReservedOutpoints()).toEqual([]);
    });
    it("fences competing workers and rejects the old owner after an expired lease is claimed", () => {
        const repo = new ProceedsRepository(db);
        repo.create("a", plan, 10);
        expect(repo.claim("a", "one", 10, 20)).toBe(true);
        expect(repo.claim("a", "two", 19, 29)).toBe(false);
        expect(repo.claim("a", "two", 21, 31)).toBe(true);
        expect(() => repo.assertLease("a", "one", 21)).toThrow(/lease_lost/);
        expect(() => repo.assertLease("a", "two", 21)).not.toThrow();
    });
    it("persists the exact immutable plan and reserves against quote inventory", () => {
        const repo = new ProceedsRepository(db);
        repo.create("a", plan, 10);
        expect(new ProceedsRepository(db).active()).toEqual({
            id: "a",
            plan,
            state: "pending",
            blocker: null,
            commitmentTxid: null,
        });
        expect(new ReservationRepository(db).listReservedOutpoints()).toEqual([input]);
        expect(() => repo.create("b", plan, 11)).toThrow(/proceeds.*active/);
    });
    it("retains reservations on ambiguous or quarantined outcomes and releases only completion", () => {
        const repo = new ProceedsRepository(db);
        repo.create("a", plan, 10);
        repo.update("a", "quarantined", "proceeds_ambiguous", null);
        expect(new ReservationRepository(db).listReservedOutpoints()).toEqual([input]);
        repo.complete("a", "bb".repeat(32));
        expect(new ReservationRepository(db).listReservedOutpoints()).toEqual([]);
        expect(repo.active()).toBeUndefined();
    });
    it("cannot overwrite the fee authorization or plan by recreating a completed id", () => {
        const repo = new ProceedsRepository(db);
        repo.create("a", plan, 10);
        repo.complete("a", "bb".repeat(32));
        expect(() => repo.create("a", { ...plan, maxFee: "100" }, 20)).toThrow();
        expect(repo.get("a")?.plan.maxFee).toBe("0");
    });
});
