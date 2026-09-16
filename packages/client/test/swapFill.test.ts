import { describe, expect, it } from "vitest";
import type {
    SwapFillGraphWire,
    SwapFillQuoteResponse,
    SwapFillStatusResponse,
} from "@arkade-taxi/protocol";
import { TaxiClient } from "../src/client.js";
import { ClientErrorCode } from "../src/errors.js";
import {
    assertSubmittableSwapFill,
    isSwapFillOperationConflict,
    isSwapFillSettlementClaim,
    isSwapFillSettled,
    isSwapFillSubmitAmbiguous,
    isSwapFillTerminal,
    swapFillMakerOutpoint,
    swapFillTxid,
    verifySwapFillQuote,
    SwapFillSubmitAmbiguousError,
    type SwapFillQuoteExpectation,
} from "../src/swapFill.js";
import { jsonResponse, recordingFetch } from "./fixtures.js";

const BASE = "https://taxi.example";
const NOW = 1_000_000_000;
const DEP = { txid: "dd".repeat(32), vout: 3 };
const SOLVER_COIN = { txid: "ee".repeat(32), vout: 1 };
const PROCEEDS = new Uint8Array([0x51]);
const FARE_ASSET = { txid: "12".repeat(32), groupIndex: 0 };

const graph = (over: Partial<SwapFillGraphWire> = {}): SwapFillGraphWire => ({
    arkTx: "aGVsbG8=",
    checkpoints: ["aGVsbG8="],
    graphId: "ab".repeat(32),
    template: "taxi-fill/1",
    inputs: [
        { owner: "offer-covenant", txid: DEP.txid, vout: DEP.vout },
        { owner: "solver", txid: SOLVER_COIN.txid, vout: SOLVER_COIN.vout },
        { owner: "sponsor", txid: "cc".repeat(32), vout: 0 },
    ],
    outputs: [
        { role: "receiver", vout: 0, script: "bd".repeat(34), sats: "5000", assets: [] },
        { role: "solver", vout: 1, script: "51", sats: "1000", assets: [] },
        { role: "sponsor-change", vout: 2, script: "cc".repeat(34), sats: "100", assets: [] },
    ],
    ...over,
});

const quote = (over: Partial<SwapFillQuoteResponse> = {}): SwapFillQuoteResponse => ({
    fillId: "fill-1",
    operationId: "op-1",
    expiresAt: NOW + 60,
    template: "taxi-fill/1",
    contributionSats: "330",
    fare: { currency: "sats", units: "0" },
    graph: graph(),
    ...over,
});

const expectTerms = (over: Partial<SwapFillQuoteExpectation> = {}): SwapFillQuoteExpectation => ({
    operationId: "op-1",
    solverProceedsScript: PROCEEDS,
    solverInputs: [{ txid: SOLVER_COIN.txid, vout: SOLVER_COIN.vout }],
    contributionSats: 330n,
    maxFare: { currency: "sats", units: 10n },
    fundingTxid: DEP.txid,
    fundingVout: DEP.vout,
    ...over,
});

const status = (over: Partial<SwapFillStatusResponse> = {}): SwapFillStatusResponse => ({
    fillId: "fill-1",
    operationId: "op-1",
    state: "quoted",
    updatedAt: NOW,
    expiresAt: NOW + 60,
    ...over,
});

