import {
    admit,
    computeExposure,
    type Advance,
    type AdvanceState,
    type FundingSnapshot,
    type Outpoint,
    validateFundingSnapshot,
} from "@arkade-taxi/core";
import {
    assetIdFromWire,
    fareToWire,
    hexToBytes,
    satsFromWire,
    sponsoredParamsToWire,
    type FundingInputValue,
    fundingInputFromWire,
    type SponsoredQuoteRequestBody,
    type SponsoredQuoteResponse,
} from "@arkade-taxi/protocol";
import {
    ArkAddress,
    Transaction,
    type CSVMultisigTapscript,
    type ExtendedVirtualCoin,
} from "@arkade-os/sdk";
import { createHash } from "node:crypto";
import {
    buildSponsoredEnvelope,
    parseSponsoredEnvelope,
    type SponsoredBuildRequest,
} from "./arkade/sponsoredBuilder.js";
import { decodeLockupEnvelope } from "./arkade/psbt.js";
import { operatorFundingInput } from "./arkade/lockupBuilder.js";
import { LockupShapeError } from "./lockup.js";
import { verifySenderFunding } from "./arkade/senderFunding.js";
import { ReservationConflictError } from "@arkade-taxi/db";
import { assertFreshSafety, selectOperatorFunding } from "./arkade/inventory.js";
import { admissionError, ErrorCode, ServiceError } from "./errors.js";
import { validateLockupSubmission } from "./arkade/submit.js";
import type { QuoteDeps } from "./quotes.js";

export type SponsoredQuoteDeps = Omit<QuoteDeps, "lockupBuilder" | "lockupSubmitter"> & {
    sponsoredBuilder: SponsoredLockupBuilder;
};

export interface SponsoredLockupBuilder {
    buildUnsigned(req: SponsoredBuildRequest): Promise<Omit<FundingSnapshot, "batchExpiry">>;
}

export class ProductionSponsoredLockupBuilder implements SponsoredLockupBuilder {
    constructor(
        private readonly config: SponsoredQuoteDeps["config"],
        private readonly getUnroll: () => CSVMultisigTapscript.Type,
    ) {}
    async buildUnsigned(req: SponsoredBuildRequest) {
        const unroll = this.getUnroll();
        const unsignedSponsoredTx = buildSponsoredEnvelope(req, this.config, unroll);
        const parsed = parseSponsoredEnvelope(unsignedSponsoredTx, req, this.config, unroll);
        return {
            unsignedLockupTx: unsignedSponsoredTx,
            unsignedLockupId: parsed.unsignedTxId,
            operatorInputs: req.funding.inputs.map(({ txid, vout }) => ({ txid, vout })),
        };
    }
}

/** Builds a real unsigned graph with deterministic submission behavior for tests. */
export class FakeSponsoredLockupBuilder implements SponsoredLockupBuilder {
    constructor(
        private readonly config: SponsoredQuoteDeps["config"],
        private readonly unroll: CSVMultisigTapscript.Type,
    ) {}
    readonly built: SponsoredBuildRequest[] = [];
    unsignedTx = "cHNidP8BAA==";
    unsignedId = "";
    outpoint: Outpoint = { txid: "aa".repeat(32), vout: 1 };

