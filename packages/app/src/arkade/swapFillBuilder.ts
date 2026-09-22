import { asset, type ExtendedVirtualCoin, type IWallet } from "@arkade-os/sdk";
import { type FillFunding } from "@arkade-os/swap";
import {
    bytesToHex,
    hexToBytes,
    SWAP_FILL_TEMPLATE,
    type SwapFillGraphInputWire,
    type SwapFillGraphOutputWire,
    type SwapFillGraph as ProtocolSwapFillGraph,
    type SwapFillGraphWire,
    type AssetIdValue,
} from "@arkade-taxi/protocol";
import type { SwapFillGraph as StoredSwapFillGraph } from "@arkade-taxi/db";
import { hex } from "@scure/base";
import {
    deriveJointInputs,
    deriveJointOutputs,
    JointGraphDerivationError,
} from "./jointGraphDerivation.js";
import {
    buildOfferFillPlan,
    type BuildOfferFillPlanOpts,
    type FillSponsor,
    type JointGraph,
} from "@arkade-taxi/client";

export class SwapFillBuilderError extends Error {
    readonly code = "swap_fill_build";
}

export interface SwapFillSponsorFare {
    /** With `amount`, charges in an asset. Omit both to charge in `sats` alone. */
    assetId?: AssetIdValue;
    amount?: bigint;
    script: Uint8Array;
    sats?: bigint;
}

export interface SwapFillSponsorRequest {
    coins: readonly ExtendedVirtualCoin[];
    netContributionSats: bigint;
    changeScript: Uint8Array;
    fare?: SwapFillSponsorFare;
    combineSatsFareWithChange?: boolean;
}

export interface SwapFillBuildRequest {
    offerHex: string;
    solverFund: FillFunding[];
    payoutScript?: Uint8Array;
    fundingOutpoint: { txid: string; vout: number };
    fundingTxid?: string;
    swapAddress?: string;
    assetCarrierSats?: bigint;
    sponsor?: SwapFillSponsorRequest;
}

export interface SwapFillBuilderDeps {
    wallet: IWallet;
    arkServerUrl: string;
    buildPlan?: typeof buildOfferFillPlan;
}

const TXID = /^[0-9a-fA-F]{64}$/;
const HEX = /^[0-9a-fA-F]*$/;
const DECIMAL = /^[0-9]+$/;

const txid = (value: unknown, label: string): string => {
    if (typeof value !== "string" || !TXID.test(value))
        throw new SwapFillBuilderError(`${label} must be a 32-byte hex transaction id`);
    return value.toLowerCase();
};

const vout = (value: unknown, label: string): number => {
    if (
        typeof value !== "number" ||
        !Number.isSafeInteger(value) ||
        value < 0 ||
        value > 0xffffffff
    )
        throw new SwapFillBuilderError(`${label} must be a non-negative output index`);
    return value;
};

const script = (value: unknown, label: string): Uint8Array => {
    if (!(value instanceof Uint8Array) || !value.length)
        throw new SwapFillBuilderError(`${label} must be a non-empty output script`);
    return value;
};

// Taxi refs carry the genesis txid in internal byte order while the SDK
// AssetId string form uses display order, so both directions reverse.
export function taxiAssetIdToSwapId(id: AssetIdValue): string {
    if (!(id.txid instanceof Uint8Array) || id.txid.length !== 32)
        throw new SwapFillBuilderError("sponsor.fare.assetId.txid must be 32 bytes");
    if (!Number.isSafeInteger(id.groupIndex) || id.groupIndex < 0)
        throw new SwapFillBuilderError("sponsor.fare.assetId.groupIndex must be non-negative");
    try {
        return asset.AssetId.create(
            hex.encode(Uint8Array.from(id.txid).reverse()),
            id.groupIndex,
        ).toString();
    } catch (cause) {
        throw new SwapFillBuilderError(
            `invalid sponsor fare asset id: ${(cause as Error).message}`,
        );
    }
}

export function swapIdToTaxiAssetId(id: string): AssetIdValue {
    let parsed: ReturnType<typeof asset.AssetId.fromString>;
    try {
        parsed = asset.AssetId.fromString(id);
    } catch {
        throw new SwapFillBuilderError("swap asset id is not a valid asset id string");
    }
    return { txid: Uint8Array.from(parsed.txid).reverse(), groupIndex: parsed.groupIndex };
}

