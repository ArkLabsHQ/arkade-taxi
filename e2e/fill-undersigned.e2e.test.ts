import { randomUUID } from "node:crypto";
import { expect } from "vitest";
import { TaxiClient } from "@arkade-taxi/client";
import { admin, health, openLive, poll, required } from "./fixtures.js";
import { liveScenario } from "./scenarios.js";
import { DELIVERED, evidence, quotedFill, signAsCaller } from "./fillSupport.js";

liveScenario("fill-undersigned-foreign-input", async () => {
    const live = await openLive();
    const observed: Record<string, unknown> = {};
    try {
        const quoted = await quotedFill(live);
        const { quote, taxiInputIndexes } = quoted;
        const posted = await signAsCaller(quoted, { underSign: true });
        expect(posted.unsigned.length).toBeGreaterThan(0);
        observed.signedInputs = posted.signed;
        observed.unsignedInputs = posted.unsigned;
        observed.operatorInputs = quote.operatorInputs.map(({ txid, vout }) => ({ txid, vout }));

        const reservedBefore = await Promise.all(
            quote.operatorInputs.map(async ({ txid, vout }) => {
                const found = (await live.indexer.getVtxos({ outpoints: [{ txid, vout }] })).vtxos;
                return { txid, vout, spent: found[0]?.isSpent === true, present: found.length };
            }),
        );
        observed.reservedBefore = reservedBefore;

        const responseStatuses: number[] = [];
        observed.submitResponseStatuses = responseStatuses;
        const submitClient = new TaxiClient({
            baseUrl: required("TAXI_E2E_BASE_URL"),
            fetch: async (...args) => {
                const response = await globalThis.fetch(...args);
                responseStatuses.push(response.status);
                return response;
            },
        });
        const refusal = await submitClient
            .submitFill({
                operationId: randomUUID(),
                quoteId: quote.quoteId,
                arkTx: posted.arkTx,
                checkpoints: posted.checkpoints,
                taxiInputIndexes,
                covenantOutputIndex: 0,
                assetUnits: DELIVERED,
            })
            .then(
                (value) => ({ accepted: true, value }) as const,
                (error: unknown) => ({ accepted: false, error }) as const,
            );
        observed.accepted = refusal.accepted;
        if (!refusal.accepted) {
            const error = refusal.error as { code?: string; message?: string };
            observed.refusal = {
                code: error.code,
                status: responseStatuses[0],
                message: error.message,
            };
        } else observed.submitted = refusal.value;

        const ready = await poll(
            "under-signed fill leaves service ready",
            health,
            (snapshot) =>
                snapshot.status === "ok" &&
                !snapshot.blockers.includes("fill_liability_unresolved"),
            120_000,
        );
        observed.health = ready;

        // Whatever the Taxi answered, no Taxi coin may have moved.
        const reservedAfter = await Promise.all(
            quote.operatorInputs.map(async ({ txid, vout }) => {
                const found = (await live.indexer.getVtxos({ outpoints: [{ txid, vout }] })).vtxos;
                return {
                    txid,
                    vout,
                    spent: found[0]?.isSpent === true,
                    spentBy: found[0]?.spentBy ?? null,
                    arkTxId: found[0]?.arkTxId ?? null,
                };
            }),
        );
        observed.reservedAfter = reservedAfter;
        const quoteAfter = await live.client.getReceiveQuote(quote.quoteId);
        observed.quoteState = quoteAfter.state;
        observed.advance = await live.client.status(quote.quoteId).then(
            (status) => ({ state: status.state, outpoint: status.outpoint ?? null }),
            () => null,
        );
        observed.advanceRow =
            (await admin("advances")).advances.find((row: any) => row.id === quote.quoteId) ?? null;

        expect(refusal.accepted).toBe(false);
        expect(responseStatuses).toEqual([400]);
        expect(quoteAfter.state).toBe("quoted");
        expect(observed.advance).toBeNull();
        expect(observed.advanceRow).toBeNull();
        expect(observed.refusal).toMatchObject({
            code: "fill_foreign_signature_invalid",
            status: 400,
        });
        for (const coin of reservedAfter) {
            expect(coin.spent).toBe(false);
            expect(coin.arkTxId).toBeFalsy();
        }
    } finally {
        evidence("fill-undersigned-foreign-input", observed);
    }
});
