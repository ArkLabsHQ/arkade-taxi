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
        recoveryRecipient?: "sender" | "receiver";
        claimMode?: "recycle" | "purchase";
        receiverFareCurrency?: "sats" | "asset";
        receiverFareUnits?: number;
    };
    vtxoMinAmount: number;
    recycle: string;
    purchase: string;
    refund: string;
    reclaim?: string;
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
    recoveryRecipient: v.params.recoveryRecipient,
    claimMode: v.params.claimMode,
    receiverFare: v.params.receiverFareCurrency
        ? {
              currency: v.params.receiverFareCurrency as "sats" | "asset",
              units: BigInt(v.params.receiverFareUnits ?? 0),
          }
        : undefined,
});

const carrier = JSON.parse(
    readFileSync(new URL("./receiver-vectors.json", import.meta.url), "utf8"),
) as { reference: string; cases: Vector[] };

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

describe(`additive receiver vectors from Go reference ${carrier.reference.slice(0, 8)}`, () => {
    it("keeps the original fixture intact and pins the accepted semantic source", () => {
        expect(reference).toBe("49ae96d0241e7672e40b25543875538d4373fb80");
        expect(carrier.reference).toBe("d4771c80982e77a55a6f8863155f45cec1dd12e5");
    });

    it.each(carrier.cases.map((c) => [c.name, c] as const))(
        "%s produces byte-identical scripts",
        (_name, v) => {
            const built = buildScripts(toParams(v), BigInt(v.vtxoMinAmount));
            expect(hex.encode(built.recycle)).toBe(v.recycle);
            expect(hex.encode(built.purchase)).toBe(v.purchase);
            expect(hex.encode(built.refund)).toBe(v.refund);
            if (v.reclaim !== undefined) expect(hex.encode(built.refund)).toBe(v.reclaim);
        },
    );
});
