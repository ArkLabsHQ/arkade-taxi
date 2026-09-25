import { base64, hex } from "@scure/base";
import {
    asset,
    DefaultVtxo,
    Extension,
    MultisigTapscript,
    scriptFromTapLeafScript,
    Transaction,
    VtxoScript,
    type ExtendedVirtualCoin,
    type VirtualCoin,
} from "@arkade-os/sdk";
import {
    SwapFillClaimError,
    type SwapFill,
    type SwapFillGraph,
    type SwapFillState,
} from "@arkade-taxi/db";
import type { SwapFillBuildRequest } from "../src/arkade/swapFillBuilder.js";
import { taxiAssetIdToSwapId } from "../src/arkade/swapFillBuilder.js";
import type { DecodedOfferTerms, SwapFillStore } from "../src/swapFillQuotes.js";
import { config, fundingCoin, receiverKey, serverKey } from "./fixtures.js";
import { digestJointGraph, OFFER_FILL_TEMPLATE, type JointGraph } from "@arkade-taxi/client";

// Any valid curve point; the fake builds transactions but never signs them.
export const FAKE_MAKER_SCRIPT = `5120${hex.encode(receiverKey)}`;

export const FAKE_COVENANT = new VtxoScript([
    MultisigTapscript.encode({ pubkeys: [serverKey, receiverKey] }).script,
]);
export const FAKE_COVENANT_SCRIPT = hex.encode(FAKE_COVENANT.pkScript);

/** A coin as the indexer serves it: never a taproot tree or leaf. */
export const asIndexed = (coin: ExtendedVirtualCoin): VirtualCoin => {
    const indexed: Partial<ExtendedVirtualCoin> = { ...coin };
    delete indexed.tapTree;
    delete indexed.forfeitTapLeafScript;
    delete indexed.intentTapLeafScript;
    return indexed as VirtualCoin;
};

/** Offer terms whose derived covenant is this `fundingCoin`'s own tree. */
export const offerTaprootOf = (
    coin: ExtendedVirtualCoin,
): Pick<DecodedOfferTerms, "covenantTapTree" | "covenantSpendLeaf"> => ({
    covenantTapTree: coin.tapTree,
    covenantSpendLeaf: scriptFromTapLeafScript(coin.forfeitTapLeafScript),
});

/** The key the fixtures' requests name in `solverKeys`. */
export const SOLVER_KEY = hex.decode("ab".repeat(32));
export const solverTreeOf = (blocks = 144n) =>
    new DefaultVtxo.Script({
        pubKey: SOLVER_KEY,
        serverPubKey: serverKey,
        csvTimelock: { type: "blocks", value: blocks },
    });
/** Leaf 0 is the collaborative {solver, server} spend, leaf 1 the solver's CSV exit. */
export const SOLVER_TREE = solverTreeOf();

export const solverCoin = (
    over: Partial<ExtendedVirtualCoin> = {},
    tree: DefaultVtxo.Script = SOLVER_TREE,
): ExtendedVirtualCoin =>
    fundingCoin({
        script: hex.encode(tree.pkScript),
        tapTree: tree.encode(),
        forfeitTapLeafScript: tree.forfeit(),
        intentTapLeafScript: tree.forfeit(),
        ...over,
    });

/** Wire taproot data for a solver input: its tree and collaborative leaf. */
export const solverTaproot = (tree: VtxoScript = SOLVER_TREE) => ({
    tapTree: hex.encode(tree.encode()),
    spendLeaf: hex.encode(tree.scripts[0]!),
});

/** A real ark tx spends checkpoint outputs, and each checkpoint spends one coin. */
export const checkpointSpending = (coin: { txid: string; vout: number }): Transaction => {
    const cp = new Transaction({ version: 3, lockTime: 0 });
    cp.addInput({ txid: coin.txid, index: coin.vout });
    cp.addOutput({ script: new Uint8Array([0x51]), amount: 1000n });
    return cp;
};

export const sealGraph = (graph: JointGraph): JointGraph => ({
    ...graph,
    graphId: digestJointGraph(
        {
            arkTx: graph.arkTx,
            checkpoints: [...graph.checkpoints],
            inputOwners: [...graph.inputOwners],
        },
        OFFER_FILL_TEMPLATE,
    ),
});

