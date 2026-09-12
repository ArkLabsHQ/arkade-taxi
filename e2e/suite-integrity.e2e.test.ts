import { readdirSync, readFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { expect, it } from "vitest";
import { EXPECTED_TOTAL, SCENARIOS } from "./scenarios.js";

const here = dirname(fileURLToPath(import.meta.url));
const self = basename(fileURLToPath(import.meta.url));
const registrations: string[] = [];
const violations: string[] = [];
for (const file of readdirSync(here).filter(
    (name) => name === "scenarios.ts" || (name.endsWith(".e2e.test.ts") && name !== self),
)) {
    const source = ts.createSourceFile(
        file,
        readFileSync(join(here, file), "utf8"),
        ts.ScriptTarget.Latest,
        true,
    );
    const visit = (node: ts.Node): void => {
        if (
            ts.isImportSpecifier(node) &&
            file !== "scenarios.ts" &&
            /^(it|test|describe|suite)$/.test(node.propertyName?.text ?? node.name.text)
        )
            violations.push(`${file}: test registration must be imported through the manifest`);
        if (ts.isCallExpression(node)) {
            const callee = node.expression.getText(source);
            if (callee === "liveScenario") {
                if (node.arguments.length !== 2 || !ts.isStringLiteral(node.arguments[0]))
                    violations.push(`${file}: scenario must have a literal ID and implementation`);
                else registrations.push(node.arguments[0].text);
            } else if (/Scenario$/.test(callee)) violations.push(`${file}: ${callee} is not live`);
            if (
                /^(it|test|describe|suite|ctx|context|task)(\.|\[|$)/.test(callee) &&
                !(file === "scenarios.ts" && callee === "it")
            )
                violations.push(`${file}: test bypasses liveScenario: ${callee}`);
        }
        ts.forEachChild(node, visit);
    };
    visit(source);
}

it("registers all nineteen live scenarios exactly once", () => {
    expect(EXPECTED_TOTAL).toBe(19);
    expect(SCENARIOS).toHaveLength(EXPECTED_TOTAL);
    expect(new Set(SCENARIOS.map(({ id }) => id)).size).toBe(EXPECTED_TOTAL);
    expect(registrations.sort()).toEqual(SCENARIOS.map(({ id }) => id).sort());
});

it("rejects unimplemented, skipped, todo, focused and unregistered tests", () => {
    expect(violations).toEqual([]);
});
