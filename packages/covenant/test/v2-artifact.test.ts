import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { CSVMultisigTapscript, MultisigTapscript, arkade } from "@arkade-os/sdk";
import { schnorr } from "@noble/curves/secp256k1.js";
import { hex } from "@scure/base";
import { DustCovenantScript, Leaf } from "../src/vtxo.js";
import { V2_ARTIFACT, v2Args } from "../src/v2-artifact.js";
import type { DustCovenantParams } from "../src/params.js";

const key = (fill: number) => schnorr.getPublicKey(new Uint8Array(32).fill(fill));
const SERVER = key(4);
const EMULATOR = key(5);

const params = (over: Partial<DustCovenantParams> = {}): DustCovenantParams => ({
    receiverKey: key(1),
    senderKey: key(2),
    operatorKey: key(3),
    operatorSignerKey: key(6),
    exitDelay: { value: 86_016n, type: "seconds" },
    dust: 330n,
    topup: 330n,
    locktime: 1_800_000_000n,
    covenantVersion: 2,
    ...over,
});

const opts = (p: DustCovenantParams = params()) => ({
    serverKey: SERVER,
    emulatorKey: EMULATOR,
    params: p,
    vtxoMinAmount: 330n,
});

const asset = { txid: new Uint8Array(32).fill(0x11), groupIndex: 0 };

/** Every v2 shape the committed vectors carry. */
const SHAPES: Record<string, DustCovenantParams> = {
    btc: params(),
    "btc-payment": params({ paymentSats: 100n }),
    asset: params({ assetId: asset }),
    "sats-fare": params({
        assetId: asset,
        claimMode: "recycle",
        recoveryRecipient: "receiver",
        receiverFare: { currency: "sats", units: 7n },
    }),
    "asset-fare": params({
        assetId: asset,
        claimMode: "recycle",
        recoveryRecipient: "receiver",
        receiverFare: { currency: "asset", units: 9n },
    }),
};

const compile = (p: DustCovenantParams) =>
    new arkade.ArkadeProgramScript(arkade.programFromArtifact(V2_ARTIFACT), v2Args(p, SERVER), {
        serverKey: SERVER,
        emulatorKey: EMULATOR,
    });

