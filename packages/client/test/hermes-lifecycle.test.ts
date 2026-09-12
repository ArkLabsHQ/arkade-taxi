import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
});

describe("Hermes lifecycle support", () => {
    it("loads and shares lifecycle state without FinalizationRegistry", async () => {
        vi.stubGlobal("FinalizationRegistry", undefined);
        vi.resetModules();

        const { WeakValueRegistry } = await import("../src/lifecycle.js");
        const registry = new WeakValueRegistry<string, { name: string }>();
        const first = registry.getOrCreate("outpoint", () => ({ name: "first" }));

        expect(registry.getOrCreate("outpoint", () => ({ name: "wrong" }))).toBe(first);
        expect(registry.size).toBe(1);
    });
});
