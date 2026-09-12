import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import {
    Transaction,
    ArkAddress,
    Extension,
    VtxoScript,
    VtxoTaprootTree,
    setArkPsbtField,
    P2A,
    type CSVMultisigTapscript,
} from "@arkade-os/sdk";
import { base64, hex } from "@scure/base";
import {
    fundingInputFromWire,
    fundingInputToWire,
    satsFromWire,
    type FundingInputWire,
    type LockupCommitment,
} from "@arkade-taxi/protocol";
import type { RuntimeConfig } from "../config.js";
import type { LockupBuildRequest } from "../quotes.js";
import { lockupPlan } from "./lockupBuilder.js";
import { LockupShapeError } from "../lockup.js";

export interface LockupEnvelope extends LockupCommitment {
    arkTx: string;
    checkpoints: string[];
    senderInputs: FundingInputWire[];
    operatorInputs: FundingInputWire[];
    serverUnrollScript: string;
    assetUnits?: string;
}

export function decodeBase64(value: string): Uint8Array {
    if (typeof value !== "string" || !value.length || value.length > 4_000_000)
        throw new LockupShapeError("invalid envelope or PSBT size");
    const bytes = base64.decode(value);
    if (base64.encode(bytes) !== value) throw new LockupShapeError("noncanonical base64");
    return bytes;
}

export function encodeLockupEnvelope(envelope: LockupEnvelope): string {
    return base64.encode(new TextEncoder().encode(canonicalJson(envelope)));
}

