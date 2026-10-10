import { ArkAddress, Transaction, type IndexerProvider, type VirtualCoin } from "@arkade-os/sdk";
import { base64, hex } from "@scure/base";
import type { AdvanceRepository, Fill, FillRepository } from "@arkade-taxi/db";
import { readFundingSource } from "./arkade/fundingSource.js";
import {
    deriveJointInputs,
    deriveJointOutputs,
    type DerivedJointOutput,
} from "./arkade/jointGraphDerivation.js";

export interface FillReconcilerStatus {
    lastTickAt: number | null;
    submitting: number;
    blockers: string[];
}
export interface FillReconciler {
    tick(): Promise<void>;
    status(): FillReconcilerStatus;
}
export interface FillReconcilerDeps {
    fills: Pick<
        FillRepository,
        "reconcileCandidates" | "listByState" | "reconcileSettled" | "reconcileCancelled"
    >;
    advances: Pick<AdvanceRepository, "get">;
    indexer: Pick<IndexerProvider, "getVtxos">;
    now(): number;
}
const point = (o: { txid: string; vout: number }) => `${o.txid.toLowerCase()}:${o.vout}`;
const spenders = (coin: VirtualCoin): string[] =>
    [coin.arkTxId, coin.spentBy]
        .filter((id): id is string => typeof id === "string" && /^[0-9a-f]{64}$/i.test(id))
        .map((id) => id.toLowerCase());
const outputMatches = (coin: VirtualCoin, txid: string, output: DerivedJointOutput): boolean => {
    const got = new Map<string, bigint>();
    const want = new Map<string, bigint>();
    for (const holding of coin.assets ?? [])
        got.set(holding.assetId, (got.get(holding.assetId) ?? 0n) + BigInt(holding.amount));
    for (const holding of output.assets)
        want.set(holding.assetId, (want.get(holding.assetId) ?? 0n) + holding.units);
    return (
        coin.txid.toLowerCase() === txid &&
        coin.vout === output.vout &&
        coin.script.toLowerCase() === hex.encode(output.script) &&
        BigInt(coin.value) === output.sats &&
        got.size === want.size &&
        [...want].every(([id, units]) => got.get(id) === units)
    );
};

