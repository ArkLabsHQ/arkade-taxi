import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import {
    asset,
    ArkAddress,
    Extension,
    UnknownPacket,
    buildOffchainTx,
    VtxoScript,
    type CSVMultisigTapscript,
    type Transaction,
} from "@arkade-os/sdk";
import type { FareSpec } from "@arkade-taxi/core";
import type { AssetIdRef } from "@arkade-taxi/covenant";
import { fundingInputToWire, type FundingInputValue } from "@arkade-taxi/protocol";
import { base64, hex } from "@scure/base";
import type { RuntimeConfig } from "../config.js";
import type { FundingSelection } from "./inventory.js";
import { LockupShapeError, assertDistinctScripts } from "../lockup.js";
import { encodeLockupEnvelope, parseJointEnvelope, type JointPlan } from "./psbt.js";
import { inputAssets, operatorFundingInput, toArkInput } from "./lockupBuilder.js";
const { AssetGroup, AssetId, AssetInput, AssetOutput, Packet } = asset;

/** Joint-send terms without a covenant. `contribution` plays the role of the
 * covenant `topup`: sats the operator fronts toward the receiver's dust
 * carrier. There is no locktime because there is no recovery leaf. */
export interface SponsoredParams {
    receiverKey: Uint8Array;
    senderKey: Uint8Array;
    operatorKey: Uint8Array;
    dust: bigint;
    contribution: bigint;
    assetId?: AssetIdRef;
    /** Sender-declared extra extension packet; see SponsoredQuoteParams. */
    extraPacket?: { type: number; payload: Uint8Array };
}

export interface SponsoredBuildRequest {
    senderInputs: FundingInputValue[];
    assetUnits?: bigint;
    funding: FundingSelection;
    advanceId: string;
    params: SponsoredParams;
    /** Bob's full canonical address. The payment output pays it directly. */
    receiverAddress: string;
    /** A separate output at submission, as with the covenant flow: a sats fare
     * is an operator-funded self-payment, an asset fare is sender-funded and
     * the operator supplies its hosting sats. */
    fare: FareSpec;
    senderSats: bigint;
}

export interface SponsoredOutput {
    role: "payment" | "operator-fare" | "sender-change" | "operator-change";
    script: Uint8Array;
    amount: bigint;
}

function ownerOutputScript(key: Uint8Array, amount: bigint, config: RuntimeConfig): Uint8Array {
    const address = new ArkAddress(config.serverPubkey, key, config.addressHrp);
    return amount < config.dust ? address.subdustPkScript : address.pkScript;
}

function receiverAddress(req: SponsoredBuildRequest, config: RuntimeConfig): ArkAddress {
    let address: ArkAddress;
    try {
        address = ArkAddress.decode(req.receiverAddress);
    } catch {
        throw new LockupShapeError("receiver address is invalid");
    }
    if (address.encode() !== req.receiverAddress)
        throw new LockupShapeError("receiver address is not canonical");
    if (address.hrp !== config.addressHrp)
        throw new LockupShapeError("receiver address uses the wrong network");
    if (!isDeepStrictEqual(address.serverPubKey, config.serverPubkey))
        throw new LockupShapeError("receiver address names the wrong Arkade server key");
    if (!isDeepStrictEqual(address.vtxoTaprootKey, req.params.receiverKey))
        throw new LockupShapeError("receiver key differs from receiver address");
    return address;
}