describe("verifySwapFillQuote", () => {
    it("accepts a quote that echoes the requested terms", () => {
        const verified = verifySwapFillQuote({ quote: quote(), expect: expectTerms(), now: NOW });
        expect(verified.quote.fillId).toBe("fill-1");
        expect(verified.contributionSats).toBe(330n);
    });

    it("rejects a fare above the authorised maximum", () => {
        expect(() =>
            verifySwapFillQuote({
                quote: quote({ fare: { currency: "sats", units: "11" } }),
                expect: expectTerms(),
                now: NOW,
            }),
        ).toThrow(/exceeds your max/);
    });

    it("rejects a fare in a currency the caller did not authorise", () => {
        expect(() =>
            verifySwapFillQuote({
                quote: quote({ fare: { currency: "asset", units: "1", assetId: FARE_ASSET } }),
                expect: expectTerms(),
                now: NOW,
            }),
        ).toThrow(/authorised sats/);
    });

    it("rejects a contribution that differs from the requested amount", () => {
        expect(() =>
            verifySwapFillQuote({
                quote: quote({ contributionSats: "331" }),
                expect: expectTerms(),
                now: NOW,
            }),
        ).toThrow(/contribution/);
    });

    it("rejects an operation id the caller did not request", () => {
        expect(() =>
            verifySwapFillQuote({
                quote: quote({ operationId: "op-2" }),
                expect: expectTerms(),
                now: NOW,
            }),
        ).toThrow(/operation/);
    });

    it("rejects an expired quote at the expiry instant", () => {
        expect(() =>
            verifySwapFillQuote({
                quote: quote({ expiresAt: NOW }),
                expect: expectTerms(),
                now: NOW,
            }),
        ).toThrow(/expired/);
    });

    it("rejects a graph missing the solver proceeds output", () => {
        const g = graph({
            outputs: [
                { role: "receiver", vout: 0, script: "bd".repeat(34), sats: "5000", assets: [] },
                { role: "solver", vout: 1, script: "52", sats: "1000", assets: [] },
            ],
        });
        expect(() =>
            verifySwapFillQuote({ quote: quote({ graph: g }), expect: expectTerms(), now: NOW }),
        ).toThrow(/proceeds/);
    });

    it("rejects a graph missing a requested solver input", () => {
        const g = graph({
            inputs: [{ owner: "offer-covenant", txid: DEP.txid, vout: DEP.vout }],
        });
        expect(() =>
            verifySwapFillQuote({ quote: quote({ graph: g }), expect: expectTerms(), now: NOW }),
        ).toThrow(/solver input/);
    });

    it("rejects a malformed wire graph with a typed verification error", () => {
        const g = { ...graph(), template: "taxi-fill/9" };
        let code: string | undefined;
        try {
            verifySwapFillQuote({
                quote: quote({ graph: g as SwapFillGraphWire }),
                expect: expectTerms(),
                now: NOW,
            });
        } catch (e) {
            code = (e as { code?: string }).code;
        }
        expect(code).toBe("MALFORMED_QUOTE");
    });

    it("rejects an unpriced sponsor-fare output when the fare is zero", () => {
        const g = graph({
            outputs: [
                ...graph().outputs,
                {
                    role: "sponsor-fare",
                    vout: 3,
                    script: "cc".repeat(34),
                    sats: "330",
                    assets: [{ assetId: FARE_ASSET, units: "5" }],
                },
            ],
        });
        expect(() =>
            verifySwapFillQuote({ quote: quote({ graph: g }), expect: expectTerms(), now: NOW }),
        ).toThrow(/unpriced fare/);
    });

    it("accepts a priced asset fare carried by a sponsor-fare output", () => {
        const wireAsset = { txid: "12".repeat(32), groupIndex: 0 };
        const domainAsset = { txid: new Uint8Array(32).fill(0x12), groupIndex: 0 };
        const g = graph({
            outputs: [
                ...graph().outputs,
                {
                    role: "sponsor-fare",
                    vout: 3,
                    script: "cc".repeat(34),
                    sats: "330",
                    assets: [{ assetId: wireAsset, units: "5" }],
                },
            ],
        });
        const verified = verifySwapFillQuote({
            quote: quote({ fare: { currency: "asset", units: "5", assetId: wireAsset }, graph: g }),
            expect: expectTerms({
                maxFare: { currency: "asset", units: 5n, assetId: domainAsset },
            }),
            now: NOW,
        });
        expect(verified.fare.units).toBe(5n);
    });
});

describe("assertSubmittableSwapFill", () => {
    it("returns the fill id when the solver graph matches the quote", () => {
        const verified = verifySwapFillQuote({ quote: quote(), expect: expectTerms(), now: NOW });
        expect(assertSubmittableSwapFill(verified, graph())).toBe("fill-1");
    });

    it("rejects a solver graph that diverts an output", () => {
        const verified = verifySwapFillQuote({ quote: quote(), expect: expectTerms(), now: NOW });
        const diverted = graph({
            outputs: graph().outputs.map((o) => (o.role === "solver" ? { ...o, script: "52" } : o)),
        });
        expect(() => assertSubmittableSwapFill(verified, diverted)).toThrow(
            /solver graph output mismatch/,
        );
    });
});

