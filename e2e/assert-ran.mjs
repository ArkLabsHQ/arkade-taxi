import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SWAP_SCENARIOS = [
    "joint-fill-two-owner",
    "receiver-paid-sats-fare-claim",
    "receiver-paid-asset-fare-claim",
    "receiver-paid-mode1-reclaim",
    "receiver-paid-fill-claim",
];
// Each leaves its stack unusable for later scenarios, so it runs on a stack of its own.
const ISOLATED_SCENARIOS = [
    "covenant-unilateral-exit-with-arkd-down",
    // Leaves a `locking` advance nothing resolves yet: no fill reconciler, no
    // admin cancel, and the lockup reconciler leaves an unobserved covenant be.
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
        if (args.length > 1 || args[0]?.startsWith("--"))
            throw new Error("usage: assert-ran.mjs [--direct|--isolated] [results.json]");
        const ids = readScenarioIds(mode);
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