const mapSponsorFund = (coins: readonly ExtendedVirtualCoin[]): FillFunding[] => {
    if (!coins.length) throw new SwapFillBuilderError("sponsor needs coins to contribute with");
    return coins.map((coin, i) => {
        if ((coin.assets?.length ?? 0) > 0)
            throw new SwapFillBuilderError(
                `sponsor.fund[${i}] carries assets — sponsor funding is sats-only`,
            );
        if (!coin.tapTree || !coin.forfeitTapLeafScript)
            throw new SwapFillBuilderError(`sponsor.fund[${i}] is missing taproot evidence`);
        return {
            txid: txid(coin.txid, `sponsor.fund[${i}].txid`),
            vout: vout(coin.vout, `sponsor.fund[${i}].vout`),
            value: coin.value,
            tapTree: coin.tapTree,
            tapLeafScript: coin.forfeitTapLeafScript,
        } as FillFunding;
    });
};

const mapSponsor = (sponsor: SwapFillSponsorRequest): FillSponsor => {
    if (typeof sponsor.netContributionSats !== "bigint" || sponsor.netContributionSats <= 0n)
        throw new SwapFillBuilderError("sponsor.netContributionSats must be positive");
    script(sponsor.changeScript, "sponsor.changeScript");
    const out: FillSponsor = {
        fund: mapSponsorFund(sponsor.coins),
        netContributionSats: sponsor.netContributionSats,
        changeScript: sponsor.changeScript,
        ...(sponsor.combineSatsFareWithChange === undefined
            ? {}
            : { combineSatsFareWithChange: sponsor.combineSatsFareWithChange }),
    };
    if (
        sponsor.combineSatsFareWithChange !== undefined &&
        typeof sponsor.combineSatsFareWithChange !== "boolean"
    )
        throw new SwapFillBuilderError("sponsor.combineSatsFareWithChange must be a boolean");
    if (sponsor.fare) {
        const { assetId, amount, sats } = sponsor.fare;
        if ((assetId === undefined) !== (amount === undefined))
            throw new SwapFillBuilderError(
                "sponsor.fare needs assetId and amount together, or neither for a sats fare",
            );
        if (amount !== undefined && (typeof amount !== "bigint" || amount <= 0n))
            throw new SwapFillBuilderError("sponsor.fare.amount must be positive");
        // A sats fare IS its sats, so it cannot fall back to the carrier default.
        if (assetId === undefined && (typeof sats !== "bigint" || sats <= 0n))
            throw new SwapFillBuilderError("a sats fare needs a positive sponsor.fare.sats");
        script(sponsor.fare.script, "sponsor.fare.script");
        out.fare = {
            ...(assetId !== undefined
                ? { assetId: taxiAssetIdToSwapId(assetId), amount: amount! }
                : {}),
            script: sponsor.fare.script,
            ...(sats !== undefined ? { sats } : {}),
        };
    }
    return out;
};

// Build-only: returns an unsigned, unauthorized JointGraph. The caller must
// compare it against Taxi's own trusted graph before signing (subtask C);
// verifyOfferFillPlan alone never authorizes.
export async function buildSwapFillGraph(
    deps: SwapFillBuilderDeps,
    req: SwapFillBuildRequest,
): Promise<JointGraph> {
    if (!deps.wallet?.identity)
        throw new SwapFillBuilderError("operator wallet with a signing identity is required");
    if (typeof deps.arkServerUrl !== "string" || !deps.arkServerUrl)
        throw new SwapFillBuilderError("arkServerUrl is required");
    if (typeof req.offerHex !== "string" || !req.offerHex)
        throw new SwapFillBuilderError("offerHex is required");
    if (!req.solverFund?.length)
        throw new SwapFillBuilderError("solver fund is required to pay the maker");
    req.solverFund.forEach((coin, i) => {
        txid(coin.txid, `solverFund[${i}].txid`);
        vout(coin.vout, `solverFund[${i}].vout`);
        if (!coin.tapTree || !coin.tapLeafScript)
            throw new SwapFillBuilderError(`solverFund[${i}] is missing taproot evidence`);
    });
    const fundingOutpoint = {
        txid: txid(req.fundingOutpoint?.txid, "fundingOutpoint.txid"),
        vout: vout(req.fundingOutpoint?.vout, "fundingOutpoint.vout"),
    };
    if (req.fundingTxid !== undefined && req.fundingTxid.toLowerCase() !== fundingOutpoint.txid)
        throw new SwapFillBuilderError(
            `fundingTxid ${req.fundingTxid} does not match fundingOutpoint ${fundingOutpoint.txid}:${fundingOutpoint.vout}`,
        );
    const opts: BuildOfferFillPlanOpts = {
        fund: req.solverFund,
        ...(req.payoutScript !== undefined ? { payoutScript: req.payoutScript } : {}),
        ...(req.fundingTxid !== undefined ? { fundingTxid: req.fundingTxid } : {}),
        fundingOutpoint,
        ...(req.swapAddress !== undefined ? { swapAddress: req.swapAddress } : {}),
        ...(req.assetCarrierSats !== undefined ? { assetCarrierSats: req.assetCarrierSats } : {}),
        ...(req.sponsor !== undefined ? { sponsor: mapSponsor(req.sponsor) } : {}),
    };
    return (deps.buildPlan ?? buildOfferFillPlan)(
        deps.wallet,
        deps.arkServerUrl,
        req.offerHex,
        opts,
    );
}

