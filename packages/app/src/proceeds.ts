import { createHash, randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import {
    ArkAddress,
    Estimator,
    Intent,
    Transaction,
    VtxoScript,
    asset,
    canSpendOffchain,
    type ExtendedVirtualCoin,
    type VirtualCoin,
    type IntentFeeConfig,
    type ArkIntent,
    type TimeHeight,
} from "@arkade-os/sdk";
import { base64, hex } from "@scure/base";
import { recycleFare, refundTopup, type AssetIdRef } from "@arkade-taxi/covenant";
import { advanceKind, covenantParamsOf, type Advance, type Outpoint } from "@arkade-taxi/core";
import type {
    AdvanceRepository,
    ProceedsRepository,
    ProceedsPlan,
    ReceiveQuoteRepository,
    ReservationRepository,
    SwapFillRepository,
} from "@arkade-taxi/db";
import type { RuntimeConfig } from "./config.js";
import {
    proofInputs,
    type createOperatorRuntime,
    type OperatorRuntimeOptions,
} from "./arkade/operatorWallet.js";
import { unionReservedOutpoints } from "./arkade/reservedOutpoints.js";
import { validatePersistedLockupGraph } from "./arkade/submit.js";
import { readFundingSource } from "./arkade/fundingSource.js";
import { classifyObservedSpend } from "./watcher.js";
import {
    normalizeExpiry,
    renewing,
    verifyProviders,
    withinVtxoMaxAmount,
} from "./arkade/providers.js";

const key = (o: Outpoint) => `${o.txid}:${o.vout}`;
const intentDigest = (proof: string, message: string) =>
    createHash("sha256")
        .update(JSON.stringify([proof, message]))
        .digest("hex");
const outpoint = ({ txid, vout }: Outpoint): Outpoint => ({ txid, vout });
const fail = (code: string): never => {
    throw new Error(code);
};
const total = (coins: readonly VirtualCoin[]) =>
    coins.reduce((sum, c) => sum + BigInt(c.value), 0n);
const withinOutputLimit = (amount: bigint, maxAmount: bigint) => {
    if (typeof maxAmount !== "bigint") fail("proceeds_output_limit_invalid");
    return withinVtxoMaxAmount(amount, maxAmount);
};
export const holdings = (coins: readonly VirtualCoin[]) => {
    const values = new Map<string, bigint>();
    for (const coin of coins)
        for (const a of coin.assets ?? []) {
            if (a.amount <= 0n) fail("proceeds_asset_invalid");
            values.set(a.assetId, (values.get(a.assetId) ?? 0n) + a.amount);
        }
    return [...values]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([assetId, amount]) => ({ assetId, amount: amount.toString() }));
};
const swapAssetId = ({ txid, groupIndex }: AssetIdRef) =>
    asset.AssetId.create(hex.encode(Uint8Array.from(txid).reverse()), groupIndex).toString();
const facts = (c: VirtualCoin) => ({
    ...outpoint(c),
    value: c.value,
    script: c.script,
    assets: holdings([c]),
});
const canonical = (c: ExtendedVirtualCoin, cfg: RuntimeConfig) => {
    try {
        return (
            c.script === `5120${hex.encode(cfg.operatorKey)}` &&
            hex.encode(VtxoScript.decode(c.tapTree).tweakedPublicKey) ===
                hex.encode(cfg.operatorKey) &&
            Number.isSafeInteger(c.value) &&
            c.value > 0 &&
            !c.isSpent &&
            !c.isUnrolled
        );
    } catch {
        return false;
    }
};
const reserveValue = (c: ExtendedVirtualCoin, cfg: RuntimeConfig, clock: TimeHeight) => {
    if (
        c.assets?.length ||
        !canSpendOffchain(c, clock) ||
        renewing(c, cfg.vtxoRenewalThresholdSeconds)
    )
        return 0n;
    try {
        const expiry = normalizeExpiry(c);
        const height = expiry.kind === "height";
        const at = height ? clock.height : Math.floor(clock.timestamp.getTime() / 1000);
        if (at === undefined || !Number.isSafeInteger(at)) return 0n;
        const headroom = height ? cfg.minExpiryHeadroomBlocks : cfg.minExpiryHeadroomSeconds;
        return expiry.value - BigInt(at) >= headroom ? BigInt(c.value) : 0n;
    } catch {
        return 0n;
    }
};

export interface CollectionPlan extends ProceedsPlan {
    kind?: "inventory-split";
    outputs?: string[];
    address: string;
    amount: string;
    plainChange?: string;
    fee: string;
    maxFee: string;
    assets: { assetId: string; amount: string }[];
    coins: ReturnType<typeof facts>[];
    receipts: Outpoint[];
}
// Keep the asset carrier at vout 0 and plain change at vout 1 for confirmation.
const collectionOutputAmounts = (plan: CollectionPlan) =>
    plan.kind === "inventory-split"
        ? plan.outputs!.map(BigInt)
        : plan.plainChange === undefined
          ? [BigInt(plan.amount)]
          : [BigInt(plan.amount) - BigInt(plan.plainChange), BigInt(plan.plainChange)];

