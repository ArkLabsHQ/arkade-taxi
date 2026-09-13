import {
    admit,
    computeExposure,
    type Advance,
    type AdvanceState,
    type Outpoint,
    type Policy,
    type FareSpec,
    type FundingSnapshot,
    validateFundingSnapshot,
} from "@arkade-taxi/core";
import { DustCovenantScript, type DustCovenantParams } from "@arkade-taxi/covenant";
import {
    assetIdFromWire,
    fareToWire,
    hexToBytes,
    quoteParamsToWire,
    satsFromWire,
    satsToWire,
    type LockupResponse,
    type QuoteRequestBody,
    type QuoteResponse,
    type TransferStatusResponse,
    type FundingInputValue,
    fundingInputFromWire,
} from "@arkade-taxi/protocol";
import type { RuntimeConfig } from "./config.js";
import type { RuntimeGate } from "./arkade/types.js";
import {
    type ExtendedVirtualCoin,
    Transaction,
    type CSVMultisigTapscript,
    type IndexerProvider,
} from "@arkade-os/sdk";
import { createHash } from "node:crypto";
import { buildLockupEnvelope, operatorFundingInput } from "./arkade/lockupBuilder.js";
import { decodeLockupEnvelope, parseLockupEnvelope } from "./arkade/psbt.js";
import { LockupShapeError } from "./lockup.js";
import { verifySenderFunding } from "./arkade/senderFunding.js";
import {
    ReservationConflictError,
    LockupClaimError,
    type ReservationRepository,
    type PolicySnapshot,
} from "@arkade-taxi/db";
import {
    assertFreshSafety,
    selectOperatorFunding,
    type FundingSelection,
} from "./arkade/inventory.js";
import { admissionError, ErrorCode, sanitizeOperationalError, ServiceError } from "./errors.js";
import { validateLockupSubmission, type LockupSubmitter } from "./arkade/submit.js";

export interface LockupBuildRequest {
    senderInputs: FundingInputValue[];
    assetUnits?: bigint;
    funding: FundingSelection;
    advanceId: string;
    params: DustCovenantParams;
    covenantAddress: string;
    /** A separate output at lockup: the covenant pins the operator's repayment
     * to exactly `topup`, so no fee is expressible inside it. */
    fare: FareSpec;
    senderSats: bigint;
}

export interface LockupBuilder {
    buildUnsigned(req: LockupBuildRequest): Promise<Omit<FundingSnapshot, "batchExpiry">>;
}

/** Builds a real unsigned graph with deterministic submission behavior for tests. */
export class FakeLockupBuilder implements LockupBuilder {
    constructor(
        private readonly config: RuntimeConfig,
        private readonly unroll: CSVMultisigTapscript.Type,
    ) {}
    readonly built: LockupBuildRequest[] = [];
    readonly submitted: string[] = [];
    unsignedTx = "cHNidP8BAA==";
    unsignedId = "";
    outpoint: Outpoint = { txid: "aa".repeat(32), vout: 1 };
    failSubmit: Error | null = null;

    async buildUnsigned(req: LockupBuildRequest): Promise<Omit<FundingSnapshot, "batchExpiry">> {
        this.built.push(req);
        this.unsignedTx = buildLockupEnvelope(req, this.config, this.unroll);
        this.unsignedId = parseLockupEnvelope(
            this.unsignedTx,
            req,
            this.config,
            this.unroll,
        ).unsignedTxId;
        return {
            unsignedLockupTx: this.unsignedTx,
            unsignedLockupId: this.unsignedId,
            operatorInputs: req.funding.inputs.map(({ txid, vout }) => ({ txid, vout })),
        };
    }

    validate(advance: Advance, signedPsbt: string) {
        try {
            return validateLockupSubmission(advance, signedPsbt, this.config);
        } catch (cause) {
            if (signedPsbt === advance.unsignedLockupTx) throw cause;
            const envelope = parseLockupEnvelope(
                advance.unsignedLockupTx,
                this.built.find((request) => request.advanceId === advance.id)!,
                this.config,
                this.unroll,
            );
            return {
                encoded: signedPsbt,
                digest: createHash("sha256").update(signedPsbt).digest("hex"),
                unsignedTxId: advance.unsignedLockupId,
                arkTx: envelope.arkTx,
                checkpoints: envelope.checkpoints,
                unsignedCheckpoints: envelope.checkpoints.map((checkpoint) =>
                    Transaction.fromPSBT(checkpoint.toPSBT()),
                ),
                senderInputIndexes: [...envelope.senderInputIndexes],
                operatorInputIndexes: [...envelope.operatorInputIndexes],
                senderKey: advance.senderKey,
                operatorSignerKey: this.config.operatorSignerKey,
                outpoint: this.outpoint,
            };
        }
    }