export function sponsoredPlan(req: SponsoredBuildRequest, config: RuntimeConfig) {
    if (!isDeepStrictEqual(req.params.operatorKey, config.operatorKey))
        throw new LockupShapeError("operator payout differs from runtime configuration");
    if (req.params.dust !== config.dust)
        throw new LockupShapeError("payment dust differs from runtime configuration");
    if (req.params.contribution < config.vtxoMinAmount || req.params.contribution > req.params.dust)
        throw new LockupShapeError("operator contribution is outside the dust window");
    if (req.fare.units < 0n) throw new LockupShapeError("negative fare");
    const operatorInputs = req.funding.inputs.map(operatorFundingInput);
    const inputs = [...req.senderInputs, ...operatorInputs];
    if (!req.senderInputs.length || !operatorInputs.length)
        throw new LockupShapeError("both funding owners required");
    if (
        new Set(inputs.map((input) => input.expiry.kind)).size !== 1 ||
        inputs.some((input) => input.expiry.value <= 0n)
    )
        throw new LockupShapeError("inconsistent funding expiry evidence");
    if (new Set(inputs.map((i) => `${i.txid}:${i.vout}`)).size !== inputs.length)
        throw new LockupShapeError("duplicate funding outpoint");
    if (req.senderInputs.reduce((sum, i) => sum + i.value, 0n) !== req.senderSats)
        throw new LockupShapeError("senderSats differs from funding inputs");
    if (operatorInputs.reduce((sum, i) => sum + i.value, 0n) !== req.funding.totalValue)
        throw new LockupShapeError("operator funding total differs");
    const receiver = receiverAddress(req, config);
    const assets = inputs.map(inputAssets);
    const totals = new Map<string, bigint>();
    for (const holdings of assets)
        for (const [id, amount] of holdings) totals.set(id, (totals.get(id) ?? 0n) + amount);
    const outputs: SponsoredOutput[] = [
        { role: "payment", script: Uint8Array.from(receiver.pkScript), amount: req.params.dust },
    ];
    const fareHosting =
        req.fare.units === 0n
            ? 0n
            : req.fare.currency === "sats"
              ? req.fare.units
              : config.vtxoMinAmount;
    if (fareHosting > 0n)
        outputs.push({
            role: "operator-fare",
            amount: fareHosting,
            script: ownerOutputScript(req.params.operatorKey, fareHosting, config),
        });
    const senderChange = req.senderSats + req.params.contribution - req.params.dust;
    const operatorChange = req.funding.totalValue - req.params.contribution - fareHosting;
    if (senderChange < 0n || operatorChange < 0n)
        throw new LockupShapeError("insufficient funding");
    const destinations = new Map<string, Map<number, bigint>>();
    const toId = (id: { txid: Uint8Array; groupIndex: number }) =>
        AssetId.create(hex.encode(Uint8Array.from(id.txid).reverse()), id.groupIndex).toString();
    const paymentId = req.params.assetId ? toId(req.params.assetId) : undefined;
    const fareId = req.fare.currency === "asset" ? toId(req.fare.assetId) : undefined;
    if (paymentId && !totals.has(paymentId))
        throw new LockupShapeError("payment asset missing from sender inputs");
    let needsAssetChange = false;
    for (const [id, total] of totals) {
        const fare = id === fareId ? req.fare.units : 0n;
        if (total < fare) throw new LockupShapeError("asset fare exceeds funding");
        const target = new Map<number, bigint>();
        if (fare) target.set(1, fare);
        const payment = id === paymentId ? (req.assetUnits ?? total - fare) : 0n;
        if (payment < 0n || payment + fare > total || (id === paymentId && payment === 0n))
            throw new LockupShapeError("invalid payment asset units");
        if (payment) target.set(0, payment);
        if (total > fare + payment) needsAssetChange = true;
        destinations.set(id, target);
    }
    if (fareId && req.fare.units && !totals.has(fareId))
        throw new LockupShapeError("fare asset missing");
    if (needsAssetChange && senderChange < config.vtxoMinAmount)
        throw new LockupShapeError("asset change lacks the Arkade Service minimum hosting sats");
    if (senderChange > 0n || needsAssetChange) {
        const index = outputs.length;
        outputs.push({
            role: "sender-change",
            amount: senderChange,
            script: ownerOutputScript(
                VtxoScript.decode(req.senderInputs[0].tapTree).tweakedPublicKey,
                senderChange,
                config,
            ),
        });
        for (const [id, total] of totals) {
            const change =
                total - [...destinations.get(id)!.values()].reduce((sum, n) => sum + n, 0n);
            if (change) destinations.get(id)!.set(index, change);
        }
    }
    if (operatorChange > 0n)
        outputs.push({
            role: "operator-change",
            amount: operatorChange,
            script: ownerOutputScript(
                VtxoScript.decode(operatorInputs[0].tapTree).tweakedPublicKey,
                operatorChange,
                config,
            ),
        });
    for (const output of outputs) {
        if (output.amount < config.vtxoMinAmount)
            throw new LockupShapeError(
                `${output.role} output is below the Arkade Service minimum ${config.vtxoMinAmount}`,
            );
    }
    assertDistinctScripts(outputs);
    if (
        outputs.reduce((sum, o) => sum + o.amount, 0n) !==
        inputs.reduce((sum, i) => sum + i.value, 0n)
    )
        throw new LockupShapeError("sats do not balance");
    const groups = [...totals]
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([id, total]) => {
            const allocation = destinations.get(id)!;
            if ([...allocation.values()].reduce((sum, n) => sum + n, 0n) !== total)
                throw new LockupShapeError("assets do not balance");
            return AssetGroup.create(
                AssetId.fromString(id),
                null,
                assets.flatMap((holdings, vin) =>
                    holdings.has(id) ? [AssetInput.create(vin, holdings.get(id)!)] : [],
                ),
                [...allocation]
                    .sort(([a], [b]) => a - b)
                    .map(([vout, amount]) => AssetOutput.create(vout, amount)),
                [],
            );
        });
    const transactionOutputs = outputs.map(({ amount, script }) => ({ amount, script }));
    // Mirrors the sender's rebuild in client/src/sponsored.ts: the packet it
    // declared rides after the asset groups. Any other order or contents and the
    // sender's byte comparison refuses the transaction.
    const extraPacket = req.params.extraPacket;
    const packets = [
        ...(groups.length ? [Packet.create(groups)] : []),
        ...(extraPacket !== undefined
            ? [new UnknownPacket(extraPacket.type, extraPacket.payload)]
            : []),
    ];
    if (packets.length) transactionOutputs.push(Extension.create(packets).txOut());
    if (transactionOutputs.filter((output) => output.script[0] === 0x6a).length > 2)
        throw new LockupShapeError(
            "the public SDK supports at most two OP_RETURN outputs; this payment requires more",
        );
    const joint: JointPlan = {
        inputs,
        operatorInputs,
        outputs: transactionOutputs,
        valueOutputs: outputs,
        assetUnits: paymentId ? destinations.get(paymentId)!.get(0)! : req.assetUnits,
        arkInputs: inputs.map((input, i) =>
            toArkInput(
                input,
                i < req.senderInputs.length ? req.params.senderKey : config.operatorSignerKey,
                config.serverPubkey,
            ),
        ),
    };
    return { ...joint, receiver };
}

