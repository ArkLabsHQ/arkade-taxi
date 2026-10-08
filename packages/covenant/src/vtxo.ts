import {
    arkade,
    CLTVMultisigTapscript,
    CSVMultisigTapscript,
    MultisigTapscript,
    VtxoScript,
} from "@arkade-os/sdk";
import { buildScripts, type CovenantScripts } from "./scripts.js";
import { compileV2 } from "./v2-artifact.js";
import { validateParams, type DustCovenantParams } from "./params.js";

/** Order fixes the merkle root, so it is part of the address. Do not reorder. */
export enum Leaf {
    Recycle = 0,
    Purchase = 1,
    RefundSender = 2,
    Recovery = 3,
    Exit = 4,
}

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

// Index 4 on the Go mirror is the unused optional LeafReclaim, so the two
// numberings disagree there.
const exitLeaf = (params: DustCovenantParams): Uint8Array =>
    CSVMultisigTapscript.encode({
        timelock: params.exitDelay,
        pubkeys: [params.senderKey, params.operatorSignerKey],
    }).script;

function handBuilt({ serverKey, emulatorKey, params, vtxoMinAmount }: DustCovenantOptions): Tree {
    const covenant = buildScripts(params, vtxoMinAmount);
    const tweak = (script: Uint8Array) => arkade.computeArkadeScriptPublicKey(emulatorKey, script);
    // The disabled slot keeps the tree's shape, so every sibling proof stays put.
    const claimKey = (leaf: Leaf, script: Uint8Array) =>
        tweak(claimLeafDisabled(params, leaf) ? DISABLED_CLAIM_SCRIPT : script);

    return {
        covenant,
        scripts: [
            MultisigTapscript.encode({
                pubkeys: [serverKey, claimKey(Leaf.Recycle, covenant.recycle)],
            }).script,
            MultisigTapscript.encode({
                pubkeys: [serverKey, claimKey(Leaf.Purchase, covenant.purchase)],
            }).script,
            MultisigTapscript.encode({
                pubkeys: [serverKey, params.senderKey, tweak(covenant.refund)],
            }).script,
            CLTVMultisigTapscript.encode({
                absoluteTimelock: params.locktime,
                pubkeys: [serverKey, tweak(covenant.refund)],
            }).script,
            exitLeaf(params),
        ],
    };
}

/**
 * v2's four covenant leaves come out of the compiled artifact, tweak and all.
 * The exit leaf does not: its CSV delay is seconds-domain above 512, and a
 * `$param` CSV read back out of an artifact is always blocks.
 */
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
        },
        scripts: [
            claimLeaf(Leaf.Recycle, recycle.leafScript),
            claimLeaf(Leaf.Purchase, purchase.leafScript),
            refund.leafScript,
            reclaim.leafScript,
            exitLeaf(params),
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
        const tree =
            options.params.covenantVersion === 2 ? fromArtifact(options) : handBuilt(options);
        super(tree.scripts);
        this.covenant = tree.covenant;
    }
}
