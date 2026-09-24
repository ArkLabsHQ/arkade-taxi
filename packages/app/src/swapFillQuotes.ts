import {
    ArkAddress,
    CSVMultisigTapscript,
    Transaction,
    VtxoScript,
    scriptFromTapLeafScript,
    canSpendOffchain,
    type ExtendedVirtualCoin,
    type IWallet,
    type TapLeafScript,
    type VirtualCoin,
} from "@arkade-os/sdk";
import {
    decodeOffer,
    offerVtxoScript,
    ASSET_CARRIER_SATS,
    type FillFunding,
} from "@arkade-os/swap";
import { base64, hex } from "@scure/base";
import { ruleFor, type Advance } from "@arkade-taxi/core";
import type { Outpoint } from "@arkade-taxi/core";
import {
    bytesToHex,
    fareToWire,
    satsToWire,
    swapFillGraphFromWire,
    swapFillQuoteRequestFromWire,
    SWAP_FILL_TEMPLATE,
    type SwapFillQuoteRequest,
    type SwapFillQuoteResponse,
    type SwapFillStatusResponse,
} from "@arkade-taxi/protocol";
import type {
    ReceiveQuoteRepository,
    ReceiveQuote,
    ReservationRepository,
    SwapFill,
    SwapFillRepository,
} from "@arkade-taxi/db";
import {
    buildSwapFillGraph,
    jointGraphToStored,
    jointGraphToWire,
    storedGraphToJoint,
    SwapFillBuilderError,
    taxiAssetIdToSwapId,
    type SwapFillBuildRequest,
    type SwapFillWireScripts,
} from "./arkade/swapFillBuilder.js";
import {
    deriveJointInputs,
    deriveJointOutputs,
    JointGraphDerivationError,
} from "./arkade/jointGraphDerivation.js";
import { assertFreshSafety, selectOperatorFunding } from "./arkade/inventory.js";
import { assertOwnerServerLeaf, operatorFundingInput } from "./arkade/lockupBuilder.js";
import { normalizeExpiry, normalizeSigner, withinVtxoMaxAmount } from "./arkade/providers.js";
import {
    encodeJointFillSource,
    readFundingSource,
    type JointFillFundingSource,
} from "./arkade/fundingSource.js";
import { buildRecoveryIntent } from "./arkade/recovery.js";
import { unionReservedOutpoints } from "./arkade/reservedOutpoints.js";
import { admissionError, ErrorCode, ServiceError } from "./errors.js";
import type { AdvanceStore, QuoteDeps } from "./quotes.js";
import { verifyOfferFillPlan, type JointGraph } from "@arkade-taxi/client";
import { createHash } from "node:crypto";

export interface SwapFillStore extends Pick<
    SwapFillRepository,
    | "insert"
    | "get"
    | "getByOperation"
    | "exposureTotals"
    | "expireQuotes"
    | "listReservedOutpoints"
> {}

export interface SwapFillGraphBuilder {
    buildSwapFillGraph(req: SwapFillBuildRequest): Promise<JointGraph>;
}

export class ProductionSwapFillGraphBuilder implements SwapFillGraphBuilder {
    constructor(
        private readonly getWallet: () => IWallet,
        private readonly arkServerUrl: string,
    ) {}
    buildSwapFillGraph(req: SwapFillBuildRequest): Promise<JointGraph> {
        return buildSwapFillGraph(
            { wallet: this.getWallet(), arkServerUrl: this.arkServerUrl },
            req,
        );
    }
}

export interface DecodedOfferTerms {
    /** Derived from the offer's terms, never read from the indexer. */
    covenantTapTree: Uint8Array;
    covenantSpendLeaf: Uint8Array;
    makerProceedsScript: Uint8Array;
    wantAmount: bigint;
    wantAsset?: { txid: Uint8Array; groupIndex: number };
    offerAsset?: { txid: Uint8Array; groupIndex: number };
    makerPublicKey: Uint8Array;
    emulatorPubkey: Uint8Array;
}

export interface OfferCodec {
    decodeOffer(offerHex: string): DecodedOfferTerms;
}

export function createSwapOfferCodec(serverPubkey: Uint8Array): OfferCodec {
    return {
        decodeOffer(offerHex: string): DecodedOfferTerms {
            let offer;
            try {
                offer = decodeOffer(hex.decode(offerHex));
            } catch (cause) {
                throw new ServiceError(ErrorCode.InvalidRequest, 400, "swap offer is invalid", {
                    cause,
                });
            }
            // Internal byte order here; the swap string form is display order.
            const assetRef = (id: { txid: Uint8Array; groupIndex: number }) => ({
                txid: Uint8Array.from(id.txid).reverse(),
                groupIndex: id.groupIndex,
            });
            const covenant = offerVtxoScript(offer, serverPubkey);
            const fulfill = covenant.functionByName("fulfill");
            if (!fulfill)
                throw new ServiceError(
                    "swap_fill_offer_invalid",
                    400,
                    "swap offer covenant has no fulfill path",
                );
            return {
                covenantTapTree: covenant.encode(),
                covenantSpendLeaf: fulfill.leafScript,
                makerProceedsScript: offer.makerPkScript,
                wantAmount: offer.wantAmount,
                ...(offer.wantAsset ? { wantAsset: assetRef(offer.wantAsset) } : {}),
                ...(offer.offerAsset ? { offerAsset: assetRef(offer.offerAsset) } : {}),
                makerPublicKey: offer.makerPublicKey,
                emulatorPubkey: offer.emulatorPubkey,
            };
        },
    };
}

export interface SwapFillQuoteDeps {
    runtime: QuoteDeps["runtime"];
    policy: QuoteDeps["policy"];
    advances: Pick<AdvanceStore, "exposureTotals" | "get">;
    reservations: Pick<ReservationRepository, "listReservedOutpoints" | "expireQuotes">;
    swapFills: SwapFillStore;
    receiveQuotes?: Pick<
        ReceiveQuoteRepository,
        "listReservedOutpoints" | "exposureTotals" | "expireQuotes" | "get" | "bind"
    >;
    inventory: QuoteDeps["inventory"];
    senderInventory: QuoteDeps["senderInventory"];
    config: QuoteDeps["config"];
    now: QuoteDeps["now"];
    nowMs: QuoteDeps["nowMs"];
    randomId: QuoteDeps["randomId"];
    swapFillBuilder: SwapFillGraphBuilder;
    offerCodec?: OfferCodec;
    providerLimits?: () => Promise<{ vtxoMaxAmount: bigint }>;
    getServerUnroll?: () => CSVMultisigTapscript.Type;
}

const key = (o: Outpoint): string => `${o.txid}:${o.vout}`;

/** The caller's wall clock, not an input batch expiry: the two never mix. */
const assertDeadlineLive = (validUntil: number | undefined, now: number): void => {
    if (validUntil !== undefined && validUntil <= now)
        throw new ServiceError("swap_fill_deadline_expired", 409, "caller deadline has passed");
};