export function assertProceedsPlan(
    plan: CollectionPlan,
    coins: VirtualCoin[],
    cfg: RuntimeConfig,
): void {
    try {
        if (plan.kind !== undefined && plan.kind !== "inventory-split")
            fail("proceeds_plan_invalid");
        if (plan.kind === "inventory-split") {
            const allowed = new Set([
                "kind",
                "outputs",
                "inputs",
                "address",
                "amount",
                "fee",
                "maxFee",
                "assets",
                "coins",
                "receipts",
            ]);
            if (
                Object.keys(plan).some((name) => !allowed.has(name)) ||
                plan.address !==
                    new ArkAddress(cfg.serverPubkey, cfg.operatorKey, cfg.addressHrp).encode() ||
                coins.length !== 1 ||
                !/^[a-f0-9]{64}$/.test(coins[0]!.txid) ||
                !Number.isSafeInteger(coins[0]!.vout) ||
                coins[0]!.vout < 0 ||
                coins[0]!.vout > 0xffff_ffff ||
                !Number.isSafeInteger(coins[0]!.value) ||
                coins[0]!.value <= 0 ||
                coins[0]!.script !== "5120" + hex.encode(cfg.operatorKey) ||
                holdings(coins).length ||
                plan.receipts.length ||
                plan.assets.length ||
                plan.plainChange !== undefined ||
                !/^(0|[1-9][0-9]*)$/.test(plan.fee) ||
                !/^(0|[1-9][0-9]*)$/.test(plan.maxFee) ||
                !/^[1-9][0-9]*$/.test(plan.amount) ||
                BigInt(plan.fee) > BigInt(plan.maxFee) ||
                BigInt(plan.maxFee) > cfg.proceedsMaxFeeSats ||
                !isDeepStrictEqual(coins.map(facts), plan.coins) ||
                !isDeepStrictEqual(coins.map(outpoint), plan.inputs) ||
                !Array.isArray(plan.outputs) ||
                plan.outputs.length < 2 ||
                plan.outputs.length > 8 ||
                plan.outputs.some((n) => typeof n !== "string" || !/^[1-9][0-9]*$/.test(n))
            )
                fail("proceeds_plan_invalid");
            const amounts = collectionOutputAmounts(plan);
            if (
                amounts.some((n) => n > BigInt(Number.MAX_SAFE_INTEGER)) ||
                amounts[0]! < cfg.operatorMinReserveSats + cfg.dust ||
                amounts[0]! < 2n * cfg.dust ||
                amounts.slice(1).some((n) => n < 2n * cfg.dust) ||
                amounts.reduce((sum, n) => sum + n, 0n) !== BigInt(plan.amount) ||
                total(coins) - BigInt(plan.fee) !== BigInt(plan.amount)
            )
                fail("proceeds_plan_invalid");
            return;
        }
        if (plan.outputs !== undefined) fail("proceeds_plan_invalid");
        const receiptKeys = new Set(plan.receipts.map(key));
        const inputs = new Set(coins.map(key));
        const sponsor = coins.find((c) => !receiptKeys.has(key(c)));
        if (
            plan.address !==
                new ArkAddress(cfg.serverPubkey, cfg.operatorKey, cfg.addressHrp).encode() ||
            !/^(0|[1-9][0-9]*)$/.test(plan.fee) ||
            !/^(0|[1-9][0-9]*)$/.test(plan.maxFee) ||
            !/^[1-9][0-9]*$/.test(plan.amount) ||
            BigInt(plan.fee) > BigInt(plan.maxFee) ||
            total(coins) - BigInt(plan.fee) !== BigInt(plan.amount) ||
            BigInt(plan.amount) < cfg.dust ||
            !isDeepStrictEqual(holdings(coins), plan.assets) ||
            !isDeepStrictEqual(coins.map(facts), plan.coins) ||
            !isDeepStrictEqual(coins.map(outpoint), plan.inputs) ||
            !receiptKeys.size ||
            receiptKeys.size !== plan.receipts.length ||
            inputs.size !== coins.length ||
            [...receiptKeys].some((k) => !inputs.has(k)) ||
            inputs.size - receiptKeys.size > 1
        )
            fail("proceeds_plan_invalid");
        if (
            plan.plainChange !== undefined &&
            (typeof plan.plainChange !== "string" ||
                !/^[1-9][0-9]*$/.test(plan.plainChange) ||
                BigInt(plan.amount) - BigInt(plan.plainChange) !== cfg.dust ||
                BigInt(plan.plainChange) < cfg.dust ||
                BigInt(plan.plainChange) < cfg.operatorMinReserveSats ||
                !plan.assets.length ||
                !sponsor ||
                !!sponsor.assets?.length)
        )
            fail("proceeds_plan_invalid");
    } catch {
        fail("proceeds_plan_invalid");
    }
}

