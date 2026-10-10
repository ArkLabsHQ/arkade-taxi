import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import {
    ArkAddress,
    Extension,
    ExtensionNotFoundError,
    Transaction,
    VtxoScript,
    VtxoTaprootTree,
    asset,
    canSpendOffchain,
    getArkPsbtFields,
    scriptFromTapLeafScript,
    type ArkProvider,
    type CSVMultisigTapscript,
    type EmulatorProvider,
    type ExtendedVirtualCoin,
    type Identity,
    type VirtualCoin,
} from "@arkade-os/sdk";
import { base64, hex } from "@scure/base";
import type { Advance, Outpoint } from "@arkade-taxi/core";
import { DustCovenantScript, lockupSats } from "@arkade-taxi/covenant";
import type {
    FillRepository,
    PolicyRepository,
    ReceiveQuote,
    ReceiveQuoteInputSnapshot,
    ReceiveQuoteRepository,
    Fill,
} from "@arkade-taxi/db";
import {
    fillCosignerKeys,
    prepareFillSubmission,
    sealFillGraph,
    signFillForTaxi,
    submitFillGraph,
    type JointGraph,
    type JointSignerBinding,
    type PreparedJointSubmission,
} from "@arkade-taxi/client";
import type { FillRequestBody, FillStatusResponse } from "@arkade-taxi/protocol";
import type { RuntimeConfig } from "./config.js";
import { ErrorCode, ServiceError, sanitizeOperationalError } from "./errors.js";
import { withQuoteAdmission } from "./quotes.js";
import type { RuntimeGate } from "./arkade/types.js";
import { assertFreshSafety } from "./arkade/inventory.js";
import { buildRecoveryIntent } from "./arkade/recovery.js";
import { encodeFillSource, type FillFundingSource } from "./arkade/fundingSource.js";
import {
    deriveJointInputs,
    deriveJointOutputs,
    JointGraphDerivationError,
    type DerivedJointOutput,
} from "./arkade/jointGraphDerivation.js";
import { assertCheckpointForInput } from "./arkade/psbt.js";
import { taxiAssetIdToSwapId } from "./arkade/swapFillBuilder.js";
import { normalizeExpiry, withinVtxoMaxAmount } from "./arkade/providers.js";

export interface FillGraphArgs {
    graph: { arkTx: string; checkpoints: readonly string[] };
    taxiInputIndexes: readonly number[];
    covenantOutputIndex: number;
    assetUnits?: bigint;
    quote: ReceiveQuote;
    operatorScript: Uint8Array;
    /** One indexer read, passed in, so the validator stays synchronous. */
    observed: ReadonlyMap<string, VirtualCoin>;
    serverUnroll: CSVMultisigTapscript.Type;
    limits?: { vtxoMaxAmount: bigint };
    dust: bigint;
    vtxoMinAmount: bigint;
    serverKey: Uint8Array;
    emulatorKey: Uint8Array;
    clock: { height: number; timestamp: Date };
}

const refuse = (code: string, status: 400 | 409, detail: string): never => {
    throw new ServiceError(code, status, `fill graph ${detail}`);
};

const same = (a: Uint8Array, b: Uint8Array): boolean => hex.encode(a) === hex.encode(b);
const point = (o: { txid: string; vout: number }): string => `${o.txid.toLowerCase()}:${o.vout}`;

const decode = (psbt: string, label: string): Transaction => {
    try {
        return Transaction.fromPSBT(base64.decode(psbt));
    } catch (cause) {
        throw new ServiceError("fill_graph_invalid", 400, `fill graph ${label} is not a PSBT`, {
            cause,
        });
    }
};

const assetPacket = (tx: Transaction): asset.Packet | null => {
    try {
        return Extension.fromTx(tx).getAssetPacket();
    } catch (cause) {
        if (cause instanceof ExtensionNotFoundError) return null;
        return refuse("fill_asset_packet_invalid", 400, "asset packet is not parsable");
    }
};

/**
 * V1-V11 of the rail-agnostic fill design, on a graph the caller built.
 *
 * The Taxi checks only that it gets its reserved coins back, its fare paid and
 * the quoted covenant created. It does not check that the fill is good for the
 * receiver: it never could, and the receiver verifies the covenant itself.
 */
