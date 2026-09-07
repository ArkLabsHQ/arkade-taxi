/**
 * Total, throwing codecs between wire JSON and domain values.
 *
 * Every function names the field it was decoding, because a bad quote is
 * diagnosed from the thrown message alone and "invalid hex" says nothing about
 * which of six keys was wrong.
 */

import type { AssetIdWire, QuoteParams } from "./index.js";

/** Structurally identical to `@arkade-taxi/covenant`'s `AssetIdRef`, restated
 * so the wire package depends on nothing. */
export type AssetIdValue = {
    txid: Uint8Array;
    groupIndex: number;
};

/** Structurally identical to `@arkade-taxi/covenant`'s `DustCovenantParams`,
 * restated for the same reason. */
export interface CovenantParamsValue {
    receiverKey: Uint8Array;
    senderKey: Uint8Array;
    operatorKey: Uint8Array;
    dust: bigint;
    topup: bigint;
    assetId?: AssetIdValue;
    locktime: bigint;
}

const fail = (label: string, reason: string): never => {
    throw new Error(`protocol: ${label}: ${reason}`);
};

const HEX = /^[0-9a-f]*$/;
const DECIMAL = /^[0-9]+$/;

export function hexToBytes(s: string, label: string): Uint8Array {
    if (typeof s !== "string") fail(label, `expected a hex string, got ${typeof s}`);
    if (s.length % 2 !== 0) fail(label, `odd-length hex (${s.length} chars)`);
    if (!HEX.test(s)) fail(label, "not lowercase hex");
    const out = new Uint8Array(s.length / 2);
    for (let i = 0; i < out.length; i++) out[i] = Number.parseInt(s.slice(i * 2, i * 2 + 2), 16);
    return out;
}

export function bytesToHex(b: Uint8Array): string {
    let out = "";
    for (const byte of b) out += byte.toString(16).padStart(2, "0");
    return out;
}

export function satsFromWire(s: string, label: string): bigint {
    if (typeof s !== "string") fail(label, `expected a decimal string, got ${typeof s}`);
    if (s === "") fail(label, "empty amount");
    if (!DECIMAL.test(s)) fail(label, `not a non-negative decimal amount: ${JSON.stringify(s)}`);
    return BigInt(s);
}

export function satsToWire(v: bigint): string {
    if (v < 0n) throw new Error(`protocol: amount must be non-negative, got ${v}`);
    return v.toString(10);
}

const groupIndexFromWire = (n: number, label: string): number => {
    if (typeof n !== "number" || !Number.isSafeInteger(n) || n < 0) {
        fail(label, `expected a non-negative integer, got ${String(n)}`);
    }
    return n;
};

export function assetIdFromWire(a: AssetIdWire, label = "assetId"): AssetIdValue {
    if (a === null || typeof a !== "object") fail(label, `expected an object, got ${typeof a}`);
    return {
        txid: hexToBytes(a.txid, `${label}.txid`),
        groupIndex: groupIndexFromWire(a.groupIndex, `${label}.groupIndex`),
    };
}

export function assetIdToWire(a: AssetIdValue): AssetIdWire {
    return { txid: bytesToHex(a.txid), groupIndex: groupIndexFromWire(a.groupIndex, "groupIndex") };
}

export function quoteParamsFromWire(p: QuoteParams, label = "params"): CovenantParamsValue {
    if (p === null || typeof p !== "object") fail(label, `expected an object, got ${typeof p}`);
    const out: CovenantParamsValue = {
        receiverKey: hexToBytes(p.receiverKey, `${label}.receiverKey`),
        senderKey: hexToBytes(p.senderKey, `${label}.senderKey`),
        operatorKey: hexToBytes(p.operatorKey, `${label}.operatorKey`),
        dust: satsFromWire(p.dust, `${label}.dust`),
        topup: satsFromWire(p.topup, `${label}.topup`),
        locktime: satsFromWire(p.locktime, `${label}.locktime`),
    };
    if (p.assetId !== undefined) out.assetId = assetIdFromWire(p.assetId, `${label}.assetId`);
    return out;
}

export function quoteParamsToWire(p: CovenantParamsValue): QuoteParams {
    const out: QuoteParams = {
        receiverKey: bytesToHex(p.receiverKey),
        senderKey: bytesToHex(p.senderKey),
        operatorKey: bytesToHex(p.operatorKey),
        dust: satsToWire(p.dust),
        topup: satsToWire(p.topup),
        locktime: satsToWire(p.locktime),
    };
    if (p.assetId !== undefined) out.assetId = assetIdToWire(p.assetId);
    return out;
}
