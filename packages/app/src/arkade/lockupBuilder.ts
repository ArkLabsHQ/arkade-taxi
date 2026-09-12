import {
    asset,
    ArkAddress,
    Extension,
    buildOffchainTx,
    VtxoScript,
    MultisigTapscript,
    scriptFromTapLeafScript,
    type CSVMultisigTapscript,
    type ArkTxInput,
    type ExtendedVirtualCoin,
} from "@arkade-os/sdk";
import { DustCovenantScript } from "@arkade-taxi/covenant";
import { fundingInputToWire, type FundingInputValue } from "@arkade-taxi/protocol";
import { base64, hex } from "@scure/base";
import type { RuntimeConfig } from "../config.js";
import type { LockupBuilder, LockupBuildRequest } from "../quotes.js";
import { normalizeExpiry } from "./providers.js";
import { LockupShapeError, assertDistinctScripts, type LockupOutput } from "../lockup.js";
import { encodeLockupEnvelope, parseLockupEnvelope, unsignedGraphId } from "./psbt.js";
import { isDeepStrictEqual } from "node:util";
const { AssetGroup, AssetId, AssetInput, AssetOutput, Packet } = asset;

function ownerOutputScript(key: Uint8Array, amount: bigint, config: RuntimeConfig): Uint8Array {
    const address = new ArkAddress(config.serverPubkey, key, config.addressHrp);
    return amount < config.dust ? address.subdustPkScript : address.pkScript;
}

export function operatorFundingInput(coin: ExtendedVirtualCoin): FundingInputValue {
    if (coin.assets?.length) throw new LockupShapeError("operator asset inputs are not selectable");
    const input = {
        txid: coin.txid,
        vout: coin.vout,
        value: BigInt(coin.value),
        tapTree: coin.tapTree,
        spendLeaf: scriptFromTapLeafScript(coin.forfeitTapLeafScript),
        expiry: normalizeExpiry(coin),
    };
    fundingInputToWire(input);
    const tree = VtxoScript.decode(input.tapTree);
    if (!isDeepStrictEqual(tree.findLeaf(hex.encode(input.spendLeaf)), coin.forfeitTapLeafScript))
        throw new LockupShapeError("operator leaf proof differs from tap tree");
    if (hex.encode(tree.pkScript) !== coin.script)
        throw new LockupShapeError("operator prevout script differs from tap tree");
    return input;
}

export function inputAssets(input: FundingInputValue): Map<string, bigint> {
    const result = new Map<string, bigint>();
    if (!input.assetPacket) return result;
    const packet = Packet.fromBytes(input.assetPacket);
    if (hex.encode(packet.serialize()) !== hex.encode(input.assetPacket))
        throw new LockupShapeError("noncanonical asset packet");
    for (const group of packet.groups) {
        if (!group.assetId || group.controlAsset)
            throw new LockupShapeError("funding packet must carry existing assets");
        const id = group.assetId.toString();
        if (result.has(id)) throw new LockupShapeError("duplicate asset group");
        const outputs = group.outputs.filter((o) => o.vout === input.vout);
        if (outputs.length > 1) throw new LockupShapeError("duplicate asset output");
        if (outputs.length) result.set(id, outputs[0].amount);
    }
    const canonical = Packet.create(
        [...result]
            .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
            .map(([id, amount]) =>
                AssetGroup.create(
                    AssetId.fromString(id),
                    null,
                    [],
                    [AssetOutput.create(input.vout, amount)],
                    [],
                ),
            ),
    );
    if (hex.encode(canonical.serialize()) !== hex.encode(input.assetPacket))
        throw new LockupShapeError("funding asset packet must be a canonical holdings snapshot");
    return result;
}

export function toArkInput(
    input: FundingInputValue,
    owner: Uint8Array,
    server: Uint8Array,
): ArkTxInput {
    fundingInputToWire(input);
    const tree = VtxoScript.decode(input.tapTree);
    const leaf = tree.findLeaf(hex.encode(input.spendLeaf));
    const closure = MultisigTapscript.decode(input.spendLeaf);
    const keys = closure.params.pubkeys.map((key) => hex.encode(key)).sort();
    if (JSON.stringify(keys) !== JSON.stringify([hex.encode(owner), hex.encode(server)].sort()))
        throw new LockupShapeError("funding leaf must require exactly owner and Arkade Service");
    return {
        txid: input.txid,
        vout: input.vout,
        value: Number(input.value),
        tapTree: input.tapTree,
        tapLeafScript: leaf,
    };
}

