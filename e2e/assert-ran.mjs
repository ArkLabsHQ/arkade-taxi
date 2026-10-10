import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SWAP_SCENARIOS = [
    "joint-fill-two-owner",
    "receiver-paid-sats-fare-claim",
    "receiver-paid-asset-fare-claim",
    "receiver-paid-mode1-reclaim",
    "receiver-paid-fill-claim",
    "fill-undersigned-foreign-input",
];
// Each leaves its stack unusable for later scenarios, so each runs on a stack
// of its own: they are mutually exclusive as well as terminal, so one shared
// isolated stack is not enough.
const ISOLATED_SCENARIOS = [
    "covenant-unilateral-exit-with-arkd-down",
    "fill-undersigned-foreign-input",
];

export function readScenarioIds(mode = "full") {
    if (!["full", "direct", "isolated"].includes(mode))
        throw new Error(`unknown E2E mode: ${mode}`);
    const manifest = readFileSync(
        join(dirname(fileURLToPath(import.meta.url)), "scenarios.ts"),
        "utf8",
    );
    const ids = [...manifest.matchAll(/\bid:\s*"([^"]+)"/g)].map((match) => match[1]);
    const total = Number(/EXPECTED_TOTAL\s*=\s*(\d+)/.exec(manifest)?.[1]);
    if (
        !Number.isSafeInteger(total) ||
        total < 1 ||
        ids.length !== total ||
        new Set(ids).size !== total ||
        [...SWAP_SCENARIOS, ...ISOLATED_SCENARIOS].some((id) => !ids.includes(id))
    )
        throw new Error(
            "manifest count must match unique live scenarios and swap/isolated classification",
        );
    if (mode === "isolated") return [...ISOLATED_SCENARIOS];
    const shared = ids.filter((id) => !ISOLATED_SCENARIOS.includes(id));
    return mode === "direct" ? shared.filter((id) => !SWAP_SCENARIOS.includes(id)) : shared;
}

/**
 * The scenarios one isolated test file registers, read from the file rather than
 * a second list that could drift from it. Each isolated stack is validated
 * against exactly these, so a file that silently stops registering one fails.
 */
export function isolatedScenarioIds(file) {
    const source = readFileSync(
        resolve(dirname(fileURLToPath(import.meta.url)), "..", file),
        "utf8",
    );
    const ids = [...source.matchAll(/\bliveScenario\(\s*"([^"]+)"/g)].map((match) => match[1]);
    const known = readScenarioIds("isolated");
    if (
        ids.length === 0 ||
        new Set(ids).size !== ids.length ||
        ids.some((id) => !known.includes(id))
    )
        throw new Error(`isolated test ${file} registers no classified isolated scenario`);
    return ids;
}

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
        const args = process.argv.slice(2);
        const mode =
            args[0] === "--direct" ? "direct" : args[0] === "--isolated" ? "isolated" : "full";
        if (mode !== "full") args.shift();
        // One stack per isolated file: the whole isolated class would demand
        // scenarios this stack never ran.
        const isolatedFile = mode === "isolated" ? args.shift() : undefined;
        if (mode === "isolated" && !isolatedFile?.endsWith(".e2e.test.ts"))
            throw new Error("usage: assert-ran.mjs --isolated <test> [results.json]");
        if (args.length > 1 || args[0]?.startsWith("--"))
            throw new Error("usage: assert-ran.mjs [--direct|--isolated <test>] [results.json]");
        const ids = isolatedFile ? isolatedScenarioIds(isolatedFile) : readScenarioIds(mode);
        const results = JSON.parse(readFileSync(args[0] ?? "e2e-results.json", "utf8"));
        // The integrity file runs with the shared suite only.
        const problems = validateResults(results, ids, mode === "isolated" ? 0 : 2);
        if (problems.length) throw new Error(problems.join("; "));
        console.log(
            `e2e (${mode}): ${ids.length} scenarios passed, 0 failed, 0 skipped; ${results.numPassedTests} total assertions`,
        );
    } catch (error) {
        console.error(`e2e: ${error.message}`);
        process.exitCode = 1;
    }
}
