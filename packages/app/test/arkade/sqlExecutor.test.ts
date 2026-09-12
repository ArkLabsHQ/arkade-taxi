import { afterEach, describe, expect, it } from "vitest";
import {
    openDatabase,
    PolicyRepository,
    AdvanceRepository,
    ReservationRepository,
    type Database,
} from "@arkade-taxi/db";
import { SQLiteIntentRepository } from "@arkade-os/sdk/repositories/sqlite";
import { CSVMultisigTapscript, VtxoScript, type ExtendedVirtualCoin } from "@arkade-os/sdk";
import { bytesToHex } from "@arkade-taxi/protocol";
import { serverKey, advance } from "../fixtures.js";
import { createSqlExecutor, createOperatorStorage } from "../../src/arkade/sqlExecutor.js";

const databases: Database[] = [];
const open = () => {
    const db = openDatabase(":memory:");
    databases.push(db);
    return db;
};
afterEach(() => databases.forEach((db) => db.close()));

describe("SQLite SDK boundary", () => {
    it.each(["rollback", "commit"])(
        "blocks every native entry while a real SDK %s is pending",
        async (outcome) => {
            const db = open();
            const policy = new PolicyRepository(db);
            const advances = new AdvanceRepository(db);
            const reservations = new ReservationRepository(db);
            const a = advance();
            advances.insert(a);
            const sql = createSqlExecutor(db);
            let entered!: () => void;
            const entry = new Promise<void>((resolve) => {
                entered = resolve;
            });
            let release!: () => void;
            const paused = new Promise<void>((resolve) => {
                release = resolve;
            });
            const repository = new SQLiteIntentRepository(
                {
                    ...sql,
                    async run(statement, params) {
                        await sql.run(statement, params);
                        if (statement.startsWith("DELETE FROM")) {
                            await sql.run("UPDATE policy SET paused = 0 WHERE id = 1");
                            entered();
                            await paused;
                            if (outcome === "rollback") throw new Error("injected SDK failure");
                        }
                    },
                },
                { prefix: "taxi_test_" },
            );
            const transaction = repository.clear();
            const settled = transaction.catch((error: unknown) => error);
            await entry;
            const calls = [
                () => policy.get(),
                () => policy.getSnapshot(),
                () => policy.history(10),
                () => policy.update({ maxOutstandingSats: 777n }, "test"),
                () => advances.insert(advance({ id: "concurrent" })),
                () => advances.get(a.id),
                () => advances.byState("locked"),
                () => advances.byOutpoint({ txid: "aa".repeat(32), vout: 0 }),
                () => advances.listMissingFundingSnapshotIds(),
                () => advances.sumTopupByState("locked"),
                () => advances.listSweepable(999999n),
                () => advances.update(a),
                () => advances.recordLockupSubmission(a.id, "aa".repeat(32), 1),
                () => advances.recordLockupFailure(a.id, "test", "test", 1),
                () => advances.recordRecoverySubmission(a.id, "tx", 1),
                () => advances.claimRecovery(a.id, 1),
                () => reservations.listReservedOutpoints(),
                () => reservations.listForAdvance(a.id),
                () =>
                    reservations.reserveQuote({
                        advance: a,
                        expectedPolicyRevision: 0n,
                        recoveryExecutionBudget: { kind: "height", value: 1n },
                    }),
                () => reservations.releaseForAdvance(a.id),
                () => new PolicyRepository(db),
                () => new AdvanceRepository(db),
                () => new ReservationRepository(db),
            ];
            try {
                for (const call of calls)
                    expect(call).toThrowError(
                        expect.objectContaining({ code: "database_busy", retryable: true }),
                    );
            } finally {
                release();
                await settled;
            }
            if (outcome === "rollback")
                await expect(transaction).rejects.toThrow("injected SDK failure");
            else await expect(transaction).resolves.toBeUndefined();
            expect(policy.get().paused).toBe(outcome === "rollback");
            expect(policy.get().maxOutstandingSats).toBe(0n);
            expect(advances.get("concurrent")).toBeUndefined();
            expect(advances.get(a.id)).toEqual(a);
            expect(policy.update({ maxOutstandingSats: 888n }, "test").maxOutstandingSats).toBe(
                888n,
            );
            db.transaction(() => policy.update({ maxOutstandingSats: 999n }, "nested"))();
            expect(policy.get().maxOutstandingSats).toBe(999n);
        },
    );
    it("retains canonical height expiry and unspent flags across repository reopen", async () => {
        const db = open();
        const leaf = CSVMultisigTapscript.encode({
            pubkeys: [serverKey],
            timelock: { type: "blocks", value: 5n },
        });
        const tree = new VtxoScript([leaf.script]);
        const address = tree.address("tark", serverKey);
        const coin: ExtendedVirtualCoin = {
            txid: "aa".repeat(32),
            vout: 0,
            value: 12345,
            status: { confirmed: false },
            createdAt: new Date(1700000000000),
            script: bytesToHex(address.pkScript),
            isUnrolled: false,
            isSpent: false,
            isSwept: false,
            isPreconfirmed: true,
            expiresAtHeight: 999,
            virtualStatus: { state: "preconfirmed", batchExpiry: 999000 },
            tapTree: tree.encode(),
            forfeitTapLeafScript: tree.findLeaf(bytesToHex(leaf.script)),
            intentTapLeafScript: tree.findLeaf(bytesToHex(leaf.script)),
        };
        await createOperatorStorage(db).walletRepository.saveVtxos(address.encode(), [coin]);
        const saved = await createOperatorStorage(db).walletRepository.getVtxos(address.encode());
        expect(saved[0]).toMatchObject({
            value: 12345,
            vout: 0,
            expiresAtHeight: 999,
            isSpent: false,
            isUnrolled: false,
        });
        expect(saved[0].expiresAt).toBeUndefined();
    });
    it("returns void, preserves large bigint values, and rejects constraints asynchronously", async () => {
        const sql = createSqlExecutor(open());
        await sql.run("CREATE TABLE sample (id INTEGER PRIMARY KEY, amount INTEGER NOT NULL)");
        await expect(
            sql.run("INSERT INTO sample VALUES (?, ?)", [1, 9007199254740993n]),
        ).resolves.toBeUndefined();
        expect(await sql.get("SELECT * FROM sample")).toEqual({ id: 1, amount: 9007199254740993n });
        expect(await sql.all("SELECT amount FROM sample")).toEqual([{ amount: 9007199254740993n }]);
        expect(await sql.get("SELECT * FROM sample WHERE id = 2")).toBeUndefined();
        await expect(sql.run("INSERT INTO sample VALUES (1, 2)")).rejects.toThrow(/UNIQUE/);
    });

    it("keeps Taxi bigint mode while returning SDK numeric flags and sharing transactions", async () => {
        const db = open();
        const sql = createSqlExecutor(db);
        expect(createSqlExecutor(db)).toBe(sql);
        await sql.run("CREATE TABLE sample (value INTEGER NOT NULL)");
        expect((await sql.all<{ notnull: number }>("PRAGMA table_info(sample)"))[0].notnull).toBe(
            1,
        );
        expect(db.prepare("SELECT 1 AS n").get()).toEqual({ n: 1n });
    });

    it("opens all four prefixed repositories repeatedly without owning the connection", async () => {
        const db = open();
        for (let i = 0; i < 2; i++) {
            const storage = createOperatorStorage(db);
            await storage.walletRepository.getWalletState();
            await storage.contractRepository.getContracts();
            await storage.intentRepository.getIntents();
            await storage.virtualTxRepository.getVirtualTx("aa".repeat(32));
            await storage.walletRepository[Symbol.asyncDispose]();
        }
        expect(db.open).toBe(true);
        const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as {
            name: string;
        }[];
        expect(tables.map((t) => t.name)).toEqual(
            expect.arrayContaining(["taxi_sdk_vtxos", "taxi_sdk_contracts", "advances"]),
        );
        expect(() => createOperatorStorage(db, "1_bad;")).toThrow();
    });
});
