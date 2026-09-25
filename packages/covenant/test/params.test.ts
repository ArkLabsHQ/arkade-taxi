import { describe, expect, it } from "vitest";
import {
    refundTopup,
    unrecoveredTopup,
    validateParams,
    type DustCovenantParams,
} from "../src/params.js";
import { receiverPaid } from "./fixtures.js";

const key = (fill: number) => new Uint8Array(32).fill(fill);
const assetId = { txid: new Uint8Array(32).fill(0x11), groupIndex: 0 };

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

    it("rejects an unknown recovery recipient", () => {
        const params = {
            ...base(),
            recoveryRecipient: "other",
        } as unknown as DustCovenantParams;
        expect(() => validateParams(params, MIN)).toThrow(/unknown recovery recipient/);
    });

    it("rejects receiver recovery without an asset", () => {
        const params = { ...base(), recoveryRecipient: "receiver" } as DustCovenantParams;
        expect(() => validateParams(params, MIN)).toThrow(/requires an asset id/);
    });

    it("rejects receiver recovery without a positive two-way split", () => {
        const params = {
            ...base(),
            dust: 10n,
            topup: 6n,
            assetId,
            recoveryRecipient: "receiver",
        } as DustCovenantParams;
        expect(() => validateParams(params, 6n)).toThrow(/needs at least 6 sats/);
    });
});

describe("receiverFare", () => {
    it("accepts a sats fare and an asset fare", () => {
        expect(() => validateParams(receiverPaid(), 1n)).not.toThrow();
        expect(() =>
            validateParams(receiverPaid({ receiverFare: { currency: "asset", units: 9n } }), 1n),
        ).not.toThrow();
    });
    it("requires the operator to fund the whole dust", () => {
        expect(() => validateParams(receiverPaid({ topup: 329n }), 1n)).toThrow(
            /fund the whole dust/,
        );
    });
    it("requires an asset id, and says so as a fare problem", () => {
        expect(() =>
            validateParams(receiverPaid({ assetId: undefined, recoveryRecipient: "sender" }), 1n),
        ).toThrow(/receiver fare requires an asset id/);
        expect(() => validateParams(receiverPaid({ assetId: undefined }), 1n)).toThrow(
            /receiver fare requires an asset id/,
        );
    });
    it("requires a recycle claim mode and receiver recovery", () => {
        expect(() => validateParams(receiverPaid({ claimMode: "purchase" }), 1n)).toThrow(
            /only defined for a recycle/,
        );
        expect(() => validateParams(receiverPaid({ recoveryRecipient: "sender" }), 1n)).toThrow(
            /receiver-owned recovery/,
        );
    });
    it("refuses negative units and units past a signed 64-bit integer", () => {
        expect(() =>
            validateParams(receiverPaid({ receiverFare: { currency: "sats", units: -1n } }), 1n),
        ).toThrow(/must not be negative/);
        expect(() =>
            validateParams(
                receiverPaid({ receiverFare: { currency: "asset", units: 2n ** 63n } }),
                1n,
            ),
        ).toThrow(/signed 64-bit/);
    });
});

describe("refundTopup", () => {
    it("returns topup unchanged when a vtxoMinAmount remains for the sender", () => {
        expect(refundTopup({ ...base(), dust: 330n, topup: 300n }, 10n)).toBe(300n);
    });

    it("caps at dust minus vtxoMinAmount when the operator funded the whole unit", () => {
        expect(refundTopup({ ...base(), dust: 330n, topup: 330n }, 10n)).toBe(320n);
    });

    it("separates unrecovered operator allocation from the receipt value", () => {
        const full = { ...base(), assetId, recoveryRecipient: "receiver" } as DustCovenantParams;
        const precharged = { ...full, topup: 329n };

        expect(unrecoveredTopup(full, 1n)).toBe(1n);
        expect(unrecoveredTopup(precharged, 1n)).toBe(0n);
        expect(precharged.dust - refundTopup(precharged, 1n)).toBe(1n);
    });
});
