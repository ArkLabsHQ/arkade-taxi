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

        super([
            MultisigTapscript.encode({ pubkeys: [serverKey, tweak(covenant.recycle)] }).script,
            MultisigTapscript.encode({ pubkeys: [serverKey, tweak(covenant.purchase)] }).script,
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
