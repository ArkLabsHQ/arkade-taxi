import { describe, expect, it } from "vitest";
import type { Advance } from "../src/types.js";
import { renewable, renewalDue } from "../src/renewal.js";

const NOW = 1_800_000_000n;
const GUARD = 43_200n;
const key = (fill: number) => new Uint8Array(32).fill(fill);

const advance = (over: Partial<Advance> = {}): Advance => ({
    id: "adv",
    state: "locked",
    receiverKey: key(1),
    senderKey: key(2),
    operatorKey: key(3),
    operatorSignerKey: key(4),
    exitDelay: { value: 5n, type: "blocks" },
    dust: 330n,
    topup: 330n,
    locktime: NOW + GUARD + 1n,
    recoveryLocktime: { kind: "time", value: NOW + GUARD + 1n },
    operatorInputs: [{ txid: "aa".repeat(32), vout: 0 }],
    unsignedLockupTx: "unsigned",
    unsignedLockupId: "bb".repeat(32),
    covenantAddress: "tark1qexample",
    fare: { currency: "sats", units: 0n },
    createdAt: 1_000,
    updatedAt: 1_000,
    expiresAt: 2_000,
    ...over,
});

describe("renewable", () => {
    it("holds until the reclaim CLTV is one guard away, and not at it", () => {
        expect(renewable(advance(), NOW, GUARD)).toBe(true);
        const atGuard = { recoveryLocktime: { kind: "time" as const, value: NOW + GUARD } };
        expect(renewable(advance(atGuard), NOW, GUARD)).toBe(false);
    });

    it.each([
        ["a recovering covenant", { state: "recovering" as const }],
        ["a sponsored send", { kind: "sponsored" as const }],
        ["a covenant carrying a failure", { failureCode: "covenant_unrolled" }],
        ["a height CLTV", { recoveryLocktime: { kind: "height" as const, value: NOW * 2n } }],
        ["no recovery locktime", { recoveryLocktime: undefined }],
    ])("refuses %s", (_, over) => {
        expect(renewable(advance(over), NOW, GUARD)).toBe(false);
    });
});

describe("renewalDue", () => {
    const WINDOW = { beforeExpirySeconds: 259_200n, guardSeconds: GUARD };
    const TREE = 172_800n;
    // A month old unless named, so the window binds before half its life does.
    const expiring = (value: bigint, createdAt = NOW - 2_592_000n) => ({
        expiry: { kind: "time" as const, value },
        createdAt,
    });

    it("is due from the window's edge on, and not a second before", () => {
        expect(renewalDue(advance(), expiring(NOW + 259_200n), NOW, WINDOW)).toBe(true);
        expect(renewalDue(advance(), expiring(NOW + 259_201n), NOW, WINDOW)).toBe(false);
        expect(renewalDue(advance(), expiring(NOW - 1n), NOW, WINDOW)).toBe(true);
    });

    it("is never due within the recovery guard, however close the expiry", () => {
        const atGuard = { recoveryLocktime: { kind: "time" as const, value: NOW + GUARD } };
        expect(renewalDue(advance(atGuard), expiring(NOW + 1n), NOW, WINDOW)).toBe(false);
        expect(renewalDue(advance(), expiring(NOW + 1n), NOW, WINDOW)).toBe(true);
    });

    it("is never due for a height expiry or an unobserved coin", () => {
        const height = { expiry: { kind: "height" as const, value: 1n }, createdAt: NOW };
        expect(renewalDue(advance(), height, NOW, WINDOW)).toBe(false);
        expect(renewalDue(advance(), undefined, NOW, WINDOW)).toBe(false);
        expect(renewalDue(advance(), { createdAt: NOW }, NOW, WINDOW)).toBe(false);
        expect(renewalDue(advance(), { expiry: expiring(NOW + 1n).expiry }, NOW, WINDOW)).toBe(
            false,
        );
        expect(renewalDue(advance(), expiring(NOW + 1n, 0n), NOW, WINDOW)).toBe(false);
        expect(renewalDue(advance(), expiring(NOW + 1n, NOW + 100n), NOW, WINDOW)).toBe(false);
    });

    it("waits for half the coin's own life when the window is longer", () => {
        expect(renewalDue(advance(), expiring(NOW + 129_600n, NOW), NOW, WINDOW)).toBe(false);
        expect(renewalDue(advance(), expiring(NOW - 60n + TREE, NOW - 60n), NOW, WINDOW)).toBe(
            false,
        );
        const half = TREE / 2n;
        expect(renewalDue(advance(), expiring(NOW + half, NOW - half), NOW, WINDOW)).toBe(true);
        expect(renewalDue(advance(), expiring(NOW + half + 1n, NOW - half + 1n), NOW, WINDOW)).toBe(
            false,
        );
    });
});
