import { ArkAddress, VtxoScript, asset, type ExtendedVirtualCoin } from "@arkade-os/sdk";
import { bytesToHex } from "@arkade-taxi/protocol";
import { describe, expect, expectTypeOf, it } from "vitest";
import * as client from "../src/index.js";
import {
    args,
    assetArgs,
    info,
    jsonResponse,
    otherKey,
    params,
    quote,
    receiverKey,
    recordingFetch,
    senderTree,
    serverKey,
} from "./fixtures.js";

const coin = (): ExtendedVirtualCoin => ({
    txid: "aa".repeat(32),
    vout: 2,
    value: 10,
    status: { confirmed: true },
    createdAt: new Date(0),
    script: bytesToHex(senderTree.pkScript),
    isUnrolled: false,
    isSpent: false,
    isSwept: false,
    isPreconfirmed: false,
    virtualStatus: { state: "settled" },
    expiresAtHeight: 900_000,
    tapTree: senderTree.encode(),
    forfeitTapLeafScript: senderTree.leaves[0],
    intentTapLeafScript: senderTree.leaves[0],
});

describe("fundingInputsFromVtxos", () => {
    it("preserves selected outpoints, canonical leaves, assets and height expiry", () => {
        const selected = coin();
        const id = asset.AssetId.create("12".repeat(32), 7);
        selected.assets = [{ assetId: id.toString(), amount: 9_007_199_254_740_993n }];
        const [input] = client.fundingInputsFromVtxos([selected]);
        expect(input).toMatchObject({
            txid: "aa".repeat(32),
            vout: 2,
            value: 10n,
            tapTree: senderTree.encode(),
            spendLeaf: senderTree.scripts[0],
            expiry: { kind: "height", value: 900_000n },
        });
        const group = asset.Packet.fromBytes(input.assetPacket!).groups[0];
        expect(group.assetId?.toString()).toBe(id.toString());
        expect(group.outputs[0]).toMatchObject({ vout: 2, amount: 9_007_199_254_740_993n });
        expect(input.tapTree).not.toBe(selected.tapTree);
    });

    it("converts Date expiry to seconds and omits packets for bitcoin", () => {
        const selected = coin();
        delete selected.expiresAtHeight;
        selected.expiresAt = new Date("2100-01-01T00:00:00Z");
        const [input] = client.fundingInputsFromVtxos([selected]);
        expect(input.expiry).toEqual({ kind: "time", value: 4_102_444_800n });
        expect(input.assetPacket).toBeUndefined();
        expect(client.fundingInputsFromVtxos([])).toEqual([]);
    });

    it.each([
        { isSpent: true },
        { spentBy: "bb".repeat(32) },
        { isSwept: true },
        { isUnrolled: true },
        { virtualStatus: { state: "spent" as const } },
        { value: Number.MAX_SAFE_INTEGER + 1 },
        { value: 1.5 },
        { value: -1 },
        { txid: "bad" },
        { vout: -1 },
        { tapTree: new Uint8Array() },
        { expiresAtHeight: undefined },
        { expiresAtHeight: 0 },
        { expiresAt: new Date("2100-01-01") },
        { forfeitTapLeafScript: new VtxoScript([new Uint8Array([81])]).leaves[0] },
        { script: "00" },
        { assets: [{ assetId: "invalid", amount: 1n }] },
        { assets: [{ assetId: asset.AssetId.create("12".repeat(32), 0).toString(), amount: -1n }] },
    ])("rejects unusable or incomplete selected coin %#", (patch) => {
        expect(() => client.fundingInputsFromVtxos([{ ...coin(), ...patch }])).toThrow();
    });

    it("rejects duplicate selections", () => {
        expect(() => client.fundingInputsFromVtxos([coin(), coin()])).toThrow(/duplicate/i);
    });

    it("canonicalizes unordered asset balances without modifying the wallet", () => {
        const selected = coin();
        const ids = ["34", "12"].map((prefix) =>
            asset.AssetId.create(prefix.repeat(32), 0).toString(),
        );
        selected.assets = ids.map((assetId) => ({ assetId, amount: 1n }));
        const [input] = client.fundingInputsFromVtxos([selected]);
        expect(
            asset.Packet.fromBytes(input.assetPacket!).groups.map((group) =>
                group.assetId!.toString(),
            ),
        ).toEqual([...ids].sort());
        expect(selected.assets.map((holding) => holding.assetId)).toEqual(ids);
    });

    it("rejects a leaf with a forged control proof", () => {
        const selected = coin();
        selected.forfeitTapLeafScript = [
            { ...selected.forfeitTapLeafScript[0], internalKey: otherKey },
            selected.forfeitTapLeafScript[1],
        ];
        expect(() => client.fundingInputsFromVtxos([selected])).toThrow(/proof/i);
    });
});

