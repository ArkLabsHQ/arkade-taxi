import { describe, expect, it } from "vitest";
import { arkade } from "@arkade-os/sdk";
import { schnorr } from "@noble/curves/secp256k1.js";
import { compileV2 } from "../src/v2-artifact.js";
import type { AssetIdRef, DustCovenantParams } from "../src/params.js";

const key = (fill: number) => schnorr.getPublicKey(new Uint8Array(32).fill(fill));
const assetId: AssetIdRef = { txid: new Uint8Array(32).fill(0x11), groupIndex: 0 };

const params: DustCovenantParams = {
    receiverKey: key(1),
    senderKey: key(2),
    operatorKey: key(3),
    operatorSignerKey: key(6),
    exitDelay: { value: 86_016n, type: "seconds" },
    dust: 330n,
    topup: 330n,
    locktime: 1_800_000_000n,
    assetId,
};

const ops = (name: string) =>
    arkade.ArkadeScript.decode(
        compileV2(params, key(4), key(5)).functionByName(name)!.arkadeScript!,
    );

/**
 * A miss returns (0, 0). If a lookup discarded its flag, a wrong AssetID would
 * miss on every read, the sum would degenerate to 0 == 0 + 0, and the covenant
 * would pass with the asset clause silently unenforced.
 */
describe("asset found-flag consumption", () => {
    const consumption = (name: string) => {
        const o = ops(name);
        return o.flatMap((op, i) =>
            op === "INSPECTINASSETLOOKUP" || op === "INSPECTOUTASSETLOOKUP"
                ? [o[i + 1] === "VERIFY" ? "verify" : `${String(o[i + 1])},${String(o[i + 2])}`]
                : [],
        );
    };

    it("verifies or branches on every recycle lookup's flag, never drops one", () => {
        expect(consumption("recycle")).toEqual(["verify", "NIP,IF", "verify", "verify", "verify"]);
    });

    it("verifies or branches on every repayRefund lookup's flag", () => {
        expect(consumption("repayRefund")).toEqual(["NIP,IF", "verify", "verify", "verify"]);
    });

    it.each(["purchase", "reclaimWhole"])("verifies both %s lookups", (name) => {
        expect(consumption(name)).toEqual(["verify", "verify"]);
    });
});

/**
 * recycle and repayRefund read a second input, so without this guard a spender
 * could add an input and divert the covenant. purchase and reclaimWhole
 * deliberately omit it because they read only in[0].
 */
describe("input count guard", () => {
    it.each(["recycle", "repayRefund"])("pins %s to exactly 2 inputs", (name) => {
        const o = ops(name);
        const i = o.indexOf("INSPECTNUMINPUTS");
        expect(i).toBeGreaterThanOrEqual(0);
        expect(o[i + 1]).toBe(2);
        expect(o[i + 2]).toBe("EQUALVERIFY");
    });

    it.each(["purchase", "reclaimWhole"])("leaves %s unpinned", (name) => {
        expect(ops(name)).not.toContain("INSPECTNUMINPUTS");
    });
});
