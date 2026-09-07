export type AssetIdRef = {
    /** Genesis txid in internal byte order, never reversed display hex. */
    txid: Uint8Array;
    groupIndex: number;
};

export interface DustCovenantParams {
    receiverKey: Uint8Array;
    senderKey: Uint8Array;
    operatorKey: Uint8Array;
    dust: bigint;
    topup: bigint;
    assetId?: AssetIdRef;
    locktime: bigint;
}

const equalKeys = (a: Uint8Array, b: Uint8Array) =>
    a.length === b.length && a.every((byte, i) => byte === b[i]);

export function validateParams(p: DustCovenantParams, vtxoMinAmount: bigint): void {
    for (const [name, k] of [
        ["receiver", p.receiverKey],
        ["sender", p.senderKey],
        ["operator", p.operatorKey],
    ] as const) {
        if (k?.length !== 32) {
            throw new Error(`covenant: ${name} key must be 32 bytes, got ${k?.length ?? 0}`);
        }
    }
    if (p.dust <= 0n) {
        throw new Error(`covenant: dust must be positive, got ${p.dust}`);
    }
    if (vtxoMinAmount <= 0n) {
        throw new Error(`covenant: vtxoMinAmount must be positive, got ${vtxoMinAmount}`);
    }
    if (p.topup < vtxoMinAmount || p.topup > p.dust) {
        throw new Error(`covenant: topup ${p.topup} outside [${vtxoMinAmount}, ${p.dust}]`);
    }
    if (
        equalKeys(p.receiverKey, p.operatorKey) ||
        equalKeys(p.receiverKey, p.senderKey) ||
        equalKeys(p.senderKey, p.operatorKey)
    ) {
        throw new Error("covenant: receiver, sender and operator keys must be distinct");
    }
    if (p.locktime === 0n) {
        throw new Error("covenant: locktime must be non-zero");
    }
}

/**
 * Falls below topup only when the operator funded the whole dust unit, where one
 * vtxoMinAmount must stay behind to host the sender's returned asset: an asset
 * cannot occupy an output on its own.
 */
export function refundTopup(p: DustCovenantParams, vtxoMinAmount: bigint): bigint {
    const capped = p.dust - vtxoMinAmount;
    return p.topup > capped ? capped : p.topup;
}
