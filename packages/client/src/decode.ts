/**
 * Wire JSON in, domain values out. Everything here treats its input as
 * `unknown` in practice — it arrives from `JSON.parse` on an operator's
 * response — so each field is checked rather than asserted.
 */

import type {
    AssetIdWire,
    AssetRuleWire,
    ClaimsChangedEvent,
    ClaimsSnapshotResponse,
    FareWire,
    QuoteParams,
    ReceiverClaimDescriptorWire,
    ReceiverClaimState,
    ReceiverClaimWire,
    TaggedLocktimeWire,
} from "@arkade-taxi/protocol";
import {
    assetIdFromWire,
    fareFromWire,
    hexToBytes,
    quoteParamsFromWire,
    satsFromWire,
    type AssetIdValue,
    type CovenantParamsValue,
    type InfoResponse,
    type LockupResponse,
    type QuoteResponse,
    type TransferStatusResponse,
} from "@arkade-taxi/protocol";
import { ClientErrorCode, TaxiError } from "./errors.js";

export interface DecodedInfo {
    protocolVersion: number;
    operatorKey: Uint8Array;
    serverKey: Uint8Array;
    emulatorKey: Uint8Array;
    arkdUrl: string;
    emulatorUrl: string;
    dust: bigint;
    vtxoMinAmount: bigint;
    /** Left in wire form: a client accepts a fare by id and re-derives nothing
     * from the terms, so decoding them would be validation with no consumer. */
    assetRules: AssetRuleWire[];
    maxPerPaymentTopupSats: bigint;
    paused: boolean;
}

export interface DecodedQuote {
    transferId: string;
    params: CovenantParamsValue;
    covenantAddress: string;
    fare: { currency: "sats" | "asset"; units: bigint; assetId?: AssetIdValue };
    expiresAt: number;
    unsignedLockupTx: string;
}

export const causeMessage = (cause: unknown): string =>
    cause instanceof Error ? cause.message : String(cause);

const invalid = (detail: string): never => {
    throw new TaxiError(ClientErrorCode.InvalidResponse, `taxi: ${detail}`);
};

const wrap = <T>(what: string, f: () => T): T => {
    try {
        return f();
    } catch (cause) {
        if (cause instanceof TaxiError) throw cause;
        throw new TaxiError(
            ClientErrorCode.InvalidResponse,
            `taxi: invalid ${what}: ${causeMessage(cause)}`,
            { cause },
        );
    }
};

const str = (v: unknown, label: string): string =>
    typeof v === "string" && v.length > 0 ? v : invalid(`${label} must be a non-empty string`);

const uint = (v: unknown, label: string): number =>
    typeof v === "number" && Number.isSafeInteger(v) && v >= 0
        ? v
        : invalid(`${label} must be a non-negative integer`);

const bool = (v: unknown, label: string): boolean =>
    typeof v === "boolean" ? v : invalid(`${label} must be a boolean`);

const exactRecord = (
    value: unknown,
    required: readonly string[],
    optional: readonly string[],
    label: string,
): Record<string, unknown> => {
    if (value === null || typeof value !== "object" || Array.isArray(value))
        invalid(`${label} must be an object`);
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null)
        invalid(`${label} must be a plain object`);
    const record = value as Record<string, unknown>;
    const descriptors = Object.getOwnPropertyDescriptors(record);
    for (const [key, descriptor] of Object.entries(descriptors))
        if (!("value" in descriptor) || !descriptor.enumerable)
            invalid(`${label}.${key} must be an enumerable data property`);
    const allowed = new Set([...required, ...optional]);
    for (const key of required)
        if (!Object.prototype.hasOwnProperty.call(record, key))
            invalid(`${label} is missing ${key}`);
    for (const key of Object.keys(record))
        if (!allowed.has(key)) invalid(`${label} has unexpected ${key}`);
    return record;
};

const dataArray = (value: unknown, label: string): unknown[] => {
    if (!Array.isArray(value)) invalid(`${label} must be an array`);
    const array = value as unknown[];
    if (Object.getPrototypeOf(array) !== Array.prototype) invalid(`${label} must be a plain array`);
    const descriptors = Object.getOwnPropertyDescriptors(array);
    const keys = Reflect.ownKeys(descriptors).filter((key) => key !== "length");
    if (
        keys.length !== array.length ||
        keys.some(
            (key) =>
                typeof key !== "string" ||
                !/^(0|[1-9][0-9]*)$/.test(key) ||
                Number(key) >= array.length,
        )
    )
        invalid(`${label} has invalid array shape`);
    return Array.from({ length: array.length }, (_, index) => {
        const descriptor = descriptors[String(index)];
        if (!descriptor || !("value" in descriptor) || !descriptor.enumerable)
            invalid(`${label}[${index}] must be an enumerable data property`);
        return descriptor.value;
    });
};

