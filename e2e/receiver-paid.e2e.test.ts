import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import { expect } from "vitest";
import {
    ArkAddress,
    Extension,
    asset,
    scriptFromTapLeafScript,
    type ExtendedVirtualCoin,
    type Transaction,
} from "@arkade-os/sdk";
import { createOffer, decodeOffer } from "@arkade-os/swap";
import {
    signJointGraphForOwner,
    type CovenantTransfer,
    type JointGraph,
} from "@arkade-taxi/client";
import { hex } from "@scure/base";
import { mineBlocks } from "../scripts/e2e-mine.mjs";
import { assertArtifactSafe } from "../scripts/lib/harness.mjs";
import { ownCleanup } from "../scripts/lib/scenario-cleanup.mjs";
import { preEffectRequest } from "./admission.js";
import { liveScenario } from "./scenarios.js";
import {
    admin,
    expectReceipt,
    fundingOf,
    health,
    openLive,
    poll,
    ready,
    required,
    terminal,
    walletBalance,
    type Live,
    type Locked,
} from "./fixtures.js";

type Fare = { id: string; currency: "sats" | "asset"; units: bigint };

const SATS_FARE: Fare = { id: "receiver-sats", currency: "sats", units: 7n };
const ASSET_FARE: Fare = { id: "receiver-asset", currency: "asset", units: 9n };
const DELIVERED = 1_000n;
const ISSUED = 10_000n;
const DEPOSIT_SATS = 5_000;
const BOB_COIN_SATS = 1_000;
const DEFAULT_MARGIN_SECONDS = 86_400n;
const RECLAIM_AFTER_SECONDS = 300n;

const readyUrl = () => `${required("TAXI_E2E_BASE_URL")}/ready`;
const expiryOf = (coin: ExtendedVirtualCoin): bigint => fundingOf(coin).expiry.value;
const taxiAssetId = (id: string) => {
    const parsed = asset.AssetId.fromString(id);
    return { txid: Uint8Array.from(parsed.txid).reverse(), groupIndex: parsed.groupIndex };
};
const unitsOf = (coin: ExtendedVirtualCoin, assetId: string): bigint =>
    (coin.assets ?? [])
        .filter((held) => held.assetId === assetId)
        .reduce((sum, held) => sum + held.amount, 0n);

const assetOutputs = (tx: Transaction, assetId: string) =>
    Extension.fromTx(tx)
        .getAssetPacket()!
        .groups.filter((group) => group.assetId?.toString() === assetId)
        .flatMap((group) => group.outputs.map((output) => [output.vout, output.amount]));

async function freshCoin(live: Live, name: string, amount: number) {
    const actor = live.actors[name];
    const txid = await live.actors.receiverWithAsset.wallet.send({
        address: await actor.wallet.getAddress(),
        amount,
    });
    return poll(
        `fresh ${amount}-sat coin for ${name}`,
        async () =>
            (await actor.wallet.getSpendableVtxos({ withRecoverable: false })).find(
                (coin) => coin.txid === txid && coin.value === amount && !coin.assets?.length,
            ),
        (coin) => coin !== undefined,
        120_000,
    ).then((coin) => coin!);
}

async function claimFromFeed(
    live: Live,
    transferId: string,
    receiverAddress: string,
    assetId: { txid: Uint8Array; groupIndex: number },
) {
    const claim = await poll(
        "claim feed serves the locked covenant",
        async () =>
            (await live.client.listClaims({ receiverAddresses: [receiverAddress] })).claims.find(
                (item) => item.transferId === transferId && item.state === "locked",
            ),
        (item) => item !== undefined,
    ).then((item) => item!);
    const transfer = await live.client.verifyIncomingClaim(
        claim,
        {
            receiverAddress,
            assetId,
            assetUnits: DELIVERED,
            claimMode: "recycle",
            recoveryRecipient: "receiver",
        },
        {
            serverKey: hex.decode(live.info.serverKey),
            emulatorKey: hex.decode(live.info.emulatorKey),
            operatorKey: hex.decode(live.info.operatorKey),
            vtxoMinAmount: BigInt(live.info.vtxoMinAmount),
            hrp: "tark",
        },
        live.config,
    );
    return { claim, transfer };
}

