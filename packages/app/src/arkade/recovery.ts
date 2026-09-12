import { createHash, randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type { Advance } from "@arkade-taxi/core";
import type { AdvanceRepository, PreparedRecoveryRecord } from "@arkade-taxi/db";
import {
    DustCovenantScript,
    Leaf,
    covenantSpendInput,
    payoutPkScript,
    refundTopup,
} from "@arkade-taxi/covenant";
import {
    CLTVMultisigTapscript,
    EmulatorPacket,
    Extension,
    P2A,
    PrevArkTxField,
    Transaction,
    CSVMultisigTapscript,
    VtxoScript,
    VtxoTaprootTree,
    asset,
    assertAllowedSighashTypes,
    setArkPsbtField,
    scriptFromTapLeafScript,
    verifyTapscriptSignatures,
    type EmulatorProvider,
} from "@arkade-os/sdk";
import { base64, hex } from "@scure/base";
import { fundingInputFromWire } from "@arkade-taxi/protocol";
import type { RuntimeConfig } from "../config.js";
import { sanitizeOperationalError } from "../errors.js";
import { decodeBase64, decodeLockupEnvelope, unsignedGraphId } from "./psbt.js";
import { validatePersistedLockupGraph } from "./submit.js";

const { AssetGroup, AssetId, AssetInput, AssetOutput, Packet } = asset;

export interface RecoveryIntent extends PreparedRecoveryRecord {}

export interface RecoverySubmission {
    txid: string;
    submittedAt: number;
    alreadyKnown: boolean;
}

export class RecoveryArtifactError extends Error {
    readonly code = "recovery_artifact_invalid";
}

function fail(message: string): never {
    throw new RecoveryArtifactError(message);
}

const sameBytes = (a: Uint8Array, b: Uint8Array): boolean =>
    a.length === b.length && a.every((value, index) => value === b[index]);

const exactBase64 = (value: string): Transaction => Transaction.fromPSBT(decodeBase64(value));

const recoveryDigest = (arkTx: string, checkpoints: readonly string[]): string => {
    return createHash("sha256").update(JSON.stringify({ arkTx, checkpoints })).digest("hex");
};

const assetId = (advance: Advance): string | undefined =>
    advance.assetId
        ? AssetId.create(
              hex.encode(Uint8Array.from(advance.assetId.txid).reverse()),
              advance.assetId.groupIndex,
          ).toString()
        : undefined;

function covenantScript(advance: Advance, config: RuntimeConfig): DustCovenantScript {
    return new DustCovenantScript({
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
}

function assertTaggedLocktime(advance: Advance): NonNullable<Advance["recoveryLocktime"]> {
    const locktime = advance.recoveryLocktime;
    if (!locktime) fail(`advance ${advance.id}: missing tagged recovery locktime`);
    if (locktime.kind !== advance.batchExpiry.kind)
        fail(`advance ${advance.id}: recovery locktime kind differs from batch expiry`);
    if (locktime.value !== advance.locktime)
        fail(`advance ${advance.id}: recovery locktime value differs from covenant locktime`);
    if (
        locktime.value < 0n ||
        locktime.value > 0xffff_ffffn ||
        (locktime.kind === "height" && locktime.value >= 500_000_000n) ||
        (locktime.kind === "time" && locktime.value < 500_000_000n)
    )
        fail(`advance ${advance.id}: recovery locktime is invalid for ${locktime.kind}`);
    return locktime;
}

function startupRecoveryAdvance(advance: Advance): Advance {
    if (advance.outpoint || advance.state !== "locking") return advance;
    try {
        const envelope = decodeLockupEnvelope(advance.unsignedLockupTx);
        const source = exactBase64(envelope.arkTx);
        return {
            ...advance,
            outpoint: { txid: source.id, vout: envelope.covenantOutputIndex },
        };
    } catch {
        return fail(`advance ${advance.id}: persisted recovery graph is malformed`);
    }
}

const present = (value: unknown): boolean => value !== undefined;

const nonBlank = (value: unknown): value is string =>
    typeof value === "string" && value.trim().length > 0;

function assertTimestamp(advance: Advance, value: number | undefined, label: string): void {
    if (present(value) && (!Number.isSafeInteger(value) || value! < 0))
        fail(`advance ${advance.id}: ${label} is invalid`);
}

function assertAttemptFacts(advance: Advance, phase: "prepared" | "submitted" | "failed"): void {
    const attempts = advance.recoveryAttempts ?? 0;
    const hasLast = present(advance.recoveryLastAttemptAt);
    const hasNext = present(advance.recoveryNextAttemptAt);
    const hasFailure = present(advance.failureCode) || present(advance.failureDetail);
    if (!Number.isSafeInteger(attempts) || attempts < 0)
        fail(`advance ${advance.id}: recovery attempt count is invalid`);
    if (present(advance.failureCode) !== present(advance.failureDetail))
        fail(`advance ${advance.id}: recovery failure facts are incomplete`);
    if (hasFailure && (!nonBlank(advance.failureCode) || !nonBlank(advance.failureDetail)))
        fail(`advance ${advance.id}: recovery failure facts are invalid`);
    assertTimestamp(advance, advance.recoveryLastAttemptAt, "recovery attempt time");
    assertTimestamp(advance, advance.recoveryNextAttemptAt, "recovery retry time");
    if (
        hasLast &&
        (advance.recoveryLastAttemptAt! < advance.createdAt ||
            advance.recoveryLastAttemptAt! > advance.updatedAt)
    )
        fail(`advance ${advance.id}: recovery attempt time is outside advance chronology`);
    if (attempts === 0 && (hasLast || hasNext || hasFailure))
        fail(`advance ${advance.id}: recovery attempt facts are orphaned`);
    if (attempts > 0 && !hasLast) fail(`advance ${advance.id}: recovery attempt time is missing`);
    if (phase === "prepared") {
        if (attempts > 0 && (!hasNext || !hasFailure))
            fail(`advance ${advance.id}: prepared recovery retry facts are incomplete`);
        if (hasNext && advance.recoveryNextAttemptAt! <= advance.recoveryLastAttemptAt!)
            fail(`advance ${advance.id}: recovery retry backoff is invalid`);
    } else if (hasNext || (phase === "submitted" && hasFailure)) {
        fail(`advance ${advance.id}: completed recovery retains retry facts`);
    } else if (phase === "failed" && (attempts === 0 || !hasFailure)) {
        fail(`advance ${advance.id}: recovery quarantine facts are incomplete`);
    }
}

function assertRecoveryPhaseMatrix(advance: Advance): void {
    const prepared = [
        advance.recoveryGraphDigest,
        advance.recoveryExpectedTxid,
        advance.recoveryPreparedArkTx,
        advance.recoveryPreparedCheckpoints,
    ];
    const response = [advance.recoveryResponseArkTx, advance.recoveryResponseCheckpoints];
    const submitted = [advance.recoveryTxid, advance.recoverySubmittedAt];
    const lease = [
        advance.recoveryLeaseOwner,
        advance.recoveryLeaseToken,
        advance.recoveryLeaseUntil,
    ];
    assertTimestamp(advance, advance.createdAt, "advance creation time");
    assertTimestamp(advance, advance.updatedAt, "advance update time");
    if (advance.updatedAt < advance.createdAt)
        fail(`advance ${advance.id}: advance timestamp chronology is invalid`);
    if (advance.state !== "recovering") {
        const attemptFacts = [
            advance.recoveryLastAttemptAt,
            advance.recoveryNextAttemptAt,
            (advance.recoveryAttempts ?? 0) === 0 ? undefined : advance.recoveryAttempts,
        ];
        if (
            [
                advance.recoveryPhase,
                ...prepared,
                ...response,
                ...submitted,
                ...lease,
                ...attemptFacts,
            ].some(present)
        )
            fail(`advance ${advance.id}: recovery facts exist before recovery`);
        return;
    }
    if (
        !advance.recoveryPhase ||
        !["prepared", "submitted", "failed"].includes(advance.recoveryPhase)
    )
        fail(`advance ${advance.id}: legacy recovery phase or unknown phase cannot be resumed`);
    if (lease.some(present) !== lease.every(present))
        fail(`advance ${advance.id}: recovery lease facts are incomplete`);
    assertTimestamp(advance, advance.recoveryLeaseUntil, "recovery lease time");
    if (
        lease.every(present) &&
        (!nonBlank(advance.recoveryLeaseOwner) ||
            !nonBlank(advance.recoveryLeaseToken) ||
            advance.recoveryLeaseUntil! < advance.createdAt)
    )
        fail(`advance ${advance.id}: recovery lease facts are invalid`);
    if (prepared.some(present) !== prepared.every(present))
        fail(`advance ${advance.id}: recovery preparation facts are incomplete`);
    if (response.some(present) !== response.every(present))
        fail(`advance ${advance.id}: recovery response facts are incomplete`);
    if (submitted.some(present) !== submitted.every(present))
        fail(`advance ${advance.id}: recovery submission facts are incomplete`);
    assertTimestamp(advance, advance.recoverySubmittedAt, "recovery submission time");
    if (advance.recoveryPhase === "prepared") {
        if (!prepared.every(present))
            fail(`advance ${advance.id}: prepared recovery artifacts are missing`);
        if ([...response, ...submitted].some(present))
            fail(`advance ${advance.id}: prepared recovery has response or submission facts`);
    } else {
        if (lease.some(present))
            fail(`advance ${advance.id}: completed recovery phase retains a lease`);
        if (advance.recoveryPhase === "submitted") {
            if (!prepared.every(present) || !response.every(present) || !submitted.every(present))
                fail(`advance ${advance.id}: submitted recovery facts are incomplete`);
        } else if (response.some(present) || submitted.some(present)) {
            fail(`advance ${advance.id}: failed recovery retains response or submission facts`);
        }
    }
    assertAttemptFacts(advance, advance.recoveryPhase as "prepared" | "submitted" | "failed");
    if (
        advance.recoveryPhase === "submitted" &&
        (advance.recoverySubmittedAt! < advance.createdAt ||
            advance.recoverySubmittedAt! > advance.updatedAt ||
            (present(advance.recoveryLastAttemptAt) &&
                advance.recoverySubmittedAt! < advance.recoveryLastAttemptAt!))
    )
        fail(`advance ${advance.id}: recovery submission time is inconsistent`);
}

export function assertRecoveryStartupInvariants(
    advances: readonly Advance[],
    config: RuntimeConfig,
): void {
    for (const advance of advances) {
        if (!["locking", "locked", "recovering"].includes(advance.state)) continue;
        const locktime = assertTaggedLocktime(advance);
        const budget =
            locktime.kind === "height"
                ? config.recoveryBroadcastBlocks
                : config.recoveryBroadcastSeconds;
        if (locktime.value + budget >= advance.batchExpiry.value)
            fail(
                `advance ${advance.id}: recovery locktime plus execution budget must be strictly before batch expiry`,
            );
        try {
            validatePersistedLockupGraph(advance, config);
        } catch (cause) {
            fail(
                `advance ${advance.id}: persisted lockup graph is invalid: ${cause instanceof Error ? cause.message : "validation failed"}`,
            );
        }
        buildRecoveryIntent(startupRecoveryAdvance(advance), config);
        assertRecoveryPhaseMatrix(advance);
        if (advance.state !== "recovering") {
            continue;
        }
        if (advance.recoveryPhase === "failed") {
            const preparedFacts = [
                advance.recoveryGraphDigest,
                advance.recoveryExpectedTxid,
                advance.recoveryPreparedArkTx,
                advance.recoveryPreparedCheckpoints,
            ];
            if (preparedFacts.every((fact) => fact !== undefined)) persistedIntent(advance, config);
            continue;
        }
        const intent = persistedIntent(advance, config);
        if (advance.recoveryPhase === "submitted") {
            if (
                advance.recoveryTxid !== intent.expectedTxid ||
                advance.recoverySubmittedAt === undefined ||
                !advance.recoveryResponseArkTx ||
                !advance.recoveryResponseCheckpoints
            )
                fail(`advance ${advance.id}: submitted recovery facts are incomplete`);
            validateRecoveryResponse(
                advance,
                intent,
                {
                    signedArkTx: advance.recoveryResponseArkTx,
                    signedCheckpointTxs: advance.recoveryResponseCheckpoints,
                },
                config,
            );
        }
    }
}

function buildRecoveryIntentUnchecked(advance: Advance, config: RuntimeConfig): RecoveryIntent {
    assertTaggedLocktime(advance);
    if (!advance.outpoint) fail(`advance ${advance.id}: covenant outpoint is missing`);
    const outpoint = advance.outpoint;
    const envelope = decodeLockupEnvelope(advance.unsignedLockupTx);
    let operatorOutpoints: Advance["operatorInputs"];
    try {
        operatorOutpoints = envelope.operatorInputs
            .map((input) => fundingInputFromWire(input))
            .map(({ txid, vout }) => ({ txid, vout }));
    } catch {
        return fail(`advance ${advance.id}: persisted operator funding is malformed`);
    }
    if (!isDeepStrictEqual(operatorOutpoints, advance.operatorInputs))
        fail(`advance ${advance.id}: persisted operator funding mismatch`);
    if (
        envelope.unsignedTxId !== advance.unsignedLockupId ||
        envelope.covenantOutputIndex !== outpoint.vout
    )
        fail(`advance ${advance.id}: persisted lockup commitments are inconsistent`);
    const source = exactBase64(envelope.arkTx);
    const sourceCheckpoints = envelope.checkpoints.map(exactBase64);
    if (unsignedGraphId(source, sourceCheckpoints) !== envelope.unsignedTxId)
        fail(`advance ${advance.id}: persisted unsigned graph id mismatch`);
    if (source.id !== outpoint.txid || source.outputsLength <= outpoint.vout)
        fail(`advance ${advance.id}: covenant outpoint differs from the lockup graph`);
    const script = covenantScript(advance, config);
    const sourceOutput = source.getOutput(outpoint.vout);
    if (
        sourceOutput.amount !== advance.dust ||
        !sourceOutput.script ||
        !sameBytes(sourceOutput.script, script.pkScript) ||
        script.address(config.addressHrp, config.serverPubkey).encode() !== advance.covenantAddress
    )
        fail(`advance ${advance.id}: persisted covenant script or value mismatch`);

    const fareHosting =
        advance.fare.units === 0n
            ? 0n
            : advance.fare.currency === "sats"
              ? advance.fare.units
              : config.vtxoMinAmount;
    if (advance.fare.units < 0n) fail(`advance ${advance.id}: persisted fare is negative`);
    if (fareHosting > 0n) {
        const fareOutput = source.outputsLength > 1 ? source.getOutput(1) : undefined;
        if (
            !fareOutput ||
            fareOutput.amount !== fareHosting ||
            !fareOutput.script ||
            !sameBytes(
                fareOutput.script,
                payoutPkScript(advance.operatorKey, fareHosting, advance.dust),
            )
        )
            fail(`advance ${advance.id}: persisted fare output mismatch`);
    }

    const id = assetId(advance);
    const units = envelope.assetUnits === undefined ? undefined : BigInt(envelope.assetUnits);
    if ((id === undefined) !== (units === undefined) || (units !== undefined && units <= 0n))
        fail(`advance ${advance.id}: persisted covenant asset facts mismatch`);
    let sourceHoldings: { id: string; amount: bigint }[];
    try {
        const hasExtension = Array.from({ length: source.outputsLength }, (_, index) =>
            source.getOutput(index),
        ).some((output) => output.script && Extension.isExtension(output.script));
        const packet = hasExtension ? Extension.fromTx(source).getAssetPacket() : undefined;
        sourceHoldings = packet
            ? (packet?.groups.flatMap((group) =>
                  group.outputs
                      .filter((output) => output.vout === outpoint.vout)
                      .map((output) => ({
                          id: group.assetId?.toString() ?? "issuance",
                          amount: output.amount,
                      })),
              ) ?? [])
            : [];
        if (advance.fare.currency === "asset" && advance.fare.units > 0n) {
            const fareId = AssetId.create(
                hex.encode(Uint8Array.from(advance.fare.assetId.txid).reverse()),
                advance.fare.assetId.groupIndex,
            ).toString();
            const fareOutputs =
                packet?.groups
                    .filter((group) => group.assetId?.toString() === fareId)
                    .flatMap((group) => group.outputs.filter((output) => output.vout === 1)) ?? [];
            if (fareOutputs.length !== 1 || fareOutputs[0]!.amount !== advance.fare.units)
                fail(`advance ${advance.id}: persisted asset fare mismatch`);
        }
    } catch {
        return fail(`advance ${advance.id}: lockup asset extension is malformed`);
    }
    if (
        sourceHoldings.length !== (id ? 1 : 0) ||
        (id !== undefined && (sourceHoldings[0]!.id !== id || sourceHoldings[0]!.amount !== units))
    )
        fail(`advance ${advance.id}: lockup asset holdings differ from persisted facts`);
    const sourceAssets =
        id && units
            ? Packet.create([
                  AssetGroup.create(
                      AssetId.fromString(id),
                      null,
                      [],
                      [AssetOutput.create(outpoint.vout, units)],
                      [],
                  ),
              ])
            : undefined;
    const transferAssets =
        id && units
            ? Packet.create([
                  AssetGroup.create(
                      AssetId.fromString(id),
                      null,
                      [AssetInput.create(0, units)],
                      [AssetOutput.create(1, units)],
                      [],
                  ),
              ])
            : undefined;
    const input = covenantSpendInput(
        script,
        Leaf.Recovery,
        outpoint,
        advance.dust,
        sourceAssets?.serialize(),
    );
    const topup = refundTopup(script.options.params, config.vtxoMinAmount);
    const outputs = [
        {
            amount: topup,
            script: payoutPkScript(advance.operatorKey, topup, advance.dust),
        },
        {
            amount: advance.dust - topup,
            script: payoutPkScript(advance.senderKey, advance.dust - topup, advance.dust),
        },
        Extension.create([
            ...(transferAssets ? [transferAssets] : []),
            EmulatorPacket.create([{ vin: 0, script: script.covenant.refund }]),
        ]).txOut(),
    ];
    let unroll: CSVMultisigTapscript.Type;
    try {
        unroll = CSVMultisigTapscript.decode(hex.decode(envelope.serverUnrollScript));
    } catch {
        return fail(`advance ${advance.id}: server unroll script is malformed`);
    }
    const selectedScript = scriptFromTapLeafScript(input.tapLeafScript);
    const checkpointTree = new VtxoScript([unroll.script, selectedScript]);
    const checkpoint = new Transaction({ version: 3, lockTime: Number(advance.locktime) });
    checkpoint.addInput({
        txid: input.txid,
        index: input.vout,
        sequence: 0xfffffffe,
        witnessUtxo: { amount: input.value, script: script.pkScript },
        tapLeafScript: [input.tapLeafScript],
    });
    setArkPsbtField(checkpoint, 0, VtxoTaprootTree, input.tapTree);
    checkpoint.addOutput({ amount: input.value, script: checkpointTree.pkScript });
    checkpoint.addOutput(P2A);
    const ark = new Transaction({ version: 3, lockTime: Number(advance.locktime) });
    ark.addInput({
        txid: checkpoint.id,
        index: 0,
        sequence: 0xfffffffe,
        witnessUtxo: { amount: input.value, script: checkpointTree.pkScript },
        tapLeafScript: [checkpointTree.findLeaf(hex.encode(selectedScript))],
    });
    setArkPsbtField(ark, 0, VtxoTaprootTree, checkpointTree.encode());
    setArkPsbtField(ark, 0, PrevArkTxField, source.toBytes());
    outputs.forEach((output) => ark.addOutput(output));
    ark.addOutput(P2A);
    const arkTx = base64.encode(ark.toPSBT());
    const checkpoints = [base64.encode(checkpoint.toPSBT())];
    return {
        arkTx,
        checkpoints,
        digest: recoveryDigest(arkTx, checkpoints),
        expectedTxid: ark.id,
    };
}

export function buildRecoveryIntent(advance: Advance, config: RuntimeConfig): RecoveryIntent {
    try {
        return buildRecoveryIntentUnchecked(advance, config);
    } catch (cause) {
        if (cause instanceof RecoveryArtifactError) throw cause;
        return fail(`advance ${advance.id}: persisted recovery graph is malformed`);
    }
}

function persistedIntent(advance: Advance, config: RuntimeConfig): RecoveryIntent {
    if (
        !advance.recoveryGraphDigest ||
        !advance.recoveryExpectedTxid ||
        !advance.recoveryPreparedArkTx ||
        !advance.recoveryPreparedCheckpoints
    )
        fail(`advance ${advance.id}: prepared recovery artifacts are missing`);
    const intent = {
        digest: advance.recoveryGraphDigest,
        expectedTxid: advance.recoveryExpectedTxid,
        arkTx: advance.recoveryPreparedArkTx,
        checkpoints: advance.recoveryPreparedCheckpoints,
    };
    if (intent.digest !== recoveryDigest(intent.arkTx, intent.checkpoints))
        fail(`advance ${advance.id}: prepared recovery digest mismatch`);
    const exact = buildRecoveryIntent(advance, config);
    if (
        intent.expectedTxid !== exact.expectedTxid ||
        intent.arkTx !== exact.arkTx ||
        !isDeepStrictEqual(intent.checkpoints, exact.checkpoints)
    )
        fail(`advance ${advance.id}: prepared recovery graph drifted from persisted facts`);
    return intent;
}

const unsignedCopy = (tx: Transaction): Transaction => {
    const copy = Transaction.fromPSBT(tx.toPSBT());
    for (let index = 0; index < copy.inputsLength; index++)
        copy.updateInput(index, { tapScriptSig: undefined });
    return copy;
};

function validateSignedTransaction(
    signed: Transaction,
    prepared: Transaction,
    signers: Uint8Array[],
    label: string,
): void {
    if (!sameBytes(unsignedCopy(signed).toPSBT(), unsignedCopy(prepared).toPSBT()))
        fail(`${label} changed the prepared recovery graph`);
    try {
        assertAllowedSighashTypes(signed, [0]);
    } catch {
        return fail(`${label} carries a non-default signature`);
    }
    const signatures = signed.getInput(0).tapScriptSig ?? [];
    const expected = new Set(signers.map(hex.encode));
    if (
        signatures.length !== expected.size ||
        signatures.some(
            ([metadata, signature]) =>
                signature.length !== 64 || !expected.has(hex.encode(metadata.pubKey)),
        ) ||
        new Set(signatures.map(([metadata]) => hex.encode(metadata.pubKey))).size !== expected.size
    )
        fail(`${label} signer set mismatch`);
    try {
        verifyTapscriptSignatures(signed, 0, [...expected], [], [0]);
    } catch {
        return fail(`${label} signature verification failed`);
    }
}

function validateRecoveryResponse(
    advance: Advance,
    intent: RecoveryIntent,
    response: Awaited<ReturnType<EmulatorProvider["submitTx"]>>,
    config: RuntimeConfig,
): void {
    if (
        !response ||
        typeof response.signedArkTx !== "string" ||
        !Array.isArray(response.signedCheckpointTxs) ||
        response.signedCheckpointTxs.length !== intent.checkpoints.length
    )
        fail(`advance ${advance.id}: emulator returned a malformed recovery graph`);
    let signedArk: Transaction;
    let signedCheckpoints: Transaction[];
    try {
        signedArk = exactBase64(response.signedArkTx);
        signedCheckpoints = response.signedCheckpointTxs.map(exactBase64);
    } catch {
        return fail(`advance ${advance.id}: emulator returned malformed recovery PSBTs`);
    }
    if (signedArk.id !== intent.expectedTxid)
        fail(`advance ${advance.id}: emulator recovery txid mismatch`);
    const script = covenantScript(advance, config);
    const signers = CLTVMultisigTapscript.decode(script.scripts[Leaf.Recovery]).params.pubkeys;
    validateSignedTransaction(signedArk, exactBase64(intent.arkTx), signers, "recovery Arkade tx");
    signedCheckpoints.forEach((checkpoint, index) =>
        validateSignedTransaction(
            checkpoint,
            exactBase64(intent.checkpoints[index]!),
            signers,
            `recovery checkpoint ${index}`,
        ),
    );
}

type RecoveryStore = Pick<
    AdvanceRepository,
    | "get"
    | "recordRecoveryPreparationFailure"
    | "claimRecoveryLease"
    | "renewRecoveryLease"
    | "recordRecoveryResponse"
    | "recordRecoveryAttemptFailure"
    | "recordPermanentRecoveryFailure"
>;

class RecoveryLeaseLostError extends Error {}

export function createRecoveryRunner(deps: {
    advances: RecoveryStore;
    emulator: Pick<EmulatorProvider, "submitTx">;
    config: RuntimeConfig;
    workerId: string;
    now(): number;
    leaseSeconds: number;
    backoffSeconds: number;
    maxBackoffSeconds?: number;
}) {
    let stopped = false;
    const timers = new Set<ReturnType<typeof setInterval>>();
    return {
        async recover(input: Advance): Promise<RecoverySubmission | undefined> {
            if (stopped) return undefined;
            const latest = deps.advances.get(input.id) ?? input;
            if (latest.state === "recovering" && latest.recoveryPhase === "submitted") {
                if (
                    !latest.recoveryTxid ||
                    latest.recoverySubmittedAt === undefined ||
                    !latest.recoveryResponseArkTx ||
                    !latest.recoveryResponseCheckpoints
                )
                    fail(`advance ${latest.id}: submitted recovery artifacts are missing`);
                const intent = persistedIntent(latest, deps.config);
                if (latest.recoveryTxid !== intent.expectedTxid)
                    fail(`advance ${latest.id}: submitted recovery txid differs from intent`);
                validateRecoveryResponse(
                    latest,
                    intent,
                    {
                        signedArkTx: latest.recoveryResponseArkTx,
                        signedCheckpointTxs: latest.recoveryResponseCheckpoints,
                    },
                    deps.config,
                );
                return {
                    txid: latest.recoveryTxid,
                    submittedAt: latest.recoverySubmittedAt,
                    alreadyKnown: true,
                };
            }
            let prepared: RecoveryIntent | undefined;
            if (latest.state === "locked") {
                try {
                    prepared = buildRecoveryIntent(latest, deps.config);
                } catch (cause) {
                    if (cause instanceof RecoveryArtifactError)
                        deps.advances.recordRecoveryPreparationFailure(
                            latest.id,
                            cause.code,
                            sanitizeOperationalError(cause, "recovery preparation failed"),
                            deps.now(),
                        );
                    throw cause;
                }
            }
            const token = randomUUID();
            const started = deps.now();
            let advance = deps.advances.claimRecoveryLease(
                latest.id,
                deps.workerId,
                token,
                started,
                started + deps.leaseSeconds,
                prepared,
            );
            if (!advance) return undefined;
            const renew = (): boolean =>
                !stopped &&
                deps.advances.renewRecoveryLease(
                    advance!.id,
                    deps.workerId,
                    token,
                    deps.now(),
                    deps.now() + deps.leaseSeconds,
                );
            let lost = false;
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
            timers.add(timer);
            try {
                const intent = persistedIntent(advance, deps.config);
                if (!renew()) throw new RecoveryLeaseLostError();
                const response = await deps.emulator.submitTx(intent.arkTx, intent.checkpoints);
                if (stopped || lost || !renew()) throw new RecoveryLeaseLostError();
                validateRecoveryResponse(advance, intent, response, deps.config);
                const submittedAt = deps.now();
                if (
                    !deps.advances.recordRecoveryResponse(
                        advance.id,
                        deps.workerId,
                        token,
                        intent.expectedTxid,
                        response.signedArkTx,
                        response.signedCheckpointTxs,
                        submittedAt,
                    )
                )
                    throw new RecoveryLeaseLostError();
                return { txid: intent.expectedTxid, submittedAt, alreadyKnown: false };
            } catch (cause) {
                if (stopped || cause instanceof RecoveryLeaseLostError) return undefined;
                const at = deps.now();
                if (cause instanceof RecoveryArtifactError) {
                    deps.advances.recordPermanentRecoveryFailure(
                        advance.id,
                        deps.workerId,
                        token,
                        cause.code,
                        sanitizeOperationalError(cause, "recovery validation failed"),
                        at,
                    );
                } else {
                    const exponent = Math.min(30, advance.recoveryAttempts ?? 0);
                    const maximum = deps.maxBackoffSeconds ?? deps.backoffSeconds * 32;
                    const delay = Math.min(maximum, deps.backoffSeconds * 2 ** exponent);
                    deps.advances.recordRecoveryAttemptFailure(
                        advance.id,
                        deps.workerId,
                        token,
                        "recovery_submission_ambiguous",
                        "emulator recovery submission failed; exact graph retained for retry",
                        at,
                        at + delay,
                    );
                }
                throw cause;
            } finally {
                clearInterval(timer);
                timers.delete(timer);
            }
        },
        stop(): void {
            stopped = true;
            for (const timer of timers) clearInterval(timer);
            timers.clear();
        },
    };
}
