/**
 * What both `/v1/fills` scenarios need before either builds a graph: the quote,
 * the offer deposit, and a caller that signs its own inputs. Kept out of the
 * test files so the shared-stack scenario and the isolated one share one copy.
 */
import { writeFileSync } from "node:fs";
import { expect } from "vitest";
import { Transaction, VtxoScript, asset, type ExtendedVirtualCoin } from "@arkade-os/sdk";
import { buildOfferFillPlan, createOffer } from "@arkade-os/swap";
import { base64, hex } from "@scure/base";
import { loadConfig } from "../packages/app/src/config.js";
import { assertArtifactSafe } from "../scripts/lib/harness.mjs";
import { ownCleanup } from "../scripts/lib/scenario-cleanup.mjs";
import { preEffectRequest } from "./admission.js";
import { admin, artifactPath, fundingOf, poll, ready, required, type Live } from "./fixtures.js";

export const DELIVERED = 1_000n;
export const ISSUED = 10_000n;
export const DEPOSIT_SATS = 5_000;
export const BOB_COIN_SATS = 1_000;
export const SATS_FARE = 7n;

const deadlineSeconds = () => loadConfig(process.env).covenantDeadlineSeconds;
const readyUrl = () => `${required("TAXI_E2E_BASE_URL")}/ready`;
const expiryOf = (coin: ExtendedVirtualCoin): bigint => fundingOf(coin).expiry.value;
const unitsOf = (coin: ExtendedVirtualCoin, assetId: string): bigint =>
    (coin.assets ?? [])
        .filter((held) => held.assetId === assetId)
        .reduce((sum, held) => sum + held.amount, 0n);

export const taxiAssetId = (id: string) => {
    const parsed = asset.AssetId.fromString(id);
    return { txid: Uint8Array.from(parsed.txid).reverse(), groupIndex: parsed.groupIndex };
};
export const txOf = (psbt: string): Transaction => Transaction.fromPSBT(base64.decode(psbt));
export const psbtOf = (tx: Transaction): string => base64.encode(tx.toPSBT());
export const sigCount = (tx: Transaction, index: number): number =>
    tx.getInput(index).tapScriptSig?.length ?? 0;

export function evidence(scenario: string, fields: Record<string, unknown>) {
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
export async function quotedFill(live: Live) {
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
    };
}

/**
 * Signs only the inputs the caller holds the key for: its own asset coins. The
 * Taxi's inputs stay unsigned because the Taxi signs last, and the offer
 * covenant stays unsigned because only the emulator may sign that one.
 */
export async function signAsCaller(
    quoted: Awaited<ReturnType<typeof quotedFill>>,
    options: { underSign?: boolean } = {},
) {
    const { graph, solver } = quoted;
    const mine = graph.inputOwners.flatMap((owner, index) => (owner === "solver" ? [index] : []));
    if (mine.length === 0) throw new Error("fill graph assigns the caller no input to sign");
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
