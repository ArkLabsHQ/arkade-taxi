import { readFileSync } from "node:fs";
import { hex } from "@scure/base";
import { describe, expect, it } from "vitest";
import { arkade } from "@arkade-os/sdk";
import { schnorr } from "@noble/curves/secp256k1.js";
import { artifactArgs, emitArtifact, type ArkadeProgram } from "../src/artifact.js";
import { DustCovenantScript, Leaf } from "../src/vtxo.js";
import type { DustCovenantParams } from "../src/params.js";

type Vector = {
    name: string;
    params: {
        receiverKey: string;
        senderKey: string;
        operatorKey: string;
        dust: number;
        topup: number;
        assetTxid: string | null;
        assetIndex: number | null;
        locktime: number;
    };
    vtxoMinAmount: number;
    recycle: string;
    purchase: string;
    refund: string;
};

const { cases } = JSON.parse(readFileSync(new URL("./vectors.json", import.meta.url), "utf8")) as {
    cases: Vector[];
};

// computeArkadeScriptPublicKey lifts the emulator key, so these two must be real
// curve points; the vector keys are only ever pushed as data.
const serverKey = schnorr.getPublicKey(new Uint8Array(32).fill(4));
const emulatorKey = schnorr.getPublicKey(new Uint8Array(32).fill(5));

const toParams = (v: Vector): DustCovenantParams => ({
    receiverKey: hex.decode(v.params.receiverKey),
    senderKey: hex.decode(v.params.senderKey),
    operatorKey: hex.decode(v.params.operatorKey),
    dust: BigInt(v.params.dust),
    topup: BigInt(v.params.topup),
    locktime: BigInt(v.params.locktime),
    assetId: v.params.assetTxid
        ? { txid: hex.decode(v.params.assetTxid), groupIndex: v.params.assetIndex ?? 0 }
        : undefined,
});

const compile = (program: ArkadeProgram, p: DustCovenantParams, vtxoMinAmount: bigint) =>
    new arkade.ArkadeProgramScript(program, artifactArgs(p, vtxoMinAmount, serverKey), {
        serverKey,
        emulatorKey,
    });

const builder = (p: DustCovenantParams, vtxoMinAmount: bigint) =>
    new DustCovenantScript({ serverKey, emulatorKey, params: p, vtxoMinAmount });

const arkadeHex = (s: InstanceType<typeof arkade.ArkadeProgramScript>, name: string) =>
    hex.encode(s.functionByName(name)!.arkadeScript!);

describe("artifact reproduces the builders byte-for-byte", () => {
    it.each(cases.map((c) => [c.name, c] as const))("%s", (_name, v) => {
        const p = toParams(v);
        const min = BigInt(v.vtxoMinAmount);
        const compiled = compile(emitArtifact(p, min), p, min);

        expect(arkadeHex(compiled, "recycle")).toBe(v.recycle);
        expect(arkadeHex(compiled, "purchase")).toBe(v.purchase);
        expect(arkadeHex(compiled, "refundSender")).toBe(v.refund);
        expect(arkadeHex(compiled, "recovery")).toBe(v.refund);
        expect(compiled.pkScript).toEqual(builder(p, min).pkScript);
    });
});

describe("leaf shapes the artifact must express", () => {
    const v = cases[0];
    const p = toParams(v);
    const min = BigInt(v.vtxoMinAmount);

    it("emits the four leaves in the order that fixes the merkle root", () => {
        const compiled = compile(emitArtifact(p, min), p, min);
        expect(compiled.compiled.map((f) => f.name)).toEqual([
            "recycle",
            "purchase",
            "refundSender",
            "recovery",
        ]);
        expect(compiled.scripts).toEqual(builder(p, min).scripts);
    });

    it("appends the tweaked co-signer after the two declared signers on refundSender", () => {
        const fn = compile(emitArtifact(p, min), p, min).compiled[Leaf.RefundSender];
        expect(fn.signerKeys).toEqual([serverKey, p.senderKey]);
        expect(fn.leafScript).toEqual(builder(p, min).scripts[Leaf.RefundSender]);
    });

    it("encodes recovery's cltv identically to CLTVMultisigTapscript", () => {
        const fn = compile(emitArtifact(p, min), p, min).compiled[Leaf.Recovery];
        expect(fn.def.tapscript.cltv).toBe("$locktime");
        expect(fn.leafScript).toEqual(builder(p, min).scripts[Leaf.Recovery]);
    });
});

describe("artifact JSON round-trip", () => {
    it.each(cases.map((c) => [c.name, c] as const))("%s survives parse/stringify", (_name, v) => {
        const p = toParams(v);
        const min = BigInt(v.vtxoMinAmount);
        const program = emitArtifact(p, min);
        const reparsed = arkade.parseArtifact(JSON.parse(arkade.stringifyArtifact(program)));

        expect(reparsed).toEqual(program);
        expect(compile(reparsed, p, min).pkScript).toEqual(builder(p, min).pkScript);
    });
});

describe("declared params", () => {
    it("declares every $ref it uses and binds every param it declares", () => {
        for (const v of cases) {
            const p = toParams(v);
            const min = BigInt(v.vtxoMinAmount);
            const program = emitArtifact(p, min);
            expect(() =>
                arkade.validateProgram(program, artifactArgs(p, min, serverKey)),
            ).not.toThrow();
        }
    });

    it("rejects a program whose params drop a referenced binding", () => {
        const p = toParams(cases[0]);
        const min = BigInt(cases[0].vtxoMinAmount);
        const program = emitArtifact(p, min);
        const { serverKey: _dropped, ...partial } = artifactArgs(p, min, serverKey);
        expect(() => arkade.validateProgram(program, partial)).toThrow(/serverKey/);
    });
});
