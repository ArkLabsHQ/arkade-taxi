import { Transaction, type IndexerProvider, type VirtualCoin } from "@arkade-os/sdk";
import { base64 } from "@scure/base";
import type { SwapFill, SwapFillRepository } from "@arkade-taxi/db";
import { bytesToHex } from "@arkade-taxi/protocol";
import {
    deriveJointOutputs,
    JointGraphDerivationError,
    type DerivedJointOutput,
} from "./arkade/jointGraphDerivation.js";

export interface SwapFillReconcilerStatus {
    lastTickAt: number | null;
    submitting: number;
    blockers: string[];
}

export interface SwapFillReconciler {
    tick(): Promise<void>;
    status(): SwapFillReconcilerStatus;
}

export interface SwapFillReconcilerStore extends Pick<
    SwapFillRepository,
    | "reconcileCandidates"
    | "listByState"
    | "reconcileSettled"
    | "reconcileRequeue"
    | "recordCancelled"
> {}

export interface SwapFillReconcilerDeps {
    swapFills: SwapFillReconcilerStore;
    indexer: Pick<IndexerProvider, "getVtxos">;
    now(): number;
}

const TXID = /^[0-9a-f]{64}$/i;

const NEVER_INVOKED_CODE = "swap_fill_submit_never_invoked";
const OFFER_SPENT_CODE = "swap_fill_offer_cancelled";
const UNEXPECTED_SPEND = "swap_fill_unexpected_spend";

const key = (txid: string, vout: number): string => `${txid}:${vout}`;

type TrustedOutput = DerivedJointOutput;

// F6: solver_graph_json is caller-supplied, so settlement keys off the trusted
// graph_json and Taxi's own prepared bytes only; fill.solverGraph is never read.
// Every expectation below is derived from the persisted trusted arkTx: the
// receiver at output 0 plus each sponsor-script output (fare and change). The
// solver proceeds output is the solver's business and is never required.
const trustedOutputs = (fill: SwapFill): TrustedOutput[] => {
    const sponsor = fill.sponsorScript;
    const outputs = deriveJointOutputs({ arkTx: fill.graph.arkTx });
    const [receiver, ...rest] = outputs;
    if (!receiver || receiver.vout !== 0) return [];
    return [
        receiver,
        ...rest.filter(
            (output) =>
                output.script.length === sponsor.length &&
                output.script.every((byte, i) => byte === sponsor[i]),
        ),
    ];
};

const preparedTxid = (fill: SwapFill): string | undefined => {
    if (!fill.preparedArkTx) return undefined;
    try {
        const id = Transaction.fromPSBT(base64.decode(fill.preparedArkTx)).id.toLowerCase();
        return TXID.test(id) ? id : undefined;
    } catch {
        return undefined;
    }
};

const assetsMatch = (coin: VirtualCoin, output: TrustedOutput): boolean => {
    const got = new Map<string, bigint>();
    for (const a of coin.assets ?? [])
        got.set(a.assetId, (got.get(a.assetId) ?? 0n) + BigInt(a.amount));
    const want = new Map<string, bigint>();
    for (const a of output.assets) want.set(a.assetId, (want.get(a.assetId) ?? 0n) + a.units);
    if (got.size !== want.size) return false;
    for (const [id, units] of want) if ((got.get(id) ?? -1n) !== units) return false;
    return true;
};

const outputMatches = (txid: string, coin: VirtualCoin, output: TrustedOutput): boolean =>
    coin.txid.toLowerCase() === txid &&
    coin.vout === output.vout &&
    coin.script.toLowerCase() === bytesToHex(output.script).toLowerCase() &&
    BigInt(coin.value) === output.sats &&
    assetsMatch(coin, output);

export function createSwapFillReconciler(deps: SwapFillReconcilerDeps): SwapFillReconciler {
    let lastTickAt: number | null = null;
    let unexpected = new Set<string>();
    let pending: Promise<void> | undefined;

    const reconcile = async (fill: SwapFill): Promise<void> => {
        // F2: stale prepared bytes on quoted rows are inert; only submitting rows resolve.
        if (fill.state !== "submitting") return;
        if (fill.offerTxid === undefined || fill.offerVout === undefined) return;
        const ourTxid = preparedTxid(fill);
        let offer: VirtualCoin | undefined;
        try {
            const response = await deps.indexer.getVtxos({
                outpoints: [{ txid: fill.offerTxid, vout: fill.offerVout }],
            });
            if (!Array.isArray(response.vtxos)) return;
            offer = response.vtxos.find(
                (coin) =>
                    coin.txid.toLowerCase() === fill.offerTxid!.toLowerCase() &&
                    coin.vout === fill.offerVout,
            );
        } catch {
            return;
        }
        const spenders = [offer?.arkTxId, offer?.spentBy]
            .filter((txid): txid is string => typeof txid === "string" && TXID.test(txid))
            .map((txid) => txid.toLowerCase());
        const spent = offer !== undefined && (offer.isSpent || offer.spentBy !== undefined);
        const ours = ourTxid !== undefined && spenders.includes(ourTxid);
        const now = deps.now();
        if (!spent) {
            // Never invoked means the provider definitely never ran, so the
            // fill is safe to re-quote; an invoked fill stays until observed.
            if (!fill.submitInvoked)
                deps.swapFills.reconcileRequeue(
                    fill.id,
                    NEVER_INVOKED_CODE,
                    "provider was never invoked; safe to re-quote (not submitted)",
                    now,
                );
            return;
        }
        if (ours) {
            // A never-invoked spend of our own bytes is impossible; surface it
            // rather than settling or cancelling either ordering.
            if (!fill.submitInvoked) {
                unexpected.add(fill.id);
                return;
            }
            let expected: TrustedOutput[];
            try {
                expected = trustedOutputs(fill);
            } catch (cause) {
                if (cause instanceof JointGraphDerivationError) return;
                throw cause;
            }
            const [receiver] = expected;
            if (!receiver) return;
            let coins: VirtualCoin[];
            try {
                const response = await deps.indexer.getVtxos({
                    outpoints: expected.map((output) => ({ txid: ourTxid!, vout: output.vout })),
                });
                if (!Array.isArray(response.vtxos)) return;
                coins = response.vtxos;
            } catch {
                return;
            }
            const byKey = new Map(
                coins.map((coin) => [key(coin.txid.toLowerCase(), coin.vout), coin]),
            );
            const settled = expected.every((output) => {
                const coin = byKey.get(key(ourTxid!, output.vout));
                return coin !== undefined && outputMatches(ourTxid!, coin, output);
            });
            // Partial or lagging outputs wait; only the full set settles.
            if (settled)
                deps.swapFills.reconcileSettled(
                    fill.id,
                    ourTxid!,
                    { txid: ourTxid!, vout: receiver.vout },
                    now,
                );
            return;
        }
        // Spent by someone else, so this fill can never settle; cancel it.
        const spentTxid = spenders[0];
        if (!spentTxid) return;
        deps.swapFills.recordCancelled(fill.id, spentTxid, OFFER_SPENT_CODE, now);
    };

    return {
        tick() {
            if (!pending)
                pending = (async () => {
                    unexpected = new Set();
                    const rows = deps.swapFills.reconcileCandidates(deps.now());
                    for (const row of rows) {
                        try {
                            await reconcile(row);
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
        status: () => ({
            lastTickAt,
            submitting: deps.swapFills.listByState("submitting").length,
            blockers: unexpected.size ? [UNEXPECTED_SPEND] : [],
        }),
    };
}
