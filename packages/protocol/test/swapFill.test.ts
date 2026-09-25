import { describe, expect, it } from "vitest";
import { bytesToHex } from "../src/codec.js";
import {
    swapFillGraphFromWire,
    swapFillGraphToWire,
    swapFillQuoteRequestFromWire,
    swapFillStatusFromWire,
    swapFillSubmitRequestFromWire,
    SWAP_FILL_TEMPLATE,
    type SwapFillGraphWire,
    type SwapFillQuoteRequestBody,
    type SwapFillStatusResponse,
} from "../src/swapFill.js";

const GRAPH: SwapFillGraphWire = {
    arkTx: "aGVsbG8=",
    checkpoints: ["d29ybGQ="],
    graphId: "ab".repeat(32),
    template: SWAP_FILL_TEMPLATE,
    inputs: [
        { owner: "offer-covenant", txid: "aa".repeat(32), vout: 0 },
        { owner: "solver", txid: "bb".repeat(32), vout: 1 },
        { owner: "sponsor", txid: "cc".repeat(32), vout: 2 },
    ],
    outputs: [
        { role: "receiver", vout: 0, script: "deadbeef", sats: "1000", assets: [] },
        {
            role: "sponsor-fare",
            vout: 2,
            script: "cafef00d",
            sats: "330",
            assets: [{ assetId: { txid: "be".repeat(32), groupIndex: 0 }, units: "5" }],
        },
        { role: "sponsor-change", vout: 3, script: "00112233", sats: "500", assets: [] },
    ],
};

const REQUEST: SwapFillQuoteRequestBody = {
    operationId: "op-1",
    receiveQuoteId: "receive-1",
    offerHex: "deadbeef",
    solverInputs: [
        { txid: "bb".repeat(32), vout: 1, value: "5000", tapTree: "c0de", spendLeaf: "51" },
    ],
    solverProceedsScript: "deadbeef",
    solverKeys: ["02".padEnd(66, "ab")],
    contributionSats: "330",
    maxFare: { currency: "sats", units: "50" },
};

describe("swap-fill wire codec", () => {
    it("round-trips a joint graph through domain and back", () => {
        const domain = swapFillGraphFromWire(GRAPH);
        expect(bytesToHex(domain.graphId)).toBe(GRAPH.graphId);
        expect(swapFillGraphToWire(domain)).toEqual(GRAPH);
    });

    it("pins the template id", () => {
        expect(SWAP_FILL_TEMPLATE).toBe("taxi-fill/1");
        expect(() =>
            swapFillGraphFromWire({
                ...GRAPH,
                template: "taxi-fill/2",
            } as unknown as SwapFillGraphWire),
        ).toThrow(/template/);
    });

    it("rejects an unknown input owner", () => {
        expect(() =>
            swapFillGraphFromWire({
                ...GRAPH,
                inputs: [{ owner: "server", txid: "aa".repeat(32), vout: 0 }],
            } as unknown as SwapFillGraphWire),
        ).toThrow(/owner/);
    });

    it("rejects an unknown output role", () => {
        expect(() =>
            swapFillGraphFromWire({
                ...GRAPH,
                outputs: [{ role: "operator", vout: 0, script: "deadbeef", sats: "1", assets: [] }],
            } as unknown as SwapFillGraphWire),
        ).toThrow(/role/);
    });

    it("rejects a graph id that is not 32 bytes", () => {
        expect(() => swapFillGraphFromWire({ ...GRAPH, graphId: "ab" })).toThrow(/graphId/);
    });

    it("rejects solver funding with a bad txid or non-positive value", () => {
        expect(() =>
            swapFillQuoteRequestFromWire({
                ...REQUEST,
                solverInputs: [{ ...REQUEST.solverInputs[0]!, txid: "zz", vout: 0, value: "1" }],
            }),
        ).toThrow(/txid/);
        expect(() =>
            swapFillQuoteRequestFromWire({
                ...REQUEST,
                solverInputs: [{ ...REQUEST.solverInputs[0]!, vout: 0, value: "0" }],
            }),
        ).toThrow(/value/);
    });

    it("decodes each solver input's taproot tree and spend leaf to bytes", () => {
        const [input] = swapFillQuoteRequestFromWire(REQUEST).solverInputs;
        expect(input!.tapTree).toEqual(new Uint8Array([0xc0, 0xde]));
        expect(input!.spendLeaf).toEqual(new Uint8Array([0x51]));
    });

    it("refuses a solver input without a well-formed taproot tree and spend leaf", () => {
        const input = REQUEST.solverInputs[0]!;
        const cases: [Record<string, unknown>, RegExp][] = [
            [{ tapTree: undefined }, /solverInputs\[0\]\.tapTree/],
            [{ spendLeaf: undefined }, /solverInputs\[0\]\.spendLeaf/],
            [{ tapTree: "" }, /empty tree or leaf/],
            [{ spendLeaf: "" }, /empty tree or leaf/],
            [{ tapTree: "C0DE" }, /solverInputs\[0\]\.tapTree: not lowercase hex/],
            [{ spendLeaf: "5" }, /solverInputs\[0\]\.spendLeaf: odd-length/],
        ];
        for (const [over, reason] of cases)
            expect(() =>
                swapFillQuoteRequestFromWire({ ...REQUEST, solverInputs: [{ ...input, ...over }] }),
            ).toThrow(reason);
    });

    it("rejects a non-positive contribution or an empty operation id", () => {
        expect(() => swapFillQuoteRequestFromWire({ ...REQUEST, contributionSats: "0" })).toThrow(
            /contribution/,
        );
        expect(() => swapFillQuoteRequestFromWire({ ...REQUEST, operationId: "" })).toThrow(
            /operationId/,
        );
    });

    it("preserves the optional receive quote binding", () => {
        expect(swapFillQuoteRequestFromWire(REQUEST).receiveQuoteId).toBe("receive-1");
        expect(
            swapFillQuoteRequestFromWire({ ...REQUEST, receiveQuoteId: undefined }).receiveQuoteId,
        ).toBeUndefined();
    });

    it("preserves an optional caller deadline ceiling and leaves a legacy request alone", () => {
        expect(
            swapFillQuoteRequestFromWire({ ...REQUEST, validUntil: 1_800_000_000 }).validUntil,
        ).toBe(1_800_000_000);
        expect(swapFillQuoteRequestFromWire(REQUEST).validUntil).toBeUndefined();
        expect(
            swapFillQuoteRequestFromWire({ ...REQUEST, validUntil: undefined }).validUntil,
        ).toBeUndefined();
    });

    it("rejects a deadline that is not a positive safe integer of unix seconds", () => {
        for (const validUntil of [
            0,
            -1,
            1.5,
            Number.NaN,
            Number.POSITIVE_INFINITY,
            2 ** 53,
            "1800000000",
            null,
        ])
            expect(() =>
                swapFillQuoteRequestFromWire({
                    ...REQUEST,
                    validUntil,
                } as unknown as SwapFillQuoteRequestBody),
            ).toThrow(/validUntil/);
    });

    it("rejects solver keys that are not x-only or compressed hex", () => {
        expect(() =>
            swapFillQuoteRequestFromWire({ ...REQUEST, solverKeys: ["not-a-key"] }),
        ).toThrow(/solverKeys/);
    });

    it("round-trips a fill status", () => {
        const status: SwapFillStatusResponse = {
            fillId: "fill-1",
            operationId: "op-1",
            state: "settled",
            txid: "dd".repeat(32),
            outpoint: { txid: "dd".repeat(32), vout: 0 },
            updatedAt: 1_757_000_000,
            expiresAt: 1_757_000_060,
        };
        expect(swapFillStatusFromWire(structuredClone(status))).toEqual(status);
    });

    it("rejects an unknown fill state", () => {
        expect(() =>
            swapFillStatusFromWire({
                fillId: "fill-1",
                operationId: "op-1",
                state: "locking",
                updatedAt: 1,
                expiresAt: 2,
            }),
        ).toThrow(/state/);
    });
});

