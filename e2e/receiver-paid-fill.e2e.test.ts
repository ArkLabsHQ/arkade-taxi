import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import { expect } from "vitest";
import {
    ArkAddress,
    Extension,
    SingleKey,
    Transaction,
    VtxoScript,
    asset,
    scriptFromTapLeafScript,
    type ExtendedVirtualCoin,
} from "@arkade-os/sdk";
import { createOffer } from "@arkade-os/swap";
import { buildOfferFillPlan, sealFillGraph } from "@arkade-taxi/client";
import { base64, hex } from "@scure/base";
import { loadConfig } from "../packages/app/src/config.js";
import { assertArtifactSafe } from "../scripts/lib/harness.mjs";
import { ownCleanup } from "../scripts/lib/scenario-cleanup.mjs";
import { preEffectRequest } from "./admission.js";
import { liveScenario } from "./scenarios.js";
import {
    admin,
    artifactPath,
    claimFromFeed,
    expectReceipt,
    freshCoin,
    fundingOf,
    openLive,
    poll,
    ready,
    recycleWith,
    releaseBound,
    required,
    terminal,
    walletBalance,
    type Live,
    type Locked,
} from "./fixtures.js";

const DELIVERED = 1_000n;
const ISSUED = 10_000n;
const DEPOSIT_SATS = 5_000;
const BOB_COIN_SATS = 1_000;
const SATS_FARE = 7n;

const deadlineSeconds = () => loadConfig(process.env).covenantDeadlineSeconds;
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
const txOf = (psbt: string): Transaction => Transaction.fromPSBT(base64.decode(psbt));
const psbtOf = (tx: Transaction): string => base64.encode(tx.toPSBT());
const sigCount = (tx: Transaction, index: number): number =>
    tx.getInput(index).tapScriptSig?.length ?? 0;

function evidence(scenario: string, fields: Record<string, unknown>) {
    const value = JSON.parse(
        JSON.stringify({ project: required("TAXI_E2E_PROJECT"), scenario, ...fields }, (_, item) =>
            typeof item === "bigint" ? item.toString() : item,
        ),
    );
    assertArtifactSafe(value);
    writeFileSync(artifactPath(`${scenario}.json`), `${JSON.stringify(value, null, 2)}\n`);
}

/**
 * The quote, the offer deposit and the solver's asset: everything both
 * scenarios need before they build a graph of their own. Returns the pieces a
 * caller needs to perform the role the solver will.
 */
