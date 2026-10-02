/**
 * Sponsored direct-send verification. Mirrors `lockup.ts`, but the joint
 * transaction pays the receiver's own address instead of a covenant: there is
 * no covenant script to re-derive and no emulator key to pin, so the payment
 * output script is checked against the receiver address the caller asked to
 * pay. Nothing here trusts the operator's quote.
 */

import {
    ArkAddress,
    Extension,
    UnknownPacket,
    Transaction,
    asset,
    assertAllowedSighashTypes,
    type Identity,
} from "@arkade-os/sdk";
import {
    PROTOCOL_VERSION,
    fundingInputToWire,
    satsFromWire,
    type FundingInputValue,
    type InfoResponse,
    type SponsoredParamsValue,
    type SponsoredQuoteResponse,
} from "@arkade-taxi/protocol";
import { hex } from "@scure/base";
import { SigHash } from "@scure/btc-signer";
import { QuoteVerificationError, VerificationErrorCode, type VerificationCode } from "./errors.js";
import { decodeInfo, decodeSponsoredQuote } from "./decode.js";
import {
    assetId,
    decodeLockupEnvelope,
    graphId,
    immutablePlainCopy,
    jointTxChecks,
    ownerScript,
    rewrap,
    sameAsset,
    sameBytes,
    unsignedCopy,
    type LockupEnvelope,
} from "./lockup.js";

const { AssetGroup, AssetId, AssetInput, AssetOutput, Packet } = asset;

declare const sponsoredVerified: unique symbol;

/** Proof that `verifySponsoredQuote` accepted this quote. Unconstructible
 * outside this module, so submission cannot be reached unverified. */
export type VerifiedSponsoredQuote = {
    readonly quote: SponsoredQuoteResponse;
    readonly params: SponsoredParamsValue;
    readonly receiverAddress: string;
    readonly envelope: LockupEnvelope;
    readonly senderInputIndexes: number[];
} & { readonly [sponsoredVerified]: true };

export interface SponsoredQuoteExpectation {
    receiverAddress: string;
    senderKey: Uint8Array;
    /** The packet the payment must carry, when funding an offer. */
    extraPacket?: { type: number; payload: Uint8Array };
    assetId?: { txid: Uint8Array; groupIndex: number };
    maxContributionSats: bigint;
    /** Exact sats the sender contributes to the carrier; see `QuoteExpectation`. */
    paymentSats?: bigint;
    maxFare: {
        currency: "sats" | "asset";
        units: bigint;
        assetId?: { txid: Uint8Array; groupIndex: number };
    };
}

export interface VerifySponsoredQuoteArgs {
    quote: SponsoredQuoteResponse;
    info: InfoResponse;
    expect: SponsoredQuoteExpectation;
    trustedServerKey: Uint8Array;
    vtxoMinAmount: bigint;
    hrp: string;
    senderInputs: FundingInputValue[];
    senderSats: bigint;
    assetUnits?: bigint;
    trustedServerUnrollScript: Uint8Array;
    /** Unix seconds. Injected only so expiry is testable; defaults to the clock. */
    now?: number;
}

export interface SponsoredValidationContext {
    quote: SponsoredQuoteResponse;
    params: SponsoredParamsValue;
    receiverAddress: string;
    fare: {
        currency: "sats" | "asset";
        units: bigint;
        assetId?: { txid: Uint8Array; groupIndex: number };
    };
    senderInputs: FundingInputValue[];
    senderSats: bigint;
    assetUnits?: bigint;
    serverKey: Uint8Array;
    operatorKey: Uint8Array;
    trustedServerUnrollScript: Uint8Array;
    vtxoMinAmount: bigint;
    dust: bigint;
    hrp: string;
}

export interface ValidatedSponsoredPayment {
    envelope: LockupEnvelope;
    tx: Transaction;
    checkpoints: Transaction[];
    unsignedPsbt: Uint8Array;
}

interface CapabilityState {
    authorization: VerifySponsoredQuoteArgs;
    context: Omit<SponsoredValidationContext, "quote">;
    baseline: Pick<ValidatedSponsoredPayment, "envelope" | "unsignedPsbt">;
}

export interface ActiveSponsoredCapabilityState {
    authorization: VerifySponsoredQuoteArgs;
    context: Omit<SponsoredValidationContext, "quote">;
    transferId: string;
    validated: ValidatedSponsoredPayment;
}

const capabilities = new WeakMap<VerifiedSponsoredQuote, CapabilityState>();

const reject = (code: VerificationCode, detail: string): never => {
    throw new QuoteVerificationError(code, `taxi: ${detail}`);
};

