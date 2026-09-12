import { describe, expect, it } from "vitest";
import {
    assetIdFromWire,
    assetIdToWire,
    bytesToHex,
    hexToBytes,
    quoteParamsFromWire,
    quoteParamsToWire,
    satsFromWire,
    satsToWire,
} from "../src/codec.js";
import type { AssetIdWire, QuoteParams } from "../src/index.js";
import { covenantSpendInputFromWire, covenantSpendInputToWire } from "../src/codec.js";

const bytes = (...b: number[]) => new Uint8Array(b);
const hex32 = (byte: string) => byte.repeat(32);

describe("hexToBytes", () => {
    it("decodes lowercase hex", () => {
        expect(hexToBytes("00ff10", "k")).toEqual(bytes(0x00, 0xff, 0x10));
    });

    it("decodes the empty string to an empty array", () => {
        expect(hexToBytes("", "k")).toEqual(new Uint8Array(0));
    });

    it("rejects odd length, naming the label", () => {
        expect(() => hexToBytes("abc", "serverKey")).toThrow(/serverKey/);
        expect(() => hexToBytes("abc", "serverKey")).toThrow(/odd/i);
    });

    it("rejects non-hex characters, naming the label", () => {
        expect(() => hexToBytes("zz", "emulatorKey")).toThrow(/emulatorKey/);
        expect(() => hexToBytes("00 11", "emulatorKey")).toThrow(/emulatorKey/);
    });

    it("rejects uppercase hex, naming the label", () => {
        expect(() => hexToBytes("AB", "receiverKey")).toThrow(/receiverKey/);
    });

    it("rejects a non-string, naming the label", () => {
        expect(() => hexToBytes(undefined as unknown as string, "txid")).toThrow(/txid/);
        expect(() => hexToBytes(1 as unknown as string, "txid")).toThrow(/txid/);
    });
});

describe("bytesToHex", () => {
    it("encodes lowercase and zero-pads each byte", () => {
        expect(bytesToHex(bytes(0x00, 0x0a, 0xff))).toBe("000aff");
    });

    it("round-trips with hexToBytes", () => {
        const h = hex32("9c");
        expect(bytesToHex(hexToBytes(h, "k"))).toBe(h);
    });
});

describe("satsFromWire", () => {
    it("parses a decimal string", () => {
        expect(satsFromWire("0", "dust")).toBe(0n);
        expect(satsFromWire("330", "dust")).toBe(330n);
    });

    it.each([
        ["", "empty"],
        ["-1", "negative"],
        ["+1", "leading plus"],
        ["1e3", "exponent"],
        ["1.0", "decimal point"],
        [" 1", "leading space"],
        ["1 ", "trailing space"],
        ["0x10", "hex prefix"],
        ["abc", "non-numeric"],
    ])("rejects %o (%s), naming the label", (input) => {
        expect(() => satsFromWire(input, "topup")).toThrow(/topup/);
    });

    it("rejects a non-string, naming the label", () => {
        expect(() => satsFromWire(330 as unknown as string, "feeSats")).toThrow(/feeSats/);
    });

    // The whole reason amounts are strings: Number() would round this to
    // ...992 and the payment would silently be off by one sat.
    it("preserves a value above 2^53 exactly through a round trip", () => {
        const big = "9007199254740993";
        expect(String(Number(big))).not.toBe(big);
        expect(satsFromWire(big, "topup")).toBe(9007199254740993n);
        expect(satsToWire(satsFromWire(big, "topup"))).toBe(big);
    });
});

describe("satsToWire", () => {
    it("encodes a decimal string", () => {
        expect(satsToWire(330n)).toBe("330");
        expect(satsToWire(0n)).toBe("0");
    });

    it("rejects a negative value, since satsFromWire could never read it back", () => {
        expect(() => satsToWire(-1n)).toThrow();
    });
});

describe("assetIdFromWire", () => {
    const wire: AssetIdWire = { txid: hex32("11"), groupIndex: 2 };

    it("decodes txid and groupIndex", () => {
        expect(assetIdFromWire(wire)).toEqual({
            txid: new Uint8Array(32).fill(0x11),
            groupIndex: 2,
        });
    });

    it("rejects a bad txid, naming the field", () => {
        expect(() => assetIdFromWire({ ...wire, txid: "zz" })).toThrow(/assetId\.txid/);
    });

    it.each([-1, 1.5, Number.NaN, "0" as unknown as number])(
        "rejects groupIndex %o, naming the field",
        (groupIndex) => {
            expect(() => assetIdFromWire({ ...wire, groupIndex })).toThrow(/assetId\.groupIndex/);
        },
    );

    it("round-trips with assetIdToWire", () => {
        expect(assetIdToWire(assetIdFromWire(wire))).toEqual(wire);
    });
});

