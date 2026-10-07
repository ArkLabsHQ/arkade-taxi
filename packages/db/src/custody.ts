import type { Database } from "better-sqlite3";
import type { Advance, Outpoint } from "@arkade-taxi/core";
import { assertNativeAccess } from "./coordination.js";
import { PolicyRepository } from "./policy.js";

/** Derived, not re-imported: this package depends on core alone, and these are
 * by definition the reclaimed advance's own asset and fare. */
type AssetIdRef = NonNullable<Advance["assetId"]>;
type ReceiverFare = NonNullable<Advance["receiverFare"]>;

export type CustodyState = "held" | "releasing" | "released" | "forfeit";

/**
 * What the Taxi owes one receiver whose v2 advance it reclaimed. A liability,
 * not a coin: the reclaimed coin becomes ordinary operator inventory, and a
 * release is funded from whatever is spendable at the time.
 */
export interface CustodyRecord {
    advanceId: string;
    ownerKey: Uint8Array;
    assetId?: AssetIdRef;
    /** Units owed, before the covenant's committed fare. */
    assetUnits?: bigint;
    /** Sats owed, before the committed fare. */
    owedSats: bigint;
    /** What the reclaim already repaid the Taxi; kept for audit, never re-charged. */
    loanSats: bigint;
    fare?: ReceiverFare;
    state: CustodyState;
    heldAt: number;
    expiresAt: number;
    /** The coins an in-flight release graph spends; empty unless `releasing`. */
    releaseInputs: Outpoint[];
    /** Set while `releasing`: the graph this row committed to. */
    releaseExpectedTxid?: string;
    /** The worker holding the release, so another process can finish it. */
    releaseLease?: { owner: string; token: string; until: number };
    releaseTxid?: string;
    releasedAt?: number;
    /** A write-off: the time and the operator who did it, never a transaction. */
    sweptAt?: number;
    sweptActor?: string;
}

/** Owed totals, for the operator surface and the lending gate. */
export interface CustodyLiabilities {
    owedSats: bigint;
    assets: { assetId: AssetIdRef; units: bigint }[];
    rows: number;
}

export type CustodyCode =
    | "custody_not_found"
    | "custody_release_in_progress"
    | "custody_released"
    | "custody_window_open"
    | "custody_window_unconfigured";

export class CustodyError extends Error {
    constructor(
        readonly code: CustodyCode,
        advanceId: string,
    ) {
        super(`custody ${advanceId}: ${code}`);
        this.name = "CustodyError";
    }
}

/** The one refusal that says what happened and when, rather than failing generically. */
export class CustodySweptError extends Error {
    readonly code = "custody_swept";

    constructor(
        advanceId: string,
        readonly actor: string,
        readonly at: number,
    ) {
        super(`custody ${advanceId}: custody_swept by ${actor} at ${at}`);
        this.name = "CustodySweptError";
    }
}

export class CustodyReleaseInputConflictError extends Error {
    readonly code = "custody_release_input_conflict";

    constructor() {
        super("custody: release input already bound");
        this.name = "CustodyReleaseInputConflictError";
    }
}

interface Row {
    advance_id: string;
    owner_key: Buffer;
    asset_txid: Buffer | null;
    asset_group_index: bigint | null;
    asset_units: bigint | null;
    owed_sats: bigint;
    loan_sats: bigint;
    fare_currency: "sats" | "asset" | null;
    fare_units: bigint | null;
    state: CustodyState;
    held_at: bigint;
    expires_at: bigint;
    release_expected_txid: string | null;
    release_lease_owner: string | null;
    release_lease_token: string | null;
    release_lease_until: bigint | null;
    release_txid: string | null;
    released_at: bigint | null;
    swept_at: bigint | null;
    swept_actor: string | null;
}

const COLUMNS = `advance_id, owner_key, asset_txid, asset_group_index, asset_units, owed_sats,
    loan_sats, fare_currency, fare_units, state, held_at, expires_at, release_expected_txid,
    release_lease_owner, release_lease_token, release_lease_until, release_txid, released_at,
    swept_at, swept_actor`;

const txid = (value: string, what: string): string => {
    if (!/^[0-9a-f]{64}$/.test(value)) throw new Error(`custody: invalid ${what}`);
    return value;
};

const clock = (value: number, what: string): number => {
    if (!Number.isSafeInteger(value) || value < 0) throw new Error(`custody: invalid ${what}`);
    return value;
};

const point = (value: Outpoint, what: string): Outpoint => {
    if (!Number.isSafeInteger(value.vout) || value.vout < 0 || value.vout > 0xffff_ffff)
        throw new Error(`custody: invalid ${what}`);
    return { txid: txid(value.txid, what), vout: value.vout };
};