const bytes32 = (v: unknown, label: string): Uint8Array => {
    const bytes = hexToBytes(v as string, label);
    return bytes.length === 32 ? bytes : invalid(`${label} must be 32 bytes, got ${bytes.length}`);
};

const outpoint = (v: unknown, label: string): { txid: string; vout: number } => {
    if (v === null || typeof v !== "object") invalid(`${label} must be an object`);
    const o = v as { txid: unknown; vout: unknown };
    bytes32(o.txid, `${label}.txid`);
    uint(o.vout, `${label}.vout`);
    return o as { txid: string; vout: number };
};

const assetId = (value: unknown, label: string): AssetIdWire => {
    const wire = exactRecord(value, ["txid", "groupIndex"], [], label);
    bytes32(wire.txid, `${label}.txid`);
    assetIdFromWire(wire as unknown as AssetIdWire, label);
    return wire as unknown as AssetIdWire;
};

const quoteParams = (value: unknown, label: string): QuoteParams => {
    const wire = exactRecord(
        value,
        ["receiverKey", "senderKey", "operatorKey", "dust", "topup", "locktime"],
        ["assetId"],
        label,
    );
    bytes32(wire.receiverKey, `${label}.receiverKey`);
    bytes32(wire.senderKey, `${label}.senderKey`);
    bytes32(wire.operatorKey, `${label}.operatorKey`);
    if (wire.assetId !== undefined) assetId(wire.assetId, `${label}.assetId`);
    quoteParamsFromWire(wire as unknown as QuoteParams, label);
    return wire as unknown as QuoteParams;
};

const fare = (value: unknown, label: string): FareWire => {
    const wire = exactRecord(value, ["currency", "units"], ["assetId"], label);
    if (wire.currency !== "sats" && wire.currency !== "asset")
        invalid(`${label}.currency must be sats or asset`);
    if (wire.currency === "asset") {
        if (wire.assetId === undefined) invalid(`${label}.assetId is required for an asset fare`);
        assetId(wire.assetId, `${label}.assetId`);
    } else if (wire.assetId !== undefined) {
        invalid(`${label}.assetId is only allowed for an asset fare`);
    }
    fareFromWire(wire as unknown as FareWire, label);
    return wire as unknown as FareWire;
};

const taggedLocktime = (value: unknown, label: string): TaggedLocktimeWire => {
    const wire = exactRecord(value, ["kind", "value"], [], label);
    if (wire.kind !== "height" && wire.kind !== "time")
        invalid(`${label}.kind must be height or time`);
    satsFromWire(wire.value as string, `${label}.value`);
    return wire as unknown as TaggedLocktimeWire;
};

const claimOutpoint = (value: unknown, label: string): { txid: string; vout: number } => {
    const wire = exactRecord(value, ["txid", "vout"], [], label);
    bytes32(wire.txid, `${label}.txid`);
    uint(wire.vout, `${label}.vout`);
    return wire as { txid: string; vout: number };
};

const receiverClaimDescriptor = (value: unknown, label: string): ReceiverClaimDescriptorWire => {
    const wire = exactRecord(
        value,
        ["params", "covenantAddress", "outpoint", "fare", "batchExpiry", "recoveryLocktime"],
        ["assetUnits"],
        label,
    );
    quoteParams(wire.params, `${label}.params`);
    str(wire.covenantAddress, `${label}.covenantAddress`);
    claimOutpoint(wire.outpoint, `${label}.outpoint`);
    if (wire.assetUnits !== undefined)
        satsFromWire(wire.assetUnits as string, `${label}.assetUnits`);
    fare(wire.fare, `${label}.fare`);
    taggedLocktime(wire.batchExpiry, `${label}.batchExpiry`);
    taggedLocktime(wire.recoveryLocktime, `${label}.recoveryLocktime`);
    return wire as unknown as ReceiverClaimDescriptorWire;
};

const claimStates = new Set<ReceiverClaimState>([
    "locking",
    "locked",
    "recovering",
    "recycled",
    "purchased",
    "refunded",
    "recovered",
    "expired",
]);

const terminalClaimStates = new Set<ReceiverClaimState>([
    "recycled",
    "purchased",
    "refunded",
    "recovered",
    "expired",
]);

