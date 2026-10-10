import { randomUUID } from "node:crypto";
import { expect } from "vitest";
import { ArkAddress } from "@arkade-os/sdk";
import { hex } from "@scure/base";
import { ownCleanup } from "../scripts/lib/scenario-cleanup.mjs";
import { preEffectRequest } from "./admission.js";
import { liveScenario } from "./scenarios.js";
import {
    assetOutputs,
    claimFromFeed,
    expectReceipt,
    freshCoin,
    openLive,
    poll,
    recycleWith,
    releaseBound,
    required,
    terminal,
    transaction,
    walletBalance,
    type Locked,
} from "./fixtures.js";
import {
    BOB_COIN_SATS,
    DELIVERED,
    SATS_FARE,
    evidence,
    quotedFill,
    sigCount,
    signAsCaller,
    txOf,
} from "./fillSupport.js";

const readyUrl = () => `${required("TAXI_E2E_BASE_URL")}/ready`;

liveScenario("receiver-paid-fill-claim", async () => {
    const live = await openLive();
    const bound: { release?: () => Promise<void> } = {};
    try {
        const bobCoin = await freshCoin(live, "receiverSats", BOB_COIN_SATS);
        const quoted = await quotedFill(live);
        const { quote, graph, taxiInputIndexes, bobAddress, assetId, dust, minted, bob } = quoted;
        const operatorBefore = await walletBalance(live.actors.operator, minted.assetId);
        const posted = await signAsCaller(quoted);
        expect(posted.unsigned).toEqual([]);
        // The Taxi signs last, and the gated covenant is the emulator's alone.
        const postedArk = txOf(posted.arkTx);
        for (const index of taxiInputIndexes) expect(sigCount(postedArk, index)).toBe(0);
        for (const [index, owner] of graph.inputOwners.entries())
            if (owner === null) expect(sigCount(postedArk, index)).toBe(0);

        const operationId = randomUUID();
        bound.release = ownCleanup(() =>
            releaseBound(live, quote.quoteId, async () => {
                const { transfer } = await claimFromFeed(
                    live,
                    quote.quoteId,
                    bobAddress,
                    assetId,
                    DELIVERED,
                );
                const coin = await freshCoin(live, "receiverSats", BOB_COIN_SATS);
                await recycleWith(live, transfer, coin, ArkAddress.decode(bobAddress).pkScript);
            }),
        );
        live.owned.set(quote.quoteId, {});
        const submitted = await preEffectRequest(
            () =>
                live.client.submitFill({
                    operationId,
                    quoteId: quote.quoteId,
                    arkTx: posted.arkTx,
                    checkpoints: posted.checkpoints,
                    taxiInputIndexes,
                    covenantOutputIndex: 0,
                    assetUnits: DELIVERED,
                }),
            { readyUrl: readyUrl(), expiresAt: quote.expiresAt },
            async () => {
                const state = await live.client.getReceiveQuote(quote.quoteId);
                if (state.state !== "quoted")
                    throw new Error("receive quote is not an unchanged quote");
            },
        );
        // V13: the answer carries a txid and no bytes.
        expect(Object.keys(submitted).sort()).toEqual(
            ["expiresAt", "fillId", "operationId", "state", "txid", "updatedAt"].sort(),
        );
        expect(submitted.state).toBe("submitting");
        const outpoint = { txid: submitted.txid!, vout: 0 };
        const locked = await poll(
            "generic fill locks its advance",
            () => live.client.status(quote.quoteId),
            (status) => status.state === "locked",
            120_000,
        );
        expect(locked.outpoint).toEqual(outpoint);
        const fillStatus = await poll(
            "generic fill reconciles",
            () => live.client.fillStatus(submitted.fillId),
            (status) => status.state === "settled",
            120_000,
        );
        expect(fillStatus.txid).toBe(submitted.txid);
        expect(fillStatus.outpoint).toEqual(outpoint);

        // What the providers actually signed, read off the settled transaction.
        const settled = await transaction(live, submitted.txid!);
        const signatures = Array.from({ length: settled.inputsLength }, (_, index) => ({
            index,
            owner: taxiInputIndexes.includes(index)
                ? "taxi"
                : graph.inputOwners[index] === null
                  ? "gated"
                  : "caller",
            keys: (settled.getInput(index).tapScriptSig ?? []).map(([meta]) =>
                hex.encode(meta.pubKey),
            ),
        }));
        // Every input is signed, and the gated covenant carries the emulator's
        // tweaked key rather than the raw one.
        for (const input of signatures) expect(input.keys.length).toBeGreaterThan(0);
        const gated = signatures.filter((input) => input.owner === "gated");
        expect(gated.length).toBeGreaterThan(0);
        for (const input of gated) expect(input.keys).not.toContain(live.info.emulatorKey);

        const { claim, transfer } = await claimFromFeed(
            live,
            quote.quoteId,
            bobAddress,
            assetId,
            DELIVERED,
        );
        expect(claim.claim).toMatchObject({
            covenantAddress: quote.covenantAddress,
            outpoint,
            assetUnits: DELIVERED.toString(),
            unclaimedMode: "reclaim",
        });
        const covenant = {
            quote: { transferId: quote.quoteId },
            lockup: { outpoint },
        } as unknown as Locked;
        const destination = ArkAddress.decode(bobAddress).pkScript;
        const bobBefore = await walletBalance(bob, minted.assetId);
        const txid = await recycleWith(live, transfer, bobCoin, destination);
        const { tx } = await terminal(live, covenant, "recycled", txid);
        expectReceipt(tx, 0, dust + SATS_FARE, live.info.operatorKey);
        expect(tx.getOutput(1).amount).toBe(BigInt(BOB_COIN_SATS) - SATS_FARE);
        expect(tx.getOutput(1).script).toEqual(destination);
        // The transaction itself, then the wallet catching up to it: a balance
        // read alone races the recycle it is meant to observe.
        expect(assetOutputs(tx, minted.assetId)).toEqual([[1, DELIVERED]]);
        const bobObserved = await poll(
            "Bob holds the delivery less his fare",
            () => walletBalance(bob, minted.assetId),
            (value) => value.sats === bobBefore.sats - SATS_FARE && value.units === DELIVERED,
            120_000,
        );
        const operatorAfter = await walletBalance(live.actors.operator, minted.assetId);

        evidence("receiver-paid-fill-claim", {
            fillId: submitted.fillId,
            txid: submitted.txid,
            quoteId: quote.quoteId,
            covenantOutpoint: outpoint,
            operatorInputs: quote.operatorInputs.map(({ txid: t, vout, value }) => ({
                txid: t,
                vout,
                value,
            })),
            operatorScript: quote.operatorScript,
            taxiInputIndexes,
            signatures,
            emulatorKey: live.info.emulatorKey,
            serverKey: live.info.serverKey,
            operatorSatsDelta: operatorAfter.sats - operatorBefore.sats,
            recycleAssets: assetOutputs(tx, minted.assetId),
            bobBefore,
            bobObserved,
            recycleTxid: txid,
        });
    } finally {
        if (bound.release) await bound.release();
    }
});
