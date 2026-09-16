/**
 * Swap-fill verified-quote capability: pure HTTP plus protocol-level
 * verification. No signing and no JointGraph/PSBT handling here — the caller
 * owns the swap package and the keys. A quote is checked against what was
 * asked; the submit error contract is preserved end to end.
 */

import {
    assetIdToWire,
    bytesToHex,
    fareToWire,
    satsToWire,
    type AssetIdValue,
    type SwapFillGraphWire,
    type SwapFillQuoteRequestBody,
    type SwapFillQuoteResponse,
    type SwapFillStatusResponse,
} from "@arkade-taxi/protocol";
import { QuoteVerificationError, TaxiError, VerificationErrorCode } from "./errors.js";
import type { VerificationCode } from "./errors.js";
import { causeMessage, decodeSwapFillQuote, type DecodedSwapFillQuote } from "./decode.js";
import { immutablePlainCopy } from "./lockup.js";

declare const swapFillVerified: unique symbol;

/** Proof that `verifySwapFillQuote` accepted this quote. Only this module
 * mints it, so `TaxiClient.submitSwapFill` cannot be reached unverified. */
export type VerifiedSwapFillQuote = {
    readonly quote: SwapFillQuoteResponse;
    readonly fillId: string;
    readonly contributionSats: bigint;
    readonly fare: DecodedSwapFillQuote["fare"];
    readonly expiresAt: number;
} & { readonly [swapFillVerified]: true };

/** What the caller asked for. Server values are evidence checked against
 * this, never authorization. The response carries no offer echo, so the
 * operation id plus the funding outpoints are the request binding. */
export interface SwapFillQuoteExpectation {
    operationId: string;
    solverProceedsScript: Uint8Array;
    solverInputs: { txid: string; vout: number }[];
    contributionSats: bigint;
    maxFare: {
        currency: "sats" | "asset";
        units: bigint;
        assetId?: { txid: Uint8Array; groupIndex: number };
    };
    fundingTxid?: string;
    fundingVout?: number;
}

export interface VerifySwapFillQuoteArgs {
    quote: SwapFillQuoteResponse;
    expect: SwapFillQuoteExpectation;
    /** Unix seconds. Injected only so expiry is testable; defaults to the clock. */
    now?: number;
}

export interface RequestSwapFillQuoteArgs {
    operationId: string;
    offerHex: string;
    solverInputs: {
        txid: string;
        vout: number;
        value: bigint;
        assets?: { assetId: AssetIdValue; amount: bigint }[];
    }[];
    solverProceedsScript: Uint8Array;
    solverKeys: string[];
    contributionSats: bigint;
    maxFare: {
        currency: "sats" | "asset";
        units: bigint;
        assetId?: AssetIdValue;
    };
    fundingTxid?: string;
    fundingVout?: number;
    swapAddress?: string;
}

export interface RequestVerifiedSwapFillQuoteArgs extends RequestSwapFillQuoteArgs {
    now?: number;
}

interface CapabilityState {
    authorization: VerifySwapFillQuoteArgs;
    baseline: SwapFillQuoteResponse;
}

export interface ActiveSwapFillCapabilityState {
    authorization: VerifySwapFillQuoteArgs;
    fillId: string;
    quote: SwapFillQuoteResponse;
}

/** Thrown when the provider was invoked: the outcome is unknown, the fill
 * must be reconciled, and the caller must never auto-retry. Distinct by type
 * from every pre-network failure, which stays a plain `TaxiError`. */
export class SwapFillSubmitAmbiguousError extends TaxiError {
    readonly name = "SwapFillSubmitAmbiguousError";

    constructor(
        public readonly fillId: string,
        cause: unknown,
    ) {
        super(
            SWAP_FILL_AMBIGUOUS_CODE,
            `taxi: swap fill ${fillId} submission is ambiguous; reconcile before retrying, never auto-retry: ${causeMessage(cause)}`,
            { cause },
        );
    }
}