const {
    attempt,
    exactBytes,
    exact,
    record,
    exactKeys,
    decodeBase64,
    decodeInput,
    inputAssets,
    inputTree,
    operatorTree,
    rebuildJointTx,
    assertCanonicalDefaultSignatures,
    assertSignedEnvelope,
    signSenderInputs,
} = jointTxChecks((detail) => reject(VerificationErrorCode.Malformed, detail));

const receiverScript = (context: SponsoredValidationContext): Uint8Array => {
    const address = attempt("receiver address", () => ArkAddress.decode(context.receiverAddress));
    if (address.encode() !== context.receiverAddress)
        reject(VerificationErrorCode.ReceiverKey, "payment address is not canonical");
    if (address.hrp !== context.hrp)
        reject(VerificationErrorCode.ReceiverKey, "payment address uses the wrong network");
    if (!sameBytes(address.serverPubKey, context.serverKey))
        reject(VerificationErrorCode.ReceiverKey, "payment address names an untrusted server key");
    if (!sameBytes(address.vtxoTaprootKey, context.params.receiverKey))
        reject(VerificationErrorCode.ReceiverKey, "payment address differs from quoted receiver");
    return address.pkScript;
};

export function validateSponsoredPayment(
    context: SponsoredValidationContext,
): ValidatedSponsoredPayment {
    const envelope = decodeLockupEnvelope(context.quote.unsignedSponsoredTx);
    const senderInputs = envelope.senderInputs.map((input, index) =>
        decodeInput(input, `senderInputs[${index}]`),
    );
    const operatorInputs = envelope.operatorInputs.map((input, index) =>
        decodeInput(input, `operatorInputs[${index}]`),
    );
    if (!senderInputs.length || !operatorInputs.length)
        reject(VerificationErrorCode.Malformed, "both funding owners are required");
    exact(
        senderInputs.map(fundingInputToWire),
        context.senderInputs.map(fundingInputToWire),
        "sender funding evidence",
    );
    if (senderInputs.reduce((sum, input) => sum + input.value, 0n) !== context.senderSats)
        reject(VerificationErrorCode.Malformed, "senderSats differs from sender funding");
    const allInputs = [...senderInputs, ...operatorInputs];
    if (new Set(allInputs.map((input) => `${input.txid}:${input.vout}`)).size !== allInputs.length)
        reject(VerificationErrorCode.Malformed, "funding outpoints are duplicated");
    if (new Set(allInputs.map((input) => input.expiry.kind)).size !== 1)
        reject(VerificationErrorCode.Malformed, "funding expiry evidence is inconsistent");

    const expectedSenderIndexes = senderInputs.map((_, index) => index);
    const expectedOperatorIndexes = operatorInputs.map((_, index) => senderInputs.length + index);
    exact(envelope.senderInputIndexes, expectedSenderIndexes, "sender ownership indexes");
    exact(envelope.operatorInputIndexes, expectedOperatorIndexes, "operator ownership indexes");
    if (envelope.covenantOutputIndex !== 0)
        reject(VerificationErrorCode.PaymentOutput, "payment output index mismatch");
    exactBytes(
        attempt("server unroll script", () => hex.decode(envelope.serverUnrollScript)),
        context.trustedServerUnrollScript,
        "server unroll script",
    );
    const senderTrees = senderInputs.map((input) =>
        inputTree(input, context.params.senderKey, context.serverKey),
    );
    const operatorTrees = operatorInputs.map((input) =>
        operatorTree(input, context.serverKey, context.operatorKey),
    );
    const holdings = allInputs.map(inputAssets);
    const totals = new Map<string, bigint>();
    for (const owned of holdings)
        for (const [id, amount] of owned) totals.set(id, (totals.get(id) ?? 0n) + amount);

    const outputs: { amount: bigint; script: Uint8Array }[] = [
        { amount: context.params.dust, script: receiverScript(context) },
    ];
    const fareHosting =
        context.fare.units === 0n
            ? 0n
            : context.fare.currency === "sats"
              ? context.fare.units
              : context.vtxoMinAmount;
    if (fareHosting > 0n)
        outputs.push({
            amount: fareHosting,
            script: ownerScript(
                context.operatorKey,
                fareHosting,
                context.serverKey,
                context.params.dust,
                context.hrp,
            ),
        });
    if (
        envelope.satsFarePayer !== undefined &&
        (context.fare.currency !== "sats" || context.fare.units <= 0n)
    )
        reject(VerificationErrorCode.Malformed, "satsFarePayer needs a positive sats fare");
    // Absent, the fare leaves operator change and returns to the operator. The
    // caller authorised this fare either way, so both layouts are within it.
    const senderFare = envelope.satsFarePayer === undefined ? 0n : fareHosting;
    const operatorFare = fareHosting - senderFare;
    const senderChange =
        context.senderSats + context.params.contribution - context.params.dust - senderFare;
    const operatorTotal = operatorInputs.reduce((sum, input) => sum + input.value, 0n);
    const operatorChange = operatorTotal - context.params.contribution - operatorFare;
    if (senderChange < 0n || operatorChange < 0n)
        reject(VerificationErrorCode.Malformed, "joint funding is insufficient");

    const destinations = new Map<string, Map<number, bigint>>();
    const paymentId = context.params.assetId ? assetId(context.params.assetId) : undefined;
    const fareId =
        context.fare.currency === "asset" && context.fare.assetId
            ? assetId(context.fare.assetId)
            : undefined;
    if (paymentId && !totals.has(paymentId))
        reject(VerificationErrorCode.AssetId, "payment asset is missing from sender funding");
    exact(
        envelope.assetUnits === undefined
            ? undefined
            : satsFromWire(envelope.assetUnits, "assetUnits"),
        paymentId
            ? (context.assetUnits ??
                  totals.get(paymentId)! - (fareId === paymentId ? context.fare.units : 0n))
            : context.assetUnits,
        "payment asset quantity",
    );
    let needsAssetChange = false;
    for (const [id, total] of totals) {
        const fare = id === fareId ? context.fare.units : 0n;
        if (total < fare) reject(VerificationErrorCode.Malformed, "asset fare exceeds funding");
        const allocation = new Map<number, bigint>();
        if (fare) allocation.set(1, fare);
        const payment = id === paymentId ? (context.assetUnits ?? total - fare) : 0n;
        if (payment < 0n || payment + fare > total || (id === paymentId && payment === 0n))
            reject(VerificationErrorCode.Malformed, "payment asset quantity is invalid");
        if (payment) allocation.set(0, payment);
        if (total > fare + payment) needsAssetChange = true;
        destinations.set(id, allocation);
    }
    if (fareId && context.fare.units && !totals.has(fareId))
        reject(VerificationErrorCode.Fee, "fare asset is missing");
    if (needsAssetChange && senderChange < context.vtxoMinAmount)
        reject(VerificationErrorCode.Malformed, "asset change lacks hosting sats");
    if (senderChange > 0n || needsAssetChange) {
        const index = outputs.length;
        outputs.push({
            amount: senderChange,
            script: ownerScript(
                senderTrees[0].tweakedPublicKey,
                senderChange,
                context.serverKey,
                context.params.dust,
                context.hrp,
            ),
        });
        for (const [id, total] of totals) {
            const allocation = destinations.get(id)!;
            const change =
                total - [...allocation.values()].reduce((sum, amount) => sum + amount, 0n);
            if (change) allocation.set(index, change);
        }
    }
    if (operatorChange > 0n)
        outputs.push({
            amount: operatorChange,
            script: ownerScript(
                operatorTrees[0].tweakedPublicKey,
                operatorChange,
                context.serverKey,
                context.params.dust,
                context.hrp,
            ),
        });
    if (outputs.some((output) => output.amount < context.vtxoMinAmount))
        reject(VerificationErrorCode.Malformed, "payment output is below the operator minimum");
    for (let i = 0; i < outputs.length; i++)
        for (let j = i + 1; j < outputs.length; j++)
            if (sameBytes(outputs[i].script, outputs[j].script))
                reject(VerificationErrorCode.Malformed, "payment outputs share a script");
    if (
        outputs.reduce((sum, output) => sum + output.amount, 0n) !==
        allInputs.reduce((sum, input) => sum + input.value, 0n)
    )
        reject(VerificationErrorCode.Malformed, "payment sats do not balance");

    const groups = [...totals]
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([id, total]) => {
            const allocation = destinations.get(id)!;
            if ([...allocation.values()].reduce((sum, amount) => sum + amount, 0n) !== total)
                reject(VerificationErrorCode.Malformed, "payment assets do not balance");
            return AssetGroup.create(
                AssetId.fromString(id),
                null,
                holdings.flatMap((owned, vin) =>
                    owned.has(id) ? [AssetInput.create(vin, owned.get(id)!)] : [],
                ),
                [...allocation]
                    .sort(([a], [b]) => a - b)
                    .map(([vout, amount]) => AssetOutput.create(vout, amount)),
                [],
            );
        });
    // The sender's own declared packet rides alongside the asset groups. It comes
    // from params, so the rebuild below only matches a transaction carrying the
    // packet the SENDER asked for — the operator cannot substitute one.
    const extra = context.params.extraPacket;
    const packets = [
        ...(groups.length ? [Packet.create(groups)] : []),
        ...(extra !== undefined ? [new UnknownPacket(extra.type, extra.payload)] : []),
    ];
    if (packets.length) outputs.push(Extension.create(packets).txOut());

    const { checkpoints, expectedArk } = rebuildJointTx(
        envelope.checkpoints,
        allInputs,
        [...senderTrees, ...operatorTrees],
        context.trustedServerUnrollScript,
        outputs,
    );

    const tx = attempt("Arkade transaction", () =>
        Transaction.fromPSBT(decodeBase64(envelope.arkTx, "arkTx")),
    );
    assertCanonicalDefaultSignatures(tx, "quoted Arkade transaction");
    assertAllowedSighashTypes(tx, [SigHash.DEFAULT]);
    for (const index of expectedSenderIndexes)
        if (tx.getInput(index).tapScriptSig?.length)
            reject(
                VerificationErrorCode.Malformed,
                `unsigned quote contains a sender signature at input ${index}`,
            );
    exactBytes(unsignedCopy(tx).toPSBT(), expectedArk.toPSBT(), "Arkade transaction");
    if (graphId("arkade-taxi-sponsored-v1\0", tx, checkpoints) !== envelope.unsignedTxId)
        reject(VerificationErrorCode.Malformed, "unsigned transaction hash mismatch");

    const commitment = record(context.quote.commitment, "quote.commitment");
    exactKeys(
        commitment,
        ["paymentOutputIndex", "senderInputIndexes", "operatorInputIndexes", "unsignedTxId"],
        [],
        "quote.commitment",
    );
    exact(
        commitment,
        {
            paymentOutputIndex: envelope.covenantOutputIndex,
            senderInputIndexes: envelope.senderInputIndexes,
            operatorInputIndexes: envelope.operatorInputIndexes,
            unsignedTxId: envelope.unsignedTxId,
        },
        "quote payment commitment",
    );
    return { envelope, tx, checkpoints, unsignedPsbt: expectedArk.toPSBT() };
}

