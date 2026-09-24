import { describe, expect, it } from "vitest";
import DatabaseCtor from "better-sqlite3";
import type { Database } from "better-sqlite3";
import { ADVANCE_STATES, applyMigrations, MIGRATIONS } from "../src/schema.js";
import { AdvanceRepository } from "../src/advances.js";
import { ReceiveQuoteRepository } from "../src/receiveQuotes.js";

function fresh(): Database {
    const db = new DatabaseCtor(":memory:");
    db.defaultSafeIntegers(true);
    return db;
}

function migrated(): Database {
    const db = fresh();
    applyMigrations(db);
    return db;
}

function userVersion(db: Database): number {
    return Number(db.pragma("user_version", { simple: true }));
}

function tableNames(db: Database): string[] {
    return db
        .prepare<[], { name: string }>("SELECT name FROM sqlite_master WHERE type = 'table'")
        .all()
        .map((r) => r.name);
}

const RAW_ADVANCE = {
    id: "a1",
    state: "quoted",
    receiver_key: new Uint8Array(32).fill(1),
    sender_key: new Uint8Array(32).fill(2),
    operator_key: new Uint8Array(32).fill(3),
    dust: 330n,
    topup: 300n,
    asset_txid: null,
    asset_group_index: null,
    asset_units: null,
    locktime: 100n,
    covenant_address: "tark1qexample",
    fare_currency: "sats",
    fare_units: 10n,
    fare_asset_txid: null,
    fare_asset_group_index: null,
    outpoint_txid: null,
    outpoint_vout: null,
    spent_txid: null,
    created_at: 1n,
    updated_at: 1n,
    expires_at: 2n,
};

function insertRaw(db: Database, overrides: Record<string, unknown> = {}): void {
    const row = { ...RAW_ADVANCE, ...overrides };
    const cols = Object.keys(row);
    db.prepare(
        `INSERT INTO advances (${cols.join(", ")}) VALUES (${cols.map((c) => "@" + c).join(", ")})`,
    ).run(row);
}

// A single repeated byte, hex-encoded: matches every field's format check
// without pulling in the app package's covenant-key machinery.
const hex32 = (byte: number): string => byte.toString(16).padStart(2, "0").repeat(32);

const RAW_RECEIVE_QUOTE = {
    id: "q1",
    state: "expired",
    receiver_address: "tark1qreceiverexample",
    maker_public_key: hex32(2),
    params_json: JSON.stringify({
        receiverKey: hex32(1),
        senderKey: hex32(2),
        operatorKey: hex32(3),
        dust: "330",
        topup: "300",
        assetId: { txid: hex32(9), groupIndex: 0 },
        locktime: "899856",
        claimMode: "recycle",
        recoveryRecipient: "receiver",
    }),
    covenant_address: "tark1qcovenantexample",
    fare_json: JSON.stringify({ currency: "sats", units: "5" }),
    batch_expiry_kind: "height",
    batch_expiry_value: 900_000n,
    input_expiry_floor_kind: "height",
    input_expiry_floor_value: 900_000n,
    recovery_locktime_kind: "height",
    recovery_locktime_value: 899_856n,
    loan_sats: 300n,
    created_at: 1n,
    expires_at: 2n,
    policy_revision: 1n,
    operator_inputs_json: JSON.stringify([
        {
            txid: hex32(5),
            vout: 0,
            value: "1000",
            tapTree: hex32(6),
            spendLeaf: hex32(7),
            expiry: { kind: "height", value: "900000" },
        },
    ]),
    bound_fill_id: null,
};

function insertRawReceiveQuote(db: Database, overrides: Record<string, unknown> = {}): void {
    const row = { ...RAW_RECEIVE_QUOTE, ...overrides };
    const cols = Object.keys(row);
    db.prepare(
        `INSERT INTO receive_quotes (${cols.join(", ")}) VALUES (${cols.map((c) => "@" + c).join(", ")})`,
    ).run(row);
}

