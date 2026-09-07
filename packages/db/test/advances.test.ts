import { beforeEach, describe, expect, it } from "vitest";
import DatabaseCtor from "better-sqlite3";
import type { Database } from "better-sqlite3";
import type { Advance } from "@arkade-taxi/core";
import { applyMigrations } from "../src/schema.js";
import { AdvanceRepository } from "../src/advances.js";

const ABOVE_MAX_SAFE = 9_007_199_254_740_993n; // 2^53 + 1
const INT64_MAX = 9_223_372_036_854_775_807n;

function advance(overrides: Partial<Advance> = {}): Advance {
    return {
        id: "adv-1",
        state: "quoted",
        receiverKey: new Uint8Array(32).fill(0xa1),
        senderKey: new Uint8Array(32).fill(0xb2),
        operatorKey: new Uint8Array(32).fill(0xc3),
        dust: 330n,
        topup: 300n,
        locktime: 850_000n,
        covenantAddress: "tark1qcovenantexample",
        feeSats: 25n,
        createdAt: 1_757_000_000,
        updatedAt: 1_757_000_001,
        expiresAt: 1_757_000_600,
        ...overrides,
    };
}

let db: Database;
let repo: AdvanceRepository;

beforeEach(() => {
    db = new DatabaseCtor(":memory:");
    applyMigrations(db);
    repo = new AdvanceRepository(db);
});

describe("round-trip fidelity", () => {
    it("returns every field of a bitcoin-variant advance unchanged", () => {
        const a = advance({
            outpoint: { txid: "ab".repeat(32), vout: 3 },
            spentTxid: "cd".repeat(32),
        });

        repo.insert(a);

        expect(repo.get(a.id)).toEqual(a);
    });

    it("keeps sats and locktimes exact above Number.MAX_SAFE_INTEGER", () => {
        const a = advance({
            dust: ABOVE_MAX_SAFE,
            topup: ABOVE_MAX_SAFE - 1n,
            feeSats: INT64_MAX,
            locktime: ABOVE_MAX_SAFE + 2n,
        });

        repo.insert(a);
        const got = repo.get(a.id)!;

        expect(got.dust).toBe(ABOVE_MAX_SAFE);
        expect(got.topup).toBe(ABOVE_MAX_SAFE - 1n);
        expect(got.feeSats).toBe(INT64_MAX);
        expect(got.locktime).toBe(ABOVE_MAX_SAFE + 2n);
        expect(got.dust).not.toBe(got.topup);
        expect(Number(got.dust)).toBe(Number(got.topup));
    });

    it("stays exact on a Database that never enabled safeIntegers", () => {
        const plain = new DatabaseCtor(":memory:");
        applyMigrations(plain);
        const a = advance({ dust: ABOVE_MAX_SAFE });

        new AdvanceRepository(plain).insert(a);

        expect(new AdvanceRepository(plain).get(a.id)?.dust).toBe(ABOVE_MAX_SAFE);
    });

    it("returns keys byte-identical and not as pooled Buffer views", () => {
        const receiverKey = Uint8Array.from({ length: 32 }, (_, i) => i * 7);
        repo.insert(advance({ receiverKey }));

        const got = repo.get("adv-1")!;

        expect(Array.from(got.receiverKey)).toEqual(Array.from(receiverKey));
        expect(got.receiverKey).toEqual(receiverKey);
        expect(got.receiverKey.byteOffset).toBe(0);
        expect(got.receiverKey.buffer.byteLength).toBe(32);
    });

    it("reports a missing assetId as undefined, never null", () => {
        repo.insert(advance());

        const got = repo.get("adv-1")!;

        expect(got.assetId).toBeUndefined();
        expect(got.assetId).not.toBeNull();
        expect("spentTxid" in got && got.spentTxid !== undefined).toBe(false);
        expect(got.outpoint).toBeUndefined();
    });

    it("round-trips an asset-variant advance through two queryable columns", () => {
        const assetId = { txid: Uint8Array.from({ length: 32 }, (_, i) => 255 - i), groupIndex: 4 };
        repo.insert(advance({ assetId }));

        const got = repo.get("adv-1")!;

        expect(Array.from(got.assetId!.txid)).toEqual(Array.from(assetId.txid));
        expect(got.assetId!.groupIndex).toBe(4);
        expect(typeof got.assetId!.groupIndex).toBe("number");
        const byAsset = db
            .prepare<[number], { id: string }>(
                "SELECT id FROM advances WHERE asset_group_index = ?",
            )
            .get(4);
        expect(byAsset?.id).toBe("adv-1");
    });

    it("returns timestamps and vout as numbers, not bigints", () => {
        repo.insert(advance({ outpoint: { txid: "ef".repeat(32), vout: 2 } }));

        const got = repo.get("adv-1")!;

        expect(typeof got.createdAt).toBe("number");
        expect(typeof got.updatedAt).toBe("number");
        expect(typeof got.expiresAt).toBe("number");
        expect(typeof got.outpoint!.vout).toBe("number");
    });

    it("returns undefined for an unknown id and refuses a duplicate insert", () => {
        repo.insert(advance());

        expect(repo.get("nope")).toBeUndefined();
        expect(() => repo.insert(advance())).toThrow(/UNIQUE constraint failed/);
    });
});

