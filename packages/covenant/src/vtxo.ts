import { arkade, MultisigTapscript, VtxoScript } from "@arkade-os/sdk";
import { compileV2 } from "./v2-artifact.js";
import { validateParams, type DustCovenantParams } from "./params.js";

/** Order fixes the merkle root, so it is part of the address. Do not reorder. */
export enum Leaf {
    Recycle = 0,
    Purchase = 1,
    RefundSender = 2,
    Recovery = 3,
    Exit = 4,
    Renew = 5,
}

/** The arkade scripts the tree committed to, one per covenant leaf. */
export type CovenantScripts = {
    recycle: Uint8Array;
    purchase: Uint8Array;
    refund: Uint8Array;
    reclaim: Uint8Array;
    renew: Uint8Array;
};

export interface DustCovenantOptions {
    serverKey: Uint8Array;
    emulatorKey: Uint8Array;
    params: DustCovenantParams;
    vtxoMinAmount: bigint;
}

// arkd requires a recognized multisig closure, so disable its emulator script
// instead of using a naked OP_FALSE leaf; the two-key closure stays parseable.
export const DISABLED_CLAIM_SCRIPT: Uint8Array = arkade.ArkadeScript.encode([0]);

/** Whether this params set forbids spending `leaf`. */
export function claimLeafDisabled(params: DustCovenantParams, leaf: Leaf): boolean {
    return (
        params.claimMode !== undefined &&
        ((params.claimMode === "recycle" && leaf === Leaf.Purchase) ||
            (params.claimMode === "purchase" && leaf === Leaf.Recycle))
    );
}

type Tree = { scripts: Uint8Array[]; covenant: CovenantScripts };

/** Every leaf comes out of the compiled artifact, tweak and all. */
function fromArtifact({
    serverKey,
    emulatorKey,
    params,
    vtxoMinAmount,
}: DustCovenantOptions): Tree {
    validateParams(params, vtxoMinAmount);
    const compiled = compileV2(params, serverKey, emulatorKey);
    const leaf = (name: string) => {
        const fn = compiled.functionByName(name);
        if (!fn?.arkadeScript) throw new Error(`covenant: artifact declares no covenant ${name}`);
        return { leafScript: fn.leafScript, arkadeScript: fn.arkadeScript };
    };
    const recycle = leaf("recycle");
    const purchase = leaf("purchase");
    const refund = leaf("repayRefund");
    const reclaim = leaf("reclaimWhole");
    const renew = leaf("renew");
    const exit = compiled.functionByName("exit");
    if (!exit) throw new Error("covenant: artifact declares no exit");
    const claimLeaf = (which: Leaf, script: Uint8Array) =>
        claimLeafDisabled(params, which)
            ? MultisigTapscript.encode({
                  pubkeys: [
                      serverKey,
                      arkade.computeArkadeScriptPublicKey(emulatorKey, DISABLED_CLAIM_SCRIPT),
                  ],
              }).script
            : script;

    return {
        covenant: {
            recycle: recycle.arkadeScript,
            purchase: purchase.arkadeScript,
            refund: refund.arkadeScript,
            reclaim: reclaim.arkadeScript,
            renew: renew.arkadeScript,
        },
        scripts: [
            claimLeaf(Leaf.Recycle, recycle.leafScript),
            claimLeaf(Leaf.Purchase, purchase.leafScript),
            refund.leafScript,
            reclaim.leafScript,
            exit.leafScript,
            renew.leafScript,
        ],
    };
}

/**
 * Every leaf but RefundSender and Exit is arkade-only, so anyone able to construct a
 * satisfying transaction may spend it — that is what lets the receiver stay
 * offline at payment time.
 */
export class DustCovenantScript extends VtxoScript {
    readonly covenant: CovenantScripts;

    constructor(readonly options: DustCovenantOptions) {
        const tree = fromArtifact(options);
        super(tree.scripts);
        this.covenant = tree.covenant;
    }
}