export const SWAP_FILL_AMBIGUOUS_CODE = "swap_fill_submission_ambiguous";
export const SWAP_FILL_CONFLICT_CODE = "operation_conflict";

export const isSwapFillSubmitAmbiguous = (error: unknown): boolean =>
    error instanceof SwapFillSubmitAmbiguousError ||
    (error instanceof TaxiError && error.code === SWAP_FILL_AMBIGUOUS_CODE);

export const isSwapFillOperationConflict = (error: unknown): boolean =>
    error instanceof TaxiError && error.code === SWAP_FILL_CONFLICT_CODE;

/** Primary proof reference. Present once the provider ran; absent before. */
export const swapFillTxid = (status: SwapFillStatusResponse): string | undefined => status.txid;

/** Maker-receipt locator. Reconciler-local first-receiver-vout convention:
 * fit for fetching the receipt, never for economic logic. */
export const swapFillMakerOutpoint = (
    status: SwapFillStatusResponse,
): { txid: string; vout: number } | undefined =>
    status.outpoint === undefined ? undefined : { ...status.outpoint };

export const isSwapFillSettled = (status: SwapFillStatusResponse): boolean =>
    status.state === "settled";

export const isSwapFillTerminal = (status: SwapFillStatusResponse): boolean =>
    status.state === "settled" || status.state === "expired" || status.state === "cancelled";

/** A `submitting` state with a txid is a claim of submission, not settlement:
 * only `settled` proves the fill landed. */
export const isSwapFillSettlementClaim = (status: SwapFillStatusResponse): boolean =>
    status.state === "submitting" && status.txid !== undefined;

const capabilities = new WeakMap<VerifiedSwapFillQuote, CapabilityState>();

const reject = (code: VerificationCode, detail: string): never => {
    throw new QuoteVerificationError(code, `taxi: ${detail}`);
};

const rewrap = <T>(code: VerificationCode, f: () => T): T => {
    try {
        return f();
    } catch (cause) {
        if (cause instanceof QuoteVerificationError) throw cause;
        return reject(code, causeMessage(cause));
    }
};

const sameBytes = (a: Uint8Array, b: Uint8Array): boolean =>
    a.length === b.length && a.every((value, index) => value === b[index]);

const sameAsset = (
    a: { txid: Uint8Array; groupIndex: number } | undefined,
    b: { txid: Uint8Array; groupIndex: number } | undefined,
): boolean =>
    a === undefined || b === undefined
        ? a === b
        : a.groupIndex === b.groupIndex && sameBytes(a.txid, b.txid);

const canonical = (value: unknown): string => {
    if (value instanceof Uint8Array) return `bytes:${bytesToHex(value)}`;
    if (typeof value === "bigint") return `bigint:${value}`;
    if (value === undefined) return "undefined";
    if (value === null || typeof value !== "object") return JSON.stringify(value);
    if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
        .sort()
        .map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`)
        .join(",")}}`;
};

const exact = (actual: unknown, expected: unknown, label: string): void => {
    if (canonical(actual) !== canonical(expected))
        reject(VerificationErrorCode.Malformed, `${label} mismatch`);
};

export function encodeSwapFillQuoteBody(args: RequestSwapFillQuoteArgs): SwapFillQuoteRequestBody {
    const body: SwapFillQuoteRequestBody = {
        operationId: args.operationId,
        offerHex: args.offerHex,
        solverInputs: args.solverInputs.map((input) => ({
            txid: input.txid,
            vout: input.vout,
            value: satsToWire(input.value),
            ...(input.assets === undefined
                ? {}
                : {
                      assets: input.assets.map((a) => ({
                          assetId: assetIdToWire(a.assetId),
                          amount: satsToWire(a.amount),
                      })),
                  }),
        })),
        solverProceedsScript: bytesToHex(args.solverProceedsScript),
        solverKeys: [...args.solverKeys],
        contributionSats: satsToWire(args.contributionSats),
        maxFare: fareToWire(args.maxFare),
        ...(args.fundingTxid !== undefined ? { fundingTxid: args.fundingTxid } : {}),
        ...(args.fundingVout !== undefined ? { fundingVout: args.fundingVout } : {}),
        ...(args.swapAddress !== undefined ? { swapAddress: args.swapAddress } : {}),
    };
    return body;
}

