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
