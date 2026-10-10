import { createHash } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { base64, hex } from "@scure/base";
import {
    asset,
    Extension,
    Transaction,
    scriptFromTapLeafScript,
    type VirtualCoin,
} from "@arkade-os/sdk";
import { sealFillGraph } from "@arkade-taxi/client";
import { FillRepository, type Fill } from "@arkade-taxi/db";
import type { Advance } from "@arkade-taxi/core";
import { createFillReconciler } from "../src/fillReconciler.js";
import { encodeFillSource, type FillFundingSource } from "../src/arkade/fundingSource.js";
import { deriveJointOutputs } from "../src/arkade/jointGraphDerivation.js";
import { insertReceiveQuote, WANTED_ASSET, WANTED_SWAP_ID } from "./jointFillFixtures.js";
import { fundingCoin, NOW, operatorTree, serverUnroll } from "./fixtures.js";
import { checkpointSpending } from "./graphFixtures.js";

const TAXI = { txid: "cc".repeat(32), vout: 0 };
const FOREIGN = { txid: "ee".repeat(32), vout: 1 };
const OTHER = "ff".repeat(32);
const point = (o: { txid: string; vout: number }) => `${o.txid}:${o.vout}`;
const closers: (() => void)[] = [];
afterEach(() => closers.splice(0).forEach((close) => close()));

