import { describe, expect, it } from "vitest";
import { bytesToHex, quoteParamsToWire, type AssetIdValue } from "@arkade-taxi/protocol";
import { QuoteVerificationError, TaxiError } from "../src/errors.js";
import { verifyQuote } from "../src/verify.js";
import {
    addressFor,
    args,
    HRP,
    info,
    NOW,
    otherKey,
    params,
    quote,
    receiverKey,
    serverKey,
    VTXO_MIN,
} from "./fixtures.js";

const rejects = (patch: Partial<ReturnType<typeof args>>, code: string) => {
    let thrown: unknown;
    try {
        verifyQuote({ ...args(), ...patch });
    } catch (e) {
        thrown = e;
    }
    expect(thrown).toBeInstanceOf(QuoteVerificationError);
    expect((thrown as QuoteVerificationError).code).toBe(code);
};

const asset: AssetIdValue = { txid: new Uint8Array(32).fill(0x11), groupIndex: 0 };

describe("verifyQuote — happy path", () => {
    it("returns the rebuilt params and script", () => {
        const v = verifyQuote(args());
        expect(v.params.receiverKey).toEqual(receiverKey);
        expect(v.params.dust).toBe(330n);
        expect(v.params.topup).toBe(330n);
        expect(v.params.locktime).toBe(800_000n);
        expect(v.script.scripts).toHaveLength(4);
    });

    it("returns a script whose own address equals the quoted one", () => {
        const v = verifyQuote(args());
        expect(v.script.address(HRP, serverKey).encode()).toBe(quote().covenantAddress);
    });

    it("accepts an asset quote when the caller asked for that asset", () => {
        const p = { ...params(), assetId: asset };
        const a = args();
        const v = verifyQuote({
            ...a,
            quote: { ...quote(), params: quoteParamsToWire(p), covenantAddress: addressFor(p) },
            expect: { ...a.expect, assetId: asset },
        });
        expect(v.params.assetId).toEqual(asset);
    });
});

// Without this the address check below is self-consistent and worthless: an
// operator naming an emulator it controls would derive an address that agrees.
describe("verifyQuote — trusted key pinning", () => {
    it("rejects an info serverKey the caller does not trust", () => {
        rejects({ trustedServerKey: otherKey }, "UNTRUSTED_SERVER_KEY");
    });

    it("rejects an info emulatorKey the caller does not trust", () => {
        rejects({ trustedEmulatorKey: otherKey }, "UNTRUSTED_EMULATOR_KEY");
    });

    it("rejects an operator-controlled emulator even though its address is self-consistent", () => {
        const forged = {
            info: { ...info(), emulatorKey: bytesToHex(otherKey) },
            quote: {
                ...quote(),
                covenantAddress: addressFor(params(), { serverKey, emulatorKey: otherKey }),
            },
        };
        expect(addressFor(params(), { serverKey, emulatorKey: otherKey })).not.toBe(
            quote().covenantAddress,
        );
        rejects(forged, "UNTRUSTED_EMULATOR_KEY");
    });

    it("rejects a protocol version it does not speak", () => {
        rejects({ info: { ...info(), protocolVersion: 2 } }, "PROTOCOL_VERSION_MISMATCH");
    });
});

describe("verifyQuote — pays who the caller asked to pay", () => {
    it("rejects a receiverKey other than the expected one", () => {
        const a = args();
        rejects({ expect: { ...a.expect, receiverKey: otherKey } }, "RECEIVER_KEY_MISMATCH");
    });

    it("rejects a senderKey other than the expected one", () => {
        const a = args();
        rejects({ expect: { ...a.expect, senderKey: otherKey } }, "SENDER_KEY_MISMATCH");
    });

    it("rejects a bitcoin quote when the caller asked to pay an asset", () => {
        const a = args();
        rejects({ expect: { ...a.expect, assetId: asset } }, "ASSET_ID_MISMATCH");
    });

    it("rejects an asset quote when the caller asked to pay bitcoin", () => {
        const p = { ...params(), assetId: asset };
        rejects(
            { quote: { ...quote(), params: quoteParamsToWire(p), covenantAddress: addressFor(p) } },
            "ASSET_ID_MISMATCH",
        );
    });

    it("rejects a different asset txid", () => {
        const p = { ...params(), assetId: asset };
        const a = args();
        rejects(
            {
                quote: {
                    ...quote(),
                    params: quoteParamsToWire(p),
                    covenantAddress: addressFor(p),
                },
                expect: {
                    ...a.expect,
                    assetId: { txid: new Uint8Array(32).fill(0x22), groupIndex: 0 },
                },
            },
            "ASSET_ID_MISMATCH",
        );
    });

    it("rejects a different asset groupIndex", () => {
        const p = { ...params(), assetId: asset };
        const a = args();
        rejects(
            {
                quote: {
                    ...quote(),
                    params: quoteParamsToWire(p),
                    covenantAddress: addressFor(p),
                },
                expect: { ...a.expect, assetId: { ...asset, groupIndex: 1 } },
            },
            "ASSET_ID_MISMATCH",
        );
    });

    it("rejects an operatorKey the info endpoint did not advertise", () => {
        rejects(
            { info: { ...info(), operatorKey: bytesToHex(otherKey) } },
            "OPERATOR_KEY_MISMATCH",
        );
    });

    it("rejects a dust the info endpoint did not advertise", () => {
        rejects({ info: { ...info(), dust: "546" } }, "DUST_MISMATCH");
    });
});