describe("v2 is compiled from Arkade source", () => {
    const onDisk = JSON.parse(
        readFileSync(resolve(import.meta.dirname, "../contracts/dust_covenant.json"), "utf8"),
    );

    it("builds the module the covenant uses from the committed artifact", () => {
        expect(V2_ARTIFACT.contractName).toBe("DustCovenant");
        expect(V2_ARTIFACT.contractName).toBe(onDisk.contractName);
        expect(V2_ARTIFACT.constructorInputs).toEqual(onDisk.constructorInputs);
        expect(V2_ARTIFACT.functions).toEqual(onDisk.functions);
    });

    it("carries the compiler and source that produced it", () => {
        expect(onDisk.compiler).toMatchObject({ name: "arkadec", version: "0.1.0" });
        expect(onDisk.source.entry).toBe("dust_covenant.ark");
        // A wall-clock stamp would break the committed-diff gate on every run.
        expect(onDisk).not.toHaveProperty("updatedAt");
    });

    // arkadec lists covenant groups before plain tapscript; vtxo.ts sets leaf order.
    it("declares the covenant groups in leaf order, then the exit as plain tapscript", () => {
        expect(V2_ARTIFACT.functions.map((f) => f.name)).toEqual([
            "recycle",
            "purchase",
            "repayRefund",
            "reclaimWhole",
            "renew",
            "exit",
        ]);
        for (const group of V2_ARTIFACT.functions)
            expect(group.arkade !== undefined, group.name).toBe(group.name !== "exit");
    });

    it("keeps six leaves with Renew after Exit, for every v2 shape", () => {
        for (const [name, p] of Object.entries(SHAPES)) {
            const s = new DustCovenantScript(opts(p));
            expect(s.scripts, name).toHaveLength(6);
        }
        expect(Leaf.Exit).toBe(4);
        expect(Leaf.Renew).toBe(5);
    });

    it("takes every leaf from the artifact, the exit byte-identical to the hand-built one", () => {
        for (const [name, p] of Object.entries(SHAPES)) {
            const s = new DustCovenantScript(opts(p));
            const c = compile(p);
            for (const [leaf, fn] of [
                [Leaf.Recycle, "recycle"],
                [Leaf.Purchase, "purchase"],
                [Leaf.RefundSender, "repayRefund"],
                [Leaf.Recovery, "reclaimWhole"],
                [Leaf.Exit, "exit"],
                [Leaf.Renew, "renew"],
            ] as const) {
                if (p.claimMode !== undefined && (leaf === Leaf.Purchase || leaf === Leaf.Recycle))
                    continue;
                expect(hex.encode(s.scripts[leaf]), `${name}/${fn}`).toBe(
                    hex.encode(c.functionByName(fn)!.leafScript),
                );
            }
            expect(s.scripts[Leaf.Exit]).toEqual(
                CSVMultisigTapscript.encode({
                    timelock: p.exitDelay,
                    pubkeys: [p.senderKey, p.operatorSignerKey],
                }).script,
            );
        }
    });

    it("exposes all five covenant scripts, resolved from the artifact", () => {
        for (const [name, p] of Object.entries(SHAPES)) {
            const s = new DustCovenantScript(opts(p));
            const c = compile(p);
            expect(Object.keys(s.covenant).sort(), name).toEqual([
                "purchase",
                "reclaim",
                "recycle",
                "refund",
                "renew",
            ]);
            expect(hex.encode(s.covenant.refund)).toBe(
                hex.encode(c.functionByName("repayRefund")!.arkadeScript!),
            );
            expect(hex.encode(s.covenant.reclaim!)).toBe(
                hex.encode(c.functionByName("reclaimWhole")!.arkadeScript!),
            );
            expect(hex.encode(s.covenant.renew!)).toBe(
                hex.encode(c.functionByName("renew")!.arkadeScript!),
            );
        }
    });

    it("commits the asset branch to the address", () => {
        expect(new DustCovenantScript(opts(SHAPES.asset!)).pkScript).not.toEqual(
            new DustCovenantScript(opts(SHAPES.btc!)).pkScript,
        );
        expect(new DustCovenantScript(opts(SHAPES["asset-fare"]!)).pkScript).not.toEqual(
            new DustCovenantScript(opts(SHAPES["sats-fare"]!)).pkScript,
        );
    });

    it("still disables exactly the forbidden claim closure, in place", () => {
        const open = new DustCovenantScript(opts(params({ assetId: asset })));
        const recycleOnly = new DustCovenantScript(
            opts(params({ assetId: asset, claimMode: "recycle" })),
        );
        expect(recycleOnly.scripts).toHaveLength(6);
        expect(recycleOnly.scripts[Leaf.Recycle]).toEqual(open.scripts[Leaf.Recycle]);
        expect(recycleOnly.scripts[Leaf.Purchase]).not.toEqual(open.scripts[Leaf.Purchase]);
        const closure = MultisigTapscript.decode(recycleOnly.scripts[Leaf.Purchase]!);
        expect(closure.params.pubkeys).toHaveLength(2);
        expect(closure.params.pubkeys[1]).toEqual(
            arkade.computeArkadeScriptPublicKey(EMULATOR, arkade.ArkadeScript.encode([0])),
        );
    });

    it("is deterministic and moves the address with every bound param", () => {
        expect(new DustCovenantScript(opts()).pkScript).toEqual(
            new DustCovenantScript(opts()).pkScript,
        );
        for (const over of [
            { dust: 400n, topup: 400n },
            { locktime: 1_900_000_000n },
            { receiverKey: key(9) },
        ] as Partial<DustCovenantParams>[]) {
            expect(new DustCovenantScript(opts(params(over))).pkScript).not.toEqual(
                new DustCovenantScript(opts()).pkScript,
            );
        }
    });

    // No v2 leaf reads lockupSats: every value pin is relative to in[0].value or
    // to the loan. The committed v2-btc and v2-btc-payment vectors share a
    // pkScript for the same reason.
    it("does not bind paymentSats, which no v2 leaf reads", () => {
        expect(new DustCovenantScript(opts(params({ paymentSats: 100n }))).pkScript).toEqual(
            new DustCovenantScript(opts()).pkScript,
        );
    });
});
