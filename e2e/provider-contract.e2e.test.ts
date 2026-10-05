import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { expect } from "vitest";
import { EsploraProvider, RestIndexerProvider, type CSVMultisigTapscript } from "@arkade-os/sdk";
import {
    AdvanceRepository,
    openDatabase,
    ProceedsRepository,
    ReceiveQuoteRepository,
    ReservationRepository,
    SwapFillRepository,
} from "@arkade-taxi/db";
import { loadConfig, resolveRuntimeConfig } from "../packages/app/src/config.js";
import { createOperatorRuntime } from "../packages/app/src/arkade/operatorWallet.js";
import { selectOperatorFunding } from "../packages/app/src/arkade/inventory.js";
import { unionReservedOutpoints } from "../packages/app/src/arkade/reservedOutpoints.js";
import { createProceedsCollector } from "../packages/app/src/proceeds.js";
import {
    assertVtxoSnapshotContains,
    buildArkFundingArgs,
    canonicalVtxoSnapshot,
} from "../scripts/lib/harness.mjs";
import {
    normalizeSigner,
    normalizeExpiry,
    verifyProviders,
} from "../packages/app/src/arkade/providers.js";
import { mineBlocks } from "../scripts/e2e-mine.mjs";
import { admin, poll, required } from "./fixtures.js";
import { liveScenario } from "./scenarios.js";

