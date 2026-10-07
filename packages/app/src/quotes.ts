import {
    admit,
    computeExposure,
    type Advance,
    type AdmissionWarning,
    type AdvanceState,
    type LendingGate,
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
    type ReceiveQuoteRepository,
    type SwapFillRepository,
    type PolicySnapshot,
} from "@arkade-taxi/db";
import {
    assertFreshSafety,
    selectOperatorFunding,
    type FundingSelection,
} from "./arkade/inventory.js";
import { unionReservedOutpoints } from "./arkade/reservedOutpoints.js";
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
    /** Set on every new positive-sats-fare lockup: the fare leaves sender change
     * instead of operator change. Absent reconstructs a funded legacy graph. */
    satsFarePayer?: "sender";
    senderSats: bigint;
}

export interface LockupBuilder {
    buildUnsigned(
        req: LockupBuildRequest,
        observe?: QuotePhaseObserver,
    ): Promise<Omit<FundingSnapshot, "batchExpiry">>;
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

    async buildUnsigned(
        req: LockupBuildRequest,
        _observe?: QuotePhaseObserver,
    ): Promise<Omit<FundingSnapshot, "batchExpiry">> {
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
        return validateFakeLockup(advance, signedPsbt, this.config, this.outpoint, () =>
            parseLockupEnvelope(
                advance.unsignedLockupTx,
                this.built.find((request) => request.advanceId === advance.id)!,
                this.config,
                this.unroll,
            ),
        );
    }

    async submit(validated: ReturnType<typeof validateLockupSubmission>) {
        this.submitted.push(validated.encoded);
        if (this.failSubmit) throw this.failSubmit;
        return { arkTxid: this.outpoint.txid, outpoint: validated.outpoint };
    }
}

export function validateFakeLockup(
    advance: Advance,
    signedPsbt: string,
    config: RuntimeConfig,
    outpoint: Outpoint,
    parse: () => ReturnType<typeof parseLockupEnvelope>,
) {
    try {
        return validateLockupSubmission(advance, signedPsbt, config);
    } catch (cause) {
        if (signedPsbt === advance.unsignedLockupTx) throw cause;
        const envelope = parse();
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
            operatorSignerKey: config.operatorSignerKey,
            outpoint,
        };
    }
}

/** The slice of `AdvanceRepository` the quote service uses. */
export interface AdvanceStore {
    insert(a: Advance): void;
    get(id: string): Advance | undefined;
    byState(s: AdvanceState): Advance[];
    byReceiverKeys(keys: readonly Uint8Array[]): Advance[];
    update(a: Advance): void;
    exposureTotals(): { outstandingSats: bigint; lockedCount: number };
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
    /** Swap-fill reservations also tie up Taxi coins; unioned into funding
     * selection so an advance never double-spends a fill's coin. */
    swapFills?: Pick<SwapFillRepository, "listReservedOutpoints" | "expireQuotes">;
    receiveQuotes?: Pick<
        ReceiveQuoteRepository,
        "listReservedOutpoints" | "exposureTotals" | "expireQuotes"
    >;
    /** The custody lending gate for this quote, read once against one snapshot.
     * Absent leaves admission exactly as it was before custody existed. */
    lending?: () => LendingGate | undefined;
    onLendingWarning?: (warnings: readonly AdmissionWarning[]) => void;
    inventory: {
        getSpendableVtxos(): Promise<ExtendedVirtualCoin[]>;
        getLockedVtxoOutpoints(): Promise<Outpoint[]>;
    };
    config: RuntimeConfig;
    /** Unix SECONDS, matching `QuoteResponse.expiresAt`. */
    now(): number;
    nowMs(): number;
    randomId(): string;
    phaseLogger?: { debug(fields: QuotePhaseFields, message: string): void };
    onLockupClaimed?(id: string): void | Promise<void>;
    lockupBuilder: LockupBuilder;
    lockupSubmitter: Pick<LockupSubmitter, "validate"> & Partial<Pick<LockupSubmitter, "submit">>;
}

