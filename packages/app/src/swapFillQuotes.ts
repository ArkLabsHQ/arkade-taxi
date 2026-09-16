import {
    ArkAddress,
    canSpendOffchain,
    type ExtendedVirtualCoin,
    type IWallet,
} from "@arkade-os/sdk";
import {
    decodeOffer,
    offerVtxoScript,
    ASSET_CARRIER_SATS,
    type FillFunding,
} from "@arkade-os/swap";
import { hex } from "@scure/base";
import { ruleFor } from "@arkade-taxi/core";
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
import type { ReservationRepository, SwapFill, SwapFillRepository } from "@arkade-taxi/db";
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
import { unionReservedOutpoints } from "./arkade/reservedOutpoints.js";
import { admissionError, ErrorCode, ServiceError } from "./errors.js";
import type { AdvanceStore, QuoteDeps } from "./quotes.js";
import {
    verifyOfferFillPlan,
    type JointGraph,
} from "@arkade-taxi/client";

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
    covenantScript: Uint8Array;
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
            return {
                covenantScript: offerVtxoScript(offer, serverPubkey).pkScript,
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
    advances: Pick<AdvanceStore, "exposureTotals">;
    reservations: Pick<ReservationRepository, "listReservedOutpoints" | "expireQuotes">;
    swapFills: SwapFillStore;
    inventory: QuoteDeps["inventory"];
    senderInventory: QuoteDeps["senderInventory"];
    config: QuoteDeps["config"];
    now: QuoteDeps["now"];
    nowMs: QuoteDeps["nowMs"];
    randomId: QuoteDeps["randomId"];
    swapFillBuilder: SwapFillGraphBuilder;
    offerCodec?: OfferCodec;
    providerLimits?: () => Promise<{ vtxoMaxAmount: bigint }>;
}

const key = (o: Outpoint): string => `${o.txid}:${o.vout}`;

const termsOf = (t: {
    offerHex: string;
    solverInputs: SwapFillQuoteRequest["solverInputs"];
    solverProceedsScript: Uint8Array;
    solverKeys: string[];
    contributionSats: bigint;
    maxFare: SwapFillQuoteRequest["maxFare"];
    fundingTxid?: string;
    fundingVout?: number;
    swapAddress?: string;
}): string =>
    JSON.stringify({
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
    });

const storedTermsOf = (fill: SwapFill): string =>
    termsOf({
        offerHex: fill.offerHex,
        solverInputs: fill.solverInputs,
        solverProceedsScript: fill.solverProceedsScript,
        solverKeys: fill.solverKeys,
        contributionSats: fill.contributionSats,
        maxFare: fill.maxFare,
        ...(fill.offerTxid !== undefined ? { fundingTxid: fill.offerTxid } : {}),
        ...(fill.offerVout !== undefined ? { fundingVout: fill.offerVout } : {}),
        ...(fill.swapAddress !== undefined ? { swapAddress: fill.swapAddress } : {}),
    });

