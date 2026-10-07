import { timelockToSequence, type RelativeTimelock } from "@arkade-os/sdk";

export type { RelativeTimelock };

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
    operatorSignerKey: Uint8Array;
    /** CSV on the exit leaf. Relative to the unroll confirmation and nothing
     * else: an absolute deadline is not expressible in an exit closure. */
    exitDelay: RelativeTimelock;
    dust: bigint;
    topup: bigint;
    /** Sats the payer locks beside a whole-dust bitcoin advance. Absent keeps the
     * dust-unit covenant byte-identical, so already-funded covenants still rebuild. */
    paymentSats?: bigint;
    assetId?: AssetIdRef;
    locktime: bigint;
    recoveryRecipient?: "sender" | "receiver";
    /** Which claim leaf this covenant commits to. Absent enables both claim
     * leaves; a mode disables the forbidden closure in place, so the
     * tree height and every control proof are unchanged. */
    claimMode?: "recycle" | "purchase";
    receiverFare?: ReceiverFare;
    /** Absent is legacy and must stay byte-identical: funded covenants rebuild from it. */
    covenantVersion?: 2;
}

const equalKeys = (a: Uint8Array, b: Uint8Array) =>
    a.length === b.length && a.every((byte, i) => byte === b[i]);

const MAX_I64 = 2n ** 63n - 1n;

export function validateParams(p: DustCovenantParams, vtxoMinAmount: bigint): void {
    for (const [name, k] of [
        ["receiver", p.receiverKey],
        ["sender", p.senderKey],
        ["operator", p.operatorKey],
        ["operator signer", p.operatorSignerKey],
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
    if (p.covenantVersion !== undefined && p.covenantVersion !== 2) {
        throw new Error(`covenant: unknown covenantVersion ${String(p.covenantVersion)}`);
    }
    const v2 = p.covenantVersion === 2;
    if (p.topup < vtxoMinAmount || p.topup > p.dust) {
        throw new Error(`covenant: topup ${p.topup} outside [${vtxoMinAmount}, ${p.dust}]`);
    }
    if (v2 && p.topup !== p.dust) {
        throw new Error(`covenant: a v2 covenant lends exactly one dust unit, got ${p.topup}`);
    }
    if (p.paymentSats !== undefined) {
        if (p.assetId !== undefined || p.topup !== p.dust)
            throw new Error("covenant: paymentSats requires a whole-dust bitcoin advance");
        if (v2 && p.paymentSats <= 0n)
            throw new Error(`covenant: paymentSats ${p.paymentSats} must be positive`);
        if (!v2 && (p.paymentSats < vtxoMinAmount || p.paymentSats >= p.dust))
            throw new Error(
                `covenant: paymentSats ${p.paymentSats} outside [${vtxoMinAmount}, ${p.dust})`,
            );
    }
    if (
        equalKeys(p.receiverKey, p.operatorKey) ||
        equalKeys(p.receiverKey, p.senderKey) ||
        equalKeys(p.senderKey, p.operatorKey)
    ) {
        throw new Error("covenant: receiver, sender and operator keys must be distinct");
    }
    if (equalKeys(p.senderKey, p.operatorSignerKey)) {
        throw new Error("covenant: sender and operator signer keys must be distinct");
    }
    // operatorKey is not compared to the signer: it is a tweaked payout key nothing signs with.
    if (equalKeys(p.receiverKey, p.operatorSignerKey)) {
        throw new Error("covenant: receiver and operator signer keys must be distinct");
    }
    if (
        !exitDelayEncodable(p.exitDelay.value) ||
        p.exitDelay.type !== exitTimelock(p.exitDelay.value).type
    ) {
        throw new Error(
            `covenant: exit delay ${p.exitDelay.value} ${p.exitDelay.type} is unusable`,
        );
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
    if (
        !v2 &&
        p.recoveryRecipient === "receiver" &&
        refundTopup(p, vtxoMinAmount) < vtxoMinAmount
    ) {
        throw new Error(
            `covenant: receiver recovery needs at least ${vtxoMinAmount} sats to host its receipt`,
        );
    }
}

/** The covenant output's value: the dust unit, plus any payment locked beside it. */
export const lockupSats = (p: DustCovenantParams): bigint => p.dust + (p.paymentSats ?? 0n);

/**
 * Falls below topup only when the operator funded the whole lockup, where one
 * vtxoMinAmount must stay behind to host the recovery owner's returned asset: an asset
 * cannot occupy an output on its own.
 */
export function refundTopup(p: DustCovenantParams, vtxoMinAmount: bigint): bigint {
    const capped = lockupSats(p) - vtxoMinAmount;
    return p.topup > capped ? capped : p.topup;
}

export function unrecoveredTopup(p: DustCovenantParams, vtxoMinAmount: bigint): bigint {
    return p.topup - refundTopup(p, vtxoMinAmount);
}

/** What a v2 refund repays; v2 has no refundTopup cap because no receipt stays behind. */
export const loanSats = (p: DustCovenantParams): bigint => p.topup;

export type RecycleFare = { operatorSats: bigint; assetFare: bigint };

/** What the recycle leaf repays: operatorSats folds a sats fare into the topup
 * repayment, assetFare is what the receiver pays out of the asset side. */
export function recycleFare(p: DustCovenantParams): RecycleFare {
    const fare = p.receiverFare;
    return {
        operatorSats: fare?.currency === "sats" ? p.topup + fare.units : p.topup,
        assetFare: fare?.currency === "asset" ? fare.units : 0n,
    };
}

/** arkd couples the delay's domain to its own VtxoTreeExpiry, so the `< 512`
 * split it advertises is the one it will accept. Same rule as DefaultVtxo. */
export const exitTimelock = (delay: bigint): RelativeTimelock => ({
    value: delay,
    type: delay < 512n ? "blocks" : "seconds",
});

export function exitDelayEncodable(delay: bigint): boolean {
    if (delay <= 0n) return false;
    try {
        timelockToSequence(exitTimelock(delay));
        return true;
    } catch {
        return false;
    }
}
