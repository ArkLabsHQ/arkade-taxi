import { base64, hex } from "@scure/base";
import { asset, Extension, Transaction } from "@arkade-os/sdk";
import {
    SwapFillClaimError,
    type SwapFill,
    type SwapFillGraph,
    type SwapFillState,
} from "@arkade-taxi/db";
import type { SwapFillBuildRequest } from "../src/arkade/swapFillBuilder.js";
import { taxiAssetIdToSwapId } from "../src/arkade/swapFillBuilder.js";
import type { DecodedOfferTerms, SwapFillStore } from "../src/swapFillQuotes.js";
import { config, receiverKey } from "./fixtures.js";
import { digestJointGraph, OFFER_FILL_TEMPLATE, type JointGraph } from "@arkade-taxi/client";

// Any valid curve point; the fake builds transactions but never signs them.
export const FAKE_MAKER_SCRIPT = `5120${hex.encode(receiverKey)}`;

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
            if (row.state === "quoted" || row.state === "submitting") {
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
    ) {}
    async buildSwapFillGraph(req: SwapFillBuildRequest): Promise<JointGraph> {
        this.built.push(req);
        const taxiTotal = req.sponsor!.coins.reduce((sum, c) => sum + BigInt(c.value), 0n);
        const solverTotal = req.solverFund.reduce((sum, c) => sum + BigInt(c.value), 0n);
        const change = taxiTotal - req.sponsor!.netContributionSats;
        const outputs: { script: Uint8Array; sats: bigint }[] = [
            { script: hex.decode(this.makerScript), sats: this.want },
            { script: req.payoutScript!, sats: solverTotal - this.want },
        ];
        let fareVout = -1;
        if (req.sponsor!.fare) {
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
            groups.push(
                asset.AssetGroup.create(
                    asset.AssetId.fromString(id),
                    null,
                    entry.vins.map(({ vin, amount }) => asset.AssetInput.create(vin, amount)),
                    [asset.AssetOutput.create(solverVout, entry.total)],
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
        for (const o of inpoints) tx.addInput({ txid: o.txid, index: o.vout });
        for (const o of outputs) tx.addOutput({ script: o.script, amount: o.sats });
        if (groups.length) {
            const extOut = Extension.create([asset.Packet.create(groups)]).txOut();
            tx.addOutput({ script: extOut.script, amount: extOut.amount });
        }
        const graph: JointGraph = {
            arkTx: base64.encode(tx.toPSBT()),
            checkpoints: inpoints.map((o) => {
                const cp = new Transaction({ version: 3, lockTime: 0 });
                cp.addInput({ txid: o.txid, index: o.vout });
                cp.addOutput({ script: new Uint8Array([0x51]), amount: 1000n });
                return base64.encode(cp.toPSBT());
            }),
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
    covenantScript: hex.decode("ac".repeat(34)),
    makerProceedsScript: hex.decode(FAKE_MAKER_SCRIPT),
    wantAmount: 5000n,
    makerPublicKey: new Uint8Array(32).fill(9),
    emulatorPubkey: config().emulatorPubkey,
    ...over,
});