export function assertFillGraph(args: FillGraphArgs): void {
    const { graph, quote, observed, operatorScript } = args;
    const arkTx = decode(graph.arkTx, "arkTx");
    const taxi = new Set(args.taxiInputIndexes);

    // V1 — per-input identity: without it no per-input rule binds to anything.
    if (taxi.size !== args.taxiInputIndexes.length)
        refuse("fill_taxi_inputs_differ", 400, "repeats a Taxi input index");
    if (
        args.taxiInputIndexes.some(
            (i) => !Number.isSafeInteger(i) || i < 0 || i >= arkTx.inputsLength,
        )
    )
        refuse("fill_taxi_inputs_differ", 400, "names a Taxi input index outside the graph");
    let inputs;
    try {
        inputs = deriveJointInputs({
            arkTx: graph.arkTx,
            checkpoints: graph.checkpoints,
            inputOwners: Array.from({ length: graph.checkpoints.length }, (_, i) =>
                taxi.has(i) ? "taxi" : null,
            ),
        });
    } catch (cause) {
        if (cause instanceof JointGraphDerivationError)
            throw new ServiceError("fill_graph_invalid", 400, `fill graph ${cause.message}`, {
                cause,
            });
        throw cause;
    }

    // V2 — the Taxi's inputs are exactly the reservation, still as reserved.
    const reserved = new Map<string, ReceiveQuoteInputSnapshot>(
        quote.operatorInputs.map((input) => [point(input), input]),
    );
    if (taxi.size !== reserved.size)
        refuse("fill_taxi_inputs_differ", 400, "spends a different number of Taxi coins");
    const taxiSnapshots = new Map<number, ReceiveQuoteInputSnapshot>();
    for (const index of taxi) {
        const snapshot = reserved.get(point(inputs[index]!));
        if (!snapshot)
            refuse("fill_taxi_inputs_differ", 400, "spends a Taxi coin this quote never reserved");
        const coin = observed.get(point(inputs[index]!));
        if (!coin) refuse("fill_taxi_inputs_differ", 400, "spends an unobserved Taxi coin");
        const tree = VtxoScript.decode(snapshot!.tapTree);
        // findLeaf throws on a leaf the tree does not carry, so the lookup is
        // the test; letting it escape would answer 500 instead of refusing.
        const reserves = (): boolean => {
            try {
                return Boolean(tree.findLeaf(hex.encode(snapshot!.spendLeaf)));
            } catch {
                return false;
            }
        };
        if (
            BigInt(coin!.value) !== snapshot!.value ||
            coin!.script !== hex.encode(tree.pkScript) ||
            !reserves() ||
            (coin!.assets ?? []).length > 0 ||
            !isDeepStrictEqual(normalizeExpiry(coin!), snapshot!.expiry)
        )
            refuse("fill_taxi_inputs_differ", 409, "Taxi coin differs from its reserved snapshot");
        taxiSnapshots.set(index, snapshot!);
    }

    // V3 — no other Taxi coin rides along. Not a theft vector (the Taxi signs
    // only these indexes) but a clear refusal beats an opaque consensus failure.
    for (const [index, input] of inputs.entries()) {
        if (taxi.has(index)) continue;
        const coin = observed.get(point(input));
        if (coin && coin.script === hex.encode(operatorScript))
            refuse("fill_foreign_taxi_coin", 400, "carries a Taxi coin as a foreign input");
    }

    // V4 — where the Taxi's sats actually move. Every output rule below is
    // worthless without it: the arkTx can look perfect while checkpoint i pays
    // the Taxi's coin to a script of the caller's choosing.
    for (const [index, snapshot] of taxiSnapshots) {
        const tree = VtxoScript.decode(snapshot.tapTree);
        const { arkInput } = assertCheckpointForInput(
            decode(graph.checkpoints[index]!, `checkpoints[${index}]`),
            {
                txid: snapshot.txid,
                vout: snapshot.vout,
                value: Number(snapshot.value),
                tapTree: snapshot.tapTree,
                tapLeafScript: tree.findLeaf(hex.encode(snapshot.spendLeaf)),
                spendLeaf: snapshot.spendLeaf,
            },
            args.serverUnroll,
            () =>
                refuse(
                    "fill_checkpoint_mismatch",
                    400,
                    `checkpoint ${index} is not the checkpoint the Taxi accepts`,
                ),
        );
        const edge = arkTx.getInput(index);
        const expected = arkInput as { witnessUtxo: unknown; tapLeafScript: unknown };
        if (
            !isDeepStrictEqual(edge.witnessUtxo, expected.witnessUtxo) ||
            !isDeepStrictEqual(edge.tapLeafScript, expected.tapLeafScript)
        )
            refuse(
                "fill_checkpoint_mismatch",
                400,
                `arkTx input ${index} does not spend its checkpoint tree`,
            );
    }

    let outputs: DerivedJointOutput[];
    try {
        outputs = deriveJointOutputs(graph);
    } catch (cause) {
        if (cause instanceof JointGraphDerivationError)
            throw new ServiceError("fill_graph_invalid", 400, `fill graph ${cause.message}`, {
                cause,
            });
        throw cause;
    }

    // V5 — the quoted covenant output. The loan is only repayable through it.
    const covenant = outputs.find((output) => output.vout === args.covenantOutputIndex);
    const covenantScript = new DustCovenantScript({
        serverKey: args.serverKey,
        emulatorKey: args.emulatorKey,
        vtxoMinAmount: args.vtxoMinAmount,
        params: quote.params,
    }).pkScript;
    if (
        !covenant ||
        !same(covenant.script, covenantScript) ||
        covenant.sats !== lockupSats(quote.params)
    )
        refuse(
            "fill_covenant_output_mismatch",
            400,
            "covenant output differs from the quoted covenant",
        );
    const wanted = taxiAssetIdToSwapId(quote.params.assetId);
    const delivered = new Map<string, bigint>();
    for (const held of covenant!.assets)
        delivered.set(held.assetId, (delivered.get(held.assetId) ?? 0n) + held.units);

    // V6 — the Taxi cannot know what the receiver was promised; it can know the
    // recycle leaf pays `delivery - fare`, so a fare at or above it is unspendable.
    const units = args.assetUnits ?? 0n;
    if (units <= 0n) refuse("fill_asset_units_invalid", 400, "declares no delivered units");
    const receiverFare = quote.params.receiverFare;
    if (receiverFare?.currency === "asset" && receiverFare.units >= units)
        refuse("fill_fare_exceeds_delivery", 400, "receiver fare is at or above the delivery");

    if (delivered.size !== 1 || delivered.get(wanted) !== units)
        refuse(
            "fill_covenant_asset_mismatch",
            400,
            "covenant output asset differs from the declared delivery",
        );

    // V7 — the whole economic check: everything the Taxi puts in comes back
    // except the loan, plus the fare it quoted. Summed, not matched per output:
    // a sats fare and change both pay `operatorScript` carrying no assets, so
    // they are indistinguishable per output and only the total is checkable.
    // A receive quote's fare is sats by construction: `encodeFare` in the quote
    // repository refuses any other currency, and so does the bind. Asserted
    // rather than handled, so the day that changes this refuses instead of
    // silently valuing an asset fare at zero.
    if (quote.fare.currency !== "sats")
        refuse("fill_fare_unsupported", 409, "quote prices a fare this rail cannot check");
    const contributed = [...taxiSnapshots.values()].reduce((sum, i) => sum + i.value, 0n);
    let paidToTaxi = 0n;
    for (const output of outputs) {
        if (!same(output.script, operatorScript)) continue;
        // The Taxi quoted sats, so any asset at its own script is unpriced.
        if (output.assets.length)
            refuse("fill_unpriced_fare", 400, "pays the Taxi an asset fare it never priced");
        paidToTaxi += output.sats;
    }
    if (paidToTaxi !== contributed - quote.params.topup + quote.fare.units)
        refuse(
            "fill_operator_payout_mismatch",
            400,
            "Taxi payout is not the reservation less the loan plus the fare",
        );

    // V8 — the standing no-sub-dust decision, and arkd refuses them anyway.
    // Unconditional, unlike the fill path it replaces: a zero-sat value output
    // passed there while the lockup path always refused one.
    for (const output of outputs) {
        if (args.limits && !withinVtxoMaxAmount(output.sats, args.limits.vtxoMaxAmount))
            refuse(
                "fill_output_limit_exceeded",
                409,
                `output ${output.vout} exceeds the provider maximum`,
            );
        if (output.sats < (output.assets.length ? args.vtxoMinAmount : args.dust))
            refuse(
                "fill_output_below_floor",
                400,
                `output ${output.vout} is below the spendable floor`,
            );
    }

    // V9 — asset conservation, and nothing taken out of the Taxi. (b) first:
    // the Taxi's coins are bitcoin-only by selection, so a packet claiming to
    // consume units at a Taxi vin is the half that is about the Taxi's money.
    const packet = assetPacket(arkTx);
    const valueVouts = new Set(outputs.map((output) => output.vout));
    for (const group of packet?.groups ?? []) {
        if (!group.assetId) refuse("fill_asset_not_conserved", 400, "mints an asset without an id");
        for (const input of group.inputs)
            if (taxi.has(input.vin))
                refuse("fill_taxi_input_assets", 400, "declares asset units at a Taxi input");
        const into = group.inputs.reduce((sum, input) => sum + input.amount, 0n);
        const outOf = group.outputs.reduce((sum, output) => sum + output.amount, 0n);
        if (into !== outOf)
            refuse(
                "fill_asset_not_conserved",
                400,
                `asset ${group.assetId!.toString()} is not conserved`,
            );
        for (const output of group.outputs)
            if (!valueVouts.has(output.vout))
                refuse("fill_asset_not_conserved", 400, "allocates an asset to a non-value output");
    }

    // V10 — the covenant coin inherits the earliest batch expiry of its inputs
    // while the Taxi's recovery is a wall-clock CLTV, so a short foreign input
    // can put the sweep before the recovery is reachable and the loan dies.
    const floor = quote.inputExpiryFloor;
    for (const input of inputs) {
        const coin = observed.get(point(input));
        if (!coin || coin.isSpent || !canSpendOffchain(coin, args.clock))
            refuse(
                "fill_input_unspendable",
                400,
                `input ${point(input)} is not spendable offchain`,
            );
        let expiry;
        try {
            expiry = normalizeExpiry(coin!);
        } catch (cause) {
            throw new ServiceError(
                "fill_input_expiry_unknown",
                400,
                `fill graph input ${point(input)} has unknown or ambiguous expiry`,
                { cause },
            );
        }
        if (expiry.kind !== floor.kind || expiry.value < floor.value)
            refuse(
                "fill_input_expiry_floor",
                409,
                `input ${point(input)} expires before the quote floor`,
            );
    }

    // V11 — the Taxi signs last. A pre-signed Taxi input means the caller holds
    // a signature the Taxi never issued. Foreign signatures are not checked:
    // with one call there is no substitution window, and an under-signed foreign
    // input only makes submission fail, atomically.
    for (const index of taxi) {
        const checkpoint = decode(graph.checkpoints[index]!, `checkpoints[${index}]`);
        if (
            arkTx.getInput(index).tapScriptSig?.length ||
            checkpoint.getInput(0).tapScriptSig?.length
        )
            refuse("fill_taxi_input_signed", 400, `Taxi input ${index} arrives already signed`);
    }
}

