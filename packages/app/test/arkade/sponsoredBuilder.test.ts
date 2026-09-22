import { describe, expect, it } from "vitest";
import { ArkAddress, Extension, Transaction, asset } from "@arkade-os/sdk";
import { base64 } from "@scure/base";
import {
    buildSponsoredEnvelope,
    parseSponsoredEnvelope,
    sponsoredGraphId,
    sponsoredPlan,
    type SponsoredBuildRequest,
} from "../../src/arkade/sponsoredBuilder.js";
import { decodeLockupEnvelope, encodeLockupEnvelope } from "../../src/arkade/psbt.js";
import {
    config,
    fundingCoin,
    operatorKey,
    receiverKey,
    senderKey,
    serverKey,
    DUST,
    VTXO_MIN,
} from "../fixtures.js";
import { operatorTree, senderTree, unroll } from "./lockupFixtures.js";

const USDT = asset.AssetId.create("1234".repeat(16), 0);
const usdtInternal = { txid: Uint8Array.from(USDT.txid).reverse(), groupIndex: USDT.groupIndex };

const receiverAddress = new ArkAddress(serverKey, receiverKey, "ark").encode();

const senderInputs = (units: bigint, sats = 1000n) => [
    {
        txid: "ab".repeat(32),
        vout: 2,
        value: sats,
        tapTree: senderTree.encode(),
        spendLeaf: senderTree.scripts[0],
        expiry: { kind: "height", value: 900_000n } as const,
        assetPacket: asset.Packet.create([
            asset.AssetGroup.create(USDT, null, [], [asset.AssetOutput.create(2, units)], []),
        ]).serialize(),
    },
];

const request = (over: Partial<SponsoredBuildRequest> = {}): SponsoredBuildRequest => ({
    advanceId: "sponsored-1",
    senderInputs: senderInputs(201_000_000n),
    senderSats: 1000n,
    funding: {
        inputs: [fundingCoin()],
        totalValue: 20_000n,
        batchExpiry: { kind: "height", value: 900_000n },
    },
    params: {
        receiverKey,
        senderKey,
        operatorKey: config().operatorKey,
        dust: DUST,
        contribution: 10n,
        assetId: usdtInternal,
    },
    receiverAddress,
    fare: {
        currency: "asset",
        assetId: { txid: Uint8Array.from(usdtInternal.txid), groupIndex: 0 },
        units: 1_000_000n,
    },
    assetUnits: 200_000_000n,
    ...over,
});