const termsOf = (t: {
    receiveQuoteId?: string;
    offerHex: string;
    solverInputs: SwapFill["solverInputs"];
    solverProceedsScript: Uint8Array;
    solverKeys: string[];
    contributionSats: bigint;
    maxFare: SwapFillQuoteRequest["maxFare"];
    fundingTxid?: string;
    fundingVout?: number;
    swapAddress?: string;
    validUntil?: number;
}): string =>
    JSON.stringify({
        receiveQuoteId: t.receiveQuoteId ?? null,
        offerHex: t.offerHex.toLowerCase(),
        solverInputs: t.solverInputs
            .map((i) => ({
                txid: i.txid,
                vout: i.vout,
                value: i.value.toString(10),
                assets: (i.assets ?? [])
                    .map((a) => ({
                        txid: bytesToHex(a.assetId.txid),
                        groupIndex: a.assetId.groupIndex,
                        amount: a.amount.toString(10),
                    }))
                    .sort((a, b) =>
                        a.txid < b.txid ? -1 : a.txid > b.txid ? 1 : a.groupIndex - b.groupIndex,
                    ),
            }))
            .sort((a, b) => (a.txid < b.txid ? -1 : a.txid > b.txid ? 1 : a.vout - b.vout)),
        proceeds: bytesToHex(t.solverProceedsScript),
        keys: [...t.solverKeys].sort(),
        contribution: t.contributionSats.toString(10),
        maxFare:
            t.maxFare.currency === "asset"
                ? {
                      currency: "asset",
                      txid: bytesToHex(t.maxFare.assetId.txid),
                      groupIndex: t.maxFare.assetId.groupIndex,
                      units: t.maxFare.units.toString(10),
                  }
                : { currency: "sats", units: t.maxFare.units.toString(10) },
        fundingTxid: t.fundingTxid ?? null,
        fundingVout: t.fundingVout ?? null,
        swapAddress: t.swapAddress ?? null,
        validUntil: t.validUntil ?? null,
    });

const storedTermsOf = (fill: SwapFill): string =>
    termsOf({
        ...(fill.receiveQuoteId !== undefined ? { receiveQuoteId: fill.receiveQuoteId } : {}),
        offerHex: fill.offerHex,
        solverInputs: fill.solverInputs,
        solverProceedsScript: fill.solverProceedsScript,
        solverKeys: fill.solverKeys,
        contributionSats: fill.contributionSats,
        maxFare: fill.maxFare,
        ...(fill.offerTxid !== undefined ? { fundingTxid: fill.offerTxid } : {}),
        ...(fill.offerVout !== undefined ? { fundingVout: fill.offerVout } : {}),
        ...(fill.swapAddress !== undefined ? { swapAddress: fill.swapAddress } : {}),
        ...(fill.validUntil !== undefined ? { validUntil: fill.validUntil } : {}),
    });

function fillToResponse(fill: SwapFill, scripts: SwapFillWireScripts): SwapFillQuoteResponse {
    return {
        fillId: fill.id,
        operationId: fill.operationId,
        expiresAt: fill.expiresAt,
        template: SWAP_FILL_TEMPLATE,
        contributionSats: satsToWire(fill.contributionSats),
        fare: fareToWire(fill.fare),
        graph: toWireGraph(storedGraphToJoint(fill.graph), {
            ...scripts,
            expectSatsFare:
                fill.receiveQuoteId === undefined &&
                fill.fare.currency === "sats" &&
                fill.fare.units > 0n,
        }),
    };
}

