/**
 * The security-critical file. A quote is an operator's claim about a covenant
 * the client is about to fund; nothing here trusts it.
 *
 * The address rebuild in step 8 is only meaningful because steps 2 and 3 pin
 * the Arkade Service and emulator keys against ones the caller already trusts.
 * An operator naming an emulator it controls would derive an address that
 * agrees with its own quote.
 */

import { DustCovenantScript, type DustCovenantParams } from "@arkade-taxi/covenant";
import {
    PROTOCOL_VERSION,
    type AssetIdValue,
    type InfoResponse,
    type QuoteResponse,
} from "@arkade-taxi/protocol";
import { causeMessage, decodeInfo, decodeQuote } from "./decode.js";
import { QuoteVerificationError, VerificationErrorCode, type VerificationCode } from "./errors.js";

declare const verified: unique symbol;

/** Proof that `verifyQuote` accepted this quote. The brand is unconstructible
 * outside this module, so `TaxiClient.submitLockup` cannot be reached without
 * having verified. */
export type VerifiedQuote = {
    readonly quote: QuoteResponse;
    readonly params: DustCovenantParams;
    readonly script: DustCovenantScript;
} & { readonly [verified]: true };

export interface QuoteExpectation {
    receiverKey: Uint8Array;
    senderKey: Uint8Array;
    assetId?: AssetIdValue;
    maxTopupSats: bigint;
    maxFeeSats: bigint;
    minLocktime: bigint;
}

export interface VerifyQuoteArgs {
    quote: QuoteResponse;
    info: InfoResponse;
    expect: QuoteExpectation;
    trustedServerKey: Uint8Array;
    trustedEmulatorKey: Uint8Array;
    vtxoMinAmount: bigint;
    hrp: string;
    /** Unix seconds. Injected only so expiry is testable; defaults to the clock. */
    now?: number;
}

const reject = (code: VerificationCode, detail: string): never => {
    throw new QuoteVerificationError(code, `taxi: ${detail}`);
};

const rewrap = <T>(code: VerificationCode, f: () => T): T => {
    try {
        return f();
    } catch (cause) {
        return reject(code, causeMessage(cause));
    }
};

const sameBytes = (a: Uint8Array, b: Uint8Array): boolean =>
    a.length === b.length && a.every((byte, i) => byte === b[i]);

const sameAsset = (a: AssetIdValue | undefined, b: AssetIdValue | undefined): boolean =>
    a === undefined || b === undefined
        ? a === b
        : a.groupIndex === b.groupIndex && sameBytes(a.txid, b.txid);

const describeAsset = (a: AssetIdValue | undefined): string => (a ? "an asset" : "bitcoin");

export function verifyQuote(args: VerifyQuoteArgs): VerifiedQuote {
    const { expect, trustedServerKey, trustedEmulatorKey, vtxoMinAmount, hrp } = args;

    const info = rewrap(VerificationErrorCode.MalformedInfo, () => decodeInfo(args.info));

    if (info.protocolVersion !== PROTOCOL_VERSION) {
        reject(
            VerificationErrorCode.ProtocolVersion,
            `operator speaks protocol ${info.protocolVersion}, this client speaks ${PROTOCOL_VERSION}`,
        );
    }
    if (!sameBytes(info.serverKey, trustedServerKey)) {
        reject(
            VerificationErrorCode.ServerKey,
            "operator named an Arkade Service key you do not trust",
        );
    }
    if (!sameBytes(info.emulatorKey, trustedEmulatorKey)) {
        reject(
            VerificationErrorCode.EmulatorKey,
            "operator named an emulator key you do not trust",
        );
    }

    const quote = rewrap(VerificationErrorCode.Malformed, () => decodeQuote(args.quote));
    const params: DustCovenantParams = quote.params;

    if (!sameBytes(params.receiverKey, expect.receiverKey)) {
        reject(VerificationErrorCode.ReceiverKey, "quote pays a receiver you did not ask to pay");
    }
    if (!sameBytes(params.senderKey, expect.senderKey)) {
        reject(VerificationErrorCode.SenderKey, "quote refunds a sender you did not name");
    }
    if (!sameAsset(params.assetId, expect.assetId)) {
        reject(
            VerificationErrorCode.AssetId,
            `quote moves ${describeAsset(params.assetId)}, you asked to pay ${describeAsset(expect.assetId)}`,
        );
    }
    if (!sameBytes(params.operatorKey, info.operatorKey)) {
        reject(
            VerificationErrorCode.OperatorKey,
            "quote repays an operator key /v1/info did not advertise",
        );
    }
    if (params.dust !== info.dust) {
        reject(
            VerificationErrorCode.Dust,
            `quote dust ${params.dust} is not the advertised ${info.dust}`,
        );
    }

    if (params.topup > expect.maxTopupSats) {
        reject(
            VerificationErrorCode.Topup,
            `topup ${params.topup} exceeds your max ${expect.maxTopupSats}`,
        );
    }
    if (quote.feeSats > expect.maxFeeSats) {
        reject(
            VerificationErrorCode.Fee,
            `fee ${quote.feeSats} exceeds your max ${expect.maxFeeSats}`,
        );
    }
    if (params.locktime < expect.minLocktime) {
        reject(
            VerificationErrorCode.Locktime,
            `locktime ${params.locktime} is earlier than your minimum ${expect.minLocktime}`,
        );
    }

    const now = args.now ?? Math.floor(Date.now() / 1000);
    if (now >= quote.expiresAt) {
        reject(VerificationErrorCode.Expired, `quote expired at ${quote.expiresAt}, now ${now}`);
    }

    // Built from the keys the caller trusts, never from the ones info claimed,
    // so weakening the pinning checks above cannot quietly re-enable the attack.
    const script = rewrap(
        VerificationErrorCode.InvalidParams,
        () =>
            new DustCovenantScript({
                serverKey: trustedServerKey,
                emulatorKey: trustedEmulatorKey,
                params,
                vtxoMinAmount,
            }),
    );

    const derived = script.address(hrp, trustedServerKey).encode();
    if (derived !== quote.covenantAddress) {
        reject(
            VerificationErrorCode.Address,
            `covenant address ${quote.covenantAddress} is not the one these parameters derive (${derived})`,
        );
    }

    return { quote: args.quote, params, script } as VerifiedQuote;
}
