import { describe, expect, it } from "vitest";
import { MultisigTapscript, VtxoScript, arkade } from "@arkade-os/sdk";
import { p2tr, TAPROOT_UNSPENDABLE_KEY, taprootListToTree } from "@scure/btc-signer";
import { schnorr } from "@noble/curves/secp256k1.js";
import { hex } from "@scure/base";
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

const opts = (p: DustCovenantParams = params()) => ({
    serverKey: key(4),
    emulatorKey: key(5),
    params: p,
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

// The mode is committed to by the tree, not merely by policy.
describe("claim mode is committed to by the tree", () => {
    const legacy = new DustCovenantScript(opts());
    const recycleOnly = new DustCovenantScript(opts({ ...params(), claimMode: "recycle" }));
    const purchaseOnly = new DustCovenantScript(opts({ ...params(), claimMode: "purchase" }));

    it("keeps the absent-mode tree byte-identical to the historical address", () => {
        expect(legacy.pkScript).toEqual(new DustCovenantScript(opts()).pkScript);
        expect(legacy.scripts).toEqual(new DustCovenantScript(opts()).scripts);
    });

    it("keeps all four leaf indexes in place for every mode", () => {
        for (const script of [legacy, recycleOnly, purchaseOnly]) {
            expect(script.scripts).toHaveLength(4);
            expect(Leaf.Recycle).toBe(0);
            expect(Leaf.Purchase).toBe(1);
            expect(Leaf.RefundSender).toBe(2);
            expect(Leaf.Recovery).toBe(3);
        }
    });

    it("derives a different address once a mode is committed", () => {
        expect(recycleOnly.pkScript).not.toEqual(legacy.pkScript);
        expect(purchaseOnly.pkScript).not.toEqual(legacy.pkScript);
        expect(purchaseOnly.pkScript).not.toEqual(recycleOnly.pkScript);
    });

    it("leaves the unconstrained leaves untouched", () => {
        expect(recycleOnly.scripts[Leaf.Recycle]).toEqual(legacy.scripts[Leaf.Recycle]);
        expect(recycleOnly.scripts[Leaf.RefundSender]).toEqual(legacy.scripts[Leaf.RefundSender]);
        expect(recycleOnly.scripts[Leaf.Recovery]).toEqual(legacy.scripts[Leaf.Recovery]);
        expect(purchaseOnly.scripts[Leaf.Purchase]).toEqual(legacy.scripts[Leaf.Purchase]);
    });

    it("disables exactly the forbidden claim closure", () => {
        const disabled = (script: DustCovenantScript, leaf: Leaf) =>
            hex.encode(script.scripts[leaf]) !== hex.encode(legacy.scripts[leaf]);
        expect(disabled(recycleOnly, Leaf.Purchase)).toBe(true);
        expect(disabled(recycleOnly, Leaf.Recycle)).toBe(false);
        expect(disabled(purchaseOnly, Leaf.Recycle)).toBe(true);
        expect(disabled(purchaseOnly, Leaf.Purchase)).toBe(false);
    });

    // A disabled slot still parses as the multisig closure arkd recognizes.
    it("keeps the disabled slot a two-key multisig closure", () => {
        for (const [script, leaf] of [
            [recycleOnly, Leaf.Purchase],
            [purchaseOnly, Leaf.Recycle],
        ] as const) {
            const closure = MultisigTapscript.decode(script.scripts[leaf]);
            expect(closure.params.pubkeys).toHaveLength(2);
            expect(closure.params.pubkeys[0]).toEqual(key(4));
        }
    });

    it("points the disabled slot at the false-emulator key", () => {
        const falseKey = arkade.computeArkadeScriptPublicKey(
            key(5),
            arkade.ArkadeScript.encode([0]),
        );
        expect(
            MultisigTapscript.decode(recycleOnly.scripts[Leaf.Purchase]).params.pubkeys[1],
        ).toEqual(falseKey);
        expect(recycleOnly.scripts[Leaf.Purchase]).toEqual(purchaseOnly.scripts[Leaf.Recycle]);
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
