import { expect, it } from "vitest";
import { quoteFenceRefusal } from "@arkade-taxi/core";
import {
    PolicyRepository,
    QuoteAdmissionError,
    RecoveryBudgetConflictError,
    ReservationRepository,
    totalExposure,
} from "../src/index.js";
import { CELLS, runGrid } from "./quoteFenceGrid.js";

it("refuses exactly as the db fence does on every grid cell", () => {
    const fence = runGrid((db) => {
        const reservations = new ReservationRepository(db);
        return (request) => reservations.reserveQuote(request);
    });
    const core = runGrid((db) => {
        const policy = new PolicyRepository(db);
        return ({ advance, recoveryExecutionBudget }) => {
            const refusal = quoteFenceRefusal({
                advance,
                policy: policy.get(),
                exposure: totalExposure(db),
                recoveryExecutionBudget,
            });
            if (refusal?.kind === "unquoted")
                throw new Error("reservation: advance must be quoted");
            if (refusal?.kind === "budget") throw new RecoveryBudgetConflictError(advance.id);
            if (refusal) throw new QuoteAdmissionError(refusal.code);
        };
    });
    expect(
        CELLS.flatMap((cell, i) =>
            core[i] === fence[i] ? [] : [{ ...cell, core: core[i], fence: fence[i] }],
        ),
    ).toEqual([]);
});