const QUOTE_PHASES = [
    "quote.total",
    "quote.admission",
    "quote.initial-guard",
    "quote.attempt-guard",
    "quote.sender.first",
    "quote.inventory.first",
    "quote.locks.first",
    "quote.selection.first",
    "quote.covenant",
    "quote.builder",
    "quote.graph.build",
    "quote.graph.self-parse",
    "quote.outer-parse",
    "quote.sender.second",
    "quote.after-sender-snapshot",
    "quote.inventory.second",
    "quote.locks.second",
    "quote.selection.second",
    "quote.final-guard",
    "quote.persist",
] as const;
export type QuotePhase = (typeof QUOTE_PHASES)[number];
export interface QuotePhaseFields {
    quoteSequence: number;
    sequence: number;
    attempt: number;
    phase: QuotePhase;
    outcome: "start" | "ok" | "error";
    elapsedMs: number;
    sampledOriginalSnapshotAgeMs?: number;
    snapshotAgeSampleElapsedMs?: number;
}
export type QuotePhaseObserver = (phase: QuotePhase, outcome: "start" | "ok") => void;
interface QuoteTrace {
    observe: QuotePhaseObserver;
    nextAttempt(): void;
    sample(checkedAt: number, nowMs: number): void;
    failedAttempt(): void;
    finish(outcome: "ok" | "error"): void;
}
let quotePhaseSequence = 0;
function createQuoteTrace(logger: QuoteDeps["phaseLogger"]): QuoteTrace | undefined {
    if (!logger || quotePhaseSequence === Number.MAX_SAFE_INTEGER) return undefined;
    const quoteSequence = ++quotePhaseSequence;
    const started = performance.now();
    const active = new Map<QuotePhase, number>();
    let sequence = 0;
    let attempt = 0;
    let originalCheckedAt: number | undefined;
    let sampledOriginalSnapshotAgeMs: number | undefined;
    let snapshotAgeSampleElapsedMs: number | undefined;
    let finished = false;
    const emit = (phase: QuotePhase, outcome: QuotePhaseFields["outcome"], elapsedMs: number) => {
        if (sequence >= 128 || !Number.isFinite(elapsedMs)) return;
        sequence++;
        try {
            logger.debug(
                {
                    quoteSequence,
                    sequence,
                    attempt,
                    phase,
                    outcome,
                    elapsedMs,
                    ...(sampledOriginalSnapshotAgeMs !== undefined
                        ? {
                              sampledOriginalSnapshotAgeMs,
                              snapshotAgeSampleElapsedMs,
                          }
                        : {}),
                },
                "quote phase",
            );
        } catch {}
    };
    const close = (phase: QuotePhase, outcome: "ok" | "error") => {
        const at = active.get(phase);
        if (at === undefined) return;
        active.delete(phase);
        emit(phase, outcome, performance.now() - at);
    };
    return {
        observe: (phase, outcome) => {
            if (finished || !QUOTE_PHASES.includes(phase)) return;
            if (outcome === "start") {
                active.set(phase, performance.now());
                emit(phase, "start", 0);
            } else if (outcome === "ok") close(phase, "ok");
        },
        nextAttempt: () => {
            attempt++;
        },
        sample: (checkedAt, nowMs) => {
            if (originalCheckedAt === undefined && Number.isFinite(checkedAt))
                originalCheckedAt = checkedAt;
            const age = originalCheckedAt === undefined ? NaN : nowMs - originalCheckedAt;
            if (!Number.isFinite(age) || Math.abs(age) > Number.MAX_SAFE_INTEGER) return;
            sampledOriginalSnapshotAgeMs = age;
            snapshotAgeSampleElapsedMs = performance.now() - started;
        },
        failedAttempt: () => {
            for (const phase of [...active.keys()].reverse())
                if (phase !== "quote.total") close(phase, "error");
        },
        finish: (outcome) => {
            for (const phase of [...active.keys()].reverse()) close(phase, outcome);
            finished = true;
        },
    };
}

