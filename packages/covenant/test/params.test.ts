import { describe, expect, it } from "vitest";
import { refundTopup, validateParams, type DustCovenantParams } from "../src/params.js";

const key = (fill: number) => new Uint8Array(32).fill(fill);

const base = (): DustCovenantParams => ({
    receiverKey: key(1),
    senderKey: key(2),
    operatorKey: key(3),
    dust: 330n,
    topup: 330n,
    locktime: 800_000n,
});

const MIN = 1n;

describe("validateParams", () => {
    it("accepts a well-formed parameter set", () => {
        expect(() => validateParams(base(), MIN)).not.toThrow();
    });

    it("rejects a key that is not 32 bytes", () => {
        expect(() => validateParams({ ...base(), senderKey: new Uint8Array(33) }, MIN)).toThrow(
            /32 bytes/,
        );
    });

    it("rejects non-positive dust", () => {
        expect(() => validateParams({ ...base(), dust: 0n }, MIN)).toThrow(/dust must be positive/);
    });

    it("rejects non-positive vtxoMinAmount", () => {
        expect(() => validateParams(base(), 0n)).toThrow(/vtxoMinAmount must be positive/);
    });

    it("rejects topup below vtxoMinAmount", () => {
        expect(() => validateParams({ ...base(), topup: 5n }, 10n)).toThrow(/outside/);
    });

    it("rejects topup above dust", () => {
        expect(() => validateParams({ ...base(), topup: 331n }, MIN)).toThrow(/outside/);
    });

    // Receiver == operator lets the operator satisfy recycle while paying the
    // repayment to itself, collecting both sides of the trade. No signature
    // check catches it: each role's key is legitimately its own.
    it.each([
        ["receiver equals operator", { receiverKey: key(3) }],
        ["receiver equals sender", { receiverKey: key(2) }],
        ["sender equals operator", { senderKey: key(3) }],
    ])("rejects %s", (_name, overrides) => {
        expect(() => validateParams({ ...base(), ...overrides }, MIN)).toThrow(/distinct/);
    });

    // A zero absolute locktime is always satisfied, making the recovery leaf
    // spendable the moment the covenant is funded.
    it("rejects a zero locktime", () => {
        expect(() => validateParams({ ...base(), locktime: 0n }, MIN)).toThrow(/locktime/);
    });
});

describe("refundTopup", () => {
    it("returns topup unchanged when a vtxoMinAmount remains for the sender", () => {
        expect(refundTopup({ ...base(), dust: 330n, topup: 300n }, 10n)).toBe(300n);
    });

    it("caps at dust minus vtxoMinAmount when the operator funded the whole unit", () => {
        expect(refundTopup({ ...base(), dust: 330n, topup: 330n }, 10n)).toBe(320n);
    });
});
