import { copyByteView, type DustCovenantParams } from "@arkade-taxi/covenant";
import {
    fundingInputFromWire,
    fundingInputToWire,
    satsFromWire,
    type FundingInputValue,
    type FundingInputWire,
    type QuoteResponse,
} from "@arkade-taxi/protocol";
import {
    ArkAddress,
    Extension,
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
import { sha256 } from "@noble/hashes/sha2.js";
import { base64, hex } from "@scure/base";
import { SigHash } from "@scure/btc-signer";
import { QuoteVerificationError, VerificationErrorCode } from "./errors.js";
import type { VerifiedQuote, VerifyQuoteArgs } from "./verify.js";

const { AssetGroup, AssetId, AssetInput, AssetOutput, Packet } = asset;

export interface LockupEnvelope {
    arkTx: string;
    checkpoints: string[];
    senderInputs: FundingInputWire[];
    operatorInputs: FundingInputWire[];
    serverUnrollScript: string;
    assetUnits?: string;
    unsignedTxId: string;
    covenantOutputIndex: number;
    senderInputIndexes: number[];
    operatorInputIndexes: number[];
}

export interface SignLockupArgs {
    verified: VerifiedQuote;
    identity: Identity;
}

export interface LockupValidationContext {
    quote: QuoteResponse;
    params: DustCovenantParams;
    covenantScript: Uint8Array;
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
    hrp: string;
}

export interface ValidatedLockup {
    envelope: LockupEnvelope;
    tx: Transaction;
    checkpoints: Transaction[];
    unsignedPsbt: Uint8Array;
}

interface CapabilityState {
    authorization: VerifyQuoteArgs;
    context: Omit<LockupValidationContext, "quote">;
    baseline: Pick<ValidatedLockup, "envelope" | "unsignedPsbt">;
}

export interface ActiveCapabilityState {
    authorization: VerifyQuoteArgs;
    context: Omit<LockupValidationContext, "quote">;
    transferId: string;
    validated: ValidatedLockup;
}

const capabilities = new WeakMap<VerifiedQuote, CapabilityState>();
const textEncoder = new TextEncoder();

const reject = (detail: string): never => {
    throw new QuoteVerificationError(
        VerificationErrorCode.Malformed,
        `taxi: invalid lockup: ${detail}`,
    );
};

const attempt = <T>(label: string, fn: () => T): T => {
    try {
        return fn();
    } catch (cause) {
        if (cause instanceof QuoteVerificationError) throw cause;
        return reject(`${label}: ${cause instanceof Error ? cause.message : String(cause)}`);
    }
};

const sameBytes = (a: Uint8Array, b: Uint8Array): boolean =>
    a.length === b.length && a.every((value, index) => value === b[index]);

const exactBytes = (actual: Uint8Array, expected: Uint8Array, label: string): void => {
    if (!sameBytes(actual, expected)) reject(`${label} mismatch`);
};

const canonical = (value: unknown): string => {
    if (value instanceof Uint8Array) return `bytes:${hex.encode(value)}`;
    if (typeof value === "bigint") return `bigint:${value}`;
    if (value === undefined) return "undefined";
    if (value === null || typeof value !== "object") return JSON.stringify(value);
    if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
        .sort()
        .map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`)
        .join(",")}}`;
};

const exact = (actual: unknown, expected: unknown, label: string): void => {
    if (canonical(actual) !== canonical(expected)) reject(`${label} mismatch`);
};

export const immutablePlainCopy = <T>(value: T, label = "value"): T => {
    const ancestors = new WeakSet<object>();
    const copy = (current: unknown, path: string): unknown => {
        if (
            current === undefined ||
            current === null ||
            typeof current === "string" ||
            typeof current === "boolean" ||
            typeof current === "bigint"
        )
            return current;
        if (typeof current === "number") return current;
        if (typeof current !== "object") return reject(`${path} is not plain data`);
        if (ArrayBuffer.isView(current)) {
            try {
                return copyByteView(current, `${path} byte string`);
            } catch (cause) {
                return reject(cause instanceof Error ? cause.message : `${path} is not byte data`);
            }
        }
        if (ancestors.has(current)) return reject(`${path} is cyclic`);
        ancestors.add(current);
        if (Array.isArray(current)) {
            if (Object.getPrototypeOf(current) !== Array.prototype)
                return reject(`${path} has an invalid array prototype`);
            const descriptors = Object.getOwnPropertyDescriptors(current);
            const keys = Reflect.ownKeys(descriptors).filter((key) => key !== "length");
            if (
                keys.some(
                    (key) =>
                        typeof key !== "string" ||
                        !/^(0|[1-9][0-9]*)$/.test(key) ||
                        Number(key) >= current.length,
                ) ||
                keys.length !== current.length
            )
                return reject(`${path} array shape is invalid`);
            const result = keys.map((key) => {
                const descriptor = descriptors[key as keyof typeof descriptors]!;
                if (!("value" in descriptor) || !descriptor.enumerable)
                    return reject(`${path}[${String(key)}] must be a data property`);
                return copy(descriptor.value, `${path}[${String(key)}]`);
            });
            ancestors.delete(current);
            return Object.freeze(result);
        }
        const prototype = Object.getPrototypeOf(current);
        if (prototype !== Object.prototype && prototype !== null)
            return reject(`${path} has an invalid object prototype`);
        const descriptors = Object.getOwnPropertyDescriptors(current);
        const result: Record<string, unknown> = {};
        for (const key of Reflect.ownKeys(descriptors)) {
            if (typeof key !== "string") return reject(`${path} has a symbol property`);
            const descriptor = descriptors[key]!;
            if (!("value" in descriptor) || !descriptor.enumerable)
                return reject(`${path}.${key} must be an enumerable data property`);
            Object.defineProperty(result, key, {
                value: copy(descriptor.value, `${path}.${key}`),
                enumerable: true,
            });
        }
        ancestors.delete(current);
        return Object.freeze(result);
    };
    return copy(value, label) as T;
};

const record = (value: unknown, label: string): Record<string, unknown> => {
    if (!value || typeof value !== "object" || Array.isArray(value))
        reject(`${label} must be an object`);
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
        reject(`${label} fields mismatch`);
};

const decodeBase64 = (value: unknown, label: string): Uint8Array => {
    if (typeof value !== "string" || !value.length || value.length > 4_000_000)
        reject(`${label} has invalid size`);
    const encoded = value as string;
    const bytes = attempt(label, () => base64.decode(encoded));
    if (base64.encode(bytes) !== encoded) reject(`${label} is not canonical base64`);
    return bytes;
};

const decodeIndexes = (value: unknown, label: string): number[] => {
    if (!Array.isArray(value)) reject(`${label} must be an array`);
    const indexes = (value as unknown[]).map((entry) => {
        if (!Number.isSafeInteger(entry) || (entry as number) < 0) reject(`${label} is invalid`);
        return entry as number;
    });
    if (new Set(indexes).size !== indexes.length) reject(`${label} contains duplicates`);
    return indexes;
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

export function decodeLockupEnvelope(encoded: string): LockupEnvelope {
    const bytes = decodeBase64(encoded, "envelope");
    const parsed = attempt("envelope JSON", () =>
        JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)),
    );
    const wire = record(parsed, "envelope");
    exactKeys(
        wire,
        [
            "arkTx",
            "checkpoints",
            "senderInputs",
            "operatorInputs",
            "serverUnrollScript",
            "unsignedTxId",
            "covenantOutputIndex",
            "senderInputIndexes",
            "operatorInputIndexes",
        ],
        ["assetUnits"],
        "envelope",
    );
    if (
        !Array.isArray(wire.checkpoints) ||
        !Array.isArray(wire.senderInputs) ||
        !Array.isArray(wire.operatorInputs)
    )
        reject("envelope arrays are invalid");
    if (typeof wire.arkTx !== "string" || typeof wire.serverUnrollScript !== "string")
        reject("envelope transaction or unroll script is invalid");
    if (typeof wire.unsignedTxId !== "string" || !/^[0-9a-f]{64}$/.test(wire.unsignedTxId))
        reject("envelope unsignedTxId is invalid");
    if (!Number.isSafeInteger(wire.covenantOutputIndex) || (wire.covenantOutputIndex as number) < 0)
        reject("envelope covenantOutputIndex is invalid");
    const unroll = attempt("envelope serverUnrollScript", () =>
        hex.decode(wire.serverUnrollScript as string),
    );
    if (hex.encode(unroll) !== wire.serverUnrollScript)
        reject("envelope serverUnrollScript is not canonical hex");
    if (wire.assetUnits !== undefined)
        attempt("envelope assetUnits", () => satsFromWire(wire.assetUnits as string, "assetUnits"));
    const checkpoints = wire.checkpoints as unknown[];
    const senderInputs = wire.senderInputs as unknown[];
    const operatorInputs = wire.operatorInputs as unknown[];
    checkpoints.forEach((checkpoint, index) => decodeBase64(checkpoint, `checkpoints[${index}]`));
    senderInputs.forEach((input, index) => decodeInput(input, `senderInputs[${index}]`));
    operatorInputs.forEach((input, index) => decodeInput(input, `operatorInputs[${index}]`));
    return {
        arkTx: wire.arkTx as string,
        checkpoints: checkpoints as string[],
        senderInputs: senderInputs as FundingInputWire[],
        operatorInputs: operatorInputs as FundingInputWire[],
        serverUnrollScript: wire.serverUnrollScript as string,
        ...(wire.assetUnits !== undefined ? { assetUnits: wire.assetUnits as string } : {}),
        unsignedTxId: wire.unsignedTxId as string,
        covenantOutputIndex: wire.covenantOutputIndex as number,
        senderInputIndexes: decodeIndexes(wire.senderInputIndexes, "senderInputIndexes"),
        operatorInputIndexes: decodeIndexes(wire.operatorInputIndexes, "operatorInputIndexes"),
    };
}

