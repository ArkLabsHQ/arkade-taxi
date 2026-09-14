import { beforeEach, describe, expect, it } from "vitest";
import { ArkAddress, SingleKey, Transaction, asset } from "@arkade-os/sdk";
import { base64 } from "@scure/base";
import { bytesToHex } from "@arkade-taxi/protocol";
import type { ServiceError } from "../src/errors.js";
import { getTransfer, submitLockup, type QuoteDeps } from "../src/quotes.js";
import {
    createSponsoredQuote,
    FakeSponsoredLockupBuilder,
    type SponsoredQuoteDeps,
} from "../src/sponsoredQuotes.js";
import { listReceiverClaims } from "../src/claims.js";
import { decodeLockupEnvelope, encodeLockupEnvelope } from "../src/arkade/psbt.js";
import {
    config,
    DUST,
    fundingCoin,
    MemoryAdvances,
    NOW,
    policy as basePolicy,
    receiverKey,
    registerSenderCoin,
    senderKey,
    serverKey,
    quoteInfrastructure,
    serverUnroll,
} from "./fixtures.js";
import { senderTree } from "./arkade/lockupFixtures.js";
import type { Policy } from "@arkade-taxi/core";

const USDT_DISPLAY = "1234".repeat(16);
const USDT_INTERNAL = Buffer.from(USDT_DISPLAY, "hex").reverse().toString("hex");
const USDT = { txid: USDT_INTERNAL, groupIndex: 0 };
const receiverAddress = new ArkAddress(serverKey, receiverKey, "ark").encode();

let advances: MemoryAdvances;
let sponsoredBuilder: FakeSponsoredLockupBuilder;
let ids: number;

const usdtPolicy = (): Policy =>
    basePolicy({
        assetRules: [
            {
                assetId: {
                    txid: Uint8Array.from(Buffer.from(USDT_DISPLAY, "hex")).reverse(),
                    groupIndex: 0,
                },
                enabled: true,
                claim: "either",
                maxTopupSats: null,
                fares: [
                    {
                        id: "usdt-fare",
                        currency: { kind: "sameAsset" },
                        pricing: { kind: "flat", units: 1_000_000n },
                    },
                ],
            },
        ],
    });

const deps = (
    over: { policy?: Policy } = {},
): SponsoredQuoteDeps & Pick<QuoteDeps, "lockupSubmitter"> => ({
    ...quoteInfrastructure(advances, () => over.policy ?? usdtPolicy()),
    advances,
    config: config(),
    now: () => NOW,
    randomId: () => `adv-${++ids}`,
    inventory: {
        getSpendableVtxos: async () => [
            fundingCoin(),
            fundingCoin({ vout: 1, expiresAtHeight: 900001 }),
        ],
        getLockedVtxoOutpoints: async () => [],
    },
    sponsoredBuilder,
    lockupSubmitter: sponsoredBuilder,
});

const sponsoredBody = (over: Record<string, unknown> = {}) => {
    const senderSats = (over.senderSats as string | undefined) ?? "1000";
    const txid = "ab".repeat(32);
    const vout = 2;
    registerSenderCoin(
        txid,
        vout,
        fundingCoin({
            txid,
            vout,
            value: Number(senderSats),
            script: bytesToHex(senderTree.pkScript),
            expiresAtHeight: 910000,
            assets: [
                {
                    assetId: asset.AssetId.create(USDT_DISPLAY, 0).toString(),
                    amount: 201_000_000n,
                },
            ],
        }),
    );
    return {
        receiverAddress,
        senderKey: bytesToHex(senderKey),
        senderSats,
        senderInputs: [
            {
                txid,
                vout,
                value: senderSats,
                tapTree: bytesToHex(senderTree.encode()),
                spendLeaf: bytesToHex(senderTree.scripts[0]),
                expiry: { kind: "height", value: "910000" },
                assetPacket: asset.Packet.create([
                    asset.AssetGroup.create(
                        asset.AssetId.create(USDT_DISPLAY, 0),
                        null,
                        [],
                        [asset.AssetOutput.create(vout, 201_000_000n)],
                        [],
                    ),
                ]).toString(),
            },
        ],
        assetId: USDT,
        assetUnits: "200000000",
        fareId: "usdt-fare",
        ...over,
    };
};

