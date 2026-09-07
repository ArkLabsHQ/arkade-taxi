import { expect } from "vitest";
import {
    QuoteVerificationError,
    VerificationErrorCode,
    verifyQuote,
    type VerifyQuoteArgs,
} from "@arkade-taxi/client";
import { bytesToHex } from "@arkade-taxi/protocol";
import {
    addressFor,
    params,
    rogueEmulatorKey,
    rogueServerKey,
    serverKey,
    verifyArgs,
} from "./fixtures.js";
import { liveScenario } from "./scenarios.js";

const codeOf = (tamper: (a: VerifyQuoteArgs) => void): string => {
    const a = verifyArgs();
    tamper(a);
    try {
        verifyQuote(a);
    } catch (e) {
        if (e instanceof QuoteVerificationError) return e.code;
        throw e;
    }
    throw new Error("verifyQuote accepted a quote it was given to reject");
};

liveScenario("verify-quote-rejects-tampered-params", () => {
    // Control: the untampered quote verifies, so every rejection below is the
    // tamper and not a broken fixture.
    expect(verifyQuote(verifyArgs()).quote.transferId).toBe("tr_e2e_01");

    // Params that still satisfy every explicit bound but derive a different
    // address. Only the rebuild catches these.
    expect(codeOf((a) => (a.quote.params.topup = "200"))).toBe(VerificationErrorCode.Address);
    expect(codeOf((a) => (a.quote.params.locktime = "900000"))).toBe(VerificationErrorCode.Address);
    expect(
        codeOf(
            (a) => (a.quote.covenantAddress = addressFor({ ...params(), dust: 400n, topup: 400n })),
        ),
    ).toBe(VerificationErrorCode.Address);

    expect(codeOf((a) => (a.quote.params.receiverKey = bytesToHex(rogueEmulatorKey)))).toBe(
        VerificationErrorCode.ReceiverKey,
    );
    expect(codeOf((a) => (a.quote.params.senderKey = bytesToHex(rogueEmulatorKey)))).toBe(
        VerificationErrorCode.SenderKey,
    );
    expect(codeOf((a) => (a.quote.params.operatorKey = bytesToHex(rogueEmulatorKey)))).toBe(
        VerificationErrorCode.OperatorKey,
    );
    expect(codeOf((a) => (a.quote.params.assetId = { txid: "ab".repeat(32), groupIndex: 0 }))).toBe(
        VerificationErrorCode.AssetId,
    );
    expect(codeOf((a) => (a.quote.params.dust = "329"))).toBe(VerificationErrorCode.Dust);
    expect(codeOf((a) => (a.quote.params.topup = "331"))).toBe(VerificationErrorCode.Topup);
    expect(codeOf((a) => (a.quote.params.topup = "5"))).toBe(VerificationErrorCode.InvalidParams);
    expect(codeOf((a) => (a.quote.feeSats = "11"))).toBe(VerificationErrorCode.Fee);
    expect(codeOf((a) => (a.quote.params.locktime = "600000"))).toBe(
        VerificationErrorCode.Locktime,
    );
    expect(codeOf((a) => (a.now = a.quote.expiresAt))).toBe(VerificationErrorCode.Expired);
    expect(codeOf((a) => (a.info.protocolVersion = 2))).toBe(VerificationErrorCode.ProtocolVersion);
    expect(codeOf((a) => (a.info.serverKey = bytesToHex(rogueServerKey)))).toBe(
        VerificationErrorCode.ServerKey,
    );
    expect(codeOf((a) => (a.info.emulatorKey = bytesToHex(rogueEmulatorKey)))).toBe(
        VerificationErrorCode.EmulatorKey,
    );

    const rogueAddress = addressFor(params(), { serverKey, emulatorKey: rogueEmulatorKey });
    expect(rogueAddress).not.toBe(addressFor(params()));

    const forged = verifyArgs();
    forged.info.emulatorKey = bytesToHex(rogueEmulatorKey);
    forged.quote.covenantAddress = rogueAddress;

    // Unpinned, the forgery verifies: the address the client re-derives is the
    // address the operator quoted, because both used the operator's emulator.
    const unpinned: VerifyQuoteArgs = { ...forged, trustedEmulatorKey: rogueEmulatorKey };
    expect(verifyQuote(unpinned).quote.covenantAddress).toBe(rogueAddress);

    // Pinned, it dies before the address is ever derived.
    let rejected: unknown;
    try {
        verifyQuote(forged);
    } catch (e) {
        rejected = e;
    }
    expect(rejected).toBeInstanceOf(QuoteVerificationError);
    expect((rejected as QuoteVerificationError).code).toBe(VerificationErrorCode.EmulatorKey);
});