export function verifySwapFillQuote(args: VerifySwapFillQuoteArgs): VerifiedSwapFillQuote {
    args = immutablePlainCopy(args, "swap-fill quote verification request");
    const { expect } = args;

    const decoded = rewrap(VerificationErrorCode.Malformed, () => decodeSwapFillQuote(args.quote));
    if (decoded.operationId !== expect.operationId)
        reject(
            VerificationErrorCode.Malformed,
            "quote carries an operation id you did not request",
        );
    if (decoded.contributionSats !== expect.contributionSats)
        reject(
            VerificationErrorCode.Topup,
            `contribution ${decoded.contributionSats} is not the requested ${expect.contributionSats}`,
        );
    if (decoded.fare.currency !== expect.maxFare.currency)
        reject(
            VerificationErrorCode.Fee,
            `fare is in ${decoded.fare.currency}, you authorised ${expect.maxFare.currency}`,
        );
    if (
        decoded.fare.currency === "asset" &&
        !sameAsset(decoded.fare.assetId, expect.maxFare.assetId)
    )
        reject(VerificationErrorCode.Fee, "fare is charged in an asset you did not authorise");
    if (decoded.fare.units > expect.maxFare.units)
        reject(
            VerificationErrorCode.Fee,
            `fare ${decoded.fare.units} exceeds your max ${expect.maxFare.units}`,
        );

    const now = args.now ?? Math.floor(Date.now() / 1000);
    if (now >= decoded.expiresAt)
        reject(VerificationErrorCode.Expired, `quote expired at ${decoded.expiresAt}, now ${now}`);

    const graph = decoded.graph;
    const expectedSolver = new Set(expect.solverInputs.map((i) => `${i.txid}:${i.vout}`));
    const graphSolver = new Set<string>();
    for (const input of graph.inputs) {
        if (input.owner === "solver") graphSolver.add(`${input.txid}:${input.vout}`);
        if (input.owner === "offer-covenant" && expect.fundingTxid !== undefined) {
            if (input.txid !== expect.fundingTxid || input.vout !== expect.fundingVout)
                reject(
                    VerificationErrorCode.Malformed,
                    "quote spends an offer outpoint you did not bind",
                );
        }
    }
    const missing = [...expectedSolver].filter((key) => !graphSolver.has(key));
    if (missing.length)
        reject(VerificationErrorCode.Malformed, `quote omits solver input ${missing[0]}`);
    if (graphSolver.size !== expectedSolver.size)
        reject(VerificationErrorCode.Malformed, "quote carries solver inputs you did not fund");
    if (expect.fundingTxid !== undefined) {
        const bound = graph.inputs.some(
            (input) =>
                input.owner === "offer-covenant" &&
                input.txid === expect.fundingTxid &&
                input.vout === expect.fundingVout,
        );
        if (!bound) reject(VerificationErrorCode.Malformed, "quote omits the bound offer outpoint");
    }
    if (
        !graph.outputs.some(
            (output) =>
                output.role === "solver" && sameBytes(output.script, expect.solverProceedsScript),
        )
    )
        reject(
            VerificationErrorCode.PaymentOutput,
            "quote pays no solver output at your proceeds script",
        );

    const fares = graph.outputs.filter((output) => output.role === "sponsor-fare");
    if (decoded.fare.units > 0n && decoded.fare.currency === "asset" && decoded.fare.assetId) {
        const units = fares
            .flatMap((output) => output.assets)
            .filter((a) => sameAsset(a.assetId, decoded.fare.assetId))
            .reduce((sum, a) => sum + a.units, 0n);
        const foreign = fares
            .flatMap((output) => output.assets)
            .some((a) => !sameAsset(a.assetId, decoded.fare.assetId));
        if (!fares.length || units !== decoded.fare.units || foreign)
            reject(VerificationErrorCode.Fee, "quote fare output does not carry the quoted fare");
    } else if (decoded.fare.units === 0n && fares.length) {
        reject(VerificationErrorCode.Fee, "quote carries an unpriced fare");
    }

    const result = Object.freeze({
        quote: immutablePlainCopy(args.quote, "verified swap-fill quote view"),
        fillId: decoded.fillId,
        contributionSats: decoded.contributionSats,
        fare: immutablePlainCopy(decoded.fare, "verified swap-fill fare view"),
        expiresAt: decoded.expiresAt,
    }) as VerifiedSwapFillQuote;
    registerSwapFillQuote(result, args, args.quote);
    return result;
}

