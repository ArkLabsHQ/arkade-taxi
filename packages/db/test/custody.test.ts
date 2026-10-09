import { beforeEach, describe, expect, it } from "vitest";
import DatabaseCtor from "better-sqlite3";
import type { Database } from "better-sqlite3";
import type { Advance } from "@arkade-taxi/core";
import { applyMigrations } from "../src/schema.js";
import { AdvanceRepository } from "../src/advances.js";
import { PolicyRepository } from "../src/policy.js";
import {
    CustodyError,
    CustodyReleaseInputConflictError,
    CustodyRepository,
    CustodySweptError,
} from "../src/custody.js";

const WINDOW = 8_640_000;
const INT64_MAX = 9_223_372_036_854_775_807n;
const RECLAIM = "12".repeat(32);
const TIP = { hash: "34".repeat(32), height: 700_000 };
const HELD_AT = 1_757_001_000;
const DUE = HELD_AT + WINDOW;
const GRAPH = "ab".repeat(32);
const COIN_A = { txid: "a1".repeat(32), vout: 0 };
const COIN_B = { txid: "b2".repeat(32), vout: 3 };
const ASSET = { txid: new Uint8Array(32).fill(9), groupIndex: 0 };

const V2_DEADLINE = 1_757_000_000n + 8_640_000n;

function advance(overrides: Partial<Advance> = {}): Advance {
    const result: Advance = {
        id: "adv-1",
        state: "locked",
        receiverKey: new Uint8Array(32).fill(0xa1),
        senderKey: new Uint8Array(32).fill(0xb2),
        operatorKey: new Uint8Array(32).fill(0xc3),
        operatorSignerKey: new Uint8Array(32).fill(0xd4),
        exitDelay: { value: 5n, type: "blocks" },
        dust: 330n,
        topup: 330n,
        locktime: V2_DEADLINE,
        operatorInputs: [{ txid: "ab".repeat(32), vout: 7 }],
        unsignedLockupTx: "unsigned-lockup",
        unsignedLockupId: "cd".repeat(32),
        covenantAddress: "tark1qcovenantexample",
        fare: { currency: "sats", units: 25n },
        outpoint: { txid: "ef".repeat(32), vout: 0 },
        createdAt: 1_757_000_000,
        updatedAt: 1_757_000_001,
        expiresAt: 1_757_000_600,
        ...overrides,
    };
    // A covenant advance keeps no batch expiry and its CLTV is wall-clock.
    result.recoveryLocktime ??= {
        kind: result.batchExpiry?.kind ?? "time",
        value: result.locktime,
    };
    return result;
}

const v2 = (overrides: Partial<Advance> = {}): Advance =>
    advance({
        paymentSats: 1_000n,
        assetId: ASSET,
        assetUnits: 7n,
        receiverFare: { currency: "asset", units: 2n },
        recoveryRecipient: "receiver",
        ...overrides,
    });

/** The sender-paid transfer rail: no receiver fare, so no receiver-owned recovery. */
const senderPaid = (overrides: Partial<Advance> = {}): Advance =>
    advance({ id: "sender-paid", paymentSats: 1_000n, ...overrides });

let db: Database;
let advances: AdvanceRepository;
let custody: CustodyRepository;

function reclaim(row: Advance = v2(), at = HELD_AT): void {
    advances.insert(row);
    expect(advances.recordSpendObservation(row.id, "locked", "recovered", RECLAIM, at, TIP)).toBe(
        "recorded",
    );
}

const claim = (token = "tok-1", at = 1_757_002_000) =>
    custody.claimRelease("adv-1", "worker-1", token, at, at + 60);

const bind = (token = "tok-1", inputs = [COIN_A], graph = GRAPH) =>
    custody.bindReleaseInputs("adv-1", "worker-1", token, inputs, graph, 1_757_002_001);

