import { createHash } from "node:crypto";
import {
    ArkAddress,
    Transaction,
    VtxoScript,
    asset,
    type ExtendedVirtualCoin,
} from "@arkade-os/sdk";
import { base64, hex } from "@scure/base";
import type { Advance, FareSpec } from "@arkade-taxi/core";
import { DustCovenantScript, type ReceiverFare } from "@arkade-taxi/covenant";
import {
    AdvanceRepository,
    openDatabase,
    PolicyRepository,
    ReceiveQuoteRepository,
    ReservationRepository,
    FillRepository,
    type Database,
    type Fill,
} from "@arkade-taxi/db";
import type { RuntimeConfig } from "../src/config.js";
import { operatorFundingInput } from "../src/arkade/lockupBuilder.js";
import { encodeFillSource, type FillFundingSource } from "../src/arkade/fundingSource.js";
import { buildRecoveryIntent } from "../src/arkade/recovery.js";
import {
    config,
    fundingCoin,
    NOW,
    policy as basePolicy,
    receiverKey,
    runtimeSafety,
    serverUnroll,
} from "./fixtures.js";
import { checkpointSpending, sealGraph, solverCoin } from "./graphFixtures.js";
import { scriptFromTapLeafScript, Extension, P2A } from "@arkade-os/sdk";
import { normalizeExpiry } from "../src/arkade/providers.js";

export const BOUND_DEPOSIT = { txid: "dd".repeat(32), vout: 3 };
export const BOUND_SOLVER = { txid: "ee".repeat(32), vout: 1 };
export const BOUND_TAXI = { txid: "cc".repeat(32), vout: 0 };

const DISPLAY_ASSET = "1234".repeat(16);
export const WANTED_ASSET = {
    txid: Uint8Array.from(hex.decode(DISPLAY_ASSET)).reverse(),
    groupIndex: 0,
};
export const WANTED_SWAP_ID = asset.AssetId.create(DISPLAY_ASSET, 0).toString();
const WANT_UNITS = 5n;
const FARE = 4n;

export interface BoundJointFill {
    db: Database;
    config: RuntimeConfig;
    fill: Fill;
    advance: Advance;
    advances: AdvanceRepository;
    fills: FillRepository;
    receiveQuotes: ReceiveQuoteRepository;
    close(): void;
}

export interface InsertedReceiveQuote {
    db: Database;
    cfg: RuntimeConfig;
    quoteId: string;
    policies: PolicyRepository;
    quotes: ReceiveQuoteRepository;
    fills: FillRepository;
    advances: AdvanceRepository;
    reservations: ReservationRepository;
    covenant: DustCovenantScript;
    operatorCoin: ExtendedVirtualCoin;
    depositCoin: ExtendedVirtualCoin;
    makerKey: Uint8Array;
    loan: bigint;
    receiverPaid: boolean;
}

/**
 * Opens a fresh in-memory database, or fills `db`, and inserts a live "quoted" receive quote
 * through the real repository — the setup every test that binds one, sender- or
 * receiver-paid, shares.
 */
const V2_DEADLINE = BigInt(NOW) + 8_640_000n;