const setup = (over: Partial<Fill> = {}) => {
    const inserted = insertReceiveQuote({ wantAmount: 5n, operatorCoin: fundingCoin(TAXI) });
    closers.push(() => inserted.db.close());
    const quote = inserted.quotes.get(inserted.quoteId)!;
    const checkpoints = [TAXI, FOREIGN].map(checkpointSpending);
    const tx = new Transaction({ version: 3 });
    checkpoints.forEach((cp) => tx.addInput({ txid: cp.id, index: 0 }));
    tx.addOutput({ script: operatorTree.pkScript, amount: 4n });
    tx.addOutput({ script: hex.decode("51"), amount: 330n });
    tx.addOutput({ script: inserted.covenant.pkScript, amount: quote.params.dust });
    tx.addOutput({ script: operatorTree.pkScript, amount: 18_800n });
    const packet = asset.Packet.create([
        asset.AssetGroup.create(
            asset.AssetId.fromString(WANTED_SWAP_ID),
            null,
            [asset.AssetInput.create(1, 5n)],
            [asset.AssetOutput.create(2, 5n)],
            [],
        ),
    ]);
    tx.addOutput(Extension.create([packet]).txOut());
    const graph = {
        arkTx: base64.encode(tx.toPSBT()),
        checkpoints: checkpoints.map((cp) => base64.encode(cp.toPSBT())),
    };
    const sealed = sealFillGraph({ ...graph, taxiInputIndexes: [0] });
    const fill: Fill = {
        id: "f1",
        quoteId: quote.id,
        operationId: "op1",
        state: "submitting",
        taxiInputs: [TAXI],
        covenantOutputIndex: 2,
        assetUnits: 5n,
        contributionSats: quote.loanSats,
        fare: quote.fare,
        graph,
        graphId: new Uint8Array(32),
        preparedArkTx: graph.arkTx,
        submitInvoked: true,
        leaseOwner: "handler",
        leaseToken: "token",
        leaseUntil: NOW + 60,
        attempts: 1,
        createdAt: NOW,
        updatedAt: NOW,
        expiresAt: quote.expiresAt,
        ...over,
    };
    const source: FillFundingSource = {
        tag: "fill",
        version: 1,
        receiveQuoteId: quote.id,
        fillId: fill.id,
        operationId: fill.operationId,
        graph: sealed,
        covenantOutputIndex: 2,
        covenantSats: quote.params.dust.toString(),
        assetId: { txid: hex.encode(WANTED_ASSET.txid), groupIndex: 0 },
        assetUnits: "5",
        inputExpiryFloor: {
            kind: quote.inputExpiryFloor.kind,
            value: quote.inputExpiryFloor.value.toString(),
        },
        inputs: [TAXI, FOREIGN].map((input, i) => ({
            ...input,
            role: i === 0 ? "taxi" : "foreign",
            value: "20000",
            script: hex.encode(operatorTree.pkScript),
            tapTree: hex.encode(operatorTree.encode()),
            spendLeaf: hex.encode(scriptFromTapLeafScript(operatorTree.leaves[0]!)),
            assets: i === 0 ? [] : [{ assetId: WANTED_SWAP_ID, amount: "5" }],
            expiry: {
                kind: quote.inputExpiryFloor.kind,
                value: quote.inputExpiryFloor.value.toString(),
            },
        })),
        serverUnrollScript: hex.encode(serverUnroll.script),
        operatorScript: hex.encode(operatorTree.pkScript),
        operatorPayouts: [
            { vout: 0, sats: "4", fareSats: "4" },
            { vout: 3, sats: "18800", fareSats: "4" },
        ],
        recoveryPreflight: {
            digest: createHash("sha256").update(JSON.stringify(graph)).digest("hex"),
            expectedTxid: tx.id,
            arkTx: graph.arkTx,
            checkpoints: graph.checkpoints,
        },
    };
    const advance: Advance = {
        id: quote.id,
        state: "locking",
        ...quote.params,
        assetUnits: 5n,
        covenantAddress: quote.covenantAddress,
        fare: quote.fare,
        createdAt: NOW,
        updatedAt: NOW,
        expiresAt: fill.expiresAt,
        recoveryLocktime: quote.recoveryLocktime,
        operatorInputs: [TAXI],
        unsignedLockupTx: encodeFillSource(source),
        unsignedLockupId: sealed.graphId,
    };
    inserted.quotes.bindFill({
        quoteId: quote.id,
        fill,
        advance,
        expectedPolicyRevision: quote.policyRevision,
        now: NOW,
    });
    const fills = new FillRepository(inserted.db);
    const coins = new Map<string, VirtualCoin>(
        [TAXI, FOREIGN].map((o) => [point(o), fundingCoin(o)]),
    );
    let at = NOW + 120;
    let fail = false;
    let onRead: (() => void) | undefined;
    const reconciler = createFillReconciler({
        fills,
        advances: inserted.advances,
        now: () => at,
        indexer: {
            getVtxos: async (opts) => {
                onRead?.();
                if (fail) throw new Error("indexer down");
                return {
                    vtxos: opts?.outpoints?.map((o) => coins.get(point(o))!).filter(Boolean) ?? [],
                };
            },
        },
    });
    const land = () => {
        coins.set(
            point(TAXI),
            fundingCoin({ ...TAXI, isSpent: true, arkTxId: checkpoints[0]!.id }),
        );
        for (const out of deriveJointOutputs(graph))
            coins.set(
                point({ txid: tx.id, vout: out.vout }),
                fundingCoin({
                    txid: tx.id,
                    vout: out.vout,
                    script: hex.encode(out.script),
                    value: Number(out.sats),
                    assets: out.assets.map((a) => ({ assetId: a.assetId, amount: a.units })),
                }),
            );
    };
    const reservations = () => inserted.reservations.listReservedOutpoints();
    return {
        ...inserted,
        fills,
        fill,
        coins,
        txid: tx.id,
        reconciler,
        land,
        reservations,
        setTime: (time: number) => {
            at = time;
        },
        setFail: () => {
            fail = true;
        },
        setOnRead: (fn: () => void) => {
            onRead = fn;
        },
    };
};

