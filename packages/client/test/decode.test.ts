import { describe, expect, it } from "vitest";
import {
    quoteParamsFromWire,
    quoteParamsToWire,
    type AssetIdWire,
    type AssetRuleWire,
    type CovenantParamsValue,
    type InfoResponse,
    type QuoteParams,
    type ReceiveQuoteResponse,
    type ReceiverClaimDescriptorWire,
} from "@arkade-taxi/protocol";
import { decodeInfo, decodeReceiveQuote, decodeReceiverClaimDescriptor } from "../src/decode.js";

const hex32 = (byte: string) => byte.repeat(32);
const fill32 = (byte: number) => new Uint8Array(32).fill(byte);

const receiverKey = hex32("01");
const senderKey = hex32("02");
const operatorKey = hex32("03");

export const anyAsset: AssetIdWire = { txid: hex32("11"), groupIndex: 0 };

const paramsWire = (): QuoteParams => ({
    receiverKey,
    senderKey,
    operatorKey,
    dust: "330",
    topup: "330",
    locktime: "800000",
});

export const receiverPaidParams = (): CovenantParamsValue => ({
    receiverKey: fill32(1),
    senderKey: fill32(2),
    operatorKey: fill32(3),
    dust: 330n,
    topup: 330n,
    locktime: 800_000n,
    assetId: { txid: fill32(0x11), groupIndex: 0 },
    recoveryRecipient: "receiver",
    claimMode: "recycle",
    receiverFare: { currency: "sats", units: 7n },
});

const receiveQuoteWire = (): ReceiveQuoteResponse => ({
    quoteId: "receive-1",
    state: "quoted",
    receiverAddress: "ark1qreceiver",
    makerPublicKey: senderKey,
    params: paramsWire(),
    covenantAddress: "ark1qcovenant",
    fare: { currency: "sats", units: "3" },
    batchExpiry: { kind: "height", value: "900000" },
    inputExpiryFloor: { kind: "height", value: "850000" },
    recoveryLocktime: { kind: "height", value: "849856" },
    createdAt: 1_000_000_000,
    expiresAt: 1_000_000_060,
});

const receiverPaidQuoteWire = (): ReceiveQuoteResponse => ({
    ...receiveQuoteWire(),
    params: quoteParamsToWire(receiverPaidParams()),
    payer: "receiver",
    receiverFare: { currency: "sats", units: "7" },
    unclaimedMode: "reclaim",
});

const descriptorWire = (): ReceiverClaimDescriptorWire => ({
    params: paramsWire(),
    covenantAddress: "ark1qcovenant",
    outpoint: { txid: hex32("aa"), vout: 0 },
    fare: { currency: "sats", units: "3" },
    batchExpiry: { kind: "height", value: "900000" },
    recoveryLocktime: { kind: "height", value: "849856" },
});

const ruleWire = (): AssetRuleWire => ({
    assetId: null,
    enabled: true,
    fares: [{ id: "sats", currency: "sats", pricing: { kind: "flat", units: "0" } }],
    claim: "either",
    maxTopupSats: null,
    unclaimedMode: "reclaim",
});

const infoWire = (): InfoResponse => ({
    protocolVersion: 1,
    operatorKey,
    serverKey: hex32("04"),
    emulatorKey: hex32("05"),
    arkdUrl: "https://arkd.example",
    emulatorUrl: "https://emulator.example",
    dust: "330",
    vtxoMinAmount: "10",
    assetRules: [],
    maxPerPaymentTopupSats: "1000",
    paused: false,
});

describe("decode", () => {
    it("round-trips receiverFare through the params codec", () => {
        const params = receiverPaidParams();
        expect(quoteParamsFromWire(quoteParamsToWire(params))).toEqual(params);
    });

    it("decodes a receive quote carrying payer, receiverFare and unclaimedMode", () => {
        expect(decodeReceiveQuote(receiverPaidQuoteWire()).payer).toBe("receiver");
    });

    it("still rejects an unknown receive-quote field", () => {
        expect(() => decodeReceiveQuote({ ...receiveQuoteWire(), surprise: 1 })).toThrow(
            /surprise/,
        );
    });

    it("rejects payer without receiverFare, and receiverFare without payer", () => {
        expect(() => decodeReceiveQuote({ ...receiveQuoteWire(), payer: "receiver" })).toThrow(
            /together/,
        );
        expect(() =>
            decodeReceiveQuote({
                ...receiveQuoteWire(),
                receiverFare: { currency: "sats", units: "7" },
            }),
        ).toThrow(/together/);
    });

    it("rejects an unclaimedMode this build does not implement, on the quote", () => {
        expect(() =>
            decodeReceiveQuote({ ...receiverPaidQuoteWire(), unclaimedMode: "custody" }),
        ).toThrow(/unclaimedMode/);
    });

    it("rejects an unclaimedMode this build does not implement, on the claim descriptor", () => {
        expect(() =>
            decodeReceiverClaimDescriptor({ ...descriptorWire(), unclaimedMode: "custody" }),
        ).toThrow(/unclaimedMode/);
        expect(() =>
            decodeReceiverClaimDescriptor({ ...descriptorWire(), unclaimedMode: "reclaim" }),
        ).not.toThrow();
        expect(() => decodeReceiverClaimDescriptor({ ...descriptorWire(), surprise: 1 })).toThrow(
            /surprise/,
        );
    });

    it("requires assetId on an asset receiverFare and refuses it on a sats one", () => {
        expect(() =>
            decodeReceiveQuote({
                ...receiverPaidQuoteWire(),
                receiverFare: { currency: "asset", units: "9" },
            }),
        ).toThrow(/assetId/);
        expect(() =>
            decodeReceiveQuote({
                ...receiverPaidQuoteWire(),
                receiverFare: { currency: "sats", units: "7", assetId: anyAsset },
            }),
        ).toThrow(/assetId/);
    });

    it("ignores an unknown asset-rule field on /v1/info", () => {
        const info = {
            ...infoWire(),
            assetRules: [{ ...ruleWire(), unclaimedMode: "reclaim" as const, future: 1 }],
        };
        expect(() => decodeInfo(info)).not.toThrow();
    });
});