beforeEach(() => {
    db = new DatabaseCtor(":memory:");
    db.defaultSafeIntegers(true);
    applyMigrations(db);
    advances = new AdvanceRepository(db, { custodyWindowSeconds: WINDOW });
    custody = new CustodyRepository(db);
});

describe("a reclaim opens the liability", () => {
    it("records what is owed, not a coin", () => {
        reclaim();
        expect(custody.get("adv-1")).toEqual({
            advanceId: "adv-1",
            ownerKey: new Uint8Array(32).fill(0xa1),
            assetId: ASSET,
            assetUnits: 7n,
            // The reclaim repaid the loaned dust; the payer's sats are the debt.
            owedSats: 1_000n,
            loanSats: 330n,
            fare: { currency: "asset", units: 2n },
            state: "held",
            heldAt: HELD_AT,
            expiresAt: DUE,
            releaseInputs: [],
        });
    });

    // The covenant pays a reclaim to the recovery owner, so the ledger has to owe
    // it to the same party. On the sender-paid rail that is the payer, whose sats
    // these are; naming the payee would credit someone who never paid.
    it("owes a reclaimed sender-paid payment to the payer, not the payee", () => {
        reclaim(senderPaid());
        expect(custody.get("sender-paid")).toMatchObject({
            ownerKey: new Uint8Array(32).fill(0xb2),
            owedSats: 1_000n,
        });
    });

    it("still owes a receiver-owned recovery to the receiver", () => {
        reclaim();
        expect(custody.get("adv-1")?.ownerKey).toEqual(new Uint8Array(32).fill(0xa1));
    });

    it("owes nothing in sats for a dust-unit covenant", () => {
        reclaim(v2({ id: "unit", paymentSats: undefined }));
        expect(custody.get("unit")?.owedSats).toBe(0n);
    });

    it("opens no row for a claim, only for a reclaim", () => {
        advances.insert(v2({ id: "claimed", outpoint: { txid: "ef".repeat(32), vout: 1 } }));
        advances.recordSpendObservation("claimed", "locked", "recycled", RECLAIM, 500, TIP);
        expect(custody.get("claimed")).toBeUndefined();
        expect(custody.liabilities()).toEqual({ owedSats: 0n, assets: [], rows: 0 });
    });

    it("refuses the reclaim rather than lose the debt when no window is configured", () => {
        const unwired = new AdvanceRepository(db);
        unwired.insert(v2({ id: "unwired" }));
        expect(() =>
            unwired.recordSpendObservation("unwired", "locked", "recovered", RECLAIM, 500, TIP),
        ).toThrow(/custody_window_unconfigured/);
        expect(unwired.get("unwired")?.state).toBe("locked");
    });

    it("leaves one row when the same reclaim is replayed", () => {
        reclaim();
        expect(
            advances.recordSpendObservation("adv-1", "locked", "recovered", RECLAIM, HELD_AT, TIP),
        ).toBe("duplicate");
        expect(db.prepare<[], { n: bigint }>("SELECT count(*) AS n FROM custody").get()).toEqual({
            n: 1n,
        });
    });
});

describe("liabilities", () => {
    it("totals sats in one figure and units per asset id", () => {
        reclaim();
        reclaim(
            v2({
                id: "adv-2",
                paymentSats: 500n,
                assetUnits: 3n,
                outpoint: { txid: "ef".repeat(32), vout: 1 },
            }),
        );
        reclaim(
            v2({
                id: "adv-3",
                paymentSats: 100n,
                assetId: { txid: new Uint8Array(32).fill(8), groupIndex: 1 },
                assetUnits: 4n,
                outpoint: { txid: "ef".repeat(32), vout: 2 },
            }),
        );
        expect(custody.liabilities()).toEqual({
            owedSats: 1_600n,
            assets: [
                { assetId: { txid: new Uint8Array(32).fill(8), groupIndex: 1 }, units: 4n },
                { assetId: ASSET, units: 10n },
            ],
            rows: 3,
        });
    });

    it("drops a released or written-off row from the totals", () => {
        reclaim();
        claim();
        bind();
        custody.recordReleased("adv-1", "worker-1", "tok-1", GRAPH, 1_757_002_010);
        expect(custody.liabilities()).toEqual({ owedSats: 0n, assets: [], rows: 0 });

        reclaim(v2({ id: "adv-2", outpoint: { txid: "ef".repeat(32), vout: 1 } }));
        custody.writeOff("adv-2", "operator", DUE);
        expect(custody.liabilities()).toEqual({ owedSats: 0n, assets: [], rows: 0 });
    });
});

