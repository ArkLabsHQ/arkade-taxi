import { expect } from "vitest";
import { liveScenario } from "./scenarios.js";
import { admin, lock, openLive, quoteFor, sizedSender, terminal } from "./fixtures.js";

const bitcoinSatsFare = (units: string) =>
    admin("policy", {
        assetRules: [
            {
                assetId: null,
                enabled: true,
                fares: [
                    { id: "sats", currency: { kind: "sats" }, pricing: { kind: "flat", units } },
                ],
                claim: "either",
                maxTopupSats: null,
            },
        ],
    });

liveScenario("exposure-cap-rejects-quote", async () => {
    const live = await openLive();
    try {
        // Receive quotes other scenarios leave open are exposure too, so every
        // figure here is a delta on what was already outstanding at the start,
        // and so is every cap set from one.
        const base = (await admin("status")).exposure;
        const baseSats = BigInt(base.outstandingSats);
        const first = await lock(
            live,
            await quoteFor(live, "receiverSats", await sizedSender(live), false, false, "purchase"),
        );
        const nextCoin = await sizedSender(live);
        const before = await admin("status");
        expect(BigInt(before.exposure.outstandingSats)).toBe(baseSats + 330n);
        expect(before.exposure.activeCount).toBe(base.activeCount + 1);
        await admin("policy", { maxOutstandingSats: String(baseSats + 330n) });
        await expect(
            quoteFor(live, "receiverSats", nextCoin, false, false, "purchase"),
        ).rejects.toMatchObject({
            code: "exceeds_max_outstanding",
        });
        expect((await admin("status")).exposure).toEqual(before.exposure);
        await admin("policy", { maxOutstandingSats: String(baseSats + 660n) });
        // Admitted on exposure, refused on the fare: a bitcoin transfer's
        // payment IS its sender sats, so a sats fare has nothing to come from.
        await bitcoinSatsFare("1");
        await expect(
            quoteFor(live, "receiverSats", nextCoin, false, false, "purchase"),
        ).rejects.toMatchObject({ code: "fare_unavailable" });
        expect((await admin("status")).exposure).toEqual(before.exposure);
        await bitcoinSatsFare("0");
        const second = await lock(
            live,
            await quoteFor(live, "receiverSats", nextCoin, false, false, "purchase"),
        );
        expect(BigInt((await admin("status")).exposure.outstandingSats)).toBe(baseSats + 660n);
        for (const locked of [first, second]) {
            const txid = await live.client.purchase(locked.transfer, locked.destination);
            await terminal(live, locked, "purchased", txid);
        }
        expect(BigInt((await admin("status")).exposure.outstandingSats)).toBe(baseSats);
    } finally {
        await admin("policy", { maxOutstandingSats: "10000000" });
        await live.close();
    }
});