// ---------------------------------------------------------------------------
// POST /v1/fills, GET /v1/fills/{id}
// ---------------------------------------------------------------------------

export interface FillDeps {
    runtime: RuntimeGate;
    policy: Pick<PolicyRepository, "getSnapshot">;
    fills: Pick<
        FillRepository,
        | "get"
        | "getByOperation"
        | "recordPrepared"
        | "recordSubmitInvoked"
        | "recordSubmitted"
        | "recordSettled"
        | "recordAmbiguous"
        | "recordSigningFailure"
        | "expire"
    >;
    receiveQuotes: Pick<ReceiveQuoteRepository, "get" | "bindFill" | "expireQuotes">;
    inventory: { getLockedVtxoOutpoints(): Promise<Outpoint[]> };
    senderInventory: {
        getVtxos(opts?: { outpoints?: Outpoint[] }): Promise<{ vtxos: VirtualCoin[] }>;
    };
    config: RuntimeConfig;
    now: () => number;
    nowMs: () => number;
    randomId: () => string;
    taxiIdentity: () => Identity;
    emulator: Pick<EmulatorProvider, "submitTx">;
    arkProvider: Pick<ArkProvider, "submitTx" | "finalizeTx">;
    providerLimits: () => Promise<{ vtxoMaxAmount: bigint }>;
    getServerUnroll: () => CSVMultisigTapscript.Type;
    leaseSeconds: number;
}

