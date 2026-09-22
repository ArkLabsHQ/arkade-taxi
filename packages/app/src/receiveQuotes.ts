import { ArkAddress, type ExtendedVirtualCoin } from "@arkade-os/sdk";
import { DustCovenantScript, type DustCovenantParams } from "@arkade-taxi/covenant";
import {
    resolveClaimMode,
    resolveFare,
    ruleFor,
    selectFare,
    type ExpiryDeadline,
    type Outpoint,
    type Policy,
} from "@arkade-taxi/core";
import {
    ReceiveQuoteReservationConflictError,
    type PolicySnapshot,
    type ReceiveQuote,
    type ReceiveQuoteRepository,
    type ReservationRepository,
    type SwapFillRepository,
} from "@arkade-taxi/db";
import {
    assetIdFromWire,
    fareToWire,
    hexToBytes,
    quoteParamsToWire,
    satsFromWire,
    satsToWire,
    type ReceiveQuoteRequestBody,
    type ReceiveQuoteResponse,
} from "@arkade-taxi/protocol";
import type { RuntimeConfig } from "./config.js";
import type { AdvanceStore } from "./quotes.js";
import { assertFreshSafety, selectOperatorFunding } from "./arkade/inventory.js";
import { operatorFundingInput } from "./arkade/lockupBuilder.js";
import { unionReservedOutpoints } from "./arkade/reservedOutpoints.js";
import type { RuntimeGate, RuntimeSafety } from "./arkade/types.js";
import { admissionError, ErrorCode, ServiceError } from "./errors.js";

export interface ReceiveQuoteDeps {
    runtime: RuntimeGate;
    policy: { get(): Policy; getSnapshot(): PolicySnapshot };
    advances: Pick<AdvanceStore, "exposureTotals">;
    reservations: Pick<ReservationRepository, "listReservedOutpoints" | "expireQuotes">;
    swapFills?: Pick<
        SwapFillRepository,
        "listReservedOutpoints" | "expireQuotes" | "exposureTotals"
    >;
    receiveQuotes: Pick<
        ReceiveQuoteRepository,
        "insert" | "get" | "bind" | "expireQuotes" | "listReservedOutpoints" | "exposureTotals"
    >;
    inventory: {
        getSpendableVtxos(): Promise<ExtendedVirtualCoin[]>;
        getLockedVtxoOutpoints(): Promise<Outpoint[]>;
    };
    config: RuntimeConfig;
    now(): number;
    nowMs(): number;
    randomId(): string;
}

type DecodedRequest = {
    receiverAddress: string;
    receiverKey: Uint8Array;
    makerPublicKey: string;
    makerKey: Uint8Array;
    assetId: { txid: Uint8Array; groupIndex: number };
    fareId?: string;
    fundingExpiry?: ExpiryDeadline;
};

const badRequest = (message: string) => new ServiceError(ErrorCode.InvalidRequest, 400, message);
const HEX_32 = /^[0-9a-f]{64}$/;
const exactKeys = (value: Record<string, unknown>, allowed: readonly string[]): void => {
    const expected = new Set(allowed);
    const unexpected = Object.keys(value).find((key) => !expected.has(key));
    if (unexpected) throw badRequest(`unexpected request field ${unexpected}`);
};