async function quotedFill(live: Live, bound: { release?: () => Promise<void> }) {
    const maker = live.actors.receiverWithAsset;
    const solver = live.actors.sender;
    const bob = live.actors.receiverSats;
    const operator = live.actors.operator;
    const dust = BigInt(live.info.dust);
    const minted = await solver.wallet.assetManager.issue({
        amount: ISSUED,
        metadata: { decimals: 0, name: "Taxi Generic Fill", ticker: "TGFL" },
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
    const floor = [
        ...(await maker.wallet.getSpendableVtxos({ withRecoverable: false })),
        ...solverFund,
        ...(await operator.wallet.getSpendableVtxos({ withRecoverable: false })).filter(
            (coin) => !coin.assets?.length,
        ),
    ].reduce((min, coin) => (expiryOf(coin) < min ? expiryOf(coin) : min), 2n ** 53n);
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
        assetRules: [
            rule(null, {
                id: "sats",
                currency: { kind: "sats" },
                pricing: { kind: "flat", units: "0" },
            }),
            rule(wireAssetId, {
                id: "receiver-sats",
                currency: { kind: "sats" },
                pricing: { kind: "flat", units: SATS_FARE.toString() },
            }),
        ],
    });

    const bobAddress = await bob.wallet.getAddress();
    const makerKey = await maker.identity.xOnlyPublicKey();
    await ready(Math.floor(Date.now() / 1000));
    const before = BigInt(Math.floor(Date.now() / 1000));
    const { verified } = await preEffectRequest(
        () =>
            live.client.requestVerifiedReceiveQuote({
                receiverAddress: bobAddress,
                senderKey: makerKey,
                assetId,
                fareId: "receiver-sats",
                fundingExpiry: { kind: "time", value: floor },
                payer: "receiver",
                trustedServerKey: hex.decode(live.info.serverKey),
                trustedEmulatorKey: hex.decode(live.info.emulatorKey),
                dust,
                vtxoMinAmount: BigInt(live.info.vtxoMinAmount),
                hrp: "tark",
                expect: {
                    maxServiceFareSats: 0n,
                    minRecoveryLocktime: { kind: "time", value: before + deadlineSeconds() },
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
    // Phase 3's publication is what lets a builder construct the sponsor leg at
    // all: without it the caller would have to reverse-engineer the Taxi's
    // funding out of quoted checkpoints, which is what the solver does today.
    expect(quote.operatorInputs.length).toBeGreaterThan(0);
    expect(quote.operatorScript).toMatch(/^5120[0-9a-f]{64}$/);

    const offer = await createOffer(maker.wallet, required("TAXI_E2E_ARKD_URL"), {
        wantAmount: DELIVERED,
        wantAsset: sdkAssetId,
        receiveAddress: quote.covenantAddress,
    });
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

    // The caller builds the graph itself, with the Taxi's published coins and
    // script as the sponsor leg: the role the intent-solver will perform.
    const operatorInputs = quote.operatorInputs.map((input) => {
        const tapTree = hex.decode(input.tapTree);
        const tree = VtxoScript.decode(tapTree);
        return {
            txid: input.txid,
            vout: input.vout,
            value: Number(input.value),
            tapTree,
            tapLeafScript: tree.findLeaf(input.spendLeaf),
        };
    });
    const graph = await buildOfferFillPlan(
        solver.wallet,
        required("TAXI_E2E_ARKD_URL"),
        offer.offerHex,
        {
            fund: solverFund.map((coin) => ({
                txid: coin.txid,
                vout: coin.vout,
                value: coin.value,
                tapTree: coin.tapTree,
                tapLeafScript: coin.forfeitTapLeafScript,
                assets: (coin.assets ?? []).map((held) => ({
                    assetId: held.assetId,
                    amount: held.amount,
                })),
            })),
            fundingTxid: deposit.txid,
            fundingOutpoint: { txid: deposit.txid, vout: deposit.vout },
            sponsor: {
                fund: operatorInputs,
                netContributionSats: BigInt(quote.params.topup),
                changeScript: hex.decode(quote.operatorScript),
            },
        },
    );
    const taxiInputIndexes = graph.inputOwners.flatMap((owner, index) =>
        owner === "sponsor" ? [index] : [],
    );
    expect(taxiInputIndexes).toHaveLength(operatorInputs.length);
    return {
        live,
        bob,
        bobAddress,
        solver,
        minted,
        assetId,
        wireAssetId,
        dust,
        quote,
        graph,
        taxiInputIndexes,
        bound,
    };
}

/** Signs every input the caller owns: its own asset coins, and the offer
 * covenant's collaborative leaf. The Taxi's inputs are left untouched. */
async function signAsCaller(
    quoted: Awaited<ReturnType<typeof quotedFill>>,
    options: { underSign?: boolean } = {},
) {
    const { graph, taxiInputIndexes, solver } = quoted;
    const mine = graph.inputOwners.flatMap((owner, index) =>
        taxiInputIndexes.includes(index) ? [] : [index],
    );
    const signable = options.underSign ? mine.slice(0, Math.max(0, mine.length - 1)) : mine;
    let arkTx = txOf(graph.arkTx);
    const checkpoints = graph.checkpoints.map((psbt) => txOf(psbt));
    for (const index of signable) {
        arkTx = Transaction.fromPSBT((await solver.identity.sign(arkTx.clone(), [index])).toPSBT());
        checkpoints[index] = Transaction.fromPSBT(
            (await solver.identity.sign(checkpoints[index]!.clone(), [0])).toPSBT(),
        );
    }
    return {
        arkTx: psbtOf(arkTx),
        checkpoints: checkpoints.map(psbtOf),
        signed: signable,
        unsigned: mine.filter((index) => !signable.includes(index)),
    };
}

liveScenario("receiver-paid-fill-claim", async () => {
    const live = await openLive();
    const bound: { release?: () => Promise<void> } = {};
    try {
        const bobCoin = await freshCoin(live, "receiverSats", BOB_COIN_SATS);
        const quoted = await quotedFill(live, bound);
        const { quote, graph, taxiInputIndexes, bobAddress, assetId, dust, minted, bob } = quoted;
        const operatorBefore = await walletBalance(live.actors.operator, minted.assetId);
        const posted = await signAsCaller(quoted);
        expect(posted.unsigned).toEqual([]);
        for (const index of taxiInputIndexes) expect(sigCount(txOf(posted.arkTx), index)).toBe(0);

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
        live.owned.set(quote.quoteId, {});
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
        expect((await live.client.fillStatus(submitted.fillId)).txid).toBe(submitted.txid);

        // What the providers actually signed, read off the settled transaction.
        const settled = await poll(
            "settled fill transaction",
            async () =>
                (await live.indexer.getVirtualTxs([submitted.txid!])).txs.find(
                    (psbt) => psbt.length > 0,
                ),
            (psbt) => psbt !== undefined,
            120_000,
        ).then((psbt) => txOf(psbt!));
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
        const operatorAfter = await walletBalance(live.actors.operator, minted.assetId);
        const bobAfter = await walletBalance(bob, minted.assetId);
        expect(bobAfter.units - bobBefore.units).toBe(DELIVERED);

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
            recycleTxid: txid,
        });
    } finally {
        if (bound.release) await bound.release();
    }
});

/**
 * The claim phase 7 gates on: with `assertSolverAuthorised` deleted, nothing
 * pins the caller's keys, so an under-signed foreign input must fail the whole
 * submission rather than move anything. This posts a graph with its last
 * caller-owned input deliberately unsigned and records exactly what the
 * provider answered.
 */
liveScenario("fill-undersigned-foreign-input", async () => {
    const live = await openLive();
    const bound: { release?: () => Promise<void> } = {};
    const observed: Record<string, unknown> = {};
    try {
        const quoted = await quotedFill(live, bound);
        const { quote, taxiInputIndexes } = quoted;
        const posted = await signAsCaller(quoted, { underSign: true });
        expect(posted.unsigned.length).toBeGreaterThan(0);
        observed.signedInputs = posted.signed;
        observed.unsignedInputs = posted.unsigned;
        observed.operatorInputs = quote.operatorInputs.map(({ txid, vout }) => ({ txid, vout }));

        const reservedBefore = await Promise.all(
            quote.operatorInputs.map(async ({ txid, vout }) => {
                const found = (await live.indexer.getVtxos({ outpoints: [{ txid, vout }] })).vtxos;
                return { txid, vout, spent: found[0]?.isSpent === true, present: found.length };
            }),
        );
        observed.reservedBefore = reservedBefore;

        const refusal = await live.client
            .submitFill({
                operationId: randomUUID(),
                quoteId: quote.quoteId,
                arkTx: posted.arkTx,
                checkpoints: posted.checkpoints,
                taxiInputIndexes,
                covenantOutputIndex: 0,
                assetUnits: DELIVERED,
            })
            .then(
                (value) => ({ accepted: true, value }) as const,
                (error: unknown) => ({ accepted: false, error }) as const,
            );
        observed.accepted = refusal.accepted;
        if (!refusal.accepted) {
            const error = refusal.error as { code?: string; status?: number; message?: string };
            observed.refusal = {
                code: error.code,
                status: error.status,
                message: error.message,
            };
        } else observed.submitted = refusal.value;

        // Whatever the Taxi answered, no Taxi coin may have moved.
        const reservedAfter = await Promise.all(
            quote.operatorInputs.map(async ({ txid, vout }) => {
                const found = (await live.indexer.getVtxos({ outpoints: [{ txid, vout }] })).vtxos;
                return {
                    txid,
                    vout,
                    spent: found[0]?.isSpent === true,
                    spentBy: found[0]?.spentBy ?? null,
                    arkTxId: found[0]?.arkTxId ?? null,
                };
            }),
        );
        observed.reservedAfter = reservedAfter;
        const quoteAfter = await live.client.getReceiveQuote(quote.quoteId);
        observed.quoteState = quoteAfter.state;
        observed.advance = await live.client.status(quote.quoteId).then(
            (status) => ({ state: status.state, outpoint: status.outpoint ?? null }),
            () => null,
        );
        observed.advanceRow =
            (await admin("advances")).advances.find((row: any) => row.id === quote.quoteId) ?? null;

        expect(refusal.accepted).toBe(false);
        for (const coin of reservedAfter) {
            expect(coin.spent).toBe(false);
            expect(coin.arkTxId).toBeFalsy();
        }
        if (quoteAfter.state === "bound")
            bound.release = ownCleanup(() => releaseBound(live, quote.quoteId, async () => {}));
    } finally {
        evidence("fill-undersigned-foreign-input", observed);
        if (bound.release) await bound.release();
    }
});
