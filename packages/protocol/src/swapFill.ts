import {
    assetIdFromWire,
    assetIdToWire,
    type AssetIdValue,
    bytesToHex,
    fareFromWire,
    fareToWire,
    hexToBytes,
    satsFromWire,
    satsToWire,
} from "./codec.js";
import type { AssetIdWire, FareWire } from "./index.js";

export const SWAP_FILL_TEMPLATE = "taxi-fill/1" as const;

export type SwapFillInputOwner = "offer-covenant" | "solver" | "sponsor";
export type SwapFillOutputRole = "receiver" | "solver" | "sponsor-fare" | "sponsor-change";
export type SwapFillState = "quoted" | "submitting" | "settled" | "expired" | "cancelled";

export interface SwapFillGraphAssetWire {
    assetId: AssetIdWire;
    units: string;
}

export interface SwapFillGraphInputWire {
    owner: SwapFillInputOwner;
    txid: string;
    vout: number;
}

export interface SwapFillGraphOutputWire {
    role: SwapFillOutputRole;
    vout: number;
    script: string;
    sats: string;
    assets: SwapFillGraphAssetWire[];
}

export interface SwapFillGraphWire {
    arkTx: string;
    checkpoints: string[];
    graphId: string;
    template: typeof SWAP_FILL_TEMPLATE;
    inputs: SwapFillGraphInputWire[];
    // Derived view of arkTx for API consumers, not an independent claim:
    // the server builds it from the transaction and re-checks it there.
    outputs: SwapFillGraphOutputWire[];
}

export interface SwapFillGraphAsset {
    assetId: AssetIdValue;
    units: bigint;
}

export interface SwapFillGraphInput {
    owner: SwapFillInputOwner;
    txid: string;
    vout: number;
}

export interface SwapFillGraphOutput {
    role: SwapFillOutputRole;
    vout: number;
    script: Uint8Array;
    sats: bigint;
    assets: SwapFillGraphAsset[];
}

export interface SwapFillGraph {
    arkTx: string;
    checkpoints: string[];
    graphId: Uint8Array;
    inputs: SwapFillGraphInput[];
    outputs: SwapFillGraphOutput[];
}

export interface SwapFillSolverAssetWire {
    assetId: AssetIdWire;
    amount: string;
}

export interface SwapFillSolverInputWire {
    txid: string;
    vout: number;
    value: string;
    /** As `FundingInputWire`, lowercase hex: build data the indexer does not
     * serve. Taxi refuses a tree that does not rebuild the indexed script. */
    tapTree: string;
    spendLeaf: string;
    assets?: SwapFillSolverAssetWire[];
}

export interface SwapFillSolverInput {
    txid: string;
    vout: number;
    value: bigint;
    tapTree: Uint8Array;
    spendLeaf: Uint8Array;
    assets?: { assetId: AssetIdValue; amount: bigint }[];
}

export interface SwapFillQuoteRequestBody {
    operationId: string;
    receiveQuoteId?: string;
    offerHex: string;
    solverInputs: SwapFillSolverInputWire[];
    solverProceedsScript: string;
    solverKeys: string[];
    contributionSats: string;
    maxFare: FareWire;
    fundingTxid?: string;
    fundingVout?: number;
    swapAddress?: string;
    /** Caller's own wall-clock ceiling, **unix SECONDS**. Never a batch
     * height or time expiry: those live in a different domain. */
    validUntil?: number;
}

export interface SwapFillQuoteRequest {
    operationId: string;
    receiveQuoteId?: string;
    offerHex: string;
    solverInputs: SwapFillSolverInput[];
    solverProceedsScript: Uint8Array;
    solverKeys: string[];
    contributionSats: bigint;
    maxFare:
        | { currency: "sats"; units: bigint }
        | { currency: "asset"; assetId: { txid: Uint8Array; groupIndex: number }; units: bigint };
    fundingTxid?: string;
    fundingVout?: number;
    swapAddress?: string;
    validUntil?: number;
}