describe("swap-fill status", () => {
    it("decodes a status strictly and surfaces txid as the proof reference", () => {
        const s = status({ state: "settled", txid: "ee".repeat(32) });
        expect(swapFillTxid(s)).toBe("ee".repeat(32));
        expect(isSwapFillSettled(s)).toBe(true);
        expect(isSwapFillTerminal(s)).toBe(true);
    });

    it("treats submitting-with-txid as a claim, not settlement", () => {
        const s = status({ state: "submitting", txid: "ee".repeat(32) });
        expect(isSwapFillSettlementClaim(s)).toBe(true);
        expect(isSwapFillSettled(s)).toBe(false);
        expect(isSwapFillTerminal(s)).toBe(false);
    });

    it("exposes the maker outpoint as a receipt locator only", () => {
        const s = status({
            state: "settled",
            txid: "ee".repeat(32),
            outpoint: { txid: "ee".repeat(32), vout: 0 },
        });
        expect(swapFillMakerOutpoint(s)).toEqual({ txid: "ee".repeat(32), vout: 0 });
        expect(swapFillMakerOutpoint(status())).toBeUndefined();
    });

    it("rejects a malformed status with INVALID_RESPONSE", async () => {
        const fetch = recordingFetch(() => jsonResponse(200, { ...status(), state: "nope" }));
        const taxi = new TaxiClient({ baseUrl: BASE, fetch });
        await expect(taxi.swapFillStatus("fill-1")).rejects.toMatchObject({
            code: ClientErrorCode.InvalidResponse,
        });
    });
});

describe("swap-fill submit error contract", () => {
    it("surfaces an ambiguous submit without retrying", async () => {
        const fetch = recordingFetch(() =>
            jsonResponse(503, {
                error: "boom (ambiguous: reconcile before retrying, never auto-retry)",
                code: "swap_fill_submission_ambiguous",
            }),
        );
        const taxi = new TaxiClient({ baseUrl: BASE, fetch });
        const verified = verifySwapFillQuote({ quote: quote(), expect: expectTerms(), now: NOW });
        const rejected = await taxi.submitSwapFill(verified, graph()).then(
            () => null,
            (e: unknown) => e,
        );
        expect(rejected).toBeInstanceOf(SwapFillSubmitAmbiguousError);
        expect(isSwapFillSubmitAmbiguous(rejected)).toBe(true);
        expect(fetch.calls).toHaveLength(1);
    });

    it("keeps a not-submitted failure distinct from ambiguous", async () => {
        const fetch = recordingFetch(() =>
            jsonResponse(409, {
                error: "solver graph differs (not submitted)",
                code: "swap_fill_graph_conflict",
            }),
        );
        const taxi = new TaxiClient({ baseUrl: BASE, fetch });
        const verified = verifySwapFillQuote({ quote: quote(), expect: expectTerms(), now: NOW });
        const rejected = await taxi.submitSwapFill(verified, graph()).then(
            () => null,
            (e: unknown) => e,
        );
        expect(rejected).not.toBeInstanceOf(SwapFillSubmitAmbiguousError);
        expect(isSwapFillSubmitAmbiguous(rejected)).toBe(false);
        expect((rejected as { code?: string }).code).toBe("swap_fill_graph_conflict");
    });

    it("flags an operation conflict distinctly from an identical replay", async () => {
        const conflict = { error: "operation id was already quoted", code: "operation_conflict" };
        expect(isSwapFillOperationConflict(conflict)).toBe(false);
        const fetch = recordingFetch(() => jsonResponse(409, conflict));
        const taxi = new TaxiClient({ baseUrl: BASE, fetch });
        const rejected = await taxi
            .requestSwapFillQuote({
                operationId: "op-1",
                offerHex: "ab12",
                solverInputs: [],
                solverProceedsScript: PROCEEDS,
                solverKeys: [],
                contributionSats: 330n,
                maxFare: { currency: "sats", units: 10n },
            })
            .then(
                () => null,
                (e: unknown) => e,
            );
        expect(isSwapFillOperationConflict(rejected)).toBe(true);
    });

    it("replays an identical retry as the same reservation", async () => {
        const fetch = recordingFetch(() => jsonResponse(200, quote()));
        const taxi = new TaxiClient({ baseUrl: BASE, fetch });
        const first = await taxi.requestVerifiedSwapFillQuote({
            operationId: "op-1",
            offerHex: "ab12",
            solverInputs: [{ txid: SOLVER_COIN.txid, vout: SOLVER_COIN.vout, value: 6000n }],
            solverProceedsScript: PROCEEDS,
            solverKeys: ["ab".repeat(32)],
            contributionSats: 330n,
            maxFare: { currency: "sats", units: 10n },
            fundingTxid: DEP.txid,
            fundingVout: DEP.vout,
            now: NOW,
        });
        const second = await taxi.requestVerifiedSwapFillQuote({
            operationId: "op-1",
            offerHex: "ab12",
            solverInputs: [{ txid: SOLVER_COIN.txid, vout: SOLVER_COIN.vout, value: 6000n }],
            solverProceedsScript: PROCEEDS,
            solverKeys: ["ab".repeat(32)],
            contributionSats: 330n,
            maxFare: { currency: "sats", units: 10n },
            fundingTxid: DEP.txid,
            fundingVout: DEP.vout,
            now: NOW,
        });
        expect(second.verified.quote.fillId).toBe(first.verified.quote.fillId);
    });
});

