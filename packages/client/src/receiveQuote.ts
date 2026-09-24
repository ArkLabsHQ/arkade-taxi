import { ArkAddress, asset } from "@arkade-os/sdk";
import { DustCovenantScript, type DustCovenantParams } from "@arkade-taxi/covenant";
import {
    PROTOCOL_VERSION,
    assetIdFromWire,
    satsFromWire,
    type AssetIdValue,
    type InfoResponse,
    type ReceiveQuoteResponse,
} from "@arkade-taxi/protocol";
import { hex } from "@scure/base";
import { decodeInfo, decodeReceiveQuote, type DecodedReceiveQuote } from "./decode.js";
import { QuoteVerificationError, VerificationErrorCode, type VerificationCode } from "./errors.js";
import { immutablePlainCopy } from "./lockup.js";

declare const verifiedReceive: unique symbol;

export interface RecycleCarrierQuote {
    quoteId: string;
    receiveAddress: string;
    makerPublicKey: string;
    assetId: string;
    physicalSats: bigint;
    loanSats: bigint;
    receiptSats: bigint;
    serviceFareSats: bigint;
    expiresAt: number;
}

export interface ReceiveQuoteExpectation {
    receiverAddress: string;
    makerPublicKey: Uint8Array;
    assetId: AssetIdValue;
    fareId?: string;
    fundingExpiry?: { kind: "height" | "time"; value: bigint };
    maxServiceFareSats: bigint;
    minRecoveryLocktime: { kind: "height" | "time"; value: bigint };
    minInputExpiryFloor: { kind: "height" | "time"; value: bigint };
}

export interface VerifyReceiveQuoteArgs {
    quote: ReceiveQuoteResponse;
    info: InfoResponse;
    expect: ReceiveQuoteExpectation;
    trustedServerKey: Uint8Array;
    trustedEmulatorKey: Uint8Array;
    dust: bigint;
    vtxoMinAmount: bigint;
    hrp: string;
    now?: number;
}

export type FareSpec = NonNullable<DecodedReceiveQuote["receiverFare"]>;

export type VerifiedReceiveQuote = {
    readonly quote: ReceiveQuoteResponse;
    readonly params: DustCovenantParams;
    readonly script: DustCovenantScript;
    readonly descriptor: RecycleCarrierQuote;
    /** Present only when the receiver, not the sender, pays the claim fare. */
    readonly receiverFare?: FareSpec;
    readonly unclaimedMode?: "reclaim";
} & { readonly [verifiedReceive]: true };

const reject = (code: VerificationCode, detail: string): never => {
    throw new QuoteVerificationError(code, `taxi: ${detail}`);
};
const sameBytes = (a: Uint8Array, b: Uint8Array): boolean =>
    a.length === b.length && a.every((byte, index) => byte === b[index]);
const sameAsset = (a: AssetIdValue, b: AssetIdValue): boolean =>
    a.groupIndex === b.groupIndex && sameBytes(a.txid, b.txid);
const sameDeadline = (
    a: { kind: "height" | "time"; value: bigint },
    b: { kind: "height" | "time"; value: bigint },
): boolean => a.kind === b.kind && a.value === b.value;
// Absent on one side, present on the other, counts as a disagreement.
const sameReceiverFare = (
    a: { currency: "sats" | "asset"; units: bigint } | undefined,
    b: { currency: "sats" | "asset"; units: bigint } | undefined,
): boolean =>
    a !== undefined && b !== undefined && a.currency === b.currency && a.units === b.units;

