import { createHash } from "node:crypto";
import { ArkAddress, Transaction, asset, type ExtendedVirtualCoin } from "@arkade-os/sdk";
import { base64, hex } from "@scure/base";
import type { Advance, FareSpec } from "@arkade-taxi/core";
import { DustCovenantScript } from "@arkade-taxi/covenant";
import {
    AdvanceRepository,
    openDatabase,
    PolicyRepository,
    ReceiveQuoteRepository,
    ReservationRepository,
    SwapFillRepository,
    type Database,
    type SwapFill,
} from "@arkade-taxi/db";
import type { SwapFillQuoteResponse } from "@arkade-taxi/protocol";
import type { RuntimeConfig } from "../src/config.js";
import { operatorFundingInput } from "../src/arkade/lockupBuilder.js";
import { encodeJointFillSource, type JointFillFundingSource } from "../src/arkade/fundingSource.js";
import { createSwapFillQuote } from "../src/swapFillQuotes.js";
import {
    config,
    fundingCoin,
    NOW,
    policy as basePolicy,
    receiverKey,
    runtimeSafety,
    serverUnroll,
} from "./fixtures.js";
import { FakeSwapFillGraphBuilder, fakeOfferTerms } from "./swapFillFixtures.js";

export const BOUND_DEPOSIT = { txid: "dd".repeat(32), vout: 3 };
export const BOUND_SOLVER = { txid: "ee".repeat(32), vout: 1 };
export const BOUND_TAXI = { txid: "cc".repeat(32), vout: 0 };

const DISPLAY_ASSET = "1234".repeat(16);
const WANTED_ASSET = {
    txid: Uint8Array.from(hex.decode(DISPLAY_ASSET)).reverse(),
    groupIndex: 0,
};
const WANTED_SWAP_ID = asset.AssetId.create(DISPLAY_ASSET, 0).toString();
const WANT_UNITS = 5n;
const LOAN = 329n;
const FARE = 4n;

export interface BoundJointFill {
    db: Database;
    config: RuntimeConfig;
    quote: SwapFillQuoteResponse;
    fill: SwapFill;
    advance: Advance;
    advances: AdvanceRepository;
    swapFills: SwapFillRepository;
    receiveQuotes: ReceiveQuoteRepository;
    close(): void;
}

const key = (o: { txid: string; vout: number }): string => `${o.txid}:${o.vout}`;

/**
 * Drives the real quote path end to end so the bound advance carries a genuine
 * `taxi-source:` graph and recovery preflight. Nothing downstream of a bound
 * fill can be exercised against a hand-written source: both the signing gate and
 * the startup invariant rebuild the recovery intent from these exact bytes.
 */
