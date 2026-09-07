import { describe, expect, it } from "vitest";
import { payoutPkScript } from "@arkade-taxi/covenant";
import {
    assertDistinctScripts,
    buildLockupOutputs,
    lockupFundingTotal,
    LockupShapeError,
    type LockupOutput,
} from "../src/lockup.js";
import { DUST, operatorKey, receiverKey, senderKey } from "./fixtures.js";

const baseParams = () => ({
    receiverKey,
    senderKey,
    operatorKey,
    dust: DUST,
    topup: DUST,
    locktime: 900_000n,
});

const covenantPkScript = new Uint8Array([0x51, 0x20, ...new Uint8Array(32).fill(0xcc)]);

const req = (over: Partial<Parameters<typeof buildLockupOutputs>[0]> = {}) => ({
    params: baseParams(),
    covenantPkScript,
    feeSats: 50n,
    senderChangeSats: 0n,
    ...over,
});

describe("buildLockupOutputs", () => {
    it("puts the covenant at index 0 for the full dust unit", () => {
        const [covenant] = buildLockupOutputs(req());
        expect(covenant).toMatchObject({ role: "covenant", amount: baseParams().dust });
        expect(covenant?.script).toEqual(covenantPkScript);
    });

    it("omits a zero fee rather than emitting a zero-value output", () => {
        expect(buildLockupOutputs(req({ feeSats: 0n })).map((o) => o.role)).toEqual(["covenant"]);
    });

    // Same rule the covenant pins its own payouts with, so a fee below dust
    // stays spendable instead of becoming an OP_RETURN the operator cannot claim.
    it("pays a below-dust fee to the operator's sub-dust script", () => {
        const fee = buildLockupOutputs(req({ feeSats: 50n }))[1];
        expect(fee?.script).toEqual(payoutPkScript(operatorKey, 50n, baseParams().dust));
    });

    it("pays an at-or-above-dust fee to P2TR", () => {
        const fee = buildLockupOutputs(req({ feeSats: 400n }))[1];
        expect(fee?.script).toEqual(payoutPkScript(operatorKey, 400n, baseParams().dust));
    });

    it("requires a script when there is change to return", () => {
        expect(() => buildLockupOutputs(req({ senderChangeSats: 100n }))).toThrow(LockupShapeError);
    });

    it("rejects negative amounts", () => {
        expect(() => buildLockupOutputs(req({ feeSats: -1n }))).toThrow(/negative/);
    });

    it("totals every output, which is what the lockup must be funded with", () => {
        const outputs = buildLockupOutputs(
            req({
                senderChangeSats: 100n,
                senderChangeScript: new Uint8Array([0x51, 0x20, ...receiverKey]),
            }),
        );
        expect(lockupFundingTotal(outputs)).toBe(baseParams().dust + 50n + 100n);
    });
});

/**
 * Sighash commits to the prevout amount and the wallet resolves inputs by
 * script, taking the first match, so a duplicate script signs for the wrong
 * amount and surfaces as an invalid checkpoint signature.
 */
describe("assertDistinctScripts", () => {
    const out = (role: LockupOutput["role"], fill: number): LockupOutput => ({
        role,
        script: new Uint8Array([0x51, 0x20, ...new Uint8Array(32).fill(fill)]),
        amount: 1n,
    });

    it("accepts distinct scripts", () => {
        expect(() =>
            assertDistinctScripts([out("covenant", 1), out("operator-fee", 2)]),
        ).not.toThrow();
    });

    it("rejects two outputs sharing a scriptPubKey, naming both roles", () => {
        expect(() => assertDistinctScripts([out("covenant", 1), out("sender-change", 1)])).toThrow(
            /covenant.*sender-change/,
        );
    });

    it("catches a duplicate that is not adjacent", () => {
        expect(() =>
            assertDistinctScripts([
                out("covenant", 1),
                out("operator-fee", 2),
                out("sender-change", 1),
            ]),
        ).toThrow(LockupShapeError);
    });

    // The operator's fee and the sender's change both being sub-dust to the
    // same key is the realistic way this happens, not a contrived collision.
    it("is enforced by buildLockupOutputs, not left to the caller", () => {
        expect(() =>
            buildLockupOutputs(
                req({
                    senderChangeSats: 100n,
                    senderChangeScript: payoutPkScript(operatorKey, 50n, baseParams().dust),
                }),
            ),
        ).toThrow(LockupShapeError);
    });
});
