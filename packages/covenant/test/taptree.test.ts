import { describe, expect, it } from "vitest";
import { CSVMultisigTapscript, MultisigTapscript, VtxoScript, arkade } from "@arkade-os/sdk";
import { p2tr, TAPROOT_UNSPENDABLE_KEY, taprootListToTree } from "@scure/btc-signer";
import { schnorr } from "@noble/curves/secp256k1.js";
import { hex } from "@scure/base";
import { DustCovenantScript, Leaf } from "../src/vtxo.js";
import { compileV2 } from "../src/v2-artifact.js";
import type { DustCovenantParams } from "../src/params.js";

// Real curve points. computeArkadeScriptPublicKey lifts the emulator key to do
// point addition, so 32 arbitrary bytes fail with "cannot find square root".
const key = (fill: number) => schnorr.getPublicKey(new Uint8Array(32).fill(fill));

const params = (): DustCovenantParams => ({
    receiverKey: key(1),
    senderKey: key(2),
    operatorKey: key(3),
    operatorSignerKey: key(6),
    exitDelay: { value: 86_016n, type: "seconds" },
    dust: 330n,
    topup: 330n,
    locktime: 1_800_000_000n,
});

const opts = (p: DustCovenantParams = params()) => ({
    serverKey: key(4),
    emulatorKey: key(5),
    params: p,
    vtxoMinAmount: 10n,
});

describe("DustCovenantScript", () => {
    it("builds six leaves from params with no version field, renew at leaf 5", () => {
        const s = new DustCovenantScript(opts());
        expect(s.scripts).toHaveLength(6);
        expect(s.scripts[Leaf.Renew]).toEqual(
            compileV2(params(), key(4), key(5)).functionByName("renew")!.leafScript,
        );
    });

    it("has its leaves in the order that fixes the merkle root", () => {
        expect(Leaf.Recycle).toBe(0);
        expect(Leaf.Recovery).toBe(3);
        expect(Leaf.Exit).toBe(4);
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
            params: { ...params(), dust: 300n, topup: 300n },
        }).pkScript;
        expect(a).not.toEqual(b);
    });

    it("derives a bech32m Arkade address", () => {
        const s = new DustCovenantScript(opts());
        expect(s.address("ark", key(4)).encode()).toMatch(/^ark1/);
    });
});

// The mode is committed to by the tree, not merely by policy.
describe("claim mode is committed to by the tree", () => {
    const legacy = new DustCovenantScript(opts());
    const recycleOnly = new DustCovenantScript(opts({ ...params(), claimMode: "recycle" }));
    const purchaseOnly = new DustCovenantScript(opts({ ...params(), claimMode: "purchase" }));

    it("rebuilds the absent-mode tree byte-identically from the same params", () => {
        expect(legacy.pkScript).toEqual(new DustCovenantScript(opts()).pkScript);
        expect(legacy.scripts).toEqual(new DustCovenantScript(opts()).scripts);
    });

    it("keeps all six leaf indexes in place for every mode", () => {
        for (const script of [legacy, recycleOnly, purchaseOnly]) {
            expect(script.scripts).toHaveLength(6);
            expect(Leaf.Recycle).toBe(0);
            expect(Leaf.Purchase).toBe(1);
            expect(Leaf.RefundSender).toBe(2);
            expect(Leaf.Recovery).toBe(3);
            expect(Leaf.Exit).toBe(4);
            expect(Leaf.Renew).toBe(5);
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
        expect(recycleOnly.scripts[Leaf.Renew]).toEqual(legacy.scripts[Leaf.Renew]);
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

describe("unilateral exit leaf", () => {
    const script = () => new DustCovenantScript(opts());

    it("locks the exit to sender and operator signer at the configured delay", () => {
        const closure = CSVMultisigTapscript.decode(script().scripts[Leaf.Exit]);
        expect(closure.params.pubkeys).toEqual([key(2), key(6)]);
        expect(closure.params.timelock).toEqual({ value: 86_016n, type: "seconds" });
    });

    it("exposes exactly one exit path to the SDK", () => {
        expect(script().exitPaths()).toHaveLength(1);
    });

    it("moves the address when either exit param changes", () => {
        const base = script().pkScript;
        expect(
            new DustCovenantScript(opts({ ...params(), operatorSignerKey: key(7) })).pkScript,
        ).not.toEqual(base);
        expect(
            new DustCovenantScript(
                opts({ ...params(), exitDelay: { value: 1024n, type: "seconds" } }),
            ).pkScript,
        ).not.toEqual(base);
    });
});

// VtxoScript uses btcd's AssembleTaprootScriptTree. @scure/btc-signer's default
// taprootListToTree is a Huffman builder, and the two agree only at some leaf
// counts: at 4 and at the covenant's 6, but not at 5. Measured, not derived —
// so a leaf added or removed has to be re-measured here, not reasoned about.
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

    it.each([
        [4, true],
        [5, false],
        [6, true],
    ])("at %i leaves, agreement with the Huffman builder is %s", (n, agrees) => {
        const same = new VtxoScript(leaves(n)).pkScript;
        if (agrees) expect(same).toEqual(huffman(leaves(n)));
        else expect(same).not.toEqual(huffman(leaves(n)));
    });
});