/**
 * Opens the ledger row for a reclaimed v2 advance. Called inside the transaction
 * that writes `recovered`, so the asset is never in the Taxi's wallet with no row
 * naming what is owed. `INSERT OR IGNORE`: a replayed reclaim is not a second row.
 */
export function openCustodyRow(
    db: Database,
    advance: Advance,
    at: number,
    windowSeconds: number | undefined,
): void {
    if (windowSeconds === undefined || !Number.isSafeInteger(windowSeconds) || windowSeconds <= 0)
        throw new CustodyError("custody_window_unconfigured", advance.id);
    db.prepare(
        `INSERT OR IGNORE INTO custody (advance_id, owner_key, asset_txid, asset_group_index,
            asset_units, owed_sats, loan_sats, fare_currency, fare_units, state, held_at,
            expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'held', ?, ?)`,
    ).run(
        advance.id,
        advance.receiverKey,
        advance.assetId?.txid ?? null,
        advance.assetId?.groupIndex ?? null,
        advance.assetUnits ?? null,
        // The reclaim paid the whole lockup to the operator, and the loaned dust
        // was the operator's own, so what is owed is the payer's sats beside it.
        advance.paymentSats ?? 0n,
        advance.topup,
        advance.receiverFare?.currency ?? null,
        advance.receiverFare?.units ?? null,
        clock(at, "reclaim clock"),
        clock(at, "reclaim clock") + windowSeconds,
    );
}

export class CustodyRepository {
    constructor(private readonly db: Database) {
        assertNativeAccess(db);
    }

    get(advanceId: string): CustodyRecord | undefined {
        assertNativeAccess(this.db);
        const row = this.db
            .prepare<[string], Row>(`SELECT ${COLUMNS} FROM custody WHERE advance_id = ?`)
            .safeIntegers(true)
            .get(advanceId);
        return row && this.#decode(row);
    }