describe("quoteParamsFromWire", () => {
    const wire = (): QuoteParams => ({
        receiverKey: hex32("01"),
        senderKey: hex32("02"),
        operatorKey: hex32("03"),
        dust: "330",
        topup: "330",
        locktime: "800000",
    });

    it("decodes every field to its domain type", () => {
        const p = quoteParamsFromWire(wire());
        expect(p.receiverKey).toEqual(new Uint8Array(32).fill(1));
        expect(p.senderKey).toEqual(new Uint8Array(32).fill(2));
        expect(p.operatorKey).toEqual(new Uint8Array(32).fill(3));
        expect(p.dust).toBe(330n);
        expect(p.topup).toBe(330n);
        expect(p.locktime).toBe(800000n);
        expect(p.assetId).toBeUndefined();
    });

    it("decodes assetId when present", () => {
        const p = quoteParamsFromWire({ ...wire(), assetId: { txid: hex32("11"), groupIndex: 0 } });
        expect(p.assetId).toEqual({ txid: new Uint8Array(32).fill(0x11), groupIndex: 0 });
    });

    it.each([
        ["receiverKey", { receiverKey: "zz" }],
        ["senderKey", { senderKey: "abc" }],
        ["operatorKey", { operatorKey: "AB" }],
        ["dust", { dust: "-1" }],
        ["topup", { topup: "1e3" }],
        ["locktime", { locktime: "" }],
    ])("rejects a bad %s, naming the field", (field, patch) => {
        expect(() => quoteParamsFromWire({ ...wire(), ...patch })).toThrow(
            new RegExp(`params\\.${field}`),
        );
    });

    it("round-trips through quoteParamsToWire, preserving a huge topup exactly", () => {
        const w = { ...wire(), topup: "9007199254740993", dust: "9007199254740993" };
        expect(quoteParamsToWire(quoteParamsFromWire(w))).toEqual(w);
    });

    it("round-trips the asset variant", () => {
        const w = { ...wire(), assetId: { txid: hex32("11"), groupIndex: 7 } };
        expect(quoteParamsToWire(quoteParamsFromWire(w))).toEqual(w);
    });
});
import * as fundingCodec from "../src/codec.js";
describe("funding input wire", () => {
    const wire = {
        txid: "ab".repeat(32),
        vout: 0,
        value: "100",
        tapTree: "00",
        spendLeaf: "51",
        expiry: { kind: "time", value: "1789132933" },
    };
    it("decodes exact tagged expiry evidence and bytes", () => {
        expect(fundingCodec.fundingInputFromWire(wire)).toMatchObject({
            value: 100n,
            expiry: { kind: "time", value: 1789132933n },
            spendLeaf: new Uint8Array([81]),
        });
    });
    it.each([
        { value: 100 },
        { txid: "ab" },
        { tapTree: "GG" },
        { vout: -1 },
        { expiry: { kind: "height", value: 99 } },
        { expiry: { kind: "other", value: "99" } },
        { assetPacket: "0" },
    ])("rejects malformed funding %j", (over) => {
        expect(() => fundingCodec.fundingInputFromWire({ ...wire, ...over })).toThrow();
    });
});

describe("covenant spend input wire", () => {
    const wire = () => ({
        txid: "ab".repeat(32),
        vout: 7,
        value: "9007199254740993",
        tapTree: "010203",
        selectedLeaf: "51c0",
        controlBlock: {
            version: 0xc1,
            internalKey: "12".repeat(32),
            merklePath: ["34".repeat(32)],
        },
        assetPacket: "0001",
    });

    it("round-trips exact bigint, tree, selected leaf, control block, and asset bytes", () => {
        const decoded = covenantSpendInputFromWire(wire());
        expect(decoded).toMatchObject({
            txid: "ab".repeat(32),
            vout: 7,
            value: 9_007_199_254_740_993n,
            tapTree: new Uint8Array([1, 2, 3]),
            tapLeafScript: [
                {
                    version: 0xc1,
                    internalKey: new Uint8Array(32).fill(0x12),
                    merklePath: [new Uint8Array(32).fill(0x34)],
                },
                new Uint8Array([0x51, 0xc0]),
            ],
            assetPacket: new Uint8Array([0, 1]),
        });
        expect(covenantSpendInputToWire(decoded)).toEqual(wire());
    });

    it.each([
        { txid: "AB".repeat(32) },
        { value: 1 },
        { tapTree: "" },
        { selectedLeaf: "51c2" },
        { assetPacket: "" },
        { controlBlock: { ...wire().controlBlock, internalKey: "12" } },
        { controlBlock: { ...wire().controlBlock, merklePath: ["34"] } },
        { controlBlock: { ...wire().controlBlock, extra: true } },
        { extra: true },
    ])("rejects non-canonical covenant spend input %j", (over) => {
        expect(() => covenantSpendInputFromWire({ ...wire(), ...over })).toThrow();
    });

    it("returns detached bytes", () => {
        const decoded = covenantSpendInputFromWire(wire());
        const encoded = covenantSpendInputToWire(decoded);
        decoded.tapTree[0] = 0xff;
        decoded.tapLeafScript[0].internalKey[0] = 0xff;
        decoded.tapLeafScript[1][0] = 0xff;
        decoded.assetPacket![0] = 0xff;
        expect(encoded).toEqual(wire());
    });

    it("rejects an accessor-forged Merkle path without invoking it", () => {
        let reads = 0;
        const merklePath = ["34".repeat(32)];
        Object.defineProperty(merklePath, "0", {
            enumerable: true,
            get() {
                reads++;
                return "34".repeat(32);
            },
        });
        expect(() =>
            covenantSpendInputFromWire({
                ...wire(),
                controlBlock: { ...wire().controlBlock, merklePath },
            }),
        ).toThrow(/data property|shape/i);
        expect(reads).toBe(0);
    });
});
