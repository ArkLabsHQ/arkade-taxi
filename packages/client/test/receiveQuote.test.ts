import { ArkAddress } from "@arkade-os/sdk";
import { describe, expect, it, vi } from "vitest";
import { DustCovenantScript } from "@arkade-taxi/covenant";
import {
    assetIdToWire,
    bytesToHex,
    quoteParamsToWire,
    type InfoResponse,
    type ReceiveQuoteResponse,
} from "@arkade-taxi/protocol";
import { TaxiClient } from "../src/client.js";
import { verifyReceiveQuote } from "../src/receiveQuote.js";
import {
    emulatorKey,
    HRP,
    jsonResponse,
    operatorKey,
    receiverKey,
    recordingFetch,
    senderKey,
    serverKey,
} from "./fixtures.js";

const ASSET = { txid: new Uint8Array(32).fill(0x12), groupIndex: 7 };
const receiverAddress = new ArkAddress(serverKey, receiverKey, HRP).encode();
const params = {
    receiverKey,
    senderKey,
    operatorKey,
    dust: 330n,
    topup: 329n,
    assetId: ASSET,
    locktime: 849_856n,
    claimMode: "recycle" as const,
    recoveryRecipient: "receiver" as const,
};
const address = new DustCovenantScript({
    serverKey,
    emulatorKey,
    params,
    vtxoMinAmount: 1n,
})
    .address(HRP, serverKey)
    .encode();
const quote = (over: Partial<ReceiveQuoteResponse> = {}): ReceiveQuoteResponse => ({
    quoteId: "receive-1",
    state: "quoted",
    receiverAddress,
    makerPublicKey: bytesToHex(senderKey),
    params: quoteParamsToWire(params),
    covenantAddress: address,
    fare: { currency: "sats", units: "3" },
    batchExpiry: { kind: "height", value: "900000" },
    inputExpiryFloor: { kind: "height", value: "850000" },
    recoveryLocktime: { kind: "height", value: "849856" },
    createdAt: 1_000_000_000,
    expiresAt: 1_000_000_060,
    ...over,
});
const info = (): InfoResponse => ({
    protocolVersion: 1,
    operatorKey: bytesToHex(operatorKey),
    serverKey: bytesToHex(serverKey),
    emulatorKey: bytesToHex(emulatorKey),
    arkdUrl: "https://arkd.example",
    emulatorUrl: "https://emulator.example",
    dust: "330",
    vtxoMinAmount: "1",
    assetRules: [
        {
            assetId: assetIdToWire(ASSET),
            enabled: true,
            claim: "either",
            maxTopupSats: "329",
            unclaimedMode: "reclaim",
            fares: [{ id: "receive", currency: "sats", pricing: { kind: "flat", units: "3" } }],
        },
    ],
    maxPerPaymentTopupSats: "329",
    paused: false,
});
const args = () => ({
    quote: quote(),
    info: info(),
    expect: {
        receiverAddress,
        makerPublicKey: senderKey,
        assetId: ASSET,
        fareId: "receive",
        fundingExpiry: { kind: "height" as const, value: 850_000n },
        maxServiceFareSats: 3n,
        minRecoveryLocktime: { kind: "height" as const, value: 800_000n },
        minInputExpiryFloor: { kind: "height" as const, value: 850_000n },
    },
    trustedServerKey: serverKey,
    trustedEmulatorKey: emulatorKey,
    dust: 330n,
    vtxoMinAmount: 1n,
    hrp: HRP,
    now: 1_000_000_001,
});

// The receiver pays their own fare: the operator funds the whole dust (topup
// === dust), so the covenant tree differs from the sender-paid one above.
const receiverParams = { ...params, topup: 330n };

