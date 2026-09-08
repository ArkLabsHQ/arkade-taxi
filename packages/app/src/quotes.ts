import {
    admit,
    isExpired,
    transition,
    computeExposure,
    type Advance,
    type AdvanceState,
    type Outpoint,
    type Policy,
    type FareSpec,
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
} from "@arkade-taxi/protocol";
import type { RuntimeConfig } from "./config.js";
import { admissionError, ErrorCode, ServiceError } from "./errors.js";

export interface LockupBuildRequest {
    advanceId: string;
    params: DustCovenantParams;
    covenantAddress: string;
    /** A separate output at lockup: the covenant pins the operator's repayment
     * to exactly `topup`, so no fee is expressible inside it. */
    fare: FareSpec;
    senderSats: bigint;
}

/**
 * Building a jointly-funded Arkade transaction needs a live arkd to source the
 * operator's topup VTXOs, and submitting one needs the emulator too. NO REAL
 * IMPLEMENTATION EXISTS YET — it is pending a live stack. Everything above this
 * seam is testable without one, which is why the seam is here.
 */
export interface LockupBuilder {
    buildUnsigned(req: LockupBuildRequest): Promise<string>;
    cosignAndSubmit(signedPsbt: string): Promise<{ txid: string; vout: number }>;
}

/** Stand-in for the real builder. Records what it was asked for so a caller can
 * assert on it, and returns a fixed PSBT and outpoint. */
export class FakeLockupBuilder implements LockupBuilder {
    readonly built: LockupBuildRequest[] = [];
    readonly submitted: string[] = [];
    unsignedTx = "cHNidP8BAA==";
    outpoint: Outpoint = { txid: "aa".repeat(32), vout: 1 };
    failSubmit: Error | null = null;

    async buildUnsigned(req: LockupBuildRequest): Promise<string> {
        this.built.push(req);
        return this.unsignedTx;
    }

    async cosignAndSubmit(signedPsbt: string): Promise<Outpoint> {
        this.submitted.push(signedPsbt);
        if (this.failSubmit) throw this.failSubmit;
        return this.outpoint;
    }
}

/** The slice of `AdvanceRepository` the quote service uses. */
export interface AdvanceStore {
    insert(a: Advance): void;
    get(id: string): Advance | undefined;
    byState(s: AdvanceState): Advance[];
    update(a: Advance): void;
}

export interface QuoteDeps {
    advances: AdvanceStore;
    policy: { get(): Policy };
    config: RuntimeConfig;
    /** Unix SECONDS, matching `QuoteResponse.expiresAt`. */
    now(): number;
    randomId(): string;
    /** Batch expiry of the VTXO the operator will fund the topup from. The
     * covenant cannot be renewed by the operator alone, so recovery must fire
     * before this. UNVERIFIED against arkd — see docs/architecture.md. */
    covenantExpiry(): Promise<bigint>;
    lockupBuilder: LockupBuilder;
}

const badRequest = (message: string) => new ServiceError(ErrorCode.InvalidRequest, 400, message);

function decodeBody(body: unknown): {
    receiverKey: Uint8Array;
    senderKey: Uint8Array;
    senderSats: bigint;
    assetId?: { txid: Uint8Array; groupIndex: number };
} {
    if (body === null || typeof body !== "object" || Array.isArray(body)) {
        throw badRequest("request body must be a JSON object");
    }
    const b = body as QuoteRequestBody;

    let decoded;
    try {
        decoded = {
            receiverKey: hexToBytes(b.receiverKey, "receiverKey"),
            senderKey: hexToBytes(b.senderKey, "senderKey"),
            senderSats: satsFromWire(b.senderSats, "senderSats"),
        };
    } catch (e) {
        throw ServiceError.from(e);
    }

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

export async function createQuote(deps: QuoteDeps, body: unknown): Promise<QuoteResponse> {
    const req = decodeBody(body);
    const policy = deps.policy.get();
    const { config } = deps;

    const exposure = computeExposure(deps.advances.byState("locked"));
    const decision = admit(req, policy, exposure, config.dust, config.vtxoMinAmount);
    if (!decision.ok) throw admissionError(decision.reason);

    const expiry = await deps.covenantExpiry();
    const locktime = expiry - BigInt(policy.locktimeMarginBlocks);
    if (locktime <= 0n) {
        throw new ServiceError(
            ErrorCode.NoLocktimeHeadroom,
            503,
            `covenant expiry ${expiry} leaves no room for a ${policy.locktimeMarginBlocks}-block margin`,
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
    const unsignedLockupTx = await deps.lockupBuilder.buildUnsigned({
        advanceId: id,
        params,
        covenantAddress: covenant.address,
        fare: decision.fare,
        senderSats: req.senderSats,
    });

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
        covenantAddress: covenant.address,
        fare: decision.fare,
        createdAt: now,
        updatedAt: now,
        expiresAt: now + policy.quoteTtlSeconds,
        ...(params.assetId ? { assetId: params.assetId } : {}),
    };
    deps.advances.insert(advance);

    return {
        transferId: id,
        params: quoteParamsToWire(params),
        covenantAddress: covenant.address,
        fare: fareToWire(decision.fare),
        expiresAt: advance.expiresAt,
        unsignedLockupTx,
    };
}

export async function submitLockup(
    deps: QuoteDeps,
    id: string,
    signedPsbt: string,
): Promise<LockupResponse> {
    const existing = require_(deps.advances.get(id), id);
    const now = deps.now();

    if (isExpired(existing, now)) {
        deps.advances.update(transition(existing, "expired", now));
        throw new ServiceError(
            ErrorCode.QuoteExpired,
            409,
            `quote ${id} expired at ${existing.expiresAt}`,
        );
    }
    if (existing.state !== "quoted") {
        throw new ServiceError(
            ErrorCode.InvalidState,
            409,
            `transfer ${id} is ${existing.state}, not quoted`,
        );
    }

    const locking = transition(existing, "locking", now);
    deps.advances.update(locking);

    let outpoint: Outpoint;
    try {
        outpoint = await deps.lockupBuilder.cosignAndSubmit(signedPsbt);
    } catch (cause) {
        release(deps, locking, cause);
    }

    const locked = { ...transition(locking, "locked", deps.now()), outpoint };
    deps.advances.update(locked);
    return { txid: outpoint.txid, outpoint };
}

/** `locking` has no edge to any terminal state, so an advance left there is
 * capital nothing can ever release. The revert is part of the failure path, not
 * an optimisation. */
function release(deps: QuoteDeps, locking: Advance, cause: unknown): never {
    try {
        deps.advances.update(transition(locking, "quoted", deps.now()));
    } catch (revertFailure) {
        throw new ServiceError(
            ErrorCode.LockupStranded,
            500,
            `lockup for ${locking.id} failed and the advance could not be released; it needs manual reconciliation`,
            { cause: revertFailure },
        );
    }
    throw new ServiceError(
        ErrorCode.LockupFailed,
        502,
        "the lockup could not be co-signed and submitted",
        { cause },
    );
}

export function getTransfer(deps: Pick<QuoteDeps, "advances">, id: string): TransferStatusResponse {
    const a = require_(deps.advances.get(id), id);
    return {
        transferId: a.id,
        state: a.state,
        updatedAt: a.updatedAt,
        ...(a.outpoint ? { outpoint: a.outpoint } : {}),
        ...(a.spentTxid ? { spentTxid: a.spentTxid } : {}),
    };
}

function require_(a: Advance | undefined, id: string): Advance {
    if (!a) throw new ServiceError(ErrorCode.NotFound, 404, `transfer ${id} not found`);
    return a;
}
