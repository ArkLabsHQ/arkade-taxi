import {
    asset,
    CSVMultisigTapscript,
    MultisigTapscript,
    SingleKey,
    VtxoScript,
} from "@arkade-os/sdk";
import { buildLockupEnvelope } from "../../app/src/arkade/lockupBuilder.js";
import { decodeLockupEnvelope } from "../../app/src/arkade/psbt.js";
import { config, fundingCoin } from "../../app/test/fixtures.js";
import { DustCovenantScript, type DustCovenantParams } from "@arkade-taxi/covenant";
import { bytesToHex, quoteParamsToWire, type FundingInputValue } from "@arkade-taxi/protocol";
import type { InfoResponse, QuoteResponse } from "@arkade-taxi/protocol";
import type { VerifyQuoteArgs } from "../src/verify.js";

type FareSpec =
    | { currency: "sats"; units: bigint }
    | {
          currency: "asset";
          units: bigint;
          assetId: { txid: Uint8Array; groupIndex: number };
      };

// Real curve points: computeArkadeScriptPublicKey lifts the emulator key to do
// point addition, so 32 arbitrary bytes fail with "cannot find square root".
const xonly = (fill: number) =>
    SingleKey.fromPrivateKey(new Uint8Array(32).fill(fill)).xOnlyPublicKey();

export const receiverKey = await xonly(1);
export const senderKey = await xonly(2);
export const operatorKey = await xonly(3);
export const serverKey = await xonly(4);
export const emulatorKey = await xonly(5);
export const otherKey = await xonly(6);

export const HRP = "ark";
export const VTXO_MIN = 10n;
export const NOW = 1_000_000_000;
export const senderIdentity = SingleKey.fromPrivateKey(new Uint8Array(32).fill(2));
export const operatorIdentity = SingleKey.fromPrivateKey(new Uint8Array(32).fill(3));
export const senderTree = new VtxoScript([
    MultisigTapscript.encode({ pubkeys: [serverKey, senderKey] }).script,
]);
export const unroll = CSVMultisigTapscript.encode({
    pubkeys: [serverKey],
    timelock: { type: "blocks", value: 144n },
});
export const fundingInputs = (): FundingInputValue[] => [
    {
        txid: "aa".repeat(32),
        vout: 2,
        value: 10n,
        tapTree: senderTree.encode(),
        spendLeaf: senderTree.scripts[0],
        expiry: { kind: "height", value: 900_000n },
    },
];

export const params = (): DustCovenantParams => ({
    receiverKey,
    senderKey,
    operatorKey,
    dust: 330n,
    topup: 330n,
    locktime: 800_000n,
});

export const addressFor = (
    p: DustCovenantParams,
    keys: { serverKey: Uint8Array; emulatorKey: Uint8Array } = { serverKey, emulatorKey },
): string =>
    new DustCovenantScript({ ...keys, params: p, vtxoMinAmount: VTXO_MIN })
        .address(HRP, keys.serverKey)
        .encode();

export const info = (): InfoResponse => ({
    protocolVersion: 1,
    operatorKey: bytesToHex(operatorKey),
    serverKey: bytesToHex(serverKey),
    emulatorKey: bytesToHex(emulatorKey),
    arkdUrl: "https://arkd.example",
    emulatorUrl: "https://emulator.example",
    dust: "330",
    vtxoMinAmount: "10",
    assetRules: [],
    maxPerPaymentTopupSats: "1000",
    paused: false,
});

interface QuoteFixtureOptions {
    senderInputs?: FundingInputValue[];
    senderSats?: bigint;
    assetUnits?: bigint;
    fare?: FareSpec;
    serverUnrollScript?: CSVMultisigTapscript.Type;
}

export const quote = (p = params(), opts: QuoteFixtureOptions = {}): QuoteResponse => {
    const senderInputs = opts.senderInputs ?? fundingInputs();
    const senderSats =
        opts.senderSats ?? senderInputs.reduce((sum, input) => sum + input.value, 0n);
    const fare = opts.fare ?? { currency: "sats", units: 10n };
    const unsignedLockupTx = buildLockupEnvelope(
        {
            senderInputs,
            senderSats,
            funding: {
                inputs: [fundingCoin()],
                totalValue: 20_000n,
                batchExpiry: { kind: "height", value: 900_000n },
            },
            params: p,
            covenantAddress: addressFor(p),
            advanceId: "tr_01",
            fare,
            ...(opts.assetUnits !== undefined ? { assetUnits: opts.assetUnits } : {}),
        },
        config(),
        opts.serverUnrollScript ?? unroll,
    );
    const envelope = decodeLockupEnvelope(unsignedLockupTx);
    return {
        transferId: "tr_01",
        params: quoteParamsToWire(p),
        covenantAddress: addressFor(p),
        fare:
            fare.currency === "asset"
                ? {
                      currency: "asset",
                      units: fare.units.toString(),
                      assetId: {
                          txid: bytesToHex(fare.assetId.txid),
                          groupIndex: fare.assetId.groupIndex,
                      },
                  }
                : { currency: "sats", units: fare.units.toString() },
        expiresAt: NOW + 60,
        unsignedLockupTx,
        lockup: {
            covenantOutputIndex: 0,
            senderInputIndexes: senderInputs.map((_, i) => i),
            operatorInputIndexes: [senderInputs.length],
            unsignedTxId: envelope.unsignedTxId,
        },
    };
};

export const args = (): VerifyQuoteArgs => ({
    quote: quote(),
    info: info(),
    expect: {
        receiverKey,
        senderKey,
        maxTopupSats: 330n,
        maxFare: { currency: "sats" as const, units: 10n },
        minLocktime: 700_000n,
    },
    trustedServerKey: serverKey,
    trustedEmulatorKey: emulatorKey,
    vtxoMinAmount: VTXO_MIN,
    hrp: HRP,
    now: NOW,
    senderInputs: fundingInputs(),
    senderSats: 10n,
    trustedServerUnrollScript: unroll.script,
});

export const assetArgs = (): VerifyQuoteArgs => {
    const id = asset.AssetId.create("12".repeat(32), 7);
    const assetId = { txid: Uint8Array.from(id.txid).reverse(), groupIndex: id.groupIndex };
    const assetUnits = 9_007_199_254_740_993n;
    const senderInputs = fundingInputs();
    senderInputs[0] = {
        ...senderInputs[0],
        value: 700n,
        assetPacket: asset.Packet.create([
            asset.AssetGroup.create(
                id,
                null,
                [],
                [asset.AssetOutput.create(senderInputs[0].vout, assetUnits + 22n)],
                [],
            ),
        ]).serialize(),
    };
    const p = { ...params(), assetId };
    const a = args();
    return {
        ...a,
        quote: quote(p, { senderInputs, senderSats: 700n, assetUnits }),
        expect: { ...a.expect, assetId },
        senderInputs,
        senderSats: 700n,
        assetUnits,
    };
};

export const jsonResponse = (status: number, body: unknown): Response =>
    new Response(JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json" },
    });

export type FetchCall = { url: string; init: RequestInit };

export function recordingFetch(
    reply: (url: string, init: RequestInit) => Response | Promise<Response>,
): typeof fetch & { calls: FetchCall[] } {
    const calls: FetchCall[] = [];
    const fn = async (input: unknown, init: RequestInit = {}) => {
        calls.push({ url: String(input), init });
        return reply(String(input), init);
    };
    return Object.assign(fn as unknown as typeof fetch, { calls });
}