describe("generic fill reconciliation", () => {
    it("settles a lost reply from checkpoint-spend evidence and covenant vout 2", async () => {
        const h = setup({ failureCode: "fill_submission_ambiguous" });
        h.land();
        await h.reconciler.tick();
        expect(h.fills.get("f1")!.state).toBe("settled");
        expect(h.advances.get(h.quoteId)!.outpoint).toEqual({ txid: h.txid, vout: 2 });
        expect(h.quotes.get(h.quoteId)!.state).toBe("bound");
        expect(h.reconciler.status().blockers).toEqual([]);
    });
    it.each(["missing", "script", "sats", "assets"])(
        "requires every exact operator payout: %s",
        async (kind) => {
            const h = setup();
            h.land();
            const key = point({ txid: h.txid, vout: 3 });
            if (kind === "missing") h.coins.delete(key);
            else
                h.coins.set(key, {
                    ...h.coins.get(key)!,
                    ...(kind === "script"
                        ? { script: "51" }
                        : kind === "sats"
                          ? { value: 18801 }
                          : { assets: [{ assetId: WANTED_SWAP_ID, amount: 1n }] }),
                });
            await h.reconciler.tick();
            expect(h.fills.get("f1")!.state).toBe("submitting");
            expect(h.advances.get(h.quoteId)!.state).toBe("locking");
            expect(h.reservations()).toEqual([TAXI]);
        },
    );
    it("keeps invoked unspent coins reserved beyond TTL and exposes unresolved liability", async () => {
        const h = setup();
        await h.reconciler.tick();
        expect(h.fills.get("f1")!.state).toBe("submitting");
        expect(h.reservations()).toEqual([TAXI]);
        expect(h.reconciler.status().blockers).toEqual(["fill_liability_unresolved"]);
    });
    it("cancels a never-invoked crash and releases its linked liability", async () => {
        const h = setup({ submitInvoked: false });
        await h.reconciler.tick();
        expect(h.fills.get("f1")!.state).toBe("cancelled");
        expect(h.advances.get(h.quoteId)!.state).toBe("expired");
        expect(h.reservations()).toEqual([]);
        expect(h.quotes.get(h.quoteId)!.state).toBe("bound");
    });
    it("cancels only a confirmed foreign spender, terminalizing the advance", async () => {
        const h = setup();
        h.coins.set(point(FOREIGN), fundingCoin({ ...FOREIGN, isSpent: true, spentBy: OTHER }));
        await h.reconciler.tick();
        expect(h.fills.get("f1")!.spentTxid).toBe(OTHER);
        expect(h.advances.get(h.quoteId)!.state).toBe("expired");
        expect(h.reservations()).toEqual([]);
    });
    it("does not release on a spender hint without spent evidence", async () => {
        const h = setup();
        h.coins.set(point(FOREIGN), fundingCoin({ ...FOREIGN, arkTxId: OTHER }));
        await h.reconciler.tick();
        expect(h.fills.get("f1")!.state).toBe("submitting");
    });
    it("does not touch an active handler lease even with landed outputs", async () => {
        const h = setup({ leaseUntil: NOW + 300 });
        h.land();
        await h.reconciler.tick();
        expect(h.fills.get("f1")!.state).toBe("submitting");
    });
    it("rejects stale reconciliation if a handler changed the row during observation", async () => {
        const h = setup();
        h.land();
        h.setOnRead(() =>
            h.db
                .prepare("UPDATE fills SET lease_token = 'new', lease_until = ? WHERE id = 'f1'")
                .run(NOW + 400),
        );
        await h.reconciler.tick();
        expect(h.fills.get("f1")!.state).toBe("submitting");
    });
    it("keeps indexer failures unresolved and observable", async () => {
        const h = setup();
        h.setFail();
        await h.reconciler.tick();
        expect(h.reconciler.status().blockers).toEqual(["fill_liability_unresolved"]);
        expect(h.reservations()).toEqual([TAXI]);
    });
    it("refuses unexpected own bytes when the provider was never invoked", async () => {
        const h = setup({ submitInvoked: false });
        h.land();
        await h.reconciler.tick();
        expect(h.fills.get("f1")!.state).toBe("submitting");
        expect(h.reconciler.status().blockers).toContain("fill_unexpected_spend");
    });
    it("derives settlement from the trusted graph despite a false reply txid", async () => {
        const h = setup({ txid: OTHER, preparedArkTx: "not-a-psbt" });
        h.land();
        await h.reconciler.tick();
        expect(h.fills.get("f1")!.txid).toBe(h.txid);
        expect(h.fills.get("f1")!.state).toBe("settled");
    });
    it("cannot omit a required payout by truncating the persisted payout hints", async () => {
        const h = setup();
        h.land();
        const current = h.advances.get(h.quoteId)!.unsignedLockupTx!;
        const source = JSON.parse(current.slice("taxi-source:".length)) as FillFundingSource;
        source.operatorPayouts = source.operatorPayouts.slice(0, 1);
        h.db
            .prepare("UPDATE advances SET unsigned_lockup_tx = ? WHERE id = ?")
            .run(encodeFillSource(source), h.quoteId);
        h.coins.delete(point({ txid: h.txid, vout: 3 }));
        await h.reconciler.tick();
        expect(h.fills.get("f1")!.state).toBe("submitting");
        expect(h.reservations()).toEqual([TAXI]);
    });
    it.each(["operation", "graph", "covenant", "asset"])(
        "refuses mismatched trusted funding linkage: %s",
        async (kind) => {
            const h = setup();
            h.land();
            if (kind === "operation")
                h.db.prepare("UPDATE fills SET operation_id = 'other' WHERE id = 'f1'").run();
            if (kind === "graph")
                h.db
                    .prepare("UPDATE fills SET graph_json = ? WHERE id = 'f1'")
                    .run(JSON.stringify({ arkTx: "bad", checkpoints: [] }));
            if (kind === "covenant")
                h.db.prepare("UPDATE fills SET covenant_output_index = 0 WHERE id = 'f1'").run();
            if (kind === "asset")
                h.db.prepare("UPDATE fills SET asset_units = 6 WHERE id = 'f1'").run();
            await h.reconciler.tick();
            expect(h.fills.get("f1")!.state).toBe("submitting");
            expect(h.reconciler.status().blockers).toEqual(["fill_liability_unresolved"]);
        },
    );
    it("requires exact covenant assets even when every payout arrived", async () => {
        const h = setup();
        h.land();
        const key = point({ txid: h.txid, vout: 2 });
        h.coins.set(key, { ...h.coins.get(key)!, assets: [] });
        await h.reconciler.tick();
        expect(h.fills.get("f1")!.state).toBe("submitting");
    });
    it("does not settle from indexed outputs without own spend evidence", async () => {
        const h = setup();
        h.land();
        h.coins.set(point(TAXI), fundingCoin(TAXI));
        await h.reconciler.tick();
        expect(h.fills.get("f1")!.state).toBe("submitting");
    });
    it("preserves mixed own and conflicting spend evidence for operator review", async () => {
        const h = setup();
        h.land();
        h.coins.set(point(FOREIGN), fundingCoin({ ...FOREIGN, isSpent: true, spentBy: OTHER }));
        await h.reconciler.tick();
        expect(h.fills.get("f1")!.state).toBe("submitting");
        expect(h.reconciler.status().blockers).toContain("fill_unexpected_spend");
        expect(h.reservations()).toEqual([TAXI]);
    });
    it("keeps liability when one spent coin reports both own and foreign spenders", async () => {
        const h = setup();
        h.land();
        h.coins.set(point(TAXI), { ...h.coins.get(point(TAXI))!, spentBy: OTHER });
        await h.reconciler.tick();
        expect(h.fills.get("f1")!.state).toBe("submitting");
        expect(h.advances.get(h.quoteId)!.state).toBe("locking");
        expect(h.reconciler.status().blockers).toContain("fill_unexpected_spend");
        expect(h.reservations()).toEqual([TAXI]);
    });
    it("holds conflicting spend evidence when an own spender is marked unspent", async () => {
        const h = setup();
        h.land();
        h.coins.set(point(TAXI), { ...h.coins.get(point(TAXI))!, isSpent: false });
        h.coins.set(point(FOREIGN), fundingCoin({ ...FOREIGN, isSpent: true, spentBy: OTHER }));
        await h.reconciler.tick();
        expect(h.fills.get("f1")!.state).toBe("submitting");
        expect(h.reconciler.status().blockers).toContain("fill_unexpected_spend");
        expect(h.reservations()).toEqual([TAXI]);
    });
    it("holds a spent coin with an unknown spender despite another input's conflict", async () => {
        const h = setup();
        h.coins.set(point(TAXI), fundingCoin({ ...TAXI, isSpent: true }));
        h.coins.set(point(FOREIGN), fundingCoin({ ...FOREIGN, isSpent: true, spentBy: OTHER }));
        await h.reconciler.tick();
        expect(h.fills.get("f1")!.state).toBe("submitting");
        expect(h.reservations()).toEqual([TAXI]);
    });
});
