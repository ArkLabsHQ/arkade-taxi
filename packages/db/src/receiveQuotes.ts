import type { Database } from "better-sqlite3";
import {
    resolveClaimMode,
    ruleFor,
    type ExpiryDeadline,
    type FareSpec,
    type Outpoint,
    type Advance,
} from "@arkade-taxi/core";
import { assertNativeAccess } from "./coordination.js";
import { AdvanceRepository } from "./advances.js";
import { PolicyRepository } from "./policy.js";
import { PolicyRevisionConflictError } from "./reservations.js";
import { SwapFillRepository, type SwapFill } from "./swapFills.js";

export type ReceiveQuoteState = "quoted" | "bound" | "expired";

export interface ReceiveQuoteParams {
    receiverKey: Uint8Array;
    senderKey: Uint8Array;
    operatorKey: Uint8Array;
    dust: bigint;
    topup: bigint;
    assetId: { txid: Uint8Array; groupIndex: number };
    locktime: bigint;
    claimMode: "recycle";
    recoveryRecipient: "receiver";
}

export interface ReceiveQuoteInputSnapshot extends Outpoint {
    value: bigint;
    tapTree: Uint8Array;
    spendLeaf: Uint8Array;
    assetPacket?: Uint8Array;
    expiry: ExpiryDeadline;
}

export interface ReceiveQuote {
    id: string;
    state: ReceiveQuoteState;
    receiverAddress: string;
    makerPublicKey: string;
    params: ReceiveQuoteParams;
    covenantAddress: string;
    fare: FareSpec;
    batchExpiry: ExpiryDeadline;
    inputExpiryFloor: ExpiryDeadline;
    recoveryLocktime: ExpiryDeadline;
    loanSats: bigint;
    createdAt: number;
    expiresAt: number;
    policyRevision: bigint;
    operatorInputs: ReceiveQuoteInputSnapshot[];
    boundFillId?: string;
}

export interface InsertReceiveQuoteRequest {
    quote: ReceiveQuote;
    expectedPolicyRevision: bigint;
    recoveryExecutionBudget: ExpiryDeadline;
    expectedReservedOutpoints?: readonly Outpoint[];
}

export interface BindReceiveQuoteRequest {
    quoteId: string;
    fill: SwapFill;
    advance: Advance;
    expectedPolicyRevision: bigint;
    now: number;
}

export class ReceiveQuoteReservationConflictError extends Error {
    constructor() {
        super("receive quote: operator input already reserved");
        this.name = "ReceiveQuoteReservationConflictError";
    }
}

type Row = {
    id: string;
    state: string;
    receiver_address: string;
    maker_public_key: string;
    params_json: string;
    covenant_address: string;
    fare_json: string;
    batch_expiry_kind: string;
    batch_expiry_value: bigint;
    input_expiry_floor_kind: string;
    input_expiry_floor_value: bigint;
    recovery_locktime_kind: string;
    recovery_locktime_value: bigint;
    loan_sats: bigint;
    created_at: bigint;
    expires_at: bigint;
    policy_revision: bigint;
    operator_inputs_json: string;
    bound_fill_id: string | null;
};

const HEX = /^[0-9a-f]*$/;
const DECIMAL = /^(0|[1-9][0-9]*)$/;

const fail = (field: string): never => {
    throw new Error(`receive quote: invalid ${field}`);
};

const object = (value: unknown, field: string): Record<string, unknown> => {
    if (!value || typeof value !== "object" || Array.isArray(value)) fail(field);
    return value as Record<string, unknown>;
};

const exact = (
    value: Record<string, unknown>,
    required: readonly string[],
    optional: readonly string[],
    field: string,
): void => {
    const allowed = new Set([...required, ...optional]);
    if (required.some((key) => !Object.prototype.hasOwnProperty.call(value, key))) fail(field);
    if (Object.keys(value).some((key) => !allowed.has(key))) fail(field);
};

const hex = (value: Uint8Array): string =>
    Array.from(value, (byte) => byte.toString(16).padStart(2, "0")).join("");

