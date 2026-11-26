import { ArkAddress, asset, RestArkProvider, Transaction, VtxoScript } from "@arkade-os/sdk";
import { buildDirectFillGraph, finalizeAcceptedDirectFill, mergeComplete } from "./directFillGraph";
export { finalizeAcceptedDirectFill } from "./directFillGraph";
import { lockupSats } from "@arkade-taxi/covenant";
import { base64, hex } from "@scure/base";
import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import { loadConfig } from "../packages/app/src/config";
import { assertArtifactSafe } from "../scripts/lib/harness.mjs";
import { ownCleanup } from "../scripts/lib/scenario-cleanup.mjs";
import { preEffectRequest } from "./admission";
import {
    admin,
    artifactPath,
    assetOutputs,
    claimFromFeed,
    control,
    expectReceipt,
    freshCoin,
    fundingOf,
    health,
    openLive,
    poll,
    recycleWith,
    required,
    terminal,
    transaction,
    walletBalance,
    type Locked,
} from "./fixtures";

export const DIRECT_DELIVERY = 1_000n;
export const DIRECT_FARE = 7n;
const parse = (psbt: string) => Transaction.fromPSBT(base64.decode(psbt));
const encode = (tx: Transaction) => base64.encode(tx.toPSBT());
export const directReady = async () => {
    const response = await fetch(`${required("TAXI_E2E_BASE_URL")}/ready`);
    return { status: response.status, body: await response.json() };
};
export const directCounters = async () => {
    const snapshot = await control("events");
    return {
        submit: snapshot.submissionCounts.arkd as number,
        emulator: snapshot.submissionCounts.emulator as number,
        finalize: snapshot.events.filter(
            (event: any) =>
                event.target === "arkd" &&
                event.method === "POST" &&
                event.path === "/v1/tx/finalize" &&
                event.action === "forwarded",
        ).length,
    };
};
export const directEvidence = (scenario: string, fields: Record<string, unknown>) => {
    const evidence = JSON.parse(
        JSON.stringify(
            { project: required("TAXI_E2E_PROJECT"), scenario, ...fields },
            (_, value) => (typeof value === "bigint" ? value.toString() : value),
        ),
    );
    assertArtifactSafe(evidence);
    writeFileSync(artifactPath(`${scenario}.json`), JSON.stringify(evidence, null, 2) + "\n");
};

