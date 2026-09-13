import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { execFileSync } from "node:child_process";
import { expect } from "vitest";
import { EsploraProvider, type CSVMultisigTapscript } from "@arkade-os/sdk";
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