export function verifySponsoredQuote(args: VerifySponsoredQuoteArgs): VerifiedSponsoredQuote {
    args = immutablePlainCopy(args, "sponsored quote verification request");
    const { expect, trustedServerKey, vtxoMinAmount, hrp } = args;

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
            "operator named an Arkade operator key you do not trust",
        );
    }

    const quote = rewrap(VerificationErrorCode.Malformed, () => decodeSponsoredQuote(args.quote));
    const params = quote.params;
    if (quote.receiverAddress !== expect.receiverAddress) {
        reject(VerificationErrorCode.ReceiverKey, "quote pays a receiver you did not ask to pay");
    }
    if (!sameBytes(params.senderKey, expect.senderKey)) {
        reject(VerificationErrorCode.SenderKey, "quote refunds a sender you did not name");
    }
    if (!sameAsset(params.assetId, expect.assetId)) {
        reject(VerificationErrorCode.AssetId, "quote moves an asset you did not ask to pay");
    }
    // Without this the rebuild is self-consistent but wrong: it would take the
    // packet from the quote and match a transaction built with it, so the
    // operator could swap in another offer and the sender would fund that.
    if (
        (params.extraPacket === undefined) !== (expect.extraPacket === undefined) ||
        (params.extraPacket !== undefined &&
            expect.extraPacket !== undefined &&
            (params.extraPacket.type !== expect.extraPacket.type ||
                !sameBytes(params.extraPacket.payload, expect.extraPacket.payload)))
    ) {
        reject(VerificationErrorCode.Malformed, "quote carries a packet you did not declare");
    }
    if (!sameBytes(params.operatorKey, info.operatorKey)) {
        reject(
            VerificationErrorCode.OperatorKey,
            "quote pays an operator key /v1/info did not advertise",
        );
    }
    if (params.dust !== info.dust) {
        reject(
            VerificationErrorCode.Dust,
            `quote dust ${params.dust} is not the advertised ${info.dust}`,
        );
    }
    if (params.contribution > expect.maxContributionSats) {
        reject(
            VerificationErrorCode.Topup,
            `contribution ${params.contribution} exceeds your max ${expect.maxContributionSats}`,
        );
    }
    if (
        expect.paymentSats !== undefined &&
        params.contribution !== params.dust - expect.paymentSats
    ) {
        reject(
            VerificationErrorCode.PaymentSats,
            `contribution ${params.contribution} leaves you paying ${params.dust - params.contribution}, you asked to pay ${expect.paymentSats}`,
        );
    }
    if (quote.fare.currency !== expect.maxFare.currency) {
        reject(
            VerificationErrorCode.Fee,
            `fare is in ${quote.fare.currency}, you authorised ${expect.maxFare.currency}`,
        );
    }
    if (
        quote.fare.currency === "asset" &&
        (!expect.maxFare.assetId ||
            !quote.fare.assetId ||
            hex.encode(quote.fare.assetId.txid) !== hex.encode(expect.maxFare.assetId.txid) ||
            quote.fare.assetId.groupIndex !== expect.maxFare.assetId.groupIndex)
    ) {
        reject(VerificationErrorCode.Fee, "fare is charged in an asset you did not authorise");
    }
    if (quote.fare.units > expect.maxFare.units) {
        reject(
            VerificationErrorCode.Fee,
            `fare ${quote.fare.units} exceeds your max ${expect.maxFare.units}`,
        );
    }

    const now = args.now ?? Math.floor(Date.now() / 1000);
    if (now >= quote.expiresAt) {
        reject(VerificationErrorCode.Expired, `quote expired at ${quote.expiresAt}, now ${now}`);
    }

    const paymentContext = {
        params,
        receiverAddress: quote.receiverAddress,
        fare: quote.fare,
        senderInputs: args.senderInputs,
        senderSats: args.senderSats,
        ...(args.assetUnits !== undefined ? { assetUnits: args.assetUnits } : {}),
        serverKey: trustedServerKey,
        operatorKey: info.operatorKey,
        trustedServerUnrollScript: args.trustedServerUnrollScript,
        vtxoMinAmount,
        dust: info.dust,
        hrp,
    };
    const validated = validateSponsoredPayment({ quote: args.quote, ...paymentContext });
    const result = Object.freeze({
        quote: immutablePlainCopy(args.quote, "verified sponsored quote view"),
        params: immutablePlainCopy(params, "verified sponsored parameters view"),
        receiverAddress: quote.receiverAddress,
        envelope: immutablePlainCopy(validated.envelope, "verified envelope view"),
        senderInputIndexes: immutablePlainCopy(
            validated.envelope.senderInputIndexes,
            "verified sender indexes view",
        ),
    }) as VerifiedSponsoredQuote;
    registerSponsoredQuote(result, args, paymentContext, validated);
    return result;
}