export class MemorySwapFills implements SwapFillStore {
    readonly rows = new Map<string, SwapFill>();
    readonly events: string[] = [];
    insert(fill: SwapFill): void {
        if ([...this.rows.values()].some((r) => r.operationId === fill.operationId))
            throw new Error("UNIQUE constraint failed: swap_fills.operation_id");
        this.rows.set(fill.id, structuredClone(fill));
    }
    get(id: string): SwapFill | undefined {
        const row = this.rows.get(id);
        return row && structuredClone(row);
    }
    getByOperation(operationId: string): SwapFill | undefined {
        const row = [...this.rows.values()].find((r) => r.operationId === operationId);
        return row && structuredClone(row);
    }
    exposureTotals(): { outstandingSats: bigint; activeCount: number } {
        let outstandingSats = 0n;
        let activeCount = 0;
        for (const row of this.rows.values())
            if (
                (row.state === "quoted" || row.state === "submitting") &&
                row.receiveQuoteId === undefined
            ) {
                outstandingSats += row.contributionSats;
                activeCount++;
            }
        return { outstandingSats, activeCount };
    }
    expireQuotes(at: number): number {
        let expired = 0;
        for (const row of this.rows.values())
            if (row.state === "quoted" && row.expiresAt <= at) {
                row.state = "expired" as SwapFillState;
                row.updatedAt = Math.max(row.updatedAt, at);
                expired++;
            }
        return expired;
    }
    listReservedOutpoints(): { txid: string; vout: number }[] {
        return [...this.rows.values()]
            .filter((r) => r.state === "quoted" || r.state === "submitting")
            .flatMap((r) => r.taxiInputs)
            .sort((a, b) => (a.txid < b.txid ? -1 : a.txid > b.txid ? 1 : a.vout - b.vout));
    }
    claimSubmit(
        id: string,
        claim: {
            leaseOwner: string;
            leaseToken: string;
            leaseUntil: number;
            solverGraph: SwapFillGraph;
            now: number;
        },
    ): SwapFill {
        this.events.push("claimSubmit");
        this.expireQuotes(claim.now);
        const current = this.rows.get(id);
        if (!current) throw new SwapFillClaimError("not_found", id);
        if (current.state === "expired") throw new SwapFillClaimError("quote_expired", id);
        if (current.state !== "quoted") throw new SwapFillClaimError("invalid_state", id);
        const claimed: SwapFill = {
            ...structuredClone(current),
            state: "submitting",
            solverGraph: structuredClone(claim.solverGraph),
            leaseOwner: claim.leaseOwner,
            leaseToken: claim.leaseToken,
            leaseUntil: claim.leaseUntil,
            attempts: current.attempts + 1,
            failureCode: undefined,
            failureDetail: undefined,
            updatedAt: Math.max(current.updatedAt, claim.now),
        };
        this.rows.set(id, claimed);
        return structuredClone(claimed);
    }
    recordPrepared(
        id: string,
        leaseToken: string,
        arkTx: string,
        checkpoints: string[],
        now: number,
    ): boolean {
        this.events.push("recordPrepared");
        const current = this.rows.get(id);
        if (!current || current.state !== "submitting" || current.leaseToken !== leaseToken)
            return false;
        this.rows.set(id, {
            ...current,
            preparedArkTx: arkTx,
            preparedCheckpoints: [...checkpoints],
            updatedAt: Math.max(current.updatedAt, now),
        });
        return true;
    }
    recordSubmitInvoked(id: string, leaseToken: string, now: number): boolean {
        this.events.push("recordSubmitInvoked");
        const current = this.rows.get(id);
        if (!current || current.state !== "submitting" || current.leaseToken !== leaseToken)
            return false;
        this.rows.set(id, {
            ...current,
            submitInvoked: true,
            updatedAt: Math.max(current.updatedAt, now),
        });
        return true;
    }
    recordSigningFailure(
        id: string,
        leaseToken: string,
        code: string,
        detail: string,
        now: number,
    ): void {
        this.events.push("recordSigningFailure");
        const current = this.rows.get(id);
        if (!current || current.state !== "submitting" || current.leaseToken !== leaseToken) return;
        this.rows.set(id, {
            ...current,
            state: "quoted",
            failureCode: code,
            failureDetail: detail,
            leaseOwner: undefined,
            leaseToken: undefined,
            leaseUntil: undefined,
            nextAttemptAt: undefined,
            submitInvoked: false,
            updatedAt: Math.max(current.updatedAt, now),
        });
    }
    recordAmbiguous(
        id: string,
        leaseToken: string,
        code: string,
        detail: string,
        nextAttemptAt: number,
        now: number,
    ): void {
        this.events.push("recordAmbiguous");
        const current = this.rows.get(id);
        if (!current || current.state !== "submitting" || current.leaseToken !== leaseToken) return;
        this.rows.set(id, {
            ...current,
            failureCode: code,
            failureDetail: detail,
            nextAttemptAt,
            leaseOwner: undefined,
            leaseToken: undefined,
            leaseUntil: undefined,
            updatedAt: Math.max(current.updatedAt, now),
        });
    }
    recordSettled(
        id: string,
        leaseToken: string,
        txid: string,
        outpoint: { txid: string; vout: number },
        now: number,
    ): SwapFill {
        this.events.push("recordSettled");
        const current = this.rows.get(id);
        if (!current || current.state !== "submitting" || current.leaseToken !== leaseToken)
            throw new SwapFillClaimError("invalid_state", id);
        const settled: SwapFill = {
            ...current,
            state: "settled",
            txid,
            outpoint: { ...outpoint },
            leaseOwner: undefined,
            leaseToken: undefined,
            leaseUntil: undefined,
            nextAttemptAt: undefined,
            updatedAt: Math.max(current.updatedAt, now),
        };
        this.rows.set(id, settled);
        return structuredClone(settled);
    }
    reconcileSettled(
        id: string,
        txid: string,
        outpoint: { txid: string; vout: number },
        now: number,
    ): boolean {
        this.events.push("reconcileSettled");
        const current = this.rows.get(id);
        if (!current || current.state !== "submitting" || !current.submitInvoked) return false;
        this.rows.set(id, {
            ...current,
            state: "settled",
            txid,
            outpoint: { ...outpoint },
            leaseOwner: undefined,
            leaseToken: undefined,
            leaseUntil: undefined,
            nextAttemptAt: undefined,
            updatedAt: Math.max(current.updatedAt, now),
        });
        return true;
    }
    reconcileRequeue(id: string, code: string, detail: string, now: number): boolean {
        this.events.push("reconcileRequeue");
        const current = this.rows.get(id);
        if (!current || current.state !== "submitting" || current.submitInvoked) return false;
        this.rows.set(id, {
            ...current,
            state: "quoted",
            failureCode: code,
            failureDetail: detail,
            leaseOwner: undefined,
            leaseToken: undefined,
            leaseUntil: undefined,
            nextAttemptAt: undefined,
            submitInvoked: false,
            updatedAt: Math.max(current.updatedAt, now),
        });
        return true;
    }
    recordCancelled(id: string, spentTxid: string, code: string, now: number): void {
        this.events.push("recordCancelled");
        const current = this.rows.get(id);
        if (!current || (current.state !== "quoted" && current.state !== "submitting")) return;
        this.rows.set(id, {
            ...current,
            state: "cancelled",
            spentTxid,
            failureCode: code,
            leaseOwner: undefined,
            leaseToken: undefined,
            leaseUntil: undefined,
            nextAttemptAt: undefined,
            updatedAt: Math.max(current.updatedAt, now),
        });
    }
    listByState(state: SwapFillState): SwapFill[] {
        return [...this.rows.values()]
            .filter((r) => r.state === state)
            .sort((a, b) => (a.id < b.id ? -1 : 1))
            .map((r) => structuredClone(r));
    }
    reconcileCandidates(now: number): SwapFill[] {
        return [...this.rows.values()]
            .filter(
                (r) =>
                    r.state === "submitting" &&
                    (r.nextAttemptAt === undefined || r.nextAttemptAt <= now) &&
                    (r.leaseUntil === undefined || r.leaseUntil <= now),
            )
            .sort((a, b) => (a.id < b.id ? -1 : 1))
            .map((r) => structuredClone(r));
    }
}