export interface SwapFillQuoteResponse {
    fillId: string;
    operationId: string;
    expiresAt: number;
    template: typeof SWAP_FILL_TEMPLATE;
    contributionSats: string;
    fare: FareWire;
    graph: SwapFillGraphWire;
}

export interface SwapFillSubmitRequestBody {
    solverGraph: SwapFillGraphWire;
}

export interface SwapFillStatusResponse {
    fillId: string;
    operationId: string;
    state: SwapFillState;
    txid?: string;
    outpoint?: { txid: string; vout: number };
    spentTxid?: string;
    failureCode?: string;
    updatedAt: number;
    expiresAt: number;
}

const fail = (label: string, reason: string): never => {
    throw new Error(`protocol: ${label}: ${reason}`);
};

const TXID = /^[0-9a-f]{64}$/;
const HEX = /^[0-9a-f]*$/;

const nonEmpty = (value: unknown, label: string): string => {
    if (typeof value !== "string" || value === "") fail(label, "must be a non-empty string");
    return value as string;
};

const base64 = (value: unknown, label: string): string => {
    const s = nonEmpty(value, label);
    if (!/^[A-Za-z0-9+/]*={0,2}$/.test(s) || s.length % 4 !== 0) fail(label, "must be base64");
    return s;
};

const txid = (value: unknown, label: string): string => {
    const s = nonEmpty(value, label);
    if (!TXID.test(s)) fail(label, "txid must be 32-byte lowercase hex");
    return s;
};

const vout = (value: unknown, label: string): number => {
    if (
        typeof value !== "number" ||
        !Number.isSafeInteger(value) ||
        value < 0 ||
        value > 0xffffffff
    )
        fail(label, "invalid vout");
    return value as number;
};

const unixSeconds = (value: unknown, label: string): number => {
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0)
        fail(label, "must be a positive safe integer of unix seconds");
    return value as number;
};

const swapAssetIdFromWire = (value: unknown, label: string): AssetIdValue => {
    const id = assetIdFromWire(value as AssetIdWire, label);
    if (id.txid.length !== 32) fail(label, "txid must be 32 bytes");
    return id;
};

const ownerFromWire = (value: unknown): SwapFillInputOwner => {
    if (value === "offer-covenant" || value === "solver" || value === "sponsor") return value;
    return fail("graph.inputs[].owner", `unknown owner ${JSON.stringify(value)}`);
};

const roleFromWire = (value: unknown): SwapFillOutputRole => {
    if (
        value === "receiver" ||
        value === "solver" ||
        value === "sponsor-fare" ||
        value === "sponsor-change"
    )
        return value;
    return fail("graph.outputs[].role", `unknown role ${JSON.stringify(value)}`);
};

export function swapFillGraphFromWire(wire: SwapFillGraphWire): SwapFillGraph {
    if (!wire || typeof wire !== "object" || Array.isArray(wire)) fail("graph", "expected object");
    if (wire.template !== SWAP_FILL_TEMPLATE) fail("graph.template", "unsupported template");
    if (!Array.isArray(wire.inputs) || !wire.inputs.length) fail("graph.inputs", "expected array");
    if (!Array.isArray(wire.outputs) || !wire.outputs.length)
        fail("graph.outputs", "expected array");
    if (!Array.isArray(wire.checkpoints)) fail("graph.checkpoints", "expected array");
    return {
        arkTx: base64(wire.arkTx, "graph.arkTx"),
        checkpoints: wire.checkpoints.map((c, i) => base64(c, `graph.checkpoints[${i}]`)),
        graphId: hexToBytes(txid(wire.graphId, "graph.graphId"), "graph.graphId"),
        inputs: wire.inputs.map((input, i) => ({
            owner: ownerFromWire(input.owner),
            txid: txid(input.txid, `graph.inputs[${i}].txid`),
            vout: vout(input.vout, `graph.inputs[${i}].vout`),
        })),
        outputs: wire.outputs.map((output, i) => {
            const script = hexToBytes(
                nonEmpty(output.script, `graph.outputs[${i}].script`),
                `graph.outputs[${i}].script`,
            );
            if (!HEX.test(output.script)) fail(`graph.outputs[${i}].script`, "not lowercase hex");
            if (!script.length) fail(`graph.outputs[${i}].script`, "empty script");
            return {
                role: roleFromWire(output.role),
                vout: vout(output.vout, `graph.outputs[${i}].vout`),
                script,
                sats: satsFromWire(output.sats, `graph.outputs[${i}].sats`),
                assets: (output.assets ?? []).map((a, j) => ({
                    assetId: swapAssetIdFromWire(
                        a.assetId,
                        `graph.outputs[${i}].assets[${j}].assetId`,
                    ),
                    units: satsFromWire(a.units, `graph.outputs[${i}].assets[${j}].units`),
                })),
            };
        }),
    };
}