export function lockupPlan(req: LockupBuildRequest, config: RuntimeConfig) {
    const operatorInputs = req.funding.inputs.map(operatorFundingInput);
    const inputs = [...req.senderInputs, ...operatorInputs];
    if (!req.senderInputs.length || !operatorInputs.length)
        throw new LockupShapeError("both funding owners required");
    if (
        inputs.some(
            (input) =>
                input.expiry.kind !== req.funding.batchExpiry.kind ||
                input.expiry.value <= req.params.locktime,
        ) ||
        operatorInputs.reduce(
            (minimum, input) => (input.expiry.value < minimum ? input.expiry.value : minimum),
            operatorInputs[0].expiry.value,
        ) !== req.funding.batchExpiry.value ||
        (req.funding.batchExpiry.kind === "time") !== req.params.locktime >= 500_000_000n
    )
        throw new LockupShapeError("inconsistent funding expiry evidence");
    if (new Set(inputs.map((i) => `${i.txid}:${i.vout}`)).size !== inputs.length)
        throw new LockupShapeError("duplicate funding outpoint");
    if (req.senderInputs.reduce((sum, i) => sum + i.value, 0n) !== req.senderSats)
        throw new LockupShapeError("senderSats differs from funding inputs");
    if (operatorInputs.reduce((sum, i) => sum + i.value, 0n) !== req.funding.totalValue)
        throw new LockupShapeError("operator funding total differs");
    const covenant = new DustCovenantScript({
        params: req.params,
        serverKey: config.serverPubkey,
        emulatorKey: config.emulatorPubkey,
        vtxoMinAmount: config.vtxoMinAmount,
    });
    if (covenant.address(config.addressHrp, config.serverPubkey).encode() !== req.covenantAddress)
        throw new LockupShapeError("covenant address differs from parameters");
    const assets = inputs.map(inputAssets);
    const totals = new Map<string, bigint>();
    for (const holdings of assets)
        for (const [id, amount] of holdings) totals.set(id, (totals.get(id) ?? 0n) + amount);
    const outputs: LockupOutput[] = [
        { role: "covenant", script: covenant.pkScript, amount: req.params.dust },
    ];
    const fareHosting =
        req.fare.units === 0n
            ? 0n
            : req.fare.currency === "sats"
              ? req.fare.units
              : config.vtxoMinAmount;
    if (req.fare.units < 0n) throw new LockupShapeError("negative fare");
    if (fareHosting > 0n)
        outputs.push({
            role: "operator-fare",
            amount: fareHosting,
            script: ownerOutputScript(req.params.operatorKey, fareHosting, config),
        });
    const senderChange = req.senderSats + req.params.topup - req.params.dust;
    const operatorChange = req.funding.totalValue - req.params.topup - fareHosting;
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
    if (groups.length) transactionOutputs.push(Extension.create([Packet.create(groups)]).txOut());
    if (transactionOutputs.filter((output) => output.script[0] === 0x6a).length > 2)
        throw new LockupShapeError(
            "the public SDK supports at most two OP_RETURN outputs; this lockup requires more",
        );
    return {
        inputs,
        operatorInputs,
        outputs: transactionOutputs,
        valueOutputs: outputs,
        covenant,
        assetUnits: paymentId ? destinations.get(paymentId)!.get(0)! : req.assetUnits,
        arkInputs: inputs.map((input, i) =>
            toArkInput(
                input,
                i < req.senderInputs.length ? req.params.senderKey : req.params.operatorKey,
                config.serverPubkey,
            ),
        ),
    };
}

export function buildLockupEnvelope(
    req: LockupBuildRequest,
    config: RuntimeConfig,
    unroll: CSVMultisigTapscript.Type,
): string {
    const plan = lockupPlan(req, config);
    const graph = buildOffchainTx(plan.arkInputs, plan.outputs, unroll);
    return encodeLockupEnvelope({
        arkTx: base64.encode(graph.arkTx.toPSBT()),
        checkpoints: graph.checkpoints.map((tx) => base64.encode(tx.toPSBT())),
        ...(plan.assetUnits !== undefined ? { assetUnits: plan.assetUnits.toString() } : {}),
        unsignedTxId: unsignedGraphId(graph.arkTx, graph.checkpoints),
        covenantOutputIndex: 0,
        senderInputIndexes: req.senderInputs.map((_, i) => i),
        operatorInputIndexes: plan.operatorInputs.map((_, i) => req.senderInputs.length + i),
        senderInputs: req.senderInputs.map(fundingInputToWire),
        operatorInputs: plan.operatorInputs.map(fundingInputToWire),
        serverUnrollScript: hex.encode(unroll.script),
    });
}

export class ProductionLockupBuilder implements LockupBuilder {
    constructor(
        private readonly config: RuntimeConfig,
        private readonly getUnroll: () => CSVMultisigTapscript.Type,
    ) {}
    async buildUnsigned(req: LockupBuildRequest) {
        const unroll = this.getUnroll();
        const unsignedLockupTx = buildLockupEnvelope(req, this.config, unroll);
        const parsed = parseLockupEnvelope(unsignedLockupTx, req, this.config, unroll);
        return {
            unsignedLockupTx,
            unsignedLockupId: parsed.unsignedTxId,
            operatorInputs: req.funding.inputs.map(({ txid, vout }) => ({ txid, vout })),
        };
    }
}