const DECIMAL = /^(0|[1-9][0-9]*)$/;
const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;

const bad = (detail: string): never => {
    throw new ServiceError(ErrorCode.InvalidRequest, 400, `fill request ${detail}`);
};

function decodeFillBody(body: unknown): FillRequestBody {
    if (!body || typeof body !== "object" || Array.isArray(body)) bad("must be an object");
    const raw = body as Record<string, unknown>;
    const text = (key: "operationId" | "quoteId", max: number): string => {
        const value = raw[key];
        if (typeof value !== "string" || !value.length || value.length > max)
            return bad(`${key} is not a bounded string`);
        return value;
    };
    const psbt = (value: unknown, label: string): string => {
        if (typeof value !== "string" || !value.length || value.length > 4_000_000)
            return bad(`${label} is not a bounded PSBT`);
        if (!BASE64.test(value)) bad(`${label} is not base64`);
        return value;
    };
    if (!Array.isArray(raw.checkpoints) || !raw.checkpoints.length || raw.checkpoints.length > 256)
        bad("checkpoints must be a bounded array");
    if (
        !Array.isArray(raw.taxiInputIndexes) ||
        !raw.taxiInputIndexes.length ||
        raw.taxiInputIndexes.length > 256
    )
        bad("taxiInputIndexes must be a bounded array");
    for (const index of raw.taxiInputIndexes as unknown[])
        if (!Number.isSafeInteger(index) || (index as number) < 0)
            bad("taxiInputIndexes must be non-negative integers");
    if (!Number.isSafeInteger(raw.covenantOutputIndex) || (raw.covenantOutputIndex as number) < 0)
        bad("covenantOutputIndex must be a non-negative integer");
    if (typeof raw.assetUnits !== "string" || !DECIMAL.test(raw.assetUnits))
        bad("assetUnits must be a canonical decimal string");
    if (
        raw.validUntil !== undefined &&
        (!Number.isSafeInteger(raw.validUntil) || (raw.validUntil as number) <= 0)
    )
        bad("validUntil must be a positive integer when present");
    return {
        operationId: text("operationId", 128),
        quoteId: text("quoteId", 128),
        arkTx: psbt(raw.arkTx, "arkTx"),
        checkpoints: (raw.checkpoints as unknown[]).map((c, i) => psbt(c, `checkpoints[${i}]`)),
        taxiInputIndexes: [...(raw.taxiInputIndexes as number[])],
        covenantOutputIndex: raw.covenantOutputIndex as number,
        assetUnits: raw.assetUnits as string,
        ...(raw.validUntil === undefined ? {} : { validUntil: raw.validUntil as number }),
    };
}