describe("verifyQuote — caller authorisation bounds", () => {
    it("rejects a topup above maxTopupSats", () => {
        const a = args();
        rejects({ expect: { ...a.expect, maxTopupSats: 329n } }, "TOPUP_ABOVE_MAX");
    });

    it("accepts a topup exactly at maxTopupSats", () => {
        expect(() => verifyQuote(args())).not.toThrow();
    });

    it("rejects a feeSats above maxFeeSats", () => {
        rejects(
            { quote: { ...quote(), fare: { currency: "sats", units: "11" } } },
            "FEE_ABOVE_MAX",
        );
    });

    it("rejects a locktime below minLocktime", () => {
        const a = args();
        rejects({ expect: { ...a.expect, minLocktime: 800_001n } }, "LOCKTIME_BELOW_MIN");
    });
});

describe("verifyQuote — independent address rebuild", () => {
    // The tamper the whole file exists for: params changed, covenantAddress left
    // alone, and the caller's expectations updated so no equality check fires
    // first. Only the rebuild can catch this.
    it("rejects a tampered receiverKey when covenantAddress is left untouched", () => {
        const a = args();
        rejects(
            {
                quote: {
                    ...quote(),
                    params: { ...quoteParamsToWire(params()), receiverKey: bytesToHex(otherKey) },
                },
                expect: { ...a.expect, receiverKey: otherKey },
            },
            "COVENANT_ADDRESS_MISMATCH",
        );
    });

    it("rejects a tampered receiverKey with the caller's original expectations", () => {
        expect(() =>
            verifyQuote({
                ...args(),
                quote: {
                    ...quote(),
                    params: { ...quoteParamsToWire(params()), receiverKey: bytesToHex(otherKey) },
                },
            }),
        ).toThrow(QuoteVerificationError);
    });

    it("rejects a locktime raised inside the caller's bound but not reflected in the address", () => {
        rejects(
            {
                quote: {
                    ...quote(),
                    params: { ...quoteParamsToWire(params()), locktime: "900000" },
                },
            },
            "COVENANT_ADDRESS_MISMATCH",
        );
    });

    it("rejects a vtxoMinAmount other than the one the address was derived under", () => {
        rejects({ vtxoMinAmount: VTXO_MIN + 1n }, "COVENANT_ADDRESS_MISMATCH");
    });

    it("rejects a different bech32 prefix", () => {
        rejects({ hrp: "tark" }, "COVENANT_ADDRESS_MISMATCH");
    });

    it("rejects params the covenant itself refuses to build", () => {
        rejects(
            { quote: { ...quote(), params: { ...quoteParamsToWire(params()), topup: "0" } } },
            "INVALID_COVENANT_PARAMS",
        );
    });
});

describe("verifyQuote — expiry", () => {
    it("rejects a quote whose expiry has passed", () => {
        rejects({ now: NOW + 61 }, "QUOTE_EXPIRED");
    });

    it("rejects a quote at exactly its expiry instant", () => {
        rejects({ now: NOW + 60 }, "QUOTE_EXPIRED");
    });

    it("accepts a quote one second before expiry", () => {
        expect(() => verifyQuote({ ...args(), now: NOW + 59 })).not.toThrow();
    });

    it("rejects a non-integer expiresAt", () => {
        rejects({ quote: { ...quote(), expiresAt: Number.NaN } }, "MALFORMED_QUOTE");
    });
});

describe("verifyQuote — malformed wire input", () => {
    it("throws a TaxiError, not a raw Error, on unparseable info hex", () => {
        expect(() => verifyQuote({ ...args(), info: { ...info(), serverKey: "zz" } })).toThrow(
            TaxiError,
        );
    });

    it("throws a TaxiError on unparseable quote amounts", () => {
        expect(() =>
            verifyQuote({
                ...args(),
                quote: { ...quote(), params: { ...quoteParamsToWire(params()), dust: "-1" } },
            }),
        ).toThrow(TaxiError);
    });

    it("throws a TaxiError on a non-string covenantAddress", () => {
        expect(() =>
            verifyQuote({
                ...args(),
                quote: { ...quote(), covenantAddress: 7 as unknown as string },
            }),
        ).toThrow(TaxiError);
    });
});

describe("verifyQuote — defaults", () => {
    it("falls back to the wall clock when no now is supplied", () => {
        const a = args();
        delete a.now;
        expect(() => verifyQuote({ ...a, quote: { ...quote(), expiresAt: 1 } })).toThrow(
            /expired/i,
        );
    });
});
