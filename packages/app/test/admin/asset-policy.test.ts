import { describe, expect, it } from "vitest";
import { admit } from "@arkade-taxi/core";
import { harness, key } from "./fixtures.js";

const rule = () => ({
    assetId: { txid: "ab".repeat(32), groupIndex: 7 },
    enabled: true,
    fares: [{ id: "sats", currency: { kind: "sats" }, pricing: { kind: "flat", units: "1" } }],
    claim: "either",
    maxTopupSats: null,
});

describe("admin asset policy wire boundary", () => {
    it("admits the exact asset after a JSON policy update and SQLite reload", async () => {
        const h = harness();
        const { status } = await h.send("/admin/api/policy", "PATCH", {
            paused: false,
            maxOutstandingSats: "10000",
            maxPerPaymentTopupSats: "1000",
            maxConcurrentAdvances: 20,
            assetRules: [rule()],
        });
        expect(status).toBe(200);
        const policy = h.policy.get();
        const request = {
            receiverKey: key(1),
            senderKey: key(2),
            senderSats: 1000n,
            assetUnits: 100n,
            assetId: { txid: key(0xab), groupIndex: 7 },
        };
        const exposure = { outstandingSats: 0n, lockedCount: 0, oldestUnsweptLocktime: null };
        expect(admit(request, policy, exposure, 330n, 1n)).toEqual({
            ok: true,
            topup: 1n,
            fare: { currency: "sats", units: 1n },
            claim: "either",
        });
        expect(
            admit(
                { ...request, assetId: { ...request.assetId, groupIndex: 8 } },
                policy,
                exposure,
                330n,
                1n,
            ),
        ).toEqual({ ok: false, reason: "asset_not_served" });
    });

    it.each([
        ["short txid", { assetId: { txid: "ab", groupIndex: 7 } }],
        ["uppercase txid", { assetId: { txid: "AB".repeat(32), groupIndex: 7 } }],
        ["nonhex txid", { assetId: { txid: "zz".repeat(32), groupIndex: 7 } }],
        ["array txid", { assetId: { txid: Array(32).fill(1), groupIndex: 7 } }],
        ["fractional group", { assetId: { txid: "ab".repeat(32), groupIndex: 0.5 } }],
        ["negative group", { assetId: { txid: "ab".repeat(32), groupIndex: -1 } }],
        ["overflow group", { assetId: { txid: "ab".repeat(32), groupIndex: 65536 } }],
        ["string group", { assetId: { txid: "ab".repeat(32), groupIndex: "7" } }],
        ["invalid enabled", { enabled: "true" }],
        ["invalid claim", { claim: "anything" }],
        ["numeric cap", { maxTopupSats: 1 }],
        ["negative cap", { maxTopupSats: "-1" }],
        ["ledger overflow cap", { maxTopupSats: "9223372036854775808" }],
        ["unknown field", { extra: true }],
    ])("rejects %s without changing policy or audit", async (_label, patch) => {
        const h = harness();
        const before = h.policy.getSnapshot();
        const response = await h.send("/admin/api/policy", "PATCH", {
            assetRules: [{ ...rule(), ...patch }],
        });
        expect(response.status).toBe(400);
        expect(h.policy.getSnapshot()).toEqual(before);
        expect(h.policy.history(10)).toEqual([]);
    });

    it.each([1, -1, "", " ", "-1", "1.5", "1e3", "0x10", "01", null])(
        "rejects malformed fare units %j without persisting",
        async (units) => {
            const h = harness();
            const value = rule();
            const before = h.policy.getSnapshot();
            const response = await h.send("/admin/api/policy", "PATCH", {
                assetRules: [
                    { ...value, fares: [{ ...value.fares[0], pricing: { kind: "flat", units } }] },
                ],
            });
            expect(response.status).toBe(400);
            expect(h.policy.getSnapshot()).toEqual(before);
            expect(h.policy.history(10)).toEqual([]);
        },
    );

    it.each([
        {
            id: "token",
            currency: { kind: "token", assetId: { txid: "cd".repeat(32), groupIndex: 65535 } },
            pricing: { kind: "flat", units: "9007199254740993" },
        },
        {
            id: "rate",
            currency: { kind: "sameAsset" },
            pricing: {
                kind: "proportional",
                bps: 123,
                minUnits: "2",
                maxUnits: "9007199254740993",
            },
        },
    ])("decodes nested %s fare fields without precision loss", async (fare) => {
        const h = harness();
        const response = await h.send("/admin/api/policy", "PATCH", {
            assetRules: [{ ...rule(), fares: [fare] }],
        });
        expect(response.status).toBe(200);
        const stored = h.policy.get().assetRules[0].fares[0];
        if (stored.currency.kind === "token")
            expect(stored.currency.assetId).toEqual({ txid: key(0xcd), groupIndex: 65535 });
        if (stored.pricing.kind === "flat") expect(stored.pricing.units).toBe(9007199254740993n);
        else
            expect(stored.pricing).toEqual({
                kind: "proportional",
                bps: 123,
                minUnits: 2n,
                maxUnits: 9007199254740993n,
            });
    });

    it.each([
        { id: "", currency: { kind: "sats" }, pricing: { kind: "flat", units: "1" } },
        { id: "x", currency: { kind: "rogue" }, pricing: { kind: "flat", units: "1" } },
        {
            id: "x",
            currency: { kind: "token", assetId: null },
            pricing: { kind: "flat", units: "1" },
        },
        {
            id: "x",
            currency: { kind: "sats" },
            pricing: { kind: "rogue", minUnits: "0", maxUnits: null, bps: 0 },
        },
        {
            id: "x",
            currency: { kind: "sats" },
            pricing: { kind: "proportional", minUnits: "0", maxUnits: null, bps: 0.5 },
        },
        {
            id: "x",
            currency: { kind: "sats" },
            pricing: { kind: "proportional", minUnits: "0", maxUnits: null, bps: 10001 },
        },
        {
            id: "x",
            currency: { kind: "sats" },
            pricing: { kind: "proportional", minUnits: "2", maxUnits: "1", bps: 1 },
        },
        {
            id: "x",
            currency: { kind: "token", assetId: { txid: "ab".repeat(32), groupIndex: 0 } },
            pricing: { kind: "proportional", minUnits: "0", maxUnits: null, bps: 1 },
        },
    ])("rejects malformed fare %j before persistence", async (fare) => {
        const h = harness();
        const before = h.policy.getSnapshot();
        const response = await h.send("/admin/api/policy", "PATCH", {
            assetRules: [{ ...rule(), fares: [fare] }],
        });
        expect(response.status).toBe(400);
        expect(h.policy.getSnapshot()).toEqual(before);
        expect(h.policy.history(10)).toEqual([]);
    });
});
