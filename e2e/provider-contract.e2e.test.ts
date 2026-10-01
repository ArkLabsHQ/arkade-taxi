import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { execFileSync } from "node:child_process";
import { expect } from "vitest";
import { EsploraProvider, RestIndexerProvider, type CSVMultisigTapscript } from "@arkade-os/sdk";
import { openDatabase } from "@arkade-taxi/db";
import { loadConfig, resolveRuntimeConfig } from "../packages/app/src/config.js";
import { createOperatorRuntime } from "../packages/app/src/arkade/operatorWallet.js";
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
    const config = await resolveRuntimeConfig(loadConfig(process.env));
    const cli = process.env.ARKADE_REGTEST_CLI;
    const esplora = process.env.ARKADE_ESPLORA_URL;
    if (!cli || !esplora)
        throw new Error(
            "ARKADE_REGTEST_CLI and ARKADE_ESPLORA_URL must name the isolated live stack",
        );
    const root = mkdtempSync(join(tmpdir(), "taxi-provider-contract-"));
    const path = join(root, "taxi.sqlite");
    let db = openDatabase(path);
    let runtime = createOperatorRuntime(config, db, {
        onchainProvider: new EsploraProvider(esplora),
    });
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
        for (const amount of [50_000, 50_000])
            execFileSync(
                process.execPath,
                [
                    cli,
                    ...buildArkFundingArgs({
                        address,
                        amount,
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
                            coin.value === 50_000 &&
                            !coin.assets?.length,
                    ).length,
                { timeout: 30_000, interval: 500 },
            )
            .toBe(2);
        const received = await wallet!.getVtxos();
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
        runtime = createOperatorRuntime(config, db, {
            onchainProvider: new EsploraProvider(esplora),
        });
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
    const before = await admin("funding");
    const boarded = BigInt(before.boarding.confirmedSats) + 123_000n;
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
    const funded = await poll(
        "confirmed boarding deposit",
        () => admin("funding"),
        // usableSats is null while the runtime re-checks the wallet.
        (funding) =>
            funding.boarding.confirmedSats === boarded.toString() && funding.usableSats !== null,
        120_000,
    );
    const usable = BigInt(funded.usableSats);

    const response = await fetch(`${required("TAXI_E2E_ADMIN_URL")}/admin/api/funding/board`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-taxi-operator": "task13-e2e" },
        body: "{}",
    });
    expect({ status: response.status, body: await response.json() }).toEqual({
        status: 202,
        body: { accepted: true, action: "board" },
    });
    const { boarding } = await poll(
        "boarding job settles",
        () => admin("funding"),
        (funding) => funding.boarding.job.state !== "running",
        240_000,
    );
    expect(boarding.job).toMatchObject({
        state: "succeeded",
        actor: "task13-e2e",
        amountSats: boarded.toString(),
        authorizedFeeSats: "0",
        error: null,
    });

    const operatorScript = `5120${Buffer.from(config.operatorKey).toString("hex")}`;
    const { vtxos } = await new RestIndexerProvider(required("TAXI_E2E_ARKD_URL")).getVtxos({
        scripts: [operatorScript],
        spendableOnly: true,
    });
    expect(
        vtxos
            .filter((coin) => coin.commitmentTxIds?.includes(boarding.job.commitmentTxid))
            .map((coin) => coin.value),
    ).toEqual([Number(boarded)]);
    await poll(
        "boarded coin counted as usable inventory",
        () => admin("funding"),
        (funding) => funding.usableSats !== null && BigInt(funding.usableSats) === usable + boarded,
        120_000,
    );
    expect((await admin("policy/history?limit=50")).history).toContainEqual(
        expect.objectContaining({ field: "operation", newValue: "board", actor: "task13-e2e" }),
    );
});
