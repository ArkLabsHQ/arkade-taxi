/**
 * Wire JSON in, domain values out. Everything here treats its input as
 * `unknown` in practice — it arrives from `JSON.parse` on an operator's
 * response — so each field is checked rather than asserted.
 */

import type { AssetRuleWire } from "@arkade-taxi/protocol";
import {
    fareFromWire,
    assetIdFromWire,
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
