import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { expect } from "vitest";
import { RestEmulatorProvider, Transaction } from "@arkade-os/sdk";
import { base64, hex } from "@scure/base";
import type { Advance } from "@arkade-taxi/core";
import { loanSats, lockupSats } from "@arkade-taxi/covenant";
import { buildRecoveryIntent } from "../packages/app/src/arkade/recovery.js";
import { loadConfig, resolveRuntimeConfig } from "../packages/app/src/config.js";
import { mineBlocks } from "../scripts/e2e-mine.mjs";
import { matchRecoveryEvidence, readOwnedRecoveryLogs } from "../scripts/lib/cltv-evidence.mjs";
import { liveScenario } from "./scenarios.js";
import {
    admin,
    artifactPath,
    expectReceipt,
    health,
    lock,
    openLive,
    poll,
    quoteFor,
    required,
    sizedSender,
    terminal,
    walletBalance,
    walletInputOf,
} from "./fixtures.js";

liveScenario("sender-refund-before-locktime", async () => {
    const live = await openLive();
    try {
        const locked = await lock(
            live,
            await quoteFor(live, "receiverSats", await sizedSender(live)),
        );
        const before = await health();
        expect(BigInt(before.runtime.chainTime)).toBeLessThan(BigInt(locked.quote.params.locktime));
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
        // Leaf 2 pays out[1] to in[1]'s own script, so the sender brings one.
        const refundCoin = await sizedSender(live);
        const txid = await live.client.refund(
            locked.transfer,
            identity,
            walletInputOf(refundCoin, identity),
        );
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
        const lockup = lockupSats(locked.verified.params);
        const loan = loanSats(locked.verified.params);
        expect(tx.inputsLength).toBe(2);
        expectReceipt(tx, 0, loan, live.info.operatorKey);
        expect(tx.getOutput(1).amount).toBe(lockup + BigInt(refundCoin.value) - loan);
        expect(hex.encode(tx.getOutput(1).script!)).toBe(refundCoin.script);
        expect(hex.encode(tx.getOutput(1).script!)).not.toBe(
            `5120${locked.quote.params.senderKey}`,
        );
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
        // Read back: the graph is rebuilt from the fare the quote really charged.
        fare: { currency: row.fare.currency, units: BigInt(row.fare.units) },
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
                    emulatorSdkVersion: JSON.parse(readFileSync(artifactPath("stack.json"), "utf8"))
                        .images.emulator.version,
                    txid: intent.expectedTxid,
                    locktime: locked.quote.params.locktime,
                    currentBlocktime: String(tip.time),
                    error: rejection,
                    logs: readOwnedRecoveryLogs(window),
                }),
            (value) => value !== undefined,
            2000,
        );
        writeFileSync(artifactPath("cltv-evidence.json"), `${JSON.stringify(evidence, null, 2)}\n`);
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
        const before = await walletBalance(live.actors.operator, live.fixture.asset.assetId);
        const custodyBefore = (await health()).custody?.rows ?? 0;
        const locked = await lock(
            live,
            await quoteFor(live, "receiverSats", await sizedSender(live)),
        );
        const intent = await recoveryIntent(locked);
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
        const lockup = lockupSats(locked.verified.params);
        const owed = lockup - loanSats(locked.verified.params);
        // Payout, emulator packet, anchor: the payer is repaid through custody.
        expect(tx.outputsLength).toBe(3);
        expectReceipt(tx, 0, lockup, live.info.operatorKey);
        expect(row.batchExpiry).toBeUndefined();
        const observedHealth = await health();
        expect(BigInt(observedHealth.runtime.chainTime)).toBeGreaterThanOrEqual(BigInt(deadline));
        expect((await admin("status")).exposure.outstandingSats).toBe("0");
        const custody = await poll(
            "custody row for the payer's sats",
            async () => (await health()).custody,
            (value) => value?.rows === custodyBefore + 1,
        );
        expect(BigInt(custody.owedSats)).toBeGreaterThanOrEqual(owed);
        const expected = { ...before, sats: before.sats + owed };
        expect(
            await poll(
                "spendable recovery repayment",
                () => walletBalance(live.actors.operator, live.fixture.asset.assetId),
                (balance) => balance.sats === expected.sats && balance.units === expected.units,
            ),
        ).toEqual(expected);
    } finally {
        await live.close();
    }
});