liveScenario("provider-contract", async () => {
    const config = await resolveRuntimeConfig(
        loadConfig({
            ...process.env,
            TAXI_OPERATOR_PRIVKEY: randomBytes(32).toString("hex"),
            TAXI_OPERATOR_MIN_RESERVE_SATS: "10000",
        }),
    );
    expect(config.networkName).toBe("regtest");
    const cli = process.env.ARKADE_REGTEST_CLI;
    const esplora = process.env.ARKADE_ESPLORA_URL;
    if (!cli || !esplora)
        throw new Error(
            "ARKADE_REGTEST_CLI and ARKADE_ESPLORA_URL must name the isolated live stack",
        );
    const root = mkdtempSync(join(tmpdir(), "taxi-provider-contract-"));
    const path = join(root, "taxi.sqlite");
    let db = openDatabase(path);
    const repositories = () => ({
        advances: new AdvanceRepository(db),
        reservations: new ReservationRepository(db),
        swapFills: new SwapFillRepository(db),
        receiveQuotes: new ReceiveQuoteRepository(db),
        jobs: new ProceedsRepository(db),
    });
    let ledger = repositories();
    const reserved = () =>
        unionReservedOutpoints(ledger.reservations, ledger.swapFills, ledger.receiveQuotes);
    const makeRuntime = () =>
        createOperatorRuntime(config, db, {
            onchainProvider: new EsploraProvider(esplora),
            reservedOutpoints: reserved,
            heldOutpoints: () => [...reserved(), ...(ledger.jobs.active()?.plan.inputs ?? [])],
        });
    let runtime = makeRuntime();
    const collector = createProceedsCollector({ config, runtime, ...ledger });
    try {
        const verified = await verifyProviders(config, runtime.providers);
        expect(verified.info?.network).toBe("regtest");
        expect(verified.providerIdentityOk).toBe(true);
        expect(verified.blockers).toEqual([]);
        const unroll: CSVMultisigTapscript.Type | undefined = verified.serverUnrollScript;
        expect(unroll?.script.length).toBeGreaterThan(0);
        const emulator = await runtime.providers.emulatorProvider.getInfo();
        expect(normalizeSigner(emulator.signerPubkey)).toBe(
            Buffer.from(config.emulatorPubkey).toString("hex"),
        );
        await runtime.refresh();
        const wallet = runtime.wallet;
        expect(wallet, JSON.stringify(runtime.safety().blockers)).toBeDefined();
        const address = await wallet!.getAddress();
        const prior = new Set(
            (await wallet!.getVtxos()).map((coin) => `${coin.txid}:${coin.vout}`),
        );
        expect(prior.size).toBe(0);
        execFileSync(
            process.execPath,
            [
                cli,
                ...buildArkFundingArgs({
                    address,
                    amount: 100_000,
                    password: process.env.ARKD_PASSWORD,
                }),
            ],
            { timeout: 120000, stdio: "pipe" },
        );
        await expect
            .poll(
                async () =>
                    (await wallet!.getVtxos()).filter(
                        (coin) =>
                            !prior.has(`${coin.txid}:${coin.vout}`) &&
                            coin.value === 100_000 &&
                            !coin.assets?.length,
                    ).length,
                { timeout: 30_000, interval: 500 },
            )
            .toBe(1);
        const received = await wallet!.getVtxos();
        expect(received).toHaveLength(1);
        const receivedSnapshot = canonicalVtxoSnapshot(received, normalizeExpiry);
        console.info(
            "provider contract expiry diagnostics",
            received.map((v) => ({
                txid: v.txid,
                vout: v.vout,
                expiresAtHeight: v.expiresAtHeight,
                expiresAt: v.expiresAt?.toISOString(),
                virtualStatus: v.virtualStatus,
            })),
        );
        await expect
            .poll(async () => (await runtime.refresh()).blockers, {
                timeout: 30000,
                interval: 1000,
            })
            .toEqual([]);
        await collector.tick();
        await expect
            .poll(
                async () => {
                    await collector.tick();
                    return ledger.jobs.active();
                },
                { timeout: 30_000, interval: 500 },
            )
            .toBeUndefined();
        const records = db.prepare<[], { id: string }>("SELECT id FROM proceeds_jobs").all();
        expect(records).toHaveLength(1);
        const job = ledger.jobs.get(records[0].id)!;
        expect(job.state).toBe("complete");
        expect(job.blocker).toBeNull();
        expect(job.plan.kind).toBe("inventory-split");
        expect(job.plan.receipts).toEqual([]);
        expect(job.plan.inputs).toEqual([{ txid: received[0].txid, vout: received[0].vout }]);
        expect(job.commitmentTxid).toMatch(/^[0-9a-f]{64}$/);
        const spent = await runtime.providers.indexerProvider.getVtxos({
            outpoints: job.plan.inputs,
        });
        expect(spent.vtxos).toHaveLength(1);
        expect(spent.vtxos[0]).toMatchObject({
            isSpent: true,
            settledBy: job.commitmentTxid,
        });
        const split = await wallet!.getSpendableVtxos({ withRecoverable: false });
        expect(split.length).toBeGreaterThan(1);
        expect(split.length).toBeLessThanOrEqual(8);
        expect(split.every((coin) => BigInt(coin.value) >= config.dust)).toBe(true);
        expect(split.every((coin) => !coin.assets?.length)).toBe(true);
        expect(split.every((coin) => coin.commitmentTxIds?.includes(job.commitmentTxid!))).toBe(
            true,
        );
        const fee = BigInt(String(job.plan.fee));
        expect(fee).toBeGreaterThanOrEqual(0n);
        expect(fee).toBeLessThanOrEqual(config.proceedsMaxFeeSats);
        const splitTotal = split.reduce((sum, coin) => sum + BigInt(coin.value), 0n);
        expect(splitTotal).toBe(100_000n - fee);
        expect(split.map((coin) => String(coin.value)).sort()).toEqual(
            (job.plan.outputs as string[]).slice().sort(),
        );
        expect(split.some((coin) => BigInt(coin.value) >= config.operatorMinReserveSats)).toBe(
            true,
        );
        const safety = await runtime.refresh();
        expect(safety.blockers).toEqual([]);
        expect(reserved()).toEqual([]);
        expect(await runtime.storage.intentRepository.getLockedVtxoOutpoints()).toEqual([]);
        const held = [...reserved()];
        for (const requiredSats of [1n, 280n, 284n]) {
            const selected = selectOperatorFunding({
                spendable: split,
                reserved: held,
                requiredSats,
                safety,
                nowMs: Date.now(),
                maxSnapshotAgeMs: config.reconcileIntervalMs,
                minExpiryHeadroomBlocks: config.minExpiryHeadroomBlocks,
                minExpiryHeadroomSeconds: config.minExpiryHeadroomSeconds,
                renewalThresholdSeconds: config.vtxoRenewalThresholdSeconds,
                minReserveSats: config.operatorMinReserveSats,
                dustSats: config.dust,
            });
            expect(
                selected.inputs.every(
                    (coin) =>
                        !held.some((input) => input.txid === coin.txid && input.vout === coin.vout),
                ),
            ).toBe(true);
            expect(selected.totalValue - requiredSats).toBeGreaterThanOrEqual(config.dust);
            const unavailable = [...held, ...selected.inputs];
            const free = split.filter(
                (coin) =>
                    !unavailable.some(
                        (input) => input.txid === coin.txid && input.vout === coin.vout,
                    ),
            );
            expect(free.reduce((sum, coin) => sum + BigInt(coin.value), 0n)).toBeGreaterThanOrEqual(
                config.operatorMinReserveSats,
            );
            held.push(...selected.inputs.map(({ txid, vout }) => ({ txid, vout })));
        }
        const observedBefore = canonicalVtxoSnapshot(await wallet!.getVtxos(), normalizeExpiry);
        expect(observedBefore.length).toBeGreaterThan(0);
        const spendableBefore = canonicalVtxoSnapshot(
            await wallet!.getSpendableVtxos({ withRecoverable: false }),
            normalizeExpiry,
        );
        expect(spendableBefore.length).toBeGreaterThan(0);
        const durableBeforeDispose = canonicalVtxoSnapshot(
            await runtime.storage.walletRepository.getVtxos(address),
            normalizeExpiry,
        );
        collector.stop();
        await collector.drain();
        await runtime.dispose();
        expect(db.open).toBe(true);
        const durableBeforeClose = canonicalVtxoSnapshot(
            await runtime.storage.walletRepository.getVtxos(address),
            normalizeExpiry,
        );
        assertVtxoSnapshotContains(durableBeforeClose, durableBeforeDispose);
        assertVtxoSnapshotContains(durableBeforeClose, receivedSnapshot);
        assertVtxoSnapshotContains(durableBeforeClose, observedBefore);
        assertVtxoSnapshotContains(durableBeforeClose, spendableBefore);
        db.close();
        db = openDatabase(path);
        ledger = repositories();
        expect(ledger.jobs.get(job.id)).toEqual(job);
        runtime = makeRuntime();
        const durableAfterReopen = canonicalVtxoSnapshot(
            await runtime.storage.walletRepository.getVtxos(address),
            normalizeExpiry,
        );
        expect(durableAfterReopen).toEqual(durableBeforeClose);
        expect((await runtime.refresh()).blockers).toEqual([]);
        expect(await runtime.wallet!.getAddress()).toBe(address);
        const spendableAfter = canonicalVtxoSnapshot(
            await runtime.wallet!.getSpendableVtxos({ withRecoverable: false }),
            normalizeExpiry,
        );
        expect(spendableAfter).toEqual(spendableBefore);
        const durableAfterRefresh = canonicalVtxoSnapshot(
            await runtime.storage.walletRepository.getVtxos(address),
            normalizeExpiry,
        );
        assertVtxoSnapshotContains(durableAfterRefresh, durableAfterReopen);
        assertVtxoSnapshotContains(durableAfterRefresh, spendableAfter);
    } finally {
        collector.stop();
        await collector.drain();
        await runtime.dispose();
        if (db.open) db.close();
        const target = resolve(root);
        if (!target.startsWith(resolve(tmpdir()) + sep))
            throw new Error("refusing cleanup outside temp");
        rmSync(target, { recursive: true });
    }
});