const request = (a = args()): client.RequestVerifiedQuoteArgs => ({
    receiverAddress: new ArkAddress(serverKey, receiverKey, "ark").encode(),
    senderKey: a.expect.senderKey,
    selectedVtxos: [coin()],
    assetId: a.expect.assetId,
    assetUnits: a.assetUnits,
    expect: {
        maxTopupSats: a.expect.maxTopupSats,
        maxFare: a.expect.maxFare,
        minLocktime: a.expect.minLocktime,
    },
    trustedServerKey: a.trustedServerKey,
    trustedEmulatorKey: a.trustedEmulatorKey,
    trustedServerUnrollScript: a.trustedServerUnrollScript,
    vtxoMinAmount: a.vtxoMinAmount,
    hrp: a.hrp,
    now: a.now,
});

const transport = (a = args()) => {
    const fetch = recordingFetch((url) =>
        jsonResponse(200, url.endsWith("/info") ? info() : a.quote),
    );
    return { taxi: new client.TaxiClient({ baseUrl: "https://taxi.example", fetch }), fetch };
};

describe("requestVerifiedQuote", () => {
    it("derives the address key and returns a verified graph after one info and quote request", async () => {
        const { taxi, fetch } = transport();
        const result = await taxi.requestVerifiedQuote(request());
        expect(result.verified.params.receiverKey).toEqual(receiverKey);
        expect(result.verified.senderInputIndexes).toEqual([0]);
        expect(result.senderInputs).toEqual(args().senderInputs);
        expect(fetch.calls.map((c) => [c.init.method, new URL(c.url).pathname])).toEqual([
            ["GET", "/v1/info"],
            ["POST", "/v1/transfers"],
        ]);
        expect(JSON.parse(String(fetch.calls[1].init.body))).toMatchObject({
            receiverKey: bytesToHex(receiverKey),
            senderSats: "10",
        });
    });

    it.each(["canonical", "network", "server"])(
        "rejects wrong receiver address %s before networking",
        async (kind) => {
            const r = request();
            if (kind === "canonical") r.receiverAddress = r.receiverAddress.toUpperCase();
            if (kind === "network")
                r.receiverAddress = new ArkAddress(serverKey, receiverKey, "tark").encode();
            if (kind === "server")
                r.receiverAddress = new ArkAddress(otherKey, receiverKey, "ark").encode();
            const { taxi, fetch } = transport();
            await expect(taxi.requestVerifiedQuote(r)).rejects.toThrow();
            expect(fetch.calls).toHaveLength(0);
        },
    );

    it.each([
        "emulator",
        "server",
        "unroll",
        "receiver",
        "sender",
        "topup",
        "fare",
        "currency",
        "locktime",
        "amount",
        "expiry",
    ])("applies explicit %s verification", async (kind) => {
        const r = request();
        if (kind === "emulator") r.trustedEmulatorKey = otherKey;
        if (kind === "server") r.trustedServerKey = otherKey;
        if (kind === "unroll") r.trustedServerUnrollScript = new Uint8Array([81]);
        if (kind === "receiver")
            r.receiverAddress = new ArkAddress(serverKey, otherKey, "ark").encode();
        if (kind === "sender") r.senderKey = otherKey;
        if (kind === "topup") r.expect.maxTopupSats = 329n;
        if (kind === "fare") r.expect.maxFare.units = 9n;
        if (kind === "currency") r.expect.maxFare = { currency: "asset", units: 10n };
        if (kind === "locktime") r.expect.minLocktime = 800_001n;
        if (kind === "amount") r.selectedVtxos[0].value = 9;
        if (kind === "expiry") r.now = 1_000_000_060;
        await expect(transport().taxi.requestVerifiedQuote(r)).rejects.toThrow();
    });

    it("preserves exact asset amounts and rejects a changed requested amount", async () => {
        const a = assetArgs();
        const r = request(a);
        r.selectedVtxos[0].value = 700;
        r.selectedVtxos[0].assets = [
            {
                assetId: asset.AssetId.create("12".repeat(32), 7).toString(),
                amount: a.assetUnits! + 22n,
            },
        ];
        const result = await transport(a).taxi.requestVerifiedQuote(r);
        expect(result.verified.params.assetId).toEqual(a.expect.assetId);
        r.assetUnits = a.assetUnits! - 1n;
        await expect(transport(a).taxi.requestVerifiedQuote(r)).rejects.toThrow();
    });

    it("verifies asset fare identity and ceiling and preserves the selected offer", async () => {
        const a = assetArgs();
        const fare = { currency: "asset" as const, assetId: a.expect.assetId!, units: 22n };
        a.quote = quote(
            { ...params(), assetId: a.expect.assetId },
            {
                senderInputs: a.senderInputs,
                senderSats: a.senderSats,
                assetUnits: a.assetUnits,
                fare,
            },
        );
        const r = request(a);
        r.fareId = "usdt-purchase";
        r.expect.maxFare = fare;
        r.selectedVtxos[0].value = 700;
        r.selectedVtxos[0].assets = [
            {
                assetId: asset.AssetId.create("12".repeat(32), 7).toString(),
                amount: a.assetUnits! + 22n,
            },
        ];
        const { taxi, fetch } = transport(a);
        expect((await taxi.requestVerifiedQuote(r)).verified.quote.fare.units).toBe("22");
        expect(JSON.parse(String(fetch.calls[1].init.body)).fareId).toBe("usdt-purchase");
        r.expect.maxFare = { ...fare, assetId: { txid: otherKey, groupIndex: 7 } };
        await expect(transport(a).taxi.requestVerifiedQuote(r)).rejects.toMatchObject({
            code: "FEE_ABOVE_MAX",
        });
        r.expect.maxFare = { ...fare, units: 21n };
        await expect(transport(a).taxi.requestVerifiedQuote(r)).rejects.toMatchObject({
            code: "FEE_ABOVE_MAX",
        });
    });

    it("snapshots funding and authorization before the first network wait", async () => {
        const r = request();
        r.trustedEmulatorKey = Uint8Array.from(r.trustedEmulatorKey);
        const a = args();
        const fetch = recordingFetch((url) => {
            r.selectedVtxos[0].value = 1;
            r.expect.maxFare.units = 0n;
            r.trustedEmulatorKey.fill(0);
            return jsonResponse(200, url.endsWith("/info") ? a.info : a.quote);
        });
        const taxi = new client.TaxiClient({ baseUrl: "https://taxi.example", fetch });
        const result = await taxi.requestVerifiedQuote(r);
        expect(result.senderInputs[0].value).toBe(10n);
        expect(JSON.parse(String(fetch.calls[1].init.body)).senderSats).toBe("10");
    });

    it.each([
        { values: [10, 20], total: 30n },
        { values: [Number.MAX_SAFE_INTEGER, 2], total: 9_007_199_254_740_993n },
    ])("derives and verifies the exact selected total $total", async ({ values, total }) => {
        expectTypeOf<client.RequestVerifiedQuoteArgs>().not.toHaveProperty("senderSats");
        const r = request();
        r.selectedVtxos = values.map((value, vout) => ({ ...coin(), value, vout }));
        const senderInputs = client.fundingInputsFromVtxos(r.selectedVtxos);
        const a = args();
        a.quote = quote(params(), { senderInputs, senderSats: total });
        Object.assign(r, { senderSats: 0n });
        const { taxi, fetch } = transport(a);
        const result = await taxi.requestVerifiedQuote(r);
        expect(result.senderInputs.reduce((sum, input) => sum + input.value, 0n)).toBe(total);
        expect(result.verified.senderInputIndexes).toEqual([0, 1]);
        expect(JSON.parse(String(fetch.calls[1].init.body)).senderSats).toBe(total.toString());
    });
});
