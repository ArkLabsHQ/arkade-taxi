import type { DustCovenantParams } from "../src/params.js";

const key = (fill: number) => new Uint8Array(32).fill(fill);

export const receiverPaid = (over: Partial<DustCovenantParams> = {}): DustCovenantParams => ({
    receiverKey: key(1),
    senderKey: key(2),
    operatorKey: key(3),
    dust: 330n,
    topup: 330n,
    locktime: 900_000n,
    assetId: { txid: new Uint8Array(32).fill(0x11), groupIndex: 0 },
    claimMode: "recycle",
    recoveryRecipient: "receiver",
    receiverFare: { currency: "sats", units: 7n },
    ...over,
});