export function registerSwapFillQuote(
    verified: VerifiedSwapFillQuote,
    authorization: VerifySwapFillQuoteArgs,
    baseline: SwapFillQuoteResponse,
): void {
    capabilities.set(verified, {
        authorization: immutablePlainCopy(authorization, "swap-fill quote authorization"),
        baseline: immutablePlainCopy(baseline, "verified swap-fill quote"),
    });
}

export const activeSwapFillStateFor = (
    verified: VerifiedSwapFillQuote,
): ActiveSwapFillCapabilityState => {
    const stored = capabilities.get(verified);
    if (stored === undefined)
        throw new QuoteVerificationError(
            VerificationErrorCode.Malformed,
            "taxi: unrecognized verified quote capability",
        );
    const state = stored;
    const authorization = immutablePlainCopy(
        state.authorization,
        "retained swap-fill authorization",
    );
    const baseline = immutablePlainCopy(state.baseline, "retained swap-fill quote");
    const decoded = rewrap(VerificationErrorCode.Malformed, () =>
        decodeSwapFillQuote(authorization.quote),
    );
    exact(decoded.graph, decodeSwapFillQuote(baseline).graph, "retained fill graph");
    return { authorization, fillId: baseline.fillId, quote: baseline };
};

/** Pre-flight for submit: the caller's solver-signed graph must still be the
 * quoted fill on every economic field. PSBT bytes are excluded on purpose —
 * signing re-encodes them — while the server stays authoritative on bytes and
 * fails any drift safe as a not-submitted graph conflict. */
export function assertSubmittableSwapFill(
    verified: VerifiedSwapFillQuote,
    solverGraph: SwapFillGraphWire,
): string {
    const state = activeSwapFillStateFor(verified);
    const trusted = rewrap(
        VerificationErrorCode.Malformed,
        () => decodeSwapFillQuote(state.quote).graph,
    );
    const solver = rewrap(
        VerificationErrorCode.Malformed,
        () => decodeSwapFillQuote({ ...state.quote, graph: solverGraph }).graph,
    );
    exact(solver.graphId, trusted.graphId, "solver graph id");
    exact(
        solver.inputs.map((i) => ({ owner: i.owner, txid: i.txid.toLowerCase(), vout: i.vout })),
        trusted.inputs.map((i) => ({ owner: i.owner, txid: i.txid.toLowerCase(), vout: i.vout })),
        "solver graph inputs",
    );
    const shape = (o: (typeof trusted.outputs)[number]) => ({
        role: o.role,
        vout: o.vout,
        script: bytesToHex(o.script),
        sats: o.sats,
        assets: o.assets.map((a) => ({
            txid: bytesToHex(a.assetId.txid),
            groupIndex: a.assetId.groupIndex,
            units: a.units,
        })),
    });
    exact(solver.outputs.map(shape), trusted.outputs.map(shape), "solver graph output");
    if (solver.checkpoints.length !== trusted.checkpoints.length)
        reject(
            VerificationErrorCode.Malformed,
            "solver graph checkpoint count differs from the quote",
        );
    return state.fillId;
}
