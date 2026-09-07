import { payoutPkScript, type DustCovenantParams } from "@arkade-taxi/covenant";
import { hex } from "@scure/base";

/**
 * The outputs a lockup transaction must carry, in index order.
 *
 * Index order is load-bearing: the covenant's claim leaves introspect out[0]
 * and out[1] by position, so a reordering here silently produces a covenant
 * output nobody can spend.
 */
export interface LockupOutput {
    /** What the output is for, for logs and tests. Not committed to anywhere. */
    role: "covenant" | "operator-fee" | "sender-change";
    script: Uint8Array;
    amount: bigint;
}

export interface LockupOutputRequest {
    params: DustCovenantParams;
    covenantPkScript: Uint8Array;
    feeSats: bigint;
    /** Sats the sender contributes beyond the covenant and the fee. */
    senderChangeSats: bigint;
    senderChangeScript?: Uint8Array;
}

export class LockupShapeError extends Error {
    readonly code = "lockup_shape";
}

const sameScript = (a: Uint8Array, b: Uint8Array) =>
    a.length === b.length && a.every((byte, i) => byte === b[i]);

/**
 * Refuses two outputs sharing a scriptPubKey.
 *
 * Sighash commits to the prevout amount and the wallet resolves inputs by
 * script, taking the FIRST match — so a second output with the same script
 * signs for the wrong amount. It surfaces as an invalid checkpoint signature,
 * which points nowhere near the cause.
 */
export function assertDistinctScripts(outputs: readonly LockupOutput[]): void {
    for (let i = 0; i < outputs.length; i++) {
        for (let j = i + 1; j < outputs.length; j++) {
            const a = outputs[i];
            const b = outputs[j];
            if (a && b && sameScript(a.script, b.script)) {
                throw new LockupShapeError(
                    `outputs ${i} (${a.role}) and ${j} (${b.role}) share a scriptPubKey`,
                );
            }
        }
    }
}

/**
 * The operator's fee output uses the same sub-dust-or-P2TR rule the covenant
 * pins its own payouts with, so a fee below dust is still spendable rather than
 * an unspendable OP_RETURN the operator cannot recover.
 */
export function buildLockupOutputs(req: LockupOutputRequest): LockupOutput[] {
    const { params, feeSats, senderChangeSats } = req;

    if (feeSats < 0n) throw new LockupShapeError(`fee must not be negative, got ${feeSats}`);
    if (senderChangeSats < 0n) {
        throw new LockupShapeError(`change must not be negative, got ${senderChangeSats}`);
    }

    const outputs: LockupOutput[] = [
        { role: "covenant", script: req.covenantPkScript, amount: params.dust },
    ];

    if (feeSats > 0n) {
        outputs.push({
            role: "operator-fee",
            script: payoutPkScript(params.operatorKey, feeSats, params.dust),
            amount: feeSats,
        });
    }

    if (senderChangeSats > 0n) {
        if (!req.senderChangeScript) {
            throw new LockupShapeError("senderChangeScript is required when change is non-zero");
        }
        outputs.push({
            role: "sender-change",
            script: req.senderChangeScript,
            amount: senderChangeSats,
        });
    }

    assertDistinctScripts(outputs);
    return outputs;
}

/** Total sats the lockup must be funded with, operator topup included. */
export function lockupFundingTotal(outputs: readonly LockupOutput[]): bigint {
    return outputs.reduce((sum, o) => sum + o.amount, 0n);
}

export const describeOutputs = (outputs: readonly LockupOutput[]): string =>
    outputs
        .map((o, i) => `${i}:${o.role}=${o.amount}@${hex.encode(o.script).slice(0, 12)}`)
        .join(" ");