const OWNERS: readonly string[] = ["offer-covenant", "solver", "sponsor"];
const ROLES: readonly string[] = ["receiver", "solver", "sponsor-fare", "sponsor-change"];

const wireTxid = (value: unknown, label: string): string => txid(value, label);
const wireVout = (value: unknown, label: string): number => vout(value, label);

const wireBase64 = (value: unknown, label: string): string => {
    if (
        typeof value !== "string" ||
        !value.length ||
        !/^[A-Za-z0-9+/]*={0,2}$/.test(value) ||
        value.length % 4 !== 0
    )
        throw new SwapFillBuilderError(`${label} must be base64`);
    return value;
};

const wireHex = (value: unknown, label: string, allowEmpty: boolean): string => {
    if (
        typeof value !== "string" ||
        value.length % 2 !== 0 ||
        (!allowEmpty && !value.length) ||
        !HEX.test(value) ||
        value !== value.toLowerCase()
    )
        throw new SwapFillBuilderError(`${label} must be lowercase hex`);
    return value;
};

const wireAmount = (value: unknown, label: string): string => {
    if (typeof value !== "string" || !DECIMAL.test(value))
        throw new SwapFillBuilderError(`${label} must be a decimal amount string`);
    return value;
};

const swapAssetFromWire = (value: unknown, label: string): string => {
    if (!value || typeof value !== "object" || Array.isArray(value))
        throw new SwapFillBuilderError(`${label} must be an asset id`);
    const { txid: rawTxid, groupIndex } = value as { txid: unknown; groupIndex: unknown };
    const txidHex = wireHex(rawTxid, `${label}.txid`, false);
    if (txidHex.length !== 64) throw new SwapFillBuilderError(`${label}.txid must be 32 bytes`);
    if (typeof groupIndex !== "number" || !Number.isSafeInteger(groupIndex) || groupIndex < 0)
        throw new SwapFillBuilderError(`${label}.groupIndex must be non-negative`);
    try {
        return taxiAssetIdToSwapId({ txid: hex.decode(txidHex), groupIndex });
    } catch {
        throw new SwapFillBuilderError(`${label} must be an asset id`);
    }
};

export interface SwapFillWireScripts {
    receiverScript: Uint8Array;
    solverScript: Uint8Array;
    sponsorScript: Uint8Array;
    /**
     * Set when the fare is priced in sats. Such a fare pays the sponsor script
     * carrying no assets, exactly as change does, so nothing about the output
     * tells them apart — the assembly order does: fare first, then change.
     */
    expectSatsFare?: boolean;
}

const sameScript = (a: Uint8Array, b: Uint8Array): boolean =>
    a.length === b.length && a.every((byte, i) => byte === b[i]);

