import type { Database, Statement } from "better-sqlite3";
import type { Policy } from "@arkade-taxi/core";

export interface AuditRow {
    id: number;
    changedAt: number;
    /** A `Policy` key at the time of the edit; kept as `string` because history
     * outlives any later rename of the field. */
    field: string;
    oldValue: string;
    newValue: string;
    actor: string;
}

/**
 * Refuses to guess the operator's pricing: caps at zero and `paused` admit
 * nothing until the UI sets them. `assetAllowlist` seeds as `[]` rather than
 * `null`, which would mean every asset is accepted.
 */
export const DEFAULT_POLICY: Policy = {
    paused: true,
    feeFlatSats: 0n,
    feeBps: 0,
    maxOutstandingSats: 0n,
    maxPerPaymentTopupSats: 0n,
    maxConcurrentAdvances: 0,
    locktimeMarginBlocks: 144,
    assetAllowlist: [],
    quoteTtlSeconds: 60,
};

const COLUMN_OF = {
    paused: "paused",
    feeFlatSats: "fee_flat_sats",
    feeBps: "fee_bps",
    maxOutstandingSats: "max_outstanding_sats",
    maxPerPaymentTopupSats: "max_per_payment_topup_sats",
    maxConcurrentAdvances: "max_concurrent_advances",
    locktimeMarginBlocks: "locktime_margin_blocks",
    assetAllowlist: "asset_allowlist",
    quoteTtlSeconds: "quote_ttl_seconds",
} as const satisfies Record<keyof Policy, string>;

const FIELDS = Object.keys(COLUMN_OF) as (keyof Policy)[];

type PolicyValue = Policy[keyof Policy];
type Bound = string | number | bigint | null;

interface PolicyRow {
    paused: bigint;
    fee_flat_sats: bigint;
    fee_bps: bigint;
    max_outstanding_sats: bigint;
    max_per_payment_topup_sats: bigint;
    max_concurrent_advances: bigint;
    locktime_margin_blocks: bigint;
    asset_allowlist: string | null;
    quote_ttl_seconds: bigint;
}

interface AuditDbRow {
    id: bigint;
    changed_at: bigint;
    field: string;
    old_value: string;
    new_value: string;
    actor: string;
}

interface AuditInsert {
    changed_at: number;
    field: string;
    old_value: string;
    new_value: string;
    actor: string;
}

const encode = (v: PolicyValue): Bound => {
    if (typeof v === "boolean") return v ? 1 : 0;
    if (Array.isArray(v)) return JSON.stringify(v);
    return v;
};

const serialize = (v: PolicyValue): string =>
    typeof v === "bigint" ? v.toString() : JSON.stringify(v);

const unchanged = (a: PolicyValue, b: PolicyValue): boolean =>
    Array.isArray(a) || Array.isArray(b) ? serialize(a) === serialize(b) : a === b;

const fromRow = (r: PolicyRow): Policy => ({
    paused: r.paused !== 0n,
    feeFlatSats: r.fee_flat_sats,
    feeBps: Number(r.fee_bps),
    maxOutstandingSats: r.max_outstanding_sats,
    maxPerPaymentTopupSats: r.max_per_payment_topup_sats,
    maxConcurrentAdvances: Number(r.max_concurrent_advances),
    locktimeMarginBlocks: Number(r.locktime_margin_blocks),
    assetAllowlist: r.asset_allowlist === null ? null : (JSON.parse(r.asset_allowlist) as string[]),
    quoteTtlSeconds: Number(r.quote_ttl_seconds),
});

export class PolicyRepository {
    readonly #db: Database;
    readonly #get: Statement<[], PolicyRow>;
    readonly #history: Statement<[number], AuditDbRow>;
    readonly #audit: Statement<AuditInsert>;
    /** A Map, not a lookup on a plain object: `patch` comes from the admin UI and
     * `"toString" in obj` would let a prototype key reach the column name. */
    readonly #setters = new Map<keyof Policy, Statement<[Bound]>>();

    constructor(db: Database) {
        this.#db = db;
        this.#get = db
            .prepare<[], PolicyRow>("SELECT * FROM policy WHERE id = 1")
            .safeIntegers(true);
        this.#history = db
            .prepare<[number], AuditDbRow>(
                "SELECT * FROM policy_audit ORDER BY changed_at DESC, id DESC LIMIT ?",
            )
            .safeIntegers(true);
        this.#audit = db.prepare<AuditInsert>(
            `INSERT INTO policy_audit (changed_at, field, old_value, new_value, actor)
             VALUES (@changed_at, @field, @old_value, @new_value, @actor)`,
        );
        for (const f of FIELDS) {
            this.#setters.set(
                f,
                db.prepare<[Bound]>(`UPDATE policy SET ${COLUMN_OF[f]} = ? WHERE id = 1`),
            );
        }

        db.prepare(
            `INSERT OR IGNORE INTO policy (id, ${FIELDS.map((f) => COLUMN_OF[f]).join(", ")})
             VALUES (1, ${FIELDS.map(() => "?").join(", ")})`,
        ).run(...FIELDS.map((f) => encode(DEFAULT_POLICY[f])));
    }

    get(): Policy {
        const row = this.#get.get();
        if (!row) throw new Error("policy: row 1 is missing");
        return fromRow(row);
    }

    update(patch: Partial<Policy>, actor: string): Policy {
        if (actor.trim() === "") throw new Error("policy: an edit must name its actor");

        const entries = Object.entries(patch).filter(([, v]) => v !== undefined) as [
            keyof Policy,
            PolicyValue,
        ][];
        for (const [field] of entries) {
            if (!this.#setters.has(field)) {
                throw new Error(`policy: unknown policy field ${JSON.stringify(field)}`);
            }
        }

        const current = this.get();
        const changed = entries.filter(([f, v]) => !unchanged(current[f], v));
        if (changed.length === 0) return current;

        const changedAt = Date.now();
        this.#db.transaction(() => {
            for (const [field, value] of changed) {
                this.#setters.get(field)!.run(encode(value));
                this.#audit.run({
                    changed_at: changedAt,
                    field,
                    old_value: serialize(current[field]),
                    new_value: serialize(value),
                    actor,
                });
            }
        })();

        return this.get();
    }

    history(limit: number): AuditRow[] {
        return this.#history.all(limit).map((r) => ({
            id: Number(r.id),
            changedAt: Number(r.changed_at),
            field: r.field,
            oldValue: r.old_value,
            newValue: r.new_value,
            actor: r.actor,
        }));
    }
}
