import { describe, expect, it, vi } from "vitest";
import {
    Transaction,
    VtxoTaprootTree,
    type BatchSignableIdentity,
    type Identity,
} from "@arkade-os/sdk";
import { base64, hex } from "@scure/base";
import {
    decodeLockupEnvelope,
    encodeLockupEnvelope,
    unsignedGraphId,
} from "../../app/src/arkade/psbt.js";
import { assertSignedLockup, signLockup } from "../src/lockup.js";
import { verifyQuote, type VerifiedQuote } from "../src/verify.js";
import {
    args,
    assetArgs,
    fundingInputs,
    operatorIdentity,
    params,
    quote,
    senderIdentity,
} from "./fixtures.js";

const signer = (sign: Identity["sign"]): Identity =>
    Object.assign(Object.create(senderIdentity), { sign }) as Identity;

const rewrite = (
    encoded: string,
    mutate: (wire: ReturnType<typeof decodeLockupEnvelope>) => void,
    recomputeHash = false,
): string => {
    const wire = decodeLockupEnvelope(encoded);
    mutate(wire);
    if (recomputeHash) {
        wire.unsignedTxId = unsignedGraphId(
            Transaction.fromPSBT(base64.decode(wire.arkTx)),
            wire.checkpoints.map((checkpoint) => Transaction.fromPSBT(base64.decode(checkpoint))),
        );
    }
    return encodeLockupEnvelope(wire);
};

const mutateArk = (
    encoded: string,
    mutate: (tx: Transaction) => void,
    recomputeHash = false,
): string =>
    rewrite(
        encoded,
        (wire) => {
            const tx = Transaction.fromPSBT(base64.decode(wire.arkTx));
            mutate(tx);
            wire.arkTx = base64.encode(tx.toPSBT());
        },
        recomputeHash,
    );

const mutateCheckpoint = (encoded: string, mutate: (tx: Transaction) => void): string =>
    rewrite(encoded, (wire) => {
        const tx = Transaction.fromPSBT(base64.decode(wire.checkpoints[0]));
        mutate(tx);
        wire.checkpoints[0] = base64.encode(tx.toPSBT());
    });

const mutateFundingTree = (encoded: string, offset: number, value: number): string =>
    rewrite(encoded, (wire) => {
        const tapTree = hex.decode(wire.senderInputs[0].tapTree);
        tapTree[offset] = value;
        wire.senderInputs[0].tapTree = hex.encode(tapTree);
        const checkpoint = Transaction.fromPSBT(base64.decode(wire.checkpoints[0]));
        checkpoint.updateInput(0, {
            unknown: checkpoint
                .getInput(0)
                .unknown?.map((entry) =>
                    VtxoTaprootTree.decode(entry) === null
                        ? entry
                        : VtxoTaprootTree.encode(tapTree),
                ),
        });
        wire.checkpoints[0] = base64.encode(checkpoint.toPSBT());
    });

const signSpy = () => {
    const sign = vi.fn(senderIdentity.sign.bind(senderIdentity));
    return { identity: signer(sign), sign };
};

