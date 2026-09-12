import { describe, expect, it } from "vitest";
import { Transaction } from "@arkade-os/sdk";
import { base64 } from "@scure/base";
import { buildLockupEnvelope } from "../../src/arkade/lockupBuilder.js";
import { parseLockupEnvelope, unsignedGraphId } from "../../src/arkade/psbt.js";
import { config } from "../fixtures.js";
import { buildRequest, unroll } from "./lockupFixtures.js";

describe("independent envelope validation", () => {
    it("rejects a recomputed hash with a below-minimum fare independently", () => {
        const req = buildRequest();
        const wire = JSON.parse(
            Buffer.from(base64.decode(buildLockupEnvelope(req, config(), unroll))).toString(),
        );
        const tx = Transaction.fromPSBT(base64.decode(wire.arkTx));
        tx.updateOutput(1, { amount: 9n });
        tx.updateOutput(2, { amount: 761n });
        wire.arkTx = base64.encode(tx.toPSBT());
        wire.unsignedTxId = unsignedGraphId(
            tx,
            wire.checkpoints.map((s: string) => Transaction.fromPSBT(base64.decode(s))),
        );
        expect(() =>
            parseLockupEnvelope(
                base64.encode(Buffer.from(JSON.stringify(wire))),
                req,
                config(),
                unroll,
            ),
        ).toThrow(/minimum/);
    });
    it("rejects an output substitution even if the attacker recomputes the hash", () => {
        const req = buildRequest();
        const wire = JSON.parse(
            Buffer.from(base64.decode(buildLockupEnvelope(req, config(), unroll))).toString(),
        );
        const tx = Transaction.fromPSBT(base64.decode(wire.arkTx));
        tx.updateOutput(2, { script: tx.getOutput(0).script });
        wire.arkTx = base64.encode(tx.toPSBT());
        wire.unsignedTxId = unsignedGraphId(
            tx,
            wire.checkpoints.map((s: string) => Transaction.fromPSBT(base64.decode(s))),
        );
        expect(() =>
            parseLockupEnvelope(
                base64.encode(Buffer.from(JSON.stringify(wire))),
                req,
                config(),
                unroll,
            ),
        ).toThrow(/script mismatch/);
    });
    it("accepts the canonical graph regardless of JSON formatting", () => {
        const req = buildRequest();
        const encoded = buildLockupEnvelope(req, config(), unroll);
        const wire = JSON.parse(Buffer.from(base64.decode(encoded)).toString());
        const formatted = base64.encode(Buffer.from(JSON.stringify(wire, null, 4)));
        expect(parseLockupEnvelope(formatted, req, config(), unroll).unsignedTxId).toBe(
            wire.unsignedTxId,
        );
    });
    it.each([
        "ownership",
        "outpoint",
        "amount",
        "leaf",
        "tree",
        "output",
        "checkpoint",
        "expiry",
        "hash",
        "index",
    ])("rejects mutated %s", (field) => {
        const req = buildRequest();
        const wire = JSON.parse(
            Buffer.from(base64.decode(buildLockupEnvelope(req, config(), unroll))).toString(),
        );
        if (field === "ownership") wire.operatorInputIndexes = [0];
        if (field === "checkpoint") wire.checkpoints.pop();
        if (field === "hash") wire.unsignedTxId = "00".repeat(32);
        if (field === "index") wire.covenantOutputIndex = 1;
        if (field === "expiry") wire.senderInputs[0].expiry.kind = "time";
        if (["outpoint", "amount", "leaf", "tree"].includes(field)) {
            const cp = Transaction.fromPSBT(base64.decode(wire.checkpoints[0]));
            if (field === "outpoint") cp.updateInput(0, { index: 1 });
            if (field === "amount")
                cp.updateInput(0, {
                    witnessUtxo: { ...cp.getInput(0).witnessUtxo!, amount: 101n },
                });
            if (field === "leaf") cp.updateInput(0, { tapLeafScript: undefined });
            if (field === "tree") cp.updateInput(0, { unknown: undefined });
            wire.checkpoints[0] = base64.encode(cp.toPSBT());
        }
        if (field === "output") {
            const tx = Transaction.fromPSBT(base64.decode(wire.arkTx));
            tx.updateOutput(1, { amount: 9n });
            wire.arkTx = base64.encode(tx.toPSBT());
        }
        expect(() =>
            parseLockupEnvelope(
                base64.encode(Buffer.from(JSON.stringify(wire))),
                req,
                config(),
                unroll,
            ),
        ).toThrow();
    });
});
