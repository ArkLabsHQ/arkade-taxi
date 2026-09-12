import { expect } from "vitest";
import { liveScenario } from "./scenarios.js";
import { admin, lock, openLive, quoteFor, sizedSender, terminal } from "./fixtures.js";

liveScenario("exposure-cap-rejects-quote", async () => {
    const live = await openLive();
    try {
        const first = await lock(
            live,
            await quoteFor(live, "receiverSats", await sizedSender(live)),
        );
        const nextCoin = await sizedSender(live);
        const before = await admin("status");
        expect(before.exposure.outstandingSats).toBe("1");
        expect(before.exposure.activeCount).toBe(1);
        await admin("policy", { maxOutstandingSats: "1" });
        await expect(quoteFor(live, "receiverSats", nextCoin)).rejects.toMatchObject({
            code: "exceeds_max_outstanding",
        });
        expect((await admin("status")).exposure).toEqual(before.exposure);
        await admin("policy", { maxOutstandingSats: "2" });
        const second = await lock(live, await quoteFor(live, "receiverSats", nextCoin));
        expect((await admin("status")).exposure.outstandingSats).toBe("2");
        for (const locked of [first, second]) {
            const txid = await live.client.purchase(locked.transfer, locked.destination);
            await terminal(live, locked, "purchased", txid);
        }
        expect((await admin("status")).exposure.outstandingSats).toBe("0");
    } finally {
        await admin("policy", { maxOutstandingSats: "10000000" });
        await live.close();
    }
});
