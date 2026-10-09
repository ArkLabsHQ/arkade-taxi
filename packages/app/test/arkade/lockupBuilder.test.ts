import { describe, expect, it } from "vitest";
import {
    Transaction,
    getArkPsbtFields,
    VtxoTaprootTree,
    asset,
    Extension,
    ArkAddress,
    MultisigTapscript,
    scriptFromTapLeafScript,
} from "@arkade-os/sdk";
import { base64, hex } from "@scure/base";
import { buildLockupEnvelope, inputAssets, lockupPlan } from "../../src/arkade/lockupBuilder.js";
import { config, operatorKey } from "../fixtures.js";
import { buildRequest, unroll, senderTree, operatorTree } from "./lockupFixtures.js";
import { parseLockupEnvelope } from "../../src/arkade/psbt.js";
import { DustCovenantScript } from "@arkade-taxi/covenant";
import type { LockupBuildRequest } from "../../src/quotes.js";

describe("joint funded graph", () => {
    it.each([330n, 660n])(
        "retains duplicate-output protection for canonical payout and change at fare %s",
        (fare) => {
            const req = buildRequest();
            const cfg = config({ operatorKey: operatorTree.tweakedPublicKey });
            req.params.operatorKey = cfg.operatorKey;
            req.fare.units = fare;
            req.funding.totalValue = req.params.topup + fare + fare;
            req.funding.inputs[0].value = Number(req.funding.totalValue);
            req.covenantAddress = new DustCovenantScript({
                params: req.params,
                serverKey: cfg.serverPubkey,
                emulatorKey: cfg.emulatorPubkey,
                vtxoMinAmount: cfg.vtxoMinAmount,
            })
                .address(cfg.addressHrp, cfg.serverPubkey)
                .encode();
            expect(() => buildLockupEnvelope(req, cfg, unroll)).toThrow(/script/);
        },
    );
    it("rejects a quote payout that differs from runtime configuration", () => {
        const req = buildRequest();
        expect(() =>
            buildLockupEnvelope(
                req,
                config({ operatorKey: operatorTree.tweakedPublicKey }),
                unroll,
            ),
        ).toThrow(/operator payout/);
    });
    it("pays the operator's canonical wallet key without using that key as a funding signer", () => {
        const req = buildRequest();
        const payout = operatorTree.tweakedPublicKey;
        req.params.operatorKey = payout;
        // Fare and change would otherwise share the payout script: both clear
        // dust now, so neither takes the distinguishing sub-dust form.
        req.funding.totalValue = req.params.topup + req.fare.units;
        req.funding.inputs[0].value = Number(req.funding.totalValue);
        const cfg = config({ operatorKey: payout, operatorSignerKey: operatorKey });
        req.covenantAddress = new DustCovenantScript({
            params: req.params,
            serverKey: cfg.serverPubkey,
            emulatorKey: cfg.emulatorPubkey,
            vtxoMinAmount: cfg.vtxoMinAmount,
        })
            .address(cfg.addressHrp, cfg.serverPubkey)
            .encode();
        const parsed = parseLockupEnvelope(buildLockupEnvelope(req, cfg, unroll), req, cfg, unroll);
        expect(parsed.arkTx.getOutput(1).script).toEqual(
            operatorTree.address(cfg.addressHrp, cfg.serverPubkey).pkScript,
        );
        expect(
            MultisigTapscript.decode(
                scriptFromTapLeafScript(parsed.arkTx.getInput(1).tapLeafScript![0]),
            ).params.pubkeys,
        ).toEqual([cfg.serverPubkey, cfg.operatorSignerKey]);
        expect(payout).not.toEqual(operatorKey);
    });
    it.each([329n, 330n])("hosts asset change at the dust floor, not below, at %s", (change) => {
        const req = buildRequest();
        const id = asset.AssetId.create("12".repeat(32), 0);
        req.senderInputs[0].assetPacket = asset.Packet.create([
            asset.AssetGroup.create(id, null, [], [asset.AssetOutput.create(2, 100n)], []),
        ]).serialize();
        req.senderSats = req.senderInputs[0].value = change;
        req.params.assetId = { txid: id.txid, groupIndex: 0 };
        req.assetUnits = 99n;
        req.fare.units = 0n;
        req.funding.totalValue = req.params.topup;
        req.funding.inputs[0].value = Number(req.funding.totalValue);
        req.covenantAddress = new DustCovenantScript({
            params: req.params,
            serverKey: config().serverPubkey,
            emulatorKey: config().emulatorPubkey,
            vtxoMinAmount: config().vtxoMinAmount,
        })
            .address("ark", config().serverPubkey)
            .encode();
        if (change < config().dust)
            expect(() => buildLockupEnvelope(req, config(), unroll)).toThrow(/dust floor/);
        else {
            const parsed = parseLockupEnvelope(
                buildLockupEnvelope(req, config(), unroll),
                req,
                config(),
                unroll,
            );
            expect(parsed.arkTx.getOutput(1)).toMatchObject({
                amount: change,
                script: senderTree.address("ark", config().serverPubkey).pkScript,
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
    it.each([0n, 329n, 330n])(
        "checks operator residual boundary %s without reallocating it",
        (amount) => {
            const req = buildRequest();
            req.funding.totalValue = req.params.topup + req.fare.units + amount;
            req.funding.inputs[0].value = Number(req.funding.totalValue);
            if (amount > 0n && amount < config().dust)
                expect(() => buildLockupEnvelope(req, config(), unroll)).toThrow(/dust floor/);
            else {
                const parsed = parseLockupEnvelope(
                    buildLockupEnvelope(req, config(), unroll),
                    req,
                    config(),
                    unroll,
                );
                expect(parsed.arkTx.outputsLength).toBe(amount === 0n ? 4 : 5);
                expect(parsed.arkTx.getOutput(3).amount).toBe(amount);
            }
        },
    );
    it.each([0n, 330n, 660n])("keeps canonical declared fare payout at %s sats", (amount) => {
        const req = buildRequest();
        req.fare.units = amount;
        req.funding.totalValue = req.params.topup + amount;
        req.funding.inputs[0].value = Number(req.funding.totalValue);
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
                script: address.pkScript,
            });
        }
    });
    // The dust floor is what keeps the SDK's two-OP_RETURN ceiling out of reach
    // on this rail: a sub-dust payout is refused before it can become a third.
    it("refuses a sub-dust payout rather than reaching the OP_RETURN ceiling", () => {
        const req = buildRequest();
        req.senderSats = req.senderInputs[0].value = 30n;
        req.funding.totalValue = req.params.topup + req.fare.units;
        req.funding.inputs[0].value = Number(req.funding.totalValue);
        expect(() => buildLockupEnvelope(req, config(), unroll)).toThrow(/dust floor/);
    });
    it.each([330n, 331n, 660n])("selects SDK scripts for owner change at %s sats", (amount) => {
        const req = buildRequest();
        req.fare.units = 330n;
        req.senderSats = req.senderInputs[0].value = amount;
        req.funding.totalValue = req.params.topup + req.fare.units + amount;
        req.funding.inputs[0].value = Number(req.funding.totalValue);
        const wire = JSON.parse(
            Buffer.from(base64.decode(buildLockupEnvelope(req, config(), unroll))).toString(),
        );
        const tx = Transaction.fromPSBT(base64.decode(wire.arkTx));
        const sender = senderTree.address("ark", config().serverPubkey);
        const operator = operatorTree.address("ark", config().serverPubkey);
        expect(tx.getOutput(2)).toMatchObject({ amount, script: sender.pkScript });
        expect(tx.getOutput(3)).toMatchObject({ amount, script: operator.pkScript });
        expect(
            parseLockupEnvelope(
                base64.encode(Buffer.from(JSON.stringify(wire))),
                req,
                config(),
                unroll,
            ).unsignedTxId,
        ).toBe(wire.unsignedTxId);
    });
    it.each(["fare", "sender change", "operator change"])(
        "rejects %s below the covenant dust floor",
        (role) => {
            const req = buildRequest();
            req.fare.units = role === "fare" ? 329n : 330n;
            req.funding.totalValue = req.params.topup + req.fare.units;
            if (role === "operator change") req.funding.totalValue += 329n;
            req.funding.inputs[0].value = Number(req.funding.totalValue);
            if (role === "sender change") req.senderSats = req.senderInputs[0].value = 329n;
            expect(() => buildLockupEnvelope(req, config(), unroll)).toThrow(/dust floor/);
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
    it.each(["mixed expiry", "wrong batch minimum", "height locktime", "packet metadata"])(
        "rejects %s in a direct construction request",
        (kind) => {
            const req = buildRequest();
            if (kind === "mixed expiry")
                req.senderInputs[0].expiry = { kind: "height", value: 900_000n };
            if (kind === "wrong batch minimum") req.funding.batchExpiry.value++;
            // The deadline outlives the funding coins on purpose, so what is
            // refused is a locktime outside the time domain, not a late one.
            if (kind === "height locktime") req.params.locktime = 899_855n;
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
            vtxoMinAmount: config().vtxoMinAmount,
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
            330n,
            700n,
            340n,
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
        expect(checkpoints[0].getInput(0).witnessUtxo?.amount).toBe(660n);
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
        expect(tx.getOutput(1).amount).toBe(330n);
        expect(tx.getOutput(2).amount).toBe(660n);
        expect(tx.getOutput(3).amount).toBe(340n);
        expect(tx.outputsLength).toBe(5);
        expect(envelope.senderInputIndexes).toEqual([0]);
        expect(envelope.operatorInputIndexes).toEqual([1]);
        expect(envelope.covenantOutputIndex).toBe(0);
    });
});

describe("covenant outputs", () => {
    const cfg = config();
    const fareAsset = asset.AssetId.create("12".repeat(32), 0);

    const request = (over: { senderSats?: bigint; fare?: bigint } = {}) => {
        const req = buildRequest();
        req.senderSats = req.senderInputs[0].value = over.senderSats ?? 330n;
        req.fare.units = over.fare ?? 0n;
        req.covenantAddress = new DustCovenantScript({
            params: req.params,
            serverKey: cfg.serverPubkey,
            emulatorKey: cfg.emulatorPubkey,
            vtxoMinAmount: cfg.vtxoMinAmount,
        })
            .address(cfg.addressHrp, cfg.serverPubkey)
            .encode();
        return req;
    };

    const withAssetFare = (req: LockupBuildRequest) => {
        req.params.assetId = { txid: fareAsset.txid, groupIndex: 0 };
        req.senderInputs[0].assetPacket = asset.Packet.create([
            asset.AssetGroup.create(fareAsset, null, [], [asset.AssetOutput.create(2, 100n)], []),
        ]).serialize();
        req.assetUnits = 95n;
        req.fare = { currency: "asset", units: 5n, assetId: req.params.assetId };
        req.covenantAddress = new DustCovenantScript({
            params: req.params,
            serverKey: cfg.serverPubkey,
            emulatorKey: cfg.emulatorPubkey,
            vtxoMinAmount: cfg.vtxoMinAmount,
        })
            .address(cfg.addressHrp, cfg.serverPubkey)
            .encode();
        return req;
    };

    it("hosts an asset fare at a whole dust unit", () => {
        const req = withAssetFare(request());
        expect(lockupPlan(req, cfg).valueOutputs).toMatchObject([
            { role: "covenant", amount: 330n },
            { role: "operator-fare", amount: cfg.dust },
            { role: "sender-change", amount: 330n },
            { role: "operator-change", amount: 340n },
        ]);
        expect(() => buildLockupEnvelope(req, cfg, unroll)).not.toThrow();
    });

    it.each([329n, 330n])("admits sender change %s only when it reaches dust", (change) => {
        const req = request({ senderSats: change });
        if (change < cfg.dust)
            expect(() => buildLockupEnvelope(req, cfg, unroll)).toThrow(/sender-change/);
        else expect(lockupPlan(req, cfg).valueOutputs[1]).toMatchObject({ amount: change });
    });

    it("refuses a sub-dust sats fare rather than paying it to a RETURN script", () => {
        expect(() => lockupPlan(request({ fare: 10n }), cfg)).toThrow(/operator-fare/);
        expect(() => lockupPlan(request({ fare: 330n, senderSats: 660n }), cfg)).not.toThrow();
    });
});

// A sats fare is its own hosting output, so under the covenant it must clear
// the dust floor; the sub-dust fares the service minimum once allowed are gone.
describe("sender-paid sats fare", () => {
    const cfg = config();
    const paymentAsset = asset.AssetId.create("12".repeat(32), 0);

    interface Over {
        senderSats?: bigint;
        fare?: bigint;
        legacy?: true;
        asset?: boolean;
    }

    const request = (over: Over = {}): LockupBuildRequest => {
        const req = buildRequest();
        req.senderSats = over.senderSats ?? 661n;
        req.senderInputs[0].value = req.senderSats;
        req.fare.units = over.fare ?? 330n;
        req.funding.totalValue = 1000n;
        req.funding.inputs[0].value = 1000;
        if (!over.legacy) req.satsFarePayer = "sender";
        if (over.asset) {
            req.senderInputs[0].assetPacket = asset.Packet.create([
                asset.AssetGroup.create(
                    paymentAsset,
                    null,
                    [],
                    [asset.AssetOutput.create(2, 100n)],
                    [],
                ),
            ]).serialize();
            req.params.assetId = {
                txid: paymentAsset.txid,
                groupIndex: paymentAsset.groupIndex,
            };
            req.assetUnits = 100n;
        }
        req.covenantAddress = new DustCovenantScript({
            params: req.params,
            serverKey: cfg.serverPubkey,
            emulatorKey: cfg.emulatorPubkey,
            vtxoMinAmount: cfg.vtxoMinAmount,
        })
            .address(cfg.addressHrp, cfg.serverPubkey)
            .encode();
        return req;
    };

    const layout = (req: LockupBuildRequest): [string, bigint][] =>
        lockupPlan(req, cfg).valueOutputs.map((o) => [o.role, o.amount]);

    /** Everything Taxi holds once the transfer settles — the fare, its own change
     * and the covenant's pinned repayment — against the inventory it committed. */
    const netOperatorSats = (req: LockupBuildRequest): bigint =>
        lockupPlan(req, cfg)
            .valueOutputs.filter((o) => o.role !== "covenant" && o.role !== "sender-change")
            .reduce((sum, o) => sum + o.amount, 0n) +
        req.params.topup -
        req.funding.totalValue;

    it("takes the fare from the sender, so the service is actually paid", () => {
        const req = request();
        expect(netOperatorSats(req)).toBe(330n);
        expect(layout(req)).toEqual([
            ["covenant", 330n],
            ["operator-fare", 330n],
            ["sender-change", 331n],
            ["operator-change", 670n],
        ]);
    });

    it("collects nothing without the discriminator, as every funded graph did", () => {
        const req = request({ legacy: true });
        expect(layout(req)).toEqual([
            ["covenant", 330n],
            ["operator-fare", 330n],
            ["sender-change", 661n],
            ["operator-change", 340n],
        ]);
        expect(netOperatorSats(req)).toBe(0n);
    });

    it("charges the same way when the carrier moves an asset", () => {
        const req = request({ senderSats: 1_000n, asset: true });
        expect(layout(req)).toEqual([
            ["covenant", 330n],
            ["operator-fare", 330n],
            ["sender-change", 670n],
            ["operator-change", 670n],
        ]);
        expect(netOperatorSats(req)).toBe(330n);
        expect(layout(request({ senderSats: 1_000n, asset: true, legacy: true }))).toEqual([
            ["covenant", 330n],
            ["operator-fare", 330n],
            ["sender-change", 1000n],
            ["operator-change", 340n],
        ]);
    });

    it.each([330n, 400n, 660n])("never nets a %s sat fare out of the loan principal", (fare) => {
        const req = request({ senderSats: fare + 330n, fare });
        const amounts = new Map(layout(req));
        expect(amounts.get("covenant")).toBe(req.params.dust);
        expect(amounts.get("operator-change")).toBe(req.funding.totalValue - req.params.topup);
        expect(amounts.get("sender-change")).toBe(req.senderSats - fare);
        expect(netOperatorSats(req)).toBe(fare);
    });

    it("refuses a sender that cannot cover the fare", () => {
        expect(() => lockupPlan(request({ senderSats: 329n }), cfg)).toThrow(/sender/);
    });

    it.each(["zero", "asset"])("refuses a payer naming a %s fare", (kind) => {
        const req = request(kind === "zero" ? { fare: 0n } : { asset: true, senderSats: 1_000n });
        if (kind === "asset")
            req.fare = { currency: "asset", assetId: req.params.assetId!, units: 5n };
        expect(() => lockupPlan(req, cfg)).toThrow(/positive sats fare/);
    });

    it("refuses an unrecognised payer rather than falling back to the legacy layout", () => {
        const req = request();
        (req as { satsFarePayer?: string }).satsFarePayer = "operator";
        expect(() => lockupPlan(req, cfg)).toThrow(/sats fare payer/);
    });

    it("carries the discriminator through the envelope it signs", () => {
        const req = request({ senderSats: 1_000n, asset: true });
        const encoded = buildLockupEnvelope(req, cfg, unroll);
        const wire = JSON.parse(Buffer.from(base64.decode(encoded)).toString());
        expect(wire.satsFarePayer).toBe("sender");
        expect(parseLockupEnvelope(encoded, req, cfg, unroll).unsignedTxId).toBe(wire.unsignedTxId);
        expect(Transaction.fromPSBT(base64.decode(wire.arkTx)).getOutput(2).amount).toBe(670n);
        const legacy = buildLockupEnvelope(
            request({ senderSats: 1_000n, asset: true, legacy: true }),
            cfg,
            unroll,
        );
        expect(
            JSON.parse(Buffer.from(base64.decode(legacy)).toString()).satsFarePayer,
        ).toBeUndefined();
    });
});