const senderPaidArgs = (
    over: { topup?: bigint; advertisedCurrency?: "sameAsset"; requestedReceiver?: boolean } = {},
) => {
    const baseArgs = args();
    return {
        ...baseArgs,
        expect: over.requestedReceiver
            ? { ...baseArgs.expect, payer: "receiver" as const }
            : baseArgs.expect,
        quote:
            over.topup === undefined
                ? baseArgs.quote
                : quote({ params: quoteParamsToWire({ ...params, topup: over.topup }) }),
        info:
            over.advertisedCurrency === undefined
                ? baseArgs.info
                : {
                      ...baseArgs.info,
                      assetRules: [
                          {
                              ...baseArgs.info.assetRules[0]!,
                              fares: [
                                  {
                                      ...baseArgs.info.assetRules[0]!.fares[0]!,
                                      currency: over.advertisedCurrency,
                                  },
                              ],
                          },
                      ],
                  },
    };
};

const receiverPaidArgs = (
    over: {
        fare?: { currency: "sats"; units: string };
        paramsUnits?: bigint;
        advertisedFlatUnits?: bigint;
        advertisedCurrency?: "sameAsset";
        receiverFareCurrency?: "sats" | "asset";
        unrequested?: boolean;
    } = {},
) => {
    const baseArgs = args();
    const currency: "sats" | "asset" = over.receiverFareCurrency ?? "sats";
    const quoteParams = {
        ...receiverParams,
        receiverFare: { currency, units: over.paramsUnits ?? 7n },
    };
    const covenantAddress = new DustCovenantScript({
        serverKey,
        emulatorKey,
        params: quoteParams,
        vtxoMinAmount: 1n,
    })
        .address(HRP, serverKey)
        .encode();
    return {
        ...baseArgs,
        expect: over.unrequested
            ? baseArgs.expect
            : { ...baseArgs.expect, payer: "receiver" as const },
        quote: quote({
            params: quoteParamsToWire(quoteParams),
            covenantAddress,
            fare: over.fare ?? { currency: "sats", units: "0" },
            receiverFare:
                currency === "asset"
                    ? { currency, units: "7", assetId: assetIdToWire(ASSET) }
                    : { currency, units: "7" },
            payer: "receiver",
            unclaimedMode: "reclaim",
        }),
        info: {
            ...baseArgs.info,
            assetRules: [
                {
                    ...baseArgs.info.assetRules[0]!,
                    maxTopupSats: "330",
                    fares: [
                        {
                            ...baseArgs.info.assetRules[0]!.fares[0]!,
                            currency: over.advertisedCurrency ?? ("sats" as const),
                            pricing: {
                                kind: "flat" as const,
                                units: String(over.advertisedFlatUnits ?? 7n),
                            },
                        },
                    ],
                },
            ],
        },
    };
};

