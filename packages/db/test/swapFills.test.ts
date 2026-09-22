import { describe, expect, it } from "vitest";
import DatabaseCtor from "better-sqlite3";
import type { Database } from "better-sqlite3";
import { AdvanceRepository } from "../src/advances.js";
import { applyMigrations, MIGRATIONS } from "../src/schema.js";
import { SwapFillRepository } from "../src/swapFills.js";
import type { SwapFill } from "../src/swapFills.js";

const NOW = 1_757_000_000;

function fresh(): Database {
    const db = new DatabaseCtor(":memory:");
    db.defaultSafeIntegers(true);
    return db;
}

const GRAPH = {
    arkTx: "aGVsbG8=",
    checkpoints: ["d29ybGQ="],
    graphId: new Uint8Array(32).fill(0xab),
    inputOwners: [null, "solver", "sponsor"] as (string | null)[],
};

const fill = (over: Partial<SwapFill> = {}): SwapFill => ({
    id: "fill-1",
    operationId: "op-1",
    state: "quoted",
    offerHex: "deadbeef",
    offerTxid: "aa".repeat(32),
    offerVout: 0,
    solverInputs: [{ txid: "bb".repeat(32), vout: 1, value: 5000n }],
    solverProceedsScript: new Uint8Array([0x51]),
    solverKeys: ["ab".repeat(32)],
    taxiInputs: [{ txid: "cc".repeat(32), vout: 0 }],
    contributionSats: 330n,
    sponsorScript: new Uint8Array([0x52]),
    fare: { currency: "sats", units: 10n },
    maxFare: { currency: "sats", units: 50n },
    graph: structuredClone(GRAPH),
    graphId: new Uint8Array(32).fill(0xab),
    submitInvoked: false,
    attempts: 0,
    createdAt: NOW,
    updatedAt: NOW,
    expiresAt: NOW + 60,
    ...over,
});

/** Inserts directly so this works against the schema before claim_mode exists. */
function insertLegacyAdvance(db: Database, over: Record<string, unknown> = {}): void {
    const row: Record<string, unknown> = {
        id: "a1",
        state: "locked",
        receiver_key: new Uint8Array(32).fill(1),
        sender_key: new Uint8Array(32).fill(2),
        operator_key: new Uint8Array(32).fill(3),
        dust: 330n,
        topup: 300n,
        asset_txid: null,
        asset_group_index: null,
        asset_units: null,
        locktime: 850_000n,
        covenant_address: "tark1qcovenantexample",
        fare_currency: "sats",
        fare_units: 25n,
        fare_asset_txid: null,
        fare_asset_group_index: null,
        outpoint_txid: null,
        outpoint_vout: null,
        spent_txid: null,
        created_at: 1n,
        updated_at: 1n,
        expires_at: 2n,
        batch_expiry_kind: "height",
        batch_expiry_value: 900_000n,
        operator_inputs_json: JSON.stringify([{ txid: "aa".repeat(32), vout: 0 }]),
        unsigned_lockup_tx: "unsigned",
        unsigned_lockup_id: "bb".repeat(32),
        ...over,
    };
    const cols = Object.keys(row);
    db.prepare(
        `INSERT INTO advances (${cols.join(", ")}) VALUES (${cols.map((c) => "@" + c).join(", ")})`,
    ).run(row);
}

describe("swap-fill migration", () => {
    it("adds swap-fill storage as a new migration without touching prior ones", () => {
        expect(MIGRATIONS.map(({ id }) => id)).toEqual([1, 2, 3, 4, 5, 6]);
        const db = fresh();
        applyMigrations(db);
        expect(Number(db.pragma("user_version", { simple: true }))).toBe(6);
        const tables = db
            .prepare<[], { name: string }>("SELECT name FROM sqlite_master WHERE type = 'table'")
            .all();
        expect(tables.map((t) => t.name)).toEqual(
            expect.arrayContaining(["swap_fills", "swap_fill_reservations"]),
        );
        db.close();
    });

    it("keeps advances rows readable across the additive migration", () => {
        const db = fresh();
        applyMigrations(
            db,
            MIGRATIONS.filter((m) => m.id <= 2),
        );
        insertLegacyAdvance(db, {
            id: "a1",
            state: "locked",
        });
        applyMigrations(db);
        expect(new AdvanceRepository(db).get("a1")?.topup).toBe(300n);
        expect(new AdvanceRepository(db).get("a1")?.claimMode).toBeUndefined();
        db.close();
    });
});