describe("swap-fill asset group index", () => {
    const GENESIS = "be".repeat(32);
    const graphWithGroup = (groupIndex: number): SwapFillGraphWire =>
        ({
            ...GRAPH,
            outputs: [
                { role: "receiver", vout: 0, script: "deadbeef", sats: "1000", assets: [] },
                {
                    role: "sponsor-fare",
                    vout: 2,
                    script: "cafef00d",
                    sats: "330",
                    assets: [{ assetId: { txid: GENESIS, groupIndex }, units: "5" }],
                },
            ],
        }) as unknown as SwapFillGraphWire;

    it("keeps same-genesis graph assets with different group indices distinct", () => {
        const zero = swapFillGraphFromWire(graphWithGroup(0));
        const one = swapFillGraphFromWire(graphWithGroup(1));
        expect(zero.outputs[1]?.assets[0]?.assetId).not.toEqual(one.outputs[1]?.assets[0]?.assetId);
        expect(one.outputs[1]?.assets[0]?.assetId).toMatchObject({ groupIndex: 1 });
    });

    it("round-trips a graph asset group index through wire and back", () => {
        const domain = swapFillGraphFromWire(graphWithGroup(2));
        expect(swapFillGraphToWire(domain)).toEqual(graphWithGroup(2));
    });

    it("keeps same-genesis solver input assets with different group indices distinct", () => {
        const quoteWithGroup = (groupIndex: number): SwapFillQuoteRequestBody =>
            ({
                ...REQUEST,
                solverInputs: [
                    {
                        ...REQUEST.solverInputs[0]!,
                        assets: [{ assetId: { txid: GENESIS, groupIndex }, amount: "7" }],
                    },
                ],
            }) as unknown as SwapFillQuoteRequestBody;
        const zero = swapFillQuoteRequestFromWire(quoteWithGroup(0));
        const one = swapFillQuoteRequestFromWire(quoteWithGroup(1));
        expect(zero.solverInputs[0]?.assets?.[0]?.assetId).not.toEqual(
            one.solverInputs[0]?.assets?.[0]?.assetId,
        );
        expect(one.solverInputs[0]?.assets?.[0]?.assetId).toMatchObject({ groupIndex: 1 });
    });

    it("parses a submit body down to its solver graph", () => {
        expect(swapFillSubmitRequestFromWire({ solverGraph: GRAPH })).toEqual(
            swapFillGraphFromWire(GRAPH),
        );
    });

    it("rejects a submit body without a solver graph", () => {
        expect(() => swapFillSubmitRequestFromWire({})).toThrow(/solverGraph/);
        expect(() => swapFillSubmitRequestFromWire(null)).toThrow(/expected object/);
    });
});
