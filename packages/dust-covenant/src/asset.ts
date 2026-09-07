import type { arkade } from "@arkade-os/sdk";
import type { AssetIdRef } from "./params.js";

/**
 * `required` decides how the found flag is consumed, and the distinction is
 * load-bearing. A miss pushes (0, 0). Dropping the flag everywhere makes a wrong
 * AssetID — from a byte-order slip or a deliberate substitution — miss on every
 * read, degenerating the sum to 0 == 0 + 0 so the covenant passes with the asset
 * constraint silently unenforced.
 */
export function appendAssetLookup(
    out: arkade.ArkadeScriptType,
    idx: number,
    id: AssetIdRef,
    output: boolean,
    required: boolean,
): void {
    out.push(
        idx,
        id.txid,
        id.groupIndex,
        output ? "INSPECTOUTASSETLOOKUP" : "INSPECTINASSETLOOKUP",
        required ? "VERIFY" : "DROP",
    );
}