function canonicalJson(value: unknown): string {
    if (value === null || typeof value !== "object") return JSON.stringify(value);
    if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
        .sort()
        .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
        .join(",")}}`;
}

function assertUniqueJsonKeys(json: string): void {
    let offset = 0;
    const whitespace = () => {
        while (/\s/.test(json[offset] ?? "")) offset++;
    };
    const string = (): string => {
        const start = offset++;
        while (offset < json.length) {
            if (json[offset] === "\\") {
                offset += 2;
                continue;
            }
            if (json[offset++] === '"') return JSON.parse(json.slice(start, offset)) as string;
        }
        throw new LockupShapeError("invalid lockup envelope JSON string");
    };
    const value = (): void => {
        whitespace();
        if (json[offset] === "{") {
            offset++;
            const keys = new Set<string>();
            whitespace();
            while (json[offset] !== "}") {
                if (json[offset] !== '"')
                    throw new LockupShapeError("invalid lockup envelope JSON");
                const key = string();
                if (keys.has(key)) throw new LockupShapeError(`duplicate envelope key ${key}`);
                keys.add(key);
                whitespace();
                if (json[offset++] !== ":")
                    throw new LockupShapeError("invalid lockup envelope JSON");
                value();
                whitespace();
                if (json[offset] === "}") break;
                if (json[offset++] !== ",")
                    throw new LockupShapeError("invalid lockup envelope JSON");
                whitespace();
            }
            offset++;
            return;
        }
        if (json[offset] === "[") {
            offset++;
            whitespace();
            while (json[offset] !== "]") {
                value();
                whitespace();
                if (json[offset] === "]") break;
                if (json[offset++] !== ",")
                    throw new LockupShapeError("invalid lockup envelope JSON");
            }
            offset++;
            return;
        }
        if (json[offset] === '"') {
            string();
            return;
        }
        while (offset < json.length && !/[\s,\]}]/.test(json[offset]!)) offset++;
    };
    value();
    whitespace();
    if (offset !== json.length) throw new LockupShapeError("invalid trailing envelope JSON");
}

function decodeEnvelopeBase64(value: string): Uint8Array {
    if (typeof value !== "string" || !value.length || value.length > 4_000_000)
        throw new LockupShapeError("invalid envelope size");
    const compact = value.replace(/[\t\n\r ]/g, "");
    if (!/^[A-Za-z0-9+/]*={0,2}$/.test(compact) || compact.length % 4 === 1)
        throw new LockupShapeError("invalid envelope base64");
    const unpadded = compact.replace(/=+$/, "");
    const normalized = unpadded.padEnd(Math.ceil(unpadded.length / 4) * 4, "=");
    const bytes = base64.decode(normalized);
    if (base64.encode(bytes).replace(/=+$/, "") !== unpadded)
        throw new LockupShapeError("invalid envelope base64");
    return bytes;
}

export function unsignedGraphId(tx: Transaction, checkpoints: Transaction[]): string {
    const hash = createHash("sha256");
    hash.update("arkade-taxi-lockup-v1\0");
    hash.update(tx.toPSBT());
    for (const checkpoint of checkpoints) hash.update(hex.decode(checkpoint.id));
    return hash.digest("hex");
}

export function decodeLockupEnvelope(encoded: string): LockupEnvelope {
    const json = new TextDecoder("utf-8", { fatal: true }).decode(decodeEnvelopeBase64(encoded));
    assertUniqueJsonKeys(json);
    const wire = JSON.parse(json) as LockupEnvelope;
    if (
        !wire ||
        typeof wire !== "object" ||
        Array.isArray(wire) ||
        !Array.isArray(wire.senderInputs) ||
        !Array.isArray(wire.operatorInputs) ||
        !Array.isArray(wire.checkpoints) ||
        !/^[0-9a-f]{64}$/.test(wire.unsignedTxId)
    )
        throw new LockupShapeError("invalid lockup envelope");
    return wire;
}

export function parseLockupEnvelope(
    encoded: string,
    req: LockupBuildRequest,
    config: RuntimeConfig,
    unroll: CSVMultisigTapscript.Type,
) {
    const wire = decodeLockupEnvelope(encoded);
    const plan = lockupPlan(req, config);
    const same = (actual: unknown, expected: unknown, label: string) => {
        if (!isDeepStrictEqual(actual, expected))
            throw new LockupShapeError(`lockup ${label} mismatch`);
    };
    same(wire.covenantOutputIndex, 0, "covenant index");
    same(
        wire.senderInputIndexes,
        req.senderInputs.map((_, i) => i),
        "sender ownership",
    );
    same(
        wire.operatorInputIndexes,
        plan.operatorInputs.map((_, i) => i + req.senderInputs.length),
        "operator ownership",
    );
    same(wire.serverUnrollScript, hex.encode(unroll.script), "unroll script");
    same(
        wire.assetUnits === undefined
            ? undefined
            : satsFromWire(wire.assetUnits, "envelope.assetUnits"),
        plan.assetUnits,
        "payment asset units",
    );
    same(
        wire.senderInputs.map((i) => fundingInputToWire(fundingInputFromWire(i))),
        req.senderInputs.map(fundingInputToWire),
        "sender evidence",
    );
    same(
        wire.operatorInputs.map((i) => fundingInputToWire(fundingInputFromWire(i))),
        plan.operatorInputs.map(fundingInputToWire),
        "operator evidence",
    );
    same(wire.checkpoints.length, plan.inputs.length, "checkpoint count");
    const arkTx = Transaction.fromPSBT(decodeBase64(wire.arkTx));
    for (let i = 0; i < arkTx.outputsLength; i++) {
        const output = arkTx.getOutput(i);
        const anchor =
            i === arkTx.outputsLength - 1 &&
            output.amount === 0n &&
            isDeepStrictEqual(output.script, P2A.script);
        const extension =
            output.amount === 0n && output.script && Extension.isExtension(output.script);
        if (
            !anchor &&
            !extension &&
            (output.amount === undefined || output.amount < config.vtxoMinAmount)
        )
            throw new LockupShapeError(`lockup output ${i} is below the Arkade Service minimum`);
    }
    for (const [i, output] of plan.valueOutputs.entries()) {
        if (output.role === "covenant") continue;
        const key =
            output.role === "operator-fare"
                ? req.params.operatorKey
                : VtxoScript.decode(
                      output.role === "sender-change"
                          ? req.senderInputs[0].tapTree
                          : plan.operatorInputs[0].tapTree,
                  ).tweakedPublicKey;
        const address = new ArkAddress(config.serverPubkey, key, config.addressHrp);
        same(
            arkTx.getOutput(i).script,
            output.amount < config.dust ? address.subdustPkScript : address.pkScript,
            `${output.role} amount-dependent script`,
        );
    }
    const checkpoints = wire.checkpoints.map((s) => Transaction.fromPSBT(decodeBase64(s)));
    const expectedArk = new Transaction({ version: 3, lockTime: 0 });
    for (const [i, input] of plan.arkInputs.entries()) {
        const source = VtxoScript.decode(input.tapTree);
        const checkpointTree = new VtxoScript([unroll.script, plan.inputs[i].spendLeaf]);
        const expectedCheckpoint = new Transaction({ version: 3, lockTime: 0 });
        expectedCheckpoint.addInput({
            txid: input.txid,
            index: input.vout,
            witnessUtxo: { script: source.pkScript, amount: BigInt(input.value) },
            tapLeafScript: [input.tapLeafScript],
        });
        setArkPsbtField(expectedCheckpoint, 0, VtxoTaprootTree, input.tapTree);
        expectedCheckpoint.addOutput({
            amount: BigInt(input.value),
            script: checkpointTree.pkScript,
        });
        expectedCheckpoint.addOutput(P2A);
        same(
            hex.encode(checkpoints[i].toPSBT()),
            hex.encode(expectedCheckpoint.toPSBT()),
            `checkpoint ${i} transaction and metadata`,
        );
        expectedArk.addInput({
            txid: checkpoints[i].id,
            index: 0,
            witnessUtxo: { script: checkpointTree.pkScript, amount: BigInt(input.value) },
            tapLeafScript: [checkpointTree.findLeaf(hex.encode(plan.inputs[i].spendLeaf))],
        });
        setArkPsbtField(expectedArk, i, VtxoTaprootTree, checkpointTree.encode());
    }
    for (const output of plan.outputs) expectedArk.addOutput(output);
    expectedArk.addOutput(P2A);
    same(
        hex.encode(arkTx.toPSBT()),
        hex.encode(expectedArk.toPSBT()),
        "Arkade transaction and metadata",
    );
    same(unsignedGraphId(arkTx, checkpoints), wire.unsignedTxId, "unsigned transaction hash");
    return { ...wire, arkTx, checkpoints };
}