export function swapFillGraphToWire(graph: SwapFillGraph): SwapFillGraphWire {
    const wire: SwapFillGraphWire = {
        arkTx: graph.arkTx,
        checkpoints: [...graph.checkpoints],
        graphId: bytesToHex(graph.graphId),
        template: SWAP_FILL_TEMPLATE,
        inputs: graph.inputs.map((input) => ({ ...input })),
        outputs: graph.outputs.map((output) => ({
            role: output.role,
            vout: output.vout,
            script: bytesToHex(output.script),
            sats: satsToWire(output.sats),
            assets: output.assets.map((a) => ({
                assetId: assetIdToWire(a.assetId),
                units: satsToWire(a.units),
            })),
        })),
    };
    swapFillGraphFromWire(wire);
    return wire;
}

const solverInputFromWire = (
    input: SwapFillSolverInputWire,
    label: string,
): SwapFillSolverInput => {
    if (!input || typeof input !== "object" || Array.isArray(input)) fail(label, "expected object");
    const value = satsFromWire(input.value, `${label}.value`);
    if (value <= 0n) fail(label, "value must be positive");
    const point = {
        txid: txid(input.txid, `${label}.txid`),
        vout: vout(input.vout, `${label}.vout`),
    };
    const tapTree = hexToBytes(input.tapTree, `${label}.tapTree`);
    const spendLeaf = hexToBytes(input.spendLeaf, `${label}.spendLeaf`);
    if (!tapTree.length || !spendLeaf.length) fail(label, "empty tree or leaf");
    return {
        ...point,
        value,
        tapTree,
        spendLeaf,
        ...(input.assets === undefined
            ? {}
            : {
                  assets: input.assets.map((a, i) => ({
                      assetId: swapAssetIdFromWire(a.assetId, `${label}.assets[${i}].assetId`),
                      amount: satsFromWire(a.amount, `${label}.assets[${i}].amount`),
                  })),
              }),
    };
};

const KEY64 = /^[0-9a-f]{64}$/i;
const KEY66 = /^0[23][0-9a-f]{64}$/i;

