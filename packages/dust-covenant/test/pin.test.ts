import { sha256 } from "@noble/hashes/sha2.js";
import { describe, expect, it } from "vitest";
import { arkade } from "@arkade-os/sdk";
import { payoutPkScript, pinOutput, subDustScript } from "../src/pin.js";
import { appendAssetLookup } from "../src/asset.js";
import type { AssetIdRef } from "../src/params.js";

const key = new Uint8Array(32).fill(0xab);
const assetId: AssetIdRef = { txid: new Uint8Array(32).fill(0x11), groupIndex: 0 };

describe("subDustScript", () => {
    it("is OP_RETURN followed by a 32-byte push", () => {
        expect(subDustScript(key)).toEqual(new Uint8Array([0x6a, 0x20, ...key]));
    });
});

describe("payoutPkScript", () => {
    it("is P2TR at or above dust", () => {
        expect(payoutPkScript(key, 330n, 330n)).toEqual(new Uint8Array([0x51, 0x20, ...key]));
    });

    it("is sub-dust OP_RETURN below dust", () => {
        expect(payoutPkScript(key, 100n, 330n)).toEqual(subDustScript(key));
    });
});

describe("pinOutput", () => {
    it("pins an at-dust output to the witness program form", () => {
        const out: arkade.ArkadeScriptType = [];
        pinOutput(out, 0, key, 330n, 330n);
        expect(out).toEqual([0, "INSPECTOUTPUTSCRIPTPUBKEY", 1, "EQUALVERIFY", key, "EQUALVERIFY"]);
    });

    // pushScriptPubKey reports a witness program as (program, version) but
    // anything else as (sha256(script), -1), so a below-dust output must be
    // pinned in its sub-dust OP_RETURN form.
    it("pins a below-dust output to sha256 of its OP_RETURN form with version -1", () => {
        const out: arkade.ArkadeScriptType = [];
        pinOutput(out, 1, key, 100n, 330n);
        expect(out).toEqual([
            1,
            "INSPECTOUTPUTSCRIPTPUBKEY",
            -1,
            "EQUALVERIFY",
            sha256(subDustScript(key)),
            "EQUALVERIFY",
        ]);
    });

    it("encodes -1 as OP_1NEGATE", () => {
        const out: arkade.ArkadeScriptType = [];
        pinOutput(out, 0, key, 100n, 330n);
        expect(Array.from(arkade.ArkadeScript.encode(out))).toContain(0x4f);
    });
});

describe("appendAssetLookup", () => {
    it("VERIFYs the found flag where the asset must exist", () => {
        const out: arkade.ArkadeScriptType = [];
        appendAssetLookup(out, 1, assetId, true, true);
        expect(out).toEqual([1, assetId.txid, 0, "INSPECTOUTASSETLOOKUP", "VERIFY"]);
    });

    // Only the receiver's prior balance may legitimately be absent, so only that
    // lookup drops. Dropping the flag everywhere makes a wrong AssetID miss on
    // every read, degenerating the sum to 0 == 0 + 0 and passing with the asset
    // constraint silently unenforced.
    it("DROPs the found flag where the asset may legitimately be absent", () => {
        const out: arkade.ArkadeScriptType = [];
        appendAssetLookup(out, 1, assetId, false, false);
        expect(out).toEqual([1, assetId.txid, 0, "INSPECTINASSETLOOKUP", "DROP"]);
    });

    it("selects the input opcode when output is false", () => {
        const out: arkade.ArkadeScriptType = [];
        appendAssetLookup(out, 0, assetId, false, true);
        expect(out[3]).toBe("INSPECTINASSETLOOKUP");
    });
});