describe("verifyReceiveQuote", () => {
    it("rebuilds the covenant and returns immutable SDK carrier terms", () => {
        const verified = verifyReceiveQuote(args());
        expect(verified.descriptor).toEqual({
            quoteId: "receive-1",
            receiveAddress: address,
            makerPublicKey: bytesToHex(senderKey),
            assetId: "12121212121212121212121212121212121212121212121212121212121212120700",
            physicalSats: 330n,
            loanSats: 329n,
            receiptSats: 1n,
            serviceFareSats: 3n,
            expiresAt: 1_000_000_060,
        });
        expect(Object.isFrozen(verified)).toBe(true);
        expect(Object.isFrozen(verified.descriptor)).toBe(true);
    });

    it("rejects a substituted floor even with a self-consistent replacement locktime", () => {
        const changed = { ...params, locktime: 859_856n };
        const covenantAddress = new DustCovenantScript({
            serverKey,
            emulatorKey,
            params: changed,
            vtxoMinAmount: 1n,
        })
            .address(HRP, serverKey)
            .encode();
        expect(() =>
            verifyReceiveQuote({
                ...args(),
                quote: quote({
                    params: quoteParamsToWire(changed),
                    covenantAddress,
                    inputExpiryFloor: { kind: "height", value: "860000" },
                    recoveryLocktime: { kind: "height", value: "859856" },
                }),
            }),
        ).toThrow(/floor/);
    });

    it("rejects an unknown pricing kind with plausible proportional fields", () => {
        const changed = info();
        changed.assetRules[0]!.fares[0]!.pricing = {
            kind: "tiered",
            bps: 100,
            minUnits: "3",
            maxUnits: "3",
        } as never;
        expect(() => verifyReceiveQuote({ ...args(), info: changed })).toThrow(/pricing/);
    });

    it.each([
        ["receiverAddress", { receiverAddress: `${receiverAddress}x` }],
        ["maker", { makerPublicKey: "00".repeat(32) }],
        [
            "asset",
            { params: { ...quote().params, assetId: { txid: "13".repeat(32), groupIndex: 7 } } },
        ],
        ["mode", { params: { ...quote().params, claimMode: "purchase" as const } }],
        ["recipient", { params: { ...quote().params, recoveryRecipient: "sender" as const } }],
        ["fare", { fare: { currency: "sats" as const, units: "4" } }],
        ["expiry", { expiresAt: 1_000_000_001 }],
        ["state", { state: "expired" as const }],
    ])("rejects immutable %s substitution", (_name, change) => {
        expect(() => verifyReceiveQuote({ ...args(), quote: quote(change) })).toThrow();
    });

    it("verifies a receiver-paid quote whose topup is the whole dust", () => {
        const verified = verifyReceiveQuote(receiverPaidArgs());
        expect(verified.descriptor.loanSats).toBe(330n);
        expect(verified.descriptor.receiptSats).toBe(0n);
        expect(verified.receiverFare?.units).toBe(7n);
        expect(verified.unclaimedMode).toBe("reclaim");
    });
    it("still refuses a sender-paid quote whose topup is not dust minus the receipt", () => {
        expect(() => verifyReceiveQuote(senderPaidArgs({ topup: 330n }))).toThrow(/carrier split/);
    });
    it("refuses a receiver-paid quote whose fill fare is not zero", () => {
        expect(() =>
            verifyReceiveQuote(receiverPaidArgs({ fare: { currency: "sats", units: "1" } })),
        ).toThrow(/receiver-paid quote charges the fill/);
    });
    it("refuses a quote whose params.receiverFare differs from its receiverFare field", () => {
        expect(() => verifyReceiveQuote(receiverPaidArgs({ paramsUnits: 8n }))).toThrow(
            /substituted the receiver fare/,
        );
    });
    // The policy comparison: the advertised fare is the RECEIVER's, not the fill's zero.
    it("compares the advertised fare against the receiver fare, not the fill fare", () => {
        expect(() =>
            verifyReceiveQuote(receiverPaidArgs({ advertisedFlatUnits: 7n })),
        ).not.toThrow();
        expect(() => verifyReceiveQuote(receiverPaidArgs({ advertisedFlatUnits: 8n }))).toThrow(
            /differs from advertised policy/,
        );
    });
    it("accepts a same-asset advertised fare on a receiver-paid quote", () => {
        expect(() =>
            verifyReceiveQuote(
                receiverPaidArgs({
                    advertisedCurrency: "sameAsset",
                    receiverFareCurrency: "asset",
                }),
            ),
        ).not.toThrow();
    });
    it("still refuses a same-asset advertised fare on a sender-paid quote", () => {
        expect(() =>
            verifyReceiveQuote(senderPaidArgs({ advertisedCurrency: "sameAsset" })),
        ).toThrow(/not in sats/);
    });
    it("refuses a receiver fare whose currency differs from the advertised policy", () => {
        expect(() =>
            verifyReceiveQuote(receiverPaidArgs({ receiverFareCurrency: "asset" })),
        ).toThrow(/receiver fare currency differs/);
    });
    it("refuses a sender-paid answer to a receiver-paid request", () => {
        expect(() => verifyReceiveQuote(senderPaidArgs({ requestedReceiver: true }))).toThrow(
            /payer is sender, but the request named receiver/,
        );
    });
    it("refuses a receiver-paid answer to an unrequested (sender-paid) request", () => {
        expect(() => verifyReceiveQuote(receiverPaidArgs({ unrequested: true }))).toThrow(
            /payer is receiver, but the request named sender/,
        );
    });
});

