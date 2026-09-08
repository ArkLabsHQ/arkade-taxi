import { SingleKey } from "@arkade-os/sdk";
import { DustCovenantScript, type DustCovenantParams } from "@arkade-taxi/covenant";
import { bytesToHex, quoteParamsToWire } from "@arkade-taxi/protocol";
import type { InfoResponse, QuoteResponse } from "@arkade-taxi/protocol";
import type { VerifyQuoteArgs } from "../src/verify.js";

// Real curve points: computeArkadeScriptPublicKey lifts the emulator key to do
// point addition, so 32 arbitrary bytes fail with "cannot find square root".
const xonly = (fill: number) =>
    SingleKey.fromPrivateKey(new Uint8Array(32).fill(fill)).xOnlyPublicKey();

export const receiverKey = await xonly(1);
export const senderKey = await xonly(2);
export const operatorKey = await xonly(3);
export const serverKey = await xonly(4);
export const emulatorKey = await xonly(5);
export const otherKey = await xonly(6);

export const HRP = "ark";
export const VTXO_MIN = 10n;
export const NOW = 1_000_000_000;

export const params = (): DustCovenantParams => ({
    receiverKey,
    senderKey,
    operatorKey,
    dust: 330n,
    topup: 330n,
    locktime: 800_000n,
});

export const addressFor = (
    p: DustCovenantParams,
    keys: { serverKey: Uint8Array; emulatorKey: Uint8Array } = { serverKey, emulatorKey },
): string =>
    new DustCovenantScript({ ...keys, params: p, vtxoMinAmount: VTXO_MIN })
        .address(HRP, keys.serverKey)
        .encode();

export const info = (): InfoResponse => ({
    protocolVersion: 1,
    operatorKey: bytesToHex(operatorKey),
    serverKey: bytesToHex(serverKey),
    emulatorKey: bytesToHex(emulatorKey),
    arkdUrl: "https://arkd.example",
    emulatorUrl: "https://emulator.example",
    dust: "330",
    vtxoMinAmount: "10",
    assetRules: [],
    maxPerPaymentTopupSats: "1000",
    paused: false,
});

export const quote = (): QuoteResponse => ({
    transferId: "tr_01",
    params: quoteParamsToWire(params()),
    covenantAddress: addressFor(params()),
    fare: { currency: "sats", units: "1" },
    expiresAt: NOW + 60,
    unsignedLockupTx: "cHNidP8BAA==",
});

export const args = (): VerifyQuoteArgs => ({
    quote: quote(),
    info: info(),
    expect: {
        receiverKey,
        senderKey,
        maxTopupSats: 330n,
        maxFare: { currency: "sats" as const, units: 10n },
        minLocktime: 700_000n,
    },
    trustedServerKey: serverKey,
    trustedEmulatorKey: emulatorKey,
    vtxoMinAmount: VTXO_MIN,
    hrp: HRP,
    now: NOW,
});

export const jsonResponse = (status: number, body: unknown): Response =>
    new Response(JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json" },
    });

export type FetchCall = { url: string; init: RequestInit };

export function recordingFetch(
    reply: (url: string, init: RequestInit) => Response | Promise<Response>,
): typeof fetch & { calls: FetchCall[] } {
    const calls: FetchCall[] = [];
    const fn = async (input: unknown, init: RequestInit = {}) => {
        calls.push({ url: String(input), init });
        return reply(String(input), init);
    };
    return Object.assign(fn as unknown as typeof fetch, { calls });
}