export function insertReceiveQuote(opts: {
    wantAmount: bigint;
    receiverFare?: ReceiverFare;
    operatorCoin?: ExtendedVirtualCoin;
    db?: Database;
}): InsertedReceiveQuote {
    const db = opts.db ?? openDatabase(":memory:");
    const cfg = config({ vtxoMinAmount: 330n });
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
    const fills = new FillRepository(db);
    const advances = new AdvanceRepository(db);
    const reservations = new ReservationRepository(db);
    const operatorCoin = opts.operatorCoin ?? fundingCoin({ ...BOUND_TAXI, value: 20_000 });
    const depositCoin = fundingCoin({ ...BOUND_DEPOSIT, value: 10_000 });
    const makerKey = new Uint8Array(32).fill(9);
    const receiverPaid = opts.receiverFare !== undefined;
    const loan = 330n;
    const topLevelReceiverFare: FareSpec | undefined =
        opts.receiverFare === undefined
            ? undefined
            : opts.receiverFare.currency === "asset"
              ? { currency: "asset", assetId: WANTED_ASSET, units: opts.receiverFare.units }
              : opts.receiverFare;
    const params = {
        receiverKey,
        senderKey: makerKey,
        operatorKey: cfg.operatorKey,
        operatorSignerKey: cfg.operatorSignerKey,
        exitDelay: cfg.exitDelay,
        dust: 330n,
        topup: loan,
        assetId: WANTED_ASSET,
        locktime: V2_DEADLINE,
        claimMode: "recycle" as const,
        recoveryRecipient: "receiver" as const,
        ...(opts.receiverFare === undefined ? {} : { receiverFare: opts.receiverFare }),
    };
    const covenant = new DustCovenantScript({
        serverKey: cfg.serverPubkey,
        emulatorKey: cfg.emulatorPubkey,
        vtxoMinAmount: cfg.vtxoMinAmount,
        params,
    });
    const quoteId = "receive-1";
    quotes.insert({
        quote: {
            id: quoteId,
            state: "quoted",
            receiverAddress: new ArkAddress(cfg.serverPubkey, receiverKey, cfg.addressHrp).encode(),
            senderKey: hex.encode(makerKey),
            params,
            covenantAddress: covenant.address(cfg.addressHrp, cfg.serverPubkey).encode(),
            fare: { currency: "sats", units: receiverPaid ? 0n : FARE },
            ...(receiverPaid
                ? { payer: "receiver" as const, receiverFare: topLevelReceiverFare! }
                : {}),
            batchExpiry: { kind: "height", value: 900_000n },
            inputExpiryFloor: { kind: "height", value: 900_000n },
            recoveryLocktime: { kind: "time" as const, value: V2_DEADLINE },
            loanSats: loan,
            createdAt: NOW,
            expiresAt: NOW + 60,
            policyRevision: revision,
            operatorInputs: [operatorFundingInput(operatorCoin)],
        },
        expectedPolicyRevision: revision,
        recoveryExecutionBudget: { kind: "time", value: 43_200n },
    });
    return {
        db,
        cfg,
        quoteId,
        policies,
        quotes,
        fills,
        advances,
        reservations,
        covenant,
        operatorCoin,
        depositCoin,
        makerKey,
        loan,
        receiverPaid,
    };
}