export function sponsoredGraphId(tx: Transaction, checkpoints: Transaction[]): string {
    const hash = createHash("sha256");
    hash.update("arkade-taxi-sponsored-v1\0");
    hash.update(tx.toPSBT());
    for (const checkpoint of checkpoints) hash.update(hex.decode(checkpoint.id));
    return hash.digest("hex");
}

export function buildSponsoredEnvelope(
    req: SponsoredBuildRequest,
    config: RuntimeConfig,
    unroll: CSVMultisigTapscript.Type,
): string {
    const plan = sponsoredPlan(req, config);
    const graph = buildOffchainTx(plan.arkInputs, plan.outputs, unroll);
    return encodeLockupEnvelope({
        arkTx: base64.encode(graph.arkTx.toPSBT()),
        checkpoints: graph.checkpoints.map((tx) => base64.encode(tx.toPSBT())),
        ...(plan.assetUnits !== undefined ? { assetUnits: plan.assetUnits.toString() } : {}),
        unsignedTxId: sponsoredGraphId(graph.arkTx, graph.checkpoints),
        covenantOutputIndex: 0,
        senderInputIndexes: req.senderInputs.map((_, i) => i),
        operatorInputIndexes: plan.operatorInputs.map((_, i) => req.senderInputs.length + i),
        senderInputs: req.senderInputs.map(fundingInputToWire),
        operatorInputs: plan.operatorInputs.map(fundingInputToWire),
        serverUnrollScript: hex.encode(unroll.script),
    });
}

export function parseSponsoredEnvelope(
    encoded: string,
    req: SponsoredBuildRequest,
    config: RuntimeConfig,
    unroll: CSVMultisigTapscript.Type,
) {
    const plan = sponsoredPlan(req, config);
    return parseJointEnvelope(
        encoded,
        {
            senderInputs: req.senderInputs,
            operatorKey: req.params.operatorKey,
            plan,
            paymentOutputIndex: 0,
            paymentIndexLabel: "payment index",
            unsignedId: sponsoredGraphId,
            skipScriptCheck: (role) => role === "payment",
            verifyPaymentOutput: (tx) => {
                const script = tx.getOutput(0).script;
                if (!script || !isDeepStrictEqual(script, plan.receiver.pkScript))
                    throw new LockupShapeError("lockup payment output mismatch");
            },
        },
        config,
        unroll,
    );
}