function registerSponsoredQuote(
    verified: VerifiedSponsoredQuote,
    authorization: VerifySponsoredQuoteArgs,
    context: Omit<SponsoredValidationContext, "quote">,
    validated: ValidatedSponsoredPayment,
): void {
    capabilities.set(verified, {
        authorization: immutablePlainCopy(authorization, "sponsored quote authorization"),
        context: immutablePlainCopy(context, "sponsored payment authorization"),
        baseline: immutablePlainCopy(
            { envelope: validated.envelope, unsignedPsbt: validated.unsignedPsbt },
            "validated sponsored payment",
        ),
    });
}

const activeSponsoredStateFor = (
    verified: VerifiedSponsoredQuote,
): ActiveSponsoredCapabilityState => {
    const state = capabilities.get(verified);
    if (state === undefined)
        return reject(VerificationErrorCode.Malformed, "unrecognized verified quote capability");
    const authorization = immutablePlainCopy(state.authorization, "retained quote authorization");
    const context = immutablePlainCopy(state.context, "retained payment authorization");
    const validated = validateSponsoredPayment({ ...context, quote: authorization.quote });
    exact(validated.envelope, state.baseline.envelope, "retained payment envelope");
    exactBytes(
        validated.unsignedPsbt,
        state.baseline.unsignedPsbt,
        "retained unsigned transaction",
    );
    return { authorization, context, transferId: authorization.quote.transferId, validated };
};

export function assertSignedSponsoredPayment(
    verified: VerifiedSponsoredQuote,
    encoded: string,
): string {
    return assertSignedEnvelope(
        activeSponsoredStateFor(verified),
        encoded,
        "signed payment commitments",
    );
}

export interface SignSponsoredPaymentArgs {
    verified: VerifiedSponsoredQuote;
    identity: Identity;
}

export async function signSponsoredPayment({
    verified,
    identity,
}: SignSponsoredPaymentArgs): Promise<string> {
    const encoded = await signSenderInputs(activeSponsoredStateFor(verified), identity);
    assertSignedSponsoredPayment(verified, encoded);
    return encoded;
}
