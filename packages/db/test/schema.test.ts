import { describe, expect, it } from "vitest";
import DatabaseCtor from "better-sqlite3";
import type { Database } from "better-sqlite3";
import { ADVANCE_STATES, applyMigrations, MIGRATIONS, type Migration } from "../src/schema.js";
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

/** Every column's declared shape, by table. What a reader needs to still find. */
function shape(db: Database): Record<string, Record<string, string>> {
    const columns = db.prepare<
        [string],
        { name: string; type: string; notnull: bigint; dflt_value: string | null }
    >(`SELECT name, type, "notnull", dflt_value FROM pragma_table_info(?)`);
    return Object.fromEntries(
        db
            .prepare<[], { name: string }>(
                "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name",
            )
            .all()
            .map(({ name }) => [
                name,
                Object.fromEntries(
                    columns
                        .all(name)
                        .map((c) => [c.name, `${c.type} ${c.notnull} ${String(c.dflt_value)}`]),
                ),
            ]),
    );
}

/** The only column shape migration 15 relaxes: both are write-only, so nothing
 * reads them, and a v2 advance stores no batch expiry to put there. */
const RELAXED_BY_15 = new Set([
    "operator_input_reservations.batch_expiry_kind",
    "operator_input_reservations.batch_expiry_value",
]);

/** One covenant, so the column that selected between two is gone from both. */
const DROPPED_BY_17 = new Set(["advances.covenant_version", "receive_quotes.covenant_version"]);

