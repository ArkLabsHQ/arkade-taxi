import { describe, expect, it } from "vitest";
import { ArkAddress, Extension, Transaction, asset } from "@arkade-os/sdk";
import { base64 } from "@scure/base";
import {
    buildSponsoredEnvelope,
    parseSponsoredEnvelope,
    sponsoredGraphId,
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