    async buildUnsigned(req: SponsoredBuildRequest): Promise<Omit<FundingSnapshot, "batchExpiry">> {
        this.built.push(req);
        this.unsignedTx = buildSponsoredEnvelope(req, this.config, this.unroll);
        this.unsignedId = parseSponsoredEnvelope(
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
            const envelope = parseSponsoredEnvelope(
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
}

const badRequest = (message: string) => new ServiceError(ErrorCode.InvalidRequest, 400, message);

function decodeBody(
    body: unknown,
    config: SponsoredQuoteDeps["config"],
): {
    receiverAddress: string;
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
    const b = body as SponsoredQuoteRequestBody;
    if (!Array.isArray(b.senderInputs) || !b.senderInputs.length || b.senderInputs.length > 256)
        throw badRequest("senderInputs must contain 1 to 256 funding inputs");

    let decoded;
    try {
        decoded = {
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
    if (typeof b.receiverAddress !== "string" || !b.receiverAddress.length)
        throw badRequest("receiverAddress must be a non-empty Arkade address");
    if (b.fareId !== undefined && (typeof b.fareId !== "string" || !b.fareId.length))
        throw badRequest("invalid fareId");
    if (
        new Set(decoded.senderInputs.map((i) => `${i.txid}:${i.vout}`)).size !==
        decoded.senderInputs.length
    )
        throw badRequest("duplicate sender outpoint");
    if (decoded.senderInputs.reduce((sum, i) => sum + i.value, 0n) !== decoded.senderSats)
        throw badRequest("senderSats differs from funding inputs");
    if (decoded.senderKey.length !== 32)
        throw badRequest(`senderKey must be 32 bytes, got ${decoded.senderKey.length}`);

    let receiver: ArkAddress;
    try {
        receiver = ArkAddress.decode(b.receiverAddress);
    } catch {
        throw badRequest("receiverAddress is invalid");
    }
    if (receiver.encode() !== b.receiverAddress)
        throw badRequest("receiverAddress is not canonical");
    if (receiver.hrp !== config.addressHrp)
        throw badRequest("receiverAddress uses the wrong network");
    if (
        receiver.serverPubKey.length !== config.serverPubkey.length ||
        !receiver.serverPubKey.every((byte, index) => byte === config.serverPubkey[index])
    )
        throw badRequest("receiverAddress names the wrong Arkade server key");

    if (b.assetId === undefined)
        return {
            ...decoded,
            receiverAddress: b.receiverAddress,
            receiverKey: receiver.vtxoTaprootKey,
        };
    try {
        return {
            ...decoded,
            receiverAddress: b.receiverAddress,
            receiverKey: receiver.vtxoTaprootKey,
            assetId: assetIdFromWire(b.assetId),
        };
    } catch (e) {
        throw ServiceError.from(e);
    }
}

export async function createSponsoredQuote(
    deps: SponsoredQuoteDeps,
    body: unknown,
    assertReady?: () => void,
): Promise<SponsoredQuoteResponse> {
    if (!deps.runtime)
        throw new ServiceError("runtime_unsafe", 503, "runtime verification required");
    return deps.runtime.withAdmission((assertCurrent) => {
        assertCurrent();
        assertReady?.();
        return createAdmittedSponsoredQuote(
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

async function createAdmittedSponsoredQuote(
    deps: SponsoredQuoteDeps,
    body: unknown,
): Promise<SponsoredQuoteResponse> {
    assertFreshSafety(deps.runtime.safety(), deps.nowMs(), deps.config.reconcileIntervalMs);
    deps.reservations.expireQuotes(deps.now());
    for (let attempt = 0; attempt < 3; attempt++) {
        try {
            return await createReservedSponsoredQuote(deps, body);
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

async function createReservedSponsoredQuote(
    deps: SponsoredQuoteDeps,
    body: unknown,
): Promise<SponsoredQuoteResponse> {
    assertFreshSafety(deps.runtime.safety(), deps.nowMs(), deps.config.reconcileIntervalMs);
    const req = decodeBody(body, deps.config);
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
    const decision = admit(
        {
            receiverKey: req.receiverKey,
            senderKey: req.senderKey,
            senderSats: req.senderSats,
            ...(req.assetId ? { assetId: req.assetId } : {}),
            ...(req.assetUnits !== undefined ? { assetUnits: req.assetUnits } : {}),
            ...(req.fareId !== undefined ? { fareId: req.fareId } : {}),
        },
        policy,
        exposure,
        config.dust,
        config.vtxoMinAmount,
    );
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

    const params = {
        receiverKey: req.receiverKey,
        senderKey: req.senderKey,
        operatorKey: config.operatorKey,
        dust: config.dust,
        contribution: decision.topup,
        ...(req.assetId ? { assetId: req.assetId } : {}),
    };

    const id = deps.randomId();
    const buildRequest: SponsoredBuildRequest = {
        funding: structuredClone(selection),
        advanceId: id,
        params,
        receiverAddress: req.receiverAddress,
        fare: decision.fare,
        senderSats: req.senderSats,
        senderInputs: req.senderInputs,
        ...(req.assetUnits !== undefined ? { assetUnits: req.assetUnits } : {}),
    };
    const funding = await deps.sponsoredBuilder.buildUnsigned(structuredClone(buildRequest));

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

    const envelope = parseSponsoredEnvelope(
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
        kind: "sponsored",
        state: "quoted",
        receiverKey: params.receiverKey,
        senderKey: params.senderKey,
        operatorKey: params.operatorKey,
        dust: params.dust,
        topup: params.contribution,
        locktime: 0n,
        ...funding,
        batchExpiry: expiry,
        covenantAddress: req.receiverAddress,
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
    // No locktime is derived for a direct send, but the joint outputs still
    // inherit the minimum funding expiry: refuse sender funding that leaves
    // the receiver no headroom to move the payment.
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
    const headroom =
        expiry.kind === "height" ? config.minExpiryHeadroomBlocks : config.minExpiryHeadroomSeconds;
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
        expiry.value - latestClock < headroom
    )
        throw new ServiceError("runtime_unsafe", 503, "funding safety changed during construction");
    assertFreshSafety(deps.runtime.safety(), deps.nowMs(), deps.config.reconcileIntervalMs);
    deps.reservations.reserveQuote({
        advance,
        expectedPolicyRevision: revision,
        recoveryExecutionBudget: {
            kind: expiry.kind,
            value: 0n,
        },
        expectedReservedOutpoints: reserved,
    });

    return {
        transferId: id,
        params: sponsoredParamsToWire({
            receiverKey: params.receiverKey,
            senderKey: params.senderKey,
            operatorKey: params.operatorKey,
            dust: params.dust,
            contribution: params.contribution,
            ...(params.assetId ? { assetId: params.assetId } : {}),
        }),
        receiverAddress: req.receiverAddress,
        fare: fareToWire(decision.fare),
        expiresAt: advance.expiresAt,
        unsignedSponsoredTx: funding.unsignedLockupTx,
        commitment: {
            covenantOutputIndex: 0,
            senderInputIndexes: envelope.senderInputIndexes,
            operatorInputIndexes: envelope.operatorInputIndexes,
            unsignedTxId: envelope.unsignedTxId,
        },
    };
}