const bytes = (value: unknown, size: number, field: string): Uint8Array => {
    if (typeof value !== "string" || value.length !== size * 2 || !HEX.test(value)) fail(field);
    const encoded = value as string;
    return Uint8Array.from({ length: size }, (_, i) =>
        Number.parseInt(encoded.slice(i * 2, i * 2 + 2), 16),
    );
};

const amount = (value: unknown, field: string): bigint => {
    if (typeof value !== "string" || !DECIMAL.test(value)) fail(field);
    return BigInt(value as string);
};

const safeNumber = (value: bigint, field: string): number => {
    const n = Number(value);
    if (!Number.isSafeInteger(n) || n < 0) fail(field);
    return n;
};

const deadline = (kind: unknown, value: unknown, field: string): ExpiryDeadline => {
    if (kind !== "height" && kind !== "time") fail(field);
    const parsed = typeof value === "bigint" ? value : amount(value, field);
    if (parsed <= 0n) fail(field);
    return { kind: kind as "height" | "time", value: parsed };
};

const encodeParams = (params: ReceiveQuoteParams): string =>
    JSON.stringify({
        receiverKey: hex(params.receiverKey),
        senderKey: hex(params.senderKey),
        operatorKey: hex(params.operatorKey),
        dust: params.dust.toString(10),
        topup: params.topup.toString(10),
        assetId: { txid: hex(params.assetId.txid), groupIndex: params.assetId.groupIndex },
        locktime: params.locktime.toString(10),
        claimMode: params.claimMode,
        recoveryRecipient: params.recoveryRecipient,
    });

const decodeParams = (json: string): ReceiveQuoteParams => {
    const value = object(JSON.parse(json), "params");
    exact(
        value,
        [
            "receiverKey",
            "senderKey",
            "operatorKey",
            "dust",
            "topup",
            "assetId",
            "locktime",
            "claimMode",
            "recoveryRecipient",
        ],
        [],
        "params",
    );
    const asset = object(value.assetId, "params.assetId");
    exact(asset, ["txid", "groupIndex"], [], "params.assetId");
    if (!Number.isSafeInteger(asset.groupIndex) || Number(asset.groupIndex) < 0)
        fail("params.assetId");
    if (value.claimMode !== "recycle" || value.recoveryRecipient !== "receiver") fail("params");
    return {
        receiverKey: bytes(value.receiverKey, 32, "params.receiverKey"),
        senderKey: bytes(value.senderKey, 32, "params.senderKey"),
        operatorKey: bytes(value.operatorKey, 32, "params.operatorKey"),
        dust: amount(value.dust, "params.dust"),
        topup: amount(value.topup, "params.topup"),
        assetId: {
            txid: bytes(asset.txid, 32, "params.assetId.txid"),
            groupIndex: Number(asset.groupIndex),
        },
        locktime: amount(value.locktime, "params.locktime"),
        claimMode: "recycle",
        recoveryRecipient: "receiver",
    };
};

const encodeFare = (fare: FareSpec): string => {
    if (fare.currency !== "sats") fail("fare");
    return JSON.stringify({ currency: "sats", units: fare.units.toString(10) });
};

const decodeFare = (json: string): FareSpec => {
    const value = object(JSON.parse(json), "fare");
    exact(value, ["currency", "units"], [], "fare");
    if (value.currency !== "sats") fail("fare");
    return { currency: "sats", units: amount(value.units, "fare.units") };
};

const encodeInputs = (inputs: readonly ReceiveQuoteInputSnapshot[]): string =>
    JSON.stringify(
        inputs.map((input) => ({
            txid: input.txid,
            vout: input.vout,
            value: input.value.toString(10),
            tapTree: hex(input.tapTree),
            spendLeaf: hex(input.spendLeaf),
            expiry: { kind: input.expiry.kind, value: input.expiry.value.toString(10) },
            ...(input.assetPacket ? { assetPacket: hex(input.assetPacket) } : {}),
        })),
    );