describe("migrations", () => {
    it.each([1, 2, 3, 4, 5, 6, 7, 8, 9, 10])(
        "rejects development schema v%s without modifying its schema or data",
        (version) => {
            const db = fresh();
            try {
                db.exec(`
                    CREATE TABLE advances (id TEXT PRIMARY KEY, topup INTEGER NOT NULL);
                    CREATE INDEX advances_topup ON advances (topup);
                    INSERT INTO advances VALUES ('legacy-payment', 9007199254740993);
                `);
                db.pragma(`user_version = ${version}`);
                const before = db.serialize();

                expect(() => applyMigrations(db)).toThrow(/incompatible.*recreate.*database/i);

                expect(db.serialize()).toEqual(before);
                expect(userVersion(db)).toBe(version);
                expect(db.prepare("SELECT * FROM advances").all()).toEqual([
                    { id: "legacy-payment", topup: 9007199254740993n },
                ]);
            } finally {
                db.close();
            }
        },
    );

    it("reopens the canonical database without changing its schema or data", () => {
        const first = migrated();
        insertRaw(first);
        const before = first.serialize();
        first.close();
        const reopened = new DatabaseCtor(before);
        reopened.defaultSafeIntegers(true);
        try {
            expect(() => applyMigrations(reopened)).not.toThrow();
            expect(reopened.serialize()).toEqual(before);
            expect(userVersion(reopened)).toBe(10);
            expect(
                reopened
                    .prepare(
                        "SELECT id, topup, asset_units, kind, claim_mode, recovery_recipient FROM advances",
                    )
                    .all(),
            ).toEqual([
                {
                    id: "a1",
                    topup: 300n,
                    asset_units: null,
                    kind: "covenant",
                    claim_mode: null,
                    recovery_recipient: null,
                },
            ]);
        } finally {
            reopened.close();
        }
    });

    it("adds proceeds storage without migrating unsupported development schemas", () => {
        expect(MIGRATIONS.map(({ id }) => id)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
        expect(MIGRATIONS[0]!.up).not.toMatch(/ALTER TABLE|advances_v2/i);
        const db = migrated();
        expect(userVersion(db)).toBe(10);
        expect(tableNames(db).sort()).toEqual([
            "advances",
            "operator_input_reservations",
            "policy",
            "policy_audit",
            "proceeds_inputs",
            "proceeds_jobs",
            "proceeds_local_intents",
            "receive_quote_reservations",
            "receive_quotes",
            "sqlite_sequence",
            "swap_fill_reservations",
            "swap_fills",
        ]);
        const columns = db
            .prepare<[], { name: string }>("PRAGMA table_info(advances)")
            .all()
            .map(({ name }) => name)
            .sort();
        expect(columns).toEqual(
            `
            id state kind receiver_key sender_key operator_key dust topup asset_txid asset_group_index
            asset_units claim_mode recovery_recipient locktime covenant_address fare_currency fare_units fare_asset_txid
            fare_asset_group_index outpoint_txid outpoint_vout spent_txid created_at updated_at expires_at
            batch_expiry_kind batch_expiry_value operator_inputs_json unsigned_lockup_tx unsigned_lockup_id
            submission_key ark_txid submitted_at recovery_txid recovery_submitted_at last_observed_at
            failure_code failure_detail signed_envelope_digest submission_phase signed_lockup_envelope
            prepared_ark_tx prepared_checkpoints_json server_final_ark_tx server_checkpoints_json
            submission_lease_owner submission_lease_until submission_attempts submission_last_attempt_at
            submission_next_attempt_at finalized_at submission_lease_token observation_tip_hash
            observation_tip_height observation_stable_tip_hash observation_stable_count observation_stable_tip_height
            recovery_locktime_kind recovery_phase recovery_graph_digest recovery_expected_txid
            recovery_prepared_ark_tx recovery_prepared_checkpoints_json recovery_response_ark_tx
            recovery_response_checkpoints_json recovery_lease_owner recovery_lease_token recovery_lease_until
            recovery_attempts recovery_last_attempt_at recovery_next_attempt_at
            receiver_fare_currency receiver_fare_units
        `
                .trim()
                .split(/\s+/)
                .sort(),
        );
        for (const [index, names] of [
            ["advances_state_locktime", ["state", "locktime"]],
            ["advances_state_batch_expiry", ["state", "batch_expiry_kind", "batch_expiry_value"]],
            ["advances_outpoint", ["outpoint_txid", "outpoint_vout"]],
            ["advances_receiver_updated", ["receiver_key", "updated_at", "id"]],
        ] as const) {
            expect(
                db
                    .prepare<[], { name: string }>(`PRAGMA index_info(${index})`)
                    .all()
                    .map(({ name }) => name),
            ).toEqual(names);
        }
        expect(
            db
                .prepare<[], { name: string; unique: bigint }>("PRAGMA index_list(advances)")
                .all()
                .find(({ name }) => name === "advances_outpoint")?.unique,
        ).toBe(1n);
    });
    it("migrates v1 covenant rows to kind covenant and accepts sponsored rows", () => {
        const db = fresh();
        applyMigrations(db, [MIGRATIONS[0]!]);
        expect(userVersion(db)).toBe(1);
        insertRaw(db);
        applyMigrations(db);
        expect(userVersion(db)).toBe(10);
        expect(
            db.prepare<[], { kind: string }>("SELECT kind FROM advances WHERE id = 'a1'").get(),
        ).toEqual({ kind: "covenant" });
        expect(
            db
                .prepare<[], { claim_mode: string | null }>(
                    "SELECT claim_mode FROM advances WHERE id = 'a1'",
                )
                .get(),
        ).toEqual({ claim_mode: null });
        expect(() => insertRaw(db, { id: "a2", kind: "sponsored" })).not.toThrow();
        expect(() => insertRaw(db, { id: "a3", kind: "escrow" })).toThrow(
            /CHECK constraint failed/,
        );
        expect(() => insertRaw(db, { id: "a4", claim_mode: "purchase" })).not.toThrow();
        expect(() => insertRaw(db, { id: "a5", claim_mode: "either" })).toThrow(
            /CHECK constraint failed/,
        );
        expect(() => insertRaw(db, { id: "a6", recovery_recipient: "receiver" })).not.toThrow();
        expect(() => insertRaw(db, { id: "a7", recovery_recipient: "seller" })).toThrow(
            /CHECK constraint failed/,
        );
        db.close();
    });
    it("migrates a v2 database forward preserving advances rows", () => {
        const db = fresh();
        applyMigrations(
            db,
            MIGRATIONS.filter((m) => m.id <= 2),
        );
        expect(userVersion(db)).toBe(2);
        insertRaw(db);
        applyMigrations(db);
        expect(userVersion(db)).toBe(10);
        expect(db.prepare("SELECT id, kind FROM advances").all()).toEqual([
            { id: "a1", kind: "covenant" },
        ]);
        db.close();
    });
    it("migrates a v3 database forward with a sponsor script column on swap fills", () => {
        const db = fresh();
        applyMigrations(
            db,
            MIGRATIONS.filter((m) => m.id <= 3),
        );
        expect(userVersion(db)).toBe(3);
        applyMigrations(db);
        expect(userVersion(db)).toBe(10);
        const columns = db
            .prepare<[], { name: string }>("PRAGMA table_info(swap_fills)")
            .all()
            .map(({ name }) => name);
        expect(columns).toContain("sponsor_script");
        db.close();
    });
    it("migrates a v4 database forward adding a nullable claim mode", () => {
        const db = fresh();
        applyMigrations(
            db,
            MIGRATIONS.filter((m) => m.id <= 4),
        );
        expect(userVersion(db)).toBe(4);
        insertRaw(db);
        applyMigrations(db);
        expect(userVersion(db)).toBe(10);
        expect(
            db
                .prepare<[], { claim_mode: string | null }>(
                    "SELECT claim_mode FROM advances WHERE id = 'a1'",
                )
                .get(),
        ).toEqual({ claim_mode: null });
        db.close();
    });
    it("migrates a v5 database forward adding a nullable recovery recipient", () => {
        const db = fresh();
        applyMigrations(
            db,
            MIGRATIONS.filter((m) => m.id <= 5),
        );
        expect(userVersion(db)).toBe(5);
        insertRaw(db);
        applyMigrations(db);
        expect(userVersion(db)).toBe(10);
        expect(
            db
                .prepare<[], { recovery_recipient: string | null }>(
                    "SELECT recovery_recipient FROM advances WHERE id = 'a1'",
                )
                .get(),
        ).toEqual({ recovery_recipient: null });
        db.close();
    });
    it("migrates a v8 database forward adding a nullable swap-fill deadline ceiling", () => {
        const db = fresh();
        applyMigrations(
            db,
            MIGRATIONS.filter((m) => m.id <= 8),
        );
        expect(userVersion(db)).toBe(8);
        applyMigrations(db);
        expect(userVersion(db)).toBe(10);
        expect(
            db
                .prepare<[], { name: string; notnull: bigint }>("PRAGMA table_info(swap_fills)")
                .all()
                .find(({ name }) => name === "valid_until"),
        ).toMatchObject({ notnull: 0n });
        db.close();
    });
    it("rejects a v9 stamp without the swap-fill deadline column", () => {
        const db = migrated();
        db.exec("ALTER TABLE swap_fills DROP COLUMN valid_until");
        const before = db.serialize();
        expect(() => applyMigrations(db)).toThrow(/incompatible.*recreate.*database/i);
        expect(db.serialize()).toEqual(before);
        db.close();
    });
    it("migrates a v9 database forward adding a nullable receiver fare, pre-migration rows unchanged", () => {
        const db = fresh();
        applyMigrations(
            db,
            MIGRATIONS.filter((m) => m.id <= 9),
        );
        expect(userVersion(db)).toBe(9);
        insertRaw(db, {
            batch_expiry_kind: "height",
            batch_expiry_value: 900_000n,
            operator_inputs_json: JSON.stringify([{ txid: hex32(8), vout: 0 }]),
            unsigned_lockup_tx: "unsigned",
            unsigned_lockup_id: hex32(4),
        });
        insertRawReceiveQuote(db);
        applyMigrations(db);
        expect(userVersion(db)).toBe(10);
        expect(
            db
                .prepare<
                    [],
                    { receiver_fare_currency: string | null; receiver_fare_units: string | null }
                >(
                    "SELECT receiver_fare_currency, receiver_fare_units FROM advances WHERE id = 'a1'",
                )
                .get(),
        ).toEqual({ receiver_fare_currency: null, receiver_fare_units: null });
        expect(db.prepare("SELECT topup FROM advances WHERE id = 'a1'").get()).toEqual({
            topup: 300n,
        });

        // The columns round-trip at the SQL layer above; these two also prove the
        // *repository* decode path — decodeRow's economics checks and the
        // payer/receiverFare pairing invariant — accepts a genuinely pre-migration row.
        // toStrictEqual against a complete object (every field, no receiverFare/payer):
        // toMatchObject would silently ignore an extra, missing or shifted field outside
        // the keys it's given.
        const advance = new AdvanceRepository(db).get("a1");
        expect(advance).toStrictEqual({
            id: "a1",
            state: "quoted",
            receiverKey: new Uint8Array(32).fill(1),
            senderKey: new Uint8Array(32).fill(2),
            operatorKey: new Uint8Array(32).fill(3),
            dust: 330n,
            topup: 300n,
            locktime: 100n,
            covenantAddress: "tark1qexample",
            fare: { currency: "sats", units: 10n },
            createdAt: 1,
            updatedAt: 1,
            expiresAt: 2,
            batchExpiry: { kind: "height", value: 900_000n },
            operatorInputs: [{ txid: hex32(8), vout: 0 }],
            unsignedLockupTx: "unsigned",
            unsignedLockupId: hex32(4),
        });

        const quote = new ReceiveQuoteRepository(db).get("q1");
        expect(quote).toStrictEqual({
            id: "q1",
            state: "expired",
            receiverAddress: "tark1qreceiverexample",
            makerPublicKey: hex32(2),
            params: {
                receiverKey: new Uint8Array(32).fill(1),
                senderKey: new Uint8Array(32).fill(2),
                operatorKey: new Uint8Array(32).fill(3),
                dust: 330n,
                topup: 300n,
                assetId: { txid: new Uint8Array(32).fill(9), groupIndex: 0 },
                locktime: 899_856n,
                claimMode: "recycle",
                recoveryRecipient: "receiver",
            },
            covenantAddress: "tark1qcovenantexample",
            fare: { currency: "sats", units: 5n },
            batchExpiry: { kind: "height", value: 900_000n },
            inputExpiryFloor: { kind: "height", value: 900_000n },
            recoveryLocktime: { kind: "height", value: 899_856n },
            loanSats: 300n,
            createdAt: 1,
            expiresAt: 2,
            policyRevision: 1n,
            operatorInputs: [
                {
                    txid: hex32(5),
                    vout: 0,
                    value: 1000n,
                    tapTree: new Uint8Array(32).fill(6),
                    spendLeaf: new Uint8Array(32).fill(7),
                    expiry: { kind: "height", value: 900_000n },
                },
            ],
        });
        db.close();
    });
    it("rejects a v10 stamp without the receiver-paid advances column", () => {
        const db = migrated();
        db.exec("ALTER TABLE advances DROP COLUMN receiver_fare_currency");
        const before = db.serialize();
        expect(() => applyMigrations(db)).toThrow(/incompatible.*recreate.*database/i);
        expect(db.serialize()).toEqual(before);
        db.close();
    });
    it("rejects old v1 without proceeds storage without changing its data", () => {
        const db = migrated();
        insertRaw(db);
        db.exec(
            "DROP TABLE proceeds_local_intents; DROP TABLE proceeds_inputs; DROP TABLE proceeds_jobs",
        );
        db.pragma("user_version = 1");
        const before = db.serialize();
        expect(() => applyMigrations(db)).toThrow(/incompatible.*recreate.*database/i);
        expect(db.serialize()).toEqual(before);
        db.close();
    });
    it("rejects old canonical v1 without Taxi-owned submission evidence without mutation", () => {
        const db = migrated();
        insertRaw(db);
        db.exec("DROP TABLE proceeds_local_intents");
        const before = db.serialize();
        expect(() => applyMigrations(db)).toThrow(/incompatible.*recreate.*database/i);
        expect(db.serialize()).toEqual(before);
        expect(userVersion(db)).toBe(10);
        db.close();
    });
    it("creates every table and stamps user_version with the highest applied id", () => {
        const db = migrated();

        expect(tableNames(db)).toEqual(
            expect.arrayContaining(["advances", "policy", "policy_audit"]),
        );
        expect(userVersion(db)).toBe(Math.max(...MIGRATIONS.map((m) => m.id)));
    });

    it("is idempotent and preserves existing rows on re-application", () => {
        const db = migrated();
        insertRaw(db);

        applyMigrations(db);
        applyMigrations(db);

        expect(db.prepare<[], { n: bigint }>("SELECT count(*) n FROM advances").get()?.n).toBe(1n);
        expect(userVersion(db)).toBe(Math.max(...MIGRATIONS.map((m) => m.id)));
    });

    it("applies pending migrations in id order regardless of array order", () => {
        const db = fresh();

        applyMigrations(db, [
            { id: 2, up: "INSERT INTO t (v) VALUES ('x')" },
            { id: 1, up: "CREATE TABLE t (v TEXT)" },
        ]);

        expect(db.prepare<[], { v: string }>("SELECT v FROM t").get()?.v).toBe("x");
        expect(userVersion(db)).toBe(2);
    });

    it("skips migrations at or below the current user_version", () => {
        const db = fresh();
        applyMigrations(db, [{ id: 1, up: "CREATE TABLE t (v TEXT)" }]);

        applyMigrations(db, [
            { id: 1, up: "SELECT raise_error_if_reapplied" },
            { id: 2, up: "CREATE TABLE u (v TEXT)" },
        ]);

        expect(tableNames(db)).toEqual(expect.arrayContaining(["t", "u"]));
        expect(userVersion(db)).toBe(2);
    });

    it("rolls the whole batch back when one migration fails", () => {
        const db = fresh();

        expect(() =>
            applyMigrations(db, [
                { id: 1, up: "CREATE TABLE t (v TEXT)" },
                { id: 2, up: "CREATE TABLE ((( syntax error" },
            ]),
        ).toThrow();

        expect(tableNames(db)).not.toContain("t");
        expect(userVersion(db)).toBe(0);
    });

    it("rejects duplicate or non-integer migration ids", () => {
        expect(() =>
            applyMigrations(fresh(), [
                { id: 1, up: "CREATE TABLE a (v TEXT)" },
                { id: 1, up: "CREATE TABLE b (v TEXT)" },
            ]),
        ).toThrow(/duplicate/i);
        expect(() =>
            applyMigrations(fresh(), [{ id: 1.5, up: "CREATE TABLE a (v TEXT)" }]),
        ).toThrow(/integer/i);
    });
});

describe("advances constraints", () => {
    it("requires asset identity and quantity together", () => {
        const db = migrated();
        const asset = { asset_txid: new Uint8Array(32).fill(9), asset_group_index: 0n };
        expect(() => insertRaw(db, asset)).toThrow(/CHECK constraint failed/);
        expect(() => insertRaw(db, { asset_units: 1n })).toThrow(/CHECK constraint failed/);
        expect(() => insertRaw(db, { ...asset, asset_units: 9007199254740993n })).not.toThrow();
    });
    it("accepts every AdvanceState", () => {
        const db = migrated();

        for (const [i, state] of ADVANCE_STATES.entries()) {
            expect(() => insertRaw(db, { id: `a${i}`, state })).not.toThrow();
        }
        expect(ADVANCE_STATES).toHaveLength(9);
    });

    it("rejects an unknown state", () => {
        const db = migrated();

        expect(() => insertRaw(db, { state: "settled" })).toThrow(/CHECK constraint failed/);
    });

    it("rejects a half-populated assetId", () => {
        const db = migrated();

        expect(() => insertRaw(db, { asset_txid: new Uint8Array(32).fill(9) })).toThrow(
            /CHECK constraint failed/,
        );
        expect(() => insertRaw(db, { asset_group_index: 0n })).toThrow(/CHECK constraint failed/);
    });

    it("rejects a half-populated outpoint", () => {
        const db = migrated();

        expect(() => insertRaw(db, { outpoint_txid: "ff".repeat(32) })).toThrow(
            /CHECK constraint failed/,
        );
        expect(() => insertRaw(db, { outpoint_vout: 0n })).toThrow(/CHECK constraint failed/);
    });

    it("refuses to bind one outpoint to two advances", () => {
        const db = migrated();
        const outpoint = { outpoint_txid: "aa".repeat(32), outpoint_vout: 1n };
        insertRaw(db, { id: "a1", ...outpoint });

        expect(() => insertRaw(db, { id: "a2", ...outpoint })).toThrow(/UNIQUE constraint failed/);
        expect(() => insertRaw(db, { id: "a3" })).not.toThrow();
    });
});

describe("policy constraints", () => {
    it("admits only the row with id = 1", () => {
        const db = migrated();
        const insert = (id: number) =>
            db
                .prepare(
                    `INSERT INTO policy (id, paused, max_outstanding_sats,
                     max_per_payment_topup_sats, max_concurrent_advances, locktime_margin_blocks,
                     asset_rules, quote_ttl_seconds)
                     VALUES (?, 0, 0, 0, 0, 0, '[]', 60)`,
                )
                .run(id);

        expect(() => insert(1)).not.toThrow();
        expect(() => insert(2)).toThrow(/CHECK constraint failed/);
    });
});