    byOwner(ownerKey: Uint8Array): CustodyRecord[] {
        assertNativeAccess(this.db);
        return this.db
            .prepare<[Uint8Array], Row>(
                `SELECT ${COLUMNS} FROM custody WHERE owner_key = ? ORDER BY held_at, advance_id`,
            )
            .safeIntegers(true)
            .all(ownerKey)
            .map((row) => this.#decode(row));
    }

    listActive(): CustodyRecord[] {
        assertNativeAccess(this.db);
        return this.db
            .prepare<[], Row>(
                `SELECT ${COLUMNS} FROM custody WHERE state IN ('held', 'releasing')
                 ORDER BY held_at, advance_id`,
            )
            .safeIntegers(true)
            .all()
            .map((row) => this.#decode(row));
    }

    /**
     * Only the coins an in-flight release graph spends. A `held` row binds no
     * coin at all — it is a claim on inventory, which the SDK must stay free to
     * renew — so this feeds the settlement guard and never the funding selector.
     */
    listHeldOutpoints(): Outpoint[] {
        assertNativeAccess(this.db);
        return this.db
            .prepare<[], { txid: string; vout: bigint }>(
                `SELECT outpoint_txid AS txid, outpoint_vout AS vout FROM custody_release_inputs
                 ORDER BY txid, vout`,
            )
            .safeIntegers(true)
            .all()
            .map(({ txid: t, vout }) => ({ txid: t, vout: Number(vout) }));
    }

    /** Totals across active rows: sats in one figure, units per asset id. */
    liabilities(): CustodyLiabilities {
        assertNativeAccess(this.db);
        const sats = this.db
            .prepare<[], { owed: bigint | null; rows: bigint }>(
                `SELECT coalesce(sum(owed_sats), 0) AS owed, count(*) AS rows FROM custody
                 WHERE state IN ('held', 'releasing')`,
            )
            .safeIntegers(true)
            .get()!;
        const assets = this.db
            .prepare<[], { txid: Buffer; group_index: bigint; units: bigint }>(
                `SELECT asset_txid AS txid, asset_group_index AS group_index,
                        sum(asset_units) AS units FROM custody
                 WHERE state IN ('held', 'releasing') AND asset_txid IS NOT NULL
                 GROUP BY asset_txid, asset_group_index ORDER BY asset_txid, asset_group_index`,
            )
            .safeIntegers(true)
            .all()
            .map(({ txid: t, group_index, units }) => ({
                assetId: { txid: Uint8Array.from(t), groupIndex: Number(group_index) },
                units,
            }));
        return { owedSats: sats.owed ?? 0n, assets, rows: Number(sats.rows) };
    }

    /**
     * The single compare-and-set before any payout, and before any coin is
     * chosen: nothing else moves a row out of `held`, so two concurrent
     * releases cannot both reach the funding selector. A refusal does not
     * consume the row (spec 5.5).
     */
    claimRelease(
        advanceId: string,
        owner: string,
        token: string,
        now: number,
        until: number,
    ): CustodyRecord {
        assertNativeAccess(this.db);
        clock(now, "release clock");
        clock(until, "release lease deadline");
        return this.db
            .transaction(() => {
                const current = this.get(advanceId);
                if (!current) throw new CustodyError("custody_not_found", advanceId);
                if (current.sweptAt !== undefined)
                    throw new CustodySweptError(advanceId, current.sweptActor!, current.sweptAt);
                if (current.state === "released")
                    throw new CustodyError("custody_released", advanceId);
                // 'pending' holds the CHECK until the graph exists: the coins are
                // chosen only after this row is won.
                const changed = this.db
                    .prepare(
                        `UPDATE custody SET state = 'releasing', release_lease_owner = ?,
                         release_lease_token = ?, release_lease_until = ?,
                         release_expected_txid = 'pending'
                         WHERE advance_id = ? AND state = 'held' AND swept_at IS NULL
                         AND (release_lease_until IS NULL OR release_lease_until < ?)`,
                    )
                    .run(owner, token, until, advanceId, now).changes;
                if (changed !== 1) throw new CustodyError("custody_release_in_progress", advanceId);
                return this.get(advanceId)!;
            })
            .immediate();
    }

    /**
     * Binds the coins the release graph spends, once selected. The outpoint
     * primary key is the fence: two releases cannot bind one coin, and the
     * selection-layer union cannot close that race.
     */
    bindReleaseInputs(
        advanceId: string,
        owner: string,
        token: string,
        inputs: readonly Outpoint[],
        expectedTxid: string,
        at: number,
    ): boolean {
        assertNativeAccess(this.db);
        txid(expectedTxid, "expected release txid");
        clock(at, "release clock");
        const bound = inputs.map((input) => point(input, "release input"));
        if (!bound.length) throw new Error("custody: release binds no input");
        return this.db
            .transaction(() => {
                const changed = this.db
                    .prepare(
                        `UPDATE custody SET release_expected_txid = ?
                         WHERE advance_id = ? AND state = 'releasing' AND release_lease_owner = ?
                         AND release_lease_token = ? AND swept_at IS NULL`,
                    )
                    .run(expectedTxid, advanceId, owner, token).changes;
                if (changed !== 1) return false;
                this.db
                    .prepare("DELETE FROM custody_release_inputs WHERE advance_id = ?")
                    .run(advanceId);
                const insert = this.db.prepare(
                    "INSERT INTO custody_release_inputs VALUES (?, ?, ?, ?)",
                );
                for (const input of bound) {
                    try {
                        insert.run(input.txid, input.vout, advanceId, at);
                    } catch {
                        throw new CustodyReleaseInputConflictError();
                    }
                }
                return true;
            })
            .immediate();
    }

    /** Records the payout, and only against the lease and the exact graph the
     * owner signed: the submitted txid is the chain evidence. */
    recordReleased(
        advanceId: string,
        owner: string,
        token: string,
        releaseTxid: string,
        at: number,
    ): boolean {
        assertNativeAccess(this.db);
        txid(releaseTxid, "release txid");
        clock(at, "release clock");
        return this.db
            .transaction(() => {
                const changed = this.db
                    .prepare(
                        `UPDATE custody SET state = 'released', release_txid = ?, released_at = ?,
                         release_lease_owner = NULL, release_lease_token = NULL,
                         release_lease_until = NULL
                         WHERE advance_id = ? AND state = 'releasing' AND release_lease_owner = ?
                         AND release_lease_token = ? AND release_expected_txid = ?
                         AND swept_at IS NULL`,
                    )
                    .run(releaseTxid, at, advanceId, owner, token, releaseTxid).changes;
                if (changed !== 1) return false;
                this.db
                    .prepare("DELETE FROM custody_release_inputs WHERE advance_id = ?")
                    .run(advanceId);
                return true;
            })
            .immediate();
    }

    /** Returns the row to `held` and frees its coins, so a retry can re-claim it. */
    abandonRelease(advanceId: string, owner: string, token: string, at: number): void {
        assertNativeAccess(this.db);
        clock(at, "release clock");
        this.db
            .transaction(() => {
                const changed = this.db
                    .prepare(
                        `UPDATE custody SET state = 'held', release_lease_owner = NULL,
                         release_lease_token = NULL, release_lease_until = NULL,
                         release_expected_txid = NULL
                         WHERE advance_id = ? AND state = 'releasing' AND release_lease_owner = ?
                         AND release_lease_token = ?`,
                    )
                    .run(advanceId, owner, token).changes;
                if (changed === 1)
                    this.db
                        .prepare("DELETE FROM custody_release_inputs WHERE advance_id = ?")
                        .run(advanceId);
            })
            .immediate();
    }

    /**
     * `forfeit` is reached here and nowhere else, and only once the advertised
     * window has elapsed (spec 5.6 clauses 1 and 2). There is no coin to sweep,
     * so this is a write-off: a deliberate operator action, named on the row and
     * appended to the same audit trail every other operator action uses.
     */
    writeOff(advanceId: string, actor: string, at: number): void {
        assertNativeAccess(this.db);
        clock(at, "write-off clock");
        if (actor.trim() === "") throw new Error("custody: a write-off must name its actor");
        this.db
            .transaction(() => {
                const current = this.get(advanceId);
                if (!current) throw new CustodyError("custody_not_found", advanceId);
                if (current.sweptAt !== undefined)
                    throw new CustodySweptError(advanceId, current.sweptActor!, current.sweptAt);
                if (current.state === "released")
                    throw new CustodyError("custody_released", advanceId);
                if (current.state === "releasing")
                    throw new CustodyError("custody_release_in_progress", advanceId);
                if (at < current.expiresAt)
                    throw new CustodyError("custody_window_open", advanceId);
                const changed = this.db
                    .prepare(
                        `UPDATE custody SET state = 'forfeit', swept_actor = ?, swept_at = ?
                         WHERE advance_id = ? AND state = 'held' AND swept_at IS NULL`,
                    )
                    .run(actor, at, advanceId).changes;
                if (changed !== 1) throw new CustodyError("custody_release_in_progress", advanceId);
                new PolicyRepository(this.db).recordOperation("custody-write-off", actor);
            })
            .immediate();
    }

    /** Rows whose window ends within `withinSeconds`, for the operator alarm. */
    nearingWindow(at: number, withinSeconds: number): CustodyRecord[] {
        assertNativeAccess(this.db);
        return this.db
            .prepare<[number, number], Row>(
                `SELECT ${COLUMNS} FROM custody WHERE state IN ('held', 'releasing')
                 AND expires_at <= ? + ? ORDER BY expires_at, advance_id`,
            )
            .safeIntegers(true)
            .all(clock(at, "alarm clock"), withinSeconds)
            .map((row) => this.#decode(row));
    }

    #inputs(advanceId: string): Outpoint[] {
        return this.db
            .prepare<[string], { txid: string; vout: bigint }>(
                `SELECT outpoint_txid AS txid, outpoint_vout AS vout FROM custody_release_inputs
                 WHERE advance_id = ? ORDER BY txid, vout`,
            )
            .safeIntegers(true)
            .all(advanceId)
            .map(({ txid: t, vout }) => ({ txid: t, vout: Number(vout) }));
    }

    #decode(r: Row): CustodyRecord {
        return {
            advanceId: r.advance_id,
            ownerKey: Uint8Array.from(r.owner_key),
            ...(r.asset_txid !== null
                ? {
                      assetId: {
                          txid: Uint8Array.from(r.asset_txid),
                          groupIndex: Number(r.asset_group_index),
                      },
                      assetUnits: r.asset_units!,
                  }
                : {}),
            owedSats: r.owed_sats,
            loanSats: r.loan_sats,
            ...(r.fare_currency !== null
                ? { fare: { currency: r.fare_currency, units: r.fare_units! } }
                : {}),
            state: r.state,
            heldAt: Number(r.held_at),
            expiresAt: Number(r.expires_at),
            releaseInputs: r.state === "releasing" ? this.#inputs(r.advance_id) : [],
            ...(r.release_expected_txid !== null
                ? { releaseExpectedTxid: r.release_expected_txid }
                : {}),
            ...(r.release_lease_owner !== null && r.release_lease_token !== null
                ? {
                      releaseLease: {
                          owner: r.release_lease_owner,
                          token: r.release_lease_token,
                          until: Number(r.release_lease_until),
                      },
                  }
                : {}),
            ...(r.release_txid !== null
                ? { releaseTxid: r.release_txid, releasedAt: Number(r.released_at) }
                : {}),
            ...(r.swept_actor !== null
                ? { sweptActor: r.swept_actor, sweptAt: Number(r.swept_at) }
                : {}),
        };
    }
}