export async function createBoundJointFill(
    over: { validUntil?: number; receiverFare?: ReceiverFare } = {},
): Promise<BoundJointFill> {
    const world = insertReceiveQuote({ wantAmount: WANT_UNITS, receiverFare: over.receiverFare });
    const { db, cfg, quotes, quoteId, advances, fills, covenant, operatorCoin, depositCoin } =
        world;
    try {
        const quote = quotes.get(quoteId)!;
        const solver = solverCoin({
            ...BOUND_SOLVER,
            value: 6_000,
            assets: [{ assetId: WANTED_SWAP_ID, amount: WANT_UNITS }],
        });
        const coins = [depositCoin, solver, operatorCoin];
        const checkpoints = coins.map(checkpointSpending);
        const operatorScript = new ArkAddress(cfg.serverPubkey, cfg.operatorKey, cfg.addressHrp)
            .pkScript;
        const taxiSats = BigInt(operatorCoin.value) - quote.loanSats + quote.fare.units;
        const tx = new Transaction({ version: 3, lockTime: 0 });
        for (const cp of checkpoints) tx.addInput({ txid: cp.id, index: 0 });
        tx.addOutput({ script: covenant.pkScript, amount: 330n });
        tx.addOutput({
            script: new ArkAddress(cfg.serverPubkey, receiverKey, cfg.addressHrp).pkScript,
            amount: BigInt(depositCoin.value + solver.value) - quote.fare.units,
        });
        tx.addOutput({ script: operatorScript, amount: taxiSats });
        tx.addOutput(
            Extension.create([
                asset.Packet.create([
                    asset.AssetGroup.create(
                        asset.AssetId.fromString(WANTED_SWAP_ID),
                        null,
                        [asset.AssetInput.create(1, WANT_UNITS)],
                        [asset.AssetOutput.create(0, WANT_UNITS)],
                        [],
                    ),
                ]),
            ]).txOut(),
        );
        tx.addOutput(P2A);
        const graph = sealGraph({
            arkTx: base64.encode(tx.toPSBT()),
            checkpoints: checkpoints.map((cp) => base64.encode(cp.toPSBT())),
            graphId: "",
            inputOwners: [null, null, "taxi"],
        });
        const source: FillFundingSource = {
            tag: "fill",
            version: 1,
            receiveQuoteId: quoteId,
            fillId: "fill-1",
            operationId: "op-1",
            graph,
            covenantOutputIndex: 0,
            covenantSats: "330",
            assetId: { txid: hex.encode(WANTED_ASSET.txid), groupIndex: WANTED_ASSET.groupIndex },
            assetUnits: WANT_UNITS.toString(),
            inputExpiryFloor: {
                kind: quote.inputExpiryFloor.kind,
                value: quote.inputExpiryFloor.value.toString(),
            },
            inputs: coins.map((coin, index) => ({
                role: index === 2 ? "taxi" : "foreign",
                txid: coin.txid,
                vout: coin.vout,
                value: String(coin.value),
                script: hex.encode(VtxoScript.decode(coin.tapTree).pkScript),
                tapTree: hex.encode(coin.tapTree),
                spendLeaf: hex.encode(scriptFromTapLeafScript(coin.forfeitTapLeafScript)),
                assets: (coin.assets ?? []).map((a) => ({
                    assetId: a.assetId,
                    amount: a.amount.toString(),
                })),
                expiry: {
                    kind: normalizeExpiry(coin).kind,
                    value: normalizeExpiry(coin).value.toString(),
                },
            })),
            serverUnrollScript: hex.encode(serverUnroll.script),
            operatorScript: hex.encode(operatorScript),
            operatorPayouts: [
                { vout: 2, sats: taxiSats.toString(), fareSats: quote.fare.units.toString() },
            ],
            recoveryPreflight: foreignRecoveryPreflight(),
        };
        const expiresAt = Math.min(quote.expiresAt, over.validUntil ?? quote.expiresAt);
        const advance: Advance = {
            id: quoteId,
            state: "locking",
            ...quote.params,
            assetUnits: WANT_UNITS,
            covenantAddress: quote.covenantAddress,
            fare: quote.fare,
            createdAt: NOW,
            updatedAt: NOW,
            expiresAt,
            recoveryLocktime: quote.recoveryLocktime,
            operatorInputs: [{ txid: operatorCoin.txid, vout: operatorCoin.vout }],
            unsignedLockupTx: encodeFillSource(source),
            unsignedLockupId: graph.graphId,
        };
        source.recoveryPreflight = buildRecoveryIntent(
            { ...advance, outpoint: { txid: tx.id, vout: 0 } },
            cfg,
        );
        advance.unsignedLockupTx = encodeFillSource(source);
        const fill: Fill = {
            id: "fill-1",
            quoteId,
            operationId: "op-1",
            state: "submitting",
            taxiInputs: advance.operatorInputs!,
            covenantOutputIndex: 0,
            assetUnits: WANT_UNITS,
            contributionSats: quote.loanSats,
            fare: quote.fare,
            graph: { arkTx: graph.arkTx, checkpoints: [...graph.checkpoints] },
            graphId: hex.decode(graph.graphId),
            submitInvoked: true,
            attempts: 1,
            createdAt: NOW,
            updatedAt: NOW,
            expiresAt,
            ...(over.validUntil === undefined ? {} : { validUntil: over.validUntil }),
        };
        quotes.bindFill({
            quoteId,
            fill,
            advance,
            expectedPolicyRevision: quote.policyRevision,
            now: NOW,
        });
        return {
            db,
            config: cfg,
            fill: fills.get(fill.id)!,
            advance: advances.get(quoteId)!,
            advances,
            fills,
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
    patch: (source: FillFundingSource) => void,
): Advance {
    const source = JSON.parse(
        advance.unsignedLockupTx.slice(SOURCE_PREFIX.length),
    ) as FillFundingSource;
    patch(source);
    return { ...advance, unsignedLockupTx: encodeFillSource(source) };
}

/** A self-consistent preflight that no advance in this repository rebuilds to. */
export function foreignRecoveryPreflight(): FillFundingSource["recoveryPreflight"] {
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