const toStatus = (fill: Fill): FillStatusResponse => ({
    fillId: fill.id,
    operationId: fill.operationId,
    state: fill.state,
    ...(fill.txid === undefined ? {} : { txid: fill.txid }),
    ...(fill.outpoint === undefined ? {} : { outpoint: { ...fill.outpoint } }),
    ...(fill.spentTxid === undefined ? {} : { spentTxid: fill.spentTxid }),
    ...(fill.failureCode === undefined ? {} : { failureCode: fill.failureCode }),
    updatedAt: fill.updatedAt,
    expiresAt: fill.expiresAt,
});

/** What a replayed `operationId` must still name, so one idempotency key cannot
 * be reused for a different graph. Stored as the fill's `graphId`. */
const termsDigest = (body: FillRequestBody): string =>
    createHash("sha256")
        .update(
            JSON.stringify({
                quoteId: body.quoteId,
                arkTx: body.arkTx,
                checkpoints: body.checkpoints,
                taxiInputIndexes: body.taxiInputIndexes,
                covenantOutputIndex: body.covenantOutputIndex,
                assetUnits: body.assetUnits,
            }),
        )
        .digest("hex");

/** Every input's outpoint, read off the checkpoints rather than declared. */
const fillOutpoints = (
    graph: { arkTx: string; checkpoints: readonly string[] },
    taxiInputIndexes: readonly number[],
): Outpoint[] => {
    const taxi = new Set(taxiInputIndexes);
    try {
        return deriveJointInputs({
            arkTx: graph.arkTx,
            checkpoints: graph.checkpoints,
            inputOwners: Array.from({ length: graph.checkpoints.length }, (_, i) =>
                taxi.has(i) ? "taxi" : null,
            ),
        }).map(({ txid, vout }) => ({ txid, vout }));
    } catch (cause) {
        if (cause instanceof JointGraphDerivationError)
            throw new ServiceError("fill_graph_invalid", 400, `fill graph ${cause.message}`, {
                cause,
            });
        throw cause;
    }
};

export function getFill(deps: Pick<FillDeps, "fills" | "now">, id: string): FillStatusResponse {
    deps.fills.expire(deps.now());
    const fill = deps.fills.get(id);
    if (!fill) throw new ServiceError(ErrorCode.NotFound, 404, `fill ${id} not found`);
    return toStatus(fill);
}

export async function submitFill(
    deps: FillDeps,
    body: unknown,
    assertReady?: () => void,
): Promise<FillStatusResponse> {
    const req = decodeFillBody(body);
    return withQuoteAdmission(deps, assertReady, (admitted) => createFill(admitted, req));
}