export function createFillReconciler(deps: FillReconcilerDeps): FillReconciler {
    let lastTickAt: number | null = null;
    let unexpected = new Set<string>();
    let pending: Promise<void> | undefined;
    const reconcile = async (fill: Fill): Promise<void> => {
        if (
            fill.state !== "submitting" ||
            (fill.leaseUntil !== undefined && fill.leaseUntil > deps.now())
        )
            return;
        const advance = deps.advances.get(fill.quoteId);
        if (!advance?.unsignedLockupTx) return;
        const trusted = readFundingSource(advance.unsignedLockupTx);
        if (trusted.kind !== "fill") return;
        const source = trusted.source;
        const txid = trusted.covenantOutpoint.txid;
        const taxi = source.inputs.filter((input) => input.role === "taxi");
        if (
            source.fillId !== fill.id ||
            source.receiveQuoteId !== fill.quoteId ||
            source.operationId !== fill.operationId ||
            trusted.arkTx !== fill.graph.arkTx ||
            JSON.stringify(trusted.checkpoints) !== JSON.stringify(fill.graph.checkpoints) ||
            trusted.covenantOutpoint.vout !== fill.covenantOutputIndex ||
            trusted.assetUnits !== fill.assetUnits ||
            advance.unsignedLockupId !== trusted.graphId ||
            advance.assetUnits !== trusted.assetUnits ||
            advance.dust !== BigInt(source.covenantSats) ||
            advance.topup !== fill.contributionSats ||
            advance.assetId === undefined ||
            hex.encode(advance.assetId.txid) !== source.assetId.txid ||
            advance.assetId.groupIndex !== source.assetId.groupIndex ||
            hex.encode(ArkAddress.decode(advance.covenantAddress).pkScript) !==
                hex.encode(trusted.covenantScript) ||
            taxi.length === 0 ||
            taxi.length !== fill.taxiInputs.length ||
            taxi.some((input) => !fill.taxiInputs.some((other) => point(input) === point(other))) ||
            advance.operatorInputs.length !== taxi.length ||
            advance.operatorInputs.some(
                (input) => !taxi.some((other) => point(input) === point(other)),
            )
        )
            return;
        const inputs = deriveJointInputs(source.graph);
        const ownForInput = inputs.map(
            (_, i) =>
                new Set([
                    txid,
                    Transaction.fromPSBT(
                        base64.decode(source.graph.checkpoints[i]!),
                    ).id.toLowerCase(),
                ]),
        );
        const response = await deps.indexer.getVtxos({
            outpoints: inputs.map(({ txid, vout }) => ({ txid, vout })),
        });
        if (!Array.isArray(response.vtxos)) return;
        const byPoint = new Map(response.vtxos.map((coin) => [point(coin), coin]));
        const observations = inputs.map((input, i) => {
            const coin = byPoint.get(point(input));
            const hints = coin ? spenders(coin) : [];
            const ids = coin?.isSpent ? hints : [];
            return {
                input,
                own: ids.some((id) => ownForInput[i]!.has(id)),
                ownHint: hints.some((id) => ownForInput[i]!.has(id)),
                unknownSpend: coin?.isSpent === true && ids.length === 0,
                conflict: ids.find((id) => !ownForInput[i]!.has(id)),
            };
        });
        if (observations.some((observation) => observation.ownHint && !observation.own)) {
            unexpected.add(fill.id);
            return;
        }
        if (observations.some((observation) => observation.unknownSpend)) return;
        const ownsAnySpend = observations.some((observation) => observation.own);
        if (!fill.submitInvoked) {
            if (ownsAnySpend) unexpected.add(fill.id);
            else deps.fills.reconcileCancelled(fill, "fill_submit_never_invoked", deps.now());
            return;
        }
        const conflict = observations.find((observation) => observation.conflict !== undefined);
        if (conflict) {
            if (ownsAnySpend) unexpected.add(fill.id);
            else
                deps.fills.reconcileCancelled(
                    fill,
                    "fill_input_conflict",
                    deps.now(),
                    conflict.conflict,
                );
            return;
        }
        if (
            !observations
                .filter((o) => taxi.some((input) => point(input) === point(o.input)))
                .every((o) => o.own)
        )
            return;
        const outputs = deriveJointOutputs(source.graph);
        const covenant = outputs.find((output) => output.vout === fill.covenantOutputIndex);
        if (!covenant) return;
        // Derive all operator outputs; a truncated payout list cannot weaken settlement.
        const expected = [
            covenant,
            ...outputs.filter(
                (output) =>
                    output.vout !== covenant.vout &&
                    hex.encode(output.script) === source.operatorScript,
            ),
        ];
        if (expected.length === 1) return;
        const indexed = await deps.indexer.getVtxos({
            outpoints: expected.map((output) => ({ txid, vout: output.vout })),
        });
        if (!Array.isArray(indexed.vtxos)) return;
        const byOutput = new Map(indexed.vtxos.map((coin) => [point(coin), coin]));
        if (
            expected.every((output) => {
                const coin = byOutput.get(point({ txid, vout: output.vout }));
                return coin !== undefined && outputMatches(coin, txid, output);
            })
        )
            deps.fills.reconcileSettled(fill, txid, trusted.covenantOutpoint, deps.now());
    };
    return {
        tick() {
            if (!pending)
                pending = (async () => {
                    unexpected = new Set();
                    for (const fill of deps.fills.reconcileCandidates(deps.now())) {
                        try {
                            await reconcile(fill);
                        } catch {
                            continue;
                        }
                    }
                    lastTickAt = deps.now();
                })().finally(() => {
                    pending = undefined;
                });
            return pending;
        },
        status() {
            const rows = deps.fills.listByState("submitting");
            return {
                lastTickAt,
                submitting: rows.length,
                blockers: [
                    ...(rows.some((row) => unexpected.has(row.id))
                        ? ["fill_unexpected_spend"]
                        : []),
                    ...(rows.some(
                        (row) => row.leaseUntil === undefined || row.leaseUntil <= deps.now(),
                    )
                        ? ["fill_liability_unresolved"]
                        : []),
                ],
            };
        },
    };
}
