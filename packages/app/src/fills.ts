import { isDeepStrictEqual } from "node:util";
import {
    Extension,
    ExtensionNotFoundError,
    Transaction,
    VtxoScript,
    asset,
    canSpendOffchain,
    type CSVMultisigTapscript,
    type VirtualCoin,
} from "@arkade-os/sdk";
import { base64, hex } from "@scure/base";
import { DustCovenantScript, lockupSats } from "@arkade-taxi/covenant";
import type { ReceiveQuote, ReceiveQuoteInputSnapshot } from "@arkade-taxi/db";
import { ServiceError } from "./errors.js";
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

const holdings = (coin: VirtualCoin): Map<string, bigint> =>
    new Map((coin.assets ?? []).map((held) => [held.assetId, BigInt(held.amount)]));

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
    const contributed = [...taxiSnapshots.values()].reduce((sum, i) => sum + i.value, 0n);
    const satsFare = quote.fare.currency === "sats" ? quote.fare.units : 0n;
    let paidToTaxi = 0n;
    let assetFare: { assetId: string; units: bigint } | undefined;
    for (const output of outputs) {
        if (!same(output.script, operatorScript)) continue;
        if (!output.assets.length) {
            paidToTaxi += output.sats;
            continue;
        }
        if (assetFare) refuse("fill_two_fares", 400, "pays the Taxi two asset fares");
        assetFare = {
            assetId: output.assets[0]!.assetId,
            units: output.assets.reduce((sum, held) => sum + held.units, 0n),
        };
        if (output.assets.some((held) => held.assetId !== assetFare!.assetId))
            refuse("fill_unpriced_fare", 400, "pays the Taxi an asset mix it never quoted");
    }
    if (paidToTaxi !== contributed - quote.params.topup + satsFare)
        refuse(
            "fill_operator_payout_mismatch",
            400,
            "Taxi payout is not the reservation less the loan plus the fare",
        );
    if (quote.fare.currency === "asset" && quote.fare.units > 0n) {
        const allowed = taxiAssetIdToSwapId(quote.fare.assetId);
        if (!assetFare || assetFare.assetId !== allowed || assetFare.units !== quote.fare.units)
            refuse("fill_unpriced_fare", 400, "asset fare differs from the quoted fare");
        const funded = inputs.some((input, index) => {
            if (taxi.has(index)) return false;
            const coin = observed.get(point(input));
            return coin !== undefined && (holdings(coin).get(allowed) ?? 0n) >= assetFare!.units;
        });
        if (!funded)
            refuse("fill_unpriced_fare", 400, "asset fare is not carried by a foreign input");
    } else if (assetFare) {
        refuse("fill_unpriced_fare", 400, "pays the Taxi an asset fare it never priced");
    }

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
