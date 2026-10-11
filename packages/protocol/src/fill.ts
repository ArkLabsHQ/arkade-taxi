/**
 * `/v1/fills`: the caller hands over a complete graph and declares only what the
 * Taxi cannot derive from it. Every input outpoint comes from the checkpoints, so
 * there is no `foreignInputs` array to disagree with.
 */
export interface FillRequestBody {
    /** Idempotency key. A replay under different terms is a conflict. */
    operationId: string;
    /** The receive quote whose covenant and reservation this fills. */
    quoteId: string;
    /** base64 PSBT; every non-Taxi input signed, the Taxi's left unsigned. */
    arkTx: string;
    /** base64 PSBTs, one per arkTx input, index-aligned. */
    checkpoints: string[];
    taxiInputIndexes: number[];
    covenantOutputIndex: number;
    /** Decimal; the units the covenant output must carry. */
    assetUnits: string;
    /** Unix seconds; the caller's own ceiling on this fill. */
    validUntil?: number;
}

export type FillState = "submitting" | "settled" | "expired" | "cancelled";

/** No PSBT bytes: the caller never holds a Taxi-signed graph (V13). */
export interface FillStatusResponse {
    fillId: string;
    operationId: string;
    state: FillState;
    txid?: string;
    outpoint?: { txid: string; vout: number };
    spentTxid?: string;
    failureCode?: string;
    updatedAt: number;
    expiresAt: number;
}

const fail = (field: string, detail: string): never => {
    throw new Error(`fill ${field}: ${detail}`);
};

const nonEmpty = (value: unknown, field: string): string => {
    if (typeof value !== "string" || value.length === 0 || value.length > 128)
        return fail(field, "expected a bounded non-empty string");
    return value;
};

const canonicalTxid = (value: unknown, field: string): string => {
    if (typeof value !== "string" || !/^[0-9a-f]{64}$/.test(value))
        return fail(field, "expected 32-byte lowercase hex");
    return value;
};

/** Strict: an unknown key is a refusal, so a field added server-side cannot be
 * silently ignored by a client that has not been re-vendored. */
export function fillStatusFromWire(body: unknown): FillStatusResponse {
    if (!body || typeof body !== "object" || Array.isArray(body)) fail("status", "expected object");
    const b = body as Record<string, unknown>;
    const known = [
        "fillId",
        "operationId",
        "state",
        "txid",
        "outpoint",
        "spentTxid",
        "failureCode",
        "updatedAt",
        "expiresAt",
    ];
    for (const key of Object.keys(b))
        if (!known.includes(key)) fail("status", `unexpected field ${JSON.stringify(key)}`);
    const states: readonly string[] = ["submitting", "settled", "expired", "cancelled"];
    if (typeof b.state !== "string" || !states.includes(b.state))
        fail("state", `unknown state ${JSON.stringify(b.state)}`);
    for (const field of ["updatedAt", "expiresAt"] as const)
        if (!Number.isSafeInteger(b[field]) || (b[field] as number) < 0)
            fail(field, "invalid time");
    const out: FillStatusResponse = {
        fillId: nonEmpty(b.fillId, "fillId"),
        operationId: nonEmpty(b.operationId, "operationId"),
        state: b.state as FillState,
        updatedAt: b.updatedAt as number,
        expiresAt: b.expiresAt as number,
    };
    if (b.txid !== undefined) out.txid = canonicalTxid(b.txid, "txid");
    if (b.outpoint !== undefined) {
        const point = b.outpoint as { txid?: unknown; vout?: unknown };
        if (!point || typeof point !== "object") fail("outpoint", "expected object");
        if (!Number.isSafeInteger(point.vout) || (point.vout as number) < 0)
            fail("outpoint.vout", "expected a non-negative integer");
        out.outpoint = {
            txid: canonicalTxid(point.txid, "outpoint.txid"),
            vout: point.vout as number,
        };
    }
    if (b.spentTxid !== undefined) out.spentTxid = canonicalTxid(b.spentTxid, "spentTxid");
    if (b.failureCode !== undefined) out.failureCode = nonEmpty(b.failureCode, "failureCode");
    return out;
}

export function fillRequestToWire(req: {
    operationId: string;
    quoteId: string;
    arkTx: string;
    checkpoints: readonly string[];
    taxiInputIndexes: readonly number[];
    covenantOutputIndex: number;
    assetUnits: bigint;
    validUntil?: number;
}): FillRequestBody {
    if (!req.checkpoints.length) fail("checkpoints", "expected at least one");
    if (!req.taxiInputIndexes.length) fail("taxiInputIndexes", "expected at least one");
    if (new Set(req.taxiInputIndexes).size !== req.taxiInputIndexes.length)
        fail("taxiInputIndexes", "repeats an index");
    if (req.assetUnits <= 0n) fail("assetUnits", "expected a positive amount");
    if (!Number.isSafeInteger(req.covenantOutputIndex) || req.covenantOutputIndex < 0)
        fail("covenantOutputIndex", "expected a non-negative integer");
    return {
        operationId: nonEmpty(req.operationId, "operationId"),
        quoteId: nonEmpty(req.quoteId, "quoteId"),
        arkTx: req.arkTx,
        checkpoints: [...req.checkpoints],
        taxiInputIndexes: [...req.taxiInputIndexes],
        covenantOutputIndex: req.covenantOutputIndex,
        assetUnits: req.assetUnits.toString(10),
        ...(req.validUntil === undefined ? {} : { validUntil: req.validUntil }),
    };
}