export async function createSwapFillQuote(
    deps: SwapFillQuoteDeps,
    body: unknown,
    assertReady?: () => void,
): Promise<SwapFillQuoteResponse> {
    if (!deps.runtime)
        throw new ServiceError("runtime_unsafe", 503, "runtime verification required");
    return deps.runtime.withAdmission((assertCurrent) => {
        assertCurrent();
        assertReady?.();
        return createAdmittedSwapFillQuote(
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

async function createAdmittedSwapFillQuote(
    deps: SwapFillQuoteDeps,
    body: unknown,
): Promise<SwapFillQuoteResponse> {
    assertFreshSafety(deps.runtime.safety(), deps.nowMs(), deps.config.reconcileIntervalMs);
    const now = deps.now();
    deps.reservations.expireQuotes(now);
    deps.swapFills.expireQuotes(now);
    deps.receiveQuotes?.expireQuotes(now);
    let req: SwapFillQuoteRequest;
    try {
        req = swapFillQuoteRequestFromWire(body);
    } catch (e) {
        throw ServiceError.from(e);
    }
    const existing = deps.swapFills.getByOperation(req.operationId);
    const { policy, revision } = deps.policy.getSnapshot();
    const { config } = deps;
    const taxiScript = new ArkAddress(config.serverPubkey, config.operatorKey, config.addressHrp)
        .pkScript;
    const offerOf = (offerHex: string) =>
        (deps.offerCodec ?? createSwapOfferCodec(config.serverPubkey)).decodeOffer(offerHex);
    if (existing) {
        if (storedTermsOf(existing) !== termsOf(req))
            throw new ServiceError(
                "operation_conflict",
                409,
                "operation id was already quoted with different terms",
            );
        return fillToResponse(existing, {
            receiverScript: offerOf(existing.offerHex).makerProceedsScript,
            solverScript: existing.solverProceedsScript,
            sponsorScript: existing.sponsorScript,
        });
    }
    assertDeadlineLive(req.validUntil, now);
    let receiveQuote: ReceiveQuote | undefined;
    if (req.contributionSats > 0n && deps.receiveQuotes) {
        if (!req.receiveQuoteId)
            throw new ServiceError(
                "receive_quote_required",
                400,
                "receiveQuoteId is required for an operator-sponsored joint fill",
            );
        receiveQuote = deps.receiveQuotes.get(req.receiveQuoteId);
        if (
            !receiveQuote ||
            receiveQuote.state !== "quoted" ||
            receiveQuote.expiresAt <= now ||
            receiveQuote.policyRevision !== revision
        )
            throw new ServiceError(
                "receive_quote_unavailable",
                409,
                "receive quote is missing, expired, bound, or stale",
            );
    }
    if (policy.paused) throw admissionError("paused");
    if (req.fundingTxid === undefined || req.fundingVout === undefined)
        throw new ServiceError(
            "swap_fill_funding_outpoint_required",
            400,
            "fundingTxid and fundingVout must bind the exact offer outpoint",
        );
    const fundingOutpoint = { txid: req.fundingTxid, vout: req.fundingVout };
    if (req.swapAddress !== undefined) {
        let parsed: { hrp: string };
        try {
            parsed = ArkAddress.decode(req.swapAddress);
        } catch (cause) {
            throw new ServiceError(ErrorCode.InvalidRequest, 400, "swapAddress is invalid", {
                cause,
            });
        }
        if (parsed.hrp !== config.addressHrp)
            throw new ServiceError("swap_fill_swap_address_invalid", 400, "swapAddress is invalid");
    }
    const offer = offerOf(req.offerHex);
    if (receiveQuote) {
        let covenantScript: Uint8Array;
        try {
            covenantScript = ArkAddress.decode(receiveQuote.covenantAddress).pkScript;
        } catch (cause) {
            throw new ServiceError(
                "receive_quote_invalid",
                500,
                "receive quote covenant is invalid",
                {
                    cause,
                },
            );
        }
        const wantedAsset = offer.wantAsset;
        if (
            bytesToHex(offer.makerPublicKey) !== receiveQuote.makerPublicKey ||
            bytesToHex(offer.makerProceedsScript) !== bytesToHex(covenantScript) ||
            !wantedAsset ||
            bytesToHex(wantedAsset.txid) !== bytesToHex(receiveQuote.params.assetId.txid) ||
            wantedAsset.groupIndex !== receiveQuote.params.assetId.groupIndex ||
            offer.wantAmount <= 0n ||
            req.contributionSats !== receiveQuote.loanSats ||
            req.maxFare.currency !== "sats" ||
            req.maxFare.units < receiveQuote.fare.units
        )
            throw new ServiceError(
                "receive_quote_mismatch",
                400,
                "offer, contribution, or fare cap differs from the receive quote",
            );
        if (
            receiveQuote.payer === "receiver" &&
            receiveQuote.receiverFare?.currency === "asset" &&
            receiveQuote.receiverFare.units >= offer.wantAmount
        )
            throw new ServiceError(
                "fare_exceeds_delivery",
                409,
                "receiver fare is not smaller than the delivered units",
            );
    }
    if (
        offer.emulatorPubkey.length !== config.emulatorPubkey.length ||
        !offer.emulatorPubkey.every((byte, i) => byte === config.emulatorPubkey[i])
    )
        throw new ServiceError(
            "swap_fill_offer_identity_mismatch",
            400,
            "swap offer names a different emulator key",
        );
    if (offer.wantAmount <= 0n)
        throw new ServiceError("swap_fill_offer_invalid", 400, "swap offer want must be positive");
    const deposit = await observedCoin(
        deps.senderInventory,
        fundingOutpoint,
        "swap_fill_deposit_unknown",
        "swap offer deposit is not served by the indexer",
    );
    if (deposit.isSpent)
        throw new ServiceError("swap_fill_deposit_spent", 400, "swap offer deposit is spent");
    const depositSpend = checkedTaprootSpend(
        { tapTree: offer.covenantTapTree, spendLeaf: offer.covenantSpendLeaf },
        deposit.script,
        {
            invalid: "swap_fill_deposit_taproot_invalid",
            mismatch: "swap_fill_deposit_mismatch",
            leaf: "swap_fill_deposit_leaf_unknown",
        },
        "swap offer deposit",
        "the offer covenant",
    );
    if (offer.offerAsset) {
        const wanted = taxiAssetIdToSwapId(offer.offerAsset);
        const held = (deposit.assets ?? []).find((a) => a.assetId === wanted);
        if (!held || held.amount <= 0n)
            throw new ServiceError(
                "swap_fill_deposit_mismatch",
                400,
                "swap offer deposit does not carry the offered asset",
            );
    } else if (BigInt(deposit.value) <= 0n)
        throw new ServiceError(
            "swap_fill_deposit_mismatch",
            400,
            "swap offer deposit has no value",
        );
    if (req.solverInputs.some((i) => key(i) === key(fundingOutpoint)))
        throw new ServiceError(
            "swap_fill_solver_deposit_conflict",
            400,
            "solver funding must not spend the offer deposit",
        );
    const {
        fund: solverFund,
        coins: solverCoins,
        spends: solverSpends,
    } = await enrichSolverFund(deps, req, offer);
    const bitcoinRule = ruleFor(policy.assetRules, undefined);
    if (!bitcoinRule) throw admissionError("asset_not_served");
    if (!bitcoinRule.enabled) throw admissionError("asset_disabled");
    const contributionCap = bitcoinRule.maxTopupSats ?? policy.maxPerPaymentTopupSats;
    if (req.contributionSats > contributionCap)
        throw admissionError("topup_exceeds_max_per_payment");
    const advancesExposure = deps.advances.exposureTotals();
    const fillsExposure = deps.swapFills.exposureTotals();
    const receiveExposure = deps.receiveQuotes?.exposureTotals() ?? {
        outstandingSats: 0n,
        activeCount: 0,
    };
    if (
        advancesExposure.outstandingSats +
            fillsExposure.outstandingSats +
            receiveExposure.outstandingSats +
            (receiveQuote ? 0n : req.contributionSats) >
        policy.maxOutstandingSats
    )
        throw admissionError("exceeds_max_outstanding");
    if (
        advancesExposure.lockedCount +
            fillsExposure.activeCount +
            receiveExposure.activeCount +
            (receiveQuote ? 0 : 1) >
        policy.maxConcurrentAdvances
    )
        throw admissionError("max_concurrent_advances");
    let spendable;
    let intentLocks;
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
    const reserved = unionReservedOutpoints(deps.reservations, deps.swapFills, deps.receiveQuotes);
    let selection: ReturnType<typeof selectOperatorFunding>;
    try {
        if (receiveQuote) {
            const byKey = new Map(spendable.map((coin) => [key(coin), coin]));
            const inputs = receiveQuote.operatorInputs.map((expected) => {
                const coin = byKey.get(key(expected));
                if (!coin || !sameFundingSnapshot(operatorFundingInput(coin), expected))
                    throw new ServiceError(
                        "receive_quote_funding_changed",
                        409,
                        "receive quote operator funding changed or is unavailable",
                    );
                return coin;
            });
            if (intentLocks.some((locked) => inputs.some((coin) => key(coin) === key(locked))))
                throw new ServiceError(
                    "receive_quote_funding_changed",
                    409,
                    "receive quote operator funding is locked by another intent",
                );
            selection = {
                inputs,
                totalValue: inputs.reduce((sum, coin) => sum + BigInt(coin.value), 0n),
                batchExpiry: { ...receiveQuote.batchExpiry },
            };
        } else {
            selection = selectOperatorFunding({
                spendable,
                reserved: [...reserved, ...intentLocks],
                requiredSats: req.contributionSats,
                safety: deps.runtime.safety(),
                nowMs: deps.nowMs(),
                maxSnapshotAgeMs: config.reconcileIntervalMs,
                minExpiryHeadroomBlocks: config.minExpiryHeadroomBlocks,
                minExpiryHeadroomSeconds: config.minExpiryHeadroomSeconds,
                minReserveSats: config.operatorMinReserveSats,
                dustSats: config.dust,
            });
        }
    } catch (error) {
        if (
            error instanceof ServiceError &&
            error.code === "operator_inventory_insufficient" &&
            spendable.some(
                (c) => !reserved.some((r) => key(r) === key(c)) && (c.assets?.length ?? 0) > 0,
            )
        )
            throw new ServiceError(
                "sponsor_assets_unsupported",
                503,
                "operator sponsor inventory carries assets; Taxi sponsor inputs are bitcoin-only",
                { cause: error },
            );
        throw error;
    }
    const taxiInputs = selection.inputs.map(({ txid, vout }) => ({ txid, vout }));
    const taxiTotal = selection.inputs.reduce((sum, c) => sum + BigInt(c.value), 0n);
    if (taxiTotal < req.contributionSats)
        throw new ServiceError("runtime_unsafe", 503, "sponsor selection covers no contribution");
    for (const [i, coin] of selection.inputs.entries())
        if ((coin.assets?.length ?? 0) > 0)
            throw new ServiceError(
                "sponsor_assets_unsupported",
                503,
                `sponsor input ${i} carries assets; Taxi sponsor inputs are bitcoin-only`,
            );
    const actualFare = receiveQuote?.fare ?? req.maxFare;
    const sponsorFare =
        actualFare.units > 0n
            ? actualFare.currency === "asset"
                ? { assetId: actualFare.assetId, amount: actualFare.units, script: taxiScript }
                : { script: taxiScript, sats: actualFare.units }
            : undefined;
    let graph: JointGraph;
    try {
        graph = await deps.swapFillBuilder.buildSwapFillGraph({
            offerHex: req.offerHex,
            solverFund,
            payoutScript: req.solverProceedsScript,
            fundingOutpoint,
            fundingTxid: req.fundingTxid,
            ...(req.swapAddress !== undefined ? { swapAddress: req.swapAddress } : {}),
            sponsor: {
                coins: selection.inputs,
                netContributionSats: req.contributionSats,
                changeScript: taxiScript,
                ...(sponsorFare ? { fare: sponsorFare } : {}),
                // The library refuses the flag without a sats fare paid to the change script.
                ...(receiveQuote && sponsorFare && !("assetId" in sponsorFare)
                    ? { combineSatsFareWithChange: true }
                    : {}),
            },
        });
    } catch (cause) {
        if (cause instanceof ServiceError) throw cause;
        throw new ServiceError("runtime_unsafe", 503, "swap fill graph build failed", {
            cause,
        });
    }
    const wire = toWireGraph(graph, {
        receiverScript: offer.makerProceedsScript,
        solverScript: req.solverProceedsScript,
        sponsorScript: taxiScript,
        expectSatsFare: !receiveQuote && req.maxFare.currency === "sats" && req.maxFare.units > 0n,
    });
    const domain = swapFillGraphFromWire(wire);
    assertTrustedGraph({
        graph,
        req,
        offer,
        fundingOutpoint,
        taxiInputs,
        taxiTotal,
        taxiScript,
        inputAssets: [
            ...(deposit.assets ?? []).map((a) => ({
                assetId: a.assetId,
                amount: BigInt(a.amount),
            })),
            ...solverFund.flatMap((c) =>
                (c.assets ?? []).map((a) => ({ assetId: a.assetId, amount: BigInt(a.amount) })),
            ),
        ],
        limits: await optionalLimits(deps),
        dust: config.dust,
        vtxoMinAmount: config.vtxoMinAmount,
        actualFare,
    });
    const expiries = [deposit, ...solverCoins, ...selection.inputs].map((coin, index) => {
        try {
            return normalizeExpiry(coin);
        } catch (cause) {
            throw new ServiceError(
                "swap_fill_expiry_unknown",
                400,
                `swap fill input ${index} has unknown or ambiguous expiry`,
                { cause },
            );
        }
    });
    if (
        receiveQuote &&
        expiries.some(
            (expiry) =>
                expiry.kind !== receiveQuote!.inputExpiryFloor.kind ||
                expiry.value < receiveQuote!.inputExpiryFloor.value,
        )
    )
        throw new ServiceError(
            "receive_quote_expiry_mismatch",
            409,
            "swap fill input expiry is below the receive quote floor",
        );
    await reverifyFreshness(deps, req, fundingOutpoint, selection, intentLocks, receiveQuote);
    if (deps.policy.getSnapshot().revision !== revision)
        throw new ServiceError("policy_changed", 409, "policy changed during construction");
    assertFreshSafety(deps.runtime.safety(), deps.nowMs(), deps.config.reconcileIntervalMs);
    // Building the graph took awaits; the caller's window may have closed since.
    assertDeadlineLive(req.validUntil, deps.now());
    const quotedExpiry = receiveQuote ? receiveQuote.expiresAt : now + policy.quoteTtlSeconds;
    const expiresAt =
        req.validUntil !== undefined && req.validUntil < quotedExpiry
            ? req.validUntil
            : quotedExpiry;
    const fill: SwapFill = {
        id: deps.randomId(),
        ...(receiveQuote ? { receiveQuoteId: receiveQuote.id } : {}),
        operationId: req.operationId,
        state: "quoted",
        offerHex: req.offerHex,
        offerTxid: req.fundingTxid,
        offerVout: req.fundingVout,
        ...(req.swapAddress !== undefined ? { swapAddress: req.swapAddress } : {}),
        solverInputs: req.solverInputs,
        solverProceedsScript: req.solverProceedsScript,
        solverKeys: [...req.solverKeys],
        taxiInputs,
        contributionSats: req.contributionSats,
        sponsorScript: taxiScript,
        fare: receiveQuote ? receiveQuote.fare : fareOf(domain),
        maxFare: req.maxFare,
        graph: jointGraphToStored(graph),
        graphId: domain.graphId,
        submitInvoked: false,
        attempts: 0,
        createdAt: now,
        updatedAt: now,
        expiresAt,
        ...(req.validUntil !== undefined ? { validUntil: req.validUntil } : {}),
    };
    try {
        if (receiveQuote) {
            if (!deps.getServerUnroll)
                throw new ServiceError(
                    "runtime_unsafe",
                    503,
                    "server unroll data is unavailable for joint recovery",
                );
            const batchExpiry = expiries.reduce((minimum, expiry) =>
                expiry.value < minimum.value ? expiry : minimum,
            );
            const inputs = [deposit, ...solverCoins, ...selection.inputs];
            const spends = [
                depositSpend,
                ...solverSpends,
                ...selection.inputs.map((coin) => ({
                    tapTree: coin.tapTree,
                    spendLeaf: scriptFromTapLeafScript(
                        coin.forfeitTapLeafScript ?? coin.intentTapLeafScript,
                    ),
                })),
            ];
            const roles = [
                "offer-covenant",
                ...solverCoins.map(() => "solver" as const),
                ...selection.inputs.map(() => "sponsor" as const),
            ] as const;
            const operatorPayouts = deriveJointOutputs(graph)
                .filter(
                    (output) =>
                        output.script.every((byte, index) => byte === taxiScript[index]) &&
                        output.script.length === taxiScript.length &&
                        output.assets.length === 0,
                )
                .map((output) => ({
                    vout: output.vout,
                    sats: output.sats.toString(10),
                    fareSats: receiveQuote!.fare.units.toString(10),
                }));
            const tx = Transaction.fromPSBT(base64.decode(graph.arkTx));
            const source: JointFillFundingSource = {
                tag: "joint-fill",
                version: 1,
                receiveQuoteId: receiveQuote.id,
                fillId: fill.id,
                operationId: fill.operationId,
                offerHex: fill.offerHex,
                offerOutpoint: fundingOutpoint,
                graph,
                covenantOutputIndex: 0,
                covenantSats: receiveQuote.params.dust.toString(10),
                assetId: {
                    txid: bytesToHex(receiveQuote.params.assetId.txid),
                    groupIndex: receiveQuote.params.assetId.groupIndex,
                },
                assetUnits: offer.wantAmount.toString(10),
                inputExpiryFloor: {
                    kind: receiveQuote.inputExpiryFloor.kind,
                    value: receiveQuote.inputExpiryFloor.value.toString(10),
                },
                inputs: inputs.map((coin, index) => ({
                    role: roles[index]!,
                    txid: coin.txid,
                    vout: coin.vout,
                    value: BigInt(coin.value).toString(10),
                    script: coin.script.toLowerCase(),
                    tapTree: bytesToHex(spends[index]!.tapTree),
                    spendLeaf: bytesToHex(spends[index]!.spendLeaf),
                    assets: (coin.assets ?? []).map((asset) => ({
                        assetId: asset.assetId,
                        amount: BigInt(asset.amount).toString(10),
                    })),
                    expiry: {
                        kind: expiries[index]!.kind,
                        value: expiries[index]!.value.toString(10),
                    },
                })),
                serverUnrollScript: hex.encode(deps.getServerUnroll().script),
                operatorScript: bytesToHex(taxiScript),
                operatorPayouts,
                recoveryPreflight: {
                    digest: createHash("sha256")
                        .update(
                            JSON.stringify({
                                arkTx: graph.arkTx,
                                checkpoints: graph.checkpoints,
                            }),
                        )
                        .digest("hex"),
                    expectedTxid: tx.id.toLowerCase(),
                    arkTx: graph.arkTx,
                    checkpoints: [...graph.checkpoints],
                },
            };
            const advance: Advance = {
                id: receiveQuote.id,
                state: "locking",
                ...receiveQuote.params,
                assetUnits: offer.wantAmount,
                covenantAddress: receiveQuote.covenantAddress,
                fare: receiveQuote.fare,
                createdAt: now,
                updatedAt: now,
                expiresAt: fill.expiresAt,
                batchExpiry,
                recoveryLocktime: receiveQuote.recoveryLocktime,
                operatorInputs: selection.inputs.map(({ txid, vout }) => ({ txid, vout })),
                unsignedLockupTx: encodeJointFillSource(source),
                unsignedLockupId: graph.graphId,
            };
            source.recoveryPreflight = buildRecoveryIntent(
                { ...advance, outpoint: { txid: tx.id.toLowerCase(), vout: 0 } },
                config,
            );
            advance.unsignedLockupTx = encodeJointFillSource(source);
            deps.receiveQuotes!.bind({
                quoteId: receiveQuote.id,
                fill,
                advance,
                expectedPolicyRevision: revision,
                now,
            });
        } else deps.swapFills.insert(fill, revision);
    } catch (cause) {
        const raced = deps.swapFills.getByOperation(req.operationId);
        if (!raced) throw cause;
        if (storedTermsOf(raced) !== termsOf(req))
            throw new ServiceError(
                "operation_conflict",
                409,
                "operation id was already quoted with different terms",
            );
        return fillToResponse(raced, {
            receiverScript: offer.makerProceedsScript,
            solverScript: raced.solverProceedsScript,
            sponsorScript: raced.sponsorScript,
        });
    }
    return fillToResponse(fill, {
        receiverScript: offer.makerProceedsScript,
        solverScript: req.solverProceedsScript,
        sponsorScript: taxiScript,
    });
}

interface TaprootSpend {
    tapTree: Uint8Array;
    spendLeaf: Uint8Array;
    tapLeafScript: TapLeafScript;
}

/** Build data for the graph, not trust. Checking it against the INDEXED script refuses
 * a wrong tree at quote time instead of producing a graph no one can submit. */
function checkedTaprootSpend(
    given: { tapTree: Uint8Array; spendLeaf: Uint8Array },
    indexedScript: string,
    codes: { invalid: string; mismatch: string; leaf: string },
    subject: string,
    source: string,
): TaprootSpend {
    let tree: VtxoScript;
    try {
        tree = VtxoScript.decode(given.tapTree);
    } catch (cause) {
        throw new ServiceError(codes.invalid, 400, `${subject} taproot tree is malformed`, {
            cause,
        });
    }
    if (bytesToHex(tree.pkScript) !== indexedScript.toLowerCase())
        throw new ServiceError(codes.mismatch, 400, `${subject} script differs from ${source}`);
    let tapLeafScript: TapLeafScript;
    try {
        tapLeafScript = tree.findLeaf(bytesToHex(given.spendLeaf));
    } catch (cause) {
        throw new ServiceError(
            codes.leaf,
            400,
            `${subject} spend leaf is not in its taproot tree`,
            {
                cause,
            },
        );
    }
    return { tapTree: tree.encode(), spendLeaf: given.spendLeaf, tapLeafScript };
}

/** toArkInput's rule for a client-supplied spend: a CSV exit leaf would reserve
 * sponsor coins for a graph arkd then refuses. */
const isOwnerServerLeaf = (leaf: Uint8Array, owner: Uint8Array, server: Uint8Array): boolean => {
    try {
        assertOwnerServerLeaf(leaf, owner, server);
        return true;
    } catch {
        return false;
    }
};

async function observedCoin(
    indexer: SwapFillQuoteDeps["senderInventory"],
    outpoint: Outpoint,
    code: string,
    message: string,
): Promise<VirtualCoin> {
    let response;
    try {
        response = await indexer.getVtxos({ outpoints: [outpoint] });
    } catch (cause) {
        throw new ServiceError("runtime_unsafe", 503, "funding verification unavailable", {
            cause,
        });
    }
    const matches = response.vtxos.filter(
        (coin) => coin.txid === outpoint.txid && coin.vout === outpoint.vout,
    );
    if (matches.length !== 1) throw new ServiceError(code, 400, message);
    return matches[0]!;
}

async function enrichSolverFund(
    deps: SwapFillQuoteDeps,
    req: SwapFillQuoteRequest,
    offer: DecodedOfferTerms,
): Promise<{ fund: FillFunding[]; coins: VirtualCoin[]; spends: TaprootSpend[] }> {
    const safety = deps.runtime.safety();
    const clock = {
        height: Number(safety.chainHeight),
        timestamp: new Date(Number(safety.chainTime) * 1000),
    };
    let response;
    try {
        response = await deps.senderInventory.getVtxos({
            outpoints: req.solverInputs.map(({ txid, vout }) => ({ txid, vout })),
        });
    } catch (cause) {
        throw new ServiceError("runtime_unsafe", 503, "solver funding verification unavailable", {
            cause,
        });
    }
    const byKey = new Map(response.vtxos.map((c) => [key(c), c]));
    const solverOwners = req.solverKeys.map((solverKey) => hex.decode(normalizeSigner(solverKey)));
    const server = deps.config.serverPubkey;
    const fund: FillFunding[] = [];
    const coins: VirtualCoin[] = [];
    const spends: TaprootSpend[] = [];
    for (const [i, input] of req.solverInputs.entries()) {
        const coin = byKey.get(key(input));
        if (!coin || coin.isSpent)
            throw new ServiceError(
                "swap_fill_solver_unknown",
                400,
                `solver input ${i} is not served by the indexer`,
            );
        if (BigInt(coin.value) !== input.value)
            throw new ServiceError(
                "swap_fill_solver_mismatch",
                400,
                `solver input ${i} differs from indexed funding`,
            );
        const spend = checkedTaprootSpend(
            input,
            coin.script,
            {
                invalid: "swap_fill_solver_taproot_invalid",
                mismatch: "swap_fill_solver_taproot_mismatch",
                leaf: "swap_fill_solver_leaf_unknown",
            },
            `solver input ${i}`,
            "its taproot tree",
        );
        if (!solverOwners.some((owner) => isOwnerServerLeaf(spend.spendLeaf, owner, server)))
            throw new ServiceError(
                "swap_fill_solver_leaf_not_collaborative",
                400,
                `solver input ${i} spend leaf must require exactly a solver key and the Arkade Service`,
            );
        const actual = new Map((coin.assets ?? []).map((a) => [a.assetId, a.amount]));
        const claimed = new Map(
            (input.assets ?? []).map((a) => [taxiAssetIdToSwapId(a.assetId), a.amount]),
        );
        if (
            actual.size !== (coin.assets ?? []).length ||
            actual.size !== claimed.size ||
            [...actual].some(([id, amount]) => claimed.get(id) !== amount)
        )
            throw new ServiceError(
                "swap_fill_solver_mismatch",
                400,
                `solver input ${i} assets differ from indexed funding`,
            );
        if (!canSpendOffchain(coin, clock))
            throw new ServiceError(
                "swap_fill_solver_mismatch",
                400,
                `solver input ${i} is not spendable`,
            );
        fund.push({
            txid: coin.txid,
            vout: coin.vout,
            value: coin.value,
            tapTree: spend.tapTree,
            tapLeafScript: spend.tapLeafScript,
            ...(coin.assets?.length ? { assets: [...coin.assets] } : {}),
        } as FillFunding);
        coins.push(coin);
        spends.push(spend);
    }
    const totals = solverTotals(fund);
    if (offer.wantAsset) {
        const held = totals.assets.get(taxiAssetIdToSwapId(offer.wantAsset)) ?? 0n;
        if (held < offer.wantAmount)
            throw new ServiceError(
                "swap_fill_solver_insufficient",
                400,
                "solver funding does not cover the wanted asset amount",
            );
    } else if (totals.sats < offer.wantAmount)
        throw new ServiceError(
            "swap_fill_solver_insufficient",
            400,
            "solver funding does not cover the wanted sats amount",
        );
    return { fund, coins, spends };
}

function solverTotals(fund: FillFunding[]): { sats: bigint; assets: Map<string, bigint> } {
    let sats = 0n;
    const assets = new Map<string, bigint>();
    for (const coin of fund) {
        sats += BigInt(coin.value);
        for (const a of coin.assets ?? [])
            assets.set(a.assetId, (assets.get(a.assetId) ?? 0n) + BigInt(a.amount));
    }
    return { sats, assets };
}

function toWireGraph(graph: JointGraph, scripts: SwapFillWireScripts) {
    try {
        return jointGraphToWire(graph, scripts);
    } catch (cause) {
        if (cause instanceof SwapFillBuilderError)
            throw new ServiceError("swap_fill_graph_invalid", 503, cause.message, { cause });
        throw cause;
    }
}

async function optionalLimits(
    deps: SwapFillQuoteDeps,
): Promise<{ vtxoMaxAmount: bigint } | undefined> {
    if (!deps.providerLimits) return undefined;
    try {
        return await deps.providerLimits();
    } catch (cause) {
        throw new ServiceError("runtime_unsafe", 503, "provider limits unavailable", { cause });
    }
}

function assertTrustedGraph(args: {
    graph: JointGraph;
    req: SwapFillQuoteRequest;
    offer: DecodedOfferTerms;
    fundingOutpoint: Outpoint;
    taxiInputs: Outpoint[];
    taxiTotal: bigint;
    taxiScript: Uint8Array;
    inputAssets: { assetId: string; amount: bigint }[];
    limits: { vtxoMaxAmount: bigint } | undefined;
    dust: bigint;
    vtxoMinAmount: bigint;
    actualFare: SwapFill["fare"];
}): void {
    const { graph, req, offer } = args;
    const mismatch = (detail: string): never => {
        throw new ServiceError("swap_fill_graph_mismatch", 503, `fill graph ${detail}`);
    };
    // Integrity only; every binding below is checked against Taxi's own inputs.
    if (!verifyOfferFillPlan(graph))
        throw new ServiceError(
            "swap_fill_graph_integrity",
            503,
            "fill graph failed integrity check",
        );
    const expectedInputs = [
        `offer-covenant:${args.fundingOutpoint.txid.toLowerCase()}:${args.fundingOutpoint.vout}`,
        ...req.solverInputs.map((i) => `solver:${i.txid.toLowerCase()}:${i.vout}`),
        ...args.taxiInputs.map((i) => `sponsor:${i.txid.toLowerCase()}:${i.vout}`),
    ].sort();
    let derivedInputs;
    try {
        derivedInputs = deriveJointInputs(graph);
    } catch (cause) {
        if (cause instanceof JointGraphDerivationError) mismatch(cause.message);
        throw cause;
    }
    const actualInputs = derivedInputs
        .map(
            (input) =>
                `${input.owner === null ? "offer-covenant" : input.owner}:${input.txid.toLowerCase()}:${input.vout}`,
        )
        .sort();
    if (
        expectedInputs.length !== actualInputs.length ||
        expectedInputs.some((k, i) => k !== actualInputs[i])
    )
        mismatch("inputs differ from the reserved funding selection");
    const sameScript = (a: Uint8Array, b: Uint8Array): boolean =>
        a.length === b.length && a.every((byte, i) => byte === b[i]);
    let derivedOutputs;
    try {
        derivedOutputs = deriveJointOutputs(graph);
    } catch (cause) {
        if (cause instanceof JointGraphDerivationError) mismatch(cause.message);
        throw cause;
    }
    if (!derivedOutputs.length) mismatch("graph carries no outputs");
    // The covenant pays the maker at output 0, so the receiver is positional;
    // every other output is Taxi's sponsor leg or the solver's proceeds.
    const [receiver, ...rest] = derivedOutputs;
    if (receiver!.vout !== 0 || !sameScript(receiver!.script, offer.makerProceedsScript))
        mismatch("receiver output differs from the offer want");
    const change = args.taxiTotal - req.contributionSats;
    let changeSum = 0n;
    let fareSeen: { assetId: string; units: bigint } | undefined;
    let receiverSats = receiver!.sats;
    const receiverAssets = new Map<string, bigint>();
    const outputAssets = new Map<string, bigint>();
    for (const a of receiver!.assets) {
        receiverAssets.set(a.assetId, (receiverAssets.get(a.assetId) ?? 0n) + a.units);
    }
    const checkOutput = (sats: bigint, assets: readonly { assetId: string; units: bigint }[]) => {
        if (sats < 0n) mismatch("output carries negative sats");
        if (args.limits && !withinVtxoMaxAmount(sats, args.limits.vtxoMaxAmount))
            throw new ServiceError(
                "swap_fill_output_limit_exceeded",
                409,
                "fill graph output exceeds the provider maximum",
            );
        if (sats > 0n && sats < (assets.length ? args.vtxoMinAmount : args.dust))
            mismatch("output is below the spendable floor");
        for (const a of assets)
            outputAssets.set(a.assetId, (outputAssets.get(a.assetId) ?? 0n) + a.units);
    };
    checkOutput(receiver!.sats, receiver!.assets);
    for (const output of rest) {
        checkOutput(output.sats, output.assets);
        if (sameScript(output.script, args.taxiScript)) {
            if (!output.assets.length) {
                changeSum += output.sats;
                continue;
            }
            if (fareSeen) mismatch("fill carries two fares");
            fareSeen = {
                assetId: output.assets[0]?.assetId ?? "",
                units: output.assets.reduce((s, a) => s + a.units, 0n),
            };
        } else if (sameScript(output.script, req.solverProceedsScript)) {
            continue;
        } else mismatch("output pays an unknown script");
    }
    // No minting: every input asset must be accounted for in the outputs.
    const held = new Map<string, bigint>();
    for (const { assetId, amount } of args.inputAssets)
        held.set(assetId, (held.get(assetId) ?? 0n) + amount);
    for (const [id, amount] of held)
        if ((outputAssets.get(id) ?? 0n) !== amount)
            mismatch(
                `asset ${id} is not conserved: inputs ${amount}, outputs ${outputAssets.get(id) ?? 0n}`,
            );
    for (const [id] of outputAssets)
        if (!held.has(id)) mismatch(`asset ${id} appears from nowhere`);
    if (offer.wantAsset) {
        if (receiverSats !== ASSET_CARRIER_SATS) mismatch("receiver carrier differs");
        const got = receiverAssets.get(taxiAssetIdToSwapId(offer.wantAsset)) ?? 0n;
        if (got !== offer.wantAmount) mismatch("receiver asset amount differs from the offer want");
    } else if (receiverSats !== offer.wantAmount)
        mismatch("receiver sats differ from the offer want");
    if (args.actualFare.currency === "asset" && args.actualFare.units > 0n) {
        if (fareSeen === undefined)
            throw new ServiceError(
                "swap_fill_graph_mismatch",
                503,
                "fill graph fare output is missing",
            );
        const allowed = taxiAssetIdToSwapId(args.actualFare.assetId);
        if (fareSeen.assetId !== allowed) mismatch("fare asset differs from maxFare");
        if (fareSeen.units !== args.actualFare.units) mismatch("fare units differ from quote");
        if (!args.inputAssets.some((a) => a.assetId === allowed && a.amount >= fareSeen.units))
            throw new ServiceError(
                "swap_fill_fare_provenance",
                400,
                "fare asset is not carried by the fill inputs",
            );
    } else if (fareSeen && fareSeen.units > 0n) mismatch("fill carries an unpriced fare");
    // A sats fare pays the taxi script carrying no assets, exactly as change
    // does, so the two are indistinguishable per-output. What is checkable is
    // the total: Taxi receives its change plus the fare it quoted, no more.
    const satsFare = args.actualFare.currency === "sats" ? args.actualFare.units : 0n;
    if (changeSum !== change + satsFare) mismatch("taxi change differs from the reservation");
}

const fareOf = (domain: ReturnType<typeof swapFillGraphFromWire>): SwapFill["fare"] => {
    const fares = domain.outputs.filter((o) => o.role === "sponsor-fare");
    const [fare] = fares;
    if (!fare) return { currency: "sats", units: 0n };
    if (fare.assets.length)
        return {
            currency: "asset",
            assetId: { ...fare.assets[0]!.assetId },
            units: fare.assets.reduce((s, a) => s + a.units, 0n),
        };
    return { currency: "sats", units: fare.sats };
};

async function reverifyFreshness(
    deps: SwapFillQuoteDeps,
    req: SwapFillQuoteRequest,
    fundingOutpoint: Outpoint,
    selection: { inputs: { txid: string; vout: number }[]; totalValue: bigint },
    intentLocks: Outpoint[],
    receiveQuote?: ReceiveQuote,
): Promise<void> {
    let currentSpendable;
    let currentLocks;
    try {
        currentSpendable = await deps.inventory.getSpendableVtxos();
        currentLocks = await deps.inventory.getLockedVtxoOutpoints();
        const before = new Set(intentLocks.map(key));
        if (currentLocks.length !== before.size || currentLocks.some((o) => !before.has(key(o))))
            throw new Error("intent locks changed during construction");
    } catch (cause) {
        throw new ServiceError(
            "runtime_unsafe",
            503,
            "wallet inventory or intent locks changed or unavailable",
            { cause },
        );
    }
    const latest = receiveQuote
        ? {
              inputs: receiveQuote.operatorInputs.map((expected) => {
                  const coin = currentSpendable.find(
                      (candidate) => key(candidate) === key(expected),
                  );
                  if (!coin || !sameFundingSnapshot(operatorFundingInput(coin), expected))
                      throw new ServiceError(
                          "receive_quote_funding_changed",
                          409,
                          "receive quote operator funding changed during construction",
                      );
                  return coin;
              }),
              totalValue: receiveQuote.operatorInputs.reduce((sum, input) => sum + input.value, 0n),
          }
        : selectOperatorFunding({
              spendable: currentSpendable,
              reserved: [
                  ...unionReservedOutpoints(deps.reservations, deps.swapFills, deps.receiveQuotes),
                  ...currentLocks,
              ],
              requiredSats: req.contributionSats,
              safety: deps.runtime.safety(),
              nowMs: deps.nowMs(),
              maxSnapshotAgeMs: deps.config.reconcileIntervalMs,
              minExpiryHeadroomBlocks: deps.config.minExpiryHeadroomBlocks,
              minExpiryHeadroomSeconds: deps.config.minExpiryHeadroomSeconds,
              minReserveSats: deps.config.operatorMinReserveSats,
              dustSats: deps.config.dust,
          });
    const wanted = selection.inputs.map(key).sort();
    const got = latest.inputs.map(key).sort();
    if (
        wanted.length !== got.length ||
        wanted.some((k, i) => k !== got[i]) ||
        latest.totalValue !== selection.totalValue
    )
        throw new ServiceError("runtime_unsafe", 503, "funding safety changed during construction");
    await observedCoin(
        deps.senderInventory,
        fundingOutpoint,
        "swap_fill_deposit_unknown",
        "swap offer deposit is not served by the indexer",
    );
    for (const input of req.solverInputs)
        await observedCoin(
            deps.senderInventory,
            { txid: input.txid, vout: input.vout },
            "swap_fill_solver_unknown",
            "solver funding is not served by the indexer",
        );
}

export async function revalidateBoundSwapFill(
    deps: SwapFillQuoteDeps,
    fill: SwapFill,
): Promise<void> {
    if (!fill.receiveQuoteId) return;
    // A runtime check in flight publishes `runtime_checking`; admission awaits it
    // and keeps the next one from starting before the final freshness read.
    return deps.runtime.withAdmission((assertCurrent) =>
        revalidateAdmittedBoundSwapFill(
            {
                ...deps,
                runtime: {
                    ...deps.runtime,
                    safety: () => {
                        assertCurrent();
                        return deps.runtime.safety();
                    },
                },
            },
            fill,
        ),
    );
}

async function revalidateAdmittedBoundSwapFill(
    deps: SwapFillQuoteDeps,
    fill: SwapFill,
): Promise<void> {
    if (!fill.receiveQuoteId) return;
    const quote = deps.receiveQuotes?.get(fill.receiveQuoteId);
    const snapshot = deps.policy.getSnapshot();
    if (
        !quote ||
        quote.state !== "bound" ||
        quote.boundFillId !== fill.id ||
        quote.policyRevision !== snapshot.revision ||
        snapshot.policy.paused
    )
        throw new Error("bound receive quote is missing, stale, or paused");
    assertFreshSafety(deps.runtime.safety(), deps.nowMs(), deps.config.reconcileIntervalMs);
    const source = readFundingSource(
        deps.advances.get(fill.receiveQuoteId)?.unsignedLockupTx ?? "",
    );
    if (
        source.kind !== "joint-fill" ||
        source.source.fillId !== fill.id ||
        source.source.operationId !== fill.operationId ||
        source.source.offerHex.toLowerCase() !== fill.offerHex.toLowerCase()
    )
        throw new Error("bound funding source differs from the fill");
    const [spendable, locks, indexed] = await Promise.all([
        deps.inventory.getSpendableVtxos(),
        deps.inventory.getLockedVtxoOutpoints(),
        deps.senderInventory.getVtxos({
            outpoints: source.source.inputs
                .filter((input) => input.role !== "sponsor")
                .map(({ txid, vout }) => ({ txid, vout })),
        }),
    ]);
    const current = new Map<string, VirtualCoin & Partial<ExtendedVirtualCoin>>([
        ...spendable.map((coin) => [key(coin), coin] as const),
        ...indexed.vtxos.map((coin) => [key(coin), coin] as const),
    ]);
    if (locks.some((locked) => fill.taxiInputs.some((input) => key(input) === key(locked))))
        throw new Error("bound operator input is locked by another intent");
    for (const input of source.source.inputs) {
        const coin = current.get(key(input));
        const leaf = coin?.forfeitTapLeafScript ?? coin?.intentTapLeafScript;
        // Indexed coins carry no taproot data. Theirs was checked against this
        // script at quote time, and readFundingSource re-checks it on every read.
        if (
            !coin ||
            coin.isSpent ||
            BigInt(coin.value).toString(10) !== input.value ||
            coin.script.toLowerCase() !== input.script ||
            (input.role === "sponsor" &&
                (!coin.tapTree ||
                    bytesToHex(coin.tapTree) !== input.tapTree ||
                    !leaf ||
                    bytesToHex(scriptFromTapLeafScript(leaf)) !== input.spendLeaf)) ||
            JSON.stringify(
                (coin.assets ?? [])
                    .map((asset) => ({
                        assetId: asset.assetId,
                        amount: BigInt(asset.amount).toString(10),
                    }))
                    .sort((a, b) => a.assetId.localeCompare(b.assetId)),
            ) !==
                JSON.stringify([...input.assets].sort((a, b) => a.assetId.localeCompare(b.assetId)))
        )
            throw new Error(`bound input ${input.txid}:${input.vout} changed`);
        const expiry = normalizeExpiry(coin);
        if (
            expiry.kind !== input.expiry.kind ||
            expiry.value.toString(10) !== input.expiry.value ||
            expiry.kind !== quote.inputExpiryFloor.kind ||
            expiry.value < quote.inputExpiryFloor.value
        )
            throw new Error(`bound input ${input.txid}:${input.vout} expiry changed`);
    }
    if (deps.policy.getSnapshot().revision !== snapshot.revision)
        throw new Error("policy changed during bound fill revalidation");
    assertFreshSafety(deps.runtime.safety(), deps.nowMs(), deps.config.reconcileIntervalMs);
}

const sameFundingSnapshot = (
    actual: ReturnType<typeof operatorFundingInput>,
    expected: ReturnType<typeof operatorFundingInput>,
): boolean =>
    JSON.stringify(actual, (_, value) => (typeof value === "bigint" ? value.toString() : value)) ===
    JSON.stringify(expected, (_, value) => (typeof value === "bigint" ? value.toString() : value));

export function getSwapFill(
    deps: Pick<SwapFillQuoteDeps, "swapFills" | "now">,
    id: string,
): SwapFillStatusResponse {
    deps.swapFills.expireQuotes(deps.now());
    const fill = deps.swapFills.get(id);
    if (!fill) throw new ServiceError(ErrorCode.NotFound, 404, `swap fill ${id} not found`);
    return {
        fillId: fill.id,
        operationId: fill.operationId,
        state: fill.state,
        ...(fill.txid !== undefined ? { txid: fill.txid } : {}),
        ...(fill.outpoint ? { outpoint: { ...fill.outpoint } } : {}),
        ...(fill.spentTxid !== undefined ? { spentTxid: fill.spentTxid } : {}),
        ...(fill.failureCode !== undefined ? { failureCode: fill.failureCode } : {}),
        updatedAt: fill.updatedAt,
        expiresAt: fill.expiresAt,
    };
}