export function verifyReceiveQuote(raw: VerifyReceiveQuoteArgs): VerifiedReceiveQuote {
    const args = immutablePlainCopy(raw, "receive quote verification request");
    const info = decodeInfo(args.info);
    const quote = decodeReceiveQuote(args.quote);
    const { expect } = args;
    if (info.protocolVersion !== PROTOCOL_VERSION)
        reject(VerificationErrorCode.ProtocolVersion, "receive quote protocol version differs");
    if (!sameBytes(info.serverKey, args.trustedServerKey))
        reject(VerificationErrorCode.ServerKey, "receive quote names an untrusted server");
    if (!sameBytes(info.emulatorKey, args.trustedEmulatorKey))
        reject(VerificationErrorCode.EmulatorKey, "receive quote names an untrusted emulator");
    if (info.dust !== args.dust || info.vtxoMinAmount !== args.vtxoMinAmount)
        reject(VerificationErrorCode.Dust, "advertised server limits differ from trusted limits");
    if (info.paused) reject(VerificationErrorCode.MalformedInfo, "operator policy is paused");
    if (quote.state !== "quoted")
        reject(VerificationErrorCode.Expired, `receive quote is ${quote.state}, not usable`);

    let receiver: ArkAddress;
    try {
        receiver = ArkAddress.decode(expect.receiverAddress);
    } catch {
        reject(VerificationErrorCode.ReceiverKey, "expected receiver address is invalid");
    }
    if (
        receiver!.encode() !== expect.receiverAddress ||
        receiver!.hrp !== args.hrp ||
        !sameBytes(receiver!.serverPubKey, args.trustedServerKey)
    )
        reject(VerificationErrorCode.ReceiverKey, "receiver address is not trusted and canonical");
    if (quote.receiverAddress !== expect.receiverAddress)
        reject(VerificationErrorCode.ReceiverKey, "receive quote substituted the receiver address");
    if (!sameBytes(quote.params.receiverKey, receiver!.vtxoTaprootKey))
        reject(VerificationErrorCode.ReceiverKey, "receive quote substituted the receiver key");
    if (!sameBytes(quote.params.senderKey, expect.makerPublicKey))
        reject(VerificationErrorCode.SenderKey, "receive quote substituted the maker key");
    if (quote.makerPublicKey !== hex.encode(expect.makerPublicKey))
        reject(VerificationErrorCode.SenderKey, "receive quote substituted makerPublicKey");
    if (!quote.params.assetId || !sameAsset(quote.params.assetId, expect.assetId))
        reject(VerificationErrorCode.AssetId, "receive quote substituted the asset");
    if (!sameBytes(quote.params.operatorKey, info.operatorKey))
        reject(VerificationErrorCode.OperatorKey, "receive quote substituted the operator key");

    const receipt = args.vtxoMinAmount;
    const senderLoan = args.dust - receipt;
    if (receipt <= 0n || senderLoan < receipt || senderLoan + receipt !== args.dust)
        reject(VerificationErrorCode.Topup, "trusted limits do not form a positive carrier split");
    const receiverPaid = quote.payer === "receiver";
    const loan = receiverPaid ? args.dust : senderLoan;
    if (quote.params.dust !== args.dust || quote.params.topup !== loan)
        reject(VerificationErrorCode.Topup, "receive quote substituted the carrier split");
    if (quote.params.claimMode !== "recycle")
        reject(VerificationErrorCode.ClaimMode, "receive quote did not commit to recycle");
    if (quote.params.recoveryRecipient !== "receiver")
        reject(
            VerificationErrorCode.RecoveryRecipient,
            "receive quote recovery is not receiver-owned",
        );
    if (receiverPaid) {
        if (quote.fare.currency !== "sats" || quote.fare.units !== 0n)
            reject(VerificationErrorCode.Fee, "receiver-paid quote charges the fill a fare");
        if (!sameReceiverFare(quote.params.receiverFare, quote.receiverFare))
            reject(VerificationErrorCode.Fee, "receive quote substituted the receiver fare");
    } else {
        if (quote.fare.currency !== "sats")
            reject(VerificationErrorCode.Fee, "receive quote fare is not denominated in sats");
        if (quote.fare.units > expect.maxServiceFareSats)
            reject(VerificationErrorCode.Fee, "receive quote fare exceeds the caller ceiling");
    }
    verifyPolicy(
        info.assetRules,
        info.maxPerPaymentTopupSats,
        expect,
        loan,
        receiverPaid ? quote.receiverFare!.units : quote.fare.units,
        receiverPaid,
    );

    const { batchExpiry: batch, inputExpiryFloor: floor, recoveryLocktime: recovery } = quote;
    if (batch.kind !== floor.kind || floor.kind !== recovery.kind)
        reject(VerificationErrorCode.Locktime, "receive quote expiry domains differ");
    if (floor.value > batch.value || recovery.value >= floor.value)
        reject(VerificationErrorCode.Locktime, "receive quote lifetime ordering is unsafe");
    const expectedFloor = expect.fundingExpiry
        ? {
              kind: batch.kind,
              value:
                  expect.fundingExpiry.value < batch.value
                      ? expect.fundingExpiry.value
                      : batch.value,
          }
        : batch;
    if (expect.fundingExpiry && expect.fundingExpiry.kind !== batch.kind)
        reject(
            VerificationErrorCode.Locktime,
            "funding expiry domain differs from operator inputs",
        );
    if (!sameDeadline(floor, expectedFloor))
        reject(VerificationErrorCode.Locktime, "receive quote substituted the input expiry floor");
    if (quote.params.locktime !== recovery.value)
        reject(VerificationErrorCode.Locktime, "covenant locktime differs from recoveryLocktime");
    for (const [actual, minimum, label] of [
        [floor, expect.minInputExpiryFloor, "input expiry floor"],
        [recovery, expect.minRecoveryLocktime, "recovery locktime"],
    ] as const)
        if (actual.kind !== minimum.kind || actual.value < minimum.value)
            reject(VerificationErrorCode.Locktime, `${label} is below the caller minimum`);

    const now = args.now ?? Math.floor(Date.now() / 1000);
    if (quote.createdAt >= quote.expiresAt || now >= quote.expiresAt)
        reject(VerificationErrorCode.Expired, "receive quote has expired or invalid timestamps");
    let script: DustCovenantScript;
    try {
        script = new DustCovenantScript({
            serverKey: args.trustedServerKey,
            emulatorKey: args.trustedEmulatorKey,
            params: quote.params,
            vtxoMinAmount: args.vtxoMinAmount,
        });
    } catch (cause) {
        reject(
            VerificationErrorCode.InvalidParams,
            cause instanceof Error ? cause.message : "invalid receive covenant params",
        );
    }
    if (script!.address(args.hrp, args.trustedServerKey).encode() !== quote.covenantAddress)
        reject(VerificationErrorCode.Address, "receive covenant address does not match its terms");

    const descriptor = immutablePlainCopy<RecycleCarrierQuote>(
        {
            quoteId: quote.quoteId,
            receiveAddress: quote.covenantAddress,
            makerPublicKey: quote.makerPublicKey,
            assetId: asset.AssetId.create(
                hex.encode(Uint8Array.from(expect.assetId.txid).reverse()),
                expect.assetId.groupIndex,
            ).toString(),
            physicalSats: args.dust,
            loanSats: loan,
            receiptSats: receiverPaid ? 0n : receipt,
            serviceFareSats: receiverPaid ? 0n : quote.fare.units,
            expiresAt: quote.expiresAt,
        },
        "receive carrier descriptor",
    );
    return Object.freeze({
        quote: immutablePlainCopy(args.quote, "verified receive quote view"),
        params: immutablePlainCopy(quote.params, "verified receive params"),
        script: script!,
        descriptor,
        ...(receiverPaid
            ? {
                  receiverFare: immutablePlainCopy(quote.receiverFare, "verified receiver fare"),
                  unclaimedMode: quote.unclaimedMode,
              }
            : {}),
    }) as VerifiedReceiveQuote;
}