function decodeBody(body: unknown, config: RuntimeConfig): DecodedRequest {
    if (!body || typeof body !== "object" || Array.isArray(body))
        throw badRequest("request body must be a JSON object");
    const prototype = Object.getPrototypeOf(body);
    if (prototype !== Object.prototype && prototype !== null)
        throw badRequest("request body must be a plain JSON object");
    const raw = body as Record<string, unknown>;
    exactKeys(raw, ["receiverAddress", "makerPublicKey", "assetId", "fareId", "fundingExpiry"]);
    for (const required of ["receiverAddress", "makerPublicKey", "assetId"])
        if (!Object.prototype.hasOwnProperty.call(raw, required))
            throw badRequest(`missing request field ${required}`);

    if (typeof raw.receiverAddress !== "string" || raw.receiverAddress.length > 512)
        throw badRequest("receiverAddress must be a bounded string");
    let receiver: ArkAddress;
    try {
        receiver = ArkAddress.decode(raw.receiverAddress);
    } catch {
        throw badRequest("receiverAddress is invalid");
    }
    if (receiver.encode() !== raw.receiverAddress)
        throw badRequest("receiverAddress is not canonical");
    if (receiver.hrp !== config.addressHrp)
        throw badRequest("receiverAddress uses the wrong network");
    if (!equalBytes(receiver.serverPubKey, config.serverPubkey))
        throw badRequest("receiverAddress names the wrong Arkade server key");

    if (typeof raw.makerPublicKey !== "string" || !HEX_32.test(raw.makerPublicKey))
        throw badRequest("makerPublicKey must be a 32-byte lowercase hex key");
    const makerKey = hexToBytes(raw.makerPublicKey, "makerPublicKey");

    if (!raw.assetId || typeof raw.assetId !== "object" || Array.isArray(raw.assetId))
        throw badRequest("assetId must be an object");
    const assetRaw = raw.assetId as Record<string, unknown>;
    exactKeys(assetRaw, ["txid", "groupIndex"]);
    if (!Object.prototype.hasOwnProperty.call(assetRaw, "txid"))
        throw badRequest("assetId is missing txid");
    if (!Object.prototype.hasOwnProperty.call(assetRaw, "groupIndex"))
        throw badRequest("assetId is missing groupIndex");
    let assetId;
    try {
        assetId = assetIdFromWire(assetRaw as unknown as ReceiveQuoteRequestBody["assetId"]);
    } catch (cause) {
        throw ServiceError.from(cause);
    }
    if (assetId.txid.length !== 32) throw badRequest("assetId.txid must be 32 bytes");

    let fareId: string | undefined;
    if (raw.fareId !== undefined) {
        if (typeof raw.fareId !== "string" || !raw.fareId.length || raw.fareId.length > 128)
            throw badRequest("fareId must be a non-empty bounded string");
        fareId = raw.fareId;
    }
    let fundingExpiry: ExpiryDeadline | undefined;
    if (raw.fundingExpiry !== undefined) {
        if (
            !raw.fundingExpiry ||
            typeof raw.fundingExpiry !== "object" ||
            Array.isArray(raw.fundingExpiry)
        )
            throw badRequest("fundingExpiry must be an object");
        const expiry = raw.fundingExpiry as Record<string, unknown>;
        exactKeys(expiry, ["kind", "value"]);
        if (expiry.kind !== "height" && expiry.kind !== "time")
            throw badRequest("fundingExpiry.kind must be height or time");
        let value: bigint;
        try {
            value = satsFromWire(expiry.value as string, "fundingExpiry.value");
        } catch (cause) {
            throw ServiceError.from(cause);
        }
        if (value <= 0n || value > BigInt(Number.MAX_SAFE_INTEGER))
            throw badRequest("fundingExpiry.value is outside the supported range");
        fundingExpiry = { kind: expiry.kind, value };
    }
    return {
        receiverAddress: raw.receiverAddress,
        receiverKey: receiver.vtxoTaprootKey,
        makerPublicKey: raw.makerPublicKey,
        makerKey,
        assetId,
        ...(fareId === undefined ? {} : { fareId }),
        ...(fundingExpiry === undefined ? {} : { fundingExpiry }),
    };
}

function deriveCovenant(config: RuntimeConfig, params: DustCovenantParams): string {
    try {
        return new DustCovenantScript({
            serverKey: config.serverPubkey,
            emulatorKey: config.emulatorPubkey,
            params,
            vtxoMinAmount: config.vtxoMinAmount,
        })
            .address(config.addressHrp, config.serverPubkey)
            .encode();
    } catch (cause) {
        throw badRequest(cause instanceof Error ? cause.message : "invalid covenant identity");
    }
}

function immutableTerms(
    req: DecodedRequest,
    policy: Policy,
    config: RuntimeConfig,
): { loan: bigint; fare: { currency: "sats"; units: bigint } } {
    const receipt = config.vtxoMinAmount;
    const loan = config.dust - receipt;
    if (receipt <= 0n || config.dust <= 0n || loan < receipt || loan + receipt !== config.dust)
        throw badRequest("server limits cannot form a positive two-output split");
    const rule = ruleFor(policy.assetRules, req.assetId);
    if (!rule) throw admissionError("asset_not_served");
    if (!rule.enabled) throw admissionError("asset_disabled");
    if (resolveClaimMode(rule.claim, "recycle") !== "recycle")
        throw badRequest("asset policy does not allow recycle claims");
    const cap = rule.maxTopupSats ?? policy.maxPerPaymentTopupSats;
    if (loan > cap) throw admissionError("topup_exceeds_max_per_payment");
    let fare;
    try {
        fare = resolveFare(selectFare(rule, req.fareId), {
            topupSats: loan,
            assetId: req.assetId,
        });
    } catch (cause) {
        throw new ServiceError("fare_unavailable", 409, "requested fare is unavailable", { cause });
    }
    if (fare.currency !== "sats")
        throw new ServiceError("fare_unavailable", 409, "receive quotes require a sats fare");
    return { loan, fare };
}

