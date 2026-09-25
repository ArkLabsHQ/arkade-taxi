import { expect } from "vitest";
import { base64, hex } from "@scure/base";
import {
    ArkAddress,
    Extension,
    RestArkProvider,
    RestEmulatorProvider,
    Transaction,
    asset,
    selectCoinsWithAsset,
    toXOnly,
    type ExtendedVirtualCoin,
} from "@arkade-os/sdk";
import { createOffer, decodeOffer, type FillFunding } from "@arkade-os/swap";
import {
    buildOfferFillPlan,
    prepareJointSubmission,
    providerCosignerKey,
    signJointGraphForOwner,
    submitJointFill,
    tapScriptSigEntries,
} from "@arkade-taxi/client";
import { liveScenario } from "./scenarios.js";
import { openLive, poll, required, walletBalance } from "./fixtures.js";

const WANT_UNITS = 1_000n;
const FARE_UNITS = 100n;
const ISSUE_UNITS = 10_000n;
const DEPOSIT_SATS = 5_000;
const OWNER_SATS = 20_000;
const CONTRIBUTION_SATS = 500n;
const FARE_CARRIER_SATS = 330;

const toFunding = (coin: ExtendedVirtualCoin): FillFunding => ({
    txid: coin.txid,
    vout: coin.vout,
    value: coin.value,
    tapLeafScript: coin.forfeitTapLeafScript,
    tapTree: coin.tapTree,
    ...(coin.assets !== undefined
        ? { assets: coin.assets.map(({ assetId, amount }) => ({ assetId, amount })) }
        : {}),
});