const checkedFee = (fee: number) => {
    if (!Number.isSafeInteger(fee) || fee < 0) fail("proceeds_fee_invalid");
    return BigInt(fee);
};
const proceedsInputFee = (coins: readonly ExtendedVirtualCoin[], estimator: Estimator) =>
    coins.reduce(
        (sum, c) =>
            sum +
            checkedFee(
                estimator.evalOffchainInput({
                    amount: BigInt(c.value),
                    type: c.isSwept ? "recoverable" : "vtxo",
                    weight: 0,
                    birth: c.createdAt,
                    expiry:
                        c.expiresAt ??
                        (c.expiresAtHeight === undefined
                            ? undefined
                            : new Date(c.expiresAtHeight * 1000)),
                }).satoshis,
            ),
        0n,
    );

export function proceedsFee(
    coins: readonly ExtendedVirtualCoin[],
    info: IntentFeeConfig,
    script: string,
    outputAmounts?: readonly bigint[],
): bigint {
    const estimator = new Estimator(info);
    const inputs = proceedsInputFee(coins, estimator);
    return (
        inputs +
        (outputAmounts ?? [total(coins) - inputs]).reduce(
            (sum, amount) =>
                sum + checkedFee(estimator.evalOffchainOutput({ amount, script }).satoshis),
            0n,
        )
    );
}

export function planInventorySplit(
    coins: ExtendedVirtualCoin[],
    reserved: readonly Outpoint[],
    cfg: RuntimeConfig,
    fees: IntentFeeConfig,
    address: string,
    clock: TimeHeight,
    maxAmount: bigint,
): CollectionPlan | undefined {
    const expected = new ArkAddress(cfg.serverPubkey, cfg.operatorKey, cfg.addressHrp);
    if (address !== expected.encode()) fail("proceeds_ownership_invalid");
    if (new Set(coins.map(key)).size !== coins.length) fail("proceeds_duplicate_inventory");
    const locked = new Set(reserved.map(key));
    const available = coins.filter(
        (c) =>
            canonical(c, cfg) &&
            !locked.has(key(c)) &&
            /^[a-f0-9]{64}$/.test(c.txid) &&
            Number.isSafeInteger(c.vout) &&
            c.vout >= 0 &&
            c.vout <= 0xffff_ffff &&
            reserveValue(c, cfg, clock) > 0n,
    );
    const working = available.filter((c) => BigInt(c.value) >= 2n * cfg.dust).length;
    if (working >= 8) return;
    const reserve =
        cfg.operatorMinReserveSats + cfg.dust > 2n * cfg.dust
            ? cfg.operatorMinReserveSats + cfg.dust
            : 2n * cfg.dust;
    const candidates = available.sort((a, b) => b.value - a.value || key(a).localeCompare(key(b)));
    for (const coin of candidates) {
        for (let count = Math.min(8, 9 - working); count >= 2; count--) {
            let fee = 0n;
            for (let attempt = 0; attempt < 8; attempt++) {
                const amount = BigInt(coin.value) - fee;
                const chunk = (amount - reserve) / BigInt(count - 1);
                if (chunk < 2n * cfg.dust) break;
                const outputs = [
                    amount - chunk * BigInt(count - 1),
                    ...Array<bigint>(count - 1).fill(chunk),
                ];
                if (outputs.some((n) => !withinOutputLimit(n, maxAmount))) break;
                const estimated = proceedsFee([coin], fees, hex.encode(expected.pkScript), outputs);
                if (estimated > cfg.proceedsMaxFeeSats) break;
                if (estimated === fee) {
                    const plan: CollectionPlan = {
                        kind: "inventory-split",
                        inputs: [outpoint(coin)],
                        coins: [facts(coin)],
                        receipts: [],
                        address,
                        amount: amount.toString(),
                        outputs: outputs.map(String),
                        assets: [],
                        fee: fee.toString(),
                        maxFee: cfg.proceedsMaxFeeSats.toString(),
                    };
                    assertProceedsPlan(plan, [coin], cfg);
                    return plan;
                }
                fee = estimated;
            }
        }
    }
}

