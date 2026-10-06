import { describe, expect, it } from "vitest";
import { ArkAddress } from "@arkade-os/sdk";
import { hex } from "@scure/base";
import { vetBitcoinTaxi, type TaxiInfo } from "../src/wallet/context.js";

const serverKey = new Uint8Array(32).fill(1);
const emulatorKey = new Uint8Array(32).fill(2);
const receiverAddress = new ArkAddress(serverKey, new Uint8Array(32).fill(3), "tark").encode();
const ctx = { serverKey, emulatorKey, hrp: "tark", dust: 330n, vtxoMinAmount: 1n };
const info = (cap = "330") =>
    ({
        protocolVersion: 1,
        operatorKey: "44".repeat(32),
        serverKey: hex.encode(serverKey),
        emulatorKey: hex.encode(emulatorKey),
        arkdUrl: "https://arkd.example",
        emulatorUrl: "https://emulator.example",
        dust: "330",
        vtxoMinAmount: "1",
        maxPerPaymentTopupSats: cap,
        paused: false,
        assetRules: [
            {
                assetId: null,
                enabled: true,
                fares: [{ id: "sats", currency: "sats", pricing: { kind: "flat", units: "0" } }],
                claim: "recycle",
                maxTopupSats: null,
            },
        ],
    }) as unknown as TaxiInfo;

describe("vetBitcoinTaxi", () => {
    it.each([1n, 100n, 329n])("lends a whole dust unit beside %s sats", (amount) => {
        expect(vetBitcoinTaxi(info(), ctx, { receiverAddress, amount })).toMatchObject({
            ok: true,
            topup: 330n,
        });
    });

    it.each([0n, 330n])("refuses %s sats, which need no carrier or cannot be sent", (amount) => {
        expect(vetBitcoinTaxi(info(), ctx, { receiverAddress, amount })).toEqual({
            ok: false,
            reason: "amount-outside-carrier",
        });
    });

    it("refuses a Taxi whose loan cap is below a whole dust unit", () => {
        expect(vetBitcoinTaxi(info("329"), ctx, { receiverAddress, amount: 100n })).toEqual({
            ok: false,
            reason: "loan-cap-below-shortfall",
        });
    });
});