liveScenario("joint-fill-two-owner", async () => {
    const live = await openLive();
    // The service spends the operator wallet concurrently, so a fixture actor
    // plays the sponsor: the invariant is the two-owner signature partition.
    const maker = live.actors.receiverWithAsset;
    const solver = live.actors.sender;
    const sponsor = live.actors.receiverSats;
    const arkdUrl = required("TAXI_E2E_ARKD_URL");
    // Fixture leftovers carry other assets, so the sponsor is funded fresh. The
    // maker pays: a solver send would spend the coin holding its own issuance.
    const freshSats = async (actor: (typeof live.actors)[string]) => {
        const txid = await maker.wallet.send({
            address: await actor.wallet.getAddress(),
            amount: OWNER_SATS,
        });
        return poll(
            "fresh asset-free fill funding",
            async () =>
                (await actor.wallet.getSpendableVtxos({ withRecoverable: false })).find(
                    (coin) =>
                        coin.txid === txid && coin.value === OWNER_SATS && !coin.assets?.length,
                ),
            (coin) => coin !== undefined,
            120_000,
        ).then((coin) => coin!);
    };
    try {
        const sponsorCoin = await freshSats(sponsor);
        const minted = await solver.wallet.assetManager.issue({
            amount: ISSUE_UNITS,
            metadata: { decimals: 0, name: "Taxi Fill", ticker: "TFILL" },
        });
        const wantAsset = asset.AssetId.fromString(minted.assetId);
        const solverCoins = await poll(
            "solver holds the offered asset",
            () => solver.wallet.getSpendableVtxos({ withRecoverable: false }),
            (coins) =>
                coins.reduce(
                    (sum, coin) =>
                        sum +
                        (coin.assets ?? [])
                            .filter((held) => held.assetId === minted.assetId)
                            .reduce((amount, held) => amount + held.amount, 0n),
                    0n,
                ) >=
                WANT_UNITS + FARE_UNITS,
            120_000,
        );
        const { selected: solverFund } = selectCoinsWithAsset(
            solverCoins,
            minted.assetId,
            WANT_UNITS + FARE_UNITS,
        );
        const offer = await createOffer(maker.wallet, arkdUrl, {
            wantAmount: WANT_UNITS,
            wantAsset,
        });
        const fundingTxid = await maker.wallet.send({
            address: offer.address,
            amount: DEPOSIT_SATS,
            extensions: [offer.extension],
        });
        const offerScript = hex.encode(offer.swapPkScript);
        await poll(
            "indexed offer deposit",
            () => live.indexer.getVtxos({ scripts: [offerScript] }),
            ({ vtxos }) => vtxos.some((coin) => coin.txid === fundingTxid),
            120_000,
        );
        const sponsorScript = ArkAddress.decode(await sponsor.wallet.getAddress()).pkScript;
        const solverScript = ArkAddress.decode(await solver.wallet.getAddress()).pkScript;
        const expected = await buildOfferFillPlan(solver.wallet, arkdUrl, offer.offerHex, {
            fund: solverFund.map(toFunding),
            payoutScript: solverScript,
            swapAddress: offer.address,
            sponsor: {
                fund: [toFunding(sponsorCoin)],
                netContributionSats: CONTRIBUTION_SATS,
                fare: {
                    assetId: minted.assetId,
                    amount: FARE_UNITS,
                    script: sponsorScript,
                    sats: FARE_CARRIER_SATS,
                },
                changeScript: sponsorScript,
            },
        });
        const afterSolver = await signJointGraphForOwner({
            expected,
            owner: "solver",
            bindings: solverFund.map((_, index) => ({
                inputIndex: 1 + index,
                identity: solver.identity,
            })),
        });
        const complete = await signJointGraphForOwner({
            expected,
            partial: afterSolver,
            owner: "sponsor",
            bindings: [{ inputIndex: 1 + solverFund.length, identity: sponsor.identity }],
        });
        const [makerBefore, solverBefore, sponsorBefore] = await Promise.all([
            walletBalance(maker, minted.assetId),
            walletBalance(solver, minted.assetId),
            walletBalance(sponsor, minted.assetId),
        ]);
        const settled = Transaction.fromPSBT(base64.decode(expected.arkTx));
        const solverPayoutSats = Array.from({ length: settled.outputsLength }, (_, index) =>
            settled.getOutput(index),
        ).find(
            (output) => output.script && hex.encode(output.script) === hex.encode(solverScript),
        )!.amount!;
        const solverDelta =
            solverPayoutSats - solverFund.reduce((sum, coin) => sum + BigInt(coin.value), 0n);
        const ownerKeys = {
            solver: [hex.encode(await solver.identity.xOnlyPublicKey())],
            sponsor: [hex.encode(await sponsor.identity.xOnlyPublicKey())],
        };
        const prepared = prepareJointSubmission({ expected, partial: complete, ownerKeys });
        const arkInfo = await new RestArkProvider(arkdUrl).getInfo();
        const pins = {
            emulatorXOnly: hex.encode(decodeOffer(hex.decode(offer.offerHex)).emulatorPubkey),
            serverXOnly: arkInfo.signerPubkey,
        };
        const { txid, signedArkTx } = await submitJointFill({
            expected,
            prepared,
            provider: new RestEmulatorProvider(required("TAXI_E2E_EMULATOR_URL")),
            pins,
            ownerKeys,
        });
        expect(txid).toBe(prepared.txid);
        const submitted = Transaction.fromPSBT(base64.decode(prepared.arkTx));
        expect(Extension.fromTx(submitted).getAssetPacket()).toBeDefined();
        const tweaked = providerCosignerKey({ expected, emulatorXOnly: pins.emulatorXOnly });
        const serverKey = hex.encode(toXOnly(hex.decode(pins.serverXOnly), "pin"));
        const covenantSigners = tapScriptSigEntries(
            Transaction.fromPSBT(base64.decode(signedArkTx)),
            0,
        ).map((entry) => entry.pubKeyHex);
        expect(covenantSigners.length).toBeGreaterThan(0);
        expect(covenantSigners.filter((key) => key !== tweaked && key !== serverKey)).toEqual([]);
        await poll(
            "maker receives the asset it asked for",
            () => walletBalance(maker, minted.assetId),
            (balance) => balance.units === makerBefore.units + WANT_UNITS,
            120_000,
        );
        await poll(
            "the sponsor receives its asset fare",
            () => walletBalance(sponsor, minted.assetId),
            (balance) => balance.units === sponsorBefore.units + FARE_UNITS,
            120_000,
        );
        const solverAfter = {
            sats: solverBefore.sats + solverDelta,
            units: solverBefore.units - WANT_UNITS - FARE_UNITS,
        };
        expect(
            await poll(
                "the solver pays exactly the want, the fare and its planned sats",
                () => walletBalance(solver, minted.assetId),
                (balance) =>
                    balance.units === solverAfter.units && balance.sats === solverAfter.sats,
                120_000,
            ),
        ).toEqual(solverAfter);
    } finally {
        await live.close();
    }
});