export class FakeSwapFillGraphBuilder {
    readonly built: SwapFillBuildRequest[] = [];
    mutate?: (graph: JointGraph) => JointGraph;
    constructor(
        private readonly makerScript: string,
        private readonly want: bigint,
        private readonly wantedAsset?: { id: string; amount: bigint },
    ) {}
    async buildSwapFillGraph(req: SwapFillBuildRequest): Promise<JointGraph> {
        this.built.push(req);
        if (req.sponsor?.combineSatsFareWithChange && !req.sponsor.fare)
            throw new Error("sponsor.combineSatsFareWithChange requires a fare");
        const taxiTotal = req.sponsor!.coins.reduce((sum, c) => sum + BigInt(c.value), 0n);
        const solverTotal = req.solverFund.reduce((sum, c) => sum + BigInt(c.value), 0n);
        const combinedFare =
            req.sponsor!.combineSatsFareWithChange && req.sponsor!.fare?.assetId === undefined
                ? (req.sponsor!.fare?.sats ?? 0n)
                : 0n;
        const change = taxiTotal - req.sponsor!.netContributionSats + combinedFare;
        const outputs: { script: Uint8Array; sats: bigint }[] = [
            { script: hex.decode(this.makerScript), sats: this.want },
            { script: req.payoutScript!, sats: solverTotal - this.want },
        ];
        let fareVout = -1;
        if (req.sponsor!.fare && combinedFare === 0n) {
            fareVout = outputs.length;
            const fare = req.sponsor!.fare;
            outputs.push({ script: fare.script, sats: BigInt(fare.sats ?? 330n) });
        }
        const solverVout = 1;
        outputs.push({ script: req.sponsor!.changeScript, sats: change });
        const held = new Map<string, { total: bigint; vins: { vin: number; amount: bigint }[] }>();
        req.solverFund.forEach((coin, i) => {
            for (const a of coin.assets ?? []) {
                const entry = held.get(a.assetId) ?? { total: 0n, vins: [] };
                entry.total += BigInt(a.amount);
                entry.vins.push({ vin: 1 + i, amount: BigInt(a.amount) });
                held.set(a.assetId, entry);
            }
        });
        const groups: asset.AssetGroup[] = [];
        // A sats fare pays an output but names no asset, so it opens no group.
        if (req.sponsor!.fare?.assetId !== undefined) {
            const fareAmount = req.sponsor!.fare.amount!;
            const fareId = taxiAssetIdToSwapId(req.sponsor!.fare.assetId);
            const entry = held.get(fareId);
            held.delete(fareId);
            const outs = [{ vout: fareVout, amount: fareAmount }];
            const remainder = (entry?.total ?? 0n) - fareAmount;
            if (remainder > 0n) outs.push({ vout: solverVout, amount: remainder });
            groups.push(
                asset.AssetGroup.create(
                    asset.AssetId.fromString(fareId),
                    null,
                    (entry?.vins ?? []).map(({ vin, amount }) =>
                        asset.AssetInput.create(vin, amount),
                    ),
                    outs.map(({ vout, amount }) => asset.AssetOutput.create(vout, amount)),
                    [],
                ),
            );
        }
        for (const [id, entry] of held) {
            if (entry.total <= 0n) continue;
            const receiver = this.wantedAsset?.id === id ? this.wantedAsset.amount : 0n;
            const outs = [
                ...(receiver > 0n ? [{ vout: 0, amount: receiver }] : []),
                ...(entry.total > receiver
                    ? [{ vout: solverVout, amount: entry.total - receiver }]
                    : []),
            ];
            groups.push(
                asset.AssetGroup.create(
                    asset.AssetId.fromString(id),
                    null,
                    entry.vins.map(({ vin, amount }) => asset.AssetInput.create(vin, amount)),
                    outs.map(({ vout, amount }) => asset.AssetOutput.create(vout, amount)),
                    [],
                ),
            );
        }
        const tx = new Transaction({ version: 3, lockTime: 0 });
        const inpoints = [
            req.fundingOutpoint,
            ...req.solverFund.map(({ txid, vout }) => ({ txid, vout })),
            ...req.sponsor!.coins.map(({ txid, vout }) => ({ txid, vout })),
        ];
        const checkpoints = inpoints.map(checkpointSpending);
        for (const cp of checkpoints) tx.addInput({ txid: cp.id, index: 0 });
        for (const o of outputs) tx.addOutput({ script: o.script, amount: o.sats });
        if (groups.length) {
            const extOut = Extension.create([asset.Packet.create(groups)]).txOut();
            tx.addOutput({ script: extOut.script, amount: extOut.amount });
        }
        const graph: JointGraph = {
            arkTx: base64.encode(tx.toPSBT()),
            checkpoints: checkpoints.map((cp) => base64.encode(cp.toPSBT())),
            graphId: "",
            inputOwners: [
                null,
                ...req.solverFund.map(() => "solver" as const),
                ...req.sponsor!.coins.map(() => "sponsor" as const),
            ],
        };
        const sealed = sealGraph(graph);
        return this.mutate ? sealGraph(this.mutate(structuredClone(sealed))) : sealed;
    }
}

export const fakeOfferTerms = (over: Partial<DecodedOfferTerms> = {}): DecodedOfferTerms => ({
    covenantTapTree: FAKE_COVENANT.encode(),
    covenantSpendLeaf: FAKE_COVENANT.scripts[0]!,
    makerProceedsScript: hex.decode(FAKE_MAKER_SCRIPT),
    wantAmount: 5000n,
    makerPublicKey: new Uint8Array(32).fill(9),
    emulatorPubkey: config().emulatorPubkey,
    ...over,
});
