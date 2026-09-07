import { describe, expect, it } from "vitest";
import { VtxoScript } from "@arkade-os/sdk";
import { p2tr, TAPROOT_UNSPENDABLE_KEY, taprootListToTree } from "@scure/btc-signer";
import { schnorr } from "@noble/curves/secp256k1.js";
import { DustCovenantScript, Leaf } from "../src/vtxo.js";
import type { DustCovenantParams } from "../src/params.js";

// Real curve points. computeArkadeScriptPublicKey lifts the emulator key to do
// point addition, so 32 arbitrary bytes fail with "cannot find square root".
const key = (fill: number) => schnorr.getPublicKey(new Uint8Array(32).fill(fill));

const params = (): DustCovenantParams => ({
    receiverKey: key(1),
    senderKey: key(2),
    operatorKey: key(3),
    dust: 330n,
    topup: 330n,
    locktime: 800_000n,
});

const opts = () => ({
    serverKey: key(4),
    emulatorKey: key(5),
    params: params(),
    vtxoMinAmount: 10n,
});

describe("DustCovenantScript", () => {
    it("has four leaves in the order that fixes the merkle root", () => {
        const s = new DustCovenantScript(opts());
        expect(s.scripts).toHaveLength(4);
        expect(Leaf.Recycle).toBe(0);
        expect(Leaf.Recovery).toBe(3);
    });

    it("is deterministic for the same parameters", () => {
        expect(new DustCovenantScript(opts()).pkScript).toEqual(
            new DustCovenantScript(opts()).pkScript,
        );
    });

    it("changes the address when any parameter changes", () => {
        const a = new DustCovenantScript(opts()).pkScript;
        const b = new DustCovenantScript({
            ...opts(),
            params: { ...params(), topup: 300n },
        }).pkScript;
        expect(a).not.toEqual(b);
    });

    it("derives a bech32m Arkade address", () => {
        const s = new DustCovenantScript(opts());
        expect(s.address("ark", key(4)).encode()).toMatch(/^ark1/);
    });

    it("exposes the three covenant scripts it committed to", () => {
        expect(Object.keys(new DustCovenantScript(opts()).covenant).sort()).toEqual([
            "purchase",
            "recycle",
            "refund",
        ]);
    });
});

// VtxoScript uses btcd's AssembleTaprootScriptTree. @scure/btc-signer's default
// taprootListToTree is a Huffman builder that only agrees with arkd for
// power-of-2 leaf counts. At 4 leaves both happen to agree; splitting the shared
// refund leaf would make it 5 and silently change the address.
describe("taptree assembly", () => {
    // Tapscript leaves, not scriptPubKeys: <32-byte key> OP_CHECKSIG.
    const leaves = (n: number) =>
        Array.from({ length: n }, (_, i) => new Uint8Array([0x20, ...key(i + 1), 0xac]));

    const huffman = (scripts: Uint8Array[]) =>
        p2tr(
            TAPROOT_UNSPENDABLE_KEY,
            taprootListToTree(scripts.map((script) => ({ script, leafVersion: 0xc0 }))),
            undefined,
            true,
        ).script;

    it("agrees with the Huffman builder at four leaves", () => {
        expect(new VtxoScript(leaves(4)).pkScript).toEqual(huffman(leaves(4)));
    });

    it("DIVERGES from the Huffman builder at five leaves", () => {
        expect(new VtxoScript(leaves(5)).pkScript).not.toEqual(huffman(leaves(5)));
    });
});
