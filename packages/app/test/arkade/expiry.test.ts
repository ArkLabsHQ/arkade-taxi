import { describe, expect, it } from "vitest";
import { normalizeExpiry } from "../../src/arkade/providers.js";

describe("canonical SDK expiry", () => {
    it("keeps Unix seconds and chain heights as distinct units", () => {
        expect(normalizeExpiry({ expiresAt: new Date(1789132933000) })).toEqual({
            kind: "time",
            value: 1789132933n,
        });
        expect(normalizeExpiry({ expiresAtHeight: 999 })).toEqual({ kind: "height", value: 999n });
    });
    it.each([
        {},
        { expiresAtHeight: 0 },
        { expiresAtHeight: 1.5 },
        { expiresAt: new Date(NaN) },
        { expiresAtHeight: 999, expiresAt: new Date(1789132933000) },
    ])("rejects unknown or ambiguous expiry %j", (value) => {
        expect(() => normalizeExpiry(value)).toThrow(/expiry/);
    });
});
