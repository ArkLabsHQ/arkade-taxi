import { createHash, randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type { Advance, Outpoint } from "@arkade-taxi/core";
import type { AdvanceRepository } from "@arkade-taxi/db";
import {
    DustCovenantScript,
    signerTransaction as readSignerTransaction,
} from "@arkade-taxi/covenant";
import { fundingInputFromWire, fundingInputToWire } from "@arkade-taxi/protocol";
import {
    Transaction,
    Intent,
    CSVMultisigTapscript,
    VtxoScript,
    assertAllowedSighashTypes,
    assertSubmittedArkTxid,
    combineTapscriptSigs,
    matchServerCheckpoints,
    verifyTapscriptSignatures,
    type ArkProvider,
    type Identity,
    type ExtendedVirtualCoin,
} from "@arkade-os/sdk";
import { base64, hex } from "@scure/base";
import type { RuntimeConfig } from "../config.js";
import { sanitizeOperationalError } from "../errors.js";
import { LockupShapeError } from "../lockup.js";
import {
    decodeBase64,
    decodeLockupEnvelope,
    encodeLockupEnvelope,
    unsignedGraphId,
    type LockupEnvelope,
} from "./psbt.js";
import { buildLockupEnvelope } from "./lockupBuilder.js";
import type { LockupBuildRequest } from "../quotes.js";

export interface ValidatedLockupSubmission {
    encoded: string;
    digest: string;
    unsignedTxId: string;
    arkTx: Transaction;
    checkpoints: Transaction[];
    unsignedCheckpoints: Transaction[];
    senderInputIndexes: number[];
    operatorInputIndexes: number[];
    senderKey: Uint8Array;
    operatorSignerKey: Uint8Array;
    outpoint: Outpoint;
}

export interface LockupSubmitter {
    validate(advance: Advance, encoded: string): ValidatedLockupSubmission;
    prepare(validated: ValidatedLockupSubmission): Promise<PreparedLockupSubmission>;
    submitPrepared(
        validated: ValidatedLockupSubmission,
        prepared: PreparedLockupSubmission,
    ): Promise<ValidatedSubmissionResponse>;
    finalizePrepared(
        validated: ValidatedLockupSubmission,
        prepared: PreparedLockupSubmission,
        response: ValidatedSubmissionResponse,
    ): Promise<void>;
    submit(validated: ValidatedLockupSubmission): Promise<{ arkTxid: string; outpoint: Outpoint }>;
}

export interface PreparedLockupSubmission {
    arkTx: string;
    ownerCheckpoints: string[];
}

export interface ValidatedSubmissionResponse {
    arkTxid: string;
    finalArkTx: string;
    signedCheckpointTxs: string[];
}

export class SubmissionAttemptError extends Error {
    constructor(
        readonly stage: "prepare" | "submit" | "finalize",
        readonly arkTxid: string | undefined,
        cause: unknown,
        readonly permanentCode?: string,
    ) {
        super(
            permanentCode && cause instanceof Error
                ? cause.message
                : `lockup ${stage} outcome requires reconciliation`,
            { cause },
        );
        this.name = "SubmissionAttemptError";
    }
}

export class PermanentPreparationError extends SubmissionAttemptError {
    constructor(cause: unknown) {
        super("prepare", undefined, cause, "lockup_submission_invalid_prepared_artifact");
        this.name = "PermanentPreparationError";
    }
}

const DEFAULT_SIGHASH = 0;
const INTENT_SIGHASH_ALL = 1;

const sameBytes = (a: Uint8Array, b: Uint8Array): boolean =>
    a.length === b.length && a.every((value, index) => value === b[index]);

const unsignedCopy = (tx: Transaction): Transaction => {
    const copy = Transaction.fromPSBT(tx.toPSBT());
    for (let index = 0; index < copy.inputsLength; index++)
        copy.updateInput(index, { tapScriptSig: undefined });
    return copy;
};

const assertCanonical = (tx: Transaction, label: string): void => {
    try {
        assertAllowedSighashTypes(tx, [DEFAULT_SIGHASH]);
    } catch (cause) {
        throw new LockupShapeError(
            `${label} has a non-DEFAULT signature: ${cause instanceof Error ? cause.message : "signature validation failed"}`,
        );
    }
    for (let index = 0; index < tx.inputsLength; index++)
        for (const [, signature] of tx.getInput(index).tapScriptSig ?? [])
            if (signature.length !== 64)
                throw new LockupShapeError(
                    `${label} input ${index} signature is not canonical DEFAULT`,
                );
};

const signaturesFor = (tx: Transaction, index: number, key: Uint8Array) =>
    (tx.getInput(index).tapScriptSig ?? []).filter(([metadata]) => sameBytes(metadata.pubKey, key));

const verifySignatures = (
    tx: Transaction,
    index: number,
    owners: Uint8Array[],
    label: string,
): void => {
    try {
        verifyTapscriptSignatures(
            tx,
            index,
            owners.map((owner) => hex.encode(owner)),
            [],
            [DEFAULT_SIGHASH],
        );
    } catch (cause) {
        throw new LockupShapeError(
            `${label} signature verification failed: ${cause instanceof Error ? cause.message : "invalid signature"}`,
        );
    }
};

const signedTransaction = (value: unknown, label: string): Transaction => {
    try {
        return readSignerTransaction(value, label);
    } catch (cause) {
        throw new LockupShapeError(
            cause instanceof Error ? cause.message : `${label} signer output validation failed`,
        );
    }
};

const verifyOnlyOwner = (
    tx: Transaction,
    index: number,
    owner: Uint8Array,
    label: string,
): void => {
    const signatures = tx.getInput(index).tapScriptSig;
    if (!signatures || signatures.length !== 1 || signaturesFor(tx, index, owner).length !== 1)
        throw new LockupShapeError(`${label} sender signature is missing or has the wrong owner`);
    verifySignatures(tx, index, [owner], label);
};

const exactSignature = (
    before: Transaction,
    after: Transaction,
    index: number,
    key: Uint8Array,
    label: string,
): void => {
    const expected = signaturesFor(before, index, key);
    const actual = signaturesFor(after, index, key);
    if (!isDeepStrictEqual(actual, expected))
        throw new LockupShapeError(`${label} signature was not preserved byte for byte`);
};

const verifyExactParties = (
    tx: Transaction,
    index: number,
    first: Uint8Array,
    second: Uint8Array,
    label: string,
): void => {
    const signatures = tx.getInput(index).tapScriptSig;
    if (
        !signatures ||
        signatures.length !== 2 ||
        signaturesFor(tx, index, first).length !== 1 ||
        signaturesFor(tx, index, second).length !== 1
    )
        throw new LockupShapeError(`${label} signatures have unexpected owners`);
    verifySignatures(tx, index, [first, second], label);
};

function assertPersistedFacts(advance: Advance, envelope: LockupEnvelope): void {
    if (envelope.unsignedTxId !== advance.unsignedLockupId)
        throw new LockupShapeError("persisted unsigned transaction id mismatch");
    const operatorInputs = envelope.operatorInputs.map((input) =>
        fundingInputToWire(fundingInputFromWire(input)),
    );
    const outpoints = operatorInputs.map(({ txid, vout }) => ({ txid, vout }));
    if (!isDeepStrictEqual(outpoints, advance.operatorInputs))
        throw new LockupShapeError("persisted operator funding mismatch");
    const expiries = [...envelope.senderInputs, ...operatorInputs].map((input) => input.expiry);
    if (
        expiries.some(
            (expiry) =>
                expiry.kind !== advance.batchExpiry.kind ||
                BigInt(expiry.value) <= advance.locktime,
        ) ||
        expiries.reduce(
            (minimum, input) => (BigInt(input.value) < minimum ? BigInt(input.value) : minimum),
            BigInt(expiries[0]!.value),
        ) !== advance.batchExpiry.value
    )
        throw new LockupShapeError("persisted funding expiry mismatch");
}

function assertPersistedGraph(
    advance: Advance,
    envelope: LockupEnvelope,
    config: RuntimeConfig,
): void {
    const senderInputs = envelope.senderInputs.map((input) => fundingInputFromWire(input));
    const operatorInputs = envelope.operatorInputs.map((input) => fundingInputFromWire(input));
    const funding = operatorInputs.map((input) => {
        const tree = VtxoScript.decode(input.tapTree);
        const leaf = tree.findLeaf(hex.encode(input.spendLeaf));
        return {
            txid: input.txid,
            vout: input.vout,
            value: Number(input.value),
            script: hex.encode(tree.pkScript),
            tapTree: input.tapTree,
            forfeitTapLeafScript: leaf,
            intentTapLeafScript: leaf,
            isPreconfirmed: true,
            virtualStatus: { state: "preconfirmed" },
            ...(input.expiry.kind === "height"
                ? { expiresAtHeight: Number(input.expiry.value) }
                : { expiresAt: new Date(Number(input.expiry.value) * 1000) }),
        } as ExtendedVirtualCoin;
    });
    const request: LockupBuildRequest = {
        advanceId: advance.id,
        senderInputs,
        senderSats: senderInputs.reduce((sum, input) => sum + input.value, 0n),
        ...(envelope.assetUnits === undefined ? {} : { assetUnits: BigInt(envelope.assetUnits) }),
        funding: {
            inputs: funding,
            totalValue: operatorInputs.reduce((sum, input) => sum + input.value, 0n),
            batchExpiry: {
                kind: advance.batchExpiry.kind,
                value: operatorInputs.reduce(
                    (minimum, input) =>
                        input.expiry.value < minimum ? input.expiry.value : minimum,
                    operatorInputs[0]!.expiry.value,
                ),
            },
        },
        params: {
            receiverKey: advance.receiverKey,
            senderKey: advance.senderKey,
            operatorKey: advance.operatorKey,
            dust: advance.dust,
            topup: advance.topup,
            locktime: advance.locktime,
            ...(advance.assetId ? { assetId: advance.assetId } : {}),
        },
        covenantAddress: advance.covenantAddress,
        fare: advance.fare,
    };
    const unroll = CSVMultisigTapscript.decode(hex.decode(envelope.serverUnrollScript));
    const rebuilt = decodeLockupEnvelope(buildLockupEnvelope(request, config, unroll));
    if (!isDeepStrictEqual(rebuilt, envelope))
        throw new LockupShapeError("persisted unsigned graph differs from persisted advance facts");
}

export function validatePersistedLockupGraph(
    advance: Advance,
    config: RuntimeConfig,
): LockupEnvelope {
    const envelope = decodeLockupEnvelope(advance.unsignedLockupTx);
    assertPersistedFacts(advance, envelope);
    assertPersistedGraph(advance, envelope, config);
    return envelope;
}

export function validateLockupSubmission(
    advance: Advance,
    encoded: string,
    config: RuntimeConfig,
): ValidatedLockupSubmission {
    const baseline = validatePersistedLockupGraph(advance, config);
    const envelope = decodeLockupEnvelope(encoded);
    const {
        arkTx: _baselineArk,
        checkpoints: _baselineCheckpoints,
        ...baselineCommitments
    } = baseline;
    const { arkTx: _signedArk, checkpoints: _signedCheckpoints, ...signedCommitments } = envelope;
    if (!isDeepStrictEqual(signedCommitments, baselineCommitments))
        throw new LockupShapeError("signed lockup commitments differ from persisted quote");

    const unsignedArk = Transaction.fromPSBT(decodeBase64(baseline.arkTx));
    const unsignedCheckpoints = baseline.checkpoints.map((checkpoint) =>
        Transaction.fromPSBT(decodeBase64(checkpoint)),
    );
    if (unsignedGraphId(unsignedArk, unsignedCheckpoints) !== advance.unsignedLockupId)
        throw new LockupShapeError("persisted unsigned transaction graph mismatch");
    const covenant = new DustCovenantScript({
        serverKey: config.serverPubkey,
        emulatorKey: config.emulatorPubkey,
        vtxoMinAmount: config.vtxoMinAmount,
        params: {
            receiverKey: advance.receiverKey,
            senderKey: advance.senderKey,
            operatorKey: advance.operatorKey,
            dust: advance.dust,
            topup: advance.topup,
            locktime: advance.locktime,
            ...(advance.assetId ? { assetId: advance.assetId } : {}),
        },
    });
    if (
        covenant.address(config.addressHrp, config.serverPubkey).encode() !==
            advance.covenantAddress ||
        !sameBytes(unsignedArk.getOutput(envelope.covenantOutputIndex).script!, covenant.pkScript)
    )
        throw new LockupShapeError("persisted covenant output mismatch");

    const arkTx = Transaction.fromPSBT(decodeBase64(envelope.arkTx));
    assertCanonical(arkTx, "signed Arkade transaction");
    if (!sameBytes(unsignedCopy(arkTx).toPSBT(), unsignedArk.toPSBT()))
        throw new LockupShapeError(
            "signed Arkade transaction differs from persisted unsigned transaction",
        );
    const senderSet = new Set(baseline.senderInputIndexes);
    const operatorSet = new Set(baseline.operatorInputIndexes);
    for (let index = 0; index < arkTx.inputsLength; index++) {
        if (senderSet.has(index))
            verifyOnlyOwner(arkTx, index, advance.senderKey, `Arkade input ${index}`);
        else if (operatorSet.has(index) && arkTx.getInput(index).tapScriptSig?.length)
            throw new LockupShapeError(`operator input ${index} was signed by the request`);
        else if (!operatorSet.has(index))
            throw new LockupShapeError(`Arkade input ${index} has no persisted owner`);
    }

    const checkpoints = envelope.checkpoints.map((checkpoint) =>
        Transaction.fromPSBT(decodeBase64(checkpoint)),
    );
    if (checkpoints.length !== unsignedCheckpoints.length)
        throw new LockupShapeError("signed checkpoint count mismatch");
    checkpoints.forEach((checkpoint, index) => {
        assertCanonical(checkpoint, `checkpoint ${index}`);
        if (!sameBytes(unsignedCopy(checkpoint).toPSBT(), unsignedCheckpoints[index]!.toPSBT()))
            throw new LockupShapeError(
                `checkpoint ${index} differs from persisted unsigned transaction`,
            );
        if (senderSet.has(index))
            verifyOnlyOwner(checkpoint, 0, advance.senderKey, `checkpoint ${index}`);
        else if (operatorSet.has(index) && checkpoint.getInput(0).tapScriptSig?.length)
            throw new LockupShapeError(`operator checkpoint ${index} was signed by the request`);
    });

    const canonical = encodeLockupEnvelope(envelope);
    const digest = createHash("sha256").update(decodeBase64(canonical)).digest("hex");
    return {
        encoded: canonical,
        digest,
        unsignedTxId: advance.unsignedLockupId,
        arkTx,
        checkpoints,
        unsignedCheckpoints,
        senderInputIndexes: [...baseline.senderInputIndexes],
        operatorInputIndexes: [...baseline.operatorInputIndexes],
        senderKey: advance.senderKey,
        operatorSignerKey: config.operatorSignerKey,
        outpoint: { txid: arkTx.id, vout: envelope.covenantOutputIndex },
    };
}

type SubmissionProvider = Pick<ArkProvider, "submitTx" | "finalizeTx"> &
    Partial<Pick<ArkProvider, "getPendingTxs">>;

export function createLockupSubmitter(deps: {
    identity: Identity;
    provider: SubmissionProvider;
    serverPubkey: Uint8Array;
}): Omit<LockupSubmitter, "validate"> {
    const readPrepared = (
        validated: ValidatedLockupSubmission,
        prepared: PreparedLockupSubmission,
    ): { ownerArk: Transaction; ownerCheckpoints: Transaction[] } => {
        const ownerArk = Transaction.fromPSBT(decodeBase64(prepared.arkTx));
        const ownerCheckpoints = prepared.ownerCheckpoints.map((checkpoint) =>
            Transaction.fromPSBT(decodeBase64(checkpoint)),
        );
        assertCanonical(ownerArk, "co-signed Arkade transaction");
        if (!sameBytes(unsignedCopy(ownerArk).toPSBT(), unsignedCopy(validated.arkTx).toPSBT()))
            throw new LockupShapeError("prepared Arkade transaction changed unsigned fields");
        for (const index of validated.senderInputIndexes) {
            exactSignature(
                validated.arkTx,
                ownerArk,
                index,
                validated.senderKey,
                `sender input ${index}`,
            );
            verifyOnlyOwner(ownerArk, index, validated.senderKey, `sender input ${index}`);
        }
        for (const index of validated.operatorInputIndexes)
            verifyOnlyOwner(
                ownerArk,
                index,
                validated.operatorSignerKey,
                `operator input ${index}`,
            );
        if (ownerCheckpoints.length !== validated.unsignedCheckpoints.length)
            throw new LockupShapeError("prepared checkpoint count mismatch");
        ownerCheckpoints.forEach((checkpoint, index) => {
            assertCanonical(checkpoint, `owner checkpoint ${index}`);
            if (
                !sameBytes(
                    unsignedCopy(checkpoint).toPSBT(),
                    validated.unsignedCheckpoints[index]!.toPSBT(),
                )
            )
                throw new LockupShapeError(`owner signer changed checkpoint ${index}`);
            const owner = validated.senderInputIndexes.includes(index)
                ? validated.senderKey
                : validated.operatorSignerKey;
            verifyOnlyOwner(checkpoint, 0, owner, `checkpoint ${index}`);
        });
        return { ownerArk, ownerCheckpoints };
    };

    const validateResponse = (
        validated: ValidatedLockupSubmission,
        prepared: PreparedLockupSubmission,
        response: ValidatedSubmissionResponse,
    ): string[] => {
        const { ownerArk, ownerCheckpoints } = readPrepared(validated, prepared);
        if (
            !response ||
            typeof response.arkTxid !== "string" ||
            typeof response.finalArkTx !== "string" ||
            !Array.isArray(response.signedCheckpointTxs) ||
            response.signedCheckpointTxs.some((checkpoint) => typeof checkpoint !== "string")
        )
            throw new LockupShapeError("submitTx returned a malformed response");
        assertSubmittedArkTxid(response, ownerArk, "submitTx");
        const finalArk = Transaction.fromPSBT(decodeBase64(response.finalArkTx));
        assertCanonical(finalArk, "server Arkade transaction");
        if (!sameBytes(unsignedCopy(finalArk).toPSBT(), unsignedCopy(ownerArk).toPSBT()))
            throw new LockupShapeError("server changed the Arkade transaction");
        for (const index of validated.senderInputIndexes) {
            exactSignature(ownerArk, finalArk, index, validated.senderKey, `sender input ${index}`);
            verifyExactParties(
                finalArk,
                index,
                validated.senderKey,
                deps.serverPubkey,
                `Arkade input ${index}`,
            );
        }
        for (const index of validated.operatorInputIndexes) {
            exactSignature(
                ownerArk,
                finalArk,
                index,
                validated.operatorSignerKey,
                `operator input ${index}`,
            );
            verifyExactParties(
                finalArk,
                index,
                validated.operatorSignerKey,
                deps.serverPubkey,
                `Arkade input ${index}`,
            );
        }
        const matched = new Map(
            matchServerCheckpoints(
                response.signedCheckpointTxs,
                validated.unsignedCheckpoints,
                "submitTx",
            ).map(({ server, local }) => [local.id, server]),
        );
        return validated.unsignedCheckpoints.map((local, index) => {
            const server = matched.get(local.id);
            if (!server) throw new LockupShapeError(`missing server checkpoint ${local.id}`);
            if (!sameBytes(unsignedCopy(server).toPSBT(), local.toPSBT()))
                throw new LockupShapeError(
                    `server checkpoint ${index} changed unsigned fields or metadata`,
                );
            assertCanonical(server, `server checkpoint ${index}`);
            verifyOnlyOwner(server, 0, deps.serverPubkey, `server checkpoint ${index}`);
            const owner = ownerCheckpoints[index];
            if (!owner) throw new LockupShapeError(`missing owner checkpoint ${local.id}`);
            const ownerKey = validated.senderInputIndexes.includes(index)
                ? validated.senderKey
                : validated.operatorSignerKey;
            const serverSignatures = structuredClone(server.getInput(0).tapScriptSig);
            combineTapscriptSigs(owner, server);
            if (
                !isDeepStrictEqual(
                    server.getInput(0).tapScriptSig?.slice(0, serverSignatures?.length),
                    serverSignatures,
                )
            )
                throw new LockupShapeError(
                    `server checkpoint ${index} signature was not preserved`,
                );
            if (!sameBytes(unsignedCopy(server).toPSBT(), local.toPSBT()))
                throw new LockupShapeError(
                    `final checkpoint ${index} changed unsigned fields or metadata`,
                );
            assertCanonical(server, `final checkpoint ${index}`);
            verifyExactParties(server, 0, deps.serverPubkey, ownerKey, `final checkpoint ${index}`);
            return base64.encode(server.toPSBT());
        });
    };

    const adapter: Omit<LockupSubmitter, "validate"> = {
        async prepare(validated) {
            try {
                const ownerArk = signedTransaction(
                    await deps.identity.sign(Transaction.fromPSBT(validated.arkTx.toPSBT()), [
                        ...validated.operatorInputIndexes,
                    ]),
                    "operator Arkade transaction",
                );
                assertCanonical(ownerArk, "co-signed Arkade transaction");
                if (
                    !sameBytes(
                        unsignedCopy(ownerArk).toPSBT(),
                        unsignedCopy(validated.arkTx).toPSBT(),
                    )
                )
                    throw new LockupShapeError("operator signer changed the Arkade transaction");
                for (const index of validated.senderInputIndexes)
                    exactSignature(
                        validated.arkTx,
                        ownerArk,
                        index,
                        validated.senderKey,
                        `sender input ${index}`,
                    );
                for (const index of validated.operatorInputIndexes) {
                    const signatures = signaturesFor(ownerArk, index, validated.operatorSignerKey);
                    if (signatures.length !== 1)
                        throw new LockupShapeError(
                            `operator input ${index} was not signed by the operator`,
                        );
                    verifySignatures(
                        ownerArk,
                        index,
                        [validated.operatorSignerKey],
                        `operator input ${index}`,
                    );
                }
                const ownerCheckpoints = await Promise.all(
                    validated.checkpoints.map(async (checkpoint, index) => {
                        if (!validated.operatorInputIndexes.includes(index))
                            return Transaction.fromPSBT(checkpoint.toPSBT());
                        return signedTransaction(
                            await deps.identity.sign(
                                Transaction.fromPSBT(checkpoint.toPSBT()),
                                [0],
                            ),
                            `operator checkpoint ${index}`,
                        );
                    }),
                );
                ownerCheckpoints.forEach((checkpoint, index) => {
                    assertCanonical(checkpoint, `owner checkpoint ${index}`);
                    if (
                        !sameBytes(
                            unsignedCopy(checkpoint).toPSBT(),
                            validated.unsignedCheckpoints[index]!.toPSBT(),
                        )
                    )
                        throw new LockupShapeError(`owner signer changed checkpoint ${index}`);
                    const owner = validated.senderInputIndexes.includes(index)
                        ? validated.senderKey
                        : validated.operatorSignerKey;
                    verifyOnlyOwner(checkpoint, 0, owner, `checkpoint ${index}`);
                });
                return {
                    arkTx: base64.encode(ownerArk.toPSBT()),
                    ownerCheckpoints: ownerCheckpoints.map((checkpoint) =>
                        base64.encode(checkpoint.toPSBT()),
                    ),
                };
            } catch (cause) {
                throw new PermanentPreparationError(cause);
            }
        },

        async submitPrepared(validated, prepared) {
            let response: Awaited<ReturnType<ArkProvider["submitTx"]>>;
            let ownerArk: Transaction;
            try {
                ownerArk = readPrepared(validated, prepared).ownerArk;
            } catch (cause) {
                throw new SubmissionAttemptError(
                    "submit",
                    undefined,
                    cause,
                    "lockup_submission_invalid_prepared_artifact",
                );
            }
            try {
                response = await deps.provider.submitTx(
                    prepared.arkTx,
                    validated.unsignedCheckpoints.map((checkpoint) =>
                        base64.encode(checkpoint.toPSBT()),
                    ),
                );
            } catch (cause) {
                if (!deps.provider.getPendingTxs)
                    throw new SubmissionAttemptError("submit", undefined, cause);
                const message = { type: "get-pending-tx", expire_at: 0 } as const;
                let signedProof: Transaction;
                try {
                    const proof = Intent.create(
                        message,
                        validated.operatorInputIndexes.map((index) =>
                            validated.unsignedCheckpoints[index]!.getInput(0),
                        ),
                        [],
                    );
                    const indexes = Array.from({ length: proof.inputsLength }, (_, index) => index);
                    signedProof = signedTransaction(
                        await deps.identity.sign(Transaction.fromPSBT(proof.toPSBT()), indexes),
                        "pending lookup proof",
                    );
                    assertAllowedSighashTypes(signedProof, [INTENT_SIGHASH_ALL]);
                    if (!sameBytes(unsignedCopy(signedProof).toPSBT(), proof.toPSBT()))
                        throw new LockupShapeError("pending lookup signer changed the proof");
                    for (const index of indexes) {
                        const signatures = signedProof.getInput(index).tapScriptSig;
                        if (
                            signatures?.length !== 1 ||
                            signaturesFor(signedProof, index, validated.operatorSignerKey)
                                .length !== 1 ||
                            signatures[0]![1].length !== 65 ||
                            signatures[0]![1][64] !== INTENT_SIGHASH_ALL
                        )
                            throw new LockupShapeError(
                                "pending lookup proof has unexpected signatures",
                            );
                        verifyTapscriptSignatures(
                            signedProof,
                            index,
                            [hex.encode(validated.operatorSignerKey)],
                            [],
                            [INTENT_SIGHASH_ALL],
                        );
                    }
                } catch (proofError) {
                    throw new SubmissionAttemptError(
                        "submit",
                        undefined,
                        proofError,
                        "lockup_submission_invalid_pending_proof",
                    );
                }
                try {
                    const pending = await deps.provider.getPendingTxs({
                        message,
                        proof: base64.encode(signedProof.toPSBT()),
                    });
                    const matches = pending.filter((item) => item?.arkTxid === ownerArk.id);
                    if (matches.length !== 1)
                        throw new Error(
                            "pending lookup did not identify one exact prepared transaction",
                        );
                    response = matches[0]!;
                } catch (lookupError) {
                    throw new SubmissionAttemptError(
                        "submit",
                        undefined,
                        new AggregateError(
                            [cause, lookupError],
                            "pending submission lookup failed",
                        ),
                    );
                }
            }
            try {
                assertSubmittedArkTxid(response, ownerArk, "submitTx");
                const persisted = {
                    arkTxid: response.arkTxid,
                    finalArkTx: response.finalArkTx,
                    signedCheckpointTxs: [...response.signedCheckpointTxs],
                };
                validateResponse(validated, prepared, persisted);
                return persisted;
            } catch (cause) {
                if (cause instanceof SubmissionAttemptError) throw cause;
                throw new SubmissionAttemptError(
                    "submit",
                    undefined,
                    cause,
                    "lockup_submission_invalid_provider_response",
                );
            }
        },

        async finalizePrepared(validated, prepared, response) {
            let finalCheckpoints: string[];
            try {
                finalCheckpoints = validateResponse(validated, prepared, response);
            } catch (cause) {
                throw new SubmissionAttemptError(
                    "finalize",
                    response.arkTxid,
                    cause,
                    "lockup_submission_invalid_persisted_artifact",
                );
            }
            try {
                await deps.provider.finalizeTx(response.arkTxid, finalCheckpoints);
            } catch (cause) {
                throw new SubmissionAttemptError("finalize", response.arkTxid, cause);
            }
        },

        async submit(validated) {
            const prepared = await adapter.prepare(validated);
            const response = await adapter.submitPrepared(validated, prepared);
            await adapter.finalizePrepared(validated, prepared, response);
            return { arkTxid: response.arkTxid, outpoint: validated.outpoint };
        },
    };
    return adapter;
}

export interface SubmissionResumer {
    resume(id: string): Promise<boolean>;
    stop(): void;
    drain(): Promise<void>;
}

type SubmissionStore = Pick<
    AdvanceRepository,
    | "get"
    | "claimSubmissionLease"
    | "renewSubmissionLease"
    | "recordPreparedSubmission"
    | "recordSubmissionResponse"
    | "recordSubmissionFinalized"
    | "recordSubmissionAttemptFailure"
    | "recordPermanentSubmissionFailure"
>;

class SubmissionLeaseLostError extends Error {}

class SubmissionValidationError extends Error {
    constructor(
        readonly failureCode: string,
        cause: unknown,
    ) {
        super(cause instanceof Error ? cause.message : "submission validation failed", { cause });
    }
}

export function createSubmissionResumer(deps: {
    advances: SubmissionStore;
    submitter: LockupSubmitter;
    workerId: string;
    now(): number;
    leaseSeconds: number;
    backoffSeconds: number;
    maxBackoffSeconds?: number;
}): SubmissionResumer {
    let stopped = false;
    const active = new Set<Promise<boolean>>();
    const run = async (id: string): Promise<boolean> => {
        if (stopped) return false;
        const started = deps.now();
        const leaseToken = randomUUID();
        let advance = deps.advances.claimSubmissionLease(
            id,
            deps.workerId,
            leaseToken,
            started,
            started + deps.leaseSeconds,
        );
        if (!advance) return false;
        try {
            const runLeased = async <T>(
                phase: "claimed" | "prepared" | "responded",
                work: () => Promise<T>,
            ): Promise<T> => {
                let lost = false;
                const renew = (): boolean =>
                    !stopped &&
                    deps.advances.renewSubmissionLease(
                        id,
                        deps.workerId,
                        leaseToken,
                        phase,
                        deps.now(),
                        deps.now() + deps.leaseSeconds,
                    );
                const assertRenewed = (): void => {
                    try {
                        if (!renew()) throw new SubmissionLeaseLostError();
                    } catch {
                        throw new SubmissionLeaseLostError();
                    }
                };
                assertRenewed();
                const timer = setInterval(
                    () => {
                        try {
                            if (!renew()) lost = true;
                        } catch {
                            lost = true;
                        }
                    },
                    Math.max(25, Math.floor((deps.leaseSeconds * 1000) / 3)),
                );
                try {
                    const result = await work();
                    if (lost) throw new SubmissionLeaseLostError();
                    assertRenewed();
                    return result;
                } finally {
                    clearInterval(timer);
                }
            };
            if (!advance.signedLockupEnvelope || !advance.signedEnvelopeDigest)
                throw new LockupShapeError("claimed submission is missing its signed envelope");
            let validated: ValidatedLockupSubmission;
            try {
                validated = deps.submitter.validate(advance, advance.signedLockupEnvelope);
            } catch (cause) {
                throw new SubmissionValidationError(
                    "lockup_submission_invalid_persisted_envelope",
                    cause,
                );
            }
            if (validated.digest !== advance.signedEnvelopeDigest)
                throw new LockupShapeError("persisted signed envelope digest mismatch");
            if (advance.submissionPhase === "claimed") {
                const prepared = await runLeased("claimed", () =>
                    deps.submitter.prepare(validated),
                );
                if (
                    !deps.advances.recordPreparedSubmission(
                        id,
                        deps.workerId,
                        leaseToken,
                        prepared.arkTx,
                        prepared.ownerCheckpoints,
                        deps.now(),
                    )
                )
                    return false;
                advance = deps.advances.get(id)!;
            }
            if (advance.submissionPhase === "prepared") {
                if (!advance.preparedArkTx || !advance.preparedCheckpoints)
                    throw new LockupShapeError("prepared submission artifacts are missing");
                const prepared = {
                    arkTx: advance.preparedArkTx,
                    ownerCheckpoints: advance.preparedCheckpoints,
                };
                const response = await runLeased("prepared", () =>
                    deps.submitter.submitPrepared(validated, prepared),
                );
                if (
                    !deps.advances.recordSubmissionResponse(
                        id,
                        deps.workerId,
                        leaseToken,
                        response.arkTxid,
                        response.finalArkTx,
                        response.signedCheckpointTxs,
                        deps.now(),
                    )
                )
                    return false;
                advance = deps.advances.get(id)!;
            }
            if (advance.submissionPhase === "responded") {
                if (
                    !advance.preparedArkTx ||
                    !advance.preparedCheckpoints ||
                    !advance.arkTxid ||
                    !advance.serverFinalArkTx ||
                    !advance.serverCheckpoints
                )
                    throw new LockupShapeError("responded submission artifacts are missing");
                const prepared = {
                    arkTx: advance.preparedArkTx,
                    ownerCheckpoints: advance.preparedCheckpoints,
                };
                const response = {
                    arkTxid: advance.arkTxid,
                    finalArkTx: advance.serverFinalArkTx,
                    signedCheckpointTxs: advance.serverCheckpoints,
                };
                await runLeased("responded", () =>
                    deps.submitter.finalizePrepared(validated, prepared, response),
                );
                return deps.advances.recordSubmissionFinalized(
                    id,
                    deps.workerId,
                    leaseToken,
                    deps.now(),
                );
            }
            return advance.submissionPhase === "finalized";
        } catch (cause) {
            if (stopped || cause instanceof SubmissionLeaseLostError) return false;
            const at = deps.now();
            const phase = advance.submissionPhase ?? "claimed";
            const permanentCode =
                cause instanceof SubmissionAttemptError
                    ? cause.permanentCode
                    : cause instanceof SubmissionValidationError
                      ? cause.failureCode
                      : cause instanceof LockupShapeError
                        ? "lockup_submission_invalid_persisted_envelope"
                        : undefined;
            if (permanentCode) {
                deps.advances.recordPermanentSubmissionFailure(
                    id,
                    deps.workerId,
                    leaseToken,
                    permanentCode,
                    sanitizeOperationalError(cause, "permanent submission failure"),
                    at,
                );
                return false;
            }
            const exponent = Math.min(30, advance.submissionAttempts ?? 0);
            const maximum = deps.maxBackoffSeconds ?? deps.backoffSeconds * 32;
            const delay = Math.min(maximum, deps.backoffSeconds * 2 ** exponent);
            deps.advances.recordSubmissionAttemptFailure(
                id,
                deps.workerId,
                leaseToken,
                `lockup_submission_${phase}_ambiguous`,
                sanitizeOperationalError(cause, "submission attempt failed"),
                at,
                at + delay,
            );
            return false;
        }
    };
    return {
        resume(id) {
            if (stopped) return Promise.resolve(false);
            const work = run(id).finally(() => active.delete(work));
            active.add(work);
            return work;
        },
        stop() {
            stopped = true;
        },
        async drain() {
            await Promise.allSettled([...active]);
        },
    };
}

export function productionLockupSubmitter(
    config: RuntimeConfig,
    identity: Identity,
    provider: SubmissionProvider,
): LockupSubmitter {
    return {
        validate: (advance, encoded) => validateLockupSubmission(advance, encoded, config),
        ...createLockupSubmitter({ identity, provider, serverPubkey: config.serverPubkey }),
    };
}
