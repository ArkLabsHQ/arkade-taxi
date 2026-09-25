import { Extension, Transaction, VtxoScript, asset } from "@arkade-os/sdk";
import { createHash } from "node:crypto";
import { verifyOfferFillPlan, type JointGraph } from "@arkade-taxi/client";
import { base64, hex } from "@scure/base";
import { deriveJointInputs, deriveJointOutputs } from "./jointGraphDerivation.js";

export interface JointFillFundingSource {
    tag: "joint-fill";
    version: 1;
    receiveQuoteId: string;
    fillId: string;
    operationId: string;
    offerHex: string;
    offerOutpoint: { txid: string; vout: number };
    graph: JointGraph;
    covenantOutputIndex: number;
    covenantSats: string;
    assetId: { txid: string; groupIndex: number };
    assetUnits: string;
    inputExpiryFloor: { kind: "height" | "time"; value: string };
    inputs: {
        role: "offer-covenant" | "solver" | "sponsor";
        txid: string;
        vout: number;
        value: string;
        script: string;
        tapTree: string;
        spendLeaf: string;
        assetPacket?: string;
        assets: { assetId: string; amount: string }[];
        expiry: { kind: "height" | "time"; value: string };
    }[];
    serverUnrollScript: string;
    operatorScript: string;
    operatorPayouts: { vout: number; sats: string; fareSats: string }[];
    recoveryPreflight: {
        digest: string;
        expectedTxid: string;
        arkTx: string;
        checkpoints: string[];
    };
}

export const encodeJointFillSource = (source: JointFillFundingSource): string =>
    `taxi-source:${JSON.stringify(source)}`;

export interface ValidatedJointFillSource {
    kind: "joint-fill";
    source: JointFillFundingSource;
    covenantOutpoint: { txid: string; vout: number };
    operatorPayouts: { vout: number; sats: bigint; fareSats: bigint }[];
    batchExpiry: { kind: "height" | "time"; value: bigint };
    assetUnits: bigint;
    arkTx: string;
    checkpoints: string[];
    graphId: string;
    covenantScript: Uint8Array;
    serverUnrollScript: string;
}

const SOURCE_PREFIX = "taxi-source:";
const TXID = /^[0-9a-f]{64}$/;
const HEX = /^(?:[0-9a-f]{2})+$/;
const DECIMAL = /^(0|[1-9][0-9]*)$/;

const fail = (detail: string): never => {
    throw new Error(`joint-fill source: ${detail}`);
};
const amount = (value: unknown, label: string): bigint => {
    if (typeof value !== "string" || !DECIMAL.test(value)) return fail(`${label} is invalid`);
    return BigInt(value);
};
const outpoint = (value: { txid?: unknown; vout?: unknown }, label: string) => {
    if (
        !TXID.test(String(value.txid)) ||
        !Number.isSafeInteger(value.vout) ||
        Number(value.vout) < 0 ||
        Number(value.vout) > 0xffff_ffff
    )
        fail(`${label} is invalid`);
    return { txid: String(value.txid), vout: Number(value.vout) };
};
const sameBytes = (a: Uint8Array, b: Uint8Array): boolean =>
    a.length === b.length && a.every((value, index) => value === b[index]);

