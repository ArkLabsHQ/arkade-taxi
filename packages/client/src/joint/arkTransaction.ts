import { hex } from "@scure/base";
import { SigHash } from "@scure/btc-signer";
import { tapLeafHash } from "@scure/btc-signer/payment.js";
import { equalBytes } from "@scure/btc-signer/utils.js";
import {
    Transaction,
    assertAllowedSighashTypes,
    verifyTapscriptSignatures,
} from "@arkade-os/sdk";
/** One `tapScriptSig` entry: who signed, on which leaf, with what bytes. */
export interface TapScriptSigEntry {
    readonly pubKeyHex: string;
    readonly leafHashHex: string;
    readonly signature: Uint8Array;
}

/** Read the `tapScriptSig` entries of one input as plain data. */
export function tapScriptSigEntries(tx: Transaction, inputIndex: number): TapScriptSigEntry[] {
    const input = tx.getInput(inputIndex);
    return (input.tapScriptSig ?? []).map(([data, signature]) => ({
        pubKeyHex: hex.encode(data.pubKey),
        leafHashHex: hex.encode(data.leafHash),
        signature,
    }));
}

/** One spend leaf carried by an input, with its hash precomputed. */
export interface TapLeafRef {
    readonly leafHashHex: string;
    readonly script: Uint8Array;
    readonly version: number;
}

/** Read the spend leaves carried by one input. */
export function tapLeavesOfInput(tx: Transaction, inputIndex: number): TapLeafRef[] {
    const input = tx.getInput(inputIndex);
    return (input.tapLeafScript ?? []).map(([, scriptWithVersion]) => {
        const script = scriptWithVersion.subarray(0, -1);
        const version = scriptWithVersion[scriptWithVersion.length - 1];
        return { leafHashHex: hex.encode(tapLeafHash(script, version)), script, version };
    });
}

/** Reject any input carrying a signature, finalization, or non-DEFAULT declared sighash. */
export function assertUnsignedPsbt(tx: Transaction, context: string): void {
    for (let i = 0; i < tx.inputsLength; i++) {
        const input = tx.getInput(i);
        if (input.tapKeySig && input.tapKeySig.length > 0) {
            throw new Error(`${context}: input ${i} carries a key-path signature`);
        }
        if (input.tapScriptSig && input.tapScriptSig.length > 0) {
            throw new Error(`${context}: input ${i} carries script-path signatures`);
        }
        if (input.partialSig && input.partialSig.length > 0) {
            throw new Error(`${context}: input ${i} carries partial signatures`);
        }
        if (input.finalScriptSig && input.finalScriptSig.length > 0) {
            throw new Error(`${context}: input ${i} is finalized`);
        }
        if (input.finalScriptWitness && input.finalScriptWitness.length > 0) {
            throw new Error(`${context}: input ${i} is finalized`);
        }
    }
    assertAllowedSighashTypes(tx, [SigHash.DEFAULT]);
}

/** Serialize a transaction with all `tapScriptSig` entries stripped. */
export function unsignedPsbtBytes(tx: Transaction): Uint8Array {
    const stripped = tx.clone();
    for (let i = 0; i < stripped.inputsLength; i++) {
        // `[]` would merge (a no-op); an explicit `undefined` deletes.
        stripped.updateInput(i, { tapScriptSig: undefined });
    }
    return stripped.toPSBT();
}

/** Reject a candidate whose unsigned bytes differ from the trusted transaction. */
export function assertSameUnsignedTx(
    candidate: Transaction,
    trusted: Transaction,
    context: string,
): void {
    if (candidate.inputsLength !== trusted.inputsLength) {
        throw new Error(
            `${context}: ${candidate.inputsLength} inputs, expected ${trusted.inputsLength}`,
        );
    }
    if (candidate.outputsLength !== trusted.outputsLength) {
        throw new Error(
            `${context}: ${candidate.outputsLength} outputs, expected ${trusted.outputsLength}`,
        );
    }
    if (!equalBytes(unsignedPsbtBytes(candidate), unsignedPsbtBytes(trusted))) {
        throw new Error(`${context}: unsigned transaction differs from the trusted graph`);
    }
}

/** Replace one input's `tapScriptSig` entries wholesale. */
export function setTapScriptSigEntries(
    tx: Transaction,
    inputIndex: number,
    entries: readonly { pubKey: Uint8Array; leafHash: Uint8Array; signature: Uint8Array }[],
): void {
    // An array merges, so a shorter set would leave stale entries behind;
    // `undefined` deletes, which is what makes this a replacement.
    tx.updateInput(inputIndex, { tapScriptSig: undefined });
    tx.updateInput(inputIndex, {
        tapScriptSig: entries.map((e) => [{ pubKey: e.pubKey, leafHash: e.leafHash }, e.signature]),
    });
}

/**
 * Reject non-64-byte, unexpected-key, or unexpected-leaf entries, then verify
 * every signature.
 *
 * @remarks
 * Omitting `requiredPubKeys` requires EVERY allowed key to have signed, so
 * checking one party's half of a two-party graph must pass it explicitly --
 * `requiredPubKeys: []` verifies the signatures present without demanding any
 * particular signer.
 */
export function assertDefaultTapScriptSigs(
    tx: Transaction,
    inputIndex: number,
    opts: {
        allowedPubKeys: readonly string[];
        leafHash: Uint8Array;
        requiredPubKeys?: readonly string[];
        context: string;
    },
): void {
    const leafHashHex = hex.encode(opts.leafHash);
    for (const entry of tapScriptSigEntries(tx, inputIndex)) {
        if (entry.signature.length !== 64) {
            throw new Error(
                `${opts.context}: input ${inputIndex} carries a ${entry.signature.length}-byte signature from ${entry.pubKeyHex}, expected 64-byte DEFAULT`,
            );
        }
        if (entry.leafHashHex !== leafHashHex) {
            throw new Error(
                `${opts.context}: input ${inputIndex} signature from ${entry.pubKeyHex} commits to unexpected leaf ${entry.leafHashHex}`,
            );
        }
        if (!opts.allowedPubKeys.includes(entry.pubKeyHex)) {
            throw new Error(
                `${opts.context}: input ${inputIndex} carries a signature from unexpected key ${entry.pubKeyHex}`,
            );
        }
    }
    verifyTapscriptSignatures(
        tx,
        inputIndex,
        [...(opts.requiredPubKeys ?? opts.allowedPubKeys)],
        [],
        [SigHash.DEFAULT],
        opts.leafHash,
    );
}

