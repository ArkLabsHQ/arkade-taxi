import { describe, expect, it } from "vitest";
import { hex } from "@scure/base";
import { planReceiverClaim, type ReceiverClaim } from "../src/wallet/claims.js";

const receiverKey = "11".repeat(32);
const script = `5120${receiverKey}`;
const claim = (params: Record<string, string>): ReceiverClaim =>
    ({
        transferId: "tr_01",
        claim: { params: { dust: "330", receiverKey, ...params } },
    }) as unknown as ReceiverClaim;
const coin = (value: number) => ({ txid: hex.encode(new Uint8Array(32)), vout: 0, value, script });

describe("planReceiverClaim", () => {
    const paid = claim({ topup: "330", paymentSats: "100", claimMode: "recycle" });

    it("merges the payment and repays the whole advance", () => {
        expect(planReceiverClaim(paid, [coin(250)])).toMatchObject({
            kind: "recycle",
            mergedSats: 350n,
            feeSats: 0n,
        });
    });

    it("needs only enough of the receiver's own sats to leave a dust coin", () => {
        expect(planReceiverClaim(paid, [coin(229)])).toEqual({
            kind: "wait-for-reclaim",
            reason: "no-coin-covers-the-fare",
            neededSats: 230n,
        });
    });

    it("hands the whole lockup over on purchase", () => {
        expect(
            planReceiverClaim(
                claim({ topup: "330", paymentSats: "100", claimMode: "purchase" }),
                [],
            ),
        ).toEqual({ kind: "purchase", receivedSats: 430n });
    });

    it("keeps planning a dust-unit covenant the way it was funded", () => {
        expect(
            planReceiverClaim(claim({ topup: "230", claimMode: "recycle" }), [coin(250)]),
        ).toMatchObject({ kind: "recycle", mergedSats: 350n });
    });
});
