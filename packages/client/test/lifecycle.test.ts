import { describe, expect, it } from "vitest";
import { WeakValueRegistry } from "../src/lifecycle.js";

interface Value {
    name: string;
}

const harness = () => {
    const references: { value?: Value }[] = [];
    const callbacks: ((held: { key: string; generation: number }) => void)[] = [];
    const registry = new WeakValueRegistry<string, Value>(
        (value) => {
            const reference = { value };
            references.push(reference);
            return { deref: () => reference.value };
        },
        (callback) => {
            callbacks.push(callback);
            return { register() {} };
        },
    );
    return { registry, references, callbacks };
};

describe("WeakValueRegistry", () => {
    it("shares a live value and opportunistically removes a dead value", () => {
        const { registry, references } = harness();
        const first = registry.getOrCreate("outpoint", () => ({ name: "first" }));
        expect(registry.getOrCreate("outpoint", () => ({ name: "wrong" }))).toBe(first);
        expect(registry.size).toBe(1);

        references[0].value = undefined;
        registry.sweep();

        expect(registry.size).toBe(0);
    });

    it("ignores a stale finalizer callback after a replacement is registered", () => {
        const { registry, references, callbacks } = harness();
        registry.getOrCreate("outpoint", () => ({ name: "first" }));
        references[0].value = undefined;
        const replacement = registry.getOrCreate("outpoint", () => ({ name: "replacement" }));

        callbacks[0]({ key: "outpoint", generation: 1 });

        expect(registry.getOrCreate("outpoint", () => ({ name: "wrong" }))).toBe(replacement);
        expect(registry.size).toBe(1);
    });

    it("sweeps dead entries before claiming an unrelated live value", () => {
        const { registry, references } = harness();
        registry.getOrCreate("dead", () => ({ name: "dead" }));
        const live = registry.getOrCreate("live", () => ({ name: "live" }));
        references[0].value = undefined;

        expect(registry.claim(live, (value) => value.name)).toBe("live");
        expect(registry.size).toBe(1);
    });
});