function fillToResponse(fill: SwapFill, scripts: SwapFillWireScripts): SwapFillQuoteResponse {
    return {
        fillId: fill.id,
        operationId: fill.operationId,
        expiresAt: fill.expiresAt,
        template: SWAP_FILL_TEMPLATE,
        contributionSats: satsToWire(fill.contributionSats),
        fare: fareToWire(fill.fare),
        graph: toWireGraph(storedGraphToJoint(fill.graph), scripts),
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
    if (deposit.script.toLowerCase() !== bytesToHex(offer.covenantScript).toLowerCase())
        throw new ServiceError(
            "swap_fill_deposit_mismatch",
            400,
            "swap offer deposit script differs from the offer covenant",
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
    const solverFund = await enrichSolverFund(deps, req, offer);
    const bitcoinRule = ruleFor(policy.assetRules, undefined);
    if (!bitcoinRule) throw admissionError("asset_not_served");
    if (!bitcoinRule.enabled) throw admissionError("asset_disabled");
    const contributionCap = bitcoinRule.maxTopupSats ?? policy.maxPerPaymentTopupSats;
    if (req.contributionSats > contributionCap)
        throw admissionError("topup_exceeds_max_per_payment");
    const advancesExposure = deps.advances.exposureTotals();
    const fillsExposure = deps.swapFills.exposureTotals();
    if (
        advancesExposure.outstandingSats + fillsExposure.outstandingSats + req.contributionSats >
        policy.maxOutstandingSats
    )
        throw admissionError("exceeds_max_outstanding");
    if (advancesExposure.lockedCount + fillsExposure.activeCount >= policy.maxConcurrentAdvances)
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
    const reserved = unionReservedOutpoints(deps.reservations, deps.swapFills);
    let selection;
    try {
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
        });
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
    // The builder prices fares in asset units only; a sats maxFare authorizes
    // no fare output, so the fill takes none and discloses zero.
    const sponsorFare =
        req.maxFare.currency === "asset" && req.maxFare.units > 0n
            ? { assetId: req.maxFare.assetId, amount: req.maxFare.units, script: taxiScript }
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
    });
    await reverifyFreshness(deps, req, fundingOutpoint, selection, intentLocks);
    if (deps.policy.getSnapshot().revision !== revision)
        throw new ServiceError("policy_changed", 409, "policy changed during construction");
    assertFreshSafety(deps.runtime.safety(), deps.nowMs(), deps.config.reconcileIntervalMs);
    const fill: SwapFill = {
        id: deps.randomId(),
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
        fare: fareOf(domain),
        maxFare: req.maxFare,
        graph: jointGraphToStored(graph),
        graphId: domain.graphId,
        submitInvoked: false,
        attempts: 0,
        createdAt: now,
        updatedAt: now,
        expiresAt: now + policy.quoteTtlSeconds,
    };
    try {
        deps.swapFills.insert(fill);
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

async function observedCoin(
    indexer: SwapFillQuoteDeps["senderInventory"],
    outpoint: Outpoint,
    code: string,
    message: string,
) {
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
): Promise<FillFunding[]> {
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
    const byKey = new Map(response.vtxos.map((c) => [key(c), c as ExtendedVirtualCoin]));
    const fund: FillFunding[] = [];
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
        const tapLeafScript = coin.forfeitTapLeafScript ?? coin.intentTapLeafScript;
        if (!coin.tapTree || !tapLeafScript)
            throw new ServiceError(
                "swap_fill_solver_evidence_missing",
                400,
                `solver input ${i} lacks taproot evidence`,
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
            tapTree: coin.tapTree,
            tapLeafScript,
            ...(coin.assets?.length ? { assets: [...coin.assets] } : {}),
        } as FillFunding);
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
    return fund;
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
        outputAssets.set(a.assetId, (outputAssets.get(a.assetId) ?? 0n) + a.units);
    }
    const checkOutput = (sats: bigint, assets: readonly { assetId: string; units: bigint }[]) => {
        if (sats < 0n) mismatch("output carries negative sats");
        if (args.limits && sats > args.limits.vtxoMaxAmount)
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
        if ((outputAssets.get(id) ?? 0n) !== amount) mismatch(`asset ${id} is not conserved`);
    for (const [id] of outputAssets)
        if (!held.has(id)) mismatch(`asset ${id} appears from nowhere`);
    if (offer.wantAsset) {
        if (receiverSats !== ASSET_CARRIER_SATS) mismatch("receiver carrier differs");
        const got = receiverAssets.get(taxiAssetIdToSwapId(offer.wantAsset)) ?? 0n;
        if (got !== offer.wantAmount) mismatch("receiver asset amount differs from the offer want");
    } else if (receiverSats !== offer.wantAmount)
        mismatch("receiver sats differ from the offer want");
    if (req.maxFare.currency === "asset" && req.maxFare.units > 0n) {
        if (fareSeen === undefined)
            throw new ServiceError(
                "swap_fill_graph_mismatch",
                503,
                "fill graph fare output is missing",
            );
        const allowed = taxiAssetIdToSwapId(req.maxFare.assetId);
        if (fareSeen.assetId !== allowed) mismatch("fare asset differs from maxFare");
        if (fareSeen.units !== req.maxFare.units) mismatch("fare units differ from maxFare");
        if (!args.inputAssets.some((a) => a.assetId === allowed && a.amount >= fareSeen.units))
            throw new ServiceError(
                "swap_fill_fare_provenance",
                400,
                "fare asset is not carried by the fill inputs",
            );
    } else if (fareSeen && fareSeen.units > 0n) mismatch("fill carries an unpriced fare");
    if (changeSum !== change) mismatch("taxi change differs from the reservation");
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
    const reserved = unionReservedOutpoints(deps.reservations, deps.swapFills);
    const latest = selectOperatorFunding({
        spendable: currentSpendable,
        reserved: [...reserved, ...currentLocks],
        requiredSats: req.contributionSats,
        safety: deps.runtime.safety(),
        nowMs: deps.nowMs(),
        maxSnapshotAgeMs: deps.config.reconcileIntervalMs,
        minExpiryHeadroomBlocks: deps.config.minExpiryHeadroomBlocks,
        minExpiryHeadroomSeconds: deps.config.minExpiryHeadroomSeconds,
        minReserveSats: deps.config.operatorMinReserveSats,
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
