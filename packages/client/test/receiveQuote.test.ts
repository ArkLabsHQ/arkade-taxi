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
