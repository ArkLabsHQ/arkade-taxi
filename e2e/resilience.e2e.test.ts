import { execFileSync } from "node:child_process";
import { expect } from "vitest";
import { signLockup } from "@arkade-taxi/client";
import { Extension, Transaction } from "@arkade-os/sdk";
import { base64 } from "@scure/base";
import { mineBlocks } from "../scripts/e2e-mine.mjs";
import { preEffectRequest } from "./admission.js";
import { liveScenario } from "./scenarios.js";
import {
    admin,
    boundary,
    control,
    fundingOf,
    health,
    lock,
    observeLock,
    openLive,
    poll,
    quoteFor,
    ready,
    required,
    sizedSender,
    terminal,
    type Live,
    type Locked,
} from "./fixtures.js";

const rowFor = async (id: string) =>
    (await admin("advances")).advances.find((row: any) => row.id === id);

const lockupTxid = (offered: Awaited<ReturnType<typeof quoteFor>>) =>
    Transaction.fromPSBT(base64.decode(offered.verified.envelope.arkTx)).id;

const emulatorSubmits = async () =>
    (await control("events")).events.filter(
        (event: any) =>
            event.target === "emulator" &&
            event.path === "/v1/tx" &&
            event.method === "POST" &&
            event.action === "forwarded",
    ).length;

async function restart() {
    const result = await control("restart");
    expect(result.id).not.toBe(result.previousId);
    expect(result.volume).toBe(`${required("TAXI_E2E_PROJECT")}-taxi-data`);
    await poll(
        "recreated Taxi liveness",
        async () => {
            try {
                return await fetch(`${required("TAXI_E2E_BASE_URL")}/health`).then((r) => r.status);
            } catch {
                return 0;
            }
        },
        (status) => status === 200,
    );
    return result;
}

async function mineTo(live: Live, time: number) {
    const before = await live.actors.sender.wallet.onchainProvider.getChainTip();
    expect(time).toBeGreaterThan(before.time);
    execFileSync(
        process.execPath,
        [required("ARKADE_REGTEST_CLI"), "rpc", "setmocktime", String(time)],
        { stdio: "pipe", timeout: 30_000 },
    );
    await mineBlocks(11);
    const tip = await poll(
        "explicit chain median-time advance",
        () => live.actors.sender.wallet.onchainProvider.getChainTip(),
        (value) => value.time >= time && value.height === before.height + 11,
    );
    expect(tip.height).toBe(before.height + 11);
    return tip;
}

async function purchase(live: Live, locked: Locked) {
    const txid = await live.client.purchase(locked.transfer, locked.destination);
    await terminal(live, locked, "purchased", txid);
}

async function submitSame(
    live: Live,
    offered: Awaited<ReturnType<typeof quoteFor>>,
    signed: string,
) {
    return preEffectRequest(() => live.client.submitLockup(offered.verified, signed), {
        readyUrl: `${required("TAXI_E2E_BASE_URL")}/ready`,
        expiresAt: offered.quote.expiresAt,
    });
}

liveScenario("restart-quoted-reservation", async () => {
    const live = await openLive();
    const offered = await quoteFor(live, "receiverSats", await sizedSender(live));
    const before = await rowFor(offered.quote.transferId);
    const status = await admin("status");
    const reservedValue = offered.verified.envelope.operatorInputs.reduce(
        (sum, input) => sum + BigInt(input.value),
        0n,
    );
    const inventory = await poll(
        "verified reserved wallet inventory",
        async () => (await ready()).body.runtime.inventory,
        (value) =>
            value.reservedSats === String(reservedValue) &&
            value.reservedVtxos === offered.verified.envelope.operatorInputs.length,
    );
    await restart();
    await ready();
    const after = await rowFor(offered.quote.transferId);
    expect(after.state).toBe("quoted");
    expect(after.expiresAt).toBe(before.expiresAt);
    expect((await admin("status")).exposure).toEqual(status.exposure);
    expect((await ready()).body.runtime.inventory).toEqual(inventory);
    const secondCoin = await sizedSender(live);
    await expect(quoteFor(live, "receiverSats", secondCoin)).rejects.toMatchObject({
        code: "operator_inventory_insufficient",
    });
    await purchase(live, await lock(live, offered));
    const second = await quoteFor(live, "receiverSats", secondCoin);
    await purchase(live, await lock(live, second));
});