const receiverClaim = (value: unknown, label: string): ReceiverClaimWire => {
    const wire = exactRecord(
        value,
        ["transferId", "receiverAddress", "state", "claimable", "updatedAt"],
        ["claim", "spentTxid", "failureCode"],
        label,
    );
    str(wire.transferId, `${label}.transferId`);
    str(wire.receiverAddress, `${label}.receiverAddress`);
    if (typeof wire.state !== "string" || !claimStates.has(wire.state as ReceiverClaimState))
        invalid(`${label}.state is invalid`);
    const state = wire.state as ReceiverClaimState;
    const claimable = bool(wire.claimable, `${label}.claimable`);
    uint(wire.updatedAt, `${label}.updatedAt`);
    const hasClaim = Object.prototype.hasOwnProperty.call(wire, "claim");
    const descriptor = hasClaim ? receiverClaimDescriptor(wire.claim, `${label}.claim`) : undefined;
    const hasSpentTxid = Object.prototype.hasOwnProperty.call(wire, "spentTxid");
    const hasFailureCode = Object.prototype.hasOwnProperty.call(wire, "failureCode");
    if (hasSpentTxid) bytes32(wire.spentTxid, `${label}.spentTxid`);
    if (hasFailureCode) str(wire.failureCode, `${label}.failureCode`);
    if (state === "locked") {
        if (!claimable || descriptor === undefined)
            invalid(`${label} locked claims must be claimable with a descriptor`);
        if (hasSpentTxid || hasFailureCode)
            invalid(`${label} only terminal claims may carry terminal details`);
    } else {
        if (claimable || descriptor !== undefined)
            invalid(`${label} only locked claims may be claimable or carry a descriptor`);
        if (!terminalClaimStates.has(state) && (hasSpentTxid || hasFailureCode))
            invalid(`${label} only terminal claims may carry terminal details`);
    }
    return wire as unknown as ReceiverClaimWire;
};

export function decodeInfo(info: InfoResponse): DecodedInfo {
    return wrap("info", () => {
        if (info === null || typeof info !== "object") invalid("info must be an object");
        if (!Array.isArray(info.assetRules)) invalid("info.assetRules must be an array");
        return {
            protocolVersion: uint(info.protocolVersion, "info.protocolVersion"),
            operatorKey: bytes32(info.operatorKey, "info.operatorKey"),
            serverKey: bytes32(info.serverKey, "info.serverKey"),
            emulatorKey: bytes32(info.emulatorKey, "info.emulatorKey"),
            arkdUrl: str(info.arkdUrl, "info.arkdUrl"),
            emulatorUrl: str(info.emulatorUrl, "info.emulatorUrl"),
            dust: satsFromWire(info.dust, "info.dust"),
            vtxoMinAmount: satsFromWire(info.vtxoMinAmount, "info.vtxoMinAmount"),
            // Kept in wire form: a client picks a fare by id and re-derives
            // nothing from the terms, so decoding them would be validation
            // without a consumer.
            assetRules: info.assetRules,
            maxPerPaymentTopupSats: satsFromWire(
                info.maxPerPaymentTopupSats,
                "info.maxPerPaymentTopupSats",
            ),
            paused: bool(info.paused, "info.paused"),
        };
    });
}

export function decodeQuote(quote: QuoteResponse): DecodedQuote {
    return wrap("quote", () => {
        if (quote === null || typeof quote !== "object") invalid("quote must be an object");
        return {
            transferId: str(quote.transferId, "quote.transferId"),
            params: quoteParamsFromWire(quote.params, "quote.params"),
            covenantAddress: str(quote.covenantAddress, "quote.covenantAddress"),
            fare: fareFromWire(quote.fare, "quote.fare"),
            expiresAt: uint(quote.expiresAt, "quote.expiresAt"),
            unsignedLockupTx: str(quote.unsignedLockupTx, "quote.unsignedLockupTx"),
        };
    });
}

export function decodeLockup(res: LockupResponse): LockupResponse {
    return wrap("lockup response", () => {
        if (res === null || typeof res !== "object") invalid("lockup response must be an object");
        bytes32(res.txid, "lockup.txid");
        outpoint(res.outpoint, "lockup.outpoint");
        return res;
    });
}

export function decodeStatus(res: TransferStatusResponse): TransferStatusResponse {
    return wrap("status response", () => {
        if (res === null || typeof res !== "object") invalid("status response must be an object");
        str(res.transferId, "status.transferId");
        str(res.state, "status.state");
        uint(res.updatedAt, "status.updatedAt");
        if (res.outpoint !== undefined) outpoint(res.outpoint, "status.outpoint");
        if (res.spentTxid !== undefined) bytes32(res.spentTxid, "status.spentTxid");
        if (res.submissionPhase !== undefined) str(res.submissionPhase, "status.submissionPhase");
        if (res.failureCode !== undefined) str(res.failureCode, "status.failureCode");
        if (res.failureDetail !== undefined) str(res.failureDetail, "status.failureDetail");
        return res;
    });
}

export function decodeClaimsSnapshot(value: unknown): ClaimsSnapshotResponse {
    return wrap("claims snapshot", () => {
        const body = exactRecord(value, ["claims"], [], "claims snapshot");
        return {
            claims: dataArray(body.claims, "claims snapshot claims").map((claim, index) =>
                receiverClaim(claim, `claims[${index}]`),
            ),
        };
    });
}

export function decodeClaimsChanged(value: unknown): ClaimsChangedEvent {
    return decodeClaimsSnapshot(value);
}