describe("queries", () => {
    it("selects by state", () => {
        repo.insert(advance({ id: "q1", state: "quoted" }));
        repo.insert(advance({ id: "l1", state: "locked" }));
        repo.insert(advance({ id: "l2", state: "locked" }));

        expect(
            repo
                .byState("locked")
                .map((a) => a.id)
                .sort(),
        ).toEqual(["l1", "l2"]);
        expect(repo.byState("expired")).toEqual([]);
    });

    it("selects by outpoint", () => {
        const outpoint = { txid: "11".repeat(32), vout: 7 };
        repo.insert(advance({ id: "o1", outpoint }));
        repo.insert(advance({ id: "o2", outpoint: { txid: "22".repeat(32), vout: 7 } }));

        expect(repo.byOutpoint(outpoint)?.id).toBe("o1");
        expect(repo.byOutpoint({ txid: outpoint.txid, vout: 8 })).toBeUndefined();
        expect(repo.byOutpoint({ txid: "33".repeat(32), vout: 7 })).toBeUndefined();
    });

    it("lists sweepable advances oldest locktime first, matured only", () => {
        repo.insert(advance({ id: "late", state: "locked", locktime: 900n }));
        repo.insert(advance({ id: "early", state: "locked", locktime: 700n }));
        repo.insert(advance({ id: "due", state: "locked", locktime: 800n }));
        repo.insert(advance({ id: "unlocked", state: "quoted", locktime: 700n }));

        expect(repo.listSweepable(800n).map((a) => a.id)).toEqual(["early", "due"]);
        expect(repo.listSweepable(699n)).toEqual([]);
    });

    it("compares locktimes above 2^53 without collapsing them", () => {
        repo.insert(advance({ id: "under", state: "locked", locktime: ABOVE_MAX_SAFE }));
        repo.insert(advance({ id: "over", state: "locked", locktime: ABOVE_MAX_SAFE + 1n }));

        expect(repo.listSweepable(ABOVE_MAX_SAFE).map((a) => a.id)).toEqual(["under"]);
    });

    it("sums topup per state exactly, and returns 0n for an empty state", () => {
        repo.insert(advance({ id: "s1", state: "locked", topup: ABOVE_MAX_SAFE }));
        repo.insert(advance({ id: "s2", state: "locked", topup: ABOVE_MAX_SAFE }));
        repo.insert(advance({ id: "s3", state: "quoted", topup: 5n }));

        expect(repo.sumTopupByState("locked")).toBe(ABOVE_MAX_SAFE * 2n);
        expect(repo.sumTopupByState("quoted")).toBe(5n);
        expect(repo.sumTopupByState("refunded")).toBe(0n);
    });
});

describe("update", () => {
    it("overwrites every mutable field", () => {
        repo.insert(advance());
        const moved: Advance = {
            ...advance(),
            state: "locked",
            outpoint: { txid: "99".repeat(32), vout: 1 },
            spentTxid: "88".repeat(32),
            topup: ABOVE_MAX_SAFE,
            updatedAt: 1_757_000_900,
        };

        repo.update(moved);

        expect(repo.get("adv-1")).toEqual(moved);
    });

    it("clears optional fields back to undefined", () => {
        repo.insert(
            advance({
                outpoint: { txid: "99".repeat(32), vout: 1 },
                spentTxid: "88".repeat(32),
                assetId: { txid: new Uint8Array(32).fill(1), groupIndex: 2 },
            }),
        );

        repo.update(advance());

        const got = repo.get("adv-1")!;
        expect(got.outpoint).toBeUndefined();
        expect(got.spentTxid).toBeUndefined();
        expect(got.assetId).toBeUndefined();
    });

    it("refuses to silently no-op on an unknown id", () => {
        expect(() => repo.update(advance({ id: "ghost" }))).toThrow(/ghost/);
    });
});
