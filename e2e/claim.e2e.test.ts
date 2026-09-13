import { expect } from "vitest";
import { writeFileSync } from "node:fs";
import {
    ArkAddress,
    Extension,
    Transaction,
    VtxoScript,
    asset,
    selectCoinsWithAsset,
} from "@arkade-os/sdk";
import { TaxiClient } from "@arkade-taxi/client";
import type { ClaimsSnapshotResponse, ReceiverClaimWire } from "@arkade-taxi/protocol";
import { base64, hex } from "@scure/base";
import { assertArtifactSafe } from "../scripts/lib/harness.mjs";
import { ownCleanup } from "../scripts/lib/scenario-cleanup.mjs";
import { preEffectRequest, submitWithReadiness } from "./admission.js";
import { liveScenario } from "./scenarios.js";
import {
    admin,
    control,
    expectReceipt,
    fundingOf,
    holdings,
    lock,
    openLive,
    poll,
    quoteFor,
    required,
    sizedSender,
    terminal,
    transaction,
    walletBalance,
} from "./fixtures.js";

async function claim(receiverName: string, withAsset: boolean, mode: "recycle" | "purchase") {
    const live = await openLive();
    try {
        const receiver = live.actors[receiverName];
        if (!withAsset) {
            const txid = await live.actors.sender.wallet.send({
                address: await receiver.wallet.getAddress(),
                amount: 1000,
            });
            await poll(
                "fresh receiver sats",
                () => receiver.wallet.getSpendableVtxos({ withRecoverable: false }),
                (coins: any[]) => coins.some((coin) => coin.txid === txid && coin.value === 1000),
            );
        }
        const before = await walletBalance(receiver, live.fixture.asset.assetId);
        if (receiverName === "receiverWithAsset") expect(before.units).toBe(1000n);
        else if (withAsset) expect(before.units).toBe(0n);
        const inventory = await receiver.wallet.getSpendableVtxos({ withRecoverable: false });
        if (mode === "purchase") expect(inventory).toHaveLength(0);
        else expect(inventory.length).toBeGreaterThan(0);
        const coin = await sizedSender(live, withAsset);
        const senderBefore = await walletBalance(live.actors.sender, live.fixture.asset.assetId);
        const operatorBefore = await walletBalance(
            live.actors.operator,
            live.fixture.asset.assetId,
        );
        const locked = await lock(live, await quoteFor(live, receiverName, coin, withAsset));
        let txid: string;
        if (mode === "purchase")
            txid = await live.client.purchase(locked.transfer, locked.destination);
        else {
            const receiverCoin = inventory.find((item: any) =>
                receiverName === "receiverWithAsset" ? item.assets?.length : !item.assets?.length,
            );
            if (!receiverCoin) throw new Error("the receiver has no input matching this scenario");
            const funding = fundingOf(receiverCoin);
            txid = await live.client.recycle(
                locked.transfer,
                {
                    input: {
                        txid: receiverCoin.txid,
                        vout: receiverCoin.vout,
                        value: BigInt(receiverCoin.value),
                        tapTree: receiverCoin.tapTree,
                        tapLeafScript: receiverCoin.forfeitTapLeafScript,
                        ...(holdings(receiverCoin) ? { assetPacket: holdings(receiverCoin) } : {}),
                    },
                    expiry: funding.expiry,
                    identity: receiver.identity,
                },
                locked.destination,
            );
        }
        const { tx } = await terminal(
            live,
            locked,
            mode === "purchase" ? "purchased" : "recycled",
            txid,
        );
        expect(tx.inputsLength).toBe(mode === "purchase" ? 1 : 2);
        if (mode === "recycle") expectReceipt(tx, 0, 1n, live.info.operatorKey);
        const expected = {
            sats: before.sats + (mode === "purchase" ? 330n : 329n),
            units: before.units + (withAsset ? 100n : 0n),
        };
        expect(
            await poll(
                "receiver financial effect",
                () => walletBalance(receiver, live.fixture.asset.assetId),
                (value) => value.sats === expected.sats && value.units === expected.units,
            ),
        ).toEqual(expected);
        expect(await walletBalance(live.actors.sender, live.fixture.asset.assetId)).toEqual({
            sats: senderBefore.sats - 329n,
            units: senderBefore.units - (withAsset ? 100n : 0n),
        });
        const expectedOperator = {
            sats: operatorBefore.sats - (mode === "purchase" ? 1n : 0n),
            units: operatorBefore.units,
        };
        expect(
            await poll(
                "spendable operator proceeds",
                () => walletBalance(live.actors.operator, live.fixture.asset.assetId),
                (balance) =>
                    balance.sats === expectedOperator.sats &&
                    balance.units === expectedOperator.units,
            ),
        ).toEqual(expectedOperator);
    } finally {
        await live.close();
    }
}