async function createFill(deps: FillDeps, req: FillRequestBody): Promise<FillStatusResponse> {
    const { config } = deps;
    const now = deps.now();
    deps.receiveQuotes.expireQuotes(now);
    deps.fills.expire(now);
    const digest = termsDigest(req);
    const replay = deps.fills.getByOperation(req.operationId);
    if (replay) {
        if (hex.encode(replay.graphId) !== digest)
            throw new ServiceError(
                "operation_conflict",
                409,
                "operation id was already filled with different terms",
            );
        return toStatus(replay);
    }
    if (req.validUntil !== undefined && req.validUntil <= now)
        throw new ServiceError(ErrorCode.QuoteExpired, 409, "fill deadline has already passed");

    const quote = deps.receiveQuotes.get(req.quoteId);
    if (!quote)
        throw new ServiceError(ErrorCode.NotFound, 404, `receive quote ${req.quoteId} not found`);
    if (quote.state !== "quoted")
        throw new ServiceError(
            ErrorCode.InvalidState,
            409,
            `receive quote ${req.quoteId} is ${quote.state}, not fillable`,
        );
    if (quote.expiresAt <= now)
        throw new ServiceError(ErrorCode.QuoteExpired, 409, `receive quote ${req.quoteId} expired`);
    const { revision } = deps.policy.getSnapshot();
    if (quote.policyRevision !== revision)
        throw new ServiceError("policy_changed", 409, "policy changed since the quote was issued");

    const graph = { arkTx: req.arkTx, checkpoints: req.checkpoints };
    const safety = deps.runtime.safety();
    assertFreshSafety(safety, deps.nowMs(), config.reconcileIntervalMs);
    const operatorScript = new ArkAddress(
        config.serverPubkey,
        config.operatorKey,
        config.addressHrp,
    ).pkScript;

    // One batched indexer read over every derived outpoint, so the validator
    // stays synchronous and sees one snapshot instead of a coin per round trip.
    let observed: Map<string, VirtualCoin>;
    try {
        const response = await deps.senderInventory.getVtxos({
            outpoints: fillOutpoints(graph, req.taxiInputIndexes),
        });
        observed = new Map(response.vtxos.map((coin) => [point(coin), coin]));
    } catch (cause) {
        if (cause instanceof ServiceError) throw cause;
        throw new ServiceError("runtime_unsafe", 503, "funding verification unavailable", {
            cause,
        });
    }
    const limits = await deps.providerLimits();
    assertFillGraph({
        graph,
        taxiInputIndexes: req.taxiInputIndexes,
        covenantOutputIndex: req.covenantOutputIndex,
        assetUnits: BigInt(req.assetUnits),
        quote,
        operatorScript,
        observed,
        serverUnroll: deps.getServerUnroll(),
        limits,
        dust: config.dust,
        vtxoMinAmount: config.vtxoMinAmount,
        serverKey: config.serverPubkey,
        emulatorKey: config.emulatorPubkey,
        clock: {
            height: Number(safety.chainHeight),
            timestamp: new Date(Number(safety.chainTime) * 1000),
        },
    });

    // V12: every rule above read a moving world, so the reservation, the policy
    // and the runtime are re-read before anything binds.
    const locks = await deps.inventory.getLockedVtxoOutpoints();
    if (locks.some((l) => quote.operatorInputs.some((input) => point(input) === point(l))))
        throw new ServiceError(
            "runtime_unsafe",
            503,
            "a reserved Taxi coin is locked by an intent",
        );
    if (deps.policy.getSnapshot().revision !== revision)
        throw new ServiceError("policy_changed", 409, "policy changed during validation");
    assertFreshSafety(deps.runtime.safety(), deps.nowMs(), config.reconcileIntervalMs);

    const txid = Transaction.fromPSBT(base64.decode(req.arkTx)).id.toLowerCase();
    const expiresAt =
        req.validUntil !== undefined && req.validUntil < quote.expiresAt
            ? req.validUntil
            : quote.expiresAt;
    const leaseToken = deps.randomId();
    const row: Fill = {
        id: deps.randomId(),
        quoteId: quote.id,
        operationId: req.operationId,
        state: "submitting",
        taxiInputs: quote.operatorInputs.map(({ txid: t, vout }) => ({ txid: t, vout })),
        covenantOutputIndex: req.covenantOutputIndex,
        assetUnits: BigInt(req.assetUnits),
        contributionSats: quote.loanSats,
        fare: quote.fare,
        graph: { arkTx: graph.arkTx, checkpoints: [...graph.checkpoints] },
        graphId: hex.decode(digest),
        submitInvoked: false,
        leaseOwner: "fill",
        leaseToken,
        leaseUntil: now + deps.leaseSeconds,
        attempts: 1,
        createdAt: now,
        updatedAt: now,
        expiresAt,
        ...(req.validUntil === undefined ? {} : { validUntil: req.validUntil }),
    };

    const source = fillSource(deps, quote, row, req, observed, operatorScript, txid);
    const advance: Advance = {
        id: quote.id,
        state: "locking",
        ...quote.params,
        assetUnits: row.assetUnits,
        covenantAddress: quote.covenantAddress,
        fare: quote.fare,
        createdAt: now,
        updatedAt: now,
        expiresAt,
        recoveryLocktime: quote.recoveryLocktime,
        operatorInputs: row.taxiInputs.map(({ txid: t, vout }) => ({ txid: t, vout })),
        unsignedLockupTx: encodeFillSource(source),
        unsignedLockupId: source.graph.graphId,
    };
    source.recoveryPreflight = buildRecoveryIntent(
        { ...advance, outpoint: { txid, vout: req.covenantOutputIndex } },
        config,
    );
    advance.unsignedLockupTx = encodeFillSource(source);
    try {
        deps.receiveQuotes.bindFill({
            quoteId: quote.id,
            fill: row,
            advance,
            expectedPolicyRevision: revision,
            now,
        });
    } catch (cause) {
        const raced = deps.fills.getByOperation(req.operationId);
        if (raced) return toStatus(raced);
        throw new ServiceError("fill_bind_failed", 409, "fill could not bind its receive quote", {
            cause,
        });
    }
    return signAndSubmit(deps, row, leaseToken, now);
}