liveScenario("onchain-boarding-topup", async () => {
    const config = await resolveRuntimeConfig(loadConfig(process.env));
    const operatorScript = `5120${Buffer.from(config.operatorKey).toString("hex")}`;
    const indexer = new RestIndexerProvider(required("TAXI_E2E_ARKD_URL"));
    const spendable = async () =>
        (await indexer.getVtxos({ scripts: [operatorScript], spendableOnly: true })).vtxos;
    const coins = await spendable();
    const known = new Set(coins.map(({ txid, vout }) => `${txid}:${vout}`));
    const baseline = coins
        .filter((coin) => !coin.assets?.length)
        .reduce((sum, coin) => sum + BigInt(coin.value), 0n);
    // Taxi re-reads its wallet once per reconcile interval, so it can lag the last scenario's coins.
    const before = await poll(
        `usable inventory of every operator coin, ${baseline} sats`,
        () => admin("funding"),
        (funding) =>
            funding.usableSats !== null &&
            BigInt(funding.usableSats) === baseline &&
            funding.boarding.address !== null,
        30_000,
    );
    execFileSync(
        process.execPath,
        [
            required("ARKADE_REGTEST_CLI"),
            "faucet",
            before.boarding.address,
            "0.00123",
            "--env",
            required("ARKADE_REGTEST_ENV"),
        ],
        { timeout: 120000, stdio: "pipe" },
    );
    await mineBlocks(1);

    // The SDK polls every 60 s and boards in the next batch; three polls, inside testTimeout.
    await poll(
        "the SDK boards the confirmed deposit on its own",
        async () =>
            (await spendable())
                .filter(({ txid, vout }) => !known.has(`${txid}:${vout}`))
                .map((coin) => coin.value),
        (values) => values.length === 1 && values[0] === 123_000,
        180_000,
    );
    await poll(
        `boarded coin counted as usable inventory, ${baseline + 123_000n} sats`,
        () => admin("funding"),
        (funding) =>
            funding.usableSats !== null && BigInt(funding.usableSats) === baseline + 123_000n,
        60_000,
    );
});
