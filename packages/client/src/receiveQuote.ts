import { ArkAddress, VtxoScript, asset } from "@arkade-os/sdk";
import {
    DustCovenantScript,
    type DustCovenantParams,
    type RelativeTimelock,
} from "@arkade-taxi/covenant";
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
import { assertExitDelayFloor } from "./verify.js";

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
    /** Opt-in: the request that produced this quote asked the receiver to pay. */
    payer?: "receiver";
    maxServiceFareSats: bigint;
    minRecoveryLocktime: { kind: "height" | "time"; value: bigint };
    minInputExpiryFloor: { kind: "height" | "time"; value: bigint };
    /** Floor for params.exitDelay (omit to accept any); see docs/protocol.md "Verification". */
    minExitDelay?: RelativeTimelock;
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
    if (info.protocolVersion !== PROTOCOL_VERSION)
        reject(VerificationErrorCode.ProtocolVersion, "receive quote protocol version differs");
    const quote = decodeReceiveQuote(args.quote);
    const { expect } = args;
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

    if (args.vtxoMinAmount <= 0n || args.dust <= 0n)
        reject(VerificationErrorCode.Topup, "trusted limits do not form a positive loan");
    const receiverPaid = quote.payer === "receiver";
    const requestedReceiverPaid = expect.payer === "receiver";
    if (requestedReceiverPaid !== receiverPaid)
        reject(
            VerificationErrorCode.Fee,
            `receive quote payer is ${receiverPaid ? "receiver" : "sender"}, but the request named ${requestedReceiverPaid ? "receiver" : "sender"}`,
        );
    const loan = args.dust;
    if (quote.params.dust !== args.dust || quote.params.topup !== loan)
        reject(VerificationErrorCode.Topup, "receive quote substituted the whole-dust loan");
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
        receiverPaid ? quote.receiverFare!.currency : undefined,
    );

    const { batchExpiry: batch, inputExpiryFloor: floor, recoveryLocktime: recovery } = quote;
    // Floor and batch expiry are one funding fact and must still agree; the
    // recovery deadline is a separate clock that outlives them on purpose.
    if (batch.kind !== floor.kind)
        reject(VerificationErrorCode.Locktime, "receive quote funding expiry domains differ");
    if (floor.value > batch.value)
        reject(VerificationErrorCode.Locktime, "receive quote funding ordering is unsafe");
    if (recovery.kind !== "time" || recovery.value <= BigInt(quote.createdAt))
        reject(
            VerificationErrorCode.Locktime,
            "receive quote recovery locktime is not a future wall-clock deadline",
        );
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
    assertExitDelayFloor(quote.params.exitDelay, expect.minExitDelay);

    // The reserved coins and the script every Taxi output must pay. Checked on
    // the quote's own terms, not re-derived from `info.operatorKey`: the Taxi
    // may legitimately pay a different script later, and what matters is that a
    // builder builds against the script the Taxi said it would accept.
    if (!quote.operatorInputs.length)
        reject(VerificationErrorCode.OperatorFunding, "receive quote reserves no operator funding");
    if (
        quote.operatorScript.length !== 34 ||
        quote.operatorScript[0] !== 0x51 ||
        quote.operatorScript[1] !== 0x20
    )
        reject(
            VerificationErrorCode.OperatorFunding,
            "receive quote operatorScript is not a taproot output script",
        );
    const seen = new Set<string>();
    for (const [index, input] of quote.operatorInputs.entries()) {
        const at = `operator input ${index}`;
        const outpoint = `${input.txid}:${input.vout}`;
        if (seen.has(outpoint))
            reject(VerificationErrorCode.OperatorFunding, `${at} repeats an outpoint`);
        seen.add(outpoint);
        if (input.value <= 0n)
            reject(VerificationErrorCode.OperatorFunding, `${at} reserves no value`);
        let leaf: unknown;
        try {
            leaf = VtxoScript.decode(input.tapTree).findLeaf(hex.encode(input.spendLeaf));
        } catch {
            reject(
                VerificationErrorCode.OperatorFunding,
                `${at} spend leaf is not in its own tap tree`,
            );
        }
        if (!leaf)
            reject(
                VerificationErrorCode.OperatorFunding,
                `${at} spend leaf is not in its own tap tree`,
            );
        if (input.expiry.kind !== floor.kind || input.expiry.value < floor.value)
            reject(
                VerificationErrorCode.OperatorFunding,
                `${at} expires before the quote's own input expiry floor`,
            );
    }

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
            receiptSats: 0n,
            serviceFareSats: receiverPaid ? 0n : quote.fare.units,
            expiresAt: quote.expiresAt,
        },
        "receive carrier descriptor",
    );
    return Object.freeze({
        quote: immutablePlainCopy(args.quote, "verified receive quote view"),
        params: immutablePlainCopy<DustCovenantParams>(quote.params, "verified receive params"),
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
    fareCurrency: "sats" | "asset" | undefined,
): void {
    const idOf = (candidate: unknown): unknown =>
        candidate && typeof candidate === "object" && !Array.isArray(candidate)
            ? (candidate as { assetId?: unknown }).assetId
            : undefined;
    const foundRule =
        (rules as unknown[]).find((candidate) => {
            const id = idOf(candidate);
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
        }) ?? (rules as unknown[]).find((candidate) => idOf(candidate) === "*");
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
        reject(
            VerificationErrorCode.Fee,
            receiverPaid
                ? "advertised receive fare is missing or not sats/sameAsset"
                : "advertised receive fare is missing or not in sats",
        );
    if (receiverPaid && fareCurrency !== (option.currency === "sats" ? "sats" : "asset"))
        reject(
            VerificationErrorCode.Fee,
            "receive quote receiver fare currency differs from advertised policy",
        );
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