export function planProceeds(
    receipts: ExtendedVirtualCoin[],
    ordinary: ExtendedVirtualCoin[],
    reserved: readonly Outpoint[],
    cfg: RuntimeConfig,
    fees: IntentFeeConfig,
    address: string,
    clock: TimeHeight,
    maxAmount: bigint,
): CollectionPlan {
    const expectedAddress = new ArkAddress(cfg.serverPubkey, cfg.operatorKey, cfg.addressHrp);
    if (
        address !== expectedAddress.encode() ||
        !receipts.length ||
        receipts.some((c) => !canonical(c, cfg))
    )
        fail("proceeds_ownership_invalid");
    const locked = new Set(reserved.map(key));
    const ids = new Set(receipts.map(key));
    if (new Set(ordinary.map(key)).size !== ordinary.length) fail("proceeds_duplicate_inventory");
    if (ids.size !== receipts.length || receipts.some((c) => locked.has(key(c))))
        fail("proceeds_input_reserved");
    const available = ordinary
        .filter(
            (c) =>
                canonical(c, cfg) &&
                canSpendOffchain(c, clock) &&
                !renewing(c, cfg.vtxoRenewalThresholdSeconds) &&
                !locked.has(key(c)) &&
                !ids.has(key(c)),
        )
        .sort(
            (a, b) =>
                Number(!!b.assets?.length) - Number(!!a.assets?.length) ||
                a.value - b.value ||
                key(a).localeCompare(key(b)),
        );
    if (!withinOutputLimit(cfg.dust, maxAmount)) fail("proceeds_output_limit_exceeded");
    const script = hex.encode(expectedAddress.pkScript);
    const selected: ExtendedVirtualCoin[] = [];
    for (const receipt of receipts) {
        const projected = [...selected, receipt];
        if (withinOutputLimit(total(projected) - proceedsFee(projected, fees, script), maxAmount))
            selected.push(receipt);
    }
    if (!selected.length) fail("proceeds_output_limit_exceeded");
    const collected = selected.map(outpoint);
    let fee = proceedsFee(selected, fees, script);
    let plainChange: bigint | undefined;
    if (total(selected) - fee < cfg.dust) {
        const reserve = available.reduce((sum, c) => sum + reserveValue(c, cfg, clock), 0n);
        let overLimit = false;
        const sponsor = available.find((c) => {
            const projected = [...selected, c];
            const split = holdings(selected).length > 0 && !c.assets?.length;
            const consumedReserve = reserveValue(c, cfg, clock);
            if (
                (split || consumedReserve > 0n) &&
                reserve - consumedReserve < cfg.operatorMinReserveSats
            )
                return false;
            const quotedFee = proceedsFee(
                projected,
                fees,
                script,
                split
                    ? [
                          cfg.dust,
                          total(projected) -
                              proceedsInputFee(projected, new Estimator(fees)) -
                              cfg.dust,
                      ]
                    : undefined,
            );
            const amount = total(projected) - quotedFee;
            if (amount < cfg.dust) return false;
            const change = amount - cfg.dust;
            if (split && (change < cfg.dust || change < cfg.operatorMinReserveSats)) return false;
            if (
                !withinOutputLimit(split ? cfg.dust : amount, maxAmount) ||
                (split && !withinOutputLimit(change, maxAmount))
            ) {
                overLimit = true;
                return false;
            }
            if (split && proceedsFee(projected, fees, script, [cfg.dust, change]) !== quotedFee)
                fail("proceeds_fee_authorization_changed");
            plainChange = split ? change : undefined;
            fee = quotedFee;
            return true;
        });
        if (!sponsor)
            fail(overLimit ? "proceeds_output_limit_exceeded" : "proceeds_reserve_unavailable");
        selected.push(sponsor!);
    }
    if (fee > cfg.proceedsMaxFeeSats) fail("proceeds_fee_cap_exceeded");
    return {
        inputs: selected.map(outpoint),
        coins: selected.map(facts),
        receipts: collected,
        address,
        amount: (total(selected) - fee).toString(),
        ...(plainChange === undefined ? {} : { plainChange: plainChange.toString() }),
        assets: holdings(selected),
        fee: fee.toString(),
        maxFee: cfg.proceedsMaxFeeSats.toString(),
    };
}

export function reconcileProceeds(
    coins: VirtualCoin[],
    intents: Partial<
        Pick<ArkIntent, "validUntil" | "state" | "registerProof" | "registerProofMessage">
    >[],
    now: number,
    evidence: ReturnType<ProceedsRepository["submissionEvidence"]>,
):
    | { kind: "retry" | "pending" }
    | { kind: "quarantined"; blocker: string }
    | { kind: "verify"; commitmentTxid: string } {
    const settled = coins[0]?.settledBy;
    if (
        settled &&
        /^[a-f0-9]{64}$/.test(settled) &&
        coins.every((c) => c.isSpent && c.settledBy === settled)
    )
        return { kind: "verify", commitmentTxid: settled };
    if (!coins.length || coins.some((c) => c.isSpent || c.isUnrolled || c.spentBy || c.settledBy))
        return { kind: "quarantined", blocker: "proceeds_input_conflict" };
    if (evidence.state !== "unsubmitted")
        return { kind: "quarantined", blocker: "proceeds_submission_ambiguous" };
    const unresolved = intents.filter(
        (intent) =>
            !(
                intent.state === "cancelled" &&
                typeof intent.registerProof === "string" &&
                typeof intent.registerProofMessage === "string" &&
                evidence.localIntents.includes(
                    intentDigest(intent.registerProof, intent.registerProofMessage),
                )
            ),
    );
    if (
        unresolved.some(
            (i) =>
                i.validUntil === undefined ||
                !Number.isSafeInteger(i.validUntil) ||
                i.validUntil <= 0,
        )
    )
        return { kind: "quarantined", blocker: "proceeds_ambiguous_intent" };
    return { kind: unresolved.every((i) => i.validUntil! < now) ? "retry" : "pending" };
}