export async function prepareDirectFill(options: { unrelatedCoin?: boolean } = {}) {
    const live = await openLive();
    const caller = live.actors.sender;
    const bob = live.actors.receiverSats;
    const bobCoin = await freshCoin(live, "receiverSats", 1_000);
    const minted = await caller.wallet.assetManager.issue({
        amount: 10_000n,
        metadata: { decimals: 0, name: "Taxi Native Direct Fill", ticker: "TNDF" },
    });
    const otherCoin = options.unrelatedCoin ? await freshCoin(live, "sender", 1_000) : undefined;
    if (options.unrelatedCoin) {
        await freshCoin(live, "operator", 1_000);
        await freshCoin(live, "operator", 1_000);
    }
    const callerCoins = await poll(
        "ordinary caller asset inventory",
        async () =>
            (await caller.wallet.getSpendableVtxos({ withRecoverable: false })).filter((coin) =>
                coin.assets?.some((held) => held.assetId === minted.assetId),
            ),
        (coins) =>
            coins.reduce(
                (sum, coin) =>
                    sum +
                    (coin.assets ?? [])
                        .filter((held) => held.assetId === minted.assetId)
                        .reduce((amount, held) => amount + held.amount, 0n),
                0n,
            ) === 10_000n,
        120_000,
    );
    const operatorCoins = (
        await live.actors.operator.wallet.getSpendableVtxos({ withRecoverable: false })
    ).filter((coin) => !coin.assets?.length);
    const funding = [...callerCoins, ...operatorCoins].map(fundingOf);
    const operatorTotal = operatorCoins.reduce((sum, coin) => sum + BigInt(coin.value), 0n);
    await poll(
        "Taxi observes all direct-fill operator inventory",
        health,
        (snapshot) =>
            snapshot.status === "ok" &&
            snapshot.runtime.inventory.usableSats === operatorTotal.toString(),
        120_000,
    );
    if (!funding.length || funding.some((input) => input.expiry.kind !== "time"))
        throw new Error("direct fill fixture requires time-expiring funded inputs");
    const floor = funding.reduce(
        (min, coin) => (coin.expiry.value < min ? coin.expiry.value : min),
        2n ** 53n,
    );
    const parsedAsset = asset.AssetId.fromString(minted.assetId);
    const assetId = {
        txid: Uint8Array.from(parsedAsset.txid).reverse(),
        groupIndex: parsedAsset.groupIndex,
    };
    const wireAsset = { txid: hex.encode(assetId.txid), groupIndex: assetId.groupIndex };
    await admin("policy", {
        assetRules: [null, wireAsset].map((id) => ({
            assetId: id,
            enabled: true,
            claim: "either",
            maxTopupSats: null,
            fares: [
                {
                    id: id ? "receiver-sats" : "sats",
                    currency: { kind: "sats" },
                    pricing: { kind: "flat", units: id ? DIRECT_FARE.toString() : "0" },
                },
            ],
        })),
    });
    const bobAddress = await bob.wallet.getAddress();
    const callerAddress = await caller.wallet.getAddress();
    const callerKey = await caller.identity.xOnlyPublicKey();
    const now = BigInt(Math.floor(Date.now() / 1000));
    const { verified } = await preEffectRequest(
        () =>
            live.client.requestVerifiedReceiveQuote({
                receiverAddress: bobAddress,
                senderKey: callerKey,
                assetId,
                fareId: "receiver-sats",
                fundingExpiry: { kind: "time", value: floor },
                payer: "receiver",
                trustedServerKey: hex.decode(live.info.serverKey),
                trustedEmulatorKey: hex.decode(live.info.emulatorKey),
                dust: BigInt(live.info.dust),
                vtxoMinAmount: BigInt(live.info.vtxoMinAmount),
                hrp: "tark",
                expect: {
                    maxServiceFareSats: 0n,
                    minRecoveryLocktime: {
                        kind: "time",
                        value: now + loadConfig(process.env).covenantDeadlineSeconds,
                    },
                    minInputExpiryFloor: { kind: "time", value: floor },
                },
            }),
        { readyUrl: `${required("TAXI_E2E_BASE_URL")}/ready`, expiresAt: Number(now) + 10 },
    );
    const quote = verified.quote;
    ownCleanup(() =>
        poll(
            "direct receive quote is bound or expired",
            () => live.client.getReceiveQuote(quote.quoteId),
            (state) => state.state !== "quoted",
            150_000,
        ),
    );
    const taxiInputs = quote.operatorInputs.map((coin) => {
        const tapTree = hex.decode(coin.tapTree);
        return {
            txid: coin.txid,
            vout: coin.vout,
            value: Number(coin.value),
            tapTree,
            tapLeafScript: VtxoScript.decode(tapTree).findLeaf(coin.spendLeaf),
        };
    });
    const graph = buildDirectFillGraph({
        callerInputs: callerCoins.map((coin) => ({
            txid: coin.txid,
            vout: coin.vout,
            value: coin.value,
            tapTree: coin.tapTree,
            tapLeafScript: coin.forfeitTapLeafScript,
            assets: coin.assets,
        })),
        taxiInputs,
        callerScript: ArkAddress.decode(callerAddress).pkScript,
        covenantScript: verified.script.pkScript,
        operatorScript: hex.decode(quote.operatorScript),
        callerKey,
        operatorKey: await live.actors.operator.identity.xOnlyPublicKey(),
        serverKey: hex.decode(live.info.serverKey),
        assetId: minted.assetId,
        assetUnits: DIRECT_DELIVERY,
        covenantSats: lockupSats(verified.params),
        loanSats: verified.params.topup,
        senderFareSats: BigInt(quote.fare.units),
        dust: BigInt(live.info.dust),
        vtxoMinAmount: BigInt(live.info.vtxoMinAmount),
        unroll: live.unroll,
    });
    graph.arkTx = parse(encode(await caller.identity.sign(graph.arkTx, graph.callerInputIndexes)));
    for (const index of graph.callerInputIndexes)
        graph.checkpoints[index] = parse(
            encode(await caller.identity.sign(graph.checkpoints[index]!, [0])),
        );
    const operatorBefore = await walletBalance(live.actors.operator, minted.assetId);
    const callerBefore = await walletBalance(caller, minted.assetId);
    return {
        live,
        caller,
        bob,
        bobCoin,
        otherCoin,
        callerCoins,
        minted,
        assetId,
        bobAddress,
        verified,
        quote,
        graph,
        operatorBefore,
        callerBefore,
        operationId: randomUUID(),
    };
}

export type LiveDirectFill = Awaited<ReturnType<typeof prepareDirectFill>>;
export const postDirectFill = (context: LiveDirectFill, client = context.live.client) =>
    client.submitFill({
        operationId: context.operationId,
        quoteId: context.quote.quoteId,
        arkTx: encode(context.graph.arkTx),
        checkpoints: context.graph.checkpoints.map(encode),
        taxiInputIndexes: context.graph.taxiInputIndexes,
        covenantOutputIndex: 0,
        assetUnits: DIRECT_DELIVERY,
    });

