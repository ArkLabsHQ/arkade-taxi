import { describe, expect, it } from "vitest";
import { arkade } from "@arkade-os/sdk";
import { buildRecycle } from "../src/scripts.js";
import type { AssetIdRef, DustCovenantParams } from "../src/params.js";

const key = (fill: number) => new Uint8Array(32).fill(fill);
const assetId: AssetIdRef = { txid: new Uint8Array(32).fill(0x11), groupIndex: 0 };

const params: DustCovenantParams = {
    receiverKey: key(1),
    senderKey: key(2),
    operatorKey: key(3),
    dust: 330n,
    topup: 330n,
    locktime: 800_000n,
    assetId,
};

const decoded = () => arkade.ArkadeScript.decode(buildRecycle(params));

/**
 * A miss returns (0, 0). If every lookup DROPped its flag, a wrong AssetID would
 * miss on all three reads, the sum would degenerate to 0 == 0 + 0, and the
 * covenant would pass with the asset clause silently unenforced.
 */
describe("asset found-flag consumption", () => {
    it("VERIFYs exactly the two lookups that must find the asset", () => {
        expect(decoded().filter((o) => o === "VERIFY")).toHaveLength(2);
    });

    it("DROPs exactly the one lookup that may legitimately miss", () => {
        expect(decoded().filter((o) => o === "DROP")).toHaveLength(1);
    });

    it("DROPs the receiver's prior-balance lookup, not a required one", () => {
        const ops = decoded();
        const dropIndex = ops.indexOf("DROP");
        expect(ops[dropIndex - 1]).toBe("INSPECTINASSETLOOKUP");
        expect(ops[dropIndex - 4]).toBe(1);
    });
});

/**
 * recycle reads a second input, so without this guard a spender could add an
 * input and divert the covenant. purchase deliberately omits it because it reads
 * only in[0].
 */
describe("input count guard", () => {
    it("pins numInputs to exactly 2", () => {
        const ops = decoded();
        const i = ops.indexOf("INSPECTNUMINPUTS");
        expect(i).toBeGreaterThanOrEqual(0);
        expect(ops[i + 1]).toBe(2);
        expect(ops[i + 2]).toBe("EQUALVERIFY");
    });
});