export async function createReceiveQuote(
    deps: ReceiveQuoteDeps,
    body: unknown,
    assertReady?: () => void,
): Promise<ReceiveQuoteResponse> {
    if (!deps.runtime)
        throw new ServiceError("runtime_unsafe", 503, "runtime verification required");
    return deps.runtime.withAdmission((assertCurrent) => {
        assertCurrent();
        assertReady?.();
        return createAdmitted(
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

async function createAdmitted(
    deps: ReceiveQuoteDeps,
    body: unknown,
): Promise<ReceiveQuoteResponse> {
    assertFreshSafety(deps.runtime.safety(), deps.nowMs(), deps.config.reconcileIntervalMs);
    const req = decodeBody(body, deps.config);
    const initial = deps.policy.getSnapshot();
    const terms = immutableTerms(req, initial.policy, deps.config);
    try {
        deriveCovenant(deps.config, {
            receiverKey: req.receiverKey,
            senderKey: req.makerKey,
            operatorKey: deps.config.operatorKey,
            dust: deps.config.dust,
            topup: terms.loan,
            assetId: req.assetId,
            locktime: 1n,
            claimMode: "recycle",
            recoveryRecipient: "receiver",
        });
    } catch (cause) {
        throw badRequest("makerPublicKey or receiverAddress is not a valid covenant identity");
    }
    deps.reservations.expireQuotes(deps.now());
    deps.swapFills?.expireQuotes(deps.now());
    deps.receiveQuotes.expireQuotes(deps.now());
    for (let attempt = 0; attempt < 3; attempt++) {
        try {
            return await createReserved(deps, req, initial, terms);
        } catch (cause) {
            if (!(cause instanceof ReceiveQuoteReservationConflictError)) throw cause;
            if (attempt === 2)
                throw new ServiceError(
                    "reservation_conflict",
                    409,
                    "operator inventory reservation conflicted",
                    { cause },
                );
        }
    }
    throw new Error("unreachable");
}

async function createReserved(
    deps: ReceiveQuoteDeps,
    req: DecodedRequest,
    initial: PolicySnapshot,
    terms: { loan: bigint; fare: { currency: "sats"; units: bigint } },
): Promise<ReceiveQuoteResponse> {
    enforceExposure(deps, initial.policy, terms.loan);
    const firstSafety = deps.runtime.safety();
    assertFreshSafety(firstSafety, deps.nowMs(), deps.config.reconcileIntervalMs);
    let spendable: ExtendedVirtualCoin[];
    let locks: Outpoint[];
    try {
        [spendable, locks] = await Promise.all([
            deps.inventory.getSpendableVtxos(),
            deps.inventory.getLockedVtxoOutpoints(),
        ]);
    } catch (cause) {
        throw new ServiceError(
            "runtime_unsafe",
            503,
            "wallet inventory or intent locks unavailable",
            {
                cause,
            },
        );
    }
    const reserved = unionReservedOutpoints(deps.reservations, deps.swapFills, deps.receiveQuotes);
    const options = {
        spendable,
        reserved: [...reserved, ...locks],
        requiredSats:
            terms.loan +
            (deps.config.dust > terms.fare.units ? deps.config.dust - terms.fare.units : 0n),
        safety: firstSafety,
        nowMs: deps.nowMs(),
        maxSnapshotAgeMs: deps.config.reconcileIntervalMs,
        minExpiryHeadroomBlocks: deps.config.minExpiryHeadroomBlocks,
        minExpiryHeadroomSeconds: deps.config.minExpiryHeadroomSeconds,
        minReserveSats: deps.config.operatorMinReserveSats,
    };
    const selection = structuredClone(selectOperatorFunding(options));
    const floor = inputFloor(selection.batchExpiry, req.fundingExpiry);
    const recovery = recoveryDeadline(floor, initial.policy, firstSafety, deps.config);
    const params: ReceiveQuote["params"] = {
        receiverKey: req.receiverKey,
        senderKey: req.makerKey,
        operatorKey: deps.config.operatorKey,
        dust: deps.config.dust,
        topup: terms.loan,
        assetId: req.assetId,
        locktime: recovery.value,
        claimMode: "recycle",
        recoveryRecipient: "receiver",
    };
    const covenantAddress = deriveCovenant(deps.config, params);
    let latestSpendable: ExtendedVirtualCoin[];
    let latestLocks: Outpoint[];
    try {
        [latestSpendable, latestLocks] = await Promise.all([
            deps.inventory.getSpendableVtxos(),
            deps.inventory.getLockedVtxoOutpoints(),
        ]);
    } catch (cause) {
        throw new ServiceError("runtime_unsafe", 503, "wallet inventory changed or unavailable", {
            cause,
        });
    }
    if (!sameOutpoints(locks, latestLocks))
        throw new ServiceError("runtime_unsafe", 503, "intent locks changed during construction");
    const latestSafety = deps.runtime.safety();
    assertFreshSafety(latestSafety, deps.nowMs(), deps.config.reconcileIntervalMs);
    const latest = selectOperatorFunding({
        ...options,
        spendable: latestSpendable,
        reserved: [
            ...unionReservedOutpoints(deps.reservations, deps.swapFills, deps.receiveQuotes),
            ...latestLocks,
        ],
        safety: latestSafety,
        nowMs: deps.nowMs(),
    });
    const latestFloor = inputFloor(latest.batchExpiry, req.fundingExpiry);
    const latestRecovery = recoveryDeadline(latestFloor, initial.policy, latestSafety, deps.config);
    if (
        !sameSelection(selection, latest) ||
        latestFloor.kind !== floor.kind ||
        latestFloor.value !== floor.value ||
        latestRecovery.kind !== recovery.kind ||
        latestRecovery.value !== recovery.value
    )
        throw new ServiceError("runtime_unsafe", 503, "funding safety changed during construction");
    const currentPolicy = deps.policy.getSnapshot();
    if (currentPolicy.revision !== initial.revision)
        throw new ServiceError(
            "policy_revision_conflict",
            409,
            "policy changed during construction",
        );
    immutableTerms(req, currentPolicy.policy, deps.config);
    const now = deps.now();
    const quote: ReceiveQuote = {
        id: deps.randomId(),
        state: "quoted",
        receiverAddress: req.receiverAddress,
        makerPublicKey: req.makerPublicKey,
        params,
        covenantAddress,
        fare: terms.fare,
        batchExpiry: { ...selection.batchExpiry },
        inputExpiryFloor: floor,
        recoveryLocktime: recovery,
        loanSats: terms.loan,
        createdAt: now,
        expiresAt: now + initial.policy.quoteTtlSeconds,
        policyRevision: initial.revision,
        operatorInputs: selection.inputs.map(operatorFundingInput),
    };
    deps.receiveQuotes.insert({
        quote,
        expectedPolicyRevision: initial.revision,
        recoveryExecutionBudget: {
            kind: floor.kind,
            value:
                floor.kind === "height"
                    ? deps.config.recoveryBroadcastBlocks
                    : deps.config.recoveryBroadcastSeconds,
        },
        expectedReservedOutpoints: reserved,
    });
    return toResponse(quote);
}

function inputFloor(batch: ExpiryDeadline, hint?: ExpiryDeadline): ExpiryDeadline {
    if (!hint) return { ...batch };
    if (hint.kind !== batch.kind)
        throw badRequest("funding expiry domain differs from operator inputs");
    return { kind: batch.kind, value: hint.value < batch.value ? hint.value : batch.value };
}

function recoveryDeadline(
    floor: ExpiryDeadline,
    policy: Policy,
    safety: RuntimeSafety,
    config: RuntimeConfig,
): ExpiryDeadline {
    const clock = floor.kind === "height" ? safety.chainHeight! : safety.chainTime!;
    const headroom =
        floor.kind === "height" ? config.minExpiryHeadroomBlocks : config.minExpiryHeadroomSeconds;
    const margin = BigInt(
        floor.kind === "height" ? policy.locktimeMarginBlocks : policy.locktimeMarginSeconds,
    );
    const execution =
        floor.kind === "height" ? config.recoveryBroadcastBlocks : config.recoveryBroadcastSeconds;
    if (floor.value - clock < headroom)
        throw new ServiceError(ErrorCode.NoLocktimeHeadroom, 503, "funding expiry lacks headroom");
    const value = floor.value - margin;
    if (
        margin <= execution ||
        value <= clock ||
        value + execution >= floor.value ||
        (floor.kind === "time") !== value >= 500_000_000n
    )
        throw new ServiceError(ErrorCode.NoLocktimeHeadroom, 503, "recovery margin is unsafe");
    return { kind: floor.kind, value };
}

function enforceExposure(deps: ReceiveQuoteDeps, policy: Policy, loan: bigint): void {
    const advance = deps.advances.exposureTotals();
    const swaps = deps.swapFills?.exposureTotals() ?? { outstandingSats: 0n, activeCount: 0 };
    const receive = deps.receiveQuotes.exposureTotals();
    if (
        advance.outstandingSats + swaps.outstandingSats + receive.outstandingSats + loan >
        policy.maxOutstandingSats
    )
        throw admissionError("exceeds_max_outstanding");
    if (
        advance.lockedCount + swaps.activeCount + receive.activeCount >=
        policy.maxConcurrentAdvances
    )
        throw admissionError("max_concurrent_advances");
}

function sameSelection(
    first: ReturnType<typeof selectOperatorFunding>,
    second: ReturnType<typeof selectOperatorFunding>,
): boolean {
    if (
        first.totalValue !== second.totalValue ||
        first.batchExpiry.kind !== second.batchExpiry.kind ||
        first.batchExpiry.value !== second.batchExpiry.value ||
        first.inputs.length !== second.inputs.length
    )
        return false;
    return first.inputs.every((coin, index) =>
        equalFunding(operatorFundingInput(coin), operatorFundingInput(second.inputs[index])),
    );
}

const equalFunding = (
    a: ReturnType<typeof operatorFundingInput>,
    b: ReturnType<typeof operatorFundingInput>,
) =>
    JSON.stringify(a, (_, value) => (typeof value === "bigint" ? value.toString() : value)) ===
    JSON.stringify(b, (_, value) => (typeof value === "bigint" ? value.toString() : value));
const equalBytes = (a: Uint8Array, b: Uint8Array): boolean =>
    a.length === b.length && a.every((byte, index) => byte === b[index]);
const sameOutpoints = (a: readonly Outpoint[], b: readonly Outpoint[]): boolean => {
    const first = new Set(a.map(({ txid, vout }) => `${txid}:${vout}`));
    return first.size === b.length && b.every(({ txid, vout }) => first.has(`${txid}:${vout}`));
};

function toResponse(quote: ReceiveQuote): ReceiveQuoteResponse {
    return {
        quoteId: quote.id,
        state: quote.state,
        receiverAddress: quote.receiverAddress,
        makerPublicKey: quote.makerPublicKey,
        params: quoteParamsToWire(quote.params),
        covenantAddress: quote.covenantAddress,
        fare: fareToWire(quote.fare),
        batchExpiry: { kind: quote.batchExpiry.kind, value: satsToWire(quote.batchExpiry.value) },
        inputExpiryFloor: {
            kind: quote.inputExpiryFloor.kind,
            value: satsToWire(quote.inputExpiryFloor.value),
        },
        recoveryLocktime: {
            kind: quote.recoveryLocktime.kind,
            value: satsToWire(quote.recoveryLocktime.value),
        },
        createdAt: quote.createdAt,
        expiresAt: quote.expiresAt,
        ...(quote.boundFillId === undefined ? {} : { boundFillId: quote.boundFillId }),
    };
}

export function getReceiveQuote(
    deps: Pick<ReceiveQuoteDeps, "receiveQuotes" | "now">,
    id: string,
): ReceiveQuoteResponse {
    deps.receiveQuotes.expireQuotes(deps.now());
    const quote = deps.receiveQuotes.get(id);
    if (!quote) throw new ServiceError(ErrorCode.NotFound, 404, `receive quote ${id} not found`);
    return toResponse(quote);
}