/** The persisted record a restart rebuilds the recovery from. */
function fillSource(
    deps: FillDeps,
    quote: ReceiveQuote,
    row: Fill,
    req: FillRequestBody,
    observed: ReadonlyMap<string, VirtualCoin>,
    operatorScript: Uint8Array,
    txid: string,
): FillFundingSource {
    const sealed = sealFillGraph({
        arkTx: row.graph.arkTx,
        checkpoints: row.graph.checkpoints,
        taxiInputIndexes: req.taxiInputIndexes,
    });
    const taxi = new Set(req.taxiInputIndexes);
    const reserved = new Map(quote.operatorInputs.map((input) => [point(input), input]));
    const inputs = fillOutpoints(row.graph, req.taxiInputIndexes).map((outpoint, index) => {
        const coin = observed.get(point(outpoint))!;
        const snapshot = reserved.get(point(outpoint));
        const taproot = snapshot ?? checkpointTaproot(row.graph.checkpoints[index]!, index);
        return {
            role: (taxi.has(index) ? "taxi" : "foreign") as "taxi" | "foreign",
            txid: outpoint.txid,
            vout: outpoint.vout,
            value: BigInt(coin.value).toString(10),
            script: coin.script.toLowerCase(),
            tapTree: hex.encode(taproot.tapTree),
            spendLeaf: hex.encode(taproot.spendLeaf),
            assets: (coin.assets ?? []).map((held) => ({
                assetId: held.assetId,
                amount: BigInt(held.amount).toString(10),
            })),
            expiry: {
                kind: normalizeExpiry(coin).kind,
                value: normalizeExpiry(coin).value.toString(10),
            },
        };
    });
    const operatorPayouts = deriveJointOutputs(row.graph)
        .filter(
            (output) =>
                output.assets.length === 0 &&
                output.script.length === operatorScript.length &&
                output.script.every((byte, i) => byte === operatorScript[i]),
        )
        .map((output) => ({
            vout: output.vout,
            sats: output.sats.toString(10),
            fareSats: quote.fare.units.toString(10),
        }));
    return {
        tag: "fill",
        version: 1,
        receiveQuoteId: quote.id,
        fillId: row.id,
        operationId: row.operationId,
        graph: sealed,
        covenantOutputIndex: req.covenantOutputIndex,
        covenantSats: quote.params.dust.toString(10),
        assetId: {
            txid: hex.encode(quote.params.assetId.txid),
            groupIndex: quote.params.assetId.groupIndex,
        },
        assetUnits: req.assetUnits,
        inputExpiryFloor: {
            kind: quote.inputExpiryFloor.kind,
            value: quote.inputExpiryFloor.value.toString(10),
        },
        inputs,
        serverUnrollScript: hex.encode(deps.getServerUnroll().script),
        operatorScript: hex.encode(operatorScript),
        operatorPayouts,
        recoveryPreflight: {
            digest: createHash("sha256")
                .update(
                    JSON.stringify({ arkTx: row.graph.arkTx, checkpoints: row.graph.checkpoints }),
                )
                .digest("hex"),
            expectedTxid: txid,
            arkTx: row.graph.arkTx,
            checkpoints: [...row.graph.checkpoints],
        },
    };
}

/**
 * A foreign input's taproot evidence, read off its own checkpoint rather than
 * off the coin: the indexer serves no tree or leaf, and the checkpoint is the
 * only place the graph says which leaf it spends under. `readFundingSource`
 * re-checks that the tree rebuilds the coin's script, so a lie does not survive.
 */
const checkpointTaproot = (
    psbt: string,
    index: number,
): { tapTree: Uint8Array; spendLeaf: Uint8Array } => {
    const checkpoint = decode(psbt, `checkpoints[${index}]`);
    const [tapTree] = getArkPsbtFields(checkpoint, 0, VtxoTaprootTree);
    const leaf = checkpoint.getInput(0).tapLeafScript?.[0];
    if (!tapTree || !leaf)
        throw new ServiceError(
            "fill_input_taproot_unknown",
            400,
            `fill checkpoint ${index} carries no taproot evidence for its input`,
        );
    return { tapTree, spendLeaf: scriptFromTapLeafScript(leaf) };
};

/**
 * V13: sign only the Taxi's indexes, prepare, re-read the clock with nothing
 * awaited, submit, and answer without bytes. The Taxi's signatures never leave
 * the process, so there is nothing to replay once the reservation lapses.
 */
