import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export function validateResults(result, ids, integrityCount = 0) {
    const problems = [];
    if (result.success !== true) problems.push("suite did not succeed");
    if (result.numFailedTests !== 0 || result.numPendingTests !== 0 || result.numTodoTests !== 0)
        problems.push("failed, skipped or todo tests present");
    const assertions = (result.testResults ?? []).flatMap((suite) => suite.assertionResults ?? []);
    if (assertions.length !== ids.length + integrityCount)
        problems.push(
            `expected ${ids.length} scenarios and ${integrityCount} integrity assertions`,
        );
    if (result.numTotalTests !== assertions.length || result.numPassedTests !== assertions.length)
        problems.push("reported test counts disagree with executed assertions");
    const seen = new Map();
    for (const assertion of assertions) {
        const id = /^\[([^\]]+)\]/.exec(assertion.title ?? "")?.[1];
        if (assertion.status !== "passed")
            problems.push(`${id ?? assertion.title}: ${assertion.status}`);
        if (!id) continue;
        if (!ids.includes(id)) problems.push(`unknown scenario ${id}`);
        seen.set(id, (seen.get(id) ?? 0) + 1);
    }
    for (const id of ids)
        if (seen.get(id) !== 1)
            problems.push(`${id}: expected once, observed ${seen.get(id) ?? 0}`);
    return problems;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    try {
        const manifest = readFileSync(
            join(dirname(fileURLToPath(import.meta.url)), "scenarios.ts"),
            "utf8",
        );
        const ids = [...manifest.matchAll(/\bid:\s*"([^"]+)"/g)].map((match) => match[1]);
        const total = Number(/EXPECTED_TOTAL\s*=\s*(\d+)/.exec(manifest)?.[1]);
        if (total !== 19 || ids.length !== total || new Set(ids).size !== total)
            throw new Error("manifest must contain nineteen unique live scenarios");
        const results = JSON.parse(readFileSync(process.argv[2] ?? "e2e-results.json", "utf8"));
        const problems = validateResults(results, ids, 2);
        if (problems.length) throw new Error(problems.join("; "));
        console.log(
            `e2e: ${ids.length} scenarios passed, 0 failed, 0 skipped; ${results.numPassedTests} total assertions`,
        );
    } catch (error) {
        console.error(`e2e: ${error.message}`);
        process.exitCode = 1;
    }
}
