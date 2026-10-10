import { randomUUID } from "node:crypto";
import { expect } from "vitest";
import { admin, openLive } from "./fixtures.js";
import { liveScenario } from "./scenarios.js";
import { DELIVERED, evidence, quotedFill, signAsCaller } from "./fillSupport.js";

/**
 * The claim phase 7 gates on: with `assertSolverAuthorised` deleted, nothing
 * pins the caller's keys, so an under-signed foreign input must fail the whole
 * submission rather than move anything. Posts a graph with a caller-owned input
 * deliberately unsigned and records exactly what the provider answered.
 *
 * Runs last in the suite, and nothing may follow it: an ambiguous submission is
 * the documented unresolved state and nothing resolves it yet — no fill
 * reconciler, no admin action that cancels a `locking` advance, and
 * `reconciler.ts` leaves an unobserved covenant alone rather than guess. So the
 * advance it leaves would trip the next scenario's boundary check.
 */
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

        const refusal = await live.client
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
            const error = refusal.error as { code?: string; status?: number; message?: string };
            observed.refusal = {
                code: error.code,
                status: error.status,
                message: error.message,
            };
        } else observed.submitted = refusal.value;

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
        // Phase 7's gate needs the PROVIDER's refusal, not the Taxi's own. The
        // quote only reaches `bound` after validation passes, immediately before
        // the Taxi signs and submits, so this is what proves the graph got that
        // far instead of being turned away by a graph rule.
        expect(quoteAfter.state).toBe("bound");
        expect(["fill_submission_ambiguous", "fill_signing_failed"]).toContain(
            (observed.refusal as { code?: string }).code,
        );
        for (const coin of reservedAfter) {
            expect(coin.spent).toBe(false);
            expect(coin.arkTxId).toBeFalsy();
        }
    } finally {
        evidence("fill-undersigned-foreign-input", observed);
    }
});
