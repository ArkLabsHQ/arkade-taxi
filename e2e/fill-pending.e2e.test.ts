import { expect } from "vitest";
import { ArkAddress } from "@arkade-os/sdk";
import { hex } from "@scure/base";
import { TaxiClient, verifyQuote } from "@arkade-taxi/client";
import { ownCleanup } from "../scripts/lib/scenario-cleanup.mjs";
import { liveScenario } from "./scenarios.js";
import { admin, control, fundingOf, health, poll, required } from "./fixtures.js";
import {
    cleanupDirectFill,
    directCounters,
    directEvidence,
    directReady,
    postDirectFill,
    prepareDirectFill,
    recycleDirectFill,
    settledDirectFill,
} from "./directFillSupport.js";

const point = (input: { txid: string; vout: number }) => `${input.txid}:${input.vout}`;

liveScenario("fill-pending-accepted-quarantine", async () => {
    const prepared = await prepareDirectFill({ unrelatedCoin: true });
    const cleanup = ownCleanup(() => cleanupDirectFill(prepared));
    const observed: Record<string, unknown> = {};
    const responseStatuses: number[] = [];
    observed.responseStatuses = responseStatuses;
    const observedClient = new TaxiClient({
        baseUrl: required("TAXI_E2E_BASE_URL"),
        fetch: async (...args) => {
            const response = await globalThis.fetch(...args);
            responseStatuses.push(response.status);
            return response;
        },
    });
    try {
        const { live, graph, quote } = prepared;
        const before = await directCounters();
        const outputProof = await control("configure", {
            target: "arkd",
            path: "/v1/indexer/vtxos",
            mode: "projection-lag",
            method: "GET",
            query: { outpoints: `${graph.arkTx.id}:0` },
        });
        await control("configure", {
            target: "arkd",
            path: "/v1/tx/submit",
            method: "POST",
            mode: "drop",
        });
        await expect(postDirectFill(prepared, observedClient)).rejects.toMatchObject({
            code: "fill_submission_ambiguous",
        });
        expect(responseStatuses).toEqual([503]);
        const events = await control("events");
        expect(
            events.events.filter(
                (event: any) =>
                    event.target === "arkd" &&
                    event.path === "/v1/tx/submit" &&
                    event.action === "dropped" &&
                    event.status === 200,
            ),
        ).toHaveLength(1);
        const afterDrop = await directCounters();
        expect(afterDrop.submit - before.submit).toBe(1);
        expect(afterDrop.finalize - before.finalize).toBe(0);
        expect(afterDrop.emulator - before.emulator).toBe(0);
        const bound = await live.client.getReceiveQuote(quote.quoteId);
        expect(bound.state).toBe("bound");
        expect(bound.boundFillId).toBeTruthy();
        expect(await live.client.fillStatus(bound.boundFillId!)).toMatchObject({
            state: "submitting",
        });
        expect(await live.client.status(quote.quoteId)).toMatchObject({ state: "locking" });
        const inputs = [...prepared.callerCoins, ...quote.operatorInputs];
        const acceptedInputs = await poll(
            "accepted inputs carry their original spend",
            async () =>
                (
                    await live.indexer.getVtxos({
                        outpoints: inputs.map(({ txid, vout }) => ({ txid, vout })),
                    })
                ).vtxos,
            (coins) =>
                coins.length === inputs.length &&
                inputs.every((input, index) => {
                    const coin = coins.find((coin) => point(coin) === point(input));
                    return (
                        coin?.isSpent === true &&
                        coin.arkTxId === graph.arkTx.id &&
                        coin.spentBy === graph.checkpoints[index]!.id
                    );
                }),
            120_000,
        );
        await poll(
            "original transaction output proof is unavailable",
            () => control("events"),
            (snapshot) =>
                snapshot.events.some(
                    (event: any) =>
                        event.action === "projection-delayed" &&
                        event.ruleId === outputProof.ruleId,
                ),
            120_000,
        );
        const quarantined = await poll(
            "fresh pending quarantine past quote and submit lease",
            health,
            (snapshot) =>
                Date.now() >= quote.expiresAt * 1000 &&
                snapshot.reconciler.fills.lastTickAt >= quote.expiresAt &&
                snapshot.reconciler.fills.submitting === 1 &&
                snapshot.reconciler.fills.blockers.includes("fill_liability_unresolved"),
            Math.max(150_000, quote.expiresAt * 1000 - Date.now() + 60_000),
        );
        expect((await directReady()).status).toBe(503);
        const retained = await live.client.getReceiveQuote(quote.quoteId);
        expect(retained.state).toBe("bound");
        expect(retained.boundFillId).toBe(bound.boundFillId);
        expect(retained.operatorInputs.map(point)).toEqual(quote.operatorInputs.map(point));
        expect((await live.client.status(quote.quoteId)).state).toBe("locking");
        const held = new Set(quote.operatorInputs.map(point));
        const rows = (await admin("advances")).advances;
        expect(rows.find((row: any) => row.id === quote.quoteId)).toMatchObject({
            state: "locking",
        });
        const exposure = (await admin("status")).exposure;
        expect(exposure.outstandingSats).toBe(prepared.verified.params.topup.toString());
        expect(exposure.activeCount).toBe(1);
        const request = {
            senderInputs: [fundingOf(prepared.otherCoin!)],
            senderKey: await prepared.caller.identity.xOnlyPublicKey(),
            receiverKey: ArkAddress.decode(prepared.bobAddress).vtxoTaprootKey,
            senderSats: BigInt(prepared.otherCoin!.value),
            claimMode: "purchase" as const,
            paymentSats: 329n,
        };
        const unrelatedQuote = async () => {
            const next = await live.client.requestQuote(request);
            live.owned.set(next.transferId, {});
            const { envelope } = verifyQuote({
                quote: next,
                info: live.info,
                expect: {
                    receiverKey: request.receiverKey,
                    senderKey: request.senderKey,
                    maxTopupSats: 330n,
                    maxFare: { currency: "sats", units: 0n },
                    minLocktime: 1n,
                    claimMode: "purchase",
                    paymentSats: request.paymentSats,
                },
                trustedServerKey: hex.decode(live.info.serverKey),
                trustedEmulatorKey: hex.decode(live.info.emulatorKey),
                trustedServerUnrollScript: live.unroll.script,
                vtxoMinAmount: BigInt(live.info.vtxoMinAmount),
                hrp: "tark",
                senderInputs: request.senderInputs,
                senderSats: request.senderSats,
            });
            const operatorInputs = envelope.operatorInputs;
            expect(operatorInputs.length).toBeGreaterThan(0);
            expect(operatorInputs.every((input) => !held.has(point(input)))).toBe(true);
            return next.transferId;
        };
        await admin("policy", { quoteTtlSeconds: 10 });
        const admitted = await unrelatedQuote();
        expect((await directReady()).status).toBe(503);
        const outageAt = Math.floor(Date.now() / 1000);
        const sourceProof = await control("configure", {
            target: "arkd",
            path: "/v1/indexer/vtxos",
            mode: "drop",
            method: "GET",
            once: false,
            query: { outpoints: point(prepared.callerCoins[0]!) },
        });
        await poll(
            "pending source-input observation reaches the fault",
            async () =>
                (await control("events")).events.some(
                    (event: any) =>
                        event.target === "arkd" &&
                        event.ruleId === sourceProof.ruleId &&
                        event.action === "dropped" &&
                        event.at >= outageAt * 1000,
                ),
            (seen) => seen,
            120_000,
        );
        await poll(
            "failed fresh observation revokes pending admission",
            health,
            (snapshot) =>
                snapshot.reconciler.fills.lastTickAt > outageAt &&
                snapshot.blockers.includes("fill_liability_unresolved"),
            120_000,
        );
        await expect(observedClient.requestQuote(request)).rejects.toMatchObject({
            code: "not_ready",
        });
        expect(responseStatuses).toEqual([503, 503]);
        await control("reset", { ruleId: sourceProof.ruleId });
        const resetAt = Math.floor(Date.now() / 1000);
        await poll(
            "pending input observation refreshes after outage",
            health,
            (snapshot) =>
                snapshot.reconciler.fills.lastTickAt > resetAt &&
                snapshot.blockers.every((code: string) => code === "fill_liability_unresolved"),
            120_000,
        );
        const readmitted = await unrelatedQuote();
        const beforeCleanup = await directCounters();
        expect(beforeCleanup.submit).toBe(afterDrop.submit);
        expect(beforeCleanup.finalize).toBe(afterDrop.finalize);
        expect(await live.client.fillStatus(bound.boundFillId!)).toMatchObject({
            state: "submitting",
        });
        await control("reset", { ruleId: outputProof.ruleId });
        const settled = await settledDirectFill(prepared);
        const afterSettlement = await directCounters();
        expect(afterSettlement.submit).toBe(afterDrop.submit);
        expect(afterSettlement.finalize).toBe(afterDrop.finalize);
        expect(afterSettlement.emulator).toBe(afterDrop.emulator);
        const money = await recycleDirectFill(prepared);
        Object.assign(observed, {
            quoteId: quote.quoteId,
            fillId: bound.boundFillId,
            txid: graph.arkTx.id,
            acceptedInputs: acceptedInputs.map(({ txid, vout, isSpent, spentBy, arkTxId }) => ({
                txid,
                vout,
                isSpent,
                spentBy,
                arkTxId,
            })),
            quarantinedAt: quarantined.reconciler.fills.lastTickAt,
            heldOperatorInputs: quote.operatorInputs.map(({ txid, vout }) => ({ txid, vout })),
            admitted,
            readmitted,
            signatures: settled.signatures,
            counters: { before, afterDrop, beforeCleanup, afterSettlement },
            finalization: "arkd-one-shot",
            proofFaults: { output: outputProof.ruleId, source: sourceProof.ruleId },
            ...money,
        });
    } finally {
        directEvidence("fill-pending-accepted-quarantine", observed);
        await cleanup();
    }
});