async function recycleWith(
    live: Live,
    transfer: CovenantTransfer,
    coin: ExtendedVirtualCoin,
    destination: Uint8Array,
) {
    return live.client.recycle(
        transfer,
        {
            input: {
                txid: coin.txid,
                vout: coin.vout,
                value: BigInt(coin.value),
                tapTree: coin.tapTree,
                tapLeafScript: coin.forfeitTapLeafScript,
            },
            expiry: fundingOf(coin).expiry,
            identity: live.actors.receiverSats.identity,
        },
        destination,
    );
}

async function jumpPast(locktime: bigint) {
    execFileSync(
        process.execPath,
        [required("ARKADE_REGTEST_CLI"), "rpc", "setmocktime", String(locktime + 1n)],
        { stdio: "pipe", timeout: 30_000 },
    );
    await mineBlocks(11);
}

// A failed scenario must not hand the next one an active advance: a bound fill
// stays `locking` until it expires, past the fixture's 90s wait.
async function releaseBound(live: Live, id: string, unlock: () => Promise<unknown>) {
    let { state } = await live.client.status(id);
    if (state === "locking") {
        const row = (await admin("advances")).advances.find((item: any) => item.id === id);
        if (!row)
            throw new Error(
                `bound advance ${id} (receive quote ${id}) reports locking but is missing from /admin/api/advances`,
            );
        state = (
            await poll(
                `bound fill ${id} settles or expires`,
                () => live.client.status(id),
                (value) => value.state !== "locking",
                Math.max(90_000, row.expiresAt * 1000 - Date.now() + 30_000),
            )
        ).state;
    }
    if (state === "locked") await unlock();
    await poll(
        `bound advance ${id} leaves the active states`,
        () => live.client.status(id),
        (value) => !["locking", "locked", "recovering"].includes(value.state),
        120_000,
    );
}