liveScenario("restart-submitted-reconciliation", async () => {
    const live = await openLive();
    const offered = await quoteFor(live, "receiverSats", await sizedSender(live));
    const signed = await signLockup({
        verified: offered.verified,
        identity: live.actors.sender.identity,
    });
    await control("configure", {
        target: "indexer",
        path: "/v1/indexer/vtxos",
        mode: "pause",
        query: { outpoints: `${lockupTxid(offered)}:0` },
    });
    await submitSame(live, offered, signed);
    expect((await rowFor(offered.quote.transferId)).state).toBe("locking");
    await poll(
        "paused covenant observation",
        async () =>
            (await control("events")).events.filter(
                (event: any) => event.target === "indexer" && event.action === "paused",
            ),
        (events) => events.length > 0,
    );
    await restart();
    await control("reset");
    await ready();
    const locked = await observeLock(live, offered);
    expect(locked.lockup.outpoint.txid).toBe(lockupTxid(offered));
    await purchase(live, locked);
});

liveScenario("dropped-submit-response", async () => {
    const live = await openLive();
    const offered = await quoteFor(live, "receiverSats", await sizedSender(live));
    const signed = await signLockup({
        verified: offered.verified,
        identity: live.actors.sender.identity,
    });
    await control("configure", {
        target: "arkd",
        path: "/v1/tx/submit",
        mode: "drop",
        method: "POST",
    });
    const accepted = await submitSame(live, offered, signed);
    expect(accepted.txid).toBe(lockupTxid(offered));
    const dropped = await poll(
        "the exact upstream submit response is dropped",
        async () =>
            (await control("events")).events.filter(
                (event: any) => event.target === "arkd" && event.action === "dropped",
            ),
        (events) => events.length === 1,
    );
    expect(dropped).toHaveLength(1);
    expect(dropped[0].status).toBe(200);
    const locked = await observeLock(live, offered);
    expect(locked.lockup.outpoint.txid).toBe(lockupTxid(offered));
    const before = await admin("status");
    expect(await submitSame(live, offered, signed)).toEqual(locked.lockup);
    expect((await admin("status")).exposure).toEqual(before.exposure);
    for (const input of offered.verified.envelope.operatorInputs) {
        const { vtxos } = await live.indexer.getVtxos({
            outpoints: [{ txid: input.txid, vout: input.vout }],
        });
        expect(vtxos).toHaveLength(1);
        expect(vtxos[0].isSpent).toBe(true);
        expect(vtxos[0].arkTxId).toBe(locked.lockup.txid);
    }
    await purchase(live, locked);
});

liveScenario("duplicate-lockup-idempotent", async () => {
    const live = await openLive();
    const offered = await quoteFor(live, "receiverSats", await sizedSender(live));
    const signed = await signLockup({
        verified: offered.verified,
        identity: live.actors.sender.identity,
    });
    const first = await submitSame(live, offered, signed);
    const locked = await observeLock(live, offered, first);
    const before = await admin("status");
    const rows = (await admin("advances")).advances.length;
    const submits = (await control("events")).events.filter(
        (event: any) =>
            event.target === "arkd" &&
            event.path === "/v1/tx/submit" &&
            event.action === "forwarded",
    ).length;
    const duplicates = await Promise.all([
        submitSame(live, offered, signed),
        submitSame(live, offered, signed),
    ]);
    expect(duplicates).toEqual([first, first]);
    expect((await admin("advances")).advances.length).toBe(rows);
    expect((await admin("status")).exposure).toEqual(before.exposure);
    expect(
        (await control("events")).events.filter(
            (event: any) =>
                event.target === "arkd" &&
                event.path === "/v1/tx/submit" &&
                event.action === "forwarded",
        ),
    ).toHaveLength(submits);
    await purchase(live, locked);
});

liveScenario("stale-provider-identity", async () => {
    const live = await openLive();
    const offered = await quoteFor(live, "receiverSats", await sizedSender(live));
    const locked = await lock(live, offered);
    await control("configure", { target: "esplora", path: "/", mode: "pause", phase: "request" });
    await poll("unknown chain clock closes readiness", health, (body) =>
        body.runtime.blockers.includes("chain_tip_unavailable"),
    );
    const unavailable = await boundary("controlled-chain-time-unavailable");
    expect(unavailable.runtime.chainTime).toBeNull();
    expect(unavailable.blockers).toContain("chain_time_unavailable");
    expect(unavailable.sweeper.blockers).not.toEqual(
        expect.arrayContaining([expect.objectContaining({ code: "chain_time_unavailable" })]),
    );
    await expect(live.client.requestQuote(offered.request)).rejects.toMatchObject({
        code: "runtime_unsafe",
    });
    await control("reset");
    await ready();
    await control("configure", { target: "arkd", path: "/v1/info", mode: "identity" });
    await poll("stale provider identity closes readiness", health, (body) =>
        body.runtime.blockers.includes("server_identity_mismatch"),
    );
    const stale = await boundary("controlled-stale-identity");
    expect(stale.runtime.providerIdentityOk).toBe(false);
    expect(stale.blockers).toContain("server_identity_mismatch");
    await expect(live.client.requestQuote(offered.request)).rejects.toMatchObject({
        code: "runtime_unsafe",
    });
    expect((await rowFor(offered.quote.transferId)).state).toBe("locked");
    await control("reset");
    await ready();
    await purchase(live, locked);
});