const decodeInputs = (json: string): ReceiveQuoteInputSnapshot[] => {
    const parsed: unknown = JSON.parse(json);
    if (!Array.isArray(parsed) || !parsed.length) fail("operator inputs");
    const seen = new Set<string>();
    return (parsed as unknown[]).map((raw, index) => {
        const field = `operator inputs[${index}]`;
        const value = object(raw, field);
        exact(
            value,
            ["txid", "vout", "value", "tapTree", "spendLeaf", "expiry"],
            ["assetPacket"],
            field,
        );
        if (typeof value.txid !== "string" || value.txid.length !== 64 || !HEX.test(value.txid))
            fail(field);
        if (
            !Number.isSafeInteger(value.vout) ||
            Number(value.vout) < 0 ||
            Number(value.vout) > 0xffff_ffff
        )
            fail(field);
        const txid = value.txid as string;
        const key = `${txid}:${value.vout}`;
        if (seen.has(key)) fail(field);
        seen.add(key);
        const expiry = object(value.expiry, `${field}.expiry`);
        exact(expiry, ["kind", "value"], [], `${field}.expiry`);
        const input: ReceiveQuoteInputSnapshot = {
            txid,
            vout: Number(value.vout),
            value: amount(value.value, `${field}.value`),
            tapTree: bytes(value.tapTree, String(value.tapTree).length / 2, `${field}.tapTree`),
            spendLeaf: bytes(
                value.spendLeaf,
                String(value.spendLeaf).length / 2,
                `${field}.spendLeaf`,
            ),
            expiry: deadline(expiry.kind, expiry.value, `${field}.expiry`),
        };
        if (!input.tapTree.length || !input.spendLeaf.length || input.value <= 0n) fail(field);
        if (value.assetPacket !== undefined) {
            input.assetPacket = bytes(
                value.assetPacket,
                String(value.assetPacket).length / 2,
                `${field}.assetPacket`,
            );
            if (!input.assetPacket.length) fail(field);
        }
        return input;
    });
};

const decodeRow = (row: Row): ReceiveQuote => {
    if (row.state !== "quoted" && row.state !== "bound" && row.state !== "expired") fail("state");
    if (!row.receiver_address || !/^[0-9a-f]{64}$/.test(row.maker_public_key)) fail("identity");
    const params = decodeParams(row.params_json);
    const fare = decodeFare(row.fare_json);
    const batchExpiry = deadline(row.batch_expiry_kind, row.batch_expiry_value, "batch expiry");
    const inputExpiryFloor = deadline(
        row.input_expiry_floor_kind,
        row.input_expiry_floor_value,
        "input expiry floor",
    );
    const recoveryLocktime = deadline(
        row.recovery_locktime_kind,
        row.recovery_locktime_value,
        "recovery locktime",
    );
    const operatorInputs = decodeInputs(row.operator_inputs_json);
    if (
        hex(params.senderKey) !== row.maker_public_key ||
        params.topup !== row.loan_sats ||
        params.dust <= params.topup ||
        params.locktime !== recoveryLocktime.value ||
        batchExpiry.kind !== inputExpiryFloor.kind ||
        inputExpiryFloor.kind !== recoveryLocktime.kind ||
        batchExpiry.value < inputExpiryFloor.value ||
        inputExpiryFloor.value <= recoveryLocktime.value ||
        operatorInputs.some(
            (input) =>
                input.assetPacket !== undefined ||
                input.expiry.kind !== batchExpiry.kind ||
                input.expiry.value < batchExpiry.value,
        ) ||
        operatorInputs.reduce(
            (minimum, input) => (input.expiry.value < minimum ? input.expiry.value : minimum),
            operatorInputs[0]!.expiry.value,
        ) !== batchExpiry.value ||
        row.expires_at <= row.created_at ||
        (row.state === "bound") !== (row.bound_fill_id !== null)
    )
        fail("economics");
    return {
        id: row.id,
        state: row.state as ReceiveQuoteState,
        receiverAddress: row.receiver_address,
        makerPublicKey: row.maker_public_key,
        params,
        covenantAddress: row.covenant_address,
        fare,
        batchExpiry,
        inputExpiryFloor,
        recoveryLocktime,
        loanSats: row.loan_sats,
        createdAt: safeNumber(row.created_at, "createdAt"),
        expiresAt: safeNumber(row.expires_at, "expiresAt"),
        policyRevision: row.policy_revision,
        operatorInputs,
        ...(row.bound_fill_id === null ? {} : { boundFillId: row.bound_fill_id }),
    };
};