async function receiverPaidCarrier(
    live: Live,
    fare: Fare,
    bound: { release?: () => Promise<void> },
    reclaimAfter?: bigint,
) {
    const maker = live.actors.receiverWithAsset;
    const solver = live.actors.sender;
    const bob = live.actors.receiverSats;
    const operator = live.actors.operator;
    const dust = BigInt(live.info.dust);
    const vtxoMinAmount = BigInt(live.info.vtxoMinAmount);
    const minted = await solver.wallet.assetManager.issue({
        amount: ISSUED,
        metadata: { decimals: 0, name: "Taxi Receiver Paid", ticker: "TRPD" },
    });
    const solverFund = await poll(
        "solver holds the minted asset",
        async () =>
            (await solver.wallet.getSpendableVtxos({ withRecoverable: false })).filter(
                (coin) => unitsOf(coin, minted.assetId) > 0n,
            ),
        (coins) => coins.reduce((sum, coin) => sum + unitsOf(coin, minted.assetId), 0n) === ISSUED,
        120_000,
    );
    // Every candidate fill input clears this floor, so the quote's floor is exactly it.
    const floor = [
        ...(await maker.wallet.getSpendableVtxos({ withRecoverable: false })),
        ...solverFund,
        ...(await operator.wallet.getSpendableVtxos({ withRecoverable: false })).filter(
            (coin) => !coin.assets?.length,
        ),
    ].reduce((min, coin) => (expiryOf(coin) < min ? expiryOf(coin) : min), 2n ** 53n);
    const chainTime = await poll(
        "Taxi reports a chain time between runtime checks",
        health,
        (body) => body.runtime?.chainTime != null,
    ).then((body) => BigInt(body.runtime.chainTime));
    const now = BigInt(Math.floor(Date.now() / 1000));
    const margin =
        reclaimAfter === undefined
            ? DEFAULT_MARGIN_SECONDS
            : floor - (chainTime > now ? chainTime : now) - reclaimAfter;
    const locktime = floor - margin;
    const sdkAssetId = asset.AssetId.fromString(minted.assetId);
    const assetId = taxiAssetId(minted.assetId);
    const wireAssetId = { txid: hex.encode(assetId.txid), groupIndex: assetId.groupIndex };
    const rule = (id: typeof wireAssetId | null, option: object) => ({
        assetId: id,
        enabled: true,
        fares: [option],
        claim: "either",
        maxTopupSats: null,
    });
    await admin("policy", {
        locktimeMarginSeconds: Number(margin),
        assetRules: [
            rule(null, {
                id: "sats",
                currency: { kind: "sats" },
                pricing: { kind: "flat", units: "0" },
            }),
            rule(wireAssetId, {
                id: fare.id,
                currency: { kind: fare.currency === "sats" ? "sats" : "sameAsset" },
                pricing: { kind: "flat", units: fare.units.toString() },
            }),
        ],
    });

    const bobAddress = await bob.wallet.getAddress();
    const makerKey = await maker.identity.xOnlyPublicKey();
    await ready(Math.floor(Date.now() / 1000));
    const { verified } = await preEffectRequest(
        () =>
            live.client.requestVerifiedReceiveQuote({
                receiverAddress: bobAddress,
                makerPublicKey: makerKey,
                assetId,
                fareId: fare.id,
                fundingExpiry: { kind: "time", value: floor },
                payer: "receiver",
                trustedServerKey: hex.decode(live.info.serverKey),
                trustedEmulatorKey: hex.decode(live.info.emulatorKey),
                dust,
                vtxoMinAmount,
                hrp: "tark",
                expect: {
                    maxServiceFareSats: 0n,
                    minRecoveryLocktime: { kind: "time", value: locktime },
                    minInputExpiryFloor: { kind: "time", value: floor },
                },
            }),
        { readyUrl: readyUrl(), expiresAt: Date.now() / 1000 + 10 },
    );
    const quote = verified.quote;
    ownCleanup(() =>
        poll(
            "an unbound receive quote expires before release",
            () => live.client.getReceiveQuote(quote.quoteId),
            (value) => value.state !== "quoted",
            150_000,
        ),
    );
    const covenantFare = { currency: fare.currency, units: fare.units.toString() };
    expect(quote).toMatchObject({
        payer: "receiver",
        fare: { currency: "sats", units: "0" },
        receiverFare:
            fare.currency === "sats" ? covenantFare : { ...covenantFare, assetId: wireAssetId },
        unclaimedMode: "reclaim",
        inputExpiryFloor: { kind: "time", value: floor.toString() },
        recoveryLocktime: { kind: "time", value: locktime.toString() },
        params: { dust: dust.toString(), topup: dust.toString(), receiverFare: covenantFare },
    });

    const offer = await createOffer(maker.wallet, required("TAXI_E2E_ARKD_URL"), {
        wantAmount: DELIVERED,
        wantAsset: sdkAssetId,
        receiveAddress: quote.covenantAddress,
    });
    expect(hex.encode(decodeOffer(hex.decode(offer.offerHex)).makerPublicKey)).toBe(
        hex.encode(makerKey),
    );
    const depositTxid = await maker.wallet.send({
        address: offer.address,
        amount: DEPOSIT_SATS,
        extensions: [offer.extension],
    });
    const deposit = await poll(
        "indexed offer deposit",
        async () =>
            (await live.indexer.getVtxos({ scripts: [hex.encode(offer.swapPkScript)] })).vtxos.find(
                (coin) => coin.txid === depositTxid,
            ),
        (coin) => coin !== undefined,
        120_000,
    ).then((coin) => coin!);

    const operatorBefore = await walletBalance(operator, minted.assetId);
    const operationId = randomUUID();
    const solverScript = ArkAddress.decode(await solver.wallet.getAddress()).pkScript;
    const solverKey = hex.encode(await solver.identity.xOnlyPublicKey());
    const { verified: fill } = await preEffectRequest(
        () =>
            live.client.requestVerifiedSwapFillQuote({
                operationId,
                receiveQuoteId: quote.quoteId,
                offerHex: offer.offerHex,
                solverInputs: solverFund.map((coin) => ({
                    txid: coin.txid,
                    vout: coin.vout,
                    value: BigInt(coin.value),
                    tapTree: coin.tapTree,
                    spendLeaf: scriptFromTapLeafScript(coin.forfeitTapLeafScript),
                    assets: coin.assets!.map((held) => ({
                        assetId: taxiAssetId(held.assetId),
                        amount: held.amount,
                    })),
                })),
                solverProceedsScript: solverScript,
                solverKeys: [solverKey],
                contributionSats: dust,
                maxFare: { currency: "sats", units: 0n },
                fundingTxid: deposit.txid,
                fundingVout: deposit.vout,
            }),
        { readyUrl: readyUrl(), expiresAt: quote.expiresAt },
    );
    live.owned.set(quote.quoteId, {});
    bound.release = ownCleanup(() =>
        releaseBound(live, quote.quoteId, async () => {
            if (reclaimAfter !== undefined) return jumpPast(locktime);
            const { transfer } = await claimFromFeed(live, quote.quoteId, bobAddress, assetId);
            const coin = await freshCoin(live, "receiverSats", BOB_COIN_SATS);
            await recycleWith(live, transfer, coin, ArkAddress.decode(bobAddress).pkScript);
        }),
    );
    const graph = fill.quote.graph;
    expect(graph.outputs.filter((output) => output.role === "sponsor-fare")).toEqual([]);
    expect(graph.outputs[0]).toEqual({
        role: "receiver",
        vout: 0,
        script: hex.encode(ArkAddress.decode(quote.covenantAddress).pkScript),
        sats: dust.toString(),
        assets: [{ assetId: wireAssetId, units: DELIVERED.toString() }],
    });

    const expected: JointGraph = {
        arkTx: graph.arkTx,
        checkpoints: [...graph.checkpoints],
        graphId: graph.graphId,
        inputOwners: graph.inputs.map((input) =>
            input.owner === "offer-covenant" ? null : input.owner,
        ),
    };
    const signed = await signJointGraphForOwner({
        expected,
        owner: "solver",
        bindings: expected.inputOwners.flatMap((owner, inputIndex) =>
            owner === "solver" ? [{ inputIndex, identity: solver.identity }] : [],
        ),
    });
    const submitAttempts: { startedAt: number; ms: number }[] = [];
    const submitted = await preEffectRequest(
        async () => {
            const startedAt = Date.now();
            try {
                return await live.client.submitSwapFill(fill, {
                    ...graph,
                    arkTx: signed.arkTx,
                    checkpoints: [...signed.checkpoints],
                });
            } finally {
                submitAttempts.push({ startedAt, ms: Date.now() - startedAt });
            }
        },
        { readyUrl: readyUrl(), expiresAt: fill.expiresAt },
        async () => {
            const status = await live.client.swapFillStatus(fill.fillId);
            if (status.state !== "quoted" || status.txid !== undefined)
                throw new Error("swap fill is not an unchanged quote");
        },
    );
    await poll(
        "swap fill settles",
        () => live.client.swapFillStatus(fill.fillId),
        (status) => status.state === "settled" && status.txid === submitted.txid,
        120_000,
    );
    const outpoint = { txid: submitted.txid!, vout: 0 };
    const locked = await poll(
        "receiver-paid advance locks",
        () => live.client.status(quote.quoteId),
        (status) => status.state === "locked",
        120_000,
    );
    expect(locked.outpoint).toEqual(outpoint);

    const { claim, transfer } = await claimFromFeed(live, quote.quoteId, bobAddress, assetId);
    // The feed rebuilds this descriptor from the advances row: the fare's round trip.
    expect(claim.claim!.params.receiverFare).toEqual(covenantFare);
    expect(claim.claim!.params).toEqual(quote.params);
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
    return {
        bob,
        bobAddress,
        minted,
        dust,
        vtxoMinAmount,
        locktime,
        operatorBefore,
        transfer,
        covenant,
        descriptorFare: claim.claim!.params.receiverFare,
        submitAttempts,
    };
}

