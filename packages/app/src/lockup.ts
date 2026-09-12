import { payoutPkScript, type AssetIdRef, type DustCovenantParams } from "@arkade-taxi/covenant";
import type { FareSpec } from "@arkade-taxi/core";
import { hex } from "@scure/base";

/**
 * The outputs a lockup transaction must carry, in index order.
 *
 * Index order is load-bearing: the covenant's claim leaves introspect out[0]
 * and out[1] by position, so a reordering here silently produces a covenant
 * output nobody can spend.
 */
export interface LockupOutput {
    role: "covenant" | "operator-fare" | "sender-change" | "operator-change";
    script: Uint8Array;
    /** Sats on this output. For an asset output this is the HOST value, not the
     * payment — an asset cannot occupy an output on its own. */
    amount: bigint;
    asset?: { id: AssetIdRef; units: bigint };
}

export interface LockupOutputRequest {
    params: DustCovenantParams;
    covenantPkScript: Uint8Array;
    fare: FareSpec;
    /** Sats needed to host an asset output. Unused by a sats fare. */
    vtxoMinAmount: bigint;
    senderChangeSats: bigint;
    senderChangeScript?: Uint8Array;
    senderChangeAsset?: { id: AssetIdRef; units: bigint };
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
 * An asset fare costs the operator hosting sats it pays to ITSELF, so those are
 * not capital at risk — only `topup` is. A sats fare costs no hosting but
 * demands the sender hold spendable bitcoin, which is the thing this service
 * exists so they need not.
 */
export function buildLockupOutputs(req: LockupOutputRequest): LockupOutput[] {
    const { params, fare, vtxoMinAmount, senderChangeSats } = req;

    if (fare.units < 0n) throw new LockupShapeError(`fare must not be negative, got ${fare.units}`);
    if (senderChangeSats < 0n) {
        throw new LockupShapeError(`change must not be negative, got ${senderChangeSats}`);
    }

    const outputs: LockupOutput[] = [
        { role: "covenant", script: req.covenantPkScript, amount: params.dust },
    ];

    if (fare.units > 0n) {
        const hosting = fare.currency === "asset" ? vtxoMinAmount : fare.units;
        if (fare.currency === "asset" && hosting <= 0n) {
            throw new LockupShapeError(
                "an asset fare needs a positive vtxoMinAmount to host it — an asset cannot occupy an output alone",
            );
        }
        outputs.push({
            role: "operator-fare",
            script: payoutPkScript(params.operatorKey, hosting, params.dust),
            amount: hosting,
            ...(fare.currency === "asset"
                ? { asset: { id: fare.assetId, units: fare.units } }
                : {}),
        });
    }

    if (senderChangeSats > 0n || req.senderChangeAsset) {
        if (!req.senderChangeScript) {
            throw new LockupShapeError("senderChangeScript is required when there is change");
        }
        if (req.senderChangeAsset && senderChangeSats < vtxoMinAmount) {
            throw new LockupShapeError("asset change needs vtxoMinAmount of sats to host it");
        }
        outputs.push({
            role: "sender-change",
            script: req.senderChangeScript,
            amount: senderChangeSats,
            ...(req.senderChangeAsset ? { asset: req.senderChangeAsset } : {}),
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