describe("release", () => {
    it("refuses a second release through the compare-and-set", () => {
        reclaim();
        expect(claim().state).toBe("releasing");
        expect(() => claim("tok-2")).toThrow(CustodyError);
        expect(() => claim("tok-2")).toThrow(/custody_release_in_progress/);
    });

    it("binds the coins the graph spends, and only against the lease", () => {
        reclaim();
        claim();
        expect(bind("tok-9")).toBe(false);
        expect(bind("tok-1", [COIN_A, COIN_B])).toBe(true);
        expect(custody.get("adv-1")).toMatchObject({
            releaseExpectedTxid: GRAPH,
            releaseInputs: [COIN_A, COIN_B],
        });
        expect(custody.listHeldOutpoints()).toEqual([COIN_A, COIN_B]);
    });

    it("refuses to bind a coin another release already holds", () => {
        reclaim();
        reclaim(v2({ id: "adv-2", outpoint: { txid: "ef".repeat(32), vout: 1 } }));
        claim();
        bind();
        custody.claimRelease("adv-2", "worker-2", "tok-2", 1_757_002_000, 1_757_002_060);
        expect(() =>
            custody.bindReleaseInputs(
                "adv-2",
                "worker-2",
                "tok-2",
                [COIN_A],
                "cd".repeat(32),
                1_757_002_002,
            ),
        ).toThrow(CustodyReleaseInputConflictError);
    });

    it("pays out only against the lease and the graph the owner signed", () => {
        reclaim();
        claim();
        bind();
        expect(custody.recordReleased("adv-1", "worker-2", "tok-1", GRAPH, 1)).toBe(false);
        expect(custody.recordReleased("adv-1", "worker-1", "tok-9", GRAPH, 1)).toBe(false);
        expect(custody.recordReleased("adv-1", "worker-1", "tok-1", "cd".repeat(32), 1)).toBe(
            false,
        );
        expect(custody.get("adv-1")?.state).toBe("releasing");
        expect(custody.recordReleased("adv-1", "worker-1", "tok-1", GRAPH, 1_757_002_010)).toBe(
            true,
        );
        expect(custody.get("adv-1")).toMatchObject({
            state: "released",
            releaseTxid: GRAPH,
            releasedAt: 1_757_002_010,
            releaseInputs: [],
        });
        expect(custody.listHeldOutpoints()).toEqual([]);
    });

    it("returns the row to held and frees its coins when abandoned", () => {
        reclaim();
        claim();
        bind();
        custody.abandonRelease("adv-1", "worker-1", "tok-1", 1_757_002_005);
        expect(custody.get("adv-1")?.state).toBe("held");
        expect(custody.listHeldOutpoints()).toEqual([]);
        expect(claim("tok-3").state).toBe("releasing");
    });

    it("releases a row past its window that has not been written off", () => {
        reclaim();
        const after = DUE + 1;
        expect(custody.claimRelease("adv-1", "w", "t", after, after + 60).state).toBe("releasing");
        expect(custody.bindReleaseInputs("adv-1", "w", "t", [COIN_A], GRAPH, after)).toBe(true);
        expect(custody.recordReleased("adv-1", "w", "t", GRAPH, after)).toBe(true);
    });

    it("refuses a release after a write-off, naming the actor and the time", () => {
        reclaim();
        custody.writeOff("adv-1", "ops@example", DUE);
        let thrown: unknown;
        try {
            custody.claimRelease("adv-1", "w", "t", DUE + 1, DUE + 61);
        } catch (error) {
            thrown = error;
        }
        expect(thrown).toBeInstanceOf(CustodySweptError);
        expect(thrown).toMatchObject({ code: "custody_swept", actor: "ops@example", at: DUE });
    });

    it("refuses a release for an advance with no row", () => {
        expect(() => claim()).toThrow(/custody_not_found/);
    });
});

