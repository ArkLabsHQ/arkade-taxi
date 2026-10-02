import { Transaction, VtxoScript, VtxoTaprootTree } from "@arkade-os/sdk";

const TAP_LEAF_VERSION = 0xc0;

const sameBytes = (a: Uint8Array, b: Uint8Array): boolean =>
    a.length === b.length && a.every((value, index) => value === b[index]);

const compactSize = (length: number): number[] => {
    if (length < 0xfd) return [length];
    if (length <= 0xffff) return [0xfd, length & 0xff, length >>> 8];
    return [0xfe, length & 0xff, (length >>> 8) & 0xff, (length >>> 16) & 0xff, length >>> 24];
};

// arkd rebuilds the checkpoints it signs, writing a depth byte of
// min(i+1, n-1) per leaf where the SDK always writes 1. Both decoders discard
// it, so the forms name one tree but agree on bytes only for 2 leaves.
const arkdEncoding = (scripts: readonly Uint8Array[]): Uint8Array =>
    Uint8Array.from(
        scripts.flatMap((script, index) => [
            Math.min(index + 1, scripts.length - 1),
            TAP_LEAF_VERSION,
            ...compactSize(script.length),
            ...script,
        ]),
    );

export const sameTapTree = (actual: Uint8Array, expected: VtxoScript): boolean =>
    sameBytes(actual, expected.encode()) || sameBytes(actual, arkdEncoding(expected.scripts));

const canonicalEntry = (entry: [{ type: number; key: Uint8Array }, Uint8Array]) => {
    const raw = VtxoTaprootTree.decode(entry);
    if (raw === null) return entry;
    try {
        const decoded = VtxoScript.decode(raw);
        return sameTapTree(raw, decoded) ? VtxoTaprootTree.encode(decoded.encode()) : entry;
    } catch {
        return entry;
    }
};

/** Input 0's taptree in SDK form when it already holds one of the two known
 * encodings, left untouched otherwise so a strict comparison still fails. */
export const canonicalCheckpointPsbt = (tx: Transaction): Uint8Array => {
    const copy = Transaction.fromPSBT(tx.toPSBT());
    const entries = copy.getInput(0).unknown;
    if (entries) copy.updateInput(0, { unknown: entries.map(canonicalEntry) });
    return copy.toPSBT();
};