describe("TaxiClient receive quotes", () => {
    it("POSTs the exact request and GETs an untrusted quote", async () => {
        const fetch = recordingFetch((_url, init) =>
            jsonResponse(200, init.method === "POST" ? quote() : quote({ state: "expired" })),
        );
        const taxi = new TaxiClient({ baseUrl: "https://taxi.example", fetch });
        await taxi.requestReceiveQuote({
            receiverAddress,
            makerPublicKey: senderKey,
            assetId: ASSET,
            fareId: "receive",
            fundingExpiry: { kind: "height", value: 850_000n },
        });
        expect(JSON.parse(fetch.calls[0]!.init.body as string)).toEqual({
            receiverAddress,
            makerPublicKey: bytesToHex(senderKey),
            assetId: assetIdToWire(ASSET),
            fareId: "receive",
            fundingExpiry: { kind: "height", value: "850000" },
        });
        expect((await taxi.getReceiveQuote("receive-1")).state).toBe("expired");
    });

    it("reads a bound quote's fill id back without treating it as authority", async () => {
        const bound = quote({ state: "bound", boundFillId: "fill-1" });
        const fetch = recordingFetch(() => jsonResponse(200, bound));
        const taxi = new TaxiClient({ baseUrl: "https://taxi.example", fetch });
        expect(await taxi.getReceiveQuote("receive-1")).toEqual(bound);
        expect(() => verifyReceiveQuote({ ...args(), quote: bound })).toThrow(/bound, not usable/);
    });

    it("sends the payer opt-in, and refuses a downgraded sender-paid answer", async () => {
        const fetch = recordingFetch((_url, init) =>
            jsonResponse(200, init.method === "GET" ? info() : quote()),
        );
        const taxi = new TaxiClient({ baseUrl: "https://taxi.example", fetch });
        await expect(
            taxi.requestVerifiedReceiveQuote({
                receiverAddress,
                makerPublicKey: senderKey,
                assetId: ASSET,
                fareId: "receive",
                fundingExpiry: { kind: "height", value: 850_000n },
                payer: "receiver",
                trustedServerKey: serverKey,
                trustedEmulatorKey: emulatorKey,
                dust: 330n,
                vtxoMinAmount: 1n,
                hrp: HRP,
                expect: {
                    maxServiceFareSats: 3n,
                    minRecoveryLocktime: { kind: "height", value: 800_000n },
                    minInputExpiryFloor: { kind: "height", value: 850_000n },
                },
            }),
        ).rejects.toThrow(/payer is sender, but the request named receiver/);
        expect(JSON.parse(fetch.calls[1]!.init.body as string)).toMatchObject({
            payer: "receiver",
        });
    });

    it("refuses an invalid maker before any HTTP request", async () => {
        const fetch = vi.fn();
        const taxi = new TaxiClient({ baseUrl: "https://taxi.example", fetch });
        await expect(
            taxi.requestVerifiedReceiveQuote({
                receiverAddress,
                makerPublicKey: new Uint8Array(32).fill(0xff),
                assetId: ASSET,
                fareId: "receive",
                fundingExpiry: { kind: "height", value: 850_000n },
                trustedServerKey: serverKey,
                trustedEmulatorKey: emulatorKey,
                dust: 330n,
                vtxoMinAmount: 1n,
                hrp: HRP,
                expect: {
                    maxServiceFareSats: 3n,
                    minRecoveryLocktime: { kind: "height", value: 800_000n },
                    minInputExpiryFloor: { kind: "height", value: 850_000n },
                },
            }),
        ).rejects.toThrow();
        expect(fetch).not.toHaveBeenCalled();
    });
});