const badRequest = (message: string) => new ServiceError(ErrorCode.InvalidRequest, 400, message);

export function decodeSenderFunding(
    b: Pick<
        QuoteRequestBody,
        "senderKey" | "senderSats" | "senderInputs" | "assetUnits" | "fareId" | "paymentSats"
    >,
) {
    try {
        return {
            senderKey: hexToBytes(b.senderKey, "senderKey"),
            senderSats: satsFromWire(b.senderSats, "senderSats"),
            senderInputs: b.senderInputs.map((input, i) =>
                fundingInputFromWire(input, `senderInputs[${i}]`),
            ),
            ...(b.paymentSats !== undefined
                ? { paymentSats: satsFromWire(b.paymentSats, "paymentSats") }
                : {}),
            ...(b.assetUnits !== undefined
                ? { assetUnits: satsFromWire(b.assetUnits, "assetUnits") }
                : {}),
            ...(b.fareId !== undefined ? { fareId: b.fareId } : {}),
        };
    } catch (e) {
        throw ServiceError.from(e);
    }
}

function decodeBody(body: unknown): {
    receiverKey: Uint8Array;
    senderKey: Uint8Array;
    senderSats: bigint;
    senderInputs: FundingInputValue[];
    paymentSats?: bigint;
    assetUnits?: bigint;
    fareId?: string;
    claimMode?: "recycle" | "purchase";
    assetId?: { txid: Uint8Array; groupIndex: number };
} {
    if (body === null || typeof body !== "object" || Array.isArray(body)) {
        throw badRequest("request body must be a JSON object");
    }
    const b = body as QuoteRequestBody;
    if (Object.prototype.hasOwnProperty.call(b, "recoveryRecipient"))
        throw badRequest("recoveryRecipient is service-issued");
    if (!Array.isArray(b.senderInputs) || !b.senderInputs.length || b.senderInputs.length > 256)
        throw badRequest("senderInputs must contain 1 to 256 funding inputs");

    let decoded: {
        receiverKey: Uint8Array;
        senderKey: Uint8Array;
        senderSats: bigint;
        senderInputs: FundingInputValue[];
        paymentSats?: bigint;
        assetUnits?: bigint;
        fareId?: string;
        claimMode?: "recycle" | "purchase";
    };
    try {
        decoded = {
            receiverKey: hexToBytes(b.receiverKey, "receiverKey"),
            ...decodeSenderFunding(b),
        };
    } catch (e) {
        throw ServiceError.from(e);
    }
    if (b.fareId !== undefined && (typeof b.fareId !== "string" || !b.fareId.length))
        throw badRequest("invalid fareId");
    // Rejected here rather than defaulted: a client that named a mode gets that
    // mode or an error, never a silently different covenant.
    if (b.claimMode !== undefined) {
        if (b.claimMode !== "recycle" && b.claimMode !== "purchase")
            throw badRequest("claimMode must be recycle or purchase");
        decoded.claimMode = b.claimMode;
    }
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

export function withQuoteAdmission<D extends { runtime: RuntimeGate }, T>(
    deps: D,
    assertReady: (() => void) | undefined,
    create: (admitted: D) => Promise<T>,
): Promise<T> {
    if (!deps.runtime)
        throw new ServiceError("runtime_unsafe", 503, "runtime verification required");
    return deps.runtime.withAdmission((assertCurrent) => {
        assertCurrent();
        assertReady?.();
        return create({
            ...deps,
            runtime: {
                ...deps.runtime,
                safety: () => {
                    assertCurrent();
                    assertReady?.();
                    return deps.runtime.safety();
                },
            },
        });
    });
}

export async function createQuote(
    deps: QuoteDeps,
    body: unknown,
    assertReady?: () => void,
): Promise<QuoteResponse> {
    const trace = createQuoteTrace(deps.phaseLogger);
    trace?.observe("quote.total", "start");
    trace?.observe("quote.admission", "start");
    try {
        const result = withQuoteAdmission(deps, assertReady, (admitted) => {
            trace?.observe("quote.admission", "ok");
            return createAdmittedQuote(
                admitted,
                () => createReservedQuote(admitted, body, trace),
                trace,
            );
        });
        if (trace)
            void result.then(
                () => trace.finish("ok"),
                () => trace.finish("error"),
            );
        return result;
    } catch (error) {
        trace?.finish("error");
        throw error;
    }
}

export async function createAdmittedQuote<T>(
    deps: Omit<QuoteDeps, "lockupBuilder" | "lockupSubmitter">,
    reserve: () => Promise<T>,
    trace?: QuoteTrace,
): Promise<T> {
    trace?.observe("quote.initial-guard", "start");
    const initialSafety = deps.runtime.safety();
    const initialNowMs = deps.nowMs();
    trace?.sample(initialSafety.checkedAt, initialNowMs);
    assertFreshSafety(initialSafety, initialNowMs, deps.config.reconcileIntervalMs);
    trace?.observe("quote.initial-guard", "ok");
    deps.reservations.expireQuotes(deps.now());
    deps.swapFills?.expireQuotes(deps.now());
    deps.receiveQuotes?.expireQuotes(deps.now());
    for (let attempt = 0; attempt < 3; attempt++) {
        try {
            return await reserve();
        } catch (error) {
            trace?.failedAttempt();
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

async function createReservedQuote(
    deps: QuoteDeps,
    body: unknown,
    trace?: QuoteTrace,
): Promise<QuoteResponse> {
    trace?.nextAttempt();
    trace?.observe("quote.attempt-guard", "start");
    assertFreshSafety(deps.runtime.safety(), deps.nowMs(), deps.config.reconcileIntervalMs);
    trace?.observe("quote.attempt-guard", "ok");
    const req = decodeBody(body);
    const { policy, revision } = deps.policy.getSnapshot();
    const { config } = deps;
    trace?.observe("quote.inventory.first", "start");
    trace?.observe("quote.locks.first", "start");
    const firstFunding = readFunding(deps.inventory);
    trace?.observe("quote.sender.first", "start");
    await verifySenderFunding(
        req.senderInputs,
        req.senderKey,
        config.serverPubkey,
        deps.senderInventory,
        deps.runtime.safety(),
        config,
    );
    trace?.observe("quote.sender.first", "ok");

    const exposure = computeExposure(
        ["locking", "locked", "recovering"].flatMap((state) =>
            deps.advances.byState(state as AdvanceState),
        ),
    );
    const decision = admit(
        req,
        policy,
        exposure,
        config.dust,
        config.vtxoMinAmount,
        deps.lending?.(),
    );
    if (!decision.ok) throw admissionError(decision.reason);
    if (decision.warnings?.length) deps.onLendingWarning?.(decision.warnings);
    const senderPaysFare = decision.fare.currency === "sats" && decision.fare.units > 0n;
    if (senderPaysFare) {
        // A bitcoin transfer's payment IS its senderSats, and `topup` is derived
        // from them, so there is nothing to take a fare from that is not the
        // amount asked to be sent.
        if (req.assetId === undefined)
            throw new ServiceError(
                "fare_unavailable",
                409,
                "a sats fare has no net amount to come out of on a bitcoin transfer",
            );
        if (req.senderSats + decision.topup - config.dust < decision.fare.units)
            throw new ServiceError(
                "fare_unavailable",
                409,
                "sender funding does not cover the dust carrier and this fare",
            );
    }

    let spendable: ExtendedVirtualCoin[];
    let intentLocks: Outpoint[];
    try {
        ({ spendable, intentLocks } = await firstFunding);
        trace?.observe("quote.inventory.first", "ok");
        trace?.observe("quote.locks.first", "ok");
    } catch (cause) {
        throw new ServiceError(
            "runtime_unsafe",
            503,
            "wallet inventory or intent locks unavailable",
            { cause },
        );
    }
    trace?.observe("quote.selection.first", "start");
    const reserved = unionReservedOutpoints(deps.reservations, deps.swapFills, deps.receiveQuotes);
    const selectionOptions = {
        spendable,
        reserved: [...reserved, ...intentLocks],
        requiredSats:
            decision.topup +
            (senderPaysFare || decision.fare.units === 0n
                ? 0n
                : decision.fare.currency === "sats"
                  ? decision.fare.units
                  : config.vtxoMinAmount),
        safety: deps.runtime.safety(),
        nowMs: deps.nowMs(),
        maxSnapshotAgeMs: config.reconcileIntervalMs,
        minExpiryHeadroomBlocks: config.minExpiryHeadroomBlocks,
        minExpiryHeadroomSeconds: config.minExpiryHeadroomSeconds,
        renewalThresholdSeconds: config.vtxoRenewalThresholdSeconds,
        minReserveSats: config.operatorMinReserveSats,
        dustSats: config.dust,
    };
    trace?.sample(selectionOptions.safety.checkedAt, selectionOptions.nowMs);
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
        operatorSignerKey: config.operatorSignerKey,
        exitDelay: config.exitDelay,
        dust: config.dust,
        topup: decision.topup,
        ...(decision.paymentSats !== undefined ? { paymentSats: decision.paymentSats } : {}),
        locktime,
        claimMode: decision.claim,
        ...(req.assetId ? { assetId: req.assetId } : {}),
    };
    trace?.observe("quote.selection.first", "ok");
    trace?.observe("quote.covenant", "start");
    const covenant = deriveCovenant(config, params);
    trace?.observe("quote.covenant", "ok");

    const id = deps.randomId();
    const buildRequest: LockupBuildRequest = {
        funding: structuredClone(selection),
        advanceId: id,
        params,
        covenantAddress: covenant.address,
        fare: decision.fare,
        ...(senderPaysFare ? { satsFarePayer: "sender" as const } : {}),
        senderSats: req.senderSats,
        senderInputs: req.senderInputs,
        ...(req.assetUnits !== undefined ? { assetUnits: req.assetUnits } : {}),
    };
    trace?.observe("quote.builder", "start");
    const funding = await deps.lockupBuilder.buildUnsigned(
        structuredClone(buildRequest),
        trace?.observe,
    );
    trace?.observe("quote.builder", "ok");

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

    trace?.observe("quote.outer-parse", "start");
    const envelope = parseLockupEnvelope(
        funding.unsignedLockupTx,
        buildRequest,
        config,
        deps.getServerUnroll(),
    );
    trace?.observe("quote.outer-parse", "ok");
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
        operatorSignerKey: config.operatorSignerKey,
        exitDelay: config.exitDelay,
        dust: params.dust,
        topup: params.topup,
        ...(params.paymentSats !== undefined ? { paymentSats: params.paymentSats } : {}),
        locktime: params.locktime,
        claimMode: decision.claim,
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
    trace?.observe("quote.sender.second", "start");
    await verifySenderFunding(
        req.senderInputs,
        req.senderKey,
        config.serverPubkey,
        deps.senderInventory,
        deps.runtime.safety(),
        config,
    );
    trace?.observe("quote.sender.second", "ok");
    trace?.observe("quote.after-sender-snapshot", "start");
    let latestSafety = deps.runtime.safety();
    trace?.observe("quote.after-sender-snapshot", "ok");
    const { spendable: currentSpendable, locks: currentLocks } = await rereadInventory(
        deps.inventory,
        intentLocks,
        trace?.observe,
    );
    trace?.observe("quote.selection.second", "start");
    latestSafety = deps.runtime.safety();
    const latestSelectionOptions = {
        ...selectionOptions,
        spendable: currentSpendable,
        reserved: [
            ...unionReservedOutpoints(deps.reservations, deps.swapFills, deps.receiveQuotes),
            ...currentLocks,
        ],
        safety: latestSafety,
        nowMs: deps.nowMs(),
    };
    trace?.sample(latestSelectionOptions.safety.checkedAt, latestSelectionOptions.nowMs);
    const latest = selectOperatorFunding(latestSelectionOptions);
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
                !sameFundingSnapshot(
                    operatorFundingInput(coin),
                    operatorFundingInput(selection.inputs[i]),
                ),
        ) ||
        locktime <= latestClock
    )
        throw new ServiceError("runtime_unsafe", 503, "funding safety changed during construction");
    trace?.observe("quote.selection.second", "ok");
    trace?.observe("quote.final-guard", "start");
    const finalSafety = deps.runtime.safety();
    const finalNowMs = deps.nowMs();
    trace?.sample(finalSafety.checkedAt, finalNowMs);
    assertFreshSafety(finalSafety, finalNowMs, deps.config.reconcileIntervalMs);
    trace?.observe("quote.final-guard", "ok");
    trace?.observe("quote.persist", "start");
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
    trace?.observe("quote.persist", "ok");

    return {
        transferId: id,
        params: quoteParamsToWire(advance),
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

/** The first operator funding read, started beside the sender barrier. Only
 * candidate selection reads it; `rereadInventory` re-reads live after it. */
export function readFunding(
    inventory: QuoteDeps["inventory"],
): Promise<{ spendable: ExtendedVirtualCoin[]; intentLocks: Outpoint[] }> {
    const reads = Promise.all([
        inventory.getSpendableVtxos(),
        inventory.getLockedVtxoOutpoints(),
    ]).then(([spendable, intentLocks]) => ({ spendable, intentLocks }));
    // Unawaited while the sender barrier runs, whose error must still win.
    void reads.catch(() => {});
    return reads;
}

export async function rereadInventory(
    inventory: QuoteDeps["inventory"],
    intentLocks: Outpoint[],
    observe?: QuotePhaseObserver,
): Promise<{ spendable: ExtendedVirtualCoin[]; locks: Outpoint[] }> {
    const mark = (phase: QuotePhase, outcome: "start" | "ok") => {
        try {
            observe?.(phase, outcome);
        } catch {}
    };
    try {
        mark("quote.inventory.second", "start");
        mark("quote.locks.second", "start");
        const [spendable, locks] = await Promise.all([
            inventory.getSpendableVtxos(),
            inventory.getLockedVtxoOutpoints(),
        ]);
        mark("quote.inventory.second", "ok");
        mark("quote.locks.second", "ok");
        const before = new Set(intentLocks.map(({ txid, vout }) => `${txid}:${vout}`));
        if (
            locks.length !== before.size ||
            locks.some(({ txid, vout }) => !before.has(`${txid}:${vout}`))
        )
            throw new Error("intent locks changed during construction");
        return { spendable, locks };
    } catch (cause) {
        throw new ServiceError(
            "runtime_unsafe",
            503,
            "wallet inventory or intent locks changed or unavailable",
            { cause },
        );
    }
}

export const sameFundingSnapshot = (
    actual: ReturnType<typeof operatorFundingInput>,
    expected: ReturnType<typeof operatorFundingInput>,
): boolean =>
    JSON.stringify(actual, (_, value) => (typeof value === "bigint" ? value.toString() : value)) ===
    JSON.stringify(expected, (_, value) => (typeof value === "bigint" ? value.toString() : value));

export async function submitLockup(
    deps: QuoteDeps,
    id: string,
    signedPsbt: string,
    assertReady?: () => void,
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
    let claim;
    try {
        if (current.state === "locking" || current.state === "locked") {
            const pending = deps.runtime?.pendingCheck?.();
            if (pending) await pending;
        }
        const claimLockup = (assertCurrent?: () => void) => {
            assertReady?.();
            assertCurrent?.();
            return deps.reservations.claimLockup(
                id,
                validated.unsignedTxId,
                validated.digest,
                validated.encoded,
                deps.now,
            );
        };
        claim =
            current.state === "quoted" && deps.runtime
                ? await deps.runtime.withAdmission(async (assertCurrent) =>
                      claimLockup(assertCurrent),
                  )
                : claimLockup();
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
    if (claim.claimed) {
        try {
            void Promise.resolve(deps.onLockupClaimed?.(id)).catch(() => {});
        } catch {}
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