// The wire is a view of the transaction, never a second claim about it:
// inputs, scripts, sats and asset units all come out of arkTx, and roles are
// Taxi's labels for Taxi-known scripts at the quoting site.
export function jointGraphToWire(
    graph: JointGraph,
    scripts: SwapFillWireScripts,
): SwapFillGraphWire {
    if (!graph || typeof graph !== "object" || Array.isArray(graph))
        throw new SwapFillBuilderError("graph must be an object");
    if (sameScript(scripts.sponsorScript, scripts.solverScript))
        throw new SwapFillBuilderError("sponsor and solver scripts are ambiguous");
    let inputs;
    let outputs;
    try {
        inputs = deriveJointInputs(graph);
        outputs = deriveJointOutputs(graph);
    } catch (cause) {
        if (cause instanceof JointGraphDerivationError)
            throw new SwapFillBuilderError(cause.message, { cause });
        throw cause;
    }
    if (!inputs.length) throw new SwapFillBuilderError("graph.inputs must be non-empty");
    if (!outputs.length) throw new SwapFillBuilderError("graph.outputs must be non-empty");
    if (!/^[0-9a-f]{64}$/.test(graph.graphId))
        throw new SwapFillBuilderError("graph.graphId must be 32-byte lowercase hex");
    if (graph.checkpoints.length !== inputs.length)
        throw new SwapFillBuilderError("graph inputOwners and checkpoints must agree");
    if (!sameScript(outputs[0]!.script, scripts.receiverScript))
        throw new SwapFillBuilderError("graph output 0 does not pay the maker");
    let satsFarePending = scripts.expectSatsFare === true;
    return {
        arkTx: wireBase64(graph.arkTx, "graph.arkTx"),
        checkpoints: graph.checkpoints.map((c, i) => wireBase64(c, `graph.checkpoints[${i}]`)),
        graphId: graph.graphId,
        template: SWAP_FILL_TEMPLATE,
        inputs: inputs.map((input, i) => {
            const owner = input.owner === null ? "offer-covenant" : input.owner;
            if (!OWNERS.includes(owner))
                throw new SwapFillBuilderError(`graph.inputs[${i}].owner is unknown`);
            return {
                owner: owner as SwapFillGraphInputWire["owner"],
                txid: wireTxid(input.txid, `graph.inputs[${i}].txid`),
                vout: wireVout(input.vout, `graph.inputs[${i}].vout`),
            };
        }),
        outputs: outputs.map((output, i) => {
            const satsFareHere =
                satsFarePending &&
                i !== 0 &&
                !output.assets.length &&
                sameScript(output.script, scripts.sponsorScript);
            if (satsFareHere) satsFarePending = false;
            const role =
                i === 0
                    ? "receiver"
                    : sameScript(output.script, scripts.sponsorScript)
                      ? output.assets.length || satsFareHere
                          ? "sponsor-fare"
                          : "sponsor-change"
                      : sameScript(output.script, scripts.solverScript)
                        ? "solver"
                        : undefined;
            if (role === undefined || !ROLES.includes(role))
                throw new SwapFillBuilderError(
                    `graph.outputs[${i}] pays a script no fill party owns`,
                );
            return {
                role: role as SwapFillGraphOutputWire["role"],
                vout: wireVout(output.vout, `graph.outputs[${i}].vout`),
                script: hex.encode(output.script).toLowerCase(),
                sats: output.sats.toString(10),
                assets: output.assets.map((a, j) => {
                    const ref = swapIdToTaxiAssetId(a.assetId);
                    return {
                        assetId: { txid: hex.encode(ref.txid), groupIndex: ref.groupIndex },
                        units: a.units.toString(10),
                    };
                }),
            };
        }),
    };
}

