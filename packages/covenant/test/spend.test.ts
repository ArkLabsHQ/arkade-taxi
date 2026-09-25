import { describe, expect, it } from "vitest";
import {
    CLTVMultisigTapscript,
    MultisigTapscript,
    asset,
    scriptFromTapLeafScript,
} from "@arkade-os/sdk";
import { schnorr } from "@noble/curves/secp256k1.js";
import { hex } from "@scure/base";
import { covenantSpendInput } from "../src/spend.js";
import { DustCovenantScript, Leaf } from "../src/vtxo.js";

const key = (fill: number) => schnorr.getPublicKey(new Uint8Array(32).fill(fill));

const covenant = () =>
    new DustCovenantScript({
        serverKey: key(4),
        emulatorKey: key(5),
        params: {
            receiverKey: key(1),
            senderKey: key(2),
            operatorKey: key(3),
            dust: 330n,
            topup: 320n,
            locktime: 800_000n,
        },
        vtxoMinAmount: 10n,
    });

describe("covenant spend leaves", () => {
    it.each([Leaf.Recycle, Leaf.Purchase, Leaf.RefundSender, Leaf.Recovery])(
        "materializes leaf %s from the SDK tree",
        (leaf) => {
            const script = covenant();
            const input = covenantSpendInput(
                script,
                leaf,
                { txid: "12".repeat(32), vout: 7 },
                330n,
            );

            expect(input.tapTree).toEqual(script.encode());
            expect(input.tapLeafScript).toEqual(script.findLeaf(hex.encode(script.scripts[leaf])));
            expect(scriptFromTapLeafScript(input.tapLeafScript)).toEqual(script.scripts[leaf]);
        },
    );

    it("preserves the exact signer requirements and recovery CLTV", () => {
        const script = covenant();
        const recycle = MultisigTapscript.decode(
            scriptFromTapLeafScript(
                covenantSpendInput(script, Leaf.Recycle, { txid: "12".repeat(32), vout: 0 }, 330n)
                    .tapLeafScript,
            ),
        );
        const purchase = MultisigTapscript.decode(
            scriptFromTapLeafScript(
                covenantSpendInput(script, Leaf.Purchase, { txid: "12".repeat(32), vout: 0 }, 330n)
                    .tapLeafScript,
            ),
        );
        const refund = MultisigTapscript.decode(
            scriptFromTapLeafScript(
                covenantSpendInput(
                    script,
                    Leaf.RefundSender,
                    { txid: "12".repeat(32), vout: 0 },
                    330n,
                ).tapLeafScript,
            ),
        );
        const recovery = CLTVMultisigTapscript.decode(
            scriptFromTapLeafScript(
                covenantSpendInput(script, Leaf.Recovery, { txid: "12".repeat(32), vout: 0 }, 330n)
                    .tapLeafScript,
            ),
        );

        expect(recycle.params.pubkeys).toHaveLength(2);
        expect(purchase.params.pubkeys).toHaveLength(2);
        expect(refund.params.pubkeys).toHaveLength(3);
        expect(refund.params.pubkeys).toContainEqual(script.options.params.senderKey);
        expect(recovery.params.absoluteTimelock).toBe(800_000n);
        expect(recovery.params.pubkeys).toHaveLength(2);
    });

    it("retains exact outpoint, bigint value, and canonical asset bytes without aliases", () => {
        const script = covenant();
        const assetPacket = asset.Packet.create([
            asset.AssetGroup.create(
                asset.AssetId.create("12".repeat(32), 7),
                null,
                [],
                [asset.AssetOutput.create(4, 9_007_199_254_740_993n)],
                [],
            ),
        ]).serialize();
        const expectedPacket = Uint8Array.from(assetPacket);
        const input = covenantSpendInput(
            script,
            Leaf.Purchase,
            { txid: "ab".repeat(32), vout: 4 },
            9_007_199_254_740_993n,
            assetPacket,
        );

        assetPacket[0] = 9;
        script.scripts[Leaf.Purchase][0] ^= 0xff;

        expect(input).toMatchObject({
            txid: "ab".repeat(32),
            vout: 4,
            value: 9_007_199_254_740_993n,
            assetPacket: expectedPacket,
        });
        expect(input.tapTree).toEqual(covenant().encode());
        expect(scriptFromTapLeafScript(input.tapLeafScript)).toEqual(
            covenant().scripts[Leaf.Purchase],
        );
    });

    it.each([
        [{ txid: "AB".repeat(32), vout: 0 }, 330n, "txid"],
        [{ txid: "12".repeat(31), vout: 0 }, 330n, "txid"],
        [{ txid: "12".repeat(32), vout: -1 }, 330n, "vout"],
        [{ txid: "12".repeat(32), vout: 0 }, 0n, "value"],
    ] as const)("rejects a non-canonical descriptor (%s)", (outpoint, value, label) => {
        expect(() => covenantSpendInput(covenant(), Leaf.Purchase, outpoint, value)).toThrow(label);
    });
});

// The disabled slot keeps a valid control proof, so the refusal must come from
// the mode rather than the tree lookup failing.
describe("covenant spend modes", () => {
    const withMode = (claimMode: "recycle" | "purchase") =>
        new DustCovenantScript({
            serverKey: key(4),
            emulatorKey: key(5),
            params: {
                receiverKey: key(1),
                senderKey: key(2),
                operatorKey: key(3),
                dust: 330n,
                topup: 320n,
                locktime: 800_000n,
                claimMode,
            },
            vtxoMinAmount: 10n,
        });
    const outpoint = { txid: "12".repeat(32), vout: 0 };

    it("still yields a control proof for the forbidden slot", () => {
        const script = withMode("recycle");
        expect(script.findLeaf(hex.encode(script.scripts[Leaf.Purchase]))).toHaveLength(2);
    });

    it.each([
        ["recycle", Leaf.Purchase],
        ["purchase", Leaf.Recycle],
    ] as const)("refuses the forbidden leaf under a %s covenant", (claimMode, leaf) => {
        expect(() => covenantSpendInput(withMode(claimMode), leaf, outpoint, 330n)).toThrow(
            /disabled/,
        );
    });

    it.each([
        ["recycle", Leaf.Recycle],
        ["purchase", Leaf.Purchase],
    ] as const)("allows the permitted claim leaf under a %s covenant", (claimMode, leaf) => {
        expect(
            covenantSpendInput(withMode(claimMode), leaf, outpoint, 330n).tapLeafScript,
        ).toHaveLength(2);
    });

    it("leaves the refund and recovery leaves usable in every mode", () => {
        for (const claimMode of ["recycle", "purchase"] as const)
            for (const leaf of [Leaf.RefundSender, Leaf.Recovery])
                expect(
                    covenantSpendInput(withMode(claimMode), leaf, outpoint, 330n).tapLeafScript,
                ).toHaveLength(2);
    });
});
