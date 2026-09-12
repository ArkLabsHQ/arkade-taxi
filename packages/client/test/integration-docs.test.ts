import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const integrationGuide = readFileSync(
    new URL("../../../docs/integration-js.md", import.meta.url),
    "utf8",
);

describe("JavaScript integration guide", () => {
    it("states the ambient fetch trust boundary for covenant providers", () => {
        expect(integrationGuide).toMatch(/SDK REST providers use the realm's `globalThis\.fetch`/);
        expect(integrationGuide).toMatch(/`TaxiClient\(\{ fetch \}\)` does not configure/);
        expect(integrationGuide).toMatch(/same-realm code.*replace or\s+intercept.*global fetch/is);
        expect(integrationGuide).toMatch(/TLS.*reverse\s+proxy/is);
    });
});
