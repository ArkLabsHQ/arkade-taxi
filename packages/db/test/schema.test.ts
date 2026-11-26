import { afterEach, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import DatabaseCtor from "better-sqlite3";
import type { Database } from "better-sqlite3";
import { ADVANCE_STATES, initializeSchema } from "../src/schema";

const handles = new Set<Database>();
afterEach(() => {
    for (const db of handles) if (db.open) db.close();
    handles.clear();
});
function fresh(): Database {
    const db = new DatabaseCtor(":memory:");
    db.defaultSafeIntegers(true);
    handles.add(db);
    return db;
}
function initialized(): Database {
    const db = fresh();
    initializeSchema(db);
    return db;
}
function userVersion(db: Database): number {
    return Number(db.pragma("user_version", { simple: true }));
}
function tableNames(db: Database): string[] {
    return db
        .prepare<[], { name: string }>("SELECT name FROM sqlite_master WHERE type = 'table'")
        .all()
        .map(({ name }) => name);
}
function columnNames(db: Database, table: string): string[] {
    return db
        .prepare<[string], { name: string }>("SELECT name FROM pragma_table_info(?)")
        .all(table)
        .map(({ name }) => name);
}

function schemaDigest(db: Database): string {
    const entries = db
        .prepare<[], { type: string; name: string; tbl_name: string; sql: string }>(
            "SELECT type, name, tbl_name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name",
        )
        .all()
        .map((row) => ({ ...row, sql: row.sql.replace(/\s+/g, " ").trim() }));
    const tables = entries
        .filter(({ type }) => type === "table")
        .map(({ name }) => ({
            name,
            columns: db.prepare("SELECT * FROM pragma_table_xinfo(?)").all(name),
            indexes: db
                .prepare<
                    [string],
                    { seq: bigint; name: string; unique: bigint; origin: string; partial: bigint }
                >("SELECT * FROM pragma_index_list(?)")
                .all(name)
                .map(({ seq: _, ...index }) => index)
                .sort((a, b) => a.name.localeCompare(b.name)),
            foreignKeys: db.prepare("SELECT * FROM pragma_foreign_key_list(?)").all(name),
        }));
    return createHash("sha256")
        .update(
            JSON.stringify({ entries, tables }, (_, value) =>
                typeof value === "bigint" ? value.toString() : value,
            ),
        )
        .digest("hex");
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
    sender_key: hex32(2),
    params_json: JSON.stringify({
        receiverKey: hex32(1),
        senderKey: hex32(2),
        operatorKey: hex32(3),
        operatorSignerKey: hex32(4),
        exitDelay: { value: "5", type: "blocks" },
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

const DEADLINE_QUOTE = {
    batch_expiry_kind: "time",
    batch_expiry_value: 1_800_000_001n,
    input_expiry_floor_kind: "time",
    input_expiry_floor_value: 1_800_000_001n,
    recovery_locktime_kind: "time",
    recovery_locktime_value: 1_800_000_000n,
} as const;

function insertRawReceiveQuote(db: Database, overrides: Record<string, unknown> = {}): void {
    const row = { ...RAW_RECEIVE_QUOTE, ...overrides };
    const cols = Object.keys(row);
    db.prepare(
        `INSERT INTO receive_quotes (${cols.join(", ")}) VALUES (${cols.map((c) => "@" + c).join(", ")})`,
    ).run(row);
}

describe("v1 schema initialization", () => {
    it("matches the canonical columns, indexes, foreign keys and constraints", () => {
        expect(schemaDigest(initialized())).toBe(
            "e0b2959d5b10abfd93d571c961aaf58fe69621816dc3e449d5fdd9456267e8c0",
        );
    });

    it("initializes only an empty database and stamps v1", () => {
        const db = initialized();
        expect(userVersion(db)).toBe(1);
        expect(tableNames(db)).not.toContain("schema_compat");
        expect(tableNames(db)).not.toContain("swap_fills");
        expect(columnNames(db, "advances")).not.toContain("covenant_version");
        expect(columnNames(db, "receive_quotes")).not.toContain("maker_public_key");
    });

    it("refuses nonempty unversioned databases without changing data or schema", () => {
        const db = fresh();
        db.exec(
            "CREATE TABLE owner_data (amount INTEGER); INSERT INTO owner_data VALUES (9007199254740993)",
        );
        const before = db.serialize();
        expect(() => initializeSchema(db)).toThrow(/incompatible.*database/i);
        expect(db.serialize()).toEqual(before);
        expect(userVersion(db)).toBe(0);
    });

    it("refuses a previously used unversioned database containing only internal metadata", () => {
        const db = fresh();
        db.exec(
            "CREATE TABLE previous (id INTEGER PRIMARY KEY AUTOINCREMENT); DROP TABLE previous",
        );
        const before = db.serialize();
        expect(() => initializeSchema(db)).toThrow(/incompatible.*database/i);
        expect(db.serialize()).toEqual(before);
    });

    it.each([2, 14, 18, 19, 20])("refuses unsupported schema %s without mutation", (version) => {
        const db = initialized();
        insertRaw(db, { topup: 9007199254740993n });
        db.pragma(`user_version = ${version}`);
        const before = db.serialize();
        expect(() => initializeSchema(db)).toThrow(/unsupported.*schema/i);
        expect(db.serialize()).toEqual(before);
    });

    it.each([
        "ALTER TABLE fills DROP COLUMN covenant_output_index",
        "ALTER TABLE advances ADD COLUMN unexpected TEXT",
        "DROP INDEX advances_outpoint",
        "CREATE TRIGGER unexpected AFTER UPDATE ON policy BEGIN SELECT 1; END",
    ])("refuses noncanonical v1 schema without repairing it: %s", (sql) => {
        const db = initialized();
        db.exec(sql);
        const before = db.serialize();
        expect(() => initializeSchema(db)).toThrow(/incompatible.*schema/i);
        expect(db.serialize()).toEqual(before);
    });

    it("reopens with auxiliary SDK tables without altering either owner", () => {
        const db = initialized();
        db.exec(
            "CREATE TABLE sdk_reservations (id TEXT PRIMARY KEY, outpoints TEXT NOT NULL); INSERT INTO sdk_reservations VALUES ('held', '[1]')",
        );
        insertRaw(db, { topup: 9007199254740993n });
        const before = db.serialize();
        initializeSchema(db);
        expect(db.serialize()).toEqual(before);
        expect(db.prepare("SELECT * FROM sdk_reservations").all()).toEqual([
            { id: "held", outpoints: "[1]" },
        ]);
    });

    it("rolls back incomplete initialization when SQLite cannot allocate the schema", () => {
        const db = fresh();
        db.pragma("max_page_count = 1");
        expect(() => initializeSchema(db)).toThrow(/database or disk is full/i);
        expect(userVersion(db)).toBe(0);
        expect(tableNames(db)).toEqual([]);
    });

    it("reopens the canonical database without changing its schema or data", () => {
        const first = initialized();
        insertRaw(first);
        const before = first.serialize();
        first.close();
        const reopened = new DatabaseCtor(before);
        reopened.defaultSafeIntegers(true);
        try {
            expect(() => initializeSchema(reopened)).not.toThrow();
            expect(reopened.serialize()).toEqual(before);
            expect(userVersion(reopened)).toBe(1);
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
    it("creates the complete v1 table, column and index layout", () => {
        const db = initialized();
        expect(userVersion(db)).toBe(1);
        expect(tableNames(db).sort()).toEqual([
            "advances",
            "custody",
            "custody_release_inputs",
            "fill_reservations",
            "fills",
            "operator_input_reservations",
            "policy",
            "policy_audit",
            "proceeds_inputs",
            "proceeds_jobs",
            "proceeds_local_intents",
            "receive_quote_reservations",
            "receive_quotes",
            "sqlite_sequence",
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
            fare_asset_group_index outpoint_txid outpoint_vout spent_txid renewals last_renewed_at
            created_at updated_at expires_at
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
            exit_signer_key exit_delay_type exit_delay_value payment_sats extra_packet
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
});

const DEADLINE = 1_800_000_000n;
const deadlineQuote = (over: Record<string, unknown> = {}) => ({
    params_json: JSON.stringify({
        ...JSON.parse(RAW_RECEIVE_QUOTE.params_json),
        topup: "330",
        locktime: String(DEADLINE),
    }),
    loan_sats: 330n,
    recovery_locktime_kind: "time",
    recovery_locktime_value: DEADLINE,
    ...over,
});

describe("current financial schema constraints", () => {
    it("holds every quote to a future time-domain CLTV", () => {
        const db = initialized();
        try {
            for (const bad of [
                { id: "height", recovery_locktime_kind: "height" },
                { id: "low", recovery_locktime_value: 499_999_999n },
                { id: "past", created_at: DEADLINE, expires_at: DEADLINE + 1n },
            ])
                expect(() => insertRawReceiveQuote(db, deadlineQuote(bad)), bad.id).toThrow(
                    /CHECK constraint failed/,
                );
            expect(() => insertRawReceiveQuote(db, deadlineQuote({ id: "ok" }))).not.toThrow();
        } finally {
            db.close();
        }
    });

    it("keeps the batch expiry and input floor agreeing with each other", () => {
        const db = initialized();
        try {
            expect(() =>
                insertRawReceiveQuote(
                    db,
                    deadlineQuote({ id: "domain", input_expiry_floor_kind: "time" }),
                ),
            ).toThrow(/CHECK constraint failed/);
            expect(() =>
                insertRawReceiveQuote(
                    db,
                    deadlineQuote({ id: "order", input_expiry_floor_value: 900_001n }),
                ),
            ).toThrow(/CHECK constraint failed/);
        } finally {
            db.close();
        }
    });

    it("admits only the four custody states", () => {
        const db = initialized();
        insertRaw(db);
        const row = (state: string, extra: Record<string, unknown> = {}) => ({
            advance_id: "a1",
            owner_key: new Uint8Array(32).fill(1),
            owed_sats: 1_000n,
            loan_sats: 330n,
            state,
            held_at: 1n,
            expires_at: 2n,
            ...extra,
        });
        // One row at a time: advance_id is the key and the outpoint is unique.
        const insert = (values: Record<string, unknown>) => {
            db.prepare("DELETE FROM custody").run();
            const cols = Object.keys(values);
            db.prepare(
                `INSERT INTO custody (${cols.join(", ")}) VALUES (${cols.map((c) => "@" + c).join(", ")})`,
            ).run(values);
        };
        try {
            expect(() => insert(row("held"))).not.toThrow();
            for (const state of ["pending", "swept", "HELD", ""])
                expect(() => insert(row(state))).toThrow(/CHECK constraint failed/);
            expect(() => insert(row("forfeit"))).toThrow(/CHECK constraint failed/);
            expect(() =>
                insert(row("forfeit", { swept_actor: "operator", swept_at: 9n })),
            ).not.toThrow();
            expect(() => insert(row("released"))).toThrow(/CHECK constraint failed/);
            expect(() =>
                insert(row("released", { release_txid: hex32(0xab), released_at: 9n })),
            ).not.toThrow();
            expect(() =>
                insert(
                    row("released", {
                        release_txid: hex32(0xab),
                        released_at: 9n,
                        swept_actor: "operator",
                        swept_at: 9n,
                    }),
                ),
            ).toThrow(/CHECK constraint failed/);
        } finally {
            db.close();
        }
    });

    it("stores generic fills without offer-specific columns", () => {
        const db = initialized();
        try {
            const columns = columnNames(db, "fills");
            expect(columns).toContain("covenant_output_index");
            expect(columns).toContain("asset_units");
            expect(columns).toContain("quote_id");
            for (const gone of [
                "offer_hex",
                "offer_txid",
                "offer_vout",
                "swap_address",
                "solver_inputs_json",
                "solver_proceeds_script",
                "solver_keys_json",
                "solver_graph_json",
                "max_fare_json",
            ])
                expect(columns).not.toContain(gone);
            expect(columnNames(db, "fill_reservations")).toEqual([
                "outpoint_txid",
                "outpoint_vout",
                "fill_id",
                "created_at",
            ]);
        } finally {
            db.close();
        }
    });
});
describe("advances constraints", () => {
    it.each(["submission_phase", "recovery_phase"])(
        "refuses obsolete or unknown %s values",
        (column) => {
            const db = initialized();
            for (const phase of ["legacy", "unknown"])
                expect(() => insertRaw(db, { [column]: phase })).toThrow(/CHECK constraint failed/);
        },
    );

    it.each(["claimed", "prepared", "responded", "finalized", "failed"])(
        "accepts the current submission phase %s",
        (submission_phase) => {
            expect(() => insertRaw(initialized(), { submission_phase })).not.toThrow();
        },
    );

    it.each(["prepared", "submitted", "failed"])(
        "accepts the current recovery phase %s",
        (recovery_phase) => {
            expect(() => insertRaw(initialized(), { recovery_phase })).not.toThrow();
        },
    );

    it("requires asset identity and quantity together", () => {
        const db = initialized();
        const asset = { asset_txid: new Uint8Array(32).fill(9), asset_group_index: 0n };
        expect(() => insertRaw(db, asset)).toThrow(/CHECK constraint failed/);
        expect(() => insertRaw(db, { asset_units: 1n })).toThrow(/CHECK constraint failed/);
        expect(() => insertRaw(db, { ...asset, asset_units: 9007199254740993n })).not.toThrow();
    });
    it("accepts every AdvanceState", () => {
        const db = initialized();

        for (const [i, state] of ADVANCE_STATES.entries()) {
            expect(() => insertRaw(db, { id: `a${i}`, state })).not.toThrow();
        }
        expect(ADVANCE_STATES).toHaveLength(9);
    });

    it("rejects an unknown state", () => {
        const db = initialized();

        expect(() => insertRaw(db, { state: "settled" })).toThrow(/CHECK constraint failed/);
    });

    it("rejects a half-populated assetId", () => {
        const db = initialized();

        expect(() => insertRaw(db, { asset_txid: new Uint8Array(32).fill(9) })).toThrow(
            /CHECK constraint failed/,
        );
        expect(() => insertRaw(db, { asset_group_index: 0n })).toThrow(/CHECK constraint failed/);
    });

    it("rejects a half-populated outpoint", () => {
        const db = initialized();

        expect(() => insertRaw(db, { outpoint_txid: "ff".repeat(32) })).toThrow(
            /CHECK constraint failed/,
        );
        expect(() => insertRaw(db, { outpoint_vout: 0n })).toThrow(/CHECK constraint failed/);
    });

    it("refuses to bind one outpoint to two advances", () => {
        const db = initialized();
        const outpoint = { outpoint_txid: "aa".repeat(32), outpoint_vout: 1n };
        insertRaw(db, { id: "a1", ...outpoint });

        expect(() => insertRaw(db, { id: "a2", ...outpoint })).toThrow(/UNIQUE constraint failed/);
        expect(() => insertRaw(db, { id: "a3" })).not.toThrow();
    });

    it("requires receiver fare currency and units together", () => {
        const db = initialized();
        expect(() => insertRaw(db, { receiver_fare_currency: "sats" })).toThrow(
            /CHECK constraint failed/,
        );
        expect(() => insertRaw(db, { receiver_fare_units: "5" })).toThrow(
            /CHECK constraint failed/,
        );
    });

    it("accepts sender-paid and receiver-paid advances rows", () => {
        const db = initialized();
        expect(() => insertRaw(db, { id: "a1" })).not.toThrow();
        expect(() =>
            insertRaw(db, { id: "a2", receiver_fare_currency: "sats", receiver_fare_units: "5" }),
        ).not.toThrow();
        expect(() =>
            insertRaw(db, { id: "a3", receiver_fare_currency: "asset", receiver_fare_units: "0" }),
        ).not.toThrow();
    });

    it("rejects a non-canonical receiver fare units string", () => {
        const db = initialized();
        expect(() =>
            insertRaw(db, { receiver_fare_currency: "sats", receiver_fare_units: "-5" }),
        ).toThrow(/CHECK constraint failed/);
        expect(() =>
            insertRaw(db, { receiver_fare_currency: "sats", receiver_fare_units: "" }),
        ).toThrow(/CHECK constraint failed/);
    });
});

describe("receive quotes constraints", () => {
    it("requires payer and receiver fare together", () => {
        const db = initialized();
        expect(() => insertRawReceiveQuote(db, { payer: "receiver" })).toThrow(
            /CHECK constraint failed/,
        );
        expect(() =>
            insertRawReceiveQuote(db, {
                receiver_fare_json: JSON.stringify({ currency: "sats", units: "5" }),
            }),
        ).toThrow(/CHECK constraint failed/);
    });

    it("accepts sender-paid and receiver-paid receive quotes", () => {
        const db = initialized();
        expect(() => insertRawReceiveQuote(db, { ...DEADLINE_QUOTE, id: "q1" })).not.toThrow();
        expect(() =>
            insertRawReceiveQuote(db, {
                ...DEADLINE_QUOTE,
                id: "q2",
                payer: "receiver",
                receiver_fare_json: JSON.stringify({ currency: "sats", units: "5" }),
            }),
        ).not.toThrow();
    });
});

describe("policy constraints", () => {
    it("admits only the row with id = 1", () => {
        const db = initialized();
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