describe("sponsored joint graph", () => {
    it("pays Bob directly and collects a 1 USDT fare", () => {
        const req = request();
        const cfg = config();
        const encoded = buildSponsoredEnvelope(req, cfg, unroll);
        const parsed = parseSponsoredEnvelope(encoded, req, cfg, unroll);
        expect(parsed.arkTx.getOutput(0)).toMatchObject({
            amount: DUST,
            script: new ArkAddress(serverKey, receiverKey, "ark").pkScript,
        });
        expect(parsed.arkTx.getOutput(1)).toMatchObject({
            amount: VTXO_MIN,
            script: new ArkAddress(cfg.serverPubkey, cfg.operatorKey, "ark").subdustPkScript,
        });
        expect(parsed.arkTx.getOutput(2)).toMatchObject({ amount: 680n });
        expect(
            Extension.fromTx(parsed.arkTx)
                .getAssetPacket()!
                .groups[0].outputs.map((o) => [o.vout, o.amount]),
        ).toEqual([
            [0, 200_000_000n],
            [1, 1_000_000n],
        ]);
        expect(parsed.unsignedTxId).toBe(
            sponsoredGraphId(
                Transaction.fromPSBT(base64.decode(decodeLockupEnvelope(encoded).arkTx)),
                parsed.checkpoints,
            ),
        );
    });

    it("funds a below-dust bitcoin payment without assets", () => {
        const cfg = config();
        const req = request({
            senderInputs: [
                {
                    txid: "ab".repeat(32),
                    vout: 2,
                    value: 100n,
                    tapTree: senderTree.encode(),
                    spendLeaf: senderTree.scripts[0],
                    expiry: { kind: "height", value: 900_000n },
                },
            ],
            senderSats: 100n,
            funding: {
                inputs: [fundingCoin({ value: 1000 })],
                totalValue: 1000n,
                batchExpiry: { kind: "height", value: 900_000n },
            },
            params: {
                receiverKey,
                senderKey,
                operatorKey: cfg.operatorKey,
                dust: DUST,
                contribution: 230n,
            },
            fare: { currency: "sats", units: 0n },
            assetUnits: undefined,
        });
        const parsed = parseSponsoredEnvelope(
            buildSponsoredEnvelope(req, cfg, unroll),
            req,
            cfg,
            unroll,
        );
        expect(parsed.arkTx.getOutput(0)).toMatchObject({ amount: DUST });
        expect(parsed.arkTx.outputsLength).toBe(3);
        expect(parsed.arkTx.getOutput(1)).toMatchObject({ amount: 770n });
    });

    it("rejects a receiver address that is not canonical for this service", () => {
        const cfg = config();
        const req = request();
        expect(() =>
            buildSponsoredEnvelope(
                { ...req, receiverAddress: receiverAddress.toUpperCase() },
                cfg,
                unroll,
            ),
        ).toThrow(/canonical|invalid/);
        expect(() =>
            buildSponsoredEnvelope(
                {
                    ...req,
                    receiverAddress: new ArkAddress(serverKey, receiverKey, "tark").encode(),
                },
                cfg,
                unroll,
            ),
        ).toThrow(/network/);
        expect(() =>
            buildSponsoredEnvelope(
                { ...req, params: { ...req.params, receiverKey: senderKey } },
                cfg,
                unroll,
            ),
        ).toThrow(/receiver key/);
    });

    it("rejects a contribution outside the dust window", () => {
        const cfg = config();
        const req = request();
        expect(() =>
            buildSponsoredEnvelope(
                { ...req, params: { ...req.params, contribution: 0n } },
                cfg,
                unroll,
            ),
        ).toThrow(/contribution/);
        expect(() =>
            buildSponsoredEnvelope(
                { ...req, params: { ...req.params, contribution: DUST + 1n } },
                cfg,
                unroll,
            ),
        ).toThrow(/contribution/);
    });

    it("rejects a tampered payment commitment on parse", () => {
        const req = request();
        const cfg = config();
        const envelope = decodeLockupEnvelope(buildSponsoredEnvelope(req, cfg, unroll));
        expect(() =>
            parseSponsoredEnvelope(
                encodeLockupEnvelope({ ...envelope, covenantOutputIndex: 1 }),
                req,
                cfg,
                unroll,
            ),
        ).toThrow(/payment index/);
        expect(() =>
            parseSponsoredEnvelope(
                encodeLockupEnvelope({ ...envelope, checkpoints: envelope.checkpoints.slice(1) }),
                req,
                cfg,
                unroll,
            ),
        ).toThrow(/checkpoint count/);
    });
});

