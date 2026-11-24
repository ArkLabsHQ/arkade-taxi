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
        const { quote, graph, taxiInputIndexes } = quoted;
        const undersigned = await signAsCaller(quoted, { underSign: true });
        expect(undersigned.unsigned.length).toBeGreaterThan(0);
        // The taker signs the deposit's arkTx input and omits its checkpoint signature.
        const signed = await signAsCaller(quoted);
        const deposit = graph.inputOwners.indexOf(null);
        const depositCheckpoint = {
            arkTx: signed.arkTx,
            checkpoints: signed.checkpoints.map((psbt, i) =>
                i === deposit ? graph.checkpoints[i]! : psbt,
            ),
        };
        observed.signedInputs = undersigned.signed;
        observed.unsignedInputs = undersigned.unsigned;
        observed.unsignedDepositCheckpoint = deposit;
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
        const refusals: Record<string, unknown> = {};
        observed.refusals = refusals;
        const cases = { callerCoin: undersigned, depositCheckpoint };
        for (const [name, posted] of Object.entries(cases)) {
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
            if (!refusal.accepted) {
                const error = refusal.error as { code?: string; message?: string };
                refusals[name] = {
                    accepted: false,
                    code: error.code,
                    status: responseStatuses.at(-1),
                    message: error.message,
                };
            } else refusals[name] = { accepted: true, submitted: refusal.value };
        }

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

        expect(responseStatuses).toEqual([400, 400]);
        expect(quoteAfter.state).toBe("quoted");
        expect(observed.advance).toBeNull();
        expect(observed.advanceRow).toBeNull();
        for (const refusal of Object.values(refusals))
            expect(refusal).toMatchObject({
                accepted: false,
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