describe("the write-off is the only thing that forfeits", () => {
    it("throws inside the window and forfeits at or after it", () => {
        reclaim();
        expect(() => custody.writeOff("adv-1", "operator", DUE - 1)).toThrow(/custody_window_open/);
        expect(custody.get("adv-1")?.state).toBe("held");
        custody.writeOff("adv-1", "operator", DUE);
        expect(custody.get("adv-1")).toMatchObject({
            state: "forfeit",
            sweptActor: "operator",
            sweptAt: DUE,
        });
    });

    it("appends the actor to the operator audit trail", () => {
        reclaim();
        custody.writeOff("adv-1", "ops@example", DUE);
        expect(
            new PolicyRepository(db)
                .history(10)
                .filter((row) => row.field === "operation")
                .map(({ newValue, actor }) => ({ newValue, actor })),
        ).toEqual([{ newValue: "custody-write-off", actor: "ops@example" }]);
    });

    it("requires an actor", () => {
        reclaim();
        expect(() => custody.writeOff("adv-1", "  ", DUE)).toThrow(/must name its actor/);
    });

    it("refuses to write off a row mid-release or already released", () => {
        reclaim();
        claim();
        expect(() => custody.writeOff("adv-1", "operator", DUE)).toThrow(
            /custody_release_in_progress/,
        );
        bind();
        custody.recordReleased("adv-1", "worker-1", "tok-1", GRAPH, 1_757_002_010);
        expect(() => custody.writeOff("adv-1", "operator", DUE)).toThrow(/custody_released/);
    });

    it("never forfeits by the clock alone", () => {
        reclaim();
        expect(custody.nearingWindow(DUE + 86_400, 0)).toHaveLength(1);
        expect(custody.get("adv-1")?.state).toBe("held");
    });
});

describe("segregation", () => {
    it("binds no coin while held, so inventory stays renewable", () => {
        reclaim();
        expect(custody.listHeldOutpoints()).toEqual([]);
        expect(custody.listActive()).toHaveLength(1);
    });

    it("hands only an in-flight release to the settlement guard", () => {
        reclaim();
        claim();
        bind();
        expect(custody.listHeldOutpoints()).toEqual([COIN_A]);
    });
});

describe("discovery and alarms", () => {
    it("lists rows by owner", () => {
        reclaim();
        expect(custody.byOwner(new Uint8Array(32).fill(0xa1))).toHaveLength(1);
        expect(custody.byOwner(new Uint8Array(32).fill(0xff))).toEqual([]);
    });

    it("lists the rows nearing their window and nothing else", () => {
        reclaim();
        expect(custody.nearingWindow(DUE - 86_401, 86_400)).toEqual([]);
        expect(custody.nearingWindow(DUE - 86_400, 86_400)).toHaveLength(1);
    });

    // The restart path: a second process reads the lease back and finishes it.
    it("exposes the lease so another process can complete a release", () => {
        reclaim();
        claim();
        bind();
        const reopened = new CustodyRepository(db).get("adv-1")!;
        expect(reopened.releaseLease).toEqual({
            owner: "worker-1",
            token: "tok-1",
            until: 1_757_002_060,
        });
        expect(reopened.releaseExpectedTxid).toBe(GRAPH);
        expect(
            new CustodyRepository(db).recordReleased(
                "adv-1",
                reopened.releaseLease!.owner,
                reopened.releaseLease!.token,
                GRAPH,
                1_757_002_010,
            ),
        ).toBe(true);
    });
});