export async function settledDirectFill(context: LiveDirectFill) {
    const { live, graph, quote } = context;
    const state = await poll(
        "direct fill advance locks",
        () => live.client.status(quote.quoteId),
        (state) => state.state === "locked",
        120_000,
    );
    if (state.outpoint?.txid !== graph.arkTx.id || state.outpoint.vout !== 0)
        throw new Error("direct fill advance locked a different covenant");
    const bound = await live.client.getReceiveQuote(quote.quoteId);
    if (!bound.boundFillId) throw new Error("direct fill quote lost its fill identity");
    const fill = await poll(
        "direct fill settles",
        () => live.client.fillStatus(bound.boundFillId!),
        (state) => state.state === "settled",
        120_000,
    );
    if (fill.txid !== graph.arkTx.id) throw new Error("direct fill settled another transaction");
    const tx = await transaction(live, graph.arkTx.id);
    const checked = mergeComplete(graph.arkTx, tx);
    const signatures = Array.from({ length: checked.inputsLength }, (_, index) => ({
        index,
        owner: graph.taxiInputIndexes.includes(index) ? "taxi" : "caller",
        keys: (tx.getInput(index).tapScriptSig ?? [])
            .map(([meta]) => hex.encode(meta.pubKey))
            .sort(),
    }));
    for (const input of signatures) {
        const expected = (checked.getInput(input.index).tapScriptSig ?? [])
            .map(([meta]) => hex.encode(meta.pubKey))
            .sort();
        if (JSON.stringify(input.keys) !== JSON.stringify(expected))
            throw new Error(`indexed direct fill input ${input.index} is not fully signed`);
    }
    return { state, fill, signatures };
}

export async function recycleDirectFill(context: LiveDirectFill) {
    const { live, quote, bobAddress, assetId, minted, bobCoin, bob } = context;
    const { transfer } = await claimFromFeed(
        live,
        quote.quoteId,
        bobAddress,
        assetId,
        DIRECT_DELIVERY,
    );
    const before = await walletBalance(bob, minted.assetId);
    const destination = ArkAddress.decode(bobAddress).pkScript;
    const txid = await recycleWith(live, transfer, bobCoin, destination);
    const locked = {
        quote: { transferId: quote.quoteId },
        lockup: { outpoint: { txid: context.graph.arkTx.id, vout: 0 } },
    } as unknown as Locked;
    const { tx } = await terminal(live, locked, "recycled", txid);
    expectReceipt(tx, 0, BigInt(live.info.dust) + DIRECT_FARE, live.info.operatorKey);
    if (
        tx.getOutput(1).amount !== BigInt(bobCoin.value) - DIRECT_FARE ||
        hex.encode(tx.getOutput(1).script!) !== hex.encode(destination)
    )
        throw new Error("direct receiver recycle has wrong sats or destination");
    const assetResult = assetOutputs(tx, minted.assetId);
    if (
        assetResult.length !== 1 ||
        assetResult[0]![0] !== 1 ||
        assetResult[0]![1] !== DIRECT_DELIVERY
    )
        throw new Error("direct receiver recycle lost the asset delivery");
    const bobObserved = await poll(
        "direct receiver keeps delivery less fare",
        () => walletBalance(bob, minted.assetId),
        (balance) =>
            balance.sats === before.sats - DIRECT_FARE && balance.units === DIRECT_DELIVERY,
        120_000,
    );
    const operatorAfter = await poll(
        "direct Taxi loan and fare return",
        () => walletBalance(live.actors.operator, minted.assetId),
        (balance) => balance.sats === context.operatorBefore.sats + DIRECT_FARE,
        120_000,
    );
    const callerAfter = await poll(
        "direct caller keeps all remaining assets",
        () => walletBalance(context.caller, minted.assetId),
        (balance) =>
            balance.units === context.callerBefore.units - DIRECT_DELIVERY &&
            balance.sats ===
                context.callerBefore.sats -
                    (lockupSats(context.verified.params) - context.verified.params.topup) -
                    BigInt(quote.fare.units),
        120_000,
    );
    return {
        recycleTxid: txid,
        bobObserved,
        operatorSatsDelta: operatorAfter.sats - context.operatorBefore.sats,
        callerAfter,
        recycleAssets: assetResult,
    };
}

export async function cleanupDirectFill(context: LiveDirectFill) {
    await control("reset");
    const { live, quote, graph } = context;
    const current = await live.client.getReceiveQuote(quote.quoteId);
    if (current.state !== "bound") return;
    live.owned.set(quote.quoteId, {});
    let state = await live.client.status(quote.quoteId);
    if (state.state === "locking") {
        const output = (
            await live.indexer.getVtxos({ outpoints: [{ txid: graph.arkTx.id, vout: 0 }] })
        ).vtxos;
        if (!output.length) {
            const provider = new RestArkProvider(required("TAXI_E2E_ARKD_URL"));
            const proof = await context.caller.wallet.makeGetPendingTxIntentSignature(
                context.callerCoins,
            );
            await poll(
                "original direct fill appears in pending provider state",
                async () =>
                    (await provider.getPendingTxs(proof)).some(
                        (tx) => tx.arkTxid === graph.arkTx.id,
                    ),
                (found) => found,
                120_000,
            );
            await finalizeAcceptedDirectFill({
                graph,
                callerCoins: context.callerCoins,
                pendingWallet: context.caller.wallet,
                provider,
                operatorIdentity: live.actors.operator.identity,
            });
        }
        state = (await settledDirectFill(context)).state;
    }
    if (state.state === "locked") await recycleDirectFill(context);
    await poll(
        "direct fill owns no active advance",
        () => live.client.status(quote.quoteId),
        (status) => !["locking", "locked", "recovering"].includes(status.state),
        120_000,
    );
}