describe("verified lockup capability", () => {
    it.each([
        [
            "sender evidence",
            (wire: ReturnType<typeof decodeLockupEnvelope>): void => {
                wire.senderInputs[0].value = "11";
            },
        ],
        [
            "operator evidence",
            (wire: ReturnType<typeof decodeLockupEnvelope>): void => {
                wire.operatorInputs[0].vout += 1;
            },
        ],
        [
            "sender ownership",
            (wire: ReturnType<typeof decodeLockupEnvelope>): void => {
                wire.senderInputIndexes = [1];
            },
        ],
        [
            "operator ownership",
            (wire: ReturnType<typeof decodeLockupEnvelope>): void => {
                wire.operatorInputIndexes = [0];
            },
        ],
        [
            "covenant index",
            (wire: ReturnType<typeof decodeLockupEnvelope>): void => {
                wire.covenantOutputIndex = 1;
            },
        ],
        [
            "unroll script",
            (wire: ReturnType<typeof decodeLockupEnvelope>): void => {
                wire.serverUnrollScript = "00";
            },
        ],
        [
            "asset quantity",
            (wire: ReturnType<typeof decodeLockupEnvelope>): void => {
                wire.assetUnits = "1";
            },
        ],
        [
            "hash",
            (wire: ReturnType<typeof decodeLockupEnvelope>): void => {
                wire.unsignedTxId = "00".repeat(32);
            },
        ],
    ] as const)("rejects changed %s before issuing a capability", (_, mutate) => {
        const a = assetArgs();
        a.quote.unsignedLockupTx = rewrite(a.quote.unsignedLockupTx, mutate);
        expect(() => verifyQuote(a)).toThrow();
    });

    it.each([
        ["checkpoint outpoint", (tx: Transaction) => tx.updateInput(0, { index: 3 })],
        [
            "checkpoint value",
            (tx: Transaction) =>
                tx.updateInput(0, {
                    witnessUtxo: { ...tx.getInput(0).witnessUtxo!, amount: 701n },
                }),
        ],
        [
            "checkpoint script",
            (tx: Transaction) =>
                tx.updateInput(0, {
                    witnessUtxo: {
                        ...tx.getInput(0).witnessUtxo!,
                        script: new Uint8Array([0x51]),
                    },
                }),
        ],
        ["checkpoint leaf", (tx: Transaction) => tx.updateInput(0, { tapLeafScript: undefined })],
        [
            "checkpoint control proof",
            (tx: Transaction) => {
                const leaves = tx.getInput(0).tapLeafScript!;
                const internalKey = Uint8Array.from(leaves[0][0].internalKey);
                internalKey[0] ^= 1;
                tx.updateInput(0, {
                    tapLeafScript: [[{ ...leaves[0][0], internalKey }, leaves[0][1]]],
                });
            },
        ],
        [
            "checkpoint tree metadata",
            (tx: Transaction) => tx.updateInput(0, { unknown: undefined }),
        ],
        ["checkpoint output", (tx: Transaction) => tx.updateOutput(0, { amount: 699n })],
    ] as const)("rejects changed %s", (_, mutate) => {
        const a = assetArgs();
        a.quote.unsignedLockupTx = mutateCheckpoint(a.quote.unsignedLockupTx, mutate);
        expect(() => verifyQuote(a)).toThrow();
    });

    it.each([
        ["joint input checkpoint", (tx: Transaction) => tx.updateInput(0, { index: 1 })],
        [
            "joint input value",
            (tx: Transaction) =>
                tx.updateInput(0, {
                    witnessUtxo: { ...tx.getInput(0).witnessUtxo!, amount: 699n },
                }),
        ],
        [
            "operator joint input value",
            (tx: Transaction) =>
                tx.updateInput(1, {
                    witnessUtxo: {
                        ...tx.getInput(1).witnessUtxo!,
                        amount: tx.getInput(1).witnessUtxo!.amount + 1n,
                    },
                }),
        ],
        [
            "joint input script",
            (tx: Transaction) =>
                tx.updateInput(0, {
                    witnessUtxo: {
                        ...tx.getInput(0).witnessUtxo!,
                        script: new Uint8Array([0x51]),
                    },
                }),
        ],
        ["joint input leaf", (tx: Transaction) => tx.updateInput(0, { tapLeafScript: undefined })],
        [
            "joint input tree metadata",
            (tx: Transaction) => tx.updateInput(0, { unknown: undefined }),
        ],
        ["sighash", (tx: Transaction) => tx.updateInput(0, { sighashType: 1 })],
        ["covenant amount", (tx: Transaction) => tx.updateOutput(0, { amount: 331n })],
        ["fare", (tx: Transaction) => tx.updateOutput(1, { amount: 11n })],
        [
            "change destination",
            (tx: Transaction) => tx.updateOutput(2, { script: tx.getOutput(0).script }),
        ],
        [
            "asset allocation",
            (tx: Transaction) => {
                const index = tx.outputsLength - 2;
                const script = Uint8Array.from(tx.getOutput(index).script!);
                script[script.length - 1] ^= 1;
                tx.updateOutput(index, { script });
            },
        ],
    ] as const)("rejects changed %s even with a recomputed hash", (_, mutate) => {
        const a = assetArgs();
        a.quote.unsignedLockupTx = mutateArk(a.quote.unsignedLockupTx, mutate, true);
        const envelope = decodeLockupEnvelope(a.quote.unsignedLockupTx);
        a.quote.lockup.unsignedTxId = envelope.unsignedTxId;
        expect(() => verifyQuote(a)).toThrow();
    });

    it("rejects extra envelope and input metadata", () => {
        const a = args();
        a.quote.unsignedLockupTx = rewrite(a.quote.unsignedLockupTx, (wire) => {
            Object.assign(wire, { extra: true });
            Object.assign(wire.senderInputs[0], { extra: true });
        });
        expect(() => verifyQuote(a)).toThrow();
    });

    it("rejects commitment fields that disagree with the independently checked envelope", () => {
        const a = args();
        a.quote.lockup.senderInputIndexes = [1];
        expect(() => verifyQuote(a)).toThrow();
    });

    it.each([
        ["leaf version", 1, 0xc2],
        ["leaf depth/control proof", 0, 2],
    ])(
        "rejects noncanonical funding tree %s even when checkpoint metadata matches",
        (_, offset, value) => {
            const a = args();
            a.quote.unsignedLockupTx = mutateFundingTree(a.quote.unsignedLockupTx, offset, value);
            a.senderInputs[0].tapTree = hex.decode(
                decodeLockupEnvelope(a.quote.unsignedLockupTx).senderInputs[0].tapTree,
            );
            expect(() => verifyQuote(a)).toThrow();
        },
    );

    it("rejects an unsignedTxId accessor without evaluating its changing value", () => {
        const a = args();
        const original = a.quote.lockup.unsignedTxId;
        let reads = 0;
        Object.defineProperty(a.quote.lockup, "unsignedTxId", {
            configurable: true,
            enumerable: true,
            get: () => {
                reads += 1;
                return reads === 1 ? original : "00".repeat(32);
            },
        });
        expect(() => verifyQuote(a)).toThrow();
        expect(reads).toBe(0);
    });

    it("rejects a forged capability before calling identity", async () => {
        const { identity, sign } = signSpy();
        await expect(
            signLockup({ verified: { ...verifyQuote(args()) } as VerifiedQuote, identity }),
        ).rejects.toThrow();
        expect(sign).not.toHaveBeenCalled();
    });

    it("retains a private snapshot when the caller mutates its original authorization", async () => {
        const a = args();
        const verified = verifyQuote(a);
        a.quote.unsignedLockupTx = mutateArk(a.quote.unsignedLockupTx, (tx) =>
            tx.updateOutput(0, { amount: 331n }),
        );
        const { identity, sign } = signSpy();
        await expect(signLockup({ verified, identity })).resolves.toEqual(expect.any(String));
        expect(sign).toHaveBeenCalledTimes(2);
    });

    it("returns a frozen envelope view separated from private signing state", async () => {
        const verified = verifyQuote(args());
        expect(() => verified.envelope.senderInputIndexes.push(1)).toThrow();
        expect(() => {
            verified.envelope.senderInputs[0].expiry.value = "1";
        }).toThrow();
        verified.params.senderKey[0] ^= 1;
        await expect(signLockup({ verified, identity: senderIdentity })).resolves.toEqual(
            expect.any(String),
        );
    });
});

