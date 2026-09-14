import { expect } from "vitest";
import { ArkAddress, Extension, Transaction, asset, selectCoinsWithAsset } from "@arkade-os/sdk";
import { signSponsoredPayment } from "@arkade-taxi/client";
import { base64, hex } from "@scure/base";
import { preEffectRequest } from "./admission.js";
import { liveScenario } from "./scenarios.js";
import { admin, expectReceipt, openLive, poll, required, walletBalance } from "./fixtures.js";

const assetOutputs = (tx: Transaction, assetId: string) => {
    const packet = Extension.fromTx(tx).getAssetPacket()!;
    expect(packet.groups).toHaveLength(1);
    expect(packet.groups[0]!.assetId!.toString()).toBe(assetId);
    return packet.groups[0]!.outputs.map((output) => [output.vout, output.amount]);
};

liveScenario("sponsored-direct-send", async () => {
    const live = await openLive();
    try {
        const alice = live.actors.sender;
        const bob = live.actors.emptyReceiver;
        const receiverAddress = await bob.wallet.getAddress();
        const destination = ArkAddress.decode(receiverAddress).pkScript;
        const authorizedUnits = 201_000_000n;
        const minted = await alice.wallet.assetManager.issue({
            amount: authorizedUnits,
            metadata: { decimals: 6, name: "Taxi Regtest USDT", ticker: "USDT" },
        });
        await poll(
            "indexed regtest USDT issuance",
            () => walletBalance(alice, minted.assetId),
            (balance) => balance.units === authorizedUnits,
        );
        const fundingTxid = await alice.wallet.send({
            address: await alice.wallet.getAddress(),
            amount: 1000,
            assets: [{ assetId: minted.assetId, amount: authorizedUnits }],
        });
        const available = await poll(
            "exact asset-only sender funding",
            () => alice.wallet.getSpendableVtxos({ withRecoverable: false }),
            (coins) => coins.some((coin) => coin.txid === fundingTxid && coin.value === 1000),
        );
        const { selected } = selectCoinsWithAsset(available, minted.assetId, authorizedUnits);
        expect(selected).toHaveLength(1);
        const id = asset.AssetId.fromString(minted.assetId);
        const assetId = { txid: Uint8Array.from(id.txid).reverse(), groupIndex: id.groupIndex };
        const wireAssetId = { txid: hex.encode(assetId.txid), groupIndex: assetId.groupIndex };
        await admin("policy", {
            assetRules: [
                {
                    assetId: wireAssetId,
                    enabled: true,
                    fares: [
                        {
                            id: "sponsored-usdt",
                            currency: { kind: "sameAsset" },
                            pricing: { kind: "flat", units: "1000000" },
                        },
                    ],
                    claim: "either",
                    maxTopupSats: null,
                },
            ],
        });
        const [aliceBefore, bobBefore, operatorBefore] = await Promise.all([
            walletBalance(alice, minted.assetId),
            walletBalance(bob, minted.assetId),
            walletBalance(live.actors.operator, minted.assetId),
        ]);
        expect(bobBefore.units).toBe(0n);
        const { verified, senderInputs } = await preEffectRequest(
            () =>
                live.client.requestVerifiedSponsoredQuote({
                    receiverAddress,
                    senderKey: hex.decode(live.fixture.sender.pubkey),
                    selectedVtxos: selected,
                    assetId,
                    assetUnits: 200_000_000n,
                    fareId: "sponsored-usdt",
                    trustedServerKey: hex.decode(live.info.serverKey),
                    trustedServerUnrollScript: live.unroll.script,
                    vtxoMinAmount: 1n,
                    hrp: "tark",
                    expect: {
                        maxContributionSats: 1n,
                        maxFare: { currency: "asset", assetId, units: 1_000_000n },
                    },
                }),
            {
                readyUrl: `${required("TAXI_E2E_BASE_URL")}/ready`,
                expiresAt: Date.now() / 1000 + 10,
            },
        );
        const quote = verified.quote;
        expect(senderInputs).toHaveLength(1);
        expect(quote.params).toMatchObject({
            dust: "330",
            contribution: "1",
            assetId: wireAssetId,
        });
        expect(quote.fare).toEqual({
            currency: "asset",
            assetId: wireAssetId,
            units: "1000000",
        });
        expect(quote.commitment).toMatchObject({
            paymentOutputIndex: 0,
            senderInputIndexes: [0],
            operatorInputIndexes: [1],
        });
        expect(verified.envelope.assetUnits).toBe("200000000");
        const unsigned = Transaction.fromPSBT(base64.decode(verified.envelope.arkTx));
        expect(unsigned.getOutput(0)).toMatchObject({ amount: 330n, script: destination });
        expect(assetOutputs(unsigned, minted.assetId)).toEqual([
            [0, 200_000_000n],
            [1, 1_000_000n],
        ]);
        expectReceipt(unsigned, 1, 1n, live.info.operatorKey);
        expect(unsigned.getOutput(2).amount).toBe(671n);
        const signed = await signSponsoredPayment({ verified, identity: alice.identity });
        const lockup = await preEffectRequest(
            () => live.client.submitSponsoredLockup(verified, signed),
            { readyUrl: `${required("TAXI_E2E_BASE_URL")}/ready`, expiresAt: quote.expiresAt },
            async () => {
                const state = await live.client.sponsoredStatus(quote.transferId);
                if (
                    state.transferId !== quote.transferId ||
                    state.state !== "quoted" ||
                    state.submissionPhase !== undefined ||
                    state.outpoint !== undefined ||
                    state.spentTxid !== undefined ||
                    state.failureCode !== undefined ||
                    state.failureDetail !== undefined
                )
                    throw new Error(
                        "transfer is not an unchanged quoted advance without submission effects",
                    );
            },
        );
        expect(lockup.outpoint.vout).toBe(0);
        // Witness data does not affect the txid, so the accepted joint
        // transaction is the quoted one: payment at 0, fare at 1, change at 2.
        expect(lockup.outpoint.txid).toBe(unsigned.id);
        const settled = await poll(
            "sponsored payment observation",
            () => live.client.sponsoredStatus(quote.transferId),
            (state) => state.state === "locked",
        );
        expect(settled.outpoint).toEqual(lockup.outpoint);
        expect(await live.client.listClaims({ receiverAddresses: [receiverAddress] })).toEqual({
            claims: [],
        });
        expect(
            await poll(
                "receiver financial effect",
                () => walletBalance(bob, minted.assetId),
                (value) => value.sats === bobBefore.sats + 330n && value.units === 200_000_000n,
            ),
        ).toEqual({ sats: bobBefore.sats + 330n, units: 200_000_000n });
        expect(await walletBalance(alice, minted.assetId)).toEqual({
            sats: aliceBefore.sats - 329n,
            units: 0n,
        });
        // The 1 USDT fare output is subdust-hosted, so like a covenant
        // purchase fare it never enters the operator wallet balance: the
        // operator's wallet effect is exactly the fronted contribution and
        // the fare hosting. The fare itself is proven by the accepted joint
        // transaction asserted above (output 1: 1 sat + 1M USDT to Taxi).
        expect(
            await poll(
                "operator financial effect",
                () => walletBalance(live.actors.operator, minted.assetId),
                (value) =>
                    value.sats === operatorBefore.sats - 2n && value.units === operatorBefore.units,
            ),
        ).toEqual({ sats: operatorBefore.sats - 2n, units: operatorBefore.units });
    } finally {
        await live.close();
    }
});
