/**
 * The guard against the failure this suite exists to avoid: a green e2e job
 * that asserted nothing. It reads the sibling test files off disk rather than
 * counting at runtime, because vitest isolates each file's module registry and
 * a cross-file tally would be as easy to lose as the tests themselves.
 */

import { readdirSync, readFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import {
    EXPECTED_LIVE_SCENARIOS,
    EXPECTED_STACK_SCENARIOS,
    SCENARIOS,
    type ScenarioScope,
} from "./scenarios.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const SELF = basename(fileURLToPath(import.meta.url));

const suiteFiles = readdirSync(HERE)
    .filter((f) => f.endsWith(".e2e.test.ts") && f !== SELF)
    .sort();

const sources = new Map(suiteFiles.map((f) => [f, readFileSync(join(HERE, f), "utf8")]));

const idsMatching = (re: RegExp): { id: string; file: string }[] => {
    const out: { id: string; file: string }[] = [];
    for (const [file, src] of sources) {
        for (const m of src.matchAll(re)) out.push({ id: m[1]!, file });
    }
    return out;
};

const registered = new Map<string, { scope: ScenarioScope; file: string }>();
for (const { id, file } of idsMatching(/\bstackScenario\(\s*"([^"]+)"/g)) {
    registered.set(id, { scope: "stack", file });
}
for (const { id, file } of idsMatching(/\bliveScenario\(\s*"([^"]+)"/g)) {
    registered.set(id, { scope: "logic", file });
}

it("registers every scenario exactly once, under its declared scope", () => {
    expect(suiteFiles.length).toBeGreaterThan(0);

    const stackIds = idsMatching(/\bstackScenario\(\s*"([^"]+)"/g).map((r) => r.id);
    const liveIds = idsMatching(/\bliveScenario\(\s*"([^"]+)"/g).map((r) => r.id);
    const all = [...stackIds, ...liveIds];

    expect(new Set(all).size, `a scenario id is registered twice: ${all.join(", ")}`).toBe(
        all.length,
    );
    expect([...registered.keys()].sort()).toEqual(SCENARIOS.map((s) => s.id).sort());

    for (const s of SCENARIOS) {
        expect(registered.get(s.id)?.scope, `${s.id} is registered under the wrong scope`).toBe(
            s.scope,
        );
    }
});

it("skips exactly the number of scenarios the manifest declares blocked", () => {
    const stack = SCENARIOS.filter((s) => s.scope === "stack");
    const live = SCENARIOS.filter((s) => s.scope === "logic");

    // Update these constants deliberately when the transaction layer lands.
    // A scenario that starts running must be moved, not merely un-skipped.
    expect(stack.length).toBe(EXPECTED_STACK_SCENARIOS);
    expect(live.length).toBe(EXPECTED_LIVE_SCENARIOS);
    expect(SCENARIOS.length).toBe(EXPECTED_STACK_SCENARIOS + EXPECTED_LIVE_SCENARIOS);

    expect(idsMatching(/\bstackScenario\(\s*"([^"]+)"/g).length).toBe(EXPECTED_STACK_SCENARIOS);
    expect(idsMatching(/\bliveScenario\(\s*"([^"]+)"/g).length).toBe(EXPECTED_LIVE_SCENARIOS);
});

it("gives every skipped scenario a stated reason and every live one none", () => {
    for (const s of SCENARIOS) {
        if (s.scope === "stack") {
            expect(
                s.blocked.trim().length,
                `${s.id} is skipped without saying why`,
            ).toBeGreaterThan(40);
        } else {
            expect(s.blocked, `${s.id} runs, so it must carry no blocked reason`).toBe("");
        }
        expect(s.title.trim().length).toBeGreaterThan(0);
    }
});

it("routes every test through the manifest, with no ad-hoc skip, todo or only", () => {
    const modifier =
        /\b(?:it|test|describe|suite|ctx|context|task)\s*\.\s*(?:skip|todo|only|skipIf|runIf|fails)\b/;
    const bareTest = /\b(?:it|test)\s*\(/;

    for (const [file, src] of sources) {
        expect(
            modifier.test(src),
            `${file} marks a test skip/todo/only outside scenarios.ts; declare it in SCENARIOS instead`,
        ).toBe(false);
        expect(
            bareTest.test(src),
            `${file} declares a test directly; register it in SCENARIOS and use stackScenario/liveScenario`,
        ).toBe(false);
    }
});