export function encodeLockupEnvelope(envelope: LockupEnvelope): string {
    return base64.encode(textEncoder.encode(JSON.stringify(envelope)));
}

const inputAssets = (input: FundingInputValue): Map<string, bigint> => {
    const result = new Map<string, bigint>();
    if (!input.assetPacket) return result;
    const packet = attempt("funding asset packet", () => Packet.fromBytes(input.assetPacket!));
    exactBytes(packet.serialize(), input.assetPacket, "funding asset packet encoding");
    for (const group of packet.groups) {
        if (!group.assetId || group.controlAsset) reject("funding packet is not existing holdings");
        const id = group.assetId!.toString();
        if (result.has(id)) reject("funding packet contains a duplicate asset group");
        const outputs = group.outputs.filter((output) => output.vout === input.vout);
        if (outputs.length > 1) reject("funding packet contains a duplicate asset output");
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

const graphId = (tx: Transaction, checkpoints: Transaction[]): string => {
    const hash = sha256.create();
    hash.update(textEncoder.encode("arkade-taxi-lockup-v1\0"));
    hash.update(unsignedCopy(tx).toPSBT());
    for (const checkpoint of checkpoints) hash.update(hex.decode(checkpoint.id));
    return hex.encode(hash.digest());
};

const signatureToken = (tx: Transaction, index: number): string =>
    canonical(tx.getInput(index).tapScriptSig);

export function validateLockup(context: LockupValidationContext): ValidatedLockup {
    const envelope = decodeLockupEnvelope(context.quote.unsignedLockupTx);
    const senderInputs = envelope.senderInputs.map((input, index) =>
        decodeInput(input, `senderInputs[${index}]`),
    );
    const operatorInputs = envelope.operatorInputs.map((input, index) =>
        decodeInput(input, `operatorInputs[${index}]`),
    );
    if (!senderInputs.length || !operatorInputs.length) reject("both funding owners are required");
    exact(
        senderInputs.map(fundingInputToWire),
        context.senderInputs.map(fundingInputToWire),
        "sender funding evidence",
    );
    if (senderInputs.reduce((sum, input) => sum + input.value, 0n) !== context.senderSats)
        reject("senderSats differs from sender funding");
    const allInputs = [...senderInputs, ...operatorInputs];
    if (new Set(allInputs.map((input) => `${input.txid}:${input.vout}`)).size !== allInputs.length)
        reject("funding outpoints are duplicated");
    if (
        allInputs.some(
            (input) =>
                input.expiry.kind !== allInputs[0].expiry.kind ||
                input.expiry.value <= context.params.locktime,
        ) ||
        (allInputs[0].expiry.kind === "time") !== context.params.locktime >= 500_000_000n
    )
        reject("funding expiry evidence is inconsistent");

    const expectedSenderIndexes = senderInputs.map((_, index) => index);
    const expectedOperatorIndexes = operatorInputs.map((_, index) => senderInputs.length + index);
    exact(envelope.senderInputIndexes, expectedSenderIndexes, "sender ownership indexes");
    exact(envelope.operatorInputIndexes, expectedOperatorIndexes, "operator ownership indexes");
    if (envelope.covenantOutputIndex !== 0) reject("covenant output index mismatch");
    exactBytes(
        attempt("server unroll script", () => hex.decode(envelope.serverUnrollScript)),
        context.trustedServerUnrollScript,
        "server unroll script",
    );
    const senderTrees = senderInputs.map((input) =>
        inputTree(input, context.params.senderKey, context.serverKey),
    );
    const operatorTrees = operatorInputs.map((input) => {
        if (input.assetPacket) reject("operator funding cannot carry assets");
        const closure = attempt("operator funding multisig", () =>
            MultisigTapscript.decode(input.spendLeaf),
        );
        const signer = closure.params.pubkeys.find((key) => !sameBytes(key, context.serverKey));
        if (!signer) reject("operator funding signer is missing");
        const tree = inputTree(input, signer!, context.serverKey);
        exactBytes(tree.tweakedPublicKey, context.operatorKey, "operator funding payout");
        return tree;
    });
    const holdings = allInputs.map(inputAssets);
    const totals = new Map<string, bigint>();
    for (const owned of holdings)
        for (const [id, amount] of owned) totals.set(id, (totals.get(id) ?? 0n) + amount);

    const outputs: { amount: bigint; script: Uint8Array }[] = [
        { amount: context.params.dust, script: context.covenantScript },
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
    const senderChange = context.senderSats + context.params.topup - context.params.dust;
    const operatorTotal = operatorInputs.reduce((sum, input) => sum + input.value, 0n);
    const operatorChange = operatorTotal - context.params.topup - fareHosting;
    if (senderChange < 0n || operatorChange < 0n) reject("lockup funding is insufficient");

    const destinations = new Map<string, Map<number, bigint>>();
    const paymentId = context.params.assetId ? assetId(context.params.assetId) : undefined;
    const fareId =
        context.fare.currency === "asset" && context.fare.assetId
            ? assetId(context.fare.assetId)
            : undefined;
    if (paymentId && !totals.has(paymentId)) reject("payment asset is missing from sender funding");
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
        if (total < fare) reject("asset fare exceeds funding");
        const allocation = new Map<number, bigint>();
        if (fare) allocation.set(1, fare);
        const payment = id === paymentId ? (context.assetUnits ?? total - fare) : 0n;
        if (payment < 0n || payment + fare > total || (id === paymentId && payment === 0n))
            reject("payment asset quantity is invalid");
        if (payment) allocation.set(0, payment);
        if (total > fare + payment) needsAssetChange = true;
        destinations.set(id, allocation);
    }
    if (fareId && context.fare.units && !totals.has(fareId)) reject("fare asset is missing");
    if (needsAssetChange && senderChange < context.vtxoMinAmount)
        reject("asset change lacks hosting sats");
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
        reject("lockup output is below the Arkade operator minimum");
    for (let i = 0; i < outputs.length; i++)
        for (let j = i + 1; j < outputs.length; j++)
            if (sameBytes(outputs[i].script, outputs[j].script))
                reject("lockup outputs share a script");
    if (
        outputs.reduce((sum, output) => sum + output.amount, 0n) !==
        allInputs.reduce((sum, input) => sum + input.value, 0n)
    )
        reject("lockup sats do not balance");

    const groups = [...totals]
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([id, total]) => {
            const allocation = destinations.get(id)!;
            if ([...allocation.values()].reduce((sum, amount) => sum + amount, 0n) !== total)
                reject("lockup assets do not balance");
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
    if (groups.length) outputs.push(Extension.create([Packet.create(groups)]).txOut());

    const checkpoints = envelope.checkpoints.map((checkpoint, index) =>
        attempt(`checkpoint ${index}`, () =>
            Transaction.fromPSBT(decodeBase64(checkpoint, `checkpoint ${index}`)),
        ),
    );
    if (checkpoints.length !== allInputs.length) reject("checkpoint count mismatch");
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
            reject(`unsigned quote contains a sender signature at input ${index}`);
    exactBytes(unsignedCopy(tx).toPSBT(), expectedArk.toPSBT(), "Arkade transaction");
    if (graphId(tx, checkpoints) !== envelope.unsignedTxId)
        reject("unsigned transaction hash mismatch");

    const commitment = record(context.quote.lockup, "quote.lockup");
    exactKeys(
        commitment,
        ["covenantOutputIndex", "senderInputIndexes", "operatorInputIndexes", "unsignedTxId"],
        [],
        "quote.lockup",
    );
    exact(
        commitment,
        {
            covenantOutputIndex: envelope.covenantOutputIndex,
            senderInputIndexes: envelope.senderInputIndexes,
            operatorInputIndexes: envelope.operatorInputIndexes,
            unsignedTxId: envelope.unsignedTxId,
        },
        "quote lockup commitment",
    );
    return { envelope, tx, checkpoints, unsignedPsbt: expectedArk.toPSBT() };
}

export function registerVerifiedQuote(
    verified: VerifiedQuote,
    authorization: VerifyQuoteArgs,
    context: Omit<LockupValidationContext, "quote">,
    validated: ValidatedLockup,
): void {
    capabilities.set(verified, {
        authorization: immutablePlainCopy(authorization, "quote authorization"),
        context: immutablePlainCopy(context, "lockup authorization"),
        baseline: immutablePlainCopy(
            { envelope: validated.envelope, unsignedPsbt: validated.unsignedPsbt },
            "validated lockup",
        ),
    });
}

export const activeQuoteStateFor = (verified: VerifiedQuote): ActiveCapabilityState => {
    const state = capabilities.get(verified);
    if (state === undefined) return reject("unrecognized verified quote capability");
    const authorization = immutablePlainCopy(state.authorization, "retained quote authorization");
    const context = immutablePlainCopy(state.context, "retained lockup authorization");
    const validated = validateLockup({ ...context, quote: authorization.quote });
    exact(validated.envelope, state.baseline.envelope, "retained lockup envelope");
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
                reject(`${label} input ${index} signature is not canonical DEFAULT`);
};

const validateSignedTransaction = (state: ActiveCapabilityState, signed: Transaction): void => {
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
                reject(`signature outside sender input ${index}`);
            continue;
        }
        const signatures = signed.getInput(index).tapScriptSig;
        if (
            !signatures ||
            signatures.length !== 1 ||
            !sameBytes(signatures[0][0].pubKey, state.context.params.senderKey)
        )
            reject(`input ${index} was not signed only by the sender`);
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
    state: ActiveCapabilityState,
    encoded: readonly string[],
): Transaction[] => {
    if (encoded.length !== state.validated.checkpoints.length) reject("checkpoint count mismatch");
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
            if (signatures?.length) reject(`signature outside sender checkpoint ${index}`);
            return signed;
        }
        if (
            !signatures ||
            signatures.length !== 1 ||
            !sameBytes(signatures[0][0].pubKey, state.context.params.senderKey)
        )
            reject(`checkpoint ${index} was not signed only by the sender`);
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

export function assertSignedLockup(verified: VerifiedQuote, encoded: string): string {
    const state = activeQuoteStateFor(verified);
    const envelope = decodeLockupEnvelope(encoded);
    const {
        arkTx: _expectedArkTx,
        checkpoints: _expectedCheckpoints,
        ...expectedCommitments
    } = state.validated.envelope;
    const { arkTx, checkpoints, ...actualCommitments } = envelope;
    exact(actualCommitments, expectedCommitments, "signed lockup commitments");
    const signed = attempt("signed Arkade transaction", () =>
        Transaction.fromPSBT(decodeBase64(arkTx, "signed arkTx")),
    );
    validateSignedTransaction(state, signed);
    validateSignedCheckpoints(state, checkpoints);
    return state.transferId;
}

export async function signLockup({ verified, identity }: SignLockupArgs): Promise<string> {
    const state = activeQuoteStateFor(verified);
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
    validateSignedTransaction(state, signed);
    const checkpoints = signedCheckpoints.map((checkpoint) => base64.encode(checkpoint.toPSBT()));
    const encoded = encodeLockupEnvelope({
        ...state.validated.envelope,
        arkTx: base64.encode(signed.toPSBT()),
        checkpoints,
    });
    assertSignedLockup(verified, encoded);
    return encoded;
}