export interface ProceedsStatus {
    running: boolean;
    jobId: string | null;
    state: string;
    blocker: string | null;
    maxFeeSats: string;
    authorizedFeeSats: string | null;
    commitmentTxid: string | null;
}
interface Deps {
    config: RuntimeConfig;
    runtime: ReturnType<typeof createOperatorRuntime>;
    advances: Pick<AdvanceRepository, "byState">;
    reservations: Pick<ReservationRepository, "listReservedOutpoints">;
    swapFills?: Pick<SwapFillRepository, "listReservedOutpoints">;
    receiveQuotes?: Pick<ReceiveQuoteRepository, "listReservedOutpoints">;
    jobs: ProceedsRepository;
    now?: () => number;
    phaseLogger?: OperatorRuntimeOptions["phaseLogger"];
}

const phaseTimer =
    (logger: Deps["phaseLogger"]) =>
    <T>(phase: string, work: () => T): T => {
        if (!logger) return work();
        const started = performance.now();
        const emit = (outcome: "start" | "ok" | "error") => {
            try {
                logger.debug(
                    { phase, elapsedMs: performance.now() - started, outcome },
                    "operational phase",
                );
            } catch {}
        };
        emit("start");
        try {
            const result = work();
            if (result instanceof Promise)
                void result.then(
                    () => emit("ok"),
                    () => emit("error"),
                );
            else emit("ok");
            return result;
        } catch (error) {
            emit("error");
            throw error;
        }
    };

export async function discoverProceeds(
    deps: Deps,
    coins: ExtendedVirtualCoin[],
): Promise<ExtendedVirtualCoin[]> {
    const { config, runtime, advances } = deps;
    const timed = phaseTimer(deps.phaseLogger);
    const tip = await timed("proceeds.discovery.chainTip", () =>
        runtime.wallet!.onchainProvider.getChainTip(),
    );
    const clock = { height: tip.height, timestamp: new Date(tip.time * 1000) };
    const candidates = new Map(
        coins
            .filter((c) => !canSpendOffchain(c, clock) && canonical(c, config))
            .map((c) => [key(c), c]),
    );
    if (!candidates.size) return [];
    const found = new Map<string, ExtendedVirtualCoin>();
    const indexer = runtime.providers.indexerProvider;
    const check = async (point: Outpoint, amount: bigint, assets: ReturnType<typeof holdings>) => {
        const candidate = candidates.get(key(point));
        if (!candidate) return;
        const result = await timed("proceeds.discovery.receipt", () =>
            indexer.getVtxos({ outpoints: [point] }),
        );
        if (result.vtxos.length !== 1) fail("proceeds_receipt_missing");
        const observed = result.vtxos[0]!;
        if (key(observed) !== key(point) || observed.isSpent) return;
        if (
            observed.script !== `5120${hex.encode(config.operatorKey)}` ||
            BigInt(observed.value) !== amount ||
            !isDeepStrictEqual(holdings([observed]), assets) ||
            !isDeepStrictEqual(facts(observed), facts(candidate))
        )
            fail("proceeds_receipt_mismatch");
        found.set(key(point), candidate);
    };
    const checkFare = (advance: Advance) =>
        check(
            { txid: advance.arkTxid!, vout: 1 },
            advance.fare.currency === "sats" ? advance.fare.units : config.vtxoMinAmount,
            advance.fare.currency === "asset"
                ? [
                      {
                          assetId: swapAssetId(advance.fare.assetId),
                          amount: advance.fare.units.toString(),
                      },
                  ]
                : [],
        );
    for (const advance of (["recycled", "purchased", "refunded", "recovered"] as const).flatMap(
        (s) => advances.byState(s),
    )) {
        if (!advance.outpoint || !advance.arkTxid || !advance.spentTxid) continue;
        if (hex.encode(advance.operatorKey) !== hex.encode(config.operatorKey))
            fail("proceeds_payout_key_changed");
        const source = readFundingSource(advance.unsignedLockupTx);
        const fare = { txid: advance.arkTxid, vout: 1 };
        const repayment = { txid: advance.spentTxid, vout: 0 };
        if (
            (source.kind === "joint-fill" || !candidates.has(key(fare))) &&
            !candidates.has(key(repayment))
        )
            continue;
        const envelope =
            source.kind === "legacy" ? validatePersistedLockupGraph(advance, config) : undefined;
        const tx = Transaction.fromPSBT(
            base64.decode(
                source.kind === "joint-fill" ? source.source.graph.arkTx : envelope!.arkTx,
            ),
        );
        if (tx.id !== advance.arkTxid) fail("proceeds_lockup_mismatch");
        const covenant = await timed("proceeds.discovery.covenant", () =>
            indexer.getVtxos({ outpoints: [advance.outpoint!] }),
        );
        if (covenant.vtxos.length !== 1) fail("proceeds_covenant_missing");
        const spend = await timed("proceeds.discovery.classifySpend", () =>
            classifyObservedSpend(advance, covenant.vtxos[0]!, { config, indexer }, tip),
        );
        if (spend.kind !== advance.state || spend.txid !== advance.spentTxid)
            fail("proceeds_spend_mismatch");
        if (source.kind === "legacy" && advance.fare.units > 0n) await checkFare(advance);
        if (advance.state === "recycled") {
            const { operatorSats, assetFare } = recycleFare(covenantParamsOf(advance));
            await check(
                repayment,
                operatorSats,
                assetFare > 0n
                    ? [{ assetId: swapAssetId(advance.assetId!), amount: assetFare.toString() }]
                    : [],
            );
        } else if (advance.state !== "purchased")
            await check(repayment, refundTopup(advance, config.vtxoMinAmount), []);
        if (found.size >= 32) break;
    }
    for (const advance of advances.byState("locked")) {
        if (found.size >= 32) break;
        if (
            advanceKind(advance) !== "sponsored" ||
            advance.fare.units <= 0n ||
            !advance.arkTxid ||
            !advance.outpoint ||
            !candidates.has(key({ txid: advance.arkTxid, vout: 1 }))
        )
            continue;
        if (hex.encode(advance.operatorKey) !== hex.encode(config.operatorKey))
            fail("proceeds_payout_key_changed");
        const envelope = validatePersistedLockupGraph(advance, config);
        const tx = Transaction.fromPSBT(base64.decode(envelope.arkTx));
        if (
            tx.id !== advance.arkTxid ||
            advance.outpoint.txid !== tx.id ||
            advance.outpoint.vout !== envelope.covenantOutputIndex
        )
            fail("proceeds_lockup_mismatch");
        await checkFare(advance);
    }
    return [...found.values()].slice(0, 32).sort((a, b) => key(a).localeCompare(key(b)));
}

