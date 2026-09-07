import { sha256 } from "@noble/hashes/sha2.js";
import { arkade } from "@arkade-os/sdk";
import { subDustScript } from "./pin.js";
import { refundTopup, validateParams, type DustCovenantParams } from "./params.js";

/**
 * sdk 0.4.67 emits `Program`, `AsmToken`, `InputDef` and friends into the
 * `arkade` namespace's VALUE space (`declare const index_Program: typeof
 * Program`), so `arkade.Program` does not resolve as a type. Re-derived from
 * the one construct signature the d.ts does get right.
 */
export type ArkadeProgram = ConstructorParameters<typeof arkade.ArkadeProgramScript>[0];
export type ArkadeProgramArgs = ConstructorParameters<typeof arkade.ArkadeProgramScript>[1];

type ArkadeFunction = ArkadeProgram["functions"][string];
type InputDef = Exclude<NonNullable<ArkadeProgram["params"]>[number], string>;
type Asm = NonNullable<ArkadeFunction["arkadeScript"]>["asm"];

/** Ordering of `Program.params`; only the entries a program actually references are emitted. */
const PARAM_TYPES = {
    serverKey: "pubkey",
    receiverKey: "pubkey",
    senderKey: "pubkey",
    operatorKey: "pubkey",
    operatorPinHash: "hash",
    senderPinHash: "hash",
    assetTxid: "bytes",
    assetGroupIndex: "int",
    topup: "int",
    refundTopup: "int",
    refundRemainder: "int",
    locktime: "int",
} as const satisfies Record<string, InputDef["type"]>;

/** Mirrors pinOutput. The branch is a structural choice, so it is resolved here, not in the artifact. */
function pinAsm(
    out: Asm,
    vout: number,
    keyParam: string,
    hashParam: string,
    value: bigint,
    dust: bigint,
): void {
    out.push(vout, "INSPECTOUTPUTSCRIPTPUBKEY");
    if (value >= dust) {
        out.push(1, "EQUALVERIFY", `$${keyParam}`, "EQUALVERIFY");
        return;
    }
    out.push(-1, "EQUALVERIFY", `$${hashParam}`, "EQUALVERIFY");
}

function assetAsm(out: Asm, idx: number, output: boolean, required: boolean): void {
    out.push(
        idx,
        "$assetTxid",
        "$assetGroupIndex",
        output ? "INSPECTOUTASSETLOOKUP" : "INSPECTINASSETLOOKUP",
        required ? "VERIFY" : "DROP",
    );
}

const finishAsm = (out: Asm, hasAsset: boolean): Asm => {
    if (!hasAsset) out.push(1);
    return out;
};

function recycleAsm(p: DustCovenantParams): Asm {
    const out: Asm = [
        "PUSHCURRENTINPUTINDEX",
        0,
        "EQUALVERIFY",
        "INSPECTNUMINPUTS",
        2,
        "EQUALVERIFY",
        1,
        "INSPECTINPUTSCRIPTPUBKEY",
        1,
        "EQUALVERIFY",
        "$receiverKey",
        "EQUALVERIFY",
        0,
        "INSPECTOUTPUTVALUE",
        "$topup",
        "EQUALVERIFY",
    ];
    pinAsm(out, 0, "operatorKey", "operatorPinHash", p.topup, p.dust);
    out.push(
        1,
        "INSPECTOUTPUTSCRIPTPUBKEY",
        1,
        "EQUALVERIFY",
        "$receiverKey",
        "EQUALVERIFY",
        1,
        "INSPECTOUTPUTVALUE",
        0,
        "INSPECTINPUTVALUE",
        1,
        "INSPECTINPUTVALUE",
        "ADD",
        "$topup",
        "SUB",
        "EQUALVERIFY",
    );
    if (p.assetId) {
        assetAsm(out, 1, true, true);
        assetAsm(out, 0, false, true);
        assetAsm(out, 1, false, false);
        out.push("ADD", "EQUAL");
    }
    return finishAsm(out, p.assetId !== undefined);
}

