import { describe, expect, it } from "vitest";
import {
    CLTVMultisigTapscript,
    CSVMultisigTapscript,
    MultisigTapscript,
    VtxoScript,
    arkade,
} from "@arkade-os/sdk";
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
    operatorSignerKey: key(6),
    exitDelay: { value: 86_016n, type: "seconds" },
    dust: 330n,
    topup: 330n,
    locktime: 800_000n,
});

// Captured at f3de5de from this fixture, before leaf 4 existed.
const GOLDEN_SCRIPTS = [
    "20462779ad4aad39514614751a71085f2f10e1c7a593e4e030efb5b8721ce55b0bad20f09b70026fd7394d4743912128010bb87b1fbd3823a7d09bc93df2bb6d34ee9aac",
    "20462779ad4aad39514614751a71085f2f10e1c7a593e4e030efb5b8721ce55b0bad207049caabf9dcc7c2de3d96a5d66dfae4fb883334849918f694e8ed69989283deac",
    "20462779ad4aad39514614751a71085f2f10e1c7a593e4e030efb5b8721ce55b0bad204d4b6cd1361032ca9bd2aeb9d900aa4d45d9ead80ac9423374c451a7254d0766ad2090522dd225ac25761e75cc5cdd93e40c1738d47bb683aeeaf6bec4dea5e95296ac",
    "0300350cb17520462779ad4aad39514614751a71085f2f10e1c7a593e4e030efb5b8721ce55b0bad2090522dd225ac25761e75cc5cdd93e40c1738d47bb683aeeaf6bec4dea5e95296ac",
];
const GOLDEN_PK_SCRIPT = "51203aace253edc3274123e0aff6eb4eb16d9bfcf5dc1d60a2cc38ff45f5bcd28e9e";

const opts = (p: DustCovenantParams = params()) => ({
    serverKey: key(4),
    emulatorKey: key(5),
    params: p,
    vtxoMinAmount: 10n,
});

describe("DustCovenantScript", () => {
    it("has five leaves in the order that fixes the merkle root", () => {
        const s = new DustCovenantScript(opts());
        expect(s.scripts).toHaveLength(5);
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

    it("rebuilds the absent-mode tree byte-identically from the same params", () => {
        expect(legacy.pkScript).toEqual(new DustCovenantScript(opts()).pkScript);
        expect(legacy.scripts).toEqual(new DustCovenantScript(opts()).scripts);
    });

    it("keeps all five leaf indexes in place for every mode", () => {
        for (const script of [legacy, recycleOnly, purchaseOnly]) {
            expect(script.scripts).toHaveLength(5);
            expect(Leaf.Recycle).toBe(0);
            expect(Leaf.Purchase).toBe(1);
            expect(Leaf.RefundSender).toBe(2);
            expect(Leaf.Recovery).toBe(3);
            expect(Leaf.Exit).toBe(4);
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

describe("covenant v2", () => {
    const legacy = new DustCovenantScript(opts());
    const v2 = new DustCovenantScript(
        opts({ ...params(), locktime: 1_800_000_000n, covenantVersion: 2 }),
    );
    const pathLengths = (s: DustCovenantScript) =>
        s.scripts.map((leaf) => s.findLeaf(hex.encode(leaf))[0].merklePath.length);
    const tweak = (script: Uint8Array) => arkade.computeArkadeScriptPublicKey(key(5), script);

    // A sixth leaf re-balances the individual paths, so height is what holds.
    it("appends renew without deepening the tree, at a new address", () => {
        expect(v2.scripts).toHaveLength(6);
        expect(legacy.scripts).toHaveLength(5);
        expect(Math.max(...pathLengths(v2))).toBe(Math.max(...pathLengths(legacy)));
        expect(v2.pkScript).not.toEqual(legacy.pkScript);
    });

    // Every covenant leaf is compiled from dust_covenant.ark now, so all four
    // move; only the hand-built exit is shared with v1.
    it("changes every covenant leaf and keeps the exit", () => {
        expect(
            legacy.scripts.map((leaf, i) => hex.encode(leaf) !== hex.encode(v2.scripts[i])),
        ).toEqual([true, true, true, true, false]);
    });

    it("commits leaf 2 to the v2 refund and leaf 3 to the reclaim", () => {
        expect(MultisigTapscript.decode(v2.scripts[Leaf.RefundSender]).params.pubkeys).toEqual([
            key(4),
            key(2),
            tweak(v2.covenant.refund),
        ]);
        expect(CLTVMultisigTapscript.decode(v2.scripts[Leaf.Recovery]).params.pubkeys).toEqual([
            key(4),
            tweak(v2.covenant.reclaim!),
        ]);
    });
});

describe("unilateral exit leaf", () => {
    const script = () => new DustCovenantScript(opts());

    it("appends the exit at index 4 and leaves 0-3 byte-identical", () => {
        const s = script();
        expect(s.scripts).toHaveLength(5);
        expect(Leaf.Exit).toBe(4);
        expect(s.scripts.slice(0, 4).map((leaf) => hex.encode(leaf))).toEqual(GOLDEN_SCRIPTS);
        expect(hex.encode(new VtxoScript(s.scripts.slice(0, 4)).pkScript)).toBe(GOLDEN_PK_SCRIPT);
    });

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
// taprootListToTree is a Huffman builder that only agrees with arkd for
// power-of-2 leaf counts: it agrees at 4 leaves and not at the covenant's 5.
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