describe("sponsored sender-paid sats fare", () => {
    const cfg = config();

    interface Over {
        senderSats?: bigint;
        contribution?: bigint;
        fare?: bigint;
        legacy?: true;
        bitcoin?: true;
    }

    const satsFare = (over: Over = {}): SponsoredBuildRequest => {
        const senderSats = over.senderSats ?? 700n;
        const req = request({ senderSats });
        req.senderInputs[0].value = senderSats;
        if (over.bitcoin) {
            delete req.senderInputs[0].assetPacket;
            delete req.params.assetId;
            delete req.assetUnits;
        }
        req.params.contribution = over.contribution ?? DUST;
        req.fare = { currency: "sats", units: over.fare ?? 10n };
        if (!over.legacy) req.satsFarePayer = "sender";
        return req;
    };

    const layout = (req: SponsoredBuildRequest): [string, bigint][] =>
        sponsoredPlan(req, cfg).valueOutputs.map((o) => [o.role, o.amount]);

    /** What Taxi keeps once the sponsorship it chose to give is set aside: the
     * fare and its own change, against the inventory it committed. */
    const netFareSats = (req: SponsoredBuildRequest): bigint =>
        sponsoredPlan(req, cfg)
            .valueOutputs.filter((o) => o.role !== "payment" && o.role !== "sender-change")
            .reduce((sum, o) => sum + o.amount, 0n) +
        req.params.contribution -
        req.funding.totalValue;

    it("takes the fare from the sender, so the service is actually paid", () => {
        const req = satsFare();
        expect(netFareSats(req)).toBe(10n);
        expect(layout(req)).toEqual([
            ["payment", 330n],
            ["operator-fare", 10n],
            ["sender-change", 690n],
            ["operator-change", 19_670n],
        ]);
    });

    it("collects nothing without the discriminator, as every funded graph did", () => {
        const req = satsFare({ legacy: true });
        expect(layout(req)).toEqual([
            ["payment", 330n],
            ["operator-fare", 10n],
            ["sender-change", 700n],
            ["operator-change", 19_660n],
        ]);
        expect(netFareSats(req)).toBe(0n);
    });

    it("charges the same way when the payment carries no asset", () => {
        const req = satsFare({ bitcoin: true, contribution: VTXO_MIN });
        expect(layout(req)).toEqual([
            ["payment", 330n],
            ["operator-fare", 10n],
            ["sender-change", 370n],
            ["operator-change", 19_990n],
        ]);
        expect(netFareSats(req)).toBe(10n);
        expect(netFareSats(satsFare({ bitcoin: true, contribution: VTXO_MIN, legacy: true }))).toBe(
            0n,
        );
    });

    it.each([10n, 50n, 100n])("never nets a %s sat fare out of the sponsorship", (fare) => {
        const req = satsFare({ fare });
        const amounts = new Map(layout(req));
        expect(amounts.get("payment")).toBe(req.params.dust);
        expect(amounts.get("operator-change")).toBe(
            req.funding.totalValue - req.params.contribution,
        );
        expect(amounts.get("sender-change")).toBe(req.senderSats - fare);
        expect(netFareSats(req)).toBe(fare);
    });

    it("refuses a sender whose change cannot cover the fare", () => {
        const req = satsFare({ bitcoin: true, senderSats: 5n, contribution: 325n });
        expect(() => sponsoredPlan(req, cfg)).toThrow(/sender funding/);
    });

    it("drops the sender change output when the fare consumes all of it", () => {
        const req = satsFare({ bitcoin: true, senderSats: 10n });
        expect(layout(req)).toEqual([
            ["payment", 330n],
            ["operator-fare", 10n],
            ["operator-change", 19_670n],
        ]);
        expect(netFareSats(req)).toBe(10n);
    });

    it.each(["zero", "asset"])("refuses a payer naming a %s fare", (kind) => {
        const req = satsFare();
        if (kind === "zero") req.fare = { currency: "sats", units: 0n };
        else req.fare = { currency: "asset", assetId: usdtInternal, units: 5n };
        expect(() => sponsoredPlan(req, cfg)).toThrow(/positive sats fare/);
    });

    it("refuses an unrecognised payer rather than falling back to the legacy layout", () => {
        const req = satsFare();
        (req as { satsFarePayer?: string }).satsFarePayer = "operator";
        expect(() => sponsoredPlan(req, cfg)).toThrow(/sats fare payer/);
    });

    it("carries the discriminator through the envelope it signs", () => {
        const req = satsFare();
        const encoded = buildSponsoredEnvelope(req, cfg, unroll);
        const wire = JSON.parse(Buffer.from(base64.decode(encoded)).toString());
        expect(wire.satsFarePayer).toBe("sender");
        expect(parseSponsoredEnvelope(encoded, req, cfg, unroll).unsignedTxId).toBe(
            wire.unsignedTxId,
        );
        expect(Transaction.fromPSBT(base64.decode(wire.arkTx)).getOutput(2).amount).toBe(690n);
        const legacy = buildSponsoredEnvelope(satsFare({ legacy: true }), cfg, unroll);
        expect(
            JSON.parse(Buffer.from(base64.decode(legacy)).toString()).satsFarePayer,
        ).toBeUndefined();
    });
});
