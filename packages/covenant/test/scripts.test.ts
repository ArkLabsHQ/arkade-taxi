import { describe, expect, it } from "vitest";
import { arkade } from "@arkade-os/sdk";
import { buildPurchase, buildRecycle, buildRefund, buildScripts } from "../src/scripts.js";
import type { AssetIdRef, DustCovenantParams } from "../src/params.js";

const key = (fill: number) => new Uint8Array(32).fill(fill);
const assetId: AssetIdRef = { txid: new Uint8Array(32).fill(0x11), groupIndex: 0 };

const base = (): DustCovenantParams => ({
    receiverKey: key(1),
    senderKey: key(2),
    operatorKey: key(3),
    dust: 330n,
    topup: 330n,
    locktime: 800_000n,
});

const asm = (script: Uint8Array) => arkade.ArkadeScript.decode(script);

// decode returns small values as numbers but anything wider as raw script-num
// bytes, so a literal like 330n never appears in a decoded script.
const num = (n: bigint) => arkade.BigNum.encode(n);

describe("buildRecycle", () => {
    it("pins the current input index to 0 and the input count to 2", () => {
        expect(asm(buildRecycle(base())).slice(0, 6)).toEqual([
            "PUSHCURRENTINPUTINDEX",
            0,
            "EQUALVERIFY",
            "INSPECTNUMINPUTS",
            2,
            "EQUALVERIFY",
        ]);
    });

    // Enforced as a sum over both inputs rather than as a constant, so the
    // receiver's prior balance is irrelevant.
    it("derives out[1] value from both input values minus topup", () => {
        const decoded = asm(buildRecycle(base()));
        const at = decoded.lastIndexOf("INSPECTINPUTVALUE");
        expect(decoded.slice(at + 1, at + 4)).toEqual(["ADD", num(330n), "SUB"]);
    });

    it("ends with OP_1 for the bitcoin variant", () => {
        expect(asm(buildRecycle(base())).at(-1)).toBe(1);
    });

    it("appends three asset lookups and ends with EQUAL for the asset variant", () => {
        const decoded = asm(buildRecycle({ ...base(), assetId }));
        expect(decoded.at(-1)).toBe("EQUAL");
        expect(decoded.filter((o) => o === "INSPECTOUTASSETLOOKUP")).toHaveLength(1);
        expect(decoded.filter((o) => o === "INSPECTINASSETLOOKUP")).toHaveLength(2);
    });

    it("requires the receiver's prior balance lookup to DROP, not VERIFY", () => {
        const decoded = asm(buildRecycle({ ...base(), assetId }));
        expect(decoded.filter((o) => o === "DROP")).toHaveLength(1);
        expect(decoded.filter((o) => o === "VERIFY")).toHaveLength(2);
    });
});

describe("buildPurchase", () => {
    // Reads only in[0], and out[0] is tied to in[0]'s value, so an extra input
    // cannot divert the covenant. Recycle needs the guard because it reads a
    // second input.
    it("does not pin the input count", () => {
        expect(asm(buildPurchase(base()))).not.toContain("INSPECTNUMINPUTS");
    });

    it("ties out[0] value to in[0] value", () => {
        expect(asm(buildPurchase(base()))).toEqual([
            "PUSHCURRENTINPUTINDEX",
            0,
            "EQUALVERIFY",
            0,
            "INSPECTOUTPUTSCRIPTPUBKEY",
            1,
            "EQUALVERIFY",
            key(1),
            "EQUALVERIFY",
            0,
            "INSPECTOUTPUTVALUE",
            0,
            "INSPECTINPUTVALUE",
            "EQUALVERIFY",
            1,
        ]);
    });
});

describe("buildRefund", () => {
    it("caps the operator payout at dust minus vtxoMinAmount when topup is the whole unit", () => {
        expect(asm(buildRefund(base(), 10n))).toContainEqual(num(320n));
    });

    it("pays the sender the remainder as a sub-dust output", () => {
        expect(asm(buildRefund(base(), 10n))).toContain(-1);
    });
});

describe("buildScripts", () => {
    it("rejects invalid params before building", () => {
        expect(() => buildScripts({ ...base(), locktime: 0n }, 10n)).toThrow(/locktime/);
    });

    it("returns all three scripts", () => {
        const s = buildScripts(base(), 10n);
        expect(Object.keys(s).sort()).toEqual(["purchase", "recycle", "refund"]);
    });
});
