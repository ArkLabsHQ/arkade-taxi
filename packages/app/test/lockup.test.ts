import { describe, expect, it } from "vitest";
import { payoutPkScript } from "@arkade-taxi/covenant";
import type { FareSpec } from "@arkade-taxi/core";
import {
    assertDistinctScripts,
    buildLockupOutputs,
    lockupFundingTotal,
    LockupShapeError,
    type LockupOutput,
} from "../src/lockup.js";
import { DUST, operatorKey, receiverKey, senderKey, VTXO_MIN } from "./fixtures.js";

const ASSET = { txid: new Uint8Array(32).fill(0x11), groupIndex: 0 };
const TOKEN = { txid: new Uint8Array(32).fill(0x99), groupIndex: 0 };

const params = () => ({
    receiverKey,
    senderKey,
    operatorKey,
    dust: DUST,
    topup: DUST,
    locktime: 900_000n,
});

const covenantPkScript = new Uint8Array([0x51, 0x20, ...new Uint8Array(32).fill(0xcc)]);
const satsFare: FareSpec = { currency: "sats", units: 50n };
const tokenFare: FareSpec = { currency: "asset", assetId: TOKEN, units: 1n };

const req = (over: Partial<Parameters<typeof buildLockupOutputs>[0]> = {}) => ({
    params: params(),
    covenantPkScript,
    fare: satsFare,
    vtxoMinAmount: VTXO_MIN,
    senderChangeSats: 0n,
    ...over,
});

describe("buildLockupOutputs", () => {
    it("puts the covenant at index 0 for the full dust unit", () => {
        const [covenant] = buildLockupOutputs(req());
        expect(covenant).toMatchObject({ role: "covenant", amount: DUST });
        expect(covenant?.script).toEqual(covenantPkScript);
    });

    it("omits a zero fare rather than emitting an empty output", () => {
        const fare: FareSpec = { currency: "sats", units: 0n };
        expect(buildLockupOutputs(req({ fare })).map((o) => o.role)).toEqual(["covenant"]);
    });

    // The whole point: a sender with an asset and no spare bitcoin can still pay.
    it("pays a token fare as asset units riding on hosting sats", () => {
        const fare = buildLockupOutputs(req({ fare: tokenFare }))[1];
        expect(fare).toMatchObject({ role: "operator-fare", amount: VTXO_MIN });
        expect(fare?.asset).toEqual({ id: TOKEN, units: 1n });
    });

    // Those hosting sats are the operator paying itself, so exposure is topup only.
    it("charges the sender no sats for an asset fare", () => {
        const outputs = buildLockupOutputs(req({ fare: tokenFare }));
        expect(lockupFundingTotal(outputs)).toBe(DUST + VTXO_MIN);
    });

    it("pays a sats fare with no asset rider", () => {
        const fare = buildLockupOutputs(req())[1];
        expect(fare?.amount).toBe(50n);
        expect(fare?.asset).toBeUndefined();
        expect(fare?.script).toEqual(payoutPkScript(operatorKey, 50n, DUST));
    });

    // An asset cannot occupy an output on its own.
    it("refuses an asset fare with no sats to host it", () => {
        expect(() => buildLockupOutputs(req({ fare: tokenFare, vtxoMinAmount: 0n }))).toThrow(
            /cannot occupy an output alone/,
        );
    });

    it("refuses asset change with too little sats to host it", () => {
        expect(() =>
            buildLockupOutputs(
                req({
                    senderChangeSats: 0n,
                    senderChangeScript: new Uint8Array([0x51, 0x20, ...senderKey]),
                    senderChangeAsset: { id: ASSET, units: 5n },
                }),
            ),
        ).toThrow(/host it/);
    });

    it("rejects a negative fare", () => {
        const fare: FareSpec = { currency: "sats", units: -1n };
        expect(() => buildLockupOutputs(req({ fare }))).toThrow(/negative/);
    });
});

describe("assertDistinctScripts", () => {
    const out = (role: LockupOutput["role"], fill: number): LockupOutput => ({
        role,
        script: new Uint8Array([0x51, 0x20, ...new Uint8Array(32).fill(fill)]),
        amount: 1n,
    });

    it("accepts distinct scripts", () => {
        expect(() =>
            assertDistinctScripts([out("covenant", 1), out("operator-fare", 2)]),
        ).not.toThrow();
    });

    it("rejects a shared scriptPubKey, naming both roles", () => {
        expect(() => assertDistinctScripts([out("covenant", 1), out("sender-change", 1)])).toThrow(
            /covenant.*sender-change/,
        );
    });

    it("catches a duplicate that is not adjacent", () => {
        expect(() =>
            assertDistinctScripts([
                out("covenant", 1),
                out("operator-fare", 2),
                out("sender-change", 1),
            ]),
        ).toThrow(LockupShapeError);
    });

    // The realistic collision: the fare and the change both landing on the same
    // key's script.
    it("is enforced by buildLockupOutputs, not left to the caller", () => {
        expect(() =>
            buildLockupOutputs(
                req({
                    senderChangeSats: 100n,
                    senderChangeScript: payoutPkScript(operatorKey, 50n, DUST),
                }),
            ),
        ).toThrow(LockupShapeError);
    });
});
