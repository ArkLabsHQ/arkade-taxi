import { describe, expect, it } from "vitest";
import { arkade } from "@arkade-os/sdk";
import { sha256 } from "@noble/hashes/sha2.js";
import { subDustScript } from "../src/pin.js";
import {
    buildPurchase,
    buildReclaim,
    buildReclaimWhole,
    buildRecycle,
    buildRefund,
    buildRepayRefund,
    buildScripts,
} from "../src/scripts.js";
import type { AssetIdRef, DustCovenantParams } from "../src/params.js";
import { receiverPaid } from "./fixtures.js";

const key = (fill: number) => new Uint8Array(32).fill(fill);
const assetId: AssetIdRef = { txid: new Uint8Array(32).fill(0x11), groupIndex: 0 };

const base = (): DustCovenantParams => ({
    receiverKey: key(1),
    senderKey: key(2),
    operatorKey: key(3),
    operatorSignerKey: key(6),
    exitDelay: { value: 86_016n, type: "seconds" },
    dust: 330n,
    topup: 330n,
    locktime: 800_000n,
});

const asm = (script: Uint8Array) => arkade.ArkadeScript.decode(script);

// decode returns small values as numbers but anything wider as raw script-num
// bytes, so a literal like 330n never appears in a decoded script.
const num = (n: bigint) => arkade.BigNum.encode(n);
const pinHash = (xonlyKey: Uint8Array) => sha256(subDustScript(xonlyKey));

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

    it("a zero fare builds the recycle leaf a fareless covenant builds", () => {
        expect(
            buildRecycle(receiverPaid({ receiverFare: { currency: "sats", units: 0n } })),
        ).toEqual(buildRecycle(receiverPaid({ receiverFare: undefined })));
    });

    it.each([
        ["sats", { currency: "sats", units: 7n }],
        ["asset", { currency: "asset", units: 9n }],
    ] as const)(
        "a %s fare leaves purchase, refund and reclaim byte-identical",
        (_label, receiverFare) => {
            const bare = receiverPaid({ receiverFare: undefined });
            const withFare = receiverPaid({ receiverFare });
            expect(buildPurchase(withFare)).toEqual(buildPurchase(bare));
            expect(buildRefund(withFare, 1n)).toEqual(buildRefund(bare, 1n));
            expect(buildReclaim(withFare, 1n)).toEqual(buildReclaim(bare, 1n));
            expect(buildRecycle(withFare)).not.toEqual(buildRecycle(bare));
        },
    );
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

    it("keeps explicit sender recovery byte-identical to the absent legacy term", () => {
        const sender = { ...base(), assetId, recoveryRecipient: "sender" } as DustCovenantParams;
        expect(buildRefund(sender, 1n)).toEqual(buildRefund({ ...base(), assetId }, 1n));
    });

    it("pays a receiver-owned refund to the receiver and never the sender", () => {
        const params = {
            ...base(),
            assetId,
            recoveryRecipient: "receiver",
        } as DustCovenantParams;
        const decoded = asm(buildRefund(params, 1n));
        expect(decoded).toContainEqual(pinHash(key(1)));
        expect(decoded).not.toContainEqual(pinHash(key(2)));
        expect(decoded).toContainEqual(num(329n));
    });

    it("repays a whole-dust advance in full and returns the payment to the sender", () => {
        const decoded = asm(buildRefund({ ...base(), paymentSats: 100n }, 1n));
        expect(decoded).toContainEqual(num(330n));
        expect(decoded).toContainEqual(num(100n));
        expect(decoded).toContainEqual(pinHash(key(2)));
        expect(decoded).not.toContainEqual(num(329n));
    });

    it("keeps a bitcoin covenant without paymentSats byte-identical", () => {
        expect(buildRefund({ ...base(), topup: 230n }, 1n)).toEqual(
            buildRefund({ ...base(), topup: 230n, paymentSats: undefined }, 1n),
        );
    });

    it("repays a precharged 329-sat advance in full while retaining a one-sat receipt", () => {
        const params = {
            ...base(),
            topup: 329n,
            assetId,
            recoveryRecipient: "receiver",
        } as DustCovenantParams;
        const decoded = asm(buildRefund(params, 1n));
        expect(decoded).toContainEqual(num(329n));
        expect(decoded).toContainEqual(pinHash(key(1)));
        expect(decoded).not.toContainEqual(pinHash(key(2)));
    });
});

const v2 = (over: Partial<DustCovenantParams> = {}): DustCovenantParams => ({
    ...base(),
    covenantVersion: 2,
    ...over,
});