describe("sender-only lockup signing", () => {
    it("batches the Ark transaction and sender checkpoints in one wallet interaction", async () => {
        const verified = verifyQuote(args());
        const implementation: BatchSignableIdentity["signMultiple"] = async (requests) =>
            Promise.all(
                requests.map(({ tx, inputIndexes }) => senderIdentity.sign(tx, inputIndexes)),
            );
        const signMultiple = vi.fn(implementation);
        const identity = Object.assign(Object.create(senderIdentity), {
            sign: vi.fn(() => Promise.reject(new Error("sequential signing used"))),
            signMultiple,
        }) as BatchSignableIdentity;

        await expect(signLockup({ verified, identity })).resolves.toEqual(expect.any(String));
        expect(identity.sign).not.toHaveBeenCalled();
        expect(signMultiple).toHaveBeenCalledTimes(1);
        expect(signMultiple.mock.calls[0]?.[0].map((request) => request.inputIndexes)).toEqual([
            [0],
            [0],
        ]);
    });

    it("passes exactly the independently derived sender input indexes", async () => {
        const a = args();
        const senderInputs = fundingInputs();
        senderInputs.push({ ...senderInputs[0], txid: "bb".repeat(32) });
        a.senderInputs = senderInputs;
        a.senderSats = 20n;
        a.quote = quote(params(), { senderInputs, senderSats: 20n });
        const verified = verifyQuote(a);
        const { identity, sign } = signSpy();
        const signed = decodeLockupEnvelope(await signLockup({ verified, identity }));
        expect(sign).toHaveBeenCalledTimes(3);
        expect(sign.mock.calls[0]?.[1]).toEqual(verified.senderInputIndexes);
        expect(sign.mock.calls[0]?.[1]).toEqual([0, 1]);
        expect(sign.mock.calls[1]?.[1]).toEqual([0]);
        expect(sign.mock.calls[2]?.[1]).toEqual([0]);
        const tx = Transaction.fromPSBT(base64.decode(signed.arkTx));
        expect(tx.getInput(0).tapScriptSig).toHaveLength(1);
        expect(tx.getInput(1).tapScriptSig).toHaveLength(1);
        expect(tx.getInput(2).tapScriptSig).toBeUndefined();
    });

    it("signs and verifies asset quantities above Number.MAX_SAFE_INTEGER", async () => {
        const verified = verifyQuote(assetArgs());
        const signed = await signLockup({ verified, identity: senderIdentity });
        expect(() => assertSignedLockup(verified, signed)).not.toThrow();
    });

    it("signs only sender-owned checkpoints while preserving their unsigned bytes", async () => {
        const a = args();
        const before = decodeLockupEnvelope(a.quote.unsignedLockupTx);
        const operatorSigned = await operatorIdentity.sign(
            Transaction.fromPSBT(base64.decode(before.arkTx)),
            [1],
        );
        before.arkTx = base64.encode(operatorSigned.toPSBT());
        a.quote.unsignedLockupTx = encodeLockupEnvelope(before);
        const verified = verifyQuote(a);
        const signed = decodeLockupEnvelope(
            await signLockup({ verified, identity: senderIdentity }),
        );
        expect(signed.unsignedTxId).toBe(before.unsignedTxId);
        const actual = Transaction.fromPSBT(base64.decode(signed.arkTx));
        expect(actual.getInput(1).tapScriptSig).toEqual(operatorSigned.getInput(1).tapScriptSig);
        expect(actual.getInput(0).tapScriptSig).toHaveLength(1);
        const senderCheckpoint = Transaction.fromPSBT(base64.decode(signed.checkpoints[0]));
        const operatorCheckpoint = Transaction.fromPSBT(base64.decode(signed.checkpoints[1]));
        const unsignedSenderCheckpoint = Transaction.fromPSBT(base64.decode(before.checkpoints[0]));
        expect(senderCheckpoint.getInput(0).tapScriptSig).toHaveLength(1);
        senderCheckpoint.updateInput(0, { tapScriptSig: undefined });
        expect(senderCheckpoint.toPSBT()).toEqual(unsignedSenderCheckpoint.toPSBT());
        expect(operatorCheckpoint.toPSBT()).toEqual(base64.decode(before.checkpoints[1]));
    });

    it.each([
        "no signature",
        "output",
        "operator signature",
        "invalid signature",
        "signature sighash",
        "explicit default signature suffix",
        "metadata",
    ])("rejects a signer returning %s", async (attack) => {
        const verified = verifyQuote(args());
        const sign: Identity["sign"] = async (tx, indexes) => {
            if (attack === "no signature") return tx;
            if (attack === "output") tx.updateOutput(0, { amount: 331n });
            if (attack === "metadata") tx.updateInput(1, { sighashType: 0 });
            const signed = await senderIdentity.sign(tx, indexes);
            if (attack === "operator signature") return operatorIdentity.sign(signed, [1]);
            if (attack === "invalid signature") {
                const signatures = signed.getInput(0).tapScriptSig!;
                signatures[0][1].fill(0);
                signed.updateInput(0, { tapScriptSig: signatures });
            }
            if (attack === "signature sighash") {
                const signatures = signed.getInput(0).tapScriptSig!;
                signatures[0][1] = Uint8Array.from([...signatures[0][1], 1]);
                signed.updateInput(0, { tapScriptSig: signatures });
            }
            if (attack === "explicit default signature suffix") {
                const raw = signed as unknown as {
                    inputs: { tapScriptSig?: [unknown, Uint8Array][] }[];
                };
                const signature = raw.inputs[0].tapScriptSig![0][1];
                raw.inputs[0].tapScriptSig![0][1] = Uint8Array.from([...signature, 0]);
            }
            return signed;
        };
        const result = signLockup({ verified, identity: signer(sign) });
        if (attack === "explicit default signature suffix")
            await expect(result).rejects.toThrow("signature is not canonical DEFAULT");
        else await expect(result).rejects.toThrow();
    });

    it("rejects a signed envelope whose unsigned content changed before submission", async () => {
        const verified = verifyQuote(args());
        const signed = await signLockup({ verified, identity: senderIdentity });
        const changed = mutateArk(signed, (tx) => tx.updateOutput(0, { amount: 331n }, true));
        expect(() => assertSignedLockup(verified, changed)).toThrow();
    });
});