export async function createBoundJointFill(
    over: {
        validUntil?: number;
        receiverFare?: { currency: "sats"; units: bigint } | { currency: "asset"; units: bigint };
    } = {},
): Promise<BoundJointFill> {
    const db = openDatabase(":memory:");
    try {
        const cfg = config({ vtxoMinAmount: 1n });
        const policies = new PolicyRepository(db);
        const base = basePolicy();
        policies.update(
            {
                ...base,
                assetRules: [
                    ...base.assetRules,
                    {
                        assetId: WANTED_ASSET,
                        enabled: true,
                        claim: "either",
                        maxTopupSats: null,
                        fares: [
                            {
                                id: "receive",
                                currency: { kind: "sats" },
                                pricing: { kind: "flat", units: FARE },
                            },
                        ],
                    },
                ],
            },
            "test",
        );
        const revision = policies.getSnapshot().revision;
        const quotes = new ReceiveQuoteRepository(db);
        const swapFills = new SwapFillRepository(db);
        const advances = new AdvanceRepository(db);
        const operatorCoin = fundingCoin({ ...BOUND_TAXI, value: 20_000 });
        const depositCoin = fundingCoin({ ...BOUND_DEPOSIT, value: 10_000 });
        const solverCoin = fundingCoin({
            ...BOUND_SOLVER,
            value: 6_000,
            assets: [{ assetId: WANTED_SWAP_ID, amount: WANT_UNITS }],
        });
        const makerKey = new Uint8Array(32).fill(9);
        const receiverPaid = over.receiverFare !== undefined;
        const loan = receiverPaid ? 330n : LOAN;
        const topLevelReceiverFare: FareSpec | undefined =
            over.receiverFare === undefined
                ? undefined
                : over.receiverFare.currency === "asset"
                  ? { currency: "asset", assetId: WANTED_ASSET, units: over.receiverFare.units }
                  : over.receiverFare;
        const params = {
            receiverKey,
            senderKey: makerKey,
            operatorKey: cfg.operatorKey,
            dust: 330n,
            topup: loan,
            assetId: WANTED_ASSET,
            locktime: 899_856n,
            claimMode: "recycle" as const,
            recoveryRecipient: "receiver" as const,
            ...(over.receiverFare === undefined ? {} : { receiverFare: over.receiverFare }),
        };
        const covenant = new DustCovenantScript({
            serverKey: cfg.serverPubkey,
            emulatorKey: cfg.emulatorPubkey,
            vtxoMinAmount: cfg.vtxoMinAmount,
            params,
        });
        quotes.insert({
            quote: {
                id: "receive-1",
                state: "quoted",
                receiverAddress: new ArkAddress(
                    cfg.serverPubkey,
                    receiverKey,
                    cfg.addressHrp,
                ).encode(),
                makerPublicKey: hex.encode(makerKey),
                params,
                covenantAddress: covenant.address(cfg.addressHrp, cfg.serverPubkey).encode(),
                fare: { currency: "sats", units: receiverPaid ? 0n : FARE },
                ...(receiverPaid
                    ? { payer: "receiver" as const, receiverFare: topLevelReceiverFare! }
                    : {}),
                batchExpiry: { kind: "height", value: 900_000n },
                inputExpiryFloor: { kind: "height", value: 900_000n },
                recoveryLocktime: { kind: "height", value: 899_856n },
                loanSats: loan,
                createdAt: NOW,
                expiresAt: NOW + 60,
                policyRevision: revision,
                operatorInputs: [operatorFundingInput(operatorCoin)],
            },
            expectedPolicyRevision: revision,
            recoveryExecutionBudget: { kind: "height", value: 72n },
        });
        const indexed = new Map<string, ExtendedVirtualCoin>([
            [key(depositCoin), depositCoin],
            [key(solverCoin), solverCoin],
        ]);
        const quote = await createSwapFillQuote(
            {
                runtime: {
                    assertAdmission: async () => {},
                    withAdmission: async (work) => work(() => {}),
                    safety: () => runtimeSafety(),
                },
                policy: policies,
                advances,
                reservations: new ReservationRepository(db),
                swapFills,
                receiveQuotes: quotes,
                inventory: {
                    getSpendableVtxos: async () => [operatorCoin],
                    getLockedVtxoOutpoints: async () => [],
                },
                senderInventory: {
                    getVtxos: async (opts) => ({
                        vtxos:
                            opts?.outpoints?.map((o) => indexed.get(key(o))!).filter(Boolean) ?? [],
                    }),
                },
                config: cfg,
                now: () => NOW,
                nowMs: () => NOW * 1000,
                randomId: () => "fill-1",
                swapFillBuilder: new FakeSwapFillGraphBuilder(
                    hex.encode(covenant.pkScript),
                    params.dust,
                    { id: WANTED_SWAP_ID, amount: WANT_UNITS },
                ),
                offerCodec: {
                    decodeOffer: () =>
                        fakeOfferTerms({
                            covenantScript: hex.decode(depositCoin.script),
                            makerProceedsScript: covenant.pkScript,
                            makerPublicKey: makerKey,
                            wantAsset: WANTED_ASSET,
                            wantAmount: WANT_UNITS,
                        }),
                },
                providerLimits: async () => ({ vtxoMaxAmount: 10_000_000n }),
                getServerUnroll: () => serverUnroll,
            },
            {
                operationId: "op-1",
                offerHex: "ab12",
                receiveQuoteId: "receive-1",
                solverInputs: [
                    {
                        txid: BOUND_SOLVER.txid,
                        vout: BOUND_SOLVER.vout,
                        value: "6000",
                        assets: [
                            {
                                assetId: {
                                    txid: hex.encode(WANTED_ASSET.txid),
                                    groupIndex: WANTED_ASSET.groupIndex,
                                },
                                amount: WANT_UNITS.toString(10),
                            },
                        ],
                    },
                ],
                solverProceedsScript: "51",
                solverKeys: ["ab".repeat(32)],
                contributionSats: loan.toString(10),
                maxFare: { currency: "sats", units: receiverPaid ? "0" : "30" },
                fundingTxid: BOUND_DEPOSIT.txid,
                fundingVout: BOUND_DEPOSIT.vout,
                ...(over.validUntil === undefined ? {} : { validUntil: over.validUntil }),
            },
        );
        return {
            db,
            config: cfg,
            quote,
            fill: swapFills.get(quote.fillId)!,
            advance: advances.get("receive-1")!,
            advances,
            swapFills,
            receiveQuotes: quotes,
            close: () => db.close(),
        };
    } catch (cause) {
        db.close();
        throw cause;
    }
}

const SOURCE_PREFIX = "taxi-source:";

export function patchJointSource(
    advance: Advance,
    patch: (source: JointFillFundingSource) => void,
): Advance {
    const source = JSON.parse(
        advance.unsignedLockupTx.slice(SOURCE_PREFIX.length),
    ) as JointFillFundingSource;
    patch(source);
    return { ...advance, unsignedLockupTx: encodeJointFillSource(source) };
}

/** A self-consistent preflight that no advance in this repository rebuilds to. */
export function foreignRecoveryPreflight(): JointFillFundingSource["recoveryPreflight"] {
    const tx = new Transaction({ version: 3 });
    tx.addInput({ txid: "77".repeat(32), index: 0 });
    tx.addOutput({ script: new Uint8Array([0x51]), amount: 1n });
    const arkTx = base64.encode(tx.toPSBT());
    const checkpoints: string[] = [];
    return {
        digest: createHash("sha256").update(JSON.stringify({ arkTx, checkpoints })).digest("hex"),
        expectedTxid: tx.id,
        arkTx,
        checkpoints,
    };
}