describe("buildRepayRefund", () => {
    it("repays exactly the loan and merges both inputs back into input 1's own script", () => {
        expect(asm(buildRepayRefund(v2()))).toEqual([
            "PUSHCURRENTINPUTINDEX",
            0,
            "EQUALVERIFY",
            "INSPECTNUMINPUTS",
            2,
            "EQUALVERIFY",
            1,
            "INSPECTINPUTSCRIPTPUBKEY",
            1,
            "EQUALVERIFY",
            1,
            "INSPECTOUTPUTSCRIPTPUBKEY",
            1,
            "EQUALVERIFY",
            "EQUALVERIFY",
            0,
            "INSPECTOUTPUTVALUE",
            num(330n),
            "EQUALVERIFY",
            0,
            "INSPECTOUTPUTSCRIPTPUBKEY",
            1,
            "EQUALVERIFY",
            key(3),
            "EQUALVERIFY",
            1,
            "INSPECTOUTPUTVALUE",
            0,
            "INSPECTINPUTVALUE",
            1,
            "INSPECTINPUTVALUE",
            "ADD",
            num(330n),
            "SUB",
            "EQUALVERIFY",
            1,
        ]);
    });

    it("moves the whole holding to out[1] by recycle's asset rule", () => {
        const tail = (script: Uint8Array) => asm(script).slice(-17);
        expect(tail(buildRepayRefund(v2({ assetId })))).toEqual(
            tail(buildRecycle({ ...base(), assetId })),
        );
    });

    it("ignores the receiver fare", () => {
        expect(buildRepayRefund(receiverPaid({ covenantVersion: 2 }))).toEqual(
            buildRepayRefund(receiverPaid({ covenantVersion: 2, receiverFare: undefined })),
        );
    });
});

describe("buildReclaimWhole", () => {
    it("pays in[0]'s whole value to the operator's taproot key", () => {
        expect(asm(buildReclaimWhole(v2({ paymentSats: 100n })))).toEqual([
            "PUSHCURRENTINPUTINDEX",
            0,
            "EQUALVERIFY",
            0,
            "INSPECTOUTPUTSCRIPTPUBKEY",
            1,
            "EQUALVERIFY",
            key(3),
            "EQUALVERIFY",
            0,
            "INSPECTOUTPUTVALUE",
            0,
            "INSPECTINPUTVALUE",
            "EQUALVERIFY",
            1,
        ]);
    });

    it("moves in[0]'s whole holding to out[0]", () => {
        const decoded = asm(buildReclaimWhole(v2({ assetId })));
        expect(decoded.at(-1)).toBe("EQUAL");
        expect(decoded.filter((o) => o === "INSPECTOUTASSETLOOKUP")).toHaveLength(1);
        expect(decoded.filter((o) => o === "INSPECTINASSETLOOKUP")).toHaveLength(1);
        expect(decoded.filter((o) => o === "VERIFY")).toHaveLength(2);
    });
});

describe("buildScripts", () => {
    it("adds a distinct v2 reclaim and swaps in the v2 refund", () => {
        const s = buildScripts(v2(), 330n);
        expect(Object.keys(s).sort()).toEqual(["purchase", "reclaim", "recycle", "refund"]);
        expect(s.refund).toEqual(buildRepayRefund(v2()));
        expect(s.reclaim).toEqual(buildReclaimWhole(v2()));
    });

    it("leaves recycle and purchase byte-identical to legacy", () => {
        const legacy = buildScripts(base(), 1n);
        expect(buildScripts(v2(), 1n)).toMatchObject({
            recycle: legacy.recycle,
            purchase: legacy.purchase,
        });
    });

    it.each([
        ["bitcoin", v2()],
        ["bitcoin with a payment", v2({ paymentSats: 100n })],
        ["sender-paid asset", v2({ assetId })],
        ["receiver-paid sats fare", receiverPaid({ covenantVersion: 2 })],
        [
            "receiver-paid asset fare",
            receiverPaid({ covenantVersion: 2, receiverFare: { currency: "asset", units: 9n } }),
        ],
    ])("builds %s at dust = vtxoMinAmount, independent of vtxoMinAmount", (_name, p) => {
        expect(buildScripts(p, 330n)).toEqual(buildScripts(p, 1n));
    });

    it("rejects invalid params before building", () => {
        expect(() => buildScripts({ ...base(), locktime: 0n }, 10n)).toThrow(/locktime/);
    });

    it("returns all three scripts", () => {
        const s = buildScripts(base(), 10n);
        expect(Object.keys(s).sort()).toEqual(["purchase", "recycle", "refund"]);
    });
});
