/**
 * Total, throwing codecs between wire JSON and domain values.
 *
 * Every function names the field it was decoding, because a bad quote is
 * diagnosed from the thrown message alone and "invalid hex" says nothing about
 * which of six keys was wrong.
 */

import type { FareWire, AssetIdWire, QuoteParams, CovenantSpendInputWire } from "./index.js";
import type { FundingInputWire } from "./index.js";

export interface FundingInputValue {
    txid: string;
    vout: number;
    value: bigint;
    tapTree: Uint8Array;
    spendLeaf: Uint8Array;
    assetPacket?: Uint8Array;
    expiry: { kind: "time" | "height"; value: bigint };
}

export interface CovenantSpendInputValue {
    txid: string;
    vout: number;
    value: bigint;
    tapTree: Uint8Array;
    tapLeafScript: [
        { version: number; internalKey: Uint8Array; merklePath: Uint8Array[] },
        Uint8Array,
    ];
    assetPacket?: Uint8Array;
}

export function fundingInputFromWire(input: unknown, label = "fundingInput"): FundingInputValue {
    if (!input || typeof input !== "object" || Array.isArray(input)) fail(label, "expected object");
    const w = input as FundingInputWire;
    if (hexToBytes(w.txid, `${label}.txid`).length !== 32) fail(label, "txid must be 32 bytes");
    if (!Number.isInteger(w.vout) || w.vout < 0 || w.vout > 0xffffffff) fail(label, "invalid vout");
    const value = satsFromWire(w.value, `${label}.value`);
    if (value > BigInt(Number.MAX_SAFE_INTEGER))
        fail(label, "value exceeds SDK safe integer range");
    const tapTree = hexToBytes(w.tapTree, `${label}.tapTree`);
    const spendLeaf = hexToBytes(w.spendLeaf, `${label}.spendLeaf`);
    if (!tapTree.length || !spendLeaf.length) fail(label, "empty tree or leaf");
    if (!w.expiry || (w.expiry.kind !== "time" && w.expiry.kind !== "height"))
        fail(label, "invalid expiry kind");
    const expiry = {
        kind: w.expiry.kind,
        value: satsFromWire(w.expiry.value, `${label}.expiry.value`),
    };
    if (expiry.value <= 0n || expiry.value > BigInt(Number.MAX_SAFE_INTEGER))
        fail(label, "invalid expiry value");
    return {
        txid: w.txid,
        vout: w.vout,
        value,
        tapTree,
        spendLeaf,
        expiry,
        ...(w.assetPacket !== undefined
            ? { assetPacket: hexToBytes(w.assetPacket, `${label}.assetPacket`) }
            : {}),
    };
}

export function fundingInputToWire(input: FundingInputValue): FundingInputWire {
    const wire = {
        txid: input.txid,
        vout: input.vout,
        value: satsToWire(input.value),
        tapTree: bytesToHex(input.tapTree),
        spendLeaf: bytesToHex(input.spendLeaf),
        expiry: { kind: input.expiry.kind, value: satsToWire(input.expiry.value) },
        ...(input.assetPacket !== undefined ? { assetPacket: bytesToHex(input.assetPacket) } : {}),
    };
    fundingInputFromWire(wire);
    return wire;
}

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

const exactKeys = (
    value: Record<string, unknown>,
    required: readonly string[],
    optional: readonly string[],
    label: string,
): void => {
    const allowed = new Set([...required, ...optional]);
    for (const key of required)
        if (!Object.prototype.hasOwnProperty.call(value, key)) fail(label, `missing ${key}`);
    for (const key of Object.keys(value)) if (!allowed.has(key)) fail(label, `unexpected ${key}`);
};

const record = (input: unknown, label: string): Record<string, unknown> => {
    if (!input || typeof input !== "object" || Array.isArray(input)) fail(label, "expected object");
    const prototype = Object.getPrototypeOf(input);
    if (prototype !== Object.prototype && prototype !== null) fail(label, "expected plain object");
    const descriptors = Object.getOwnPropertyDescriptors(input);
    for (const [key, descriptor] of Object.entries(descriptors))
        if (!("value" in descriptor) || !descriptor.enumerable)
            fail(label, `non-data property ${key}`);
    return input as Record<string, unknown>;
};

const dataArray = (input: unknown, label: string): unknown[] => {
    if (!Array.isArray(input)) fail(label, "expected array");
    const array = input as unknown[];
    if (Object.getPrototypeOf(array) !== Array.prototype) fail(label, "expected plain array");
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
        fail(label, "array shape is invalid");
    return Array.from({ length: array.length }, (_, index) => {
        const descriptor = descriptors[String(index)];
        if (!descriptor || !("value" in descriptor) || !descriptor.enumerable)
            fail(label, `index ${index} must be an enumerable data property`);
        return descriptor.value;
    });
};

