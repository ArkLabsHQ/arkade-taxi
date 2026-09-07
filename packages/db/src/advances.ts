import type { Database, Statement } from "better-sqlite3";
import type { Advance, AdvanceState, Outpoint } from "@arkade-taxi/core";

const COLUMNS = [
    "id",
    "state",
    "receiver_key",
    "sender_key",
    "operator_key",
    "dust",
    "topup",
    "asset_txid",
    "asset_group_index",
    "locktime",
    "covenant_address",
    "fee_sats",
    "outpoint_txid",
    "outpoint_vout",
    "spent_txid",
    "created_at",
    "updated_at",
    "expires_at",
] as const;

type AdvanceParams = Record<(typeof COLUMNS)[number], string | number | bigint | Uint8Array | null>;

interface AdvanceRow {
    id: string;
    state: AdvanceState;
    receiver_key: Buffer;
    sender_key: Buffer;
    operator_key: Buffer;
    dust: bigint;
    topup: bigint;
    asset_txid: Buffer | null;
    asset_group_index: bigint | null;
    locktime: bigint;
    covenant_address: string;
    fee_sats: bigint;
    outpoint_txid: string | null;
    outpoint_vout: bigint | null;
    spent_txid: string | null;
    created_at: bigint;
    updated_at: bigint;
    expires_at: bigint;
}

const INSERT_SQL = `INSERT INTO advances (${COLUMNS.join(", ")})
    VALUES (${COLUMNS.map((c) => `@${c}`).join(", ")})`;

const UPDATE_SQL = `UPDATE advances SET ${COLUMNS.filter((c) => c !== "id")
    .map((c) => `${c} = @${c}`)
    .join(", ")} WHERE id = @id`;

/** Copies out of the pooled Buffer: `.buffer` on it is 8KB of unrelated rows. */
const bytes = (b: Buffer): Uint8Array => Uint8Array.from(b);

function toParams(a: Advance): AdvanceParams {
    return {
        id: a.id,
        state: a.state,
        receiver_key: a.receiverKey,
        sender_key: a.senderKey,
        operator_key: a.operatorKey,
        dust: a.dust,
        topup: a.topup,
        asset_txid: a.assetId?.txid ?? null,
        asset_group_index: a.assetId?.groupIndex ?? null,
        locktime: a.locktime,
        covenant_address: a.covenantAddress,
        fee_sats: a.feeSats,
        outpoint_txid: a.outpoint?.txid ?? null,
        outpoint_vout: a.outpoint?.vout ?? null,
        spent_txid: a.spentTxid ?? null,
        created_at: a.createdAt,
        updated_at: a.updatedAt,
        expires_at: a.expiresAt,
    };
}

// Optional fields are left absent rather than set to null: the domain contract
// says `undefined`. Timestamps and indices are narrowed back to `number`, which
// safeIntegers would otherwise hand back as BigInt.
function fromRow(r: AdvanceRow): Advance {
    const a: Advance = {
        id: r.id,
        state: r.state,
        receiverKey: bytes(r.receiver_key),
        senderKey: bytes(r.sender_key),
        operatorKey: bytes(r.operator_key),
        dust: r.dust,
        topup: r.topup,
        locktime: r.locktime,
        covenantAddress: r.covenant_address,
        feeSats: r.fee_sats,
        createdAt: Number(r.created_at),
        updatedAt: Number(r.updated_at),
        expiresAt: Number(r.expires_at),
    };
    if (r.asset_txid !== null) {
        a.assetId = { txid: bytes(r.asset_txid), groupIndex: Number(r.asset_group_index) };
    }
    if (r.outpoint_txid !== null) {
        a.outpoint = { txid: r.outpoint_txid, vout: Number(r.outpoint_vout) };
    }
    if (r.spent_txid !== null) a.spentTxid = r.spent_txid;
    return a;
}

export class AdvanceRepository {
    readonly #insert: Statement<[AdvanceParams]>;
    readonly #update: Statement<[AdvanceParams]>;
    readonly #get: Statement<[string], AdvanceRow>;
    readonly #byState: Statement<[AdvanceState], AdvanceRow>;
    readonly #byOutpoint: Statement<[string, number], AdvanceRow>;
    readonly #sweepable: Statement<[bigint], AdvanceRow>;
    readonly #sumTopup: Statement<[AdvanceState], { total: bigint | null }>;

    constructor(db: Database) {
        // Per statement, not per connection: a caller's Database default must not
        // decide whether a sats value survives above 2^53.
        const read = <B extends unknown[], R>(sql: string): Statement<B, R> =>
            db.prepare<B, R>(sql).safeIntegers(true);

        this.#insert = db.prepare(INSERT_SQL);
        this.#update = db.prepare(UPDATE_SQL);
        this.#get = read("SELECT * FROM advances WHERE id = ?");
        this.#byState = read("SELECT * FROM advances WHERE state = ?");
        this.#byOutpoint = read(
            "SELECT * FROM advances WHERE outpoint_txid = ? AND outpoint_vout = ?",
        );
        this.#sweepable = read(
            `SELECT * FROM advances WHERE state = 'locked' AND locktime <= ?
             ORDER BY locktime ASC, id ASC`,
        );
        this.#sumTopup = read("SELECT sum(topup) AS total FROM advances WHERE state = ?");
    }

    insert(a: Advance): void {
        this.#insert.run(toParams(a));
    }

    get(id: string): Advance | undefined {
        const row = this.#get.get(id);
        return row && fromRow(row);
    }

    byState(s: AdvanceState): Advance[] {
        return this.#byState.all(s).map(fromRow);
    }

    byOutpoint(o: Outpoint): Advance | undefined {
        const row = this.#byOutpoint.get(o.txid, o.vout);
        return row && fromRow(row);
    }

    update(a: Advance): void {
        if (this.#update.run(toParams(a)).changes === 0) {
            throw new Error(`advance ${a.id} not found`);
        }
    }

    listSweepable(currentHeight: bigint): Advance[] {
        return this.#sweepable.all(currentHeight).map(fromRow);
    }

    sumTopupByState(s: AdvanceState): bigint {
        return this.#sumTopup.get(s)?.total ?? 0n;
    }
}
