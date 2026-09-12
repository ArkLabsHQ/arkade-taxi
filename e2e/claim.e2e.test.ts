import { expect } from "vitest";
import { liveScenario } from "./scenarios.js";
import {
    expectReceipt,
    fundingOf,
    holdings,
    lock,
    openLive,
    poll,
    quoteFor,
    sizedSender,
    terminal,
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
        expect(await walletBalance(live.actors.operator, live.fixture.asset.assetId)).toEqual({
            sats: operatorBefore.sats - 2n,
            units: operatorBefore.units,
        });
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