export function createProceedsCollector(deps: Deps) {
    const { config, runtime, jobs, reservations } = deps;
    const timed = phaseTimer(deps.phaseLogger);
    const taxiLocksOf = () =>
        unionReservedOutpoints(reservations, deps.swapFills, deps.receiveQuotes);
    const now = deps.now ?? Date.now;
    const owner = randomUUID();
    const leaseMs = 60_000;
    let stopped = false;
    let pending: Promise<void> | undefined;
    let blocker: string | null = null;
    const confirmOutput = async (id: string, plan: CollectionPlan, commitmentTxid: string) => {
        const observed = await runtime.providers.indexerProvider.getVtxos({
            outpoints: plan.inputs,
        });
        const points = new Set(plan.inputs.map(key));
        const settled =
            observed.vtxos.length === points.size &&
            new Set(observed.vtxos.map(key)).size === points.size &&
            observed.vtxos.every(
                (c) => points.has(key(c)) && c.isSpent && c.settledBy === commitmentTxid,
            );
        const coins = await runtime.wallet!.getSpendableVtxos({ withRecoverable: false });
        const outputs = coins.filter(
            (c) => c.commitmentTxIds?.includes(commitmentTxid) && canonical(c, config),
        );
        const amounts = collectionOutputAmounts(plan);
        const tip =
            plan.kind === "inventory-split"
                ? await runtime.wallet!.onchainProvider.getChainTip()
                : undefined;
        const safeOutputs =
            !tip ||
            outputs.every(
                (c) =>
                    reserveValue(c, config, {
                        height: tip.height,
                        timestamp: new Date(tip.time * 1000),
                    }) > 0n,
            );
        if (
            !safeOutputs ||
            !settled ||
            outputs.length !== amounts.length ||
            new Set(outputs.map(key)).size !== outputs.length ||
            !isDeepStrictEqual(
                outputs.map((c) => JSON.stringify([c.value.toString(), holdings([c])])).sort(),
                amounts
                    .map((amount, index) =>
                        JSON.stringify([amount.toString(), index === 0 ? plan.assets : []]),
                    )
                    .sort(),
            )
        ) {
            jobs.update(id, "settling", "proceeds_output_pending", commitmentTxid);
            blocker = "proceeds_output_pending";
            return;
        }
        jobs.complete(id, commitmentTxid);
        blocker = null;
    };
    const run = async () => {
        await timed("proceeds.assertRecovery", () => runtime.assertRecovery());
        let job = jobs.active();
        if (!job) {
            const wallet = runtime.wallet!;
            const coins = await timed("proceeds.inventory", () =>
                wallet.getSpendableVtxos({ withRecoverable: true }),
            );
            const receipts = await timed("proceeds.discovery", () => discoverProceeds(deps, coins));
            const taxiLocks = taxiLocksOf();
            const locks = [
                ...taxiLocks,
                ...(await timed("proceeds.intentLocks", () =>
                    runtime.storage.intentRepository.getLockedVtxoOutpoints(),
                )),
            ];
            const info = await timed("proceeds.providerInfo", () => wallet.arkProvider.getInfo());
            const tip = await timed("proceeds.chainTip", () =>
                wallet.onchainProvider.getChainTip(),
            );
            const fees = info.fees?.intentFee ?? {};
            const address = await timed("proceeds.address", () => wallet.getAddress());
            const plan = timed("proceeds.plan", () => {
                let receiptError: Error | undefined;
                if (receipts.length) {
                    try {
                        return planProceeds(
                            receipts,
                            coins,
                            locks,
                            config,
                            fees,
                            address,
                            { height: tip.height, timestamp: new Date(tip.time * 1000) },
                            info.vtxoMaxAmount,
                        );
                    } catch (error) {
                        if (
                            !(error instanceof Error) ||
                            error.message !== "proceeds_reserve_unavailable"
                        )
                            throw error;
                        receiptError = error;
                    }
                }
                const split = planInventorySplit(
                    coins,
                    locks,
                    config,
                    fees,
                    address,
                    { height: tip.height, timestamp: new Date(tip.time * 1000) },
                    info.vtxoMaxAmount,
                );
                if (!split && receiptError) throw receiptError;
                return split;
            });
            if (!plan) {
                blocker = null;
                return;
            }
            if (stopped) return;
            timed("proceeds.createJob", () => jobs.create(randomUUID(), plan, now(), taxiLocks));
            job = jobs.active()!;
        }
        if (!jobs.claim(job.id, owner, now(), now() + leaseMs)) {
            blocker = "proceeds_worker_active";
            return;
        }
        const plan = job.plan as CollectionPlan;
        const observed = await runtime.providers.indexerProvider.getVtxos({
            outpoints: plan.inputs,
        });
        const mapped = new Map(observed.vtxos.map((c) => [key(c), c]));
        if (mapped.size !== plan.inputs.length || plan.inputs.some((p) => !mapped.has(key(p))))
            fail("proceeds_inputs_missing");
        const inputs = plan.inputs.map((p) => mapped.get(key(p))!);
        assertProceedsPlan(plan, inputs, config);
        if (!isDeepStrictEqual(inputs.map(facts), plan.coins)) fail("proceeds_input_facts_changed");
        const intents = await runtime.storage.intentRepository.getIntents({
            containingInputs: plan.inputs,
        });
        const outcome = reconcileProceeds(inputs, intents, now(), jobs.submissionEvidence(job.id));
        if (outcome.kind === "verify") {
            await confirmOutput(job.id, plan, outcome.commitmentTxid);
            return;
        }
        if (outcome.kind !== "retry") {
            blocker = outcome.kind === "quarantined" ? outcome.blocker : "proceeds_intent_pending";
            jobs.update(
                job.id,
                outcome.kind === "quarantined" ? "quarantined" : "settling",
                blocker,
                null,
            );
            return;
        }
        if (stopped) return;
        const id = job.id;
        const assertSplitReservations = () => {
            if (plan.kind !== "inventory-split") return;
            const own = jobs.active();
            const locks = [
                ...reservations.listReservedOutpoints(),
                ...(deps.swapFills?.listReservedOutpoints() ?? []),
                ...(deps.receiveQuotes?.listReservedOutpoints() ?? []),
            ];
            if (
                own?.id !== id ||
                !isDeepStrictEqual(own.plan, plan) ||
                plan.inputs.some((p) => locks.filter((c) => key(c) === key(p)).length !== 1)
            )
                fail("proceeds_input_reserved");
        };
        const heartbeat = setInterval(() => {
            try {
                jobs.claim(id, owner, now(), now() + leaseMs);
            } catch {
                /* submit guard fences a lost lease */
            }
        }, leaseMs / 3);
        try {
            let guard: (submitting?: boolean) => Promise<ExtendedVirtualCoin[]>;
            let prepared: ExtendedVirtualCoin[] | undefined;
            await runtime.withSettlement(
                async (wallet) => {
                    guard = async (submitting = false) => {
                        if (stopped) fail("proceeds_stopped");
                        const verified = await verifyProviders(config, runtime.providers);
                        if (verified.blockers.length || !verified.info)
                            fail("proceeds_provider_unsafe");
                        if (
                            collectionOutputAmounts(plan).some(
                                (amount) =>
                                    !withinOutputLimit(amount, verified.info!.vtxoMaxAmount),
                            )
                        )
                            fail("proceeds_output_limit_exceeded");
                        const [coins, tip, sdkLocks, current] = await Promise.all([
                            wallet.getSpendableVtxos({ withRecoverable: true }),
                            wallet.onchainProvider.getChainTip(),
                            runtime.storage.intentRepository.getLockedVtxoOutpoints(),
                            submitting
                                ? runtime.providers.indexerProvider.getVtxos({
                                      outpoints: plan.inputs,
                                  })
                                : undefined,
                        ]);
                        if (
                            !Number.isSafeInteger(tip.height) ||
                            tip.height < 0 ||
                            !Number.isSafeInteger(tip.time) ||
                            tip.time <= 0
                        )
                            fail("proceeds_chain_tip_invalid");
                        if (new Set(coins.map(key)).size !== coins.length)
                            fail("proceeds_duplicate_inventory");
                        if (
                            current &&
                            (current.vtxos.length !== plan.inputs.length ||
                                new Set(current.vtxos.map(key)).size !== plan.inputs.length ||
                                plan.inputs.some(
                                    (p) => !current.vtxos.some((c) => key(c) === key(p)),
                                ))
                        )
                            fail("proceeds_inputs_missing");
                        const selected = current
                            ? prepared!.map((c) => ({
                                  ...c,
                                  ...current.vtxos.find((v) => key(v) === key(c))!,
                              }))
                            : plan.inputs.map((p) => coins.find((c) => key(c) === key(p))!);
                        if (
                            selected.some((c) => !c || !canonical(c, config)) ||
                            !isDeepStrictEqual(selected.map(facts), plan.coins)
                        )
                            fail("proceeds_input_unavailable");
                        const clock = { height: tip.height, timestamp: new Date(tip.time * 1000) };
                        const receiptKeys = new Set(plan.receipts.map(key));
                        const sponsor = selected.find((c) => !receiptKeys.has(key(c)));
                        if (sponsor && !canSpendOffchain(sponsor, clock))
                            fail("proceeds_input_unavailable");
                        const locked = new Set(
                            [...taxiLocksOf(), ...sdkLocks, ...plan.inputs].map(key),
                        );
                        const reserve = coins.reduce(
                            (sum, c) =>
                                sum +
                                (!locked.has(key(c)) && canonical(c, config)
                                    ? reserveValue(c, config, clock)
                                    : 0n),
                            0n,
                        );
                        if (plan.kind === "inventory-split") {
                            assertProceedsPlan(plan, selected, config);
                            if (
                                selected.some((c) => reserveValue(c, config, clock) === 0n) ||
                                (!submitting &&
                                    sdkLocks.some((p) =>
                                        plan.inputs.some((c) => key(c) === key(p)),
                                    ))
                            )
                                fail("proceeds_input_unavailable");
                            assertSplitReservations();
                        }
                        if (
                            plan.kind !== "inventory-split" &&
                            sponsor &&
                            (plan.plainChange !== undefined ||
                                reserveValue(sponsor, config, clock) > 0n) &&
                            reserve < config.operatorMinReserveSats
                        )
                            fail("proceeds_reserve_unavailable");
                        const fee = proceedsFee(
                            selected,
                            verified.info!.fees?.intentFee ?? {},
                            hex.encode(ArkAddress.decode(plan.address).pkScript),
                            plan.kind !== "inventory-split" && plan.plainChange === undefined
                                ? undefined
                                : collectionOutputAmounts(plan),
                        );
                        if (fee.toString() !== plan.fee || fee > BigInt(plan.maxFee))
                            fail("proceeds_fee_authorization_changed");
                        if (stopped) fail("proceeds_stopped");
                        jobs.assertLease(id, owner, now());
                        return selected;
                    };
                    const selected = (prepared = await guard());
                    jobs.update(id, "settling", null, null);
                    const commitment = await wallet.settle({
                        inputs: selected,
                        outputs: collectionOutputAmounts(plan).map((amount) => ({
                            address: plan.address,
                            amount,
                        })),
                    });
                    jobs.update(id, "settling", "proceeds_output_pending", commitment);
                    await confirmOutput(id, plan, commitment);
                },
                async (intent) => {
                    if (proofInputs(intent).sort().join() !== plan.inputs.map(key).sort().join())
                        fail("proceeds_intent_inputs_changed");
                    const digest = intentDigest(intent.proof, Intent.encodeMessage(intent.message));
                    jobs.rememberLocalIntent(id, owner, now(), digest);
                    await guard(true);
                    return () => {
                        if (stopped) fail("proceeds_stopped");
                        assertSplitReservations();
                        jobs.enterSubmission(id, owner, now(), digest);
                    };
                },
            );
        } finally {
            clearInterval(heartbeat);
        }
    };
    return {
        tick(): Promise<void> {
            if (stopped) return Promise.resolve();
            pending ??= run()
                .catch((error) => {
                    blocker =
                        error instanceof Error && /^proceeds_[a-z_]+$/.test(error.message)
                            ? error.message
                            : "proceeds_collection_failed";
                    try {
                        const job = jobs.active();
                        if (job) jobs.update(job.id, "quarantined", blocker, null);
                    } catch {
                        blocker = "proceeds_storage_unavailable";
                    }
                })
                .finally(() => {
                    pending = undefined;
                });
            return pending;
        },
        status(): ProceedsStatus {
            const job = jobs.active();
            return {
                running: !!pending,
                jobId: job?.id ?? null,
                state: job?.state ?? "idle",
                blocker,
                maxFeeSats: config.proceedsMaxFeeSats.toString(),
                authorizedFeeSats: job ? String(job.plan.fee) : null,
                commitmentTxid: job?.commitmentTxid ?? null,
            };
        },
        stop() {
            stopped = true;
        },
        async drain() {
            await pending;
        },
    };
}
