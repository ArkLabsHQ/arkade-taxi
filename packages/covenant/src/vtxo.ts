import { arkade, CLTVMultisigTapscript, MultisigTapscript, VtxoScript } from "@arkade-os/sdk";
import { buildScripts, type CovenantScripts } from "./scripts.js";
import type { DustCovenantParams } from "./params.js";

/** Order fixes the merkle root, so it is part of the address. Do not reorder. */
export enum Leaf {
    Recycle = 0,
    Purchase = 1,
    RefundSender = 2,
    Recovery = 3,
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

/**
 * Every leaf but RefundSender is arkade-only, so anyone able to construct a
 * satisfying transaction may spend it — that is what lets the receiver stay
 * offline at payment time.
 */
export class DustCovenantScript extends VtxoScript {
    readonly covenant: CovenantScripts;

    constructor(readonly options: DustCovenantOptions) {
        const { serverKey, emulatorKey, params, vtxoMinAmount } = options;
        const covenant = buildScripts(params, vtxoMinAmount);
        const tweak = (script: Uint8Array) =>
            arkade.computeArkadeScriptPublicKey(emulatorKey, script);
        // The disabled slot keeps the tree's shape, so every sibling proof stays put.
        const claimKey = (leaf: Leaf, script: Uint8Array) =>
            tweak(claimLeafDisabled(params, leaf) ? DISABLED_CLAIM_SCRIPT : script);

        super([
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
        ]);

        this.covenant = covenant;
    }
}
