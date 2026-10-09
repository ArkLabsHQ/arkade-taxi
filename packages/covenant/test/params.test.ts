import { describe, expect, it } from "vitest";
import {
    exitDelayEncodable,
    exitTimelock,
    loanSats,
    lockupSats,
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
    operatorSignerKey: key(6),
    exitDelay: { value: 86_016n, type: "seconds" },
    dust: 330n,
    topup: 330n,
    locktime: 1_800_000_000n,
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

    it("lends exactly one dust unit", () => {
        expect(() => validateParams({ ...base(), topup: 329n }, MIN)).toThrow(/one dust unit/);
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

    it("refuses a sender key equal to the operator signer key", () => {
        expect(() =>
            validateParams({ ...base(), senderKey: base().operatorSignerKey }, 10n),
        ).toThrow(/sender and operator signer keys must be distinct/);
    });

    it("refuses a receiver key equal to the operator signer key", () => {
        expect(() =>
            validateParams({ ...base(), receiverKey: base().operatorSignerKey }, 10n),
        ).toThrow(/receiver and operator signer keys must be distinct/);
    });

    it("refuses exit params the covenant cannot encode", () => {
        expect(() =>
            validateParams({ ...base(), operatorSignerKey: key(1).slice(1) }, 10n),
        ).toThrow(/operator signer key must be 32 bytes/);
        expect(() =>
            validateParams({ ...base(), exitDelay: { value: 86_400n, type: "seconds" } }, 10n),
        ).toThrow(/exit delay/);
        expect(() =>
            validateParams({ ...base(), exitDelay: { value: 5n, type: "seconds" } }, 10n),
        ).toThrow(/exit delay/);
    });

    // A zero absolute locktime is always satisfied, making the recovery leaf
    // spendable the moment the covenant is funded.
    it("rejects a zero locktime", () => {
        expect(() => validateParams({ ...base(), locktime: 0n }, MIN)).toThrow(/locktime/);
    });

    it("requires a time-domain locktime", () => {
        expect(() => validateParams({ ...base(), locktime: 499_999_999n }, MIN)).toThrow(
            /must be time-domain/,
        );
        expect(() => validateParams({ ...base(), locktime: 500_000_000n }, MIN)).not.toThrow();
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

    it("accepts receiver-owned recovery at dust = vtxoMinAmount", () => {
        expect(() => validateParams(receiverPaid(), 330n)).not.toThrow();
    });
});

describe("receiverFare", () => {
    it("accepts a sats fare and an asset fare", () => {
        expect(() => validateParams(receiverPaid(), 1n)).not.toThrow();
        expect(() =>
            validateParams(receiverPaid({ receiverFare: { currency: "asset", units: 9n } }), 1n),
        ).not.toThrow();
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

describe("lockupSats", () => {
    it("locks exactly dust without a payment", () => {
        expect(lockupSats({ ...base(), topup: 230n })).toBe(330n);
    });

    it("locks the payment beside a whole-dust advance", () => {
        expect(lockupSats({ ...base(), paymentSats: 100n })).toBe(430n);
    });
});

describe("paymentSats", () => {
    it("accepts a sub-dust payment beside a whole-dust advance", () => {
        expect(() => validateParams({ ...base(), paymentSats: 100n }, MIN)).not.toThrow();
    });

    it("accepts a one-sat payment at dust = vtxoMinAmount", () => {
        expect(() => validateParams({ ...base(), paymentSats: 1n }, 330n)).not.toThrow();
    });

    it.each([
        ["a zero payment", { paymentSats: 0n }, /paymentSats/],
        ["an asset covenant", { paymentSats: 100n, assetId }, /paymentSats/],
        ["a partial advance", { paymentSats: 100n, topup: 230n }, /one dust unit/],
    ] as const)("rejects %s", (_name, over, message) => {
        expect(() => validateParams({ ...base(), ...over } as DustCovenantParams, MIN)).toThrow(
            message,
        );
    });

    it("refunds the whole advance to the operator", () => {
        expect(loanSats({ ...base(), paymentSats: 100n })).toBe(330n);
    });
});

describe("exitTimelock", () => {
    it("types the delay the way DefaultVtxo does, at the 512 boundary", () => {
        expect(exitTimelock(511n)).toEqual({ value: 511n, type: "blocks" });
        expect(exitTimelock(512n)).toEqual({ value: 512n, type: "seconds" });
        expect(exitTimelock(86_016n)).toEqual({ value: 86_016n, type: "seconds" });
    });

    // arkd rounds seconds DOWN to a multiple of 512 before advertising
    // (arklib.ParseRelativeLocktime), so a live value is encodable; 0 is not.
    it("refuses what BIP68 cannot encode", () => {
        expect(exitDelayEncodable(0n)).toBe(false);
        expect(exitDelayEncodable(86_400n)).toBe(false);
        expect(exitDelayEncodable(86_016n)).toBe(true);
        expect(exitDelayEncodable(5n)).toBe(true);
        expect(exitDelayEncodable(33_554_432n)).toBe(false);
    });
});