describe("TaxiClient swap-fill endpoints", () => {
    it("POSTs a swap-fill quote encoded as wire hex and decimal strings", async () => {
        const fetch = recordingFetch(() => jsonResponse(200, quote()));
        const taxi = new TaxiClient({ baseUrl: BASE, fetch });
        await taxi.requestSwapFillQuote({
            operationId: "op-1",
            offerHex: "ab12",
            solverInputs: [{ txid: SOLVER_COIN.txid, vout: SOLVER_COIN.vout, value: 6000n }],
            solverProceedsScript: PROCEEDS,
            solverKeys: ["ab".repeat(32)],
            contributionSats: 330n,
            maxFare: { currency: "sats", units: 10n },
            fundingTxid: DEP.txid,
            fundingVout: DEP.vout,
        });
        const call = fetch.calls[0]!;
        expect(call.url).toBe(`${BASE}/v1/swap-fills`);
        expect(call.init.method).toBe("POST");
        expect(JSON.parse(String(call.init.body))).toEqual({
            operationId: "op-1",
            offerHex: "ab12",
            solverInputs: [{ txid: SOLVER_COIN.txid, vout: 1, value: "6000" }],
            solverProceedsScript: "51",
            solverKeys: ["ab".repeat(32)],
            contributionSats: "330",
            maxFare: { currency: "sats", units: "10" },
            fundingTxid: DEP.txid,
            fundingVout: DEP.vout,
        });
    });

    it("refuses to submit a diverted graph without touching the network", async () => {
        const fetch = recordingFetch(() => jsonResponse(202, status({ state: "submitting" })));
        const taxi = new TaxiClient({ baseUrl: BASE, fetch });
        const verified = verifySwapFillQuote({ quote: quote(), expect: expectTerms(), now: NOW });
        const diverted = graph({
            outputs: graph().outputs.map((o) => (o.role === "solver" ? { ...o, script: "52" } : o)),
        });
        await expect(taxi.submitSwapFill(verified, diverted)).rejects.toMatchObject({
            code: "MALFORMED_QUOTE",
        });
        expect(fetch.calls).toHaveLength(0);
    });

    it("GETs the fill status from /v1/swap-fills/:id", async () => {
        const fetch = recordingFetch(() => jsonResponse(200, status()));
        const taxi = new TaxiClient({ baseUrl: BASE, fetch });
        expect(await taxi.swapFillStatus("fill-1")).toEqual(status());
        expect(fetch.calls[0]?.url).toBe(`${BASE}/v1/swap-fills/fill-1`);
    });
});