    async submit(validated: ReturnType<typeof validateLockupSubmission>) {
        this.submitted.push(validated.encoded);
        if (this.failSubmit) throw this.failSubmit;
        return { arkTxid: this.outpoint.txid, outpoint: validated.outpoint };
    }
}

/** The slice of `AdvanceRepository` the quote service uses. */
export interface AdvanceStore {
    insert(a: Advance): void;
    get(id: string): Advance | undefined;
    byState(s: AdvanceState): Advance[];
    byReceiverKeys(keys: readonly Uint8Array[]): Advance[];
    update(a: Advance): void;
    recordLockupSubmission(id: string, arkTxid: string, at: number): void;
    recordLockupFailure(id: string, code: string, detail: string, at: number): void;
    recordRecoverySubmission(id: string, txid: string, at: number): void;
    claimRecovery(id: string, at: number): Advance | undefined;
}

export interface QuoteDeps {
    getServerUnroll(): CSVMultisigTapscript.Type;
    senderInventory: Pick<IndexerProvider, "getVtxos">;
    runtime: RuntimeGate;
    advances: AdvanceStore;
    policy: { get(): Policy; getSnapshot(): PolicySnapshot };
    reservations: Pick<
        ReservationRepository,
        "reserveQuote" | "listReservedOutpoints" | "expireQuotes" | "claimLockup"
    >;
    inventory: {
        getSpendableVtxos(): Promise<ExtendedVirtualCoin[]>;
        getLockedVtxoOutpoints(): Promise<Outpoint[]>;
    };
    config: RuntimeConfig;
    /** Unix SECONDS, matching `QuoteResponse.expiresAt`. */
    now(): number;
    nowMs(): number;
    randomId(): string;
    lockupBuilder: LockupBuilder;
    lockupSubmitter: Pick<LockupSubmitter, "validate"> & Partial<Pick<LockupSubmitter, "submit">>;
}

const badRequest = (message: string) => new ServiceError(ErrorCode.InvalidRequest, 400, message);

function decodeBody(body: unknown): {
    receiverKey: Uint8Array;
    senderKey: Uint8Array;
    senderSats: bigint;
    senderInputs: FundingInputValue[];
    assetUnits?: bigint;
    fareId?: string;
    assetId?: { txid: Uint8Array; groupIndex: number };
} {
    if (body === null || typeof body !== "object" || Array.isArray(body)) {
        throw badRequest("request body must be a JSON object");
    }
    const b = body as QuoteRequestBody;
    if (!Array.isArray(b.senderInputs) || !b.senderInputs.length || b.senderInputs.length > 256)
        throw badRequest("senderInputs must contain 1 to 256 funding inputs");

    let decoded;
    try {
        decoded = {
            receiverKey: hexToBytes(b.receiverKey, "receiverKey"),
            senderKey: hexToBytes(b.senderKey, "senderKey"),
            senderSats: satsFromWire(b.senderSats, "senderSats"),
            senderInputs: b.senderInputs.map((input, i) =>
                fundingInputFromWire(input, `senderInputs[${i}]`),
            ),
            ...(b.assetUnits !== undefined
                ? { assetUnits: satsFromWire(b.assetUnits, "assetUnits") }
                : {}),
            ...(b.fareId !== undefined ? { fareId: b.fareId } : {}),
        };
    } catch (e) {
        throw ServiceError.from(e);
    }
    if (b.fareId !== undefined && (typeof b.fareId !== "string" || !b.fareId.length))
        throw badRequest("invalid fareId");
    if (
        new Set(decoded.senderInputs.map((i) => `${i.txid}:${i.vout}`)).size !==
        decoded.senderInputs.length
    )
        throw badRequest("duplicate sender outpoint");
    if (decoded.senderInputs.reduce((sum, i) => sum + i.value, 0n) !== decoded.senderSats)
        throw badRequest("senderSats differs from funding inputs");

    for (const [name, k] of [
        ["receiverKey", decoded.receiverKey],
        ["senderKey", decoded.senderKey],
    ] as const) {
        if (k.length !== 32) throw badRequest(`${name} must be 32 bytes, got ${k.length}`);
    }

    if (b.assetId === undefined) return decoded;
    try {
        return { ...decoded, assetId: assetIdFromWire(b.assetId) };
    } catch (e) {
        throw ServiceError.from(e);
    }
}

/** `validateParams` rejects malformed or non-distinct keys from inside the
 * covenant package, where the failure is a plain Error. */
