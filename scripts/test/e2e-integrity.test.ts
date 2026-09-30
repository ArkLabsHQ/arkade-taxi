import { describe, expect, it } from "vitest";
import { readScenarioIds, validateResults } from "../../e2e/assert-ran.mjs";

const ids = ["first", "second"];
const result = () => ({
    success: true,
    numTotalTests: 2,
    numPassedTests: 2,
    numFailedTests: 0,
    numPendingTests: 0,
    numTodoTests: 0,
    testResults: [
        { assertionResults: ids.map((id) => ({ title: `[${id}] scenario`, status: "passed" })) },
    ],
});

describe("live E2E result gate", () => {
    it("requires the full manifest by default and precisely the direct scenarios locally", () => {
        const full = readScenarioIds();
        const direct = readScenarioIds("direct");
        expect(full).toHaveLength(21);
        expect(direct).toHaveLength(17);
        const passing = {
            ...result(),
            numTotalTests: 19,
            numPassedTests: 19,
            testResults: [
                {
                    assertionResults: [
                        ...direct.map((id: string) => ({
                            title: `[${id}] scenario`,
                            status: "passed",
                        })),
                        { title: "manifest integrity", status: "passed" },
                        { title: "registration integrity", status: "passed" },
                    ],
                },
            ],
        };
        expect(validateResults(passing, direct, 2)).toEqual([]);
        expect(validateResults(passing, full, 2)).not.toEqual([]);
        expect(() => readScenarioIds("arbitrary")).toThrow(/unknown E2E mode/);
    });

    it("rejects missing integrity checks despite every live scenario passing", () => {
        expect(validateResults(result(), ids, 2)).not.toEqual([]);
        const complete = result();
        complete.numTotalTests = 4;
        complete.numPassedTests = 4;
        complete.testResults[0].assertionResults.push(
            { title: "manifest integrity", status: "passed" },
            { title: "registration integrity", status: "passed" },
        );
        expect(validateResults(complete, ids, 2)).toEqual([]);
    });

    it("requires each registered scenario to pass exactly once", () => {
        expect(validateResults(result(), ids)).toEqual([]);
    });

    it.each(["pending", "todo", "failed", "skipped", "focused"])(
        "rejects a %s scenario",
        (status) => {
            const value = result();
            value.testResults[0].assertionResults[0].status = status;
            expect(validateResults(value, ids).join(" ")).toContain("first");
        },
    );

    it("rejects missing and duplicate scenarios even with fabricated passing totals", () => {
        const value = result();
        value.testResults[0].assertionResults[1].title = "[first] duplicate";
        expect(validateResults(value, ids).join(" ")).toMatch(/first.*second/);
    });

    it("rejects non-scenario skips and inconsistent totals", () => {
        const value = result();
        value.numPendingTests = 1;
        value.numTotalTests = 3;
        expect(validateResults(value, ids)).not.toEqual([]);
    });

    it("rejects unknown scenarios and failed suite collection", () => {
        const value = result();
        value.success = false;
        value.testResults[0].assertionResults.push({ title: "[unknown] extra", status: "passed" });
        expect(validateResults(value, ids).join(" ")).toContain("unknown");
    });
});
