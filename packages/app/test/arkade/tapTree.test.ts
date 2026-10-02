import { describe, expect, it } from "vitest";
import { VtxoScript } from "@arkade-os/sdk";
import { hex } from "@scure/base";
import { sameTapTree } from "../../src/arkade/tapTree.js";

// arkd's own bytes for mutinynet checkpoint
// 08c71016c0e710a8c537e566bcd47d8f4aeaf88293730cd4fb71b9ca1ebbca46 input 0:
// three leaves at depths 1, 2, 2.
const arkdThreeLeaf = hex.decode(
    "01c04420b187f5fc2eee0e5eb8743d60eb05b99a15647551320c8f7e7e4076b4bd1d0dfdad20301078808e4f7bc0dadfe29e34b1df8eaf0108ef06b1722274075ebc107a127aac02c02803040040b27520b187f5fc2eee0e5eb8743d60eb05b99a15647551320c8f7e7e4076b4bd1d0dfdac02c06620b187f5fc2eee0e5eb8743d60eb05b99a15647551320c8f7e7e4076b4bd1d0dfdad202903b15efe236d9609da10e536fb32cdf1d144778797bbf32a9b94e86601be6aad20301078808e4f7bc0dadfe29e34b1df8eaf0108ef06b1722274075ebc107a127aac",
);
const tree = VtxoScript.decode(arkdThreeLeaf);

describe("taptree equivalence", () => {
    it("binds the real arkd bytes to the funded prevout script", () => {
        expect(hex.encode(tree.pkScript)).toBe(
            "5120d973447581e06293d97be593ac30013ad345a6a24075a06e9f8998ee272f024d",
        );
    });

    it("accepts arkd's encoding of a three-leaf tree", () => {
        expect(sameTapTree(arkdThreeLeaf, tree)).toBe(true);
    });

    it("accepts the SDK encoding of the same tree", () => {
        const sdk = tree.encode();
        expect(hex.encode(sdk)).not.toBe(hex.encode(arkdThreeLeaf));
        expect(sameTapTree(sdk, tree)).toBe(true);
    });

    it("rejects a flipped leaf script byte", () => {
        const flipped = Uint8Array.from(arkdThreeLeaf);
        flipped[flipped.length - 2] ^= 1;
        expect(sameTapTree(flipped, tree)).toBe(false);
    });

    it("rejects trailing garbage", () => {
        expect(sameTapTree(Uint8Array.from([...arkdThreeLeaf, 0x00]), tree)).toBe(false);
        expect(sameTapTree(Uint8Array.from([...tree.encode(), 0x00]), tree)).toBe(false);
    });

    it("rejects a non-default leaf version", () => {
        const versioned = Uint8Array.from(arkdThreeLeaf);
        versioned[1] = 0xc2;
        expect(sameTapTree(versioned, tree)).toBe(false);
    });

    it("rejects a depth byte neither producer writes", () => {
        const invented = Uint8Array.from(arkdThreeLeaf);
        invented[0] = 9;
        expect(sameTapTree(invented, tree)).toBe(false);
    });

    it("accepts arkd's depth-zero encoding of a one-leaf tree", () => {
        const single = new VtxoScript([tree.scripts[1]!]);
        const script = single.scripts[0]!;
        expect(script.length).toBeLessThan(0xfd);
        expect(sameTapTree(Uint8Array.of(0x00, 0xc0, script.length, ...script), single)).toBe(true);
        expect(sameTapTree(Uint8Array.of(0x01, 0xc0, script.length, ...script), single)).toBe(true);
        expect(sameTapTree(Uint8Array.of(0x02, 0xc0, script.length, ...script), single)).toBe(
            false,
        );
    });

    it("rejects reordered leaves", () => {
        expect(sameTapTree(arkdThreeLeaf, new VtxoScript([...tree.scripts].reverse()))).toBe(false);
    });
});