export class ReceiveQuoteRepository {
    readonly #policy: PolicyRepository;

    constructor(private readonly db: Database) {
        assertNativeAccess(db);
        this.#policy = new PolicyRepository(db);
    }

    insert(request: InsertReceiveQuoteRequest): void {
        assertNativeAccess(this.db);
        const q = decodeRow({
            id: request.quote.id,
            state: request.quote.state,
            receiver_address: request.quote.receiverAddress,
            maker_public_key: request.quote.makerPublicKey,
            params_json: encodeParams(request.quote.params),
            covenant_address: request.quote.covenantAddress,
            fare_json: encodeFare(request.quote.fare),
            batch_expiry_kind: request.quote.batchExpiry.kind,
            batch_expiry_value: request.quote.batchExpiry.value,
            input_expiry_floor_kind: request.quote.inputExpiryFloor.kind,
            input_expiry_floor_value: request.quote.inputExpiryFloor.value,
            recovery_locktime_kind: request.quote.recoveryLocktime.kind,
            recovery_locktime_value: request.quote.recoveryLocktime.value,
            loan_sats: request.quote.loanSats,
            created_at: BigInt(request.quote.createdAt),
            expires_at: BigInt(request.quote.expiresAt),
            policy_revision: request.quote.policyRevision,
            operator_inputs_json: encodeInputs(request.quote.operatorInputs),
            bound_fill_id: request.quote.boundFillId ?? null,
        });
        if (q.state !== "quoted" || q.boundFillId !== undefined) fail("state");
        this.db
            .transaction(() => {
                this.#expire(q.createdAt);
                this.#expireSwap(q.createdAt);
                const { policy, revision } = this.#policy.getSnapshot();
                if (
                    revision !== request.expectedPolicyRevision ||
                    q.policyRevision !== request.expectedPolicyRevision
                )
                    throw new PolicyRevisionConflictError();
                if (policy.paused) throw new Error("receive quote: paused");
                const rule = ruleFor(policy.assetRules, q.params.assetId);
                if (!rule?.enabled) throw new Error("receive quote: asset not served");
                if (typeof resolveClaimMode(rule.claim, "recycle") !== "string")
                    throw new Error("receive quote: recycle not allowed");
                const cap = rule.maxTopupSats ?? policy.maxPerPaymentTopupSats;
                if (q.loanSats > cap)
                    throw new Error("receive quote: loan exceeds per-payment limit");
                const budget = request.recoveryExecutionBudget;
                const margin = BigInt(
                    q.batchExpiry.kind === "height"
                        ? policy.locktimeMarginBlocks
                        : policy.locktimeMarginSeconds,
                );
                if (
                    budget.kind !== q.recoveryLocktime.kind ||
                    budget.value < 0n ||
                    margin <= budget.value ||
                    q.recoveryLocktime.value + budget.value >= q.inputExpiryFloor.value ||
                    q.inputExpiryFloor.value - q.recoveryLocktime.value !== margin
                )
                    throw new Error("receive quote: recovery execution budget is unsafe");
                const current = this.#allReserved();
                if (request.expectedReservedOutpoints) {
                    const expected = new Set(
                        request.expectedReservedOutpoints.map(
                            ({ txid, vout }) => `${txid}:${vout}`,
                        ),
                    );
                    if (
                        current.length !== expected.size ||
                        current.some(({ txid, vout }) => !expected.has(`${txid}:${vout}`))
                    )
                        throw new ReceiveQuoteReservationConflictError();
                }
                const exposure = this.#exposure();
                if (exposure.total + q.loanSats > policy.maxOutstandingSats)
                    throw new Error("receive quote: exceeds max outstanding");
                if (exposure.count >= BigInt(policy.maxConcurrentAdvances))
                    throw new Error("receive quote: max concurrent advances");
                const held = new Set(current.map(({ txid, vout }) => `${txid}:${vout}`));
                if (q.operatorInputs.some(({ txid, vout }) => held.has(`${txid}:${vout}`)))
                    throw new ReceiveQuoteReservationConflictError();
                this.db
                    .prepare(
                        `INSERT INTO receive_quotes (
                            id, state, receiver_address, maker_public_key, params_json,
                            covenant_address, fare_json, batch_expiry_kind, batch_expiry_value,
                            input_expiry_floor_kind, input_expiry_floor_value,
                            recovery_locktime_kind, recovery_locktime_value, loan_sats, created_at,
                            expires_at, policy_revision, operator_inputs_json, bound_fill_id
                        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                    )
                    .run(
                        q.id,
                        q.state,
                        q.receiverAddress,
                        q.makerPublicKey,
                        encodeParams(q.params),
                        q.covenantAddress,
                        encodeFare(q.fare),
                        q.batchExpiry.kind,
                        q.batchExpiry.value,
                        q.inputExpiryFloor.kind,
                        q.inputExpiryFloor.value,
                        q.recoveryLocktime.kind,
                        q.recoveryLocktime.value,
                        q.loanSats,
                        q.createdAt,
                        q.expiresAt,
                        q.policyRevision,
                        encodeInputs(q.operatorInputs),
                        null,
                    );
                const reserve = this.db.prepare(
                    "INSERT INTO receive_quote_reservations (outpoint_txid, outpoint_vout, quote_id, created_at) VALUES (?, ?, ?, ?)",
                );
                for (const input of q.operatorInputs)
                    reserve.run(input.txid, input.vout, q.id, q.createdAt);
            })
            .immediate();
    }

    bind(request: BindReceiveQuoteRequest): void {
        assertNativeAccess(this.db);
        if (!Number.isSafeInteger(request.now) || request.now < 0) fail("binding clock");
        this.db
            .transaction(() => {
                this.#expire(request.now);
                this.#expireSwap(request.now);
                const quote = this.get(request.quoteId);
                if (!quote || quote.state !== "quoted" || quote.boundFillId !== undefined)
                    throw new Error("receive quote: state is not bindable");
                const { policy, revision } = this.#policy.getSnapshot();
                if (
                    revision !== request.expectedPolicyRevision ||
                    quote.policyRevision !== revision
                )
                    throw new PolicyRevisionConflictError();
                if (policy.paused) throw new Error("receive quote: paused");
                const { fill, advance } = request;
                const sameOutpoints = (actual: readonly Outpoint[]) =>
                    actual.length === quote.operatorInputs.length &&
                    actual.every(
                        (input, index) =>
                            input.txid === quote.operatorInputs[index]!.txid &&
                            input.vout === quote.operatorInputs[index]!.vout,
                    );
                const sameBytes = (first: Uint8Array, second: Uint8Array) =>
                    first.length === second.length &&
                    first.every((byte, index) => byte === second[index]);
                if (
                    fill.receiveQuoteId !== quote.id ||
                    advance.id !== quote.id ||
                    advance.state !== "locking" ||
                    fill.state !== "quoted" ||
                    fill.contributionSats !== quote.loanSats ||
                    fill.fare.currency !== "sats" ||
                    fill.fare.units !== quote.fare.units ||
                    advance.topup !== quote.loanSats ||
                    advance.dust !== quote.params.dust ||
                    advance.assetUnits === undefined ||
                    advance.assetUnits <= 0n ||
                    !advance.assetId ||
                    !sameBytes(advance.receiverKey, quote.params.receiverKey) ||
                    !sameBytes(advance.senderKey, quote.params.senderKey) ||
                    !sameBytes(advance.operatorKey, quote.params.operatorKey) ||
                    !sameBytes(advance.assetId.txid, quote.params.assetId.txid) ||
                    advance.assetId.groupIndex !== quote.params.assetId.groupIndex ||
                    advance.locktime !== quote.params.locktime ||
                    advance.covenantAddress !== quote.covenantAddress ||
                    advance.fare.currency !== "sats" ||
                    advance.fare.units !== quote.fare.units ||
                    advance.recoveryLocktime?.kind !== quote.recoveryLocktime.kind ||
                    advance.recoveryLocktime.value !== quote.recoveryLocktime.value ||
                    advance.batchExpiry.kind !== quote.batchExpiry.kind ||
                    advance.batchExpiry.value < quote.inputExpiryFloor.value ||
                    advance.expiresAt !== fill.expiresAt ||
                    !sameOutpoints(fill.taxiInputs) ||
                    !sameOutpoints(advance.operatorInputs)
                )
                    throw new Error("receive quote: bound economics mismatch");
                this.db
                    .prepare("DELETE FROM receive_quote_reservations WHERE quote_id = ?")
                    .run(quote.id);
                new SwapFillRepository(this.db).insert(fill);
                this.db
                    .prepare("DELETE FROM swap_fill_reservations WHERE fill_id = ?")
                    .run(fill.id);
                new AdvanceRepository(this.db).insert(advance);
                const reserve = this.db.prepare(
                    "INSERT INTO operator_input_reservations (outpoint_txid, outpoint_vout, advance_id, batch_expiry_kind, batch_expiry_value, created_at) VALUES (?, ?, ?, ?, ?, ?)",
                );
                for (const input of quote.operatorInputs)
                    reserve.run(
                        input.txid,
                        input.vout,
                        advance.id,
                        quote.batchExpiry.kind,
                        quote.batchExpiry.value,
                        request.now,
                    );
                const changed = this.db
                    .prepare(
                        "UPDATE receive_quotes SET state = 'bound', bound_fill_id = ? WHERE id = ? AND state = 'quoted' AND bound_fill_id IS NULL",
                    )
                    .run(fill.id, quote.id).changes;
                if (changed !== 1) throw new Error("receive quote: binding race");
            })
            .immediate();
    }

    get(id: string): ReceiveQuote | undefined {
        assertNativeAccess(this.db);
        const row = this.db
            .prepare<[string], Row>("SELECT * FROM receive_quotes WHERE id = ?")
            .safeIntegers(true)
            .get(id);
        if (!row) return undefined;
        const quote = decodeRow(row);
        const table =
            quote.state === "bound" ? "operator_input_reservations" : "receive_quote_reservations";
        const owner = quote.state === "bound" ? "advance_id" : "quote_id";
        const reservations = this.db
            .prepare<[string], { txid: string; vout: bigint }>(
                `SELECT outpoint_txid AS txid, outpoint_vout AS vout FROM ${table} WHERE ${owner} = ? ORDER BY txid, vout`,
            )
            .safeIntegers(true)
            .all(id);
        const expected = new Set(quote.operatorInputs.map(({ txid, vout }) => `${txid}:${vout}`));
        const boundAdvanceState =
            quote.state === "bound"
                ? this.db
                      .prepare<[string], { state: string }>(
                          "SELECT state FROM advances WHERE id = ?",
                      )
                      .get(id)?.state
                : undefined;
        const expectsReservations =
            quote.state === "quoted" ||
            (quote.state === "bound" &&
                boundAdvanceState !== undefined &&
                ["locking", "locked", "recovering"].includes(boundAdvanceState));
        if (
            (!expectsReservations && reservations.length !== 0) ||
            (expectsReservations &&
                (reservations.length !== expected.size ||
                    reservations.some(
                        ({ txid, vout }) => !expected.has(`${txid}:${Number(vout)}`),
                    ))) ||
            (quote.state === "bound" && boundAdvanceState === undefined)
        )
            fail("reservations");
        return quote;
    }

    exposureTotals(): { outstandingSats: bigint; activeCount: number } {
        assertNativeAccess(this.db);
        const row = this.db
            .prepare<[], { total: bigint; count: bigint }>(
                "SELECT coalesce(sum(loan_sats), 0) AS total, count(*) AS count FROM receive_quotes WHERE state = 'quoted'",
            )
            .safeIntegers(true)
            .get()!;
        return { outstandingSats: row.total, activeCount: Number(row.count) };
    }

    listReservedOutpoints(): Outpoint[] {
        assertNativeAccess(this.db);
        return this.db
            .prepare<[], { txid: string; vout: bigint }>(
                "SELECT outpoint_txid AS txid, outpoint_vout AS vout FROM receive_quote_reservations ORDER BY txid, vout",
            )
            .safeIntegers(true)
            .all()
            .map(({ txid, vout }) => ({ txid, vout: Number(vout) }));
    }

    expireQuotes(at: number): number {
        assertNativeAccess(this.db);
        if (!Number.isSafeInteger(at) || at < 0) fail("expiry clock");
        return this.db.transaction(() => this.#expire(at)).immediate();
    }

    #expire(at: number): number {
        const expired = this.db
            .prepare(
                "UPDATE receive_quotes SET state = 'expired' WHERE state = 'quoted' AND expires_at <= ?",
            )
            .run(at).changes;
        this.db
            .prepare(
                "DELETE FROM receive_quote_reservations WHERE quote_id IN (SELECT id FROM receive_quotes WHERE state = 'expired' AND expires_at <= ?)",
            )
            .run(at);
        return Number(expired);
    }

    #expireSwap(at: number): void {
        this.db
            .prepare(
                "UPDATE swap_fills SET state = 'expired', updated_at = max(updated_at, ?) WHERE state = 'quoted' AND receive_quote_id IS NULL AND expires_at <= ?",
            )
            .run(at, at);
        this.db
            .prepare(
                "DELETE FROM swap_fill_reservations WHERE fill_id IN (SELECT id FROM swap_fills WHERE state = 'expired' AND expires_at <= ?)",
            )
            .run(at);
    }

    #allReserved(): Outpoint[] {
        return this.db
            .prepare<[], { txid: string; vout: bigint }>(
                `SELECT outpoint_txid AS txid, outpoint_vout AS vout FROM operator_input_reservations
                 UNION ALL SELECT outpoint_txid, outpoint_vout FROM proceeds_inputs
                 UNION ALL SELECT outpoint_txid, outpoint_vout FROM swap_fill_reservations
                 UNION ALL SELECT outpoint_txid, outpoint_vout FROM receive_quote_reservations
                 ORDER BY txid, vout`,
            )
            .safeIntegers(true)
            .all()
            .map(({ txid, vout }) => ({ txid, vout: Number(vout) }));
    }

    #exposure(): { total: bigint; count: bigint } {
        return this.db
            .prepare<[], { total: bigint; count: bigint }>(
                `SELECT
                    (SELECT coalesce(sum(topup), 0) FROM advances
                     WHERE state = 'locking' OR (kind = 'covenant' AND state IN ('locked', 'recovering')))
                    + (SELECT coalesce(sum(contribution_sats), 0) FROM swap_fills
                       WHERE state IN ('quoted', 'submitting') AND receive_quote_id IS NULL)
                    + (SELECT coalesce(sum(loan_sats), 0) FROM receive_quotes WHERE state = 'quoted') AS total,
                    (SELECT count(*) FROM advances
                     WHERE state = 'locking' OR (kind = 'covenant' AND state IN ('locked', 'recovering')))
                    + (SELECT count(*) FROM swap_fills
                       WHERE state IN ('quoted', 'submitting') AND receive_quote_id IS NULL)
                    + (SELECT count(*) FROM receive_quotes WHERE state = 'quoted') AS count`,
            )
            .safeIntegers(true)
            .get()!;
    }
}