async function signAndSubmit(
    deps: FillDeps,
    row: Fill,
    leaseToken: string,
    now: number,
): Promise<FillStatusResponse> {
    const { config } = deps;
    const taxi = new Set(row.taxiInputs.map((input) => point(input)));
    const taxiInputIndexes = fillOutpoints(row.graph, [])
        .map((outpoint, index) => ({ outpoint, index }))
        .filter(({ outpoint }) => taxi.has(point(outpoint)))
        .map(({ index }) => index);
    const sealed: JointGraph = sealFillGraph({
        arkTx: row.graph.arkTx,
        checkpoints: row.graph.checkpoints,
        taxiInputIndexes,
    });
    const owners = sealed.inputOwners;
    const failSigning = (code: string, status: 409 | 503, cause: unknown): never => {
        const detail = sanitizeOperationalError(cause, "fill signing failed");
        deps.fills.recordSigningFailure(row.id, leaseToken, code, detail, deps.now());
        throw new ServiceError(code, status, detail, { cause });
    };
    let identity: Identity;
    let taxiXOnly: string;
    try {
        identity = deps.taxiIdentity();
        taxiXOnly = hex.encode(await identity.xOnlyPublicKey()).toLowerCase();
    } catch (cause) {
        return failSigning("fill_signing_failed", 503, cause);
    }
    const bindings: JointSignerBinding[] = owners
        .map((owner, inputIndex) => ({ owner, inputIndex }))
        .filter(({ owner }) => owner === "taxi")
        .map(({ inputIndex }) => ({ inputIndex, identity: identity! }));
    const ownerKeys = { taxi: [taxiXOnly!] };
    let signed: JointGraph;
    let prepared: PreparedJointSubmission;
    try {
        signed = await signFillForTaxi({ expected: sealed, bindings });
        prepared = prepareFillSubmission({ expected: sealed, partial: signed, ownerKeys });
    } catch (cause) {
        return failSigning("fill_signing_failed", 503, cause);
    }
    if (
        !deps.fills.recordPrepared(
            row.id,
            leaseToken,
            prepared!.arkTx,
            [...prepared!.checkpointTxs],
            now,
        )
    )
        throw new ServiceError(
            ErrorCode.InvalidState,
            409,
            `fill ${row.id} lease lost before submission (not submitted)`,
        );
    const emulatorXOnly = hex.encode(config.emulatorPubkey).toLowerCase();
    const serverXOnly = hex.encode(config.serverPubkey).toLowerCase();
    // Emulator when any input is provider-gated, arkd when none is (OD-5).
    const gated = fillCosignerKeys({ expected: sealed, emulatorXOnly });
    // Nothing is awaited between this read and the first provider call, and
    // refusing here records no invocation: the fill is known not to be submitted.
    const atSubmit = deps.now();
    if (row.expiresAt <= atSubmit) {
        const message = `fill ${row.id} expired before submission (not submitted)`;
        deps.fills.recordSigningFailure(
            row.id,
            leaseToken,
            ErrorCode.QuoteExpired,
            message,
            atSubmit,
        );
        throw new ServiceError(ErrorCode.QuoteExpired, 409, message);
    }
    if (!deps.fills.recordSubmitInvoked(row.id, leaseToken, now))
        throw new ServiceError(
            ErrorCode.InvalidState,
            409,
            `fill ${row.id} lease lost before submission (not submitted)`,
        );
    const provider: Pick<EmulatorProvider, "submitTx"> =
        gated.size > 0 ? deps.emulator : arkSubmitter(deps.arkProvider);
    try {
        const submitted = await submitFillGraph({
            expected: sealed,
            prepared: prepared!,
            provider,
            pins: { emulatorXOnly, serverXOnly },
            ownerKeys,
        });
        // Recorded before answering, so a status read or a reconciler can
        // follow the transaction the caller is about to be told about.
        deps.fills.recordSubmitted(row.id, leaseToken, submitted.txid, now);
        return toStatus({ ...row, txid: submitted.txid, updatedAt: now });
    } catch (cause) {
        const message = sanitizeOperationalError(cause, "fill submission is ambiguous");
        deps.fills.recordAmbiguous(
            row.id,
            leaseToken,
            "fill_submission_ambiguous",
            message,
            now + deps.leaseSeconds,
            now,
        );
        throw new ServiceError("fill_submission_ambiguous", 503, message, { cause });
    }
}

/** arkd in the emulator's submit shape, so one submission path serves both. */
const arkSubmitter = (
    ark: Pick<ArkProvider, "submitTx" | "finalizeTx">,
): Pick<EmulatorProvider, "submitTx"> => ({
    submitTx: async (arkTx: string, checkpointTxs: string[]) => {
        const response = await ark.submitTx(arkTx, checkpointTxs);
        await ark.finalizeTx(response.arkTxid, [...response.signedCheckpointTxs]);
        return {
            signedArkTx: response.finalArkTx,
            signedCheckpointTxs: [...response.signedCheckpointTxs],
        };
    },
});