function deriveCovenant(
    cfg: RuntimeConfig,
    params: DustCovenantParams,
): { script: DustCovenantScript; address: string } {
    try {
        const script = new DustCovenantScript({
            serverKey: cfg.serverPubkey,
            emulatorKey: cfg.emulatorPubkey,
            params,
            vtxoMinAmount: cfg.vtxoMinAmount,
        });
        return { script, address: script.address(cfg.addressHrp, cfg.serverPubkey).encode() };
    } catch (e) {
        if (e instanceof Error && e.message.startsWith("covenant: ")) {
            throw new ServiceError(ErrorCode.InvalidRequest, 400, e.message, { cause: e });
        }
        throw e;
    }
}

export async function createQuote(
    deps: QuoteDeps,
    body: unknown,
    assertReady?: () => void,
): Promise<QuoteResponse> {
    if (!deps.runtime)
        throw new ServiceError("runtime_unsafe", 503, "runtime verification required");
    return deps.runtime.withAdmission((assertCurrent) => {
        assertCurrent();
        assertReady?.();
        return createAdmittedQuote(
            {
                ...deps,
                runtime: {
                    ...deps.runtime,
                    safety: () => {
                        assertCurrent();
                        assertReady?.();
                        return deps.runtime.safety();
                    },
                },
            },
            body,
        );
    });
}

async function createAdmittedQuote(deps: QuoteDeps, body: unknown): Promise<QuoteResponse> {
    assertFreshSafety(deps.runtime.safety(), deps.nowMs(), deps.config.reconcileIntervalMs);
    deps.reservations.expireQuotes(deps.now());
    for (let attempt = 0; attempt < 3; attempt++) {
        try {
            return await createReservedQuote(deps, body);
        } catch (error) {
            if (!(error instanceof ReservationConflictError)) throw error;
            if (attempt === 2)
                throw new ServiceError(
                    "reservation_conflict",
                    409,
                    "operator inventory reservation conflicted",
                    { cause: error },
                );
        }
    }
    throw new Error("unreachable");
}

