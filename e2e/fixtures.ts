import type { Advance, Policy, QuoteRequest } from "@arkade-taxi/core";
import { DustCovenantScript, type DustCovenantParams } from "@arkade-taxi/covenant";
import {
    bytesToHex,
    quoteParamsToWire,
    type InfoResponse,
    type QuoteResponse,
} from "@arkade-taxi/protocol";
import type { VerifyQuoteArgs } from "@arkade-taxi/client";

const hex = (s: string): Uint8Array => Uint8Array.from(s.match(/../g)!.map((b) => parseInt(b, 16)));

/**
 * Real curve points, x-only, from private keys filled with 0x01..0x07.
 * `computeArkadeScriptPublicKey` lifts the emulator key to do point addition, so
 * 32 arbitrary bytes fail with "cannot find square root".
 */
export const receiverKey = hex("1b84c5567b126440995d3ed5aaba0565d71e1834604819ff9c17f5e9d5dd078f");
export const senderKey = hex("4d4b6cd1361032ca9bd2aeb9d900aa4d45d9ead80ac9423374c451a7254d0766");
export const operatorKey = hex("531fe6068134503d2723133227c867ac8fa6c83c537e9a44c3c5bdbdcb1fe337");
export const serverKey = hex("462779ad4aad39514614751a71085f2f10e1c7a593e4e030efb5b8721ce55b0b");
export const emulatorKey = hex("62c0a046dacce86ddd0343c6d3c7c79c2208ba0d9c9cf24a6d046d21d21f90f7");
export const rogueEmulatorKey = hex(
    "f006a18d5653c4edf5391ff23a61f03ff83d237e880ee61187fa9f379a028e0a",
);
export const rogueServerKey = hex(
    "989c0b76cb563971fdc9bef31ec06c3560f3249d6ee9e5d83c57625596e05f6f",
);

export const HRP = "ark";
export const DUST = 330n;
export const VTXO_MIN = 10n;
export const LOCKTIME = 800_000n;
export const NOW = 1_800_000_000;

export const params = (): DustCovenantParams => ({
    receiverKey,
    senderKey,
    operatorKey,
    dust: DUST,
    topup: DUST,
    locktime: LOCKTIME,
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
    arkdUrl: "http://localhost:7070",
    emulatorUrl: "http://localhost:7073",
    dust: "330",
    vtxoMinAmount: "10",
    assetRules: [],
    maxPerPaymentTopupSats: "1000",
    paused: false,
});

export const quote = (): QuoteResponse => ({
    transferId: "tr_e2e_01",
    params: quoteParamsToWire(params()),
    covenantAddress: addressFor(params()),
    fare: { currency: "sats", units: "1" },
    expiresAt: NOW + 60,
    unsignedLockupTx: "cHNidP8BAA==",
});

export const verifyArgs = (): VerifyQuoteArgs => ({
    quote: quote(),
    info: info(),
    expect: {
        receiverKey,
        senderKey,
        maxTopupSats: DUST,
        maxFare: { currency: "sats" as const, units: 10n },
        minLocktime: 700_000n,
    },
    trustedServerKey: serverKey,
    trustedEmulatorKey: emulatorKey,
    vtxoMinAmount: VTXO_MIN,
    hrp: HRP,
    now: NOW,
});

export const policy = (over: Partial<Policy> = {}): Policy => ({
    paused: false,
    maxOutstandingSats: 1_000n,
    maxPerPaymentTopupSats: 1_000n,
    maxConcurrentAdvances: 8,
    locktimeMarginBlocks: 144,
    assetRules: [
        {
            assetId: null,
            enabled: true,
            fares: [
                {
                    id: "sats",
                    currency: { kind: "sats" as const },
                    pricing: { kind: "flat" as const, units: 1n },
                },
            ],
            claim: "either" as const,
            maxTopupSats: null,
        },
    ],
    quoteTtlSeconds: 60,
    ...over,
});

export const advance = (over: Partial<Advance> & Pick<Advance, "id">): Advance => ({
    state: "locked",
    receiverKey,
    senderKey,
    operatorKey,
    dust: DUST,
    topup: DUST,
    locktime: LOCKTIME,
    covenantAddress: addressFor(params()),
    fare: { currency: "sats" as const, units: 1n },
    createdAt: NOW,
    updatedAt: NOW,
    expiresAt: NOW + 60,
    ...over,
});

/** Zero sender sats: the operator funds the whole dust unit, so topup == dust. */
export const quoteRequest = (over: Partial<QuoteRequest> = {}): QuoteRequest => ({
    receiverKey,
    senderKey,
    senderSats: 0n,
    ...over,
});
