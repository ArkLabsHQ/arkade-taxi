import { readFileSync } from "node:fs";
import { hex } from "@scure/base";
import { describe, expect, it } from "vitest";
import { buildScripts } from "../src/scripts.js";
import type { DustCovenantParams } from "../src/params.js";

type Vector = {
    name: string;
    params: {
        receiverKey: string;
        senderKey: string;
        operatorKey: string;
        dust: number;
        topup: number;
        assetTxid: string | null;
        assetIndex: number | null;
        locktime: number;
    };
    vtxoMinAmount: number;
    recycle: string;
    purchase: string;
    refund: string;
};

const { reference, cases } = JSON.parse(
    readFileSync(new URL("./vectors.json", import.meta.url), "utf8"),
) as { reference: string; cases: Vector[] };

const toParams = (v: Vector): DustCovenantParams => ({
    receiverKey: hex.decode(v.params.receiverKey),
    senderKey: hex.decode(v.params.senderKey),
    operatorKey: hex.decode(v.params.operatorKey),
    dust: BigInt(v.params.dust),
    topup: BigInt(v.params.topup),
    locktime: BigInt(v.params.locktime),
    assetId: v.params.assetTxid
        ? { txid: hex.decode(v.params.assetTxid), groupIndex: v.params.assetIndex ?? 0 }
        : undefined,
});

describe(`golden vectors from Go reference ${reference.slice(0, 8)}`, () => {
    it("covers both variants and both pinOutput branches", () => {
        expect(cases.length).toBeGreaterThanOrEqual(9);
        expect(cases.some((c) => c.params.assetTxid)).toBe(true);
        expect(cases.some((c) => !c.params.assetTxid)).toBe(true);
        expect(cases.some((c) => c.params.topup === c.params.dust)).toBe(true);
        expect(cases.some((c) => c.params.topup < c.params.dust)).toBe(true);
    });

    it.each(cases.map((c) => [c.name, c] as const))(
        "%s produces byte-identical scripts",
        (_name, v) => {
            const built = buildScripts(toParams(v), BigInt(v.vtxoMinAmount));
            expect(hex.encode(built.recycle)).toBe(v.recycle);
            expect(hex.encode(built.purchase)).toBe(v.purchase);
            expect(hex.encode(built.refund)).toBe(v.refund);
        },
    );
});