describe("SwapFillRepository", () => {
    it("round-trips a quoted fill", () => {
        const db = fresh();
        applyMigrations(db);
        const repo = new SwapFillRepository(db);
        repo.insert(fill());
        expect(repo.get("fill-1")).toEqual(fill());
        expect(repo.getByOperation("op-1")?.id).toBe("fill-1");
        db.close();
    });

    it("rejects a reused operation id", () => {
        const db = fresh();
        applyMigrations(db);
        const repo = new SwapFillRepository(db);
        repo.insert(fill());
        expect(() => repo.insert(fill({ id: "fill-2" }))).toThrow(/UNIQUE|unique/i);
        db.close();
    });

    it("claims quoted fills exactly once under a lease", () => {
        const db = fresh();
        applyMigrations(db);
        const repo = new SwapFillRepository(db);
        repo.insert(fill());
        const claimed = repo.claimSubmit("fill-1", {
            leaseOwner: "w1",
            leaseToken: "t1",
            leaseUntil: NOW + 30,
            solverGraph: structuredClone(GRAPH),
            now: NOW,
        });
        expect(claimed.state).toBe("submitting");
        expect(claimed.solverGraph).toEqual(GRAPH);
        expect(() =>
            repo.claimSubmit("fill-1", {
                leaseOwner: "w2",
                leaseToken: "t2",
                leaseUntil: NOW + 30,
                solverGraph: structuredClone(GRAPH),
                now: NOW,
            }),
        ).toThrow(/invalid_state/);
        db.close();
    });

    it("returns Definitely-unsubmitted fills to quoted on signing failure", () => {
        const db = fresh();
        applyMigrations(db);
        const repo = new SwapFillRepository(db);
        repo.insert(fill());
        repo.claimSubmit("fill-1", {
            leaseOwner: "w1",
            leaseToken: "t1",
            leaseUntil: NOW + 30,
            solverGraph: structuredClone(GRAPH),
            now: NOW,
        });
        repo.recordSigningFailure("fill-1", "t1", "invalid_solver_signature", "bad sig", NOW);
        const back = repo.get("fill-1")!;
        expect(back.state).toBe("quoted");
        expect(back.failureCode).toBe("invalid_solver_signature");
        expect(repo.listReservedOutpoints()).toEqual([{ txid: "cc".repeat(32), vout: 0 }]);
        db.close();
    });

    it("persists prepared bytes before network effects and settles with proof", () => {
        const db = fresh();
        applyMigrations(db);
        const repo = new SwapFillRepository(db);
        repo.insert(fill());
        repo.claimSubmit("fill-1", {
            leaseOwner: "w1",
            leaseToken: "t1",
            leaseUntil: NOW + 30,
            solverGraph: structuredClone(GRAPH),
            now: NOW,
        });
        expect(repo.recordPrepared("fill-1", "t1", "cHJlcA==", ["Y2hr"], NOW + 1)).toBe(true);
        expect(repo.recordPrepared("fill-1", "stale-token", "eA==", [], NOW + 1)).toBe(false);
        const mid = repo.get("fill-1")!;
        expect(mid.preparedArkTx).toBe("cHJlcA==");
        expect(mid.preparedCheckpoints).toEqual(["Y2hr"]);
        repo.recordSubmitInvoked("fill-1", "t1", NOW + 2);
        const settled = repo.recordSettled(
            "fill-1",
            "t1",
            "dd".repeat(32),
            { txid: "dd".repeat(32), vout: 0 },
            NOW + 3,
        );
        expect(settled.state).toBe("settled");
        expect(settled.txid).toBe("dd".repeat(32));
        expect(repo.listReservedOutpoints()).toEqual([]);
        db.close();
    });

    it("keeps ambiguity reserved and surfaces reconcile candidates", () => {
        const db = fresh();
        applyMigrations(db);
        const repo = new SwapFillRepository(db);
        repo.insert(fill());
        repo.claimSubmit("fill-1", {
            leaseOwner: "w1",
            leaseToken: "t1",
            leaseUntil: NOW + 30,
            solverGraph: structuredClone(GRAPH),
            now: NOW,
        });
        repo.recordAmbiguous(
            "fill-1",
            "t1",
            "submit_ambiguous",
            "lost response",
            NOW + 120,
            NOW + 1,
        );
        const held = repo.get("fill-1")!;
        expect(held.state).toBe("submitting");
        expect(repo.listReservedOutpoints()).toHaveLength(1);
        expect(repo.reconcileCandidates(NOW + 119)).toEqual([]);
        expect(repo.reconcileCandidates(NOW + 120).map((f) => f.id)).toEqual(["fill-1"]);
        db.close();
    });

    it("expires quoted fills and releases their inputs", () => {
        const db = fresh();
        applyMigrations(db);
        const repo = new SwapFillRepository(db);
        repo.insert(fill());
        expect(repo.expireQuotes(NOW + 59)).toBe(0);
        expect(repo.expireQuotes(NOW + 60)).toBe(1);
        expect(repo.get("fill-1")?.state).toBe("expired");
        expect(repo.listReservedOutpoints()).toEqual([]);
        db.close();
    });

    it("marks the fill cancelled when the offer is spent elsewhere", () => {
        const db = fresh();
        applyMigrations(db);
        const repo = new SwapFillRepository(db);
        repo.insert(fill());
        repo.claimSubmit("fill-1", {
            leaseOwner: "w1",
            leaseToken: "t1",
            leaseUntil: NOW + 30,
            solverGraph: structuredClone(GRAPH),
            now: NOW,
        });
        repo.recordCancelled("fill-1", "ee".repeat(32), "offer_cancelled", NOW + 5);
        const done = repo.get("fill-1")!;
        expect(done.state).toBe("cancelled");
        expect(done.spentTxid).toBe("ee".repeat(32));
        expect(repo.listReservedOutpoints()).toEqual([]);
        db.close();
    });

    it("counts quoted and submitting contributions as exposure", () => {
        const db = fresh();
        applyMigrations(db);
        const repo = new SwapFillRepository(db);
        repo.insert(fill());
        repo.insert(
            fill({
                id: "fill-2",
                operationId: "op-2",
                contributionSats: 100n,
                taxiInputs: [{ txid: "cd".repeat(32), vout: 0 }],
            }),
        );
        expect(repo.exposureTotals()).toEqual({ outstandingSats: 430n, activeCount: 2 });
        db.close();
    });

    it("reconcileSettles an ambiguous fill without a lease and releases its inputs", () => {
        const db = fresh();
        applyMigrations(db);
        const repo = new SwapFillRepository(db);
        repo.insert(fill());
        repo.claimSubmit("fill-1", {
            leaseOwner: "w1",
            leaseToken: "t1",
            leaseUntil: NOW + 30,
            solverGraph: structuredClone(GRAPH),
            now: NOW,
        });
        repo.recordSubmitInvoked("fill-1", "t1", NOW + 1);
        repo.recordAmbiguous("fill-1", "t1", "submit_ambiguous", "lost", NOW + 120, NOW + 1);
        expect(
            repo.reconcileSettled(
                "fill-1",
                "dd".repeat(32),
                { txid: "dd".repeat(32), vout: 0 },
                NOW + 2,
            ),
        ).toBe(true);
        const done = repo.get("fill-1")!;
        expect(done.state).toBe("settled");
        expect(done.txid).toBe("dd".repeat(32));
        expect(done.outpoint).toEqual({ txid: "dd".repeat(32), vout: 0 });
        expect(repo.listReservedOutpoints()).toEqual([]);
        expect(
            repo.reconcileSettled(
                "fill-1",
                "dd".repeat(32),
                { txid: "dd".repeat(32), vout: 0 },
                NOW + 3,
            ),
        ).toBe(false);
        db.close();
    });

    it("reconcileSettled refuses a never-invoked fill", () => {
        const db = fresh();
        applyMigrations(db);
        const repo = new SwapFillRepository(db);
        repo.insert(fill());
        repo.claimSubmit("fill-1", {
            leaseOwner: "w1",
            leaseToken: "t1",
            leaseUntil: NOW + 30,
            solverGraph: structuredClone(GRAPH),
            now: NOW,
        });
        repo.recordAmbiguous("fill-1", "t1", "submit_ambiguous", "lost", NOW + 120, NOW + 1);
        expect(
            repo.reconcileSettled(
                "fill-1",
                "dd".repeat(32),
                { txid: "dd".repeat(32), vout: 0 },
                NOW + 120,
            ),
        ).toBe(false);
        expect(repo.get("fill-1")!.state).toBe("submitting");
        expect(repo.listReservedOutpoints()).toHaveLength(1);
        db.close();
    });

    it("reconcileCandidates skips a live lease and picks the row up after expiry", () => {
        const db = fresh();
        applyMigrations(db);
        const repo = new SwapFillRepository(db);
        repo.insert(fill());
        repo.claimSubmit("fill-1", {
            leaseOwner: "w1",
            leaseToken: "t1",
            leaseUntil: NOW + 30,
            solverGraph: structuredClone(GRAPH),
            now: NOW,
        });
        expect(repo.reconcileCandidates(NOW)).toEqual([]);
        expect(repo.reconcileCandidates(NOW + 29)).toEqual([]);
        expect(repo.reconcileCandidates(NOW + 30).map((f) => f.id)).toEqual(["fill-1"]);
        db.close();
    });

    it("reconcileRequeues a never-invoked fill to quoted while keeping its reservation", () => {
        const db = fresh();
        applyMigrations(db);
        const repo = new SwapFillRepository(db);
        repo.insert(fill());
        repo.claimSubmit("fill-1", {
            leaseOwner: "w1",
            leaseToken: "t1",
            leaseUntil: NOW + 30,
            solverGraph: structuredClone(GRAPH),
            now: NOW,
        });
        repo.recordPrepared("fill-1", "t1", "cHJlcA==", ["Y2hr"], NOW + 1);
        expect(
            repo.reconcileRequeue("fill-1", "never_invoked", "provider never ran", NOW + 2),
        ).toBe(true);
        const back = repo.get("fill-1")!;
        expect(back.state).toBe("quoted");
        expect(back.submitInvoked).toBe(false);
        expect(back.leaseToken).toBeUndefined();
        expect(repo.listReservedOutpoints()).toEqual([{ txid: "cc".repeat(32), vout: 0 }]);
        db.close();
    });

    it("reconcileRequeue refuses an invoked fill", () => {
        const db = fresh();
        applyMigrations(db);
        const repo = new SwapFillRepository(db);
        repo.insert(fill());
        repo.claimSubmit("fill-1", {
            leaseOwner: "w1",
            leaseToken: "t1",
            leaseUntil: NOW + 30,
            solverGraph: structuredClone(GRAPH),
            now: NOW,
        });
        repo.recordSubmitInvoked("fill-1", "t1", NOW + 1);
        expect(
            repo.reconcileRequeue("fill-1", "never_invoked", "provider never ran", NOW + 2),
        ).toBe(false);
        expect(repo.get("fill-1")!.state).toBe("submitting");
        db.close();
    });

    it("rejects rows that violate the state check", () => {
        const db = fresh();
        applyMigrations(db);
        expect(() =>
            db.prepare("UPDATE swap_fills SET state = 'locking' WHERE id = 'fill-1'").run(),
        ).not.toThrow();
        const repo = new SwapFillRepository(db);
        expect(() => repo.insert(fill({ state: "locking" as never }))).toThrow(
            /CHECK constraint failed/,
        );
        db.close();
    });

    it("round-trips the mirror-free graph and the sponsor script losslessly", () => {
        const db = fresh();
        applyMigrations(db);
        const repo = new SwapFillRepository(db);
        const genesis = new Uint8Array(32).fill(0xbe);
        const candidate = fill({
            solverInputs: [
                {
                    txid: "bb".repeat(32),
                    vout: 1,
                    value: 5000n,
                    assets: [{ assetId: { txid: genesis, groupIndex: 2 }, amount: 7n }],
                },
            ],
            sponsorScript: new Uint8Array([0x52, 0x53]),
        });
        repo.insert(candidate as unknown as SwapFill);
        const back = repo.get("fill-1")!;
        expect(back.graph).toEqual(candidate.graph);
        expect(back.graph.inputOwners).toEqual([null, "solver", "sponsor"]);
        expect(back.sponsorScript).toEqual(new Uint8Array([0x52, 0x53]));
        db.close();
    });
});
