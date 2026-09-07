import { arkade } from "@arkade-os/sdk";
import { appendAssetLookup } from "./asset.js";
import { pinOutput } from "./pin.js";
import { refundTopup, validateParams, type DustCovenantParams } from "./params.js";

const finish = (out: arkade.ArkadeScriptType, hasAsset: boolean): Uint8Array => {
    if (!hasAsset) out.push(1);
    return arkade.ArkadeScript.encode(out);
};

/**
 * in[0] covenant, in[1] receiver account.
 * out[0] operator repaid topup, out[1] receiver's merged account.
 */
export function buildRecycle(p: DustCovenantParams): Uint8Array {
    const out: arkade.ArkadeScriptType = [
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
        p.receiverKey,
        "EQUALVERIFY",
        0,
        "INSPECTOUTPUTVALUE",
        p.topup,
        "EQUALVERIFY",
    ];
    pinOutput(out, 0, p.operatorKey, p.topup, p.dust);
    out.push(
        1,
        "INSPECTOUTPUTSCRIPTPUBKEY",
        1,
        "EQUALVERIFY",
        p.receiverKey,
        "EQUALVERIFY",
        1,
        "INSPECTOUTPUTVALUE",
        0,
        "INSPECTINPUTVALUE",
        1,
        "INSPECTINPUTVALUE",
        "ADD",
        p.topup,
        "SUB",
        "EQUALVERIFY",
    );
    if (p.assetId) {
        appendAssetLookup(out, 1, p.assetId, true, true);
        appendAssetLookup(out, 0, p.assetId, false, true);
        appendAssetLookup(out, 1, p.assetId, false, false);
        out.push("ADD", "EQUAL");
    }
    return finish(out, p.assetId !== undefined);
}

/**
 * Deliberately does not pin the input count. It reads only in[0], and out[0] is
 * tied to in[0]'s value and asset amount, so an extra input cannot divert the
 * covenant — whatever a spender adds flows to their own outputs.
 */
export function buildPurchase(p: DustCovenantParams): Uint8Array {
    const out: arkade.ArkadeScriptType = [
        "PUSHCURRENTINPUTINDEX",
        0,
        "EQUALVERIFY",
        0,
        "INSPECTOUTPUTSCRIPTPUBKEY",
        1,
        "EQUALVERIFY",
        p.receiverKey,
        "EQUALVERIFY",
        0,
        "INSPECTOUTPUTVALUE",
        0,
        "INSPECTINPUTVALUE",
        "EQUALVERIFY",
    ];
    if (p.assetId) {
        appendAssetLookup(out, 0, p.assetId, true, true);
        appendAssetLookup(out, 0, p.assetId, false, true);
        out.push("EQUAL");
    }
    return finish(out, p.assetId !== undefined);
}

/**
 * Shared by the sender-signed refund leaf and the timelocked recovery leaf. The
 * sender receives a sub-dust receipt, acceptable because the sender demonstrably
 * owns a funded account and can merge it later; it would not be acceptable for
 * the receiver, which is why no claim leaf pays sub-dust.
 */
export function buildRefund(p: DustCovenantParams, vtxoMinAmount: bigint): Uint8Array {
    const topup = refundTopup(p, vtxoMinAmount);
    const out: arkade.ArkadeScriptType = [
        "PUSHCURRENTINPUTINDEX",
        0,
        "EQUALVERIFY",
        0,
        "INSPECTOUTPUTVALUE",
        topup,
        "EQUALVERIFY",
    ];
    pinOutput(out, 0, p.operatorKey, topup, p.dust);
    out.push(1, "INSPECTOUTPUTVALUE", p.dust - topup, "EQUALVERIFY");
    pinOutput(out, 1, p.senderKey, p.dust - topup, p.dust);
    if (p.assetId) {
        appendAssetLookup(out, 1, p.assetId, true, true);
        appendAssetLookup(out, 0, p.assetId, false, true);
        out.push("EQUAL");
    }
    return finish(out, p.assetId !== undefined);
}

export type CovenantScripts = {
    recycle: Uint8Array;
    purchase: Uint8Array;
    refund: Uint8Array;
};

export function buildScripts(p: DustCovenantParams, vtxoMinAmount: bigint): CovenantScripts {
    validateParams(p, vtxoMinAmount);
    return {
        recycle: buildRecycle(p),
        purchase: buildPurchase(p),
        refund: buildRefund(p, vtxoMinAmount),
    };
}
