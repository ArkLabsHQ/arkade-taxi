import { describe, expect, it } from "vitest";
import {
    Transaction,
    getArkPsbtFields,
    VtxoTaprootTree,
    asset,
    Extension,
    ArkAddress,
} from "@arkade-os/sdk";
import { base64, hex } from "@scure/base";
import { buildLockupEnvelope, inputAssets } from "../../src/arkade/lockupBuilder.js";
import { config } from "../fixtures.js";
import { buildRequest, unroll, senderTree, operatorTree } from "./lockupFixtures.js";
import { parseLockupEnvelope } from "../../src/arkade/psbt.js";
import { DustCovenantScript } from "@arkade-taxi/covenant";

describe("joint funded graph", () => {
    it.each([1n, 9n, 10n])("enforces minimum hosting for asset change at %s sats", (change) => {
        const req = buildRequest();
        const id = asset.AssetId.create("12".repeat(32), 0);
        req.senderInputs[0].assetPacket = asset.Packet.create([
            asset.AssetGroup.create(id, null, [], [asset.AssetOutput.create(2, 100n)], []),
        ]).serialize();
        req.senderSats = 320n + change;
        req.senderInputs[0].value = req.senderSats;
        req.params.topup = 10n;
        req.params.assetId = { txid: id.txid, groupIndex: 0 };
        req.assetUnits = 99n;
        req.fare.units = 0n;
        req.covenantAddress = new DustCovenantScript({
            params: req.params,
            serverKey: config().serverPubkey,
            emulatorKey: config().emulatorPubkey,
            vtxoMinAmount: 10n,
        })
            .address("ark", config().serverPubkey)
            .encode();
        if (change < 10n)
            expect(() => buildLockupEnvelope(req, config(), unroll)).toThrow(/minimum/);
        else {
            const parsed = parseLockupEnvelope(
                buildLockupEnvelope(req, config(), unroll),
                req,
                config(),
                unroll,
            );
            expect(parsed.arkTx.getOutput(1)).toMatchObject({
                amount: 10n,
                script: senderTree.address("ark", config().serverPubkey).subdustPkScript,
            });
            expect(
                Extension.fromTx(parsed.arkTx)
                    .getAssetPacket()!
                    .groups[0].outputs.map((o) => [o.vout, o.amount]),
            ).toEqual([
                [0, 99n],
                [1, 1n],
            ]);
        }
    });
    it.each([0n, 1n, 9n, 10n, 329n, 330n])(
        "checks operator residual boundary %s without reallocating it",
        (amount) => {
            const req = buildRequest();
            req.funding.totalValue = 240n + amount;
            req.funding.inputs[0].value = Number(req.funding.totalValue);
            if (amount > 0n && amount < 10n)
                expect(() => buildLockupEnvelope(req, config(), unroll)).toThrow(/minimum/);
            else {
                const parsed = parseLockupEnvelope(
                    buildLockupEnvelope(req, config(), unroll),
                    req,
                    config(),
                    unroll,
                );
                expect(parsed.arkTx.outputsLength).toBe(amount === 0n ? 3 : 4);
                expect(parsed.arkTx.getOutput(2).amount).toBe(amount);
            }
        },
    );
    it.each([0n, 10n, 329n, 330n])("keeps canonical declared fare payout at %s sats", (amount) => {
        const req = buildRequest();
        req.fare.units = amount;
        const parsed = parseLockupEnvelope(
            buildLockupEnvelope(req, config(), unroll),
            req,
            config(),
            unroll,
        );
        if (amount === 0n) expect(parsed.arkTx.outputsLength).toBe(3);
        else {
            const address = new ArkAddress(config().serverPubkey, req.params.operatorKey, "ark");
            expect(parsed.arkTx.getOutput(1)).toMatchObject({
                amount,
                script: amount < 330n ? address.subdustPkScript : address.pkScript,
            });
        }
    });
    it("clearly refuses more than two canonical OP_RETURN outputs", () => {
        const req = buildRequest();
        req.senderSats = 330n;
        req.senderInputs[0].value = 330n;
        req.params.topup = 10n;
        req.funding.totalValue = 30n;
        req.funding.inputs[0].value = 30;
        req.covenantAddress = new DustCovenantScript({
            params: req.params,
            serverKey: config().serverPubkey,
            emulatorKey: config().emulatorPubkey,
            vtxoMinAmount: 10n,
        })
            .address("ark", config().serverPubkey)
            .encode();
        expect(() => buildLockupEnvelope(req, config(), unroll)).toThrow(
            /public SDK.*two OP_RETURN/,
        );
    });
    it.each([10n, 329n, 330n, 331n])(
        "selects SDK scripts for owner change at %s sats",
        (amount) => {
            const req = buildRequest();
            req.fare.units = 330n;
            req.senderSats = 330n + amount - 10n;
            req.senderInputs[0].value = req.senderSats;
            req.params.topup = 10n;
            req.funding.totalValue = 340n + amount;
            req.funding.inputs[0].value = Number(req.funding.totalValue);
            req.covenantAddress = new DustCovenantScript({
                params: req.params,
                serverKey: config().serverPubkey,
                emulatorKey: config().emulatorPubkey,
                vtxoMinAmount: 10n,
            })
                .address("ark", config().serverPubkey)
                .encode();
            const wire = JSON.parse(
                Buffer.from(base64.decode(buildLockupEnvelope(req, config(), unroll))).toString(),
            );
            const tx = Transaction.fromPSBT(base64.decode(wire.arkTx));
            const sender = senderTree.address("ark", config().serverPubkey);
            const operator = operatorTree.address("ark", config().serverPubkey);
            expect(tx.getOutput(2)).toMatchObject({
                amount,
                script: amount < 330n ? sender.subdustPkScript : sender.pkScript,
            });
            expect(tx.getOutput(3)).toMatchObject({
                amount,
                script: amount < 330n ? operator.subdustPkScript : operator.pkScript,
            });
            expect(
                parseLockupEnvelope(
                    base64.encode(Buffer.from(JSON.stringify(wire))),
                    req,
                    config(),
                    unroll,
                ).unsignedTxId,
            ).toBe(wire.unsignedTxId);
        },
    );
    it.each(["fare", "sender change", "operator change"])(
        "rejects %s below the Arkade Service minimum",
        (role) => {
            const req = buildRequest();
            req.fare.units = role === "fare" ? 8n : 10n;
            if (role === "operator change") {
                req.funding.totalValue = 241n;
                req.funding.inputs[0].value = 241;
            }
            if (role === "sender change") {
                req.senderSats = 321n;
                req.senderInputs[0].value = 321n;
                req.params.topup = 10n;
                req.covenantAddress = new DustCovenantScript({
                    params: req.params,
                    serverKey: config().serverPubkey,
                    emulatorKey: config().emulatorPubkey,
                    vtxoMinAmount: 10n,
                })
                    .address("ark", config().serverPubkey)
                    .encode();
            }
            expect(() => buildLockupEnvelope(req, config(), unroll)).toThrow(/minimum/);
        },
    );
    it("rejects an operator leaf proof inconsistent with its selected tap tree", () => {
        const req = buildRequest();
        req.funding.inputs[0].forfeitTapLeafScript = structuredClone(
            req.funding.inputs[0].forfeitTapLeafScript,
        );
        req.funding.inputs[0].forfeitTapLeafScript[0].internalKey[0] ^= 1;
        expect(() => buildLockupEnvelope(req, config(), unroll)).toThrow();
    });
    it.each(["mixed expiry", "wrong batch minimum", "late covenant", "packet metadata"])(
        "rejects %s in a direct construction request",
        (kind) => {
            const req = buildRequest();
            if (kind === "mixed expiry")
                req.senderInputs[0].expiry = { kind: "time", value: 1789132933n };
            if (kind === "wrong batch minimum") req.funding.batchExpiry.value++;
            if (kind === "late covenant") req.senderInputs[0].expiry.value = 899855n;
            if (kind === "packet metadata")
                req.senderInputs[0].assetPacket = asset.Packet.create([
                    asset.AssetGroup.create(
                        asset.AssetId.create("12".repeat(32), 0),
                        null,
                        [asset.AssetInput.create(5, 100n)],
                        [asset.AssetOutput.create(2, 100n)],
                        [],
                    ),
                ]).serialize();
            expect(() =>
                kind === "packet metadata"
                    ? inputAssets(req.senderInputs[0])
                    : buildLockupEnvelope(req, config(), unroll),
            ).toThrow();
        },
    );
    it("balances every asset group, separates asset fare, and returns each owner's change", () => {
        const req = buildRequest();
        req.senderInputs[0].value = 700n;
        req.senderSats = 700n;
        req.params.topup = 10n;
        const payment = asset.AssetId.create(
            "000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f",
            2,
        );
        const extra = asset.AssetId.create("34".repeat(32), 3);
        req.params.assetId = {
            txid: Uint8Array.from(payment.txid).reverse(),
            groupIndex: payment.groupIndex,
        };
        req.assetUnits = 70n;
        req.fare = { currency: "asset", assetId: req.params.assetId, units: 8n };
        req.senderInputs[0].assetPacket = asset.Packet.create([
            asset.AssetGroup.create(payment, null, [], [asset.AssetOutput.create(2, 100n)], []),
            asset.AssetGroup.create(
                extra,
                null,
                [],
                [asset.AssetOutput.create(2, 1_000_000_000_000_000_000n)],
                [],
            ),
        ]).serialize();
        const covenant = new DustCovenantScript({
            params: req.params,
            serverKey: config().serverPubkey,
            emulatorKey: config().emulatorPubkey,
            vtxoMinAmount: 10n,
        });
        req.covenantAddress = covenant.address("ark", config().serverPubkey).encode();
        const wire = JSON.parse(
            Buffer.from(base64.decode(buildLockupEnvelope(req, config(), unroll))).toString(),
        );
        expect(wire.assetUnits).toBe("70");
        const tx = Transaction.fromPSBT(base64.decode(wire.arkTx));
        expect(
            parseLockupEnvelope(
                base64.encode(Buffer.from(JSON.stringify(wire))),
                req,
                config(),
                unroll,
            ).unsignedTxId,
        ).toBe(wire.unsignedTxId);
        expect(tx.getOutput(2).script).toEqual(senderTree.pkScript);
        expect(tx.getOutput(3).script).toEqual(operatorTree.pkScript);
        expect([0, 1, 2, 3, 4, 5].map((i) => tx.getOutput(i).amount)).toEqual([
            330n,
            10n,
            380n,
            980n,
            0n,
            0n,
        ]);
        const groups = Extension.fromTx(tx).getAssetPacket()!.groups;
        expect(groups[0].outputs.map((o) => [o.vout, o.amount])).toEqual([
            [0, 70n],
            [1, 8n],
            [2, 22n],
        ]);
        expect(groups[1].outputs.map((o) => [o.vout, o.amount])).toEqual([
            [2, 1_000_000_000_000_000_000n],
        ]);
        expect(groups[0].inputs.map((i) => [i.vin, i.amount])).toEqual([[0, 100n]]);
    });
    it("binds both owners' prevouts and metadata through one checkpoint each", () => {
        const req = buildRequest();
        const result = buildLockupEnvelope(req, config(), unroll);
        const envelope = JSON.parse(Buffer.from(base64.decode(result)).toString());
        const tx = Transaction.fromPSBT(base64.decode(envelope.arkTx));
        const checkpoints = envelope.checkpoints.map((s: string) =>
            Transaction.fromPSBT(base64.decode(s)),
        );
        expect(tx.inputsLength).toBe(2);
        expect(checkpoints).toHaveLength(2);
        expect(hex.encode(checkpoints[0].getInput(0).txid!)).toBe("ab".repeat(32));
        expect(checkpoints[0].getInput(0).index).toBe(2);
        expect(checkpoints[0].getInput(0).witnessUtxo?.amount).toBe(100n);
        expect(checkpoints[0].getInput(0).witnessUtxo?.script).toEqual(senderTree.pkScript);
        expect(checkpoints[0].getInput(0).tapLeafScript).toEqual([senderTree.leaves[0]]);
        expect(checkpoints[1].getInput(0).witnessUtxo).toEqual({
            script: operatorTree.pkScript,
            amount: 1000n,
        });
        expect(checkpoints[1].getInput(0).tapLeafScript).toEqual([operatorTree.leaves[0]]);
        expect(getArkPsbtFields(checkpoints[0], 0, VtxoTaprootTree)).toEqual([
            req.senderInputs[0].tapTree,
        ]);
        expect(tx.getOutput(0).amount).toBe(330n);
        expect(tx.getOutput(1).amount).toBe(10n);
        expect(tx.getOutput(2).amount).toBe(760n);
        expect(tx.getOutput(3).amount).toBe(0n);
        expect(tx.outputsLength).toBe(4);
        expect(envelope.senderInputIndexes).toEqual([0]);
        expect(envelope.operatorInputIndexes).toEqual([1]);
        expect(envelope.covenantOutputIndex).toBe(0);
    });
});