export function swapFillQuoteRequestFromWire(body: unknown): SwapFillQuoteRequest {
    if (!body || typeof body !== "object" || Array.isArray(body))
        fail("swapFillQuote", "expected object");
    const b = body as SwapFillQuoteRequestBody;
    const operationId = nonEmpty(b.operationId, "operationId");
    if (operationId.length > 128) fail("operationId", "too long");
    const offerHex = nonEmpty(b.offerHex, "offerHex");
    if (!HEX.test(offerHex) || offerHex.length % 2 !== 0 || !offerHex.length)
        fail("offerHex", "must be even-length lowercase hex");
    if (!Array.isArray(b.solverInputs) || !b.solverInputs.length || b.solverInputs.length > 256)
        fail("solverInputs", "must contain 1 to 256 funding inputs");
    const solverInputs = b.solverInputs.map((input, i) =>
        solverInputFromWire(input, `solverInputs[${i}]`),
    );
    if (new Set(solverInputs.map((i) => `${i.txid}:${i.vout}`)).size !== solverInputs.length)
        fail("solverInputs", "duplicate solver outpoint");
    const proceeds = hexToBytes(
        nonEmpty(b.solverProceedsScript, "solverProceedsScript"),
        "solverProceedsScript",
    );
    if (!HEX.test(b.solverProceedsScript)) fail("solverProceedsScript", "not lowercase hex");
    if (!proceeds.length) fail("solverProceedsScript", "empty script");
    if (!Array.isArray(b.solverKeys) || !b.solverKeys.length || b.solverKeys.length > 256)
        fail("solverKeys", "must contain 1 to 256 owner keys");
    const solverKeys = b.solverKeys.map((key, i) => {
        if (typeof key !== "string" || (!KEY64.test(key) && !KEY66.test(key)))
            fail(`solverKeys[${i}]`, "must be x-only or compressed hex");
        return key.toLowerCase();
    });
    const contributionSats = satsFromWire(b.contributionSats, "contributionSats");
    if (contributionSats <= 0n) fail("contributionSats", "contribution must be positive");
    if (!b.maxFare || typeof b.maxFare !== "object") fail("maxFare", "expected object");
    const maxFare = fareFromWire(b.maxFare, "maxFare");
    if (maxFare.units < 0n) fail("maxFare", "units must not be negative");
    const out: SwapFillQuoteRequest = {
        operationId,
        offerHex,
        solverInputs,
        solverProceedsScript: proceeds,
        solverKeys,
        contributionSats,
        maxFare,
    };
    if (b.receiveQuoteId !== undefined)
        out.receiveQuoteId = nonEmpty(b.receiveQuoteId, "receiveQuoteId");
    if (b.fundingTxid !== undefined) out.fundingTxid = txid(b.fundingTxid, "fundingTxid");
    if (b.fundingVout !== undefined) out.fundingVout = vout(b.fundingVout, "fundingVout");
    if ((b.fundingTxid === undefined) !== (b.fundingVout === undefined))
        fail("fundingOutpoint", "fundingTxid and fundingVout are required together");
    if (b.swapAddress !== undefined) out.swapAddress = nonEmpty(b.swapAddress, "swapAddress");
    if (b.validUntil !== undefined) out.validUntil = unixSeconds(b.validUntil, "validUntil");
    return out;
}

export function swapFillSubmitRequestFromWire(body: unknown): SwapFillGraph {
    if (!body || typeof body !== "object" || Array.isArray(body))
        fail("swapFillSubmit", "expected object");
    const graph = (body as SwapFillSubmitRequestBody).solverGraph;
    if (!graph || typeof graph !== "object") fail("solverGraph", "expected object");
    return swapFillGraphFromWire(graph);
}

export function swapFillStatusFromWire(body: unknown): SwapFillStatusResponse {
    if (!body || typeof body !== "object" || Array.isArray(body))
        fail("swapFillStatus", "expected object");
    const b = body as SwapFillStatusResponse;
    const states: readonly string[] = ["quoted", "submitting", "settled", "expired", "cancelled"];
    if (!states.includes(b.state)) fail("state", `unknown state ${JSON.stringify(b.state)}`);
    const out: SwapFillStatusResponse = {
        fillId: nonEmpty(b.fillId, "fillId"),
        operationId: nonEmpty(b.operationId, "operationId"),
        state: b.state,
        updatedAt: b.updatedAt,
        expiresAt: b.expiresAt,
    };
    if (!Number.isSafeInteger(b.updatedAt) || b.updatedAt < 0) fail("updatedAt", "invalid time");
    if (!Number.isSafeInteger(b.expiresAt) || b.expiresAt < 0) fail("expiresAt", "invalid time");
    if (b.txid !== undefined) out.txid = txid(b.txid, "txid");
    if (b.outpoint !== undefined)
        out.outpoint = {
            txid: txid(b.outpoint.txid, "outpoint.txid"),
            vout: vout(b.outpoint.vout, "outpoint.vout"),
        };
    if (b.spentTxid !== undefined) out.spentTxid = txid(b.spentTxid, "spentTxid");
    if (b.failureCode !== undefined) out.failureCode = nonEmpty(b.failureCode, "failureCode");
    return out;
}

export { fareToWire };