async function createReservedQuote(deps: QuoteDeps, body: unknown): Promise<QuoteResponse> {
    assertFreshSafety(deps.runtime.safety(), deps.nowMs(), deps.config.reconcileIntervalMs);
    const req = decodeBody(body);
    const { policy, revision } = deps.policy.getSnapshot();
    const { config } = deps;
    await verifySenderFunding(
        req.senderInputs,
        req.senderKey,
        config.serverPubkey,
        deps.senderInventory,
        deps.runtime.safety(),
        config,
    );

    const exposure = computeExposure(
        ["locking", "locked", "recovering"].flatMap((state) =>
            deps.advances.byState(state as AdvanceState),
        ),
    );
    const decision = admit(req, policy, exposure, config.dust, config.vtxoMinAmount);
    if (!decision.ok) throw admissionError(decision.reason);

    let spendable: ExtendedVirtualCoin[];
    let intentLocks: Outpoint[];
    try {
        spendable = await deps.inventory.getSpendableVtxos();
        intentLocks = await deps.inventory.getLockedVtxoOutpoints();
    } catch (cause) {
        throw new ServiceError(
            "runtime_unsafe",
            503,
            "wallet inventory or intent locks unavailable",
            { cause },
        );
    }
    const reserved = deps.reservations.listReservedOutpoints();
    const selectionOptions = {
        spendable,
        reserved: [...reserved, ...intentLocks],
        requiredSats:
            decision.topup +
            (decision.fare.units === 0n
                ? 0n
                : decision.fare.currency === "sats"
                  ? decision.fare.units
                  : config.vtxoMinAmount),
        safety: deps.runtime.safety(),
        nowMs: deps.nowMs(),
        maxSnapshotAgeMs: config.reconcileIntervalMs,
        minExpiryHeadroomBlocks: config.minExpiryHeadroomBlocks,
        minExpiryHeadroomSeconds: config.minExpiryHeadroomSeconds,
        minReserveSats: config.operatorMinReserveSats,
    };
    const selection = structuredClone(selectOperatorFunding(selectionOptions));
    const expiry = { ...selection.batchExpiry };
    for (const input of req.senderInputs) {
        if (input.expiry.kind !== expiry.kind)
            throw badRequest("sender and operator expiry domains differ");
        if (input.expiry.value < expiry.value) expiry.value = input.expiry.value;
    }
    const margin =
        expiry.kind === "height" ? policy.locktimeMarginBlocks : policy.locktimeMarginSeconds;
    const locktime = expiry.value - BigInt(margin);
    const chainClock =
        expiry.kind === "height"
            ? deps.runtime.safety().chainHeight!
            : deps.runtime.safety().chainTime!;
    if (locktime <= chainClock || (expiry.kind === "time") !== locktime >= 500_000_000n) {
        throw new ServiceError(
            ErrorCode.NoLocktimeHeadroom,
            503,
            `covenant ${expiry.kind} expiry ${expiry.value} leaves no room for margin ${margin}`,
        );
    }

    const params: DustCovenantParams = {
        receiverKey: req.receiverKey,
        senderKey: req.senderKey,
        operatorKey: config.operatorKey,
        dust: config.dust,
        topup: decision.topup,
        locktime,
        ...(req.assetId ? { assetId: req.assetId } : {}),
    };
    const covenant = deriveCovenant(config, params);

    const id = deps.randomId();
    const buildRequest: LockupBuildRequest = {
        funding: structuredClone(selection),
        advanceId: id,
        params,
        covenantAddress: covenant.address,
        fare: decision.fare,
        senderSats: req.senderSats,
        senderInputs: req.senderInputs,
        ...(req.assetUnits !== undefined ? { assetUnits: req.assetUnits } : {}),
    };
    const funding = await deps.lockupBuilder.buildUnsigned(structuredClone(buildRequest));

    const selected = new Set(selection.inputs.map(({ txid, vout }) => `${txid}:${vout}`));
    if (
        funding.operatorInputs.length !== selected.size ||
        new Set(funding.operatorInputs.map(({ txid, vout }) => `${txid}:${vout}`)).size !==
            selected.size ||
        funding.operatorInputs.some(({ txid, vout }) => !selected.has(`${txid}:${vout}`))
    )
        throw new ServiceError(
            "funding_snapshot_invalid",
            503,
            "builder inputs differ from reserved funding selection",
        );

    const wireEnvelope = decodeLockupEnvelope(funding.unsignedLockupTx);
    const assetUnits =
        wireEnvelope.assetUnits === undefined
            ? undefined
            : satsFromWire(wireEnvelope.assetUnits, "envelope.assetUnits");
    if ((params.assetId === undefined) !== (assetUnits === undefined))
        throw new LockupShapeError("builder asset quantity disagrees with quote asset");
    if (assetUnits !== undefined && assetUnits <= 0n)
        throw new LockupShapeError("builder asset quantity must be positive");

    const envelope = parseLockupEnvelope(
        funding.unsignedLockupTx,
        buildRequest,
        config,
        deps.getServerUnroll(),
    );
    if (envelope.unsignedTxId !== funding.unsignedLockupId)
        throw new ServiceError(
            "funding_snapshot_invalid",
            503,
            "builder commitment differs from parsed envelope",
        );

    const now = deps.now();
    const advance: Advance = {
        id,
        state: "quoted",
        receiverKey: params.receiverKey,
        senderKey: params.senderKey,
        operatorKey: params.operatorKey,
        dust: params.dust,
        topup: params.topup,
        locktime: params.locktime,
        recoveryLocktime: { kind: expiry.kind, value: params.locktime },
        ...funding,
        batchExpiry: expiry,
        covenantAddress: covenant.address,
        fare: decision.fare,
        createdAt: now,
        updatedAt: now,
        expiresAt: now + policy.quoteTtlSeconds,
        ...(params.assetId ? { assetId: params.assetId, assetUnits } : {}),
    };
    validateFundingSnapshot(advance);
    await verifySenderFunding(
        req.senderInputs,
        req.senderKey,
        config.serverPubkey,
        deps.senderInventory,
        deps.runtime.safety(),
        config,
    );
    let currentSpendable: ExtendedVirtualCoin[];
    let currentLocks: Outpoint[];
    let latestSafety = deps.runtime.safety();
    try {
        currentSpendable = await deps.inventory.getSpendableVtxos();
        currentLocks = await deps.inventory.getLockedVtxoOutpoints();
        const before = new Set(intentLocks.map(({ txid, vout }) => `${txid}:${vout}`));
        if (
            currentLocks.length !== before.size ||
            currentLocks.some(({ txid, vout }) => !before.has(`${txid}:${vout}`))
        )
            throw new Error("intent locks changed during construction");
    } catch (cause) {
        throw new ServiceError(
            "runtime_unsafe",
            503,
            "wallet inventory or intent locks changed or unavailable",
            { cause },
        );
    }
    latestSafety = deps.runtime.safety();
    const latest = selectOperatorFunding({
        ...selectionOptions,
        spendable: currentSpendable,
        reserved: [...reserved, ...currentLocks],
        safety: latestSafety,
        nowMs: deps.nowMs(),
    });
    for (const input of req.senderInputs) {
        const clock =
            input.expiry.kind === "height" ? latestSafety.chainHeight! : latestSafety.chainTime!;
        const headroom =
            input.expiry.kind === "height"
                ? config.minExpiryHeadroomBlocks
                : config.minExpiryHeadroomSeconds;
        if (input.expiry.value - clock < headroom)
            throw new ServiceError(
                "runtime_unsafe",
                503,
                "sender funding expiry headroom changed during construction",
            );
    }
    const latestClock =
        expiry.kind === "height" ? latestSafety.chainHeight! : latestSafety.chainTime!;
    if (
        latest.inputs.length !== selected.size ||
        latest.inputs.some(
            ({ txid, vout }, i) =>
                txid !== selection.inputs[i].txid || vout !== selection.inputs[i].vout,
        ) ||
        latest.totalValue !== selection.totalValue ||
        latest.batchExpiry.kind !== selection.batchExpiry.kind ||
        latest.batchExpiry.value !== selection.batchExpiry.value ||
        latest.inputs.some(
            (coin, i) =>
                JSON.stringify(operatorFundingInput(coin), (_, v) =>
                    typeof v === "bigint" ? v.toString() : v,
                ) !==
                JSON.stringify(operatorFundingInput(selection.inputs[i]), (_, v) =>
                    typeof v === "bigint" ? v.toString() : v,
                ),
        ) ||
        locktime <= latestClock
    )
        throw new ServiceError("runtime_unsafe", 503, "funding safety changed during construction");
    assertFreshSafety(deps.runtime.safety(), deps.nowMs(), deps.config.reconcileIntervalMs);
    deps.reservations.reserveQuote({
        advance,
        expectedPolicyRevision: revision,
        recoveryExecutionBudget: {
            kind: expiry.kind,
            value:
                expiry.kind === "height"
                    ? deps.config.recoveryBroadcastBlocks
                    : deps.config.recoveryBroadcastSeconds,
        },
        expectedReservedOutpoints: reserved,
    });

    return {
        transferId: id,
        params: quoteParamsToWire(params),
        covenantAddress: covenant.address,
        fare: fareToWire(decision.fare),
        expiresAt: advance.expiresAt,
        unsignedLockupTx: funding.unsignedLockupTx,
        lockup: {
            covenantOutputIndex: 0,
            senderInputIndexes: envelope.senderInputIndexes,
            operatorInputIndexes: envelope.operatorInputIndexes,
            unsignedTxId: envelope.unsignedTxId,
        },
    };
}