const caught = async (fn: () => Promise<unknown>): Promise<ServiceError> => {
    try {
        await fn();
    } catch (e) {
        return e as ServiceError;
    }
    throw new Error("expected a rejection");
};

beforeEach(() => {
    advances = new MemoryAdvances();
    sponsoredBuilder = new FakeSponsoredLockupBuilder(config(), serverUnroll);
    ids = 0;
});

describe("createSponsoredQuote", () => {
    it("quotes a 200 USDT direct payment with a 1 USDT fare", async () => {
        const quote = await createSponsoredQuote(deps(), sponsoredBody());
        expect(quote.transferId).toBe("adv-1");
        expect(quote.receiverAddress).toBe(receiverAddress);
        expect(quote.params).toMatchObject({
            dust: DUST.toString(),
            contribution: "10",
        });
        expect(quote.fare).toMatchObject({ currency: "asset", units: "1000000" });
        expect(quote.commitment).toMatchObject({
            covenantOutputIndex: 0,
            senderInputIndexes: [0],
            operatorInputIndexes: [1],
        });
        const envelope = decodeLockupEnvelope(quote.unsignedSponsoredTx);
        expect(envelope.unsignedTxId).toBe(quote.commitment.unsignedTxId);
        const stored = advances.get("adv-1");
        expect(stored).toMatchObject({ kind: "sponsored", state: "quoted", locktime: 0n });
        expect(stored?.covenantAddress).toBe(receiverAddress);
    });

    it("rejects a receiver address outside this service", async () => {
        const bad = await caught(() =>
            createSponsoredQuote(deps(), sponsoredBody({ receiverAddress: "ark1qwrong" })),
        );
        expect(bad.status).toBe(400);
        const wrongNetwork = await caught(() =>
            createSponsoredQuote(
                deps(),
                sponsoredBody({
                    receiverAddress: new ArkAddress(serverKey, receiverKey, "tark").encode(),
                }),
            ),
        );
        expect(wrongNetwork.status).toBe(400);
    });

    it("rejects an asset the operator does not serve", async () => {
        const bad = await caught(() =>
            createSponsoredQuote(
                deps({ policy: basePolicy() }),
                sponsoredBody({
                    assetId: { txid: "99".repeat(32), groupIndex: 0 },
                }),
            ),
        );
        expect(bad.message).toMatch(/asset/i);
    });

    it("locks a signed sponsored payment and reports its status", async () => {
        const d = deps();
        const quote = await createSponsoredQuote(d, sponsoredBody());
        const envelope = decodeLockupEnvelope(quote.unsignedSponsoredTx);
        const sender = SingleKey.fromPrivateKey(new Uint8Array(32).fill(2));
        const signed = await sender.sign(
            Transaction.fromPSBT(base64.decode(envelope.arkTx)),
            envelope.senderInputIndexes,
        );
        const checkpoints: string[] = [];
        for (const [index, checkpoint] of envelope.checkpoints.entries()) {
            const tx = Transaction.fromPSBT(base64.decode(checkpoint));
            checkpoints.push(
                base64.encode(
                    (envelope.senderInputIndexes.includes(index)
                        ? await sender.sign(tx, [0])
                        : tx
                    ).toPSBT(),
                ),
            );
        }
        const out = await submitLockup(
            d as unknown as QuoteDeps,
            quote.transferId,
            encodeLockupEnvelope({
                ...envelope,
                arkTx: base64.encode(signed.toPSBT()),
                checkpoints,
            }),
        );
        expect(out.outpoint).toMatchObject({ vout: 0 });
        expect(getTransfer({ advances }, quote.transferId).state).toBe("locking");
        expect(advances.get(quote.transferId)).toMatchObject({ kind: "sponsored" });
    });

    it("keeps sponsored transfers out of receiver claims", async () => {
        await createSponsoredQuote(deps(), sponsoredBody());
        const stored = advances.get("adv-1")!;
        advances.update({ ...stored, state: "locked" });
        const claims = listReceiverClaims(
            { config: config(), advances },
            { addresses: [receiverAddress], receiverKeys: [receiverKey] },
            ["locking", "locked", "recovering"],
        );
        expect(claims).toEqual([]);
    });
});
