import { describe, expect, it } from "vitest";
import { QuoteVerificationError, TaxiError } from "../src/errors.js";

describe("TaxiError", () => {
    it("carries a machine-readable code alongside the prose", () => {
        const e = new TaxiError("PAUSED", "operator is paused");
        expect(e.code).toBe("PAUSED");
        expect(e.message).toBe("operator is paused");
        expect(e).toBeInstanceOf(Error);
        expect(e.name).toBe("TaxiError");
    });

    it("preserves a cause", () => {
        const cause = new Error("socket hang up");
        expect(new TaxiError("NETWORK_ERROR", "fetch failed", { cause }).cause).toBe(cause);
    });
});

describe("QuoteVerificationError", () => {
    // Callers that only care "did the taxi layer refuse" catch TaxiError; callers
    // that must distinguish a bad quote from a bad response check the subclass.
    it("is a TaxiError so one catch covers both", () => {
        const e = new QuoteVerificationError("QUOTE_EXPIRED", "quote expired");
        expect(e).toBeInstanceOf(TaxiError);
        expect(e.code).toBe("QUOTE_EXPIRED");
        expect(e.name).toBe("QuoteVerificationError");
    });
});