export async function submitLockup(
    deps: QuoteDeps,
    id: string,
    signedPsbt: string,
): Promise<LockupResponse> {
    const current = require_(deps.advances.get(id), id);
    let validated;
    try {
        validated = deps.lockupSubmitter.validate(current, signedPsbt);
    } catch (cause) {
        throw new ServiceError(
            ErrorCode.InvalidLockupSignature,
            400,
            "signed lockup does not match the persisted quote or required sender signatures",
            { cause },
        );
    }
    if (current.state === "quoted" && deps.runtime) await deps.runtime.assertAdmission();
    let claim;
    try {
        claim = deps.reservations.claimLockup(
            id,
            validated.unsignedTxId,
            validated.digest,
            validated.encoded,
            deps.now,
        );
    } catch (cause) {
        if (cause instanceof LockupClaimError)
            throw new ServiceError(
                cause.code,
                cause.code === "not_found" ? 404 : 409,
                cause.message,
                { cause },
            );
        throw cause;
    }
    const outpoint = claim.advance.outpoint ?? validated.outpoint;
    return { txid: outpoint.txid, outpoint };
}

export function getTransfer(deps: Pick<QuoteDeps, "advances">, id: string): TransferStatusResponse {
    const a = require_(deps.advances.get(id), id);
    return {
        transferId: a.id,
        state: a.state,
        updatedAt: a.updatedAt,
        ...(a.outpoint ? { outpoint: a.outpoint } : {}),
        ...(a.spentTxid ? { spentTxid: a.spentTxid } : {}),
        ...(a.submissionPhase ? { submissionPhase: a.submissionPhase } : {}),
        ...(a.failureCode ? { failureCode: a.failureCode } : {}),
        ...(a.failureDetail
            ? {
                  failureDetail: sanitizeOperationalError(
                      new Error(a.failureDetail),
                      "operation failed",
                  ),
              }
            : {}),
    };
}

function require_(a: Advance | undefined, id: string): Advance {
    if (!a) throw new ServiceError(ErrorCode.NotFound, 404, `transfer ${id} not found`);
    return a;
}
