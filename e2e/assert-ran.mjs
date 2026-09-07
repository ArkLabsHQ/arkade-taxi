/**
 * "Did my test run?", not "did the job pass?" — usage:
 *   node e2e/assert-ran.mjs [results.json]
 *
 * The expected skip count is read out of scenarios.ts, never restated, so the
 * gate and the manifest cannot drift apart.
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const results = process.argv[2] ?? "e2e-results.json";
const manifestPath = join(dirname(fileURLToPath(import.meta.url)), "scenarios.ts");

const die = (msg) => {
    console.error(`e2e: ${msg}`);
    process.exit(1);
};

if (!existsSync(results)) die(`no result file at ${results} — the suite never ran`);

const manifest = readFileSync(manifestPath, "utf8");
const constant = (name) => {
    // No backslashes: this string survives a YAML block scalar and a shell.
    const m = manifest.match(new RegExp(name + "[^0-9]*([0-9]+)"));
    if (!m) die(`${name} is missing from ${manifestPath}`);
    return Number(m[1]);
};

const expectedSkipped = constant("EXPECTED_STACK_SCENARIOS");
const expectedLive = constant("EXPECTED_LIVE_SCENARIOS");

const r = JSON.parse(readFileSync(results, "utf8"));
const skipped = r.numPendingTests + r.numTodoTests;

const problems = [];
if (r.numTotalTests === 0) problems.push("collected no tests at all");
if (r.numFailedTests !== 0) problems.push(`${r.numFailedTests} failed`);
if (skipped !== expectedSkipped) {
    problems.push(`skipped ${skipped}, manifest declares ${expectedSkipped} blocked`);
}
if (r.numPassedTests < expectedLive) {
    problems.push(`passed ${r.numPassedTests}, fewer than the ${expectedLive} scenarios that run`);
}

console.log(`e2e: ${r.numPassedTests} passed, ${skipped} skipped, ${r.numFailedTests} failed`);
if (problems.length > 0) die(problems.join("; "));