function evidence(scenario: string, fields: Record<string, unknown>) {
    const value = JSON.parse(
        JSON.stringify({ project: required("TAXI_E2E_PROJECT"), scenario, ...fields }, (_, item) =>
            typeof item === "bigint" ? item.toString() : item,
        ),
    );
    assertArtifactSafe(value);
    writeFileSync(`e2e-artifacts/${scenario}.json`, `${JSON.stringify(value, null, 2)}\n`);
}

async function claimed(fare: Fare) {
    const live = await openLive();
    const bound: { release?: () => Promise<void> } = {};
    try {
        const bobCoin = await freshCoin(live, "receiverSats", BOB_COIN_SATS);
        const carried = await receiverPaidCarrier(live, fare, bound);
        const { bob, minted, dust } = carried;
        const satsFare = fare.currency === "sats" ? fare.units : 0n;
        const assetFare = fare.currency === "asset" ? fare.units : 0n;
        const bobBefore = await walletBalance(bob, minted.assetId);
        const destination = ArkAddress.decode(carried.bobAddress).pkScript;
        const txid = await recycleWith(live, carried.transfer, bobCoin, destination);
        const { tx } = await terminal(live, carried.covenant, "recycled", txid);
        expectReceipt(tx, 0, dust + satsFare, live.info.operatorKey);
        expect(tx.getOutput(1).script).toEqual(destination);
        expect(tx.getOutput(1).amount).toBe(BigInt(BOB_COIN_SATS) - satsFare);
        expect(assetOutputs(tx, minted.assetId)).toEqual(
            assetFare
                ? [
                      [0, assetFare],
                      [1, DELIVERED - assetFare],
                  ]
                : [[1, DELIVERED]],
        );
        const bobAfter = { sats: bobBefore.sats - satsFare, units: DELIVERED - assetFare };
        const bobObserved = await poll(
            "Bob holds the delivery less his fare",
            () => walletBalance(bob, minted.assetId),
            (value) => value.sats === bobAfter.sats && value.units === bobAfter.units,
        );
        expect(bobObserved).toEqual(bobAfter);
        const operatorAfter = { sats: carried.operatorBefore.sats + satsFare, units: assetFare };
        const operatorObserved = await poll(
            "Taxi is repaid its whole loan plus the fare",
            () => walletBalance(live.actors.operator, minted.assetId),
            (value) => value.sats === operatorAfter.sats && value.units === operatorAfter.units,
        );
        expect(operatorObserved).toEqual(operatorAfter);
        expect((await admin("status")).exposure.outstandingSats).toBe("0");
        evidence(`receiver-paid-${fare.currency}-fare-claim`, {
            assetId: minted.assetId,
            transferId: carried.covenant.quote.transferId,
            fillTxid: carried.covenant.lockup.outpoint.txid,
            recycleTxid: txid,
            descriptorFare: carried.descriptorFare,
            recycleOutputs: [0, 1].map((vout) => tx.getOutput(vout).amount),
            recycleAssets: assetOutputs(tx, minted.assetId),
            bobBefore,
            bobObserved,
            operatorBefore: carried.operatorBefore,
            operatorObserved,
            submitAttempts: carried.submitAttempts,
        });
    } finally {
        await bound.release?.();
        await live.close();
    }
}