liveScenario("restart-locked-recovery", async () => {
    const live = await openLive();
    await admin("policy", { locktimeMarginSeconds: 108000 });
    const locked = await lock(
        live,
        await quoteFor(live, "receiverSats", await sizedSender(live, true), true, true),
    );
    expect(locked.request.assetUnits).toBeUndefined();
    expect(locked.verified.envelope.assetUnits).toBe("100");
    const before = await rowFor(locked.quote.transferId);
    await restart();
    await ready();
    expect((await rowFor(locked.quote.transferId)).outpoint).toEqual(before.outpoint);
    const submits = await emulatorSubmits();
    await mineTo(live, Number(locked.quote.params.locktime) + 1);
    const recovered = await poll(
        "restart catch-up recovery",
        () => live.client.status(locked.quote.transferId),
        (value) => value.state === "recovered",
        120_000,
    );
    const { row, tx } = await terminal(live, locked, "recovered", recovered.spentTxid!);
    expect(
        Extension.fromTx(tx)
            .getAssetPacket()!
            .groups[0]!.outputs.map((output) => [output.vout, output.amount]),
    ).toEqual([[1, 100n]]);
    expect(await emulatorSubmits()).toBe(submits + 1);
    const tip = await live.actors.sender.wallet.onchainProvider.getChainTip();
    expect(BigInt(tip.time)).toBeLessThan(BigInt(row.batchExpiry.value));
});

liveScenario("near-expiry-auto-pause", async () => {
    const live = await openLive();
    const locked = await lock(live, await quoteFor(live, "receiverSats", await sizedSender(live)));
    const admissionRequest = {
        ...locked.request,
        senderInputs: [fundingOf(await sizedSender(live))],
    };
    const row = await rowFor(locked.quote.transferId);
    expect(row.batchExpiry.kind).toBe("time");
    const expiry = Number(row.batchExpiry.value);
    await control("configure", {
        target: "emulator",
        path: "/v1/tx",
        mode: "pause",
        phase: "request",
        method: "POST",
    });
    for (const [remaining, severity] of [
        [43200, "warning"],
        [7200, "critical"],
    ] as const) {
        const tip = await mineTo(live, expiry - remaining);
        const snapshot = await poll(`exact ${severity} recovery deadline`, health, (body) => {
            const item = body.sweeper.nearestDeadline.time;
            return (
                item?.advanceId === row.id &&
                item.severity === severity &&
                item.remaining === String(expiry - tip.time)
            );
        });
        expect(snapshot.sweeper.nearestDeadline.time).toMatchObject({
            advanceId: row.id,
            kind: "time",
            remaining: String(expiry - tip.time),
            severity,
        });
        const readiness = await fetch(`${required("TAXI_E2E_BASE_URL")}/ready`);
        expect(readiness.status).toBe(503);
        expect((await readiness.json()).sweeper.nearestDeadline.time).toMatchObject({
            advanceId: row.id,
            kind: "time",
            remaining: String(expiry - tip.time),
            severity,
        });
        await expect(
            live.client.requestQuote(admissionRequest).then((quote) => {
                live.owned.set(quote.transferId, {});
                return quote;
            }),
        ).rejects.toMatchObject({
            code: "runtime_unsafe",
            message: expect.stringContaining("vtxo_expiry_headroom"),
        });
        if (severity === "critical") {
            expect(snapshot.paused).toBe(true);
            expect(snapshot.blockers).toContain("recovery_deadline_critical");
        }
        await boundary(`deadline-${severity}`);
        const { vtxos } = await live.indexer.getVtxos({ outpoints: [locked.lockup.outpoint] });
        expect(vtxos[0].isSpent).toBe(false);
    }
    await control("reset");
    const recovered = await poll(
        "critical covenant recovers before expiry",
        () => live.client.status(row.id),
        (value) => value.state === "recovered",
        120_000,
    );
    await terminal(live, locked, "recovered", recovered.spentTxid!);
    const tip = await live.actors.sender.wallet.onchainProvider.getChainTip();
    expect(BigInt(tip.time)).toBeLessThan(BigInt(row.batchExpiry.value));
    expect((await admin("status")).exposure.outstandingSats).toBe("0");
});