function purchaseAsm(p: DustCovenantParams): Asm {
    const out: Asm = [
        "PUSHCURRENTINPUTINDEX",
        0,
        "EQUALVERIFY",
        0,
        "INSPECTOUTPUTSCRIPTPUBKEY",
        1,
        "EQUALVERIFY",
        "$receiverKey",
        "EQUALVERIFY",
        0,
        "INSPECTOUTPUTVALUE",
        0,
        "INSPECTINPUTVALUE",
        "EQUALVERIFY",
    ];
    if (p.assetId) {
        assetAsm(out, 0, true, true);
        assetAsm(out, 0, false, true);
        out.push("EQUAL");
    }
    return finishAsm(out, p.assetId !== undefined);
}

function refundAsm(p: DustCovenantParams, vtxoMinAmount: bigint): Asm {
    const topup = refundTopup(p, vtxoMinAmount);
    const out: Asm = [
        "PUSHCURRENTINPUTINDEX",
        0,
        "EQUALVERIFY",
        0,
        "INSPECTOUTPUTVALUE",
        "$refundTopup",
        "EQUALVERIFY",
    ];
    pinAsm(out, 0, "operatorKey", "operatorPinHash", topup, p.dust);
    out.push(1, "INSPECTOUTPUTVALUE", "$refundRemainder", "EQUALVERIFY");
    pinAsm(out, 1, "senderKey", "senderPinHash", p.dust - topup, p.dust);
    if (p.assetId) {
        assetAsm(out, 1, true, true);
        assetAsm(out, 0, false, true);
        out.push("EQUAL");
    }
    return finishAsm(out, p.assetId !== undefined);
}

function declaredParams(functions: Record<string, ArkadeFunction>): InputDef[] {
    const refs = new Set<string>();
    const collect = (tokens: readonly Asm[number][] = []) => {
        for (const t of tokens)
            if (typeof t === "string" && t.startsWith("$")) refs.add(t.slice(1));
    };
    for (const fn of Object.values(functions)) {
        collect(fn.tapscript.signers);
        collect(fn.tapscript.cltv === undefined ? [] : [fn.tapscript.cltv]);
        collect(fn.arkadeScript?.asm);
    }
    return (Object.keys(PARAM_TYPES) as (keyof typeof PARAM_TYPES)[])
        .filter((name) => refs.has(name))
        .map((name) => ({ name, type: PARAM_TYPES[name] }));
}

/**
 * The SDK appends the tweaked co-signer after the declared signers, so leaf 2's
 * three-key shape is `signers: [server, sender]` plus the refund arkadeScript.
 * Key order matters — it is committed to by the merkle root.
 */
export function emitArtifact(p: DustCovenantParams, vtxoMinAmount: bigint): ArkadeProgram {
    validateParams(p, vtxoMinAmount);
    const refund = { asm: refundAsm(p, vtxoMinAmount) };
    const functions: Record<string, ArkadeFunction> = {
        recycle: { tapscript: { signers: ["$serverKey"] }, arkadeScript: { asm: recycleAsm(p) } },
        purchase: { tapscript: { signers: ["$serverKey"] }, arkadeScript: { asm: purchaseAsm(p) } },
        refundSender: {
            tapscript: { signers: ["$serverKey", "$senderKey"] },
            arkadeScript: refund,
        },
        recovery: {
            tapscript: { signers: ["$serverKey"], cltv: "$locktime" },
            arkadeScript: refund,
        },
    };
    return {
        version: arkade.SUPPORTED_PROGRAM_VERSION,
        name: "dust-covenant",
        params: declaredParams(functions),
        functions,
    };
}

/**
 * `resolveAsm` is pure substitution, so the two values an artifact cannot
 * express — `dust - topup` and `sha256(subDustScript(key))` — are derived here.
 */
export function artifactArgs(
    p: DustCovenantParams,
    vtxoMinAmount: bigint,
    serverKey: Uint8Array,
): ArkadeProgramArgs {
    validateParams(p, vtxoMinAmount);
    const topup = refundTopup(p, vtxoMinAmount);
    return {
        serverKey,
        receiverKey: p.receiverKey,
        senderKey: p.senderKey,
        operatorKey: p.operatorKey,
        operatorPinHash: sha256(subDustScript(p.operatorKey)),
        senderPinHash: sha256(subDustScript(p.senderKey)),
        topup: p.topup,
        refundTopup: topup,
        refundRemainder: p.dust - topup,
        locktime: p.locktime,
        ...(p.assetId ? { assetTxid: p.assetId.txid, assetGroupIndex: p.assetId.groupIndex } : {}),
    };
}