liveScenario("receiver-paid-sats-fare-claim", () => claimed(SATS_FARE));
liveScenario("receiver-paid-asset-fare-claim", () => claimed(ASSET_FARE));

liveScenario("receiver-paid-mode1-reclaim", async () => {
    const live = await openLive();
    const bound: { release?: () => Promise<void> } = {};
    try {
        const carried = await receiverPaidCarrier(live, SATS_FARE, bound, RECLAIM_AFTER_SECONDS);
        const { minted, dust, vtxoMinAmount } = carried;
        await jumpPast(carried.locktime);
        const recovered = await poll(
            "the sweeper reclaims the unclaimed covenant",
            () => live.client.status(carried.covenant.quote.transferId),
            (value) => value.state === "recovered",
            120_000,
        );
        const { tx } = await terminal(live, carried.covenant, "recovered", recovered.spentTxid!);
        const bobKey = hex.encode(ArkAddress.decode(carried.bobAddress).vtxoTaprootKey);
        expectReceipt(tx, 0, dust - vtxoMinAmount, live.info.operatorKey);
        expectReceipt(tx, 1, vtxoMinAmount, bobKey);
        expect(assetOutputs(tx, minted.assetId)).toEqual([[1, DELIVERED]]);
        const { vtxos } = await live.indexer.getVtxos({
            outpoints: [{ txid: recovered.spentTxid!, vout: 1 }],
        });
        expect(vtxos).toHaveLength(1);
        expect(vtxos[0]).toMatchObject({
            value: Number(vtxoMinAmount),
            assets: [{ assetId: minted.assetId, amount: DELIVERED }],
        });
        const operatorAfter = { sats: carried.operatorBefore.sats - vtxoMinAmount, units: 0n };
        const operatorObserved = await poll(
            "Taxi recovers its loan less Bob's receipt, and no fare",
            () => walletBalance(live.actors.operator, minted.assetId),
            (value) => value.sats === operatorAfter.sats && value.units === operatorAfter.units,
            120_000,
        );
        expect(operatorObserved).toEqual(operatorAfter);
        expect((await admin("status")).exposure.outstandingSats).toBe("0");
        evidence("receiver-paid-mode1-reclaim", {
            assetId: minted.assetId,
            transferId: carried.covenant.quote.transferId,
            fillTxid: carried.covenant.lockup.outpoint.txid,
            recoveryTxid: recovered.spentTxid,
            locktime: carried.locktime,
            descriptorFare: carried.descriptorFare,
            recoveryOutputs: [0, 1].map((vout) => tx.getOutput(vout).amount),
            recoveryAssets: assetOutputs(tx, minted.assetId),
            bobReceipt: { value: vtxos[0]!.value, assets: vtxos[0]!.assets },
            operatorBefore: carried.operatorBefore,
            operatorObserved,
            submitAttempts: carried.submitAttempts,
        });
    } finally {
        await bound.release?.();
        await live.close();
    }
});