function at(upto: number): Database {
    const db = fresh();
    applyMigrations(
        db,
        MIGRATIONS.filter((m) => m.id <= upto),
    );
    return db;
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

/** The shape every receive quote carries from migration 17 on. It also satisfies
 * migration 15's then-conditional v1 ordering, so one fixture migrates the whole
 * way from a pre-13 database to the head. */
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

describe("migration 13", () => {
    it("records no breaking migration, so a reader that stops at 12 is not locked out", () => {
        const db = at(13);
        try {
            expect(userVersion(db)).toBe(13);
            expect(MIGRATIONS.find((m) => m.id === 13)?.compat).toBe("additive");
            expect(
                db
                    .prepare<[], { v: bigint }>(
                        "SELECT min_reader_version AS v FROM schema_compat WHERE id = 1",
                    )
                    .get(),
            ).toEqual({ v: 0n });
        } finally {
            db.close();
        }
    });

    // The 18 REQUIRED_SCHEMA sentinels a v12 reader checks are a sample of this
    // set; pinning the whole set is what catches a column no sentinel covers.
    it("adds two columns and leaves every v12 column's shape untouched", () => {
        const twelve = at(12);
        const before = shape(twelve);
        twelve.close();
        const thirteen = at(13);
        const after = shape(thirteen);
        thirteen.close();

        for (const [table, columns] of Object.entries(before))
            for (const [column, declared] of Object.entries(columns))
                if (!RELAXED_BY_15.has(`${table}.${column}`))
                    expect(after[table]?.[column], `${table}.${column}`).toBe(declared);
        expect(
            Object.entries(after).flatMap(([table, columns]) =>
                Object.keys(columns)
                    .filter((column) => !(column in (before[table] ?? {})))
                    .map((column) => `${table}.${column}`),
            ),
        ).toEqual(["advances.covenant_version", "receive_quotes.covenant_version"]);
    });

    it("migrates a v12 database forward leaving its rows at a null covenant version", () => {
        const db = at(12);
        try {
            insertRaw(db);
            insertRawReceiveQuote(db);
            applyMigrations(
                db,
                MIGRATIONS.filter((m) => m.id <= 16),
            );
            expect(userVersion(db)).toBe(16);
            expect(db.prepare("SELECT id, topup, covenant_version FROM advances").all()).toEqual([
                { id: "a1", topup: 300n, covenant_version: null },
            ]);
            expect(db.prepare("SELECT id, covenant_version FROM receive_quotes").all()).toEqual([
                { id: "q1", covenant_version: null },
            ]);
        } finally {
            db.close();
        }
    });

    it("admits a null or 2 covenant version on both tables and refuses any other", () => {
        const db = at(16);
        try {
            expect(() => insertRaw(db, { id: "legacy" })).not.toThrow();
            expect(() => insertRaw(db, { id: "v2", covenant_version: 2n })).not.toThrow();
            // Since migration 15 a v2 quote also owes a time-domain deadline.
            expect(() =>
                insertRawReceiveQuote(db, { ...DEADLINE_QUOTE, covenant_version: 2n }),
            ).not.toThrow();
            for (const covenant_version of [0n, 1n, 3n]) {
                expect(() =>
                    insertRaw(db, { id: `bad-${covenant_version}`, covenant_version }),
                ).toThrow(/CHECK constraint failed/);
                expect(() =>
                    insertRawReceiveQuote(db, { id: `badq-${covenant_version}`, covenant_version }),
                ).toThrow(/CHECK constraint failed/);
            }
        } finally {
            db.close();
        }
    });
});

describe("migration 15", () => {
    const V2_DEADLINE = 1_800_000_000n;
    const v2Quote = (over: Record<string, unknown> = {}) => ({
        covenant_version: 2n,
        recovery_locktime_kind: "time",
        recovery_locktime_value: V2_DEADLINE,
        ...over,
    });

    it("declares itself breaking, so a reader that stops at 14 is locked out", () => {
        const db = at(16);
        try {
            expect(userVersion(db)).toBe(16);
            expect(MIGRATIONS.find((m) => m.id === 15)?.compat).toBe("breaking");
            expect(
                db
                    .prepare<[], { v: bigint }>(
                        "SELECT min_reader_version AS v FROM schema_compat WHERE id = 1",
                    )
                    .get(),
            ).toEqual({ v: 15n });
        } finally {
            db.close();
        }
    });

    it("copies every v14 row unchanged and keeps every other column's shape", () => {
        const fourteen = at(14);
        insertRawReceiveQuote(fourteen, { id: "v1-kept" });
        fourteen
            .prepare(
                `INSERT INTO receive_quote_reservations (outpoint_txid, outpoint_vout, quote_id, created_at)
                 VALUES (?, 0, 'v1-kept', 1)`,
            )
            .run(hex32(9));
        const before = {
            shape: shape(fourteen),
            quote: fourteen.prepare("SELECT * FROM receive_quotes WHERE id = 'v1-kept'").get(),
            reservation: fourteen.prepare("SELECT * FROM receive_quote_reservations").all(),
        };
        applyMigrations(
            fourteen,
            MIGRATIONS.filter((m) => m.id <= 16),
        );
        expect(userVersion(fourteen)).toBe(16);
        expect(fourteen.prepare("SELECT * FROM receive_quotes WHERE id = 'v1-kept'").get()).toEqual(
            before.quote,
        );
        expect(fourteen.prepare("SELECT * FROM receive_quote_reservations").all()).toEqual(
            before.reservation,
        );
        const after = shape(fourteen);
        for (const [table, columns] of Object.entries(before.shape))
            for (const [column, declared] of Object.entries(columns))
                if (!RELAXED_BY_15.has(`${table}.${column}`))
                    expect(after[table]?.[column], `${table}.${column}`).toBe(declared);
        expect(
            fourteen
                .prepare<[], { name: string }>(
                    "SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'receive_quotes'",
                )
                .all()
                .map((r) => r.name),
        ).toContain("receive_quotes_state_expiry");
        fourteen.close();
    });

    it("makes the write-only reservation expiry nullable, and nothing else", () => {
        const fourteen = at(14);
        const before = shape(fourteen);
        fourteen.close();
        const db = at(16);
        const after = shape(db);
        db.close();
        const changed = Object.entries(before).flatMap(([table, columns]) =>
            Object.entries(columns)
                .filter(([column, declared]) => after[table]?.[column] !== declared)
                .map(([column]) => `${table}.${column}`),
        );
        expect(changed.sort()).toEqual([...RELAXED_BY_15].sort());
    });

    it("admits a v2 deadline past the input floor, which v14 refused", () => {
        const fourteen = at(14);
        expect(() => insertRawReceiveQuote(fourteen, v2Quote({ id: "v2" }))).toThrow(
            /CHECK constraint failed/,
        );
        fourteen.close();
        const db = at(16);
        try {
            expect(() => insertRawReceiveQuote(db, v2Quote({ id: "v2" }))).not.toThrow();
        } finally {
            db.close();
        }
    });

    it("still refuses a v1 quote that breaks the old ordering", () => {
        const db = at(16);
        try {
            expect(() =>
                insertRawReceiveQuote(db, { id: "v1-after", recovery_locktime_value: 900_001n }),
            ).toThrow(/CHECK constraint failed/);
            expect(() =>
                insertRawReceiveQuote(db, { id: "v1-domain", recovery_locktime_kind: "time" }),
            ).toThrow(/CHECK constraint failed/);
        } finally {
            db.close();
        }
    });

    it("holds a v2 deadline to a future time-domain CLTV", () => {
        const db = at(16);
        try {
            for (const bad of [
                { id: "v2-height", recovery_locktime_kind: "height" },
                { id: "v2-low", recovery_locktime_value: 499_999_999n },
                { id: "v2-past", created_at: V2_DEADLINE, expires_at: V2_DEADLINE + 1n },
            ])
                expect(() => insertRawReceiveQuote(db, v2Quote(bad)), bad.id).toThrow(
                    /CHECK constraint failed/,
                );
        } finally {
            db.close();
        }
    });
});

describe("migration 17", () => {
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

    const columnNames = (db: Database, table: string) =>
        db
            .prepare<[string], { name: string }>("SELECT name FROM pragma_table_info(?)")
            .all(table)
            .map((r) => r.name);

    it("declares itself breaking, so a reader that stops at 16 is locked out", () => {
        const db = migrated();
        try {
            expect(userVersion(db)).toBe(17);
            expect(MIGRATIONS.find((m) => m.id === 17)?.compat).toBe("breaking");
            expect(
                db
                    .prepare<[], { v: bigint }>(
                        "SELECT min_reader_version AS v FROM schema_compat WHERE id = 1",
                    )
                    .get(),
            ).toEqual({ v: 17n });
        } finally {
            db.close();
        }
    });

    it("drops covenant_version from both tables, keeping a deadline row readable", () => {
        const sixteen = at(16);
        insertRawReceiveQuote(
            sixteen,
            deadlineQuote({ id: "deadline", state: "quoted", covenant_version: 2n }),
        );
        sixteen
            .prepare(
                `INSERT INTO receive_quote_reservations (outpoint_txid, outpoint_vout, quote_id, created_at)
                 VALUES (?, 0, 'deadline', 1)`,
            )
            .run(hex32(5));
        insertRaw(sixteen, { id: "adv", covenant_version: 2n });
        applyMigrations(sixteen, MIGRATIONS);
        try {
            expect(userVersion(sixteen)).toBe(17);
            expect(columnNames(sixteen, "receive_quotes")).not.toContain("covenant_version");
            expect(columnNames(sixteen, "advances")).not.toContain("covenant_version");
            expect(new ReceiveQuoteRepository(sixteen).get("deadline")?.recoveryLocktime).toEqual({
                kind: "time",
                value: DEADLINE,
            });
            expect(sixteen.prepare("SELECT * FROM receive_quote_reservations").all()).toHaveLength(
                1,
            );
            expect(sixteen.prepare("SELECT id, topup FROM advances").all()).toEqual([
                { id: "adv", topup: 300n },
            ]);
        } finally {
            sixteen.close();
        }
    });

    // The proof the mutinynet wipe is required, not optional: a height-domain v1
    // quote cannot satisfy the unconditional deadline CHECK, so the rebuild
    // refuses it and the whole migration rolls back.
    it("refuses to migrate a v1-shaped quote and leaves the database at 16", () => {
        const sixteen = at(16);
        insertRawReceiveQuote(sixteen, { id: "v1" });
        try {
            expect(() => applyMigrations(sixteen, MIGRATIONS)).toThrow(/CHECK constraint failed/);
            expect(userVersion(sixteen)).toBe(16);
            expect(columnNames(sixteen, "receive_quotes")).toContain("covenant_version");
        } finally {
            sixteen.close();
        }
    });

    it("holds every quote to a future time-domain CLTV", () => {
        const db = migrated();
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

    // Funding facts, not covenant facts: the floor still belongs to the batch.
    it("keeps the batch expiry and input floor agreeing with each other", () => {
        const db = migrated();
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
});

describe("migration 14", () => {
    it("records no breaking migration, so a reader that stops at 13 is not locked out", () => {
        const db = at(14);
        try {
            expect(userVersion(db)).toBe(14);
            expect(MIGRATIONS.find((m) => m.id === 14)?.compat).toBe("additive");
            expect(
                db
                    .prepare<[], { v: bigint }>(
                        "SELECT min_reader_version AS v FROM schema_compat WHERE id = 1",
                    )
                    .get(),
            ).toEqual({ v: 0n });
        } finally {
            db.close();
        }
    });

    // Stronger than the five custody sentinels: every v13 column, not a sample.
    it("adds two inert tables and leaves every v13 column's shape untouched", () => {
        const thirteen = at(13);
        const before = shape(thirteen);
        thirteen.close();
        const fourteen = at(14);
        const after = shape(fourteen);
        fourteen.close();

        for (const [table, columns] of Object.entries(before))
            for (const [column, declared] of Object.entries(columns))
                if (!RELAXED_BY_15.has(`${table}.${column}`))
                    expect(after[table]?.[column], `${table}.${column}`).toBe(declared);
        expect(
            Object.keys(after)
                .filter((table) => !(table in before))
                .sort(),
        ).toEqual(["custody", "custody_release_inputs"]);
    });

    it("migrates a v13 database forward preserving its rows and adding no custody row", () => {
        const db = at(13);
        try {
            insertRaw(db, { covenant_version: 2n });
            applyMigrations(db);
            expect(userVersion(db)).toBe(17);
            expect(db.prepare("SELECT id, topup FROM advances").all()).toEqual([
                { id: "a1", topup: 300n },
            ]);
            expect(db.prepare("SELECT count(*) AS n FROM custody").get()).toEqual({ n: 0n });
        } finally {
            db.close();
        }
    });

    it("admits only the four custody states", () => {
        const db = migrated();
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
});

describe("migrations", () => {
    it.each([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14])(
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
            expect(userVersion(reopened)).toBe(17);
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
        expect(MIGRATIONS.map(({ id }) => id)).toEqual([
            1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17,
        ]);
        expect(MIGRATIONS[0]!.up).not.toMatch(/ALTER TABLE|advances_v2/i);
        const db = migrated();
        expect(userVersion(db)).toBe(17);
        expect(tableNames(db).sort()).toEqual([
            "advances",
            "custody",
            "custody_release_inputs",
            "operator_input_reservations",
            "policy",
            "policy_audit",
            "proceeds_inputs",
            "proceeds_jobs",
            "proceeds_local_intents",
            "receive_quote_reservations",
            "receive_quotes",
            "schema_compat",
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
            exit_signer_key exit_delay_type exit_delay_value payment_sats
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
        expect(userVersion(db)).toBe(17);
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
        expect(userVersion(db)).toBe(17);
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
        expect(userVersion(db)).toBe(17);
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
        expect(userVersion(db)).toBe(17);
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
        expect(userVersion(db)).toBe(17);
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
        expect(userVersion(db)).toBe(17);
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
        db.pragma("user_version = 9");
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
            operator_inputs_json: JSON.stringify([{ txid: hex32(8), vout: 0 }]),
            unsigned_lockup_tx: "unsigned",
            unsigned_lockup_id: hex32(4),
        });
        applyMigrations(db);
        expect(userVersion(db)).toBe(17);
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

        // Migration 11 refuses this row on purpose; stamp its exit params so the
        // rest of the decode path below is still exercised.
        expect(() => new AdvanceRepository(db).get("a1")).toThrow(/missing exit params/);
        db.prepare(
            "UPDATE advances SET exit_signer_key = ?, exit_delay_type = 'blocks', exit_delay_value = 5",
        ).run(new Uint8Array(32).fill(6));

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
            operatorSignerKey: new Uint8Array(32).fill(6),
            exitDelay: { value: 5n, type: "blocks" },
            dust: 330n,
            topup: 300n,
            locktime: 100n,
            covenantAddress: "tark1qexample",
            fare: { currency: "sats", units: 10n },
            createdAt: 1,
            updatedAt: 1,
            expiresAt: 2,
            operatorInputs: [{ txid: hex32(8), vout: 0 }],
            unsignedLockupTx: "unsigned",
            unsignedLockupId: hex32(4),
        });

        db.close();
    });
    it("rejects a v10 stamp without the receiver-paid advances column", () => {
        const db = migrated();
        // receiver_fare_units carries a CHECK referencing receiver_fare_currency, so it
        // must go first: SQLite refuses to drop a column another column's CHECK cites.
        db.exec(
            "ALTER TABLE advances DROP COLUMN receiver_fare_units; ALTER TABLE advances DROP COLUMN receiver_fare_currency;",
        );
        db.pragma("user_version = 10");
        const before = db.serialize();
        expect(() => applyMigrations(db)).toThrow(/incompatible.*recreate.*database/i);
        expect(db.serialize()).toEqual(before);
        db.close();
    });
    it("adds the exit params at migration 11", () => {
        const db = migrated();
        try {
            expect(userVersion(db)).toBe(17);
            for (const column of ["exit_signer_key", "exit_delay_type", "exit_delay_value"])
                expect(
                    db
                        .prepare("SELECT 1 FROM pragma_table_info('advances') WHERE name = ?")
                        .get(column),
                ).toBeTruthy();
            insertRaw(db, { exit_delay_type: "seconds", exit_delay_value: 86016 });
            expect(() =>
                db.prepare("UPDATE advances SET exit_delay_type = 'fortnights'").run(),
            ).toThrow(/CHECK/);
            expect(() => db.prepare("UPDATE advances SET exit_delay_value = 0").run()).toThrow(
                /CHECK/,
            );
        } finally {
            db.close();
        }
    });
    it("rejects a v11 stamp without the exit params column", () => {
        const db = migrated();
        db.exec("ALTER TABLE advances DROP COLUMN exit_signer_key");
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
        expect(userVersion(db)).toBe(17);
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
            { id: 2, compat: "additive", up: "INSERT INTO t (v) VALUES ('x')" },
            { id: 1, compat: "additive", up: "CREATE TABLE t (v TEXT)" },
        ]);

        expect(db.prepare<[], { v: string }>("SELECT v FROM t").get()?.v).toBe("x");
        expect(userVersion(db)).toBe(2);
    });

    it("skips migrations at or below the current user_version", () => {
        const db = fresh();
        applyMigrations(db, [{ id: 1, compat: "additive", up: "CREATE TABLE t (v TEXT)" }]);

        applyMigrations(db, [
            { id: 1, compat: "additive", up: "SELECT raise_error_if_reapplied" },
            { id: 2, compat: "additive", up: "CREATE TABLE u (v TEXT)" },
        ]);

        expect(tableNames(db)).toEqual(expect.arrayContaining(["t", "u"]));
        expect(userVersion(db)).toBe(2);
    });

    it("rolls the whole batch back when one migration fails", () => {
        const db = fresh();

        expect(() =>
            applyMigrations(db, [
                { id: 1, compat: "additive", up: "CREATE TABLE t (v TEXT)" },
                { id: 2, compat: "additive", up: "CREATE TABLE ((( syntax error" },
            ]),
        ).toThrow();

        expect(tableNames(db)).not.toContain("t");
        expect(userVersion(db)).toBe(0);
    });

    it("rejects duplicate or non-integer migration ids", () => {
        expect(() =>
            applyMigrations(fresh(), [
                { id: 1, compat: "additive", up: "CREATE TABLE a (v TEXT)" },
                { id: 1, compat: "additive", up: "CREATE TABLE b (v TEXT)" },
            ]),
        ).toThrow(/duplicate/i);
        expect(() =>
            applyMigrations(fresh(), [
                { id: 1.5, compat: "additive", up: "CREATE TABLE a (v TEXT)" },
            ]),
        ).toThrow(/integer/i);
    });
});

describe("rollback onto a newer schema", () => {
    // Plays both binaries with the real code: the explicit list is the future
    // build that migrates, the default MIGRATIONS is the one rolled back onto it.
    const ahead = (compat: Migration["compat"], up: string): Database => {
        const db = fresh();
        applyMigrations(db, [...MIGRATIONS, { id: 18, compat, up }]);
        expect(userVersion(db)).toBe(18);
        return db;
    };
    const ADD_COLUMN = "ALTER TABLE advances ADD COLUMN covenant_type TEXT";

    it("starts against an additive newer schema", () => {
        const db = ahead("additive", ADD_COLUMN);
        try {
            expect(() => applyMigrations(db)).not.toThrow();
            expect(userVersion(db)).toBe(18);
        } finally {
            db.close();
        }
    });

    it("refuses a newer schema that dropped a column this build reads", () => {
        const db = ahead("additive", "ALTER TABLE advances DROP COLUMN renewals");
        const before = db.serialize();
        try {
            expect(() => applyMigrations(db)).toThrow(
                /database is at schema 18, this build knows 17;[\s\S]*renewals/,
            );
            expect(db.serialize()).toEqual(before);
        } finally {
            db.close();
        }
    });

    it("refuses an additive newer schema whose migration declared itself breaking", () => {
        const db = ahead("breaking", ADD_COLUMN);
        const before = db.serialize();
        try {
            expect(() => applyMigrations(db)).toThrow(
                /database is at schema 18, this build knows 17;[\s\S]*migration 18/,
            );
            expect(db.serialize()).toEqual(before);
        } finally {
            db.close();
        }
    });

    it("refuses a newer schema that records no compatibility marker", () => {
        const db = migrated();
        db.exec(`${ADD_COLUMN}; DROP TABLE schema_compat`);
        db.pragma("user_version = 18");
        try {
            expect(() => applyMigrations(db)).toThrow(
                /database is at schema 18, this build knows 17;[\s\S]*no forward-compatibility marker/,
            );
        } finally {
            db.close();
        }
    });

    // Both inputs a 13-era guard reads before admitting a newer database. The
    // cross-build run against origin/main's built package is the real proof;
    // this pins the preconditions that run depends on.
    it("leaves a 13-era reader every column it reads, but migration 17 locks it out", () => {
        const db = migrated();
        const thirteen = at(13);
        const before = shape(thirteen);
        thirteen.close();
        try {
            expect(
                db
                    .prepare<[], { v: bigint }>(
                        "SELECT min_reader_version AS v FROM schema_compat WHERE id = 1",
                    )
                    .get(),
            ).toEqual({ v: 17n });
            const after = shape(db);
            for (const [table, columns] of Object.entries(before))
                for (const [column, declared] of Object.entries(columns))
                    if (
                        !RELAXED_BY_15.has(`${table}.${column}`) &&
                        !DROPPED_BY_17.has(`${table}.${column}`)
                    )
                        expect(after[table]?.[column], `${table}.${column}`).toBe(declared);
        } finally {
            db.close();
        }
    });

    // The deployed shape: a database an older build created and this one only opens.
    it("leaves a database at the current version untouched when it has no marker", () => {
        const db = migrated();
        db.exec("DROP TABLE schema_compat");
        const before = db.serialize();
        try {
            expect(() => applyMigrations(db)).not.toThrow();
            expect(db.serialize()).toEqual(before);
        } finally {
            db.close();
        }
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

    it("requires receiver fare currency and units together", () => {
        const db = migrated();
        expect(() => insertRaw(db, { receiver_fare_currency: "sats" })).toThrow(
            /CHECK constraint failed/,
        );
        expect(() => insertRaw(db, { receiver_fare_units: "5" })).toThrow(
            /CHECK constraint failed/,
        );
    });

    it("accepts sender-paid and receiver-paid advances rows", () => {
        const db = migrated();
        expect(() => insertRaw(db, { id: "a1" })).not.toThrow();
        expect(() =>
            insertRaw(db, { id: "a2", receiver_fare_currency: "sats", receiver_fare_units: "5" }),
        ).not.toThrow();
        expect(() =>
            insertRaw(db, { id: "a3", receiver_fare_currency: "asset", receiver_fare_units: "0" }),
        ).not.toThrow();
    });

    it("rejects a non-canonical receiver fare units string", () => {
        const db = migrated();
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
        const db = migrated();
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
        const db = migrated();
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