export function covenantSpendInputFromWire(
    input: unknown,
    label = "covenantSpendInput",
): CovenantSpendInputValue {
    const wire = record(input, label);
    exactKeys(
        wire,
        ["txid", "vout", "value", "tapTree", "selectedLeaf", "controlBlock"],
        ["assetPacket"],
        label,
    );
    const txid = typeof wire.txid === "string" ? wire.txid : fail(label, "txid must be a string");
    if (hexToBytes(txid, `${label}.txid`).length !== 32)
        fail(label, "txid must be 32-byte lowercase hex");
    const vout = typeof wire.vout === "number" ? wire.vout : fail(label, "vout must be a number");
    if (!Number.isSafeInteger(vout) || vout < 0 || vout > 0xffffffff) fail(label, "invalid vout");
    const value = satsFromWire(wire.value as string, `${label}.value`);
    if (value <= 0n) fail(label, "value must be positive");
    const tapTree = hexToBytes(wire.tapTree as string, `${label}.tapTree`);
    const selectedLeaf = hexToBytes(wire.selectedLeaf as string, `${label}.selectedLeaf`);
    if (!tapTree.length || selectedLeaf.length < 2) fail(label, "empty tree or leaf");
    const control = record(wire.controlBlock, `${label}.controlBlock`);
    exactKeys(control, ["version", "internalKey", "merklePath"], [], `${label}.controlBlock`);
    const version =
        typeof control.version === "number"
            ? control.version
            : fail(label, "control-block version must be a number");
    if (!Number.isInteger(version) || version < 0 || version > 0xff)
        fail(label, "invalid control-block version");
    const internalKey = hexToBytes(
        control.internalKey as string,
        `${label}.controlBlock.internalKey`,
    );
    if (internalKey.length !== 32) fail(label, "control-block internal key must be 32 bytes");
    const encodedMerklePath = dataArray(control.merklePath, `${label}.controlBlock.merklePath`);
    const merklePath = encodedMerklePath.map((path: unknown, index: number) => {
        const decoded = hexToBytes(path as string, `${label}.controlBlock.merklePath[${index}]`);
        if (decoded.length !== 32) fail(label, "control-block merkle node must be 32 bytes");
        return decoded;
    });
    if ((version & 0xfe) !== selectedLeaf[selectedLeaf.length - 1])
        fail(label, "selected leaf version does not match control block");
    const assetPacket =
        wire.assetPacket === undefined
            ? undefined
            : hexToBytes(wire.assetPacket as string, `${label}.assetPacket`);
    if (assetPacket !== undefined && !assetPacket.length) fail(label, "asset packet is empty");
    return {
        txid,
        vout,
        value,
        tapTree,
        tapLeafScript: [{ version, internalKey, merklePath }, selectedLeaf],
        ...(assetPacket === undefined ? {} : { assetPacket }),
    };
}

export function covenantSpendInputToWire(input: CovenantSpendInputValue): CovenantSpendInputWire {
    const wire: CovenantSpendInputWire = {
        txid: input.txid,
        vout: input.vout,
        value: satsToWire(input.value),
        tapTree: bytesToHex(Uint8Array.from(input.tapTree)),
        selectedLeaf: bytesToHex(Uint8Array.from(input.tapLeafScript[1])),
        controlBlock: {
            version: input.tapLeafScript[0].version,
            internalKey: bytesToHex(Uint8Array.from(input.tapLeafScript[0].internalKey)),
            merklePath: input.tapLeafScript[0].merklePath.map((path) =>
                bytesToHex(Uint8Array.from(path)),
            ),
        },
        ...(input.assetPacket === undefined
            ? {}
            : { assetPacket: bytesToHex(Uint8Array.from(input.assetPacket)) }),
    };
    covenantSpendInputFromWire(wire);
    return wire;
}

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

/** Wire<->domain for a resolved fare. Units are decimal strings for the reason
 * every other amount is: JSON has no bigint. */
export function fareToWire(fare: {
    currency: "sats" | "asset";
    units: bigint;
    assetId?: { txid: Uint8Array; groupIndex: number };
}): FareWire {
    return fare.currency === "asset" && fare.assetId
        ? { currency: "asset", units: satsToWire(fare.units), assetId: assetIdToWire(fare.assetId) }
        : { currency: "sats", units: satsToWire(fare.units) };
}

export function fareFromWire(w: FareWire, label = "fare") {
    const units = satsFromWire(w.units, `${label}.units`);
    if (w.currency === "asset") {
        if (!w.assetId) throw new Error(`${label}: an asset fare must carry an assetId`);
        return { currency: "asset" as const, assetId: assetIdFromWire(w.assetId), units };
    }
    return { currency: "sats" as const, units };
}
