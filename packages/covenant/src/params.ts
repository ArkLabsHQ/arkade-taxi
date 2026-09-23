export type AssetIdRef = {
    /** Genesis txid in internal byte order, never reversed display hex. */
    txid: Uint8Array;
    groupIndex: number;
};

export type ReceiverFare =
    { currency: "sats"; units: bigint } | { currency: "asset"; units: bigint };

export interface DustCovenantParams {
    receiverKey: Uint8Array;
    senderKey: Uint8Array;
    operatorKey: Uint8Array;
    dust: bigint;
    topup: bigint;
    assetId?: AssetIdRef;
    locktime: bigint;
    recoveryRecipient?: "sender" | "receiver";
    /** Which claim leaf this covenant commits to. Absent is the historical
     * four-leaf tree; a mode disables the forbidden closure in place, so the
     * tree height and every control proof are unchanged. */
    claimMode?: "recycle" | "purchase";
    receiverFare?: ReceiverFare;
}

const equalKeys = (a: Uint8Array, b: Uint8Array) =>
    a.length === b.length && a.every((byte, i) => byte === b[i]);

const MAX_I64 = 2n ** 63n - 1n;

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
    if (
        p.recoveryRecipient !== undefined &&
        p.recoveryRecipient !== "sender" &&
        p.recoveryRecipient !== "receiver"
    ) {
        throw new Error(`covenant: unknown recovery recipient ${String(p.recoveryRecipient)}`);
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
    if (p.claimMode !== undefined && p.claimMode !== "recycle" && p.claimMode !== "purchase") {
        throw new Error(`covenant: unknown claimMode ${String(p.claimMode)}`);
    }
    if (p.receiverFare !== undefined) {
        const { currency, units } = p.receiverFare;
        if (currency !== "sats" && currency !== "asset")
            throw new Error(`covenant: receiver fare currency ${String(currency)} is unknown`);
        if (p.assetId === undefined)
            throw new Error("covenant: receiver fare requires an asset id");
        if (p.topup !== p.dust)
            throw new Error("covenant: receiver fare requires the operator to fund the whole dust");
        if (p.claimMode !== "recycle")
            throw new Error("covenant: receiver fare is only defined for a recycle claim");
        if (p.recoveryRecipient !== "receiver")
            throw new Error("covenant: receiver fare requires receiver-owned recovery");
        if (typeof units !== "bigint" || units < 0n)
            throw new Error("covenant: receiver fare units must not be negative");
        if (units > MAX_I64)
            throw new Error("covenant: receiver fare units exceed a signed 64-bit integer");
    }
    if (p.recoveryRecipient === "receiver" && p.assetId === undefined) {
        throw new Error("covenant: receiver recovery requires an asset id");
    }
    if (p.recoveryRecipient === "receiver" && refundTopup(p, vtxoMinAmount) < vtxoMinAmount) {
        throw new Error(
            `covenant: receiver recovery needs at least ${vtxoMinAmount} sats to host its receipt`,
        );
    }
}

/**
 * Falls below topup only when the operator funded the whole dust unit, where one
 * vtxoMinAmount must stay behind to host the recovery owner's returned asset: an asset
 * cannot occupy an output on its own.
 */
export function refundTopup(p: DustCovenantParams, vtxoMinAmount: bigint): bigint {
    const capped = p.dust - vtxoMinAmount;
    return p.topup > capped ? capped : p.topup;
}

export function unrecoveredTopup(p: DustCovenantParams, vtxoMinAmount: bigint): bigint {
    return p.topup - refundTopup(p, vtxoMinAmount);
}
