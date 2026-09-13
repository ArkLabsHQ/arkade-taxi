import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import {
    ArkAddress,
    Estimator,
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
import { refundTopup } from "@arkade-taxi/covenant";
import type { Outpoint } from "@arkade-taxi/core";
import type {
    AdvanceRepository,
    ProceedsRepository,
    ProceedsPlan,
    ReservationRepository,
} from "@arkade-taxi/db";
import type { RuntimeConfig } from "./config.js";
import type { createOperatorRuntime } from "./arkade/operatorWallet.js";
import { validatePersistedLockupGraph } from "./arkade/submit.js";
import { classifyObservedSpend } from "./watcher.js";
import { normalizeExpiry, verifyProviders } from "./arkade/providers.js";

const key = (o: Outpoint) => `${o.txid}:${o.vout}`;
const outpoint = ({ txid, vout }: Outpoint): Outpoint => ({ txid, vout });
const fail = (code: string): never => {
    throw new Error(code);
};
const total = (coins: readonly VirtualCoin[]) =>
    coins.reduce((sum, c) => sum + BigInt(c.value), 0n);
const holdings = (coins: readonly VirtualCoin[]) => {
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

export interface CollectionPlan extends ProceedsPlan {
    address: string;
    amount: string;
    fee: string;
    maxFee: string;
    assets: { assetId: string; amount: string }[];
    coins: ReturnType<typeof facts>[];
    receipts: Outpoint[];
}

export function assertProceedsPlan(
    plan: CollectionPlan,
    coins: VirtualCoin[],
    cfg: RuntimeConfig,
): void {
    try {
        const receiptKeys = new Set(plan.receipts.map(key));
        const inputs = new Set(coins.map(key));
        if (
            plan.address !==
                new ArkAddress(cfg.serverPubkey, cfg.operatorKey, cfg.addressHrp).encode() ||
            !/^(0|[1-9][0-9]*)$/.test(plan.fee) ||
            !/^(0|[1-9][0-9]*)$/.test(plan.maxFee) ||
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
    } catch {
        fail("proceeds_plan_invalid");
    }
}

export function proceedsFee(
    coins: readonly ExtendedVirtualCoin[],
    info: IntentFeeConfig,
    script: string,
): bigint {
    const estimator = new Estimator(info);
    const checked = (fee: number) => {
        if (!Number.isSafeInteger(fee) || fee < 0) fail("proceeds_fee_invalid");
        return BigInt(fee);
    };
    const inputs = coins.reduce(
        (sum, c) =>
            sum +
            checked(
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
    return (
        inputs +
        checked(estimator.evalOffchainOutput({ amount: total(coins) - inputs, script }).satoshis)
    );
}

export function planProceeds(
    receipts: ExtendedVirtualCoin[],
    ordinary: ExtendedVirtualCoin[],
    reserved: readonly Outpoint[],
    cfg: RuntimeConfig,
    fees: IntentFeeConfig,
    address: string,
    clock: TimeHeight,
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
                !locked.has(key(c)) &&
                !ids.has(key(c)),
        )
        .sort(
            (a, b) =>
                Number(!!b.assets?.length) - Number(!!a.assets?.length) ||
                a.value - b.value ||
                key(a).localeCompare(key(b)),
        );
    let selected = [...receipts];
    let fee = proceedsFee(selected, fees, hex.encode(expectedAddress.pkScript));
    if (total(selected) - fee < cfg.dust) {
        const reserveValue = (c: ExtendedVirtualCoin) => {
            if (c.assets?.length) return 0n;
            try {
                const expiry = normalizeExpiry(c);
                const height = expiry.kind === "height";
                const at = height ? clock.height : Math.floor(clock.timestamp.getTime() / 1000);
                if (at === undefined || !Number.isSafeInteger(at)) return 0n;
                const headroom = height
                    ? cfg.minExpiryHeadroomBlocks
                    : cfg.minExpiryHeadroomSeconds;
                return expiry.value - BigInt(at) >= headroom ? BigInt(c.value) : 0n;
            } catch {
                return 0n;
            }
        };
        const reserve = available.reduce((sum, c) => sum + reserveValue(c), 0n);
        const sponsor = available.find((c) => {
            const projected = [...receipts, c];
            const consumedReserve = reserveValue(c);
            return (
                (consumedReserve === 0n ||
                    reserve - consumedReserve >= cfg.operatorMinReserveSats) &&
                total(projected) -
                    proceedsFee(projected, fees, hex.encode(expectedAddress.pkScript)) >=
                    cfg.dust
            );
        });
        if (!sponsor) fail("proceeds_reserve_unavailable");
        selected.push(sponsor!);
        fee = proceedsFee(selected, fees, hex.encode(expectedAddress.pkScript));
    }
    if (fee > cfg.proceedsMaxFeeSats) fail("proceeds_fee_cap_exceeded");
    return {
        inputs: selected.map(outpoint),
        coins: selected.map(facts),
        receipts: receipts.map(outpoint),
        address,
        amount: (total(selected) - fee).toString(),
        assets: holdings(selected),
        fee: fee.toString(),
        maxFee: cfg.proceedsMaxFeeSats.toString(),
    };
}

export function reconcileProceeds(
    coins: VirtualCoin[],
    intents: Pick<ArkIntent, "validUntil">[],
    now: number,
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
    if (
        intents.some(
            (i) =>
                i.validUntil === undefined ||
                !Number.isSafeInteger(i.validUntil) ||
                i.validUntil <= 0,
        )
    )
        return { kind: "quarantined", blocker: "proceeds_ambiguous_intent" };
    return { kind: intents.every((i) => i.validUntil! < now) ? "retry" : "pending" };
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
    jobs: ProceedsRepository;
    now?: () => number;
}

export async function discoverProceeds(
    deps: Deps,
    coins: ExtendedVirtualCoin[],
): Promise<ExtendedVirtualCoin[]> {
    const { config, runtime, advances } = deps;
    const tip = await runtime.wallet!.onchainProvider.getChainTip();
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
        const result = await indexer.getVtxos({ outpoints: [point] });
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
    for (const advance of (["recycled", "purchased", "refunded", "recovered"] as const).flatMap(
        (s) => advances.byState(s),
    )) {
        if (!advance.outpoint || !advance.arkTxid || !advance.spentTxid) continue;
        if (hex.encode(advance.operatorKey) !== hex.encode(config.operatorKey))
            fail("proceeds_payout_key_changed");
        const fare = { txid: advance.arkTxid, vout: 1 };
        const repayment = { txid: advance.spentTxid, vout: 0 };
        if (!candidates.has(key(fare)) && !candidates.has(key(repayment))) continue;
        const envelope = validatePersistedLockupGraph(advance, config);
        const tx = Transaction.fromPSBT(base64.decode(envelope.arkTx));
        if (tx.id !== advance.arkTxid) fail("proceeds_lockup_mismatch");
        const covenant = await indexer.getVtxos({ outpoints: [advance.outpoint] });
        if (covenant.vtxos.length !== 1) fail("proceeds_covenant_missing");
        const spend = await classifyObservedSpend(
            advance,
            covenant.vtxos[0]!,
            { config, indexer },
            tip,
        );
        if (spend.kind !== advance.state || spend.txid !== advance.spentTxid)
            fail("proceeds_spend_mismatch");
        if (advance.fare.units > 0n) {
            const fareAssets =
                advance.fare.currency === "asset"
                    ? [
                          {
                              assetId: asset.AssetId.create(
                                  hex.encode(Uint8Array.from(advance.fare.assetId.txid).reverse()),
                                  advance.fare.assetId.groupIndex,
                              ).toString(),
                              amount: advance.fare.units.toString(),
                          },
                      ]
                    : [];
            await check(
                fare,
                advance.fare.currency === "sats" ? advance.fare.units : config.vtxoMinAmount,
                fareAssets,
            );
        }
        if (advance.state !== "purchased")
            await check(
                repayment,
                advance.state === "recycled"
                    ? advance.topup
                    : refundTopup(advance, config.vtxoMinAmount),
                [],
            );
        if (found.size >= 32) break;
    }
    return [...found.values()].slice(0, 32).sort((a, b) => key(a).localeCompare(key(b)));
}

export function createProceedsCollector(deps: Deps) {
    const { config, runtime, jobs, reservations } = deps;
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
        if (
            !settled ||
            outputs.length !== 1 ||
            total(outputs).toString() !== plan.amount ||
            !isDeepStrictEqual(holdings(outputs), plan.assets)
        ) {
            jobs.update(id, "settling", "proceeds_output_pending", commitmentTxid);
            blocker = "proceeds_output_pending";
            return;
        }
        jobs.complete(id, commitmentTxid);
        blocker = null;
    };
    const run = async () => {
        await runtime.assertRecovery();
        let job = jobs.active();
        if (!job) {
            const wallet = runtime.wallet!;
            const coins = await wallet.getSpendableVtxos({ withRecoverable: true });
            const receipts = await discoverProceeds(deps, coins);
            if (!receipts.length) {
                blocker = null;
                return;
            }
            const taxiLocks = reservations.listReservedOutpoints();
            const locks = [
                ...taxiLocks,
                ...(await runtime.storage.intentRepository.getLockedVtxoOutpoints()),
            ];
            const info = await wallet.arkProvider.getInfo();
            const tip = await wallet.onchainProvider.getChainTip();
            const plan = planProceeds(
                receipts,
                coins,
                locks,
                config,
                info.fees?.intentFee ?? {},
                await wallet.getAddress(),
                { height: tip.height, timestamp: new Date(tip.time * 1000) },
            );
            if (stopped) return;
            jobs.create(randomUUID(), plan, now(), taxiLocks);
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
        const outcome = reconcileProceeds(inputs, intents, now());
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
        const heartbeat = setInterval(() => {
            try {
                jobs.claim(id, owner, now(), now() + leaseMs);
            } catch {
                /* submit guard fences a lost lease */
            }
        }, leaseMs / 3);
        try {
            await runtime.withSettlement(
                async (wallet) => {
                    const coins = await wallet.getSpendableVtxos({ withRecoverable: true });
                    const selected = plan.inputs.map((p) => coins.find((c) => key(c) === key(p))!);
                    if (
                        selected.some((c) => !c || !canonical(c, config)) ||
                        !isDeepStrictEqual(selected.map(facts), plan.coins)
                    )
                        fail("proceeds_input_unavailable");
                    const guard = async () => {
                        if (stopped) fail("proceeds_stopped");
                        const verified = await verifyProviders(config, runtime.providers);
                        if (verified.blockers.length || !verified.info)
                            fail("proceeds_provider_unsafe");
                        const fee = proceedsFee(
                            selected,
                            verified.info!.fees?.intentFee ?? {},
                            hex.encode(ArkAddress.decode(plan.address).pkScript),
                        );
                        if (fee.toString() !== plan.fee || fee > BigInt(plan.maxFee))
                            fail("proceeds_fee_authorization_changed");
                        jobs.assertLease(id, owner, now());
                    };
                    await guard();
                    jobs.update(id, "settling", null, null);
                    const commitment = await wallet.settle({
                        inputs: selected,
                        outputs: [{ address: plan.address, amount: BigInt(plan.amount) }],
                    });
                    jobs.update(id, "settling", "proceeds_output_pending", commitment);
                    await confirmOutput(id, plan, commitment);
                },
                () => {
                    if (stopped) fail("proceeds_stopped");
                    jobs.assertLease(id, owner, now());
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