export function readFundingSource(encoded: string): { kind: "legacy" } | ValidatedJointFillSource {
    if (!encoded.startsWith(SOURCE_PREFIX)) return { kind: "legacy" };
    let source: JointFillFundingSource;
    try {
        source = JSON.parse(encoded.slice(SOURCE_PREFIX.length)) as JointFillFundingSource;
    } catch {
        return fail("malformed tagged source");
    }
    if (source?.tag !== "joint-fill" || source.version !== 1)
        fail("unsupported source tag or version");
    if (
        !source.receiveQuoteId ||
        !source.fillId ||
        !source.operationId ||
        !source.offerHex ||
        !Array.isArray(source.inputs) ||
        !source.inputs.length ||
        !Array.isArray(source.operatorPayouts) ||
        !source.recoveryPreflight ||
        !verifyOfferFillPlan(source.graph)
    )
        fail("graph or binding is malformed");
    const tx = Transaction.fromPSBT(base64.decode(source.graph.arkTx));
    const derivedInputs = deriveJointInputs(source.graph);
    if (derivedInputs.length !== source.inputs.length) fail("graph inputs differ from facts");
    const floorKind = source.inputExpiryFloor?.kind;
    const floor = amount(source.inputExpiryFloor?.value, "input expiry floor");
    let batchExpiry: bigint | undefined;
    source.inputs.forEach((input, index) => {
        const point = outpoint(input, `input ${index}`);
        const derived = derivedInputs[index];
        const owner = derived?.owner === null ? "offer-covenant" : derived?.owner;
        const expiry = amount(input.expiry?.value, `input ${index} expiry`);
        if (
            !derived ||
            owner !== input.role ||
            derived.txid !== point.txid ||
            derived.vout !== point.vout ||
            amount(input.value, `input ${index} value`) <= 0n ||
            !HEX.test(input.script) ||
            !HEX.test(input.tapTree) ||
            !HEX.test(input.spendLeaf) ||
            (input.assetPacket !== undefined && !HEX.test(input.assetPacket)) ||
            !Array.isArray(input.assets) ||
            input.assets.some(
                (asset) =>
                    typeof asset.assetId !== "string" ||
                    !asset.assetId ||
                    amount(asset.amount, `input ${index} asset amount`) <= 0n,
            ) ||
            (floorKind !== "height" && floorKind !== "time") ||
            input.expiry?.kind !== floorKind ||
            expiry < floor
        )
            fail(`input ${index} disagrees with the graph or expiry floor`);
        try {
            const tree = VtxoScript.decode(hex.decode(input.tapTree));
            if (hex.encode(tree.pkScript) !== input.script || !tree.findLeaf(input.spendLeaf))
                fail(`input ${index} taproot proof differs from source script`);
        } catch (cause) {
            if (cause instanceof Error && cause.message.startsWith("joint-fill source:"))
                throw cause;
            fail(`input ${index} taproot proof is malformed`);
        }
        batchExpiry = batchExpiry === undefined || expiry < batchExpiry ? expiry : batchExpiry;
    });
    try {
        const packet = Extension.fromTx(tx).getAssetPacket();
        const graphAssets = source.inputs.map(() => new Map<string, bigint>());
        for (const group of packet?.groups ?? []) {
            const id = group.assetId
                ? group.assetId.toString()
                : fail("joint-fill asset issuance is unsupported");
            for (const input of group.inputs) {
                if (!graphAssets[input.vin]) fail("asset input index is outside the graph");
                graphAssets[input.vin]!.set(
                    id,
                    (graphAssets[input.vin]!.get(id) ?? 0n) + input.amount,
                );
            }
        }
        source.inputs.forEach((input, index) => {
            const facts = new Map<string, bigint>();
            for (const holding of input.assets) {
                asset.AssetId.fromString(holding.assetId);
                if (facts.has(holding.assetId)) fail(`input ${index} repeats an asset`);
                facts.set(holding.assetId, amount(holding.amount, `input ${index} asset amount`));
            }
            const expected = graphAssets[index]!;
            if (
                facts.size !== expected.size ||
                [...facts].some(([id, units]) => expected.get(id) !== units)
            )
                fail(`input ${index} asset facts differ from the graph`);
        });
    } catch (cause) {
        if (cause instanceof Error && cause.message.startsWith("joint-fill source:")) throw cause;
        fail("input asset facts are malformed");
    }
    const offerPoint = outpoint(source.offerOutpoint, "offer outpoint");
    if (
        source.inputs[0]?.role !== "offer-covenant" ||
        source.inputs[0].txid !== offerPoint.txid ||
        source.inputs[0].vout !== offerPoint.vout
    )
        fail("offer binding differs from graph inputs");
    const covenant = outpoint(
        { txid: tx.id.toLowerCase(), vout: source.covenantOutputIndex },
        "covenant outpoint",
    );
    if (covenant.txid !== tx.id.toLowerCase()) fail("covenant txid differs from graph");
    const output = tx.getOutput(covenant.vout);
    const covenantSats = amount(source.covenantSats, "covenant sats");
    if (!output?.script || covenantSats <= 0n || output.amount !== covenantSats)
        fail("covenant output is invalid");
    if (!TXID.test(source.assetId?.txid) || !Number.isSafeInteger(source.assetId?.groupIndex))
        fail("asset id is invalid");
    const assetUnits = amount(source.assetUnits, "asset units");
    if (assetUnits <= 0n) fail("asset units must be positive");
    let held = 0n;
    try {
        const wanted = asset.AssetId.create(
            hex.encode(Uint8Array.from(hex.decode(source.assetId.txid)).reverse()),
            source.assetId.groupIndex,
        ).toString();
        held =
            Extension.fromTx(tx)
                .getAssetPacket()
                ?.groups.filter((group) => group.assetId?.toString() === wanted)
                .flatMap((group) => group.outputs)
                .filter((entry) => entry.vout === covenant.vout)
                .reduce((sum, entry) => sum + entry.amount, 0n) ?? 0n;
    } catch {
        fail("asset extension is malformed");
    }
    if (held !== assetUnits) fail("covenant asset amount differs from source");
    if (!HEX.test(source.operatorScript) || !HEX.test(source.serverUnrollScript))
        fail("operator or unroll script is malformed");
    const operatorScript = hex.decode(source.operatorScript);
    const outputs = deriveJointOutputs(source.graph);
    const seen = new Set<number>();
    const operatorPayouts = source.operatorPayouts.map((payout) => {
        const point = outpoint({ txid: tx.id.toLowerCase(), vout: payout.vout }, "operator payout");
        const sats = amount(payout.sats, "operator payout sats");
        const fareSats = amount(payout.fareSats, "operator payout fare");
        const actual = outputs[point.vout];
        if (
            seen.has(point.vout) ||
            !actual ||
            actual.sats !== sats ||
            !sameBytes(actual.script, operatorScript) ||
            actual.assets.length ||
            fareSats > sats
        )
            fail("operator payout differs from graph");
        seen.add(point.vout);
        return { vout: point.vout, sats, fareSats };
    });
    const preflight = source.recoveryPreflight;
    if (
        !TXID.test(preflight.digest) ||
        !TXID.test(preflight.expectedTxid) ||
        typeof preflight.arkTx !== "string" ||
        !Array.isArray(preflight.checkpoints) ||
        preflight.checkpoints.some((value) => typeof value !== "string")
    )
        fail("recovery preflight is malformed");
    try {
        const recovery = Transaction.fromPSBT(base64.decode(preflight.arkTx));
        const digest = createHash("sha256")
            .update(JSON.stringify({ arkTx: preflight.arkTx, checkpoints: preflight.checkpoints }))
            .digest("hex");
        if (recovery.id !== preflight.expectedTxid || digest !== preflight.digest)
            fail("recovery preflight commitment differs");
        preflight.checkpoints.forEach((checkpoint) =>
            Transaction.fromPSBT(base64.decode(checkpoint)),
        );
    } catch (cause) {
        if (cause instanceof Error && cause.message.startsWith("joint-fill source:")) throw cause;
        fail("recovery preflight is malformed");
    }
    return {
        kind: "joint-fill",
        source,
        covenantOutpoint: covenant,
        operatorPayouts,
        batchExpiry: { kind: floorKind, value: batchExpiry! },
        assetUnits,
        arkTx: source.graph.arkTx,
        checkpoints: [...source.graph.checkpoints],
        graphId: source.graph.graphId,
        covenantScript: Uint8Array.from(output.script!),
        serverUnrollScript: source.serverUnrollScript,
    };
}
