import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { expect } from "vitest";
import { RestEmulatorProvider, Transaction } from "@arkade-os/sdk";
import { base64, hex } from "@scure/base";
import type { Advance } from "@arkade-taxi/core";
import { buildRecoveryIntent } from "../packages/app/src/arkade/recovery.js";
import { loadConfig, resolveRuntimeConfig } from "../packages/app/src/config.js";
import { mineBlocks } from "../scripts/e2e-mine.mjs";
import { matchRecoveryEvidence, readOwnedRecoveryLogs } from "../scripts/lib/cltv-evidence.mjs";
import { liveScenario } from "./scenarios.js";
import {
    admin,
    expectReceipt,
    lock,
    openLive,
    poll,
    quoteFor,
    required,
    sizedSender,
    terminal,
    walletBalance,
} from "./fixtures.js";

liveScenario("sender-refund-before-locktime", async () => {
    const live = await openLive();
    try {
        const locked = await lock(
            live,
            await quoteFor(live, "receiverSats", await sizedSender(live)),
        );
        const health = await fetch(`${required("TAXI_E2E_BASE_URL")}/health`).then((r) => r.json());
        expect(BigInt(health.runtime.chainTime)).toBeLessThan(BigInt(locked.quote.params.locktime));
        const sender = live.actors.sender.identity;
        const signed: Transaction[] = [];
        const identity = {
            signerSession: () => sender.signerSession(),
            signMessage: sender.signMessage.bind(sender),
            compressedPublicKey: () => sender.compressedPublicKey(),
            xOnlyPublicKey: () => sender.xOnlyPublicKey(),
            sign: async (tx: Transaction, indexes?: number[]) => {
                const result = await sender.sign(tx, indexes);
                signed.push(result);
                return result;
            },
        };
        const txid = await live.client.refund(locked.transfer, identity);
        expect(signed.length).toBeGreaterThanOrEqual(2);
        for (const tx of signed)
            expect(
                tx
                    .getInput(0)
                    .tapScriptSig?.some(
                        ([meta]) => hex.encode(meta.pubKey) === locked.quote.params.senderKey,
                    ),
            ).toBe(true);
        const { tx, checkpoint } = await terminal(live, locked, "refunded", txid);
        expectReceipt(tx, 0, 1n, live.info.operatorKey);
        expectReceipt(tx, 1, 329n, locked.quote.params.senderKey);
        expect(
            checkpoint
                .getInput(0)
                .tapScriptSig?.some(
                    ([meta]) => hex.encode(meta.pubKey) === locked.quote.params.senderKey,
                ),
        ).toBe(true);
        expect((await admin("status")).exposure.outstandingSats).toBe("0");
    } finally {
        await live.close();
    }
});

async function recoveryIntent(locked: Awaited<ReturnType<typeof lock>>) {
    const row = (await admin("advances")).advances.find(
        (a: any) => a.id === locked.quote.transferId,
    );
    const advance = {
        ...row,
        ...locked.verified.params,
        fare: { currency: "sats", units: 1n },
        batchExpiry: { kind: row.batchExpiry.kind, value: BigInt(row.batchExpiry.value) },
        recoveryLocktime: {
            kind: row.recoveryLocktime.kind,
            value: BigInt(row.recoveryLocktime.value),
        },
        operatorInputs: locked.verified.envelope.operatorInputs.map(({ txid, vout }) => ({
            txid,
            vout,
        })),
        unsignedLockupTx: locked.quote.unsignedLockupTx,
        unsignedLockupId: locked.quote.lockup.unsignedTxId,
    } as Advance;
    const config = await resolveRuntimeConfig(loadConfig(process.env));
    const intent = buildRecoveryIntent(advance, config);
    return intent;
}

liveScenario("premature-recovery-rejected", async () => {
    const live = await openLive();
    try {
        const locked = await lock(
            live,
            await quoteFor(live, "receiverSats", await sizedSender(live)),
        );
        const intent = await recoveryIntent(locked);
        expect(Transaction.fromPSBT(base64.decode(intent.arkTx)).id).toBe(intent.expectedTxid);
        const tip = await live.actors.sender.wallet.onchainProvider.getChainTip();
        expect(BigInt(tip.time)).toBeLessThan(BigInt(locked.quote.params.locktime));
        const emulator = new RestEmulatorProvider(required("TAXI_E2E_EMULATOR_URL"));
        const startedAt = Date.now();
        let rejection: unknown;
        try {
            await emulator.submitTx(intent.arkTx, intent.checkpoints);
        } catch (error) {
            rejection = error;
        }
        const window = {
            project: required("TAXI_E2E_PROJECT"),
            startedAt,
            endedAt: Date.now() + 2000,
        };
        const evidence = await poll(
            "exact owned recovery CLTV rejection",
            async () =>
                matchRecoveryEvidence({
                    ...window,
                    txid: intent.expectedTxid,
                    locktime: locked.quote.params.locktime,
                    currentBlocktime: String(tip.time),
                    error: rejection,
                    logs: readOwnedRecoveryLogs(window),
                }),
            (value) => value !== undefined,
            2000,
        );
        writeFileSync("e2e-artifacts/cltv-evidence.json", `${JSON.stringify(evidence, null, 2)}\n`);
        expect((await live.client.status(locked.quote.transferId)).state).toBe("locked");
        const { vtxos } = await live.indexer.getVtxos({ outpoints: [locked.lockup.outpoint] });
        expect(vtxos[0].isSpent).toBe(false);
    } finally {
        await live.close();
    }
});

liveScenario("sweeper-recovery-after-locktime", async () => {
    const live = await openLive();
    try {
        await admin("policy", { locktimeMarginSeconds: 129600 });
        const locked = await lock(
            live,
            await quoteFor(live, "receiverSats", await sizedSender(live)),
        );
        const intent = await recoveryIntent(locked);
        const before = await walletBalance(live.actors.operator, live.fixture.asset.assetId);
        const deadline = Number(locked.quote.params.locktime);
        const states: string[] = [];
        const observed = poll(
            "recovering then recovered",
            async () => {
                const value = await live.client.status(locked.quote.transferId);
                if (states.at(-1) !== value.state) states.push(value.state);
                return value;
            },
            (value) => value.state === "recovered",
            120_000,
        );
        observed.catch(() => {});
        execFileSync(
            process.execPath,
            [required("ARKADE_REGTEST_CLI"), "rpc", "setmocktime", String(deadline + 1)],
            { stdio: "pipe", timeout: 30_000 },
        );
        await mineBlocks(11);
        await observed;
        expect(states).toContain("recovering");
        expect(states.at(-1)).toBe("recovered");
        const { tx, row } = await terminal(live, locked, "recovered", intent.expectedTxid);
        expect(row.recoveryTxid).toBe(intent.expectedTxid);
        expect(row.recoveryPhase).toBe("submitted");
        expectReceipt(tx, 0, 1n, live.info.operatorKey);
        expectReceipt(tx, 1, 329n, locked.quote.params.senderKey);
        const health = await fetch(`${required("TAXI_E2E_BASE_URL")}/health`).then((r) => r.json());
        expect(BigInt(health.runtime.chainTime)).toBeGreaterThanOrEqual(BigInt(deadline));
        expect(BigInt(health.runtime.chainTime)).toBeLessThan(BigInt(row.batchExpiry.value));
        expect((await admin("status")).exposure.outstandingSats).toBe("0");
        expect(await walletBalance(live.actors.operator, live.fixture.asset.assetId)).toEqual(
            before,
        );
    } finally {
        await live.close();
    }
});