function verifyPolicy(
    rules: InfoResponse["assetRules"],
    globalCap: bigint,
    expect: ReceiveQuoteExpectation,
    loan: bigint,
    fare: bigint,
    receiverPaid: boolean,
): void {
    const foundRule = (rules as unknown[]).find((candidate) => {
        if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) return false;
        const id = (candidate as { assetId?: unknown }).assetId;
        if (!id || typeof id !== "object" || Array.isArray(id)) return false;
        if (Object.keys(id).sort().join() !== "groupIndex,txid") return false;
        try {
            return sameAsset(
                assetIdFromWire(id as Parameters<typeof assetIdFromWire>[0]),
                expect.assetId,
            );
        } catch {
            return false;
        }
    });
    const rule = (foundRule ??
        reject(
            VerificationErrorCode.AssetId,
            "asset is absent from advertised policy",
        )) as InfoResponse["assetRules"][number];
    if (
        typeof rule.enabled !== "boolean" ||
        !rule.enabled ||
        (rule.claim !== "recycle" && rule.claim !== "either")
    )
        reject(VerificationErrorCode.ClaimMode, "advertised policy does not allow recycle");
    if (!Array.isArray(rule.fares))
        reject(VerificationErrorCode.MalformedInfo, "advertised fares are invalid");
    const cap =
        rule.maxTopupSats === null ? globalCap : parseAmount(rule.maxTopupSats, "asset topup cap");
    if (loan > cap) reject(VerificationErrorCode.Topup, "loan exceeds the advertised policy cap");
    const foundOption = expect.fareId
        ? (rule.fares as unknown[]).find(
              (candidate) =>
                  !!candidate &&
                  typeof candidate === "object" &&
                  (candidate as { id?: unknown }).id === expect.fareId,
          )
        : rule.fares[0];
    const option = (foundOption ??
        reject(
            VerificationErrorCode.Fee,
            "advertised receive fare is missing",
        )) as InfoResponse["assetRules"][number]["fares"][number];
    if (
        !option ||
        typeof option !== "object" ||
        (receiverPaid
            ? option.currency !== "sats" && option.currency !== "sameAsset"
            : option.currency !== "sats")
    )
        reject(VerificationErrorCode.Fee, "advertised receive fare is missing or not in sats");
    if (!option.pricing || typeof option.pricing !== "object")
        reject(VerificationErrorCode.MalformedInfo, "advertised receive pricing is invalid");
    let expectedFare = 0n;
    if (option.pricing.kind === "flat") {
        expectedFare = parseAmount(option.pricing.units, "flat fare");
    } else if (option.pricing.kind === "proportional") {
        const { bps } = option.pricing;
        if (!Number.isInteger(bps) || bps < 0 || bps > 10_000)
            reject(VerificationErrorCode.Fee, "advertised proportional fare is invalid");
        const min = parseAmount(option.pricing.minUnits, "minimum fare");
        const max =
            option.pricing.maxUnits === null
                ? null
                : parseAmount(option.pricing.maxUnits, "maximum fare");
        const raw = (loan * BigInt(bps)) / 10_000n;
        expectedFare = raw < min ? min : raw;
        if (max !== null && expectedFare > max) expectedFare = max;
    } else {
        reject(VerificationErrorCode.MalformedInfo, "advertised receive pricing is invalid");
    }
    if (fare !== expectedFare)
        reject(VerificationErrorCode.Fee, "receive quote fare differs from advertised policy");
}

const parseAmount = (value: string, label: string): bigint => {
    if (typeof value !== "string" || !/^(0|[1-9][0-9]*)$/.test(value))
        return reject(VerificationErrorCode.MalformedInfo, `${label} is invalid`);
    try {
        return satsFromWire(value, label);
    } catch {
        return reject(VerificationErrorCode.MalformedInfo, `${label} is invalid`);
    }
};
