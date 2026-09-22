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
    MultisigTapscript,
    P2A,
    Transaction,
    VtxoScript,
    VtxoTaprootTree,
    asset,
    assertAllowedSighashTypes,
    isBatchSignable,
    setArkPsbtField,
    verifyTapscriptSignatures,
    type Identity,
} from "@arkade-os/sdk";
import {
    fundingInputFromWire,
    fundingInputToWire,
    satsFromWire,
    type FundingInputValue,
    type InfoResponse,
    type SponsoredParamsValue,
    type SponsoredQuoteResponse,
} from "@arkade-taxi/protocol";
import { sha256 } from "@noble/hashes/sha2.js";
import { base64, hex } from "@scure/base";
import { SigHash } from "@scure/btc-signer";
import { QuoteVerificationError, VerificationErrorCode, type VerificationCode } from "./errors.js";
import { causeMessage, decodeInfo, decodeSponsoredQuote } from "./decode.js";
import {
    decodeLockupEnvelope,
    encodeLockupEnvelope,
    immutablePlainCopy,
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
const textEncoder = new TextEncoder();

const reject = (code: VerificationCode, detail: string): never => {
    throw new QuoteVerificationError(code, `taxi: ${detail}`);
};

const attempt = <T>(label: string, fn: () => T): T => {
    try {
        return fn();
    } catch (cause) {
        if (cause instanceof QuoteVerificationError) throw cause;
        return reject(
            VerificationErrorCode.Malformed,
            `${label}: ${cause instanceof Error ? cause.message : String(cause)}`,
        );
    }
};

const sameBytes = (a: Uint8Array, b: Uint8Array): boolean =>
    a.length === b.length && a.every((value, index) => value === b[index]);

const exactBytes = (actual: Uint8Array, expected: Uint8Array, label: string): void => {
    if (!sameBytes(actual, expected)) reject(VerificationErrorCode.Malformed, `${label} mismatch`);
};

const canonical = (value: unknown): string => {
    if (value instanceof Uint8Array) return `bytes:${hex.encode(value)}`;
    if (typeof value === "bigint") return `bigint:${value}`;
    if (value === undefined) return "undefined";
    if (value === null || typeof value !== "object") return JSON.stringify(value);
    if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
    const recordValue = value as Record<string, unknown>;
    return `{${Object.keys(recordValue)
        .sort()
        .map((key) => `${JSON.stringify(key)}:${canonical(recordValue[key])}`)
        .join(",")}}`;
};

const exact = (actual: unknown, expected: unknown, label: string): void => {
    if (canonical(actual) !== canonical(expected))
        reject(VerificationErrorCode.Malformed, `${label} mismatch`);
};

const record = (value: unknown, label: string): Record<string, unknown> => {
    if (!value || typeof value !== "object" || Array.isArray(value))
        reject(VerificationErrorCode.Malformed, `${label} must be an object`);
    return value as Record<string, unknown>;
};

const exactKeys = (
    value: Record<string, unknown>,
    required: string[],
    optional: string[],
    label: string,
): void => {
    const keys = Object.keys(value).sort();
    const allowed = [...required, ...optional].sort();
    if (keys.some((key) => !allowed.includes(key)) || required.some((key) => !keys.includes(key)))
        reject(VerificationErrorCode.Malformed, `${label} fields mismatch`);
};

const decodeBase64 = (value: unknown, label: string): Uint8Array => {
    if (typeof value !== "string" || !value.length || value.length > 4_000_000)
        reject(VerificationErrorCode.Malformed, `${label} has invalid size`);
    const encoded = value as string;
    const bytes = attempt(label, () => base64.decode(encoded));
    if (base64.encode(bytes) !== encoded)
        reject(VerificationErrorCode.Malformed, `${label} is not canonical base64`);
    return bytes;
};

const decodeInput = (value: unknown, label: string): FundingInputValue => {
    const wire = record(value, label);
    exactKeys(
        wire,
        ["txid", "vout", "value", "tapTree", "spendLeaf", "expiry"],
        ["assetPacket"],
        label,
    );
    const expiry = record(wire.expiry, `${label}.expiry`);
    exactKeys(expiry, ["kind", "value"], [], `${label}.expiry`);
    const decoded = attempt(label, () => fundingInputFromWire(wire, label));
    exact(wire, fundingInputToWire(decoded), label);
    return decoded;
};

const inputAssets = (input: FundingInputValue): Map<string, bigint> => {
    const result = new Map<string, bigint>();
    if (!input.assetPacket) return result;
    const packet = attempt("funding asset packet", () => Packet.fromBytes(input.assetPacket!));
    exactBytes(packet.serialize(), input.assetPacket, "funding asset packet encoding");
    for (const group of packet.groups) {
        if (!group.assetId || group.controlAsset)
            reject(VerificationErrorCode.Malformed, "funding packet is not existing holdings");
        const id = group.assetId!.toString();
        if (result.has(id))
            reject(
                VerificationErrorCode.Malformed,
                "funding packet contains a duplicate asset group",
            );
        const outputs = group.outputs.filter((output) => output.vout === input.vout);
        if (outputs.length > 1)
            reject(
                VerificationErrorCode.Malformed,
                "funding packet contains a duplicate asset output",
            );
        if (outputs.length) result.set(id, outputs[0].amount);
    }
    const canonicalPacket = Packet.create(
        [...result]
            .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
            .map(([id, amount]) =>
                AssetGroup.create(
                    AssetId.fromString(id),
                    null,
                    [],
                    [AssetOutput.create(input.vout, amount)],
                    [],
                ),
            ),
    );
    exactBytes(canonicalPacket.serialize(), input.assetPacket, "funding asset holdings");
    return result;
};

const inputTree = (
    input: FundingInputValue,
    ownerKey: Uint8Array,
    serverKey: Uint8Array,
): VtxoScript => {
    const tree = attempt("funding tap tree", () => VtxoScript.decode(input.tapTree));
    exactBytes(tree.encode(), input.tapTree, "funding tap tree encoding");
    attempt("funding spend leaf", () => tree.findLeaf(hex.encode(input.spendLeaf)));
    const closure = attempt("funding multisig leaf", () =>
        MultisigTapscript.decode(input.spendLeaf),
    );
    const actual = closure.params.pubkeys.map(hex.encode).sort();
    const expected = [hex.encode(ownerKey), hex.encode(serverKey)].sort();
    exact(actual, expected, "funding multisig owners");
    return tree;
};

const ownerScript = (
    key: Uint8Array,
    amount: bigint,
    serverKey: Uint8Array,
    dust: bigint,
    hrp: string,
): Uint8Array => {
    const address = new ArkAddress(serverKey, key, hrp);
    return amount < dust ? address.subdustPkScript : address.pkScript;
};

const assetId = (id: { txid: Uint8Array; groupIndex: number }): string =>
    AssetId.create(hex.encode(Uint8Array.from(id.txid).reverse()), id.groupIndex).toString();

const unsignedCopy = (tx: Transaction): Transaction => {
    const copy = Transaction.fromPSBT(tx.toPSBT());
    for (let index = 0; index < copy.inputsLength; index++)
        copy.updateInput(index, { tapScriptSig: undefined });
    return copy;
};

const sponsoredId = (tx: Transaction, checkpoints: Transaction[]): string => {
    const hash = sha256.create();
    hash.update(textEncoder.encode("arkade-taxi-sponsored-v1\0"));
    hash.update(unsignedCopy(tx).toPSBT());
    for (const checkpoint of checkpoints) hash.update(hex.decode(checkpoint.id));
    return hex.encode(hash.digest());
};

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

const signatureToken = (tx: Transaction, index: number): string =>
    canonical(tx.getInput(index).tapScriptSig);

export function validateSponsoredPayment(
    context: SponsoredValidationContext,
): ValidatedSponsoredPayment {
    const envelope = decodeLockupEnvelope(context.quote.unsignedSponsoredTx);
    if (envelope.satsFarePayer !== undefined)
        reject(VerificationErrorCode.Malformed, "a sponsored payment has no sats fare payer");
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
    const operatorTrees = operatorInputs.map((input) => {
        if (input.assetPacket)
            reject(VerificationErrorCode.Malformed, "operator funding cannot carry assets");
        const closure = attempt("operator funding multisig", () =>
            MultisigTapscript.decode(input.spendLeaf),
        );
        const signer = closure.params.pubkeys.find((key) => !sameBytes(key, context.serverKey));
        if (!signer) reject(VerificationErrorCode.Malformed, "operator funding signer is missing");
        const tree = inputTree(input, signer!, context.serverKey);
        exactBytes(tree.tweakedPublicKey, context.operatorKey, "operator funding payout");
        return tree;
    });
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
    const senderChange = context.senderSats + context.params.contribution - context.params.dust;
    const operatorTotal = operatorInputs.reduce((sum, input) => sum + input.value, 0n);
    const operatorChange = operatorTotal - context.params.contribution - fareHosting;
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

    const checkpoints = envelope.checkpoints.map((checkpoint, index) =>
        attempt(`checkpoint ${index}`, () =>
            Transaction.fromPSBT(decodeBase64(checkpoint, `checkpoint ${index}`)),
        ),
    );
    if (checkpoints.length !== allInputs.length)
        reject(VerificationErrorCode.Malformed, "checkpoint count mismatch");
    const expectedArk = new Transaction({ version: 3, lockTime: 0 });
    for (const [index, input] of allInputs.entries()) {
        const source =
            index < senderInputs.length
                ? senderTrees[index]
                : operatorTrees[index - senderInputs.length];
        const checkpointTree = new VtxoScript([context.trustedServerUnrollScript, input.spendLeaf]);
        const expectedCheckpoint = new Transaction({ version: 3, lockTime: 0 });
        expectedCheckpoint.addInput({
            txid: input.txid,
            index: input.vout,
            witnessUtxo: { script: source.pkScript, amount: input.value },
            tapLeafScript: [source.findLeaf(hex.encode(input.spendLeaf))],
        });
        setArkPsbtField(expectedCheckpoint, 0, VtxoTaprootTree, input.tapTree);
        expectedCheckpoint.addOutput({ amount: input.value, script: checkpointTree.pkScript });
        expectedCheckpoint.addOutput(P2A);
        exactBytes(checkpoints[index].toPSBT(), expectedCheckpoint.toPSBT(), `checkpoint ${index}`);
        expectedArk.addInput({
            txid: checkpoints[index].id,
            index: 0,
            witnessUtxo: { script: checkpointTree.pkScript, amount: input.value },
            tapLeafScript: [checkpointTree.findLeaf(hex.encode(input.spendLeaf))],
        });
        setArkPsbtField(expectedArk, index, VtxoTaprootTree, checkpointTree.encode());
    }
    for (const output of outputs) expectedArk.addOutput(output);
    expectedArk.addOutput(P2A);

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
    if (sponsoredId(tx, checkpoints) !== envelope.unsignedTxId)
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
    if (info.protocolVersion !== 1) {
        reject(
            VerificationErrorCode.ProtocolVersion,
            `operator speaks protocol ${info.protocolVersion}, this client speaks 1`,
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

export function registerSponsoredQuote(
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

export const activeSponsoredStateFor = (
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

const assertCanonicalDefaultSignatures = (tx: Transaction, label: string): void => {
    for (let index = 0; index < tx.inputsLength; index++)
        for (const [, signature] of tx.getInput(index).tapScriptSig ?? [])
            if (signature.length !== 64)
                reject(
                    VerificationErrorCode.Malformed,
                    `${label} input ${index} signature is not canonical DEFAULT`,
                );
};

const validateSignedPayment = (
    state: ActiveSponsoredCapabilityState,
    signed: Transaction,
): void => {
    assertCanonicalDefaultSignatures(signed, "signed Arkade transaction");
    assertAllowedSighashTypes(signed, [SigHash.DEFAULT]);
    exactBytes(
        unsignedCopy(signed).toPSBT(),
        state.validated.unsignedPsbt,
        "signed unsigned transaction",
    );
    const senderIndexes = state.validated.envelope.senderInputIndexes;
    const senderSet = new Set(senderIndexes);
    for (let index = 0; index < signed.inputsLength; index++) {
        if (!senderSet.has(index)) {
            if (signatureToken(signed, index) !== signatureToken(state.validated.tx, index))
                reject(VerificationErrorCode.Malformed, `signature outside sender input ${index}`);
            continue;
        }
        const signatures = signed.getInput(index).tapScriptSig;
        if (
            !signatures ||
            signatures.length !== 1 ||
            !sameBytes(signatures[0][0].pubKey, state.context.params.senderKey)
        )
            reject(
                VerificationErrorCode.Malformed,
                `input ${index} was not signed only by the sender`,
            );
        attempt(`sender signature ${index}`, () =>
            verifyTapscriptSignatures(
                signed,
                index,
                [hex.encode(state.context.params.senderKey)],
                [],
                [SigHash.DEFAULT],
            ),
        );
    }
};

const validateSignedCheckpoints = (
    state: ActiveSponsoredCapabilityState,
    encoded: readonly string[],
): Transaction[] => {
    if (encoded.length !== state.validated.checkpoints.length)
        reject(VerificationErrorCode.Malformed, "checkpoint count mismatch");
    const sender = new Set(state.validated.envelope.senderInputIndexes);
    return encoded.map((value, index) => {
        const signed = attempt(`signed checkpoint ${index}`, () =>
            Transaction.fromPSBT(decodeBase64(value, `signed checkpoint ${index}`)),
        );
        assertCanonicalDefaultSignatures(signed, `signed checkpoint ${index}`);
        assertAllowedSighashTypes(signed, [SigHash.DEFAULT]);
        exactBytes(
            unsignedCopy(signed).toPSBT(),
            state.validated.checkpoints[index].toPSBT(),
            `signed checkpoint ${index} unsigned transaction`,
        );
        const signatures = signed.getInput(0).tapScriptSig;
        if (!sender.has(index)) {
            if (signatures?.length)
                reject(
                    VerificationErrorCode.Malformed,
                    `signature outside sender checkpoint ${index}`,
                );
            return signed;
        }
        if (
            !signatures ||
            signatures.length !== 1 ||
            !sameBytes(signatures[0][0].pubKey, state.context.params.senderKey)
        )
            reject(
                VerificationErrorCode.Malformed,
                `checkpoint ${index} was not signed only by the sender`,
            );
        attempt(`sender checkpoint signature ${index}`, () =>
            verifyTapscriptSignatures(
                signed,
                0,
                [hex.encode(state.context.params.senderKey)],
                [],
                [SigHash.DEFAULT],
            ),
        );
        return signed;
    });
};

export function assertSignedSponsoredPayment(
    verified: VerifiedSponsoredQuote,
    encoded: string,
): string {
    const state = activeSponsoredStateFor(verified);
    const envelope = decodeLockupEnvelope(encoded);
    const {
        arkTx: _expectedArkTx,
        checkpoints: _expectedCheckpoints,
        ...expectedCommitments
    } = state.validated.envelope;
    const { arkTx, checkpoints, ...actualCommitments } = envelope;
    exact(actualCommitments, expectedCommitments, "signed payment commitments");
    const signed = attempt("signed Arkade transaction", () =>
        Transaction.fromPSBT(decodeBase64(arkTx, "signed arkTx")),
    );
    validateSignedPayment(state, signed);
    validateSignedCheckpoints(state, checkpoints);
    return state.transferId;
}

export interface SignSponsoredPaymentArgs {
    verified: VerifiedSponsoredQuote;
    identity: Identity;
}

export async function signSponsoredPayment({
    verified,
    identity,
}: SignSponsoredPaymentArgs): Promise<string> {
    const state = activeSponsoredStateFor(verified);
    const tx = Transaction.fromPSBT(state.validated.tx.toPSBT());
    assertAllowedSighashTypes(tx, [SigHash.DEFAULT]);
    const senderIndexes = [...state.validated.envelope.senderInputIndexes];
    const sender = new Set(senderIndexes);
    const preparedCheckpoints = state.validated.checkpoints.map((checkpoint) =>
        Transaction.fromPSBT(checkpoint.toPSBT()),
    );
    let signed: Transaction;
    let signedCheckpoints: Transaction[];
    if (isBatchSignable(identity)) {
        const senderCheckpoints = preparedCheckpoints.filter((_, index) => sender.has(index));
        const results = await identity.signMultiple([
            { tx, inputIndexes: senderIndexes },
            ...senderCheckpoints.map((checkpoint) => ({ tx: checkpoint, inputIndexes: [0] })),
        ]);
        if (results.length !== senderCheckpoints.length + 1)
            reject(
                VerificationErrorCode.Malformed,
                `signMultiple returned ${results.length} transactions, expected ${senderCheckpoints.length + 1}`,
            );
        signed = results[0];
        let cursor = 1;
        signedCheckpoints = preparedCheckpoints.map((checkpoint, index) =>
            sender.has(index) ? results[cursor++] : checkpoint,
        );
    } else {
        signed = await identity.sign(tx, senderIndexes);
        signedCheckpoints = [];
        for (const [index, checkpoint] of preparedCheckpoints.entries())
            signedCheckpoints.push(
                sender.has(index) ? await identity.sign(checkpoint, [0]) : checkpoint,
            );
    }
    validateSignedPayment(state, signed);
    const checkpoints = signedCheckpoints.map((checkpoint) => base64.encode(checkpoint.toPSBT()));
    const encoded = encodeLockupEnvelope({
        ...state.validated.envelope,
        arkTx: base64.encode(signed.toPSBT()),
        checkpoints,
    });
    assertSignedSponsoredPayment(verified, encoded);
    return encoded;
}

const rewrap = <T>(code: VerificationCode, f: () => T): T => {
    try {
        return f();
    } catch (cause) {
        if (cause instanceof QuoteVerificationError) throw cause;
        return reject(code, causeMessage(cause));
    }
};

const sameAsset = (
    a: { txid: Uint8Array; groupIndex: number } | undefined,
    b: { txid: Uint8Array; groupIndex: number } | undefined,
): boolean =>
    a === undefined || b === undefined
        ? a === b
        : a.groupIndex === b.groupIndex && sameBytes(a.txid, b.txid);