export function jointGraphFromWire(wire: SwapFillGraphWire): JointGraph {
    if (!wire || typeof wire !== "object" || Array.isArray(wire))
        throw new SwapFillBuilderError("graph must be an object");
    if (wire.template !== SWAP_FILL_TEMPLATE)
        throw new SwapFillBuilderError("graph.template must be taxi-fill/1");
    if (!Array.isArray(wire.inputs) || !wire.inputs.length)
        throw new SwapFillBuilderError("graph.inputs must be non-empty");
    if (!Array.isArray(wire.outputs) || !wire.outputs.length)
        throw new SwapFillBuilderError("graph.outputs must be non-empty");
    if (!/^[0-9a-f]{64}$/.test(wire.graphId))
        throw new SwapFillBuilderError("graph.graphId must be 32-byte lowercase hex");
    if (wire.checkpoints.length !== wire.inputs.length)
        throw new SwapFillBuilderError("graph inputs and checkpoints must agree");
    const inputOwners = wire.inputs.map((input, i) => {
        if (!OWNERS.includes(input.owner))
            throw new SwapFillBuilderError(`graph.inputs[${i}].owner is unknown`);
        wireTxid(input.txid, `graph.inputs[${i}].txid`);
        wireVout(input.vout, `graph.inputs[${i}].vout`);
        return input.owner === "offer-covenant" ? null : input.owner;
    });
    let derivedInputs;
    let derivedOutputs;
    try {
        derivedInputs = deriveJointInputs({ arkTx: wire.arkTx, inputOwners });
        derivedOutputs = deriveJointOutputs({ arkTx: wire.arkTx });
    } catch (cause) {
        if (cause instanceof JointGraphDerivationError)
            throw new SwapFillBuilderError(cause.message, { cause });
        throw cause;
    }
    derivedInputs.forEach((derived, i) => {
        const claimed = wire.inputs[i]!;
        const owner = derived.owner === null ? "offer-covenant" : derived.owner;
        if (
            owner !== claimed.owner ||
            derived.txid !== claimed.txid.toLowerCase() ||
            derived.vout !== claimed.vout
        )
            throw new SwapFillBuilderError(`graph.inputs[${i}] disagrees with the transaction`);
    });
    if (derivedOutputs.length !== wire.outputs.length)
        throw new SwapFillBuilderError("graph.outputs disagree with the transaction");
    if (wire.outputs[0]!.role !== "receiver")
        throw new SwapFillBuilderError("graph.outputs[0] must be the receiver");
    wire.outputs.forEach((claimed, i) => {
        if (!ROLES.includes(claimed.role))
            throw new SwapFillBuilderError(`graph.outputs[${i}].role is unknown`);
        const derived = derivedOutputs[i]!;
        if (derived.vout !== wireVout(claimed.vout, `graph.outputs[${i}].vout`))
            throw new SwapFillBuilderError(`graph.outputs[${i}] disagrees with the transaction`);
        if (hex.encode(derived.script).toLowerCase() !== claimed.script.toLowerCase())
            throw new SwapFillBuilderError(`graph.outputs[${i}] disagrees with the transaction`);
        if (derived.sats !== BigInt(wireAmount(claimed.sats, `graph.outputs[${i}].sats`)))
            throw new SwapFillBuilderError(`graph.outputs[${i}] disagrees with the transaction`);
        const want = [...derived.assets]
            .map((a) => ({ assetId: a.assetId, units: a.units }))
            .sort((a, b) => (a.assetId < b.assetId ? -1 : a.assetId > b.assetId ? 1 : 0));
        const got = (claimed.assets ?? [])
            .map((a, j) => ({
                assetId: swapAssetFromWire(a.assetId, `graph.outputs[${i}].assets[${j}].assetId`),
                units: BigInt(wireAmount(a.units, `graph.outputs[${i}].assets[${j}].units`)),
            }))
            .sort((a, b) => (a.assetId < b.assetId ? -1 : a.assetId > b.assetId ? 1 : 0));
        if (
            want.length !== got.length ||
            want.some((a, k) => a.assetId !== got[k]!.assetId || a.units !== got[k]!.units)
        )
            throw new SwapFillBuilderError(`graph.outputs[${i}] disagrees with the transaction`);
    });
    return {
        arkTx: wireBase64(wire.arkTx, "graph.arkTx"),
        checkpoints: wire.checkpoints.map((c, i) => wireBase64(c, `graph.checkpoints[${i}]`)),
        graphId: wire.graphId,
        inputOwners,
    };
}

export function jointGraphToStored(graph: JointGraph): StoredSwapFillGraph {
    return {
        arkTx: graph.arkTx,
        checkpoints: [...graph.checkpoints],
        graphId: hexToBytes(graph.graphId, "graph.graphId"),
        inputOwners: [...graph.inputOwners],
    };
}

export function storedGraphToJoint(graph: StoredSwapFillGraph): JointGraph {
    return {
        arkTx: graph.arkTx,
        checkpoints: [...graph.checkpoints],
        graphId: bytesToHex(graph.graphId),
        inputOwners: [...graph.inputOwners],
    };
}

export function protocolGraphToStored(graph: ProtocolSwapFillGraph): StoredSwapFillGraph {
    return {
        arkTx: graph.arkTx,
        checkpoints: [...graph.checkpoints],
        graphId: Uint8Array.from(graph.graphId),
        inputOwners: graph.inputs.map((input) =>
            input.owner === "offer-covenant" ? null : input.owner,
        ),
    };
}