liveScenario("asset-recycle-receiver-holds-asset", () =>
    claim("receiverWithAsset", true, "recycle"),
);
liveScenario("asset-recycle-receiver-holds-no-asset", () => claim("receiverSats", true, "recycle"));
liveScenario("purchase-receiver-holds-no-vtxo", () => claim("emptyReceiver", true, "purchase"));
liveScenario("subdust-bitcoin-recycle", () => claim("receiverSats", false, "recycle"));

const assetOutputs = (tx: Transaction, assetId: string) => {
    const packet = Extension.fromTx(tx).getAssetPacket()!;
    expect(packet.groups).toHaveLength(1);
    expect(packet.groups[0]!.assetId!.toString()).toBe(assetId);
    return packet.groups[0]!.outputs.map((output) => [output.vout, output.amount]);
};

async function receiverSseClaim(mode: "recycle" | "purchase") {
    const live = await openLive();
    const alice = live.actors.sender;
    const bob = live.actors[mode === "recycle" ? "receiverSats" : "emptyReceiver"];
    const receiverAddress = await bob.wallet.getAddress();
    const destination = ArkAddress.decode(receiverAddress).pkScript;
    const operatorAddress = ArkAddress.decode(await live.actors.operator.wallet.getAddress());
    expect(hex.encode(operatorAddress.vtxoTaprootKey)).toBe(live.info.operatorKey);
    expect(live.info.operatorKey).not.toBe(live.fixture.operator.pubkey);
    const receiverAddresses = [
        receiverAddress,
        await live.actors.receiverWithAsset.wallet.getAddress(),
    ];
    expect(new Set(receiverAddresses).size).toBe(2);
    const inbox = new TaxiClient({ baseUrl: required("TAXI_E2E_BASE_URL") });
    const snapshots: ClaimsSnapshotResponse[] = [];
    const changes: ReceiverClaimWire[] = [];
    const errors: unknown[] = [];
    const unsubscribe = inbox.subscribeClaims({
        receiverAddresses,
        onSnapshot: (snapshot) => snapshots.push(snapshot),
        onChanged: (event) => changes.push(...event.claims),
        onError: (error) => errors.push(error),
    });
    const closeInbox = ownCleanup(async () => unsubscribe());
    const eventFor = (id: string, state: string) =>
        poll(
            `receiver SSE ${state}`,
            async () => {
                if (errors.length) throw errors[0];
                return changes.find((claim) => claim.transferId === id && claim.state === state);
            },
            (claim) => claim !== undefined,
        ).then((claim) => claim!);
    try {
        await poll(
            "receiver SSE snapshot",
            async () => snapshots,
            (items) => items.length === 1,
        );
        expect(snapshots[0]).toEqual({ claims: [] });
        const authorizedUnits = mode === "purchase" ? 201_000_000n : 200_000_000n;
        const minted = await alice.wallet.assetManager.issue({
            amount: authorizedUnits,
            metadata: { decimals: 6, name: "Taxi Regtest USDT", ticker: "USDT" },
        });
        await poll(
            "indexed regtest USDT issuance",
            () => walletBalance(alice, minted.assetId),
            (balance) => balance.units === authorizedUnits,
        );
        expect(await alice.wallet.assetManager.getAssetDetails(minted.assetId)).toMatchObject({
            assetId: minted.assetId,
            supply: authorizedUnits,
            metadata: { decimals: 6, name: "Taxi Regtest USDT", ticker: "USDT" },
        });
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
        const { selected, totalAssetAmount } = selectCoinsWithAsset(
            available,
            minted.assetId,
            authorizedUnits,
        );
        expect(selected).toHaveLength(1);
        expect(selected[0]!.txid).toBe(fundingTxid);
        expect(selected[0]!.value).toBe(1000);
        expect(selected[0]!.assets).toEqual([{ assetId: minted.assetId, amount: authorizedUnits }]);
        expect(totalAssetAmount).toBe(authorizedUnits);
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
                            id: "receiver-usdt",
                            currency:
                                mode === "purchase" ? { kind: "sameAsset" } : { kind: "sats" },
                            pricing: { kind: "flat", units: mode === "purchase" ? "1000000" : "0" },
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
                live.client.requestVerifiedQuote({
                    receiverAddress,
                    senderKey: hex.decode(live.fixture.sender.pubkey),
                    selectedVtxos: selected,
                    assetId,
                    assetUnits: 200_000_000n,
                    fareId: "receiver-usdt",
                    trustedServerKey: hex.decode(live.info.serverKey),
                    trustedEmulatorKey: hex.decode(live.info.emulatorKey),
                    trustedServerUnrollScript: live.unroll.script,
                    vtxoMinAmount: 1n,
                    hrp: "tark",
                    expect: {
                        maxTopupSats: 1n,
                        maxFare:
                            mode === "purchase"
                                ? { currency: "asset", assetId, units: 1_000_000n }
                                : { currency: "sats", units: 0n },
                        minLocktime: 1n,
                    },
                }),
            {
                readyUrl: `${required("TAXI_E2E_BASE_URL")}/ready`,
                expiresAt: Date.now() / 1000 + 10,
            },
        );
        const quote = verified.quote;
        live.owned.set(quote.transferId, { offered: { quote, verified } });
        expect(senderInputs).toHaveLength(1);
        expect(senderInputs[0]!.assetPacket).toBeDefined();
        expect(senderInputs[0]!.value).toBe(1000n);
        expect(quote.params).toMatchObject({ dust: "330", topup: "1", assetId: wireAssetId });
        expect(quote.fare).toEqual(
            mode === "purchase"
                ? { currency: "asset", assetId: wireAssetId, units: "1000000" }
                : { currency: "sats", units: "0" },
        );
        expect(verified.envelope.assetUnits).toBe("200000000");
        const unsigned = Transaction.fromPSBT(base64.decode(verified.envelope.arkTx));
        expect(unsigned.getOutput(0).amount).toBe(330n);
        expect(assetOutputs(unsigned, minted.assetId)).toEqual(
            mode === "purchase"
                ? [
                      [0, 200_000_000n],
                      [1, 1_000_000n],
                  ]
                : [[0, 200_000_000n]],
        );
        if (mode === "purchase") expectReceipt(unsigned, 1, 1n, live.info.operatorKey);
        expect(unsigned.getOutput(mode === "purchase" ? 2 : 1).amount).toBe(671n);
        await control("configure", {
            target: "indexer",
            path: "/v1/indexer/vtxos",
            mode: "pause",
            query: { outpoints: `${unsigned.id}:0` },
        });
        const lockup = await submitWithReadiness(live.client, verified, alice.identity, {
            readyUrl: `${required("TAXI_E2E_BASE_URL")}/ready`,
        });
        const locking = await eventFor(quote.transferId, "locking");
        expect(locking.receiverAddress).toBe(receiverAddress);
        expect(locking.claimable).toBe(false);
        expect(locking.claim).toBeUndefined();
        expect(
            changes.some(
                (claim) => claim.transferId === quote.transferId && claim.state === "locked",
            ),
        ).toBe(false);
        await control("reset");
        const discovered = await eventFor(quote.transferId, "locked");
        expect(discovered.receiverAddress).toBe(receiverAddress);
        expect(discovered.claimable).toBe(true);
        expect(discovered.claim).toMatchObject({
            outpoint: lockup.outpoint,
            assetUnits: "200000000",
        });
        const transfer = await inbox.verifyIncomingClaim(
            discovered,
            { receiverAddress, assetId, assetUnits: 200_000_000n },
            {
                serverKey: hex.decode(live.info.serverKey),
                emulatorKey: hex.decode(live.info.emulatorKey),
                operatorKey: hex.decode(live.info.operatorKey),
                vtxoMinAmount: 1n,
                hrp: "tark",
            },
            live.config,
        );
        live.owned.get(quote.transferId)!.locked = { transfer };
        expect(transfer).toMatchObject({
            transferId: discovered.transferId,
            outpoint: lockup.outpoint,
            value: 330n,
        });
        const lockTx = await transaction(live, lockup.txid);
        expect(lockup.txid).toBe(unsigned.id);
        expect(assetOutputs(lockTx, minted.assetId)).toEqual(
            assetOutputs(unsigned, minted.assetId),
        );
        if (mode === "purchase") expectReceipt(lockTx, 1, 1n, live.info.operatorKey);
        let receiverInput;
        let txid: string;
        if (mode === "recycle") {
            receiverInput = (await bob.wallet.getSpendableVtxos({ withRecoverable: false })).find(
                (coin) => !coin.assets?.length && coin.value >= 330,
            );
            if (!receiverInput) throw new Error("Bob has no compatible sats VTXO");
            txid = await inbox.recycle(
                transfer,
                {
                    input: {
                        txid: receiverInput.txid,
                        vout: receiverInput.vout,
                        value: BigInt(receiverInput.value),
                        tapTree: receiverInput.tapTree,
                        tapLeafScript: receiverInput.forfeitTapLeafScript,
                    },
                    expiry: fundingOf(receiverInput).expiry,
                    identity: bob.identity,
                },
                destination,
            );
        } else txid = await inbox.purchase(transfer, destination);
        const finalState = mode === "recycle" ? "recycled" : "purchased";
        const finalEvent = await eventFor(quote.transferId, finalState);
        expect(finalEvent.claimable).toBe(false);
        expect(finalEvent.claim).toBeUndefined();
        expect(finalEvent.spentTxid).toBe(txid);
        const status = await live.client.status(quote.transferId);
        expect(status).toMatchObject({
            state: finalState,
            spentTxid: txid,
            outpoint: lockup.outpoint,
        });
        const { vtxos } = await live.indexer.getVtxos({ outpoints: [lockup.outpoint] });
        expect(vtxos).toHaveLength(1);
        expect(vtxos[0]!.isSpent).toBe(true);
        const tx = await transaction(live, txid);
        expect(tx.inputsLength).toBe(mode === "recycle" ? 2 : 1);
        const checkpoint = await transaction(live, hex.encode(tx.getInput(0).txid!));
        expect(hex.encode(checkpoint.getInput(0).txid!)).toBe(lockup.outpoint.txid);
        expect(checkpoint.getInput(0).index).toBe(lockup.outpoint.vout);
        const outputIndex = mode === "recycle" ? 1 : 0;
        expect(assetOutputs(tx, minted.assetId)).toEqual([[outputIndex, 200_000_000n]]);
        expect(tx.getOutput(outputIndex).script).toEqual(destination);
        expect(tx.getOutput(outputIndex).amount).toBe(
            receiverInput ? BigInt(receiverInput.value) + 329n : 330n,
        );
        if (mode === "recycle") expectReceipt(tx, 0, 1n, live.info.operatorKey);
        const bobAfter = await poll(
            "Bob receives exactly 200 regtest USDT",
            () => walletBalance(bob, minted.assetId),
            (balance) =>
                balance.units === 200_000_000n &&
                balance.sats === bobBefore.sats + (mode === "recycle" ? 329n : 330n),
        );
        expect(await walletBalance(alice, minted.assetId)).toEqual({
            sats: aliceBefore.sats - 329n,
            units: 0n,
        });
        const expectedOperator = {
            sats: operatorBefore.sats - (mode === "purchase" ? 1n : 0n),
            units: operatorBefore.units + (mode === "purchase" ? 1_000_000n : 0n),
        };
        const operatorAfter = await poll(
            "Taxi receives spendable repayment or exactly 1 USDT fare",
            () => walletBalance(live.actors.operator, minted.assetId),
            (balance) =>
                balance.sats === expectedOperator.sats && balance.units === expectedOperator.units,
        );
        expect(operatorAfter).toEqual(expectedOperator);
        const receiptPoint = {
            txid: mode === "purchase" ? lockup.txid : txid,
            vout: mode === "purchase" ? 1 : 0,
        };
        const receipt = (await live.indexer.getVtxos({ outpoints: [receiptPoint] })).vtxos.find(
            (coin) => coin.txid === receiptPoint.txid && coin.vout === receiptPoint.vout,
        );
        expect(receipt).toBeDefined();
        expect(receipt!.value).toBe(1);
        expect(receipt!.script).toBe(`5120${live.info.operatorKey}`);
        expect(receipt!.isSpent).toBe(true);
        expect(receipt!.settledBy).toMatch(/^[0-9a-f]{64}$/);
        expect(receipt!.assets ?? []).toEqual(
            mode === "purchase" ? [{ assetId: minted.assetId, amount: 1_000_000n }] : [],
        );
        const collected = (
            await live.actors.operator.wallet.getSpendableVtxos({ withRecoverable: false })
        ).filter((coin) => coin.commitmentTxIds?.includes(receipt!.settledBy!));
        expect(collected).toHaveLength(1);
        expect(hex.encode(VtxoScript.decode(collected[0]!.tapTree).tweakedPublicKey)).toBe(
            live.info.operatorKey,
        );
        expect(collected[0]!.assets ?? []).toEqual(
            mode === "purchase" ? [{ assetId: minted.assetId, amount: 1_000_000n }] : [],
        );
        const collectionStatus = await poll(
            "service completes its proceeds job",
            () => admin("status"),
            (status) =>
                status.readiness?.proceeds?.state === "idle" &&
                status.readiness.proceeds.blocker === null,
        );
        expect(collectionStatus.readiness.proceeds.maxFeeSats).toBe("0");
        const row = (await admin("advances")).advances.find(
            (item: any) => item.id === quote.transferId,
        );
        expect(row).toMatchObject({ state: finalState, spentTxid: txid });
        await admin("policy", {
            assetRules: [
                {
                    assetId: null,
                    enabled: true,
                    fares: [
                        {
                            id: "sats",
                            currency: { kind: "sats" },
                            pricing: { kind: "flat", units: "1" },
                        },
                    ],
                    claim: "either",
                    maxTopupSats: null,
                },
            ],
        });
        const second = await lock(
            live,
            await quoteFor(live, "receiverWithAsset", await sizedSender(live)),
        );
        const secondEvent = await eventFor(second.quote.transferId, "locked");
        expect(secondEvent.receiverAddress).toBe(receiverAddresses[1]);
        const secondTransfer = await inbox.verifyIncomingClaim(
            secondEvent,
            { receiverAddress: receiverAddresses[1]! },
            {
                serverKey: hex.decode(live.info.serverKey),
                emulatorKey: hex.decode(live.info.emulatorKey),
                operatorKey: hex.decode(live.info.operatorKey),
                vtxoMinAmount: 1n,
                hrp: "tark",
            },
            live.config,
        );
        const secondTxid = await inbox.purchase(secondTransfer, second.destination);
        const secondFinal = await eventFor(second.quote.transferId, "purchased");
        expect(secondFinal).toMatchObject({
            receiverAddress: receiverAddresses[1],
            claimable: false,
            spentTxid: secondTxid,
        });
        await terminal(live, second, "purchased", secondTxid);
        const secondOperatorAfter = await poll(
            "second-address proceeds are collected before releasing the fixture",
            () => walletBalance(live.actors.operator, minted.assetId),
            (balance) =>
                balance.sats === operatorAfter.sats - 1n && balance.units === operatorAfter.units,
        );
        expect(secondOperatorAfter).toEqual({
            sats: operatorAfter.sats - 1n,
            units: operatorAfter.units,
        });
        await poll(
            "second-address service collection finishes",
            () => admin("status"),
            (status) =>
                status.readiness?.proceeds?.state === "idle" &&
                status.readiness.proceeds.blocker === null,
        );
        expect((await admin("status")).exposure.outstandingSats).toBe("0");
        expect(await inbox.listClaims({ receiverAddresses })).toEqual({ claims: [] });
        expect(errors).toEqual([]);
        expect(snapshots).toHaveLength(1);
        expect(new Set(changes.map((claim) => claim.receiverAddress))).toEqual(
            new Set(receiverAddresses),
        );
        const states = changes
            .filter((claim) => claim.transferId === quote.transferId)
            .map((claim) => claim.state)
            .filter((state, index, all) => index === 0 || state !== all[index - 1]);
        expect(states).toEqual(["locking", "locked", finalState]);
        const evidence = {
            project: required("TAXI_E2E_PROJECT"),
            mode,
            assetId: minted.assetId,
            decimals: 6,
            authorizedUnits: authorizedUnits.toString(),
            paymentUnits: "200000000",
            fareUnits: mode === "purchase" ? "1000000" : "0",
            senderCarrierSats: "1000",
            topupSats: "1",
            receiverAddresses,
            transferId: quote.transferId,
            states,
            lockupTxid: lockup.txid,
            spendTxid: txid,
            receiverUnits: bobAfter.units.toString(),
            receiverSats: bobAfter.sats.toString(),
            operatorAddress: operatorAddress.encode(),
            operatorSatsBefore: operatorBefore.sats.toString(),
            operatorSatsAfter: operatorAfter.sats.toString(),
            operatorUnitsBefore: operatorBefore.units.toString(),
            operatorUnitsAfter: operatorAfter.units.toString(),
            secondTransferId: second.quote.transferId,
            secondSpendTxid: secondTxid,
            collectionCommitmentTxid: receipt!.settledBy,
            collectedOutpoint: { txid: collected[0]!.txid, vout: collected[0]!.vout },
        };
        assertArtifactSafe(evidence);
        writeFileSync(
            `e2e-artifacts/receiver-sse-${mode}.json`,
            `${JSON.stringify(evidence, null, 2)}\n`,
        );
    } finally {
        await closeInbox();
        await live.close();
    }
}

liveScenario("receiver-sse-recycle", () => receiverSseClaim("recycle"));
liveScenario("receiver-sse-asset-fare-purchase", () => receiverSseClaim("purchase"));
