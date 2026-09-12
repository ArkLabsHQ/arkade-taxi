#!/usr/bin/env node
import { spawn } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
    acquireNewAssetFreePreconfirmed,
    ensureFreshAssetFreeFunding,
    ensureMintedAsset,
    pollUntil,
} from "./lib/harness.mjs";
import {
    createActorWallets,
    disposeActorWallets,
    loadActorSecrets,
    publicWalletFixture,
} from "./e2e-wallets.mjs";
import { settleSelectedFunding, settleWallet } from "./e2e-settle.mjs";

const required = (name) =>
    process.env[name] ||
    (() => {
        throw new Error(`${name} is required`);
    })();
const toBigInt = (value) => BigInt(value ?? 0);

const run = (command, args, options = {}) =>
    new Promise((done) => {
        const child = spawn(command, args, {
            env: options.env ?? process.env,
            stdio: ["ignore", "pipe", "pipe"],
        });
        let stdout = "";
        let stderr = "";
        child.stdout.on("data", (chunk) => (stdout += chunk));
        child.stderr.on("data", (chunk) => (stderr += chunk));
        child.on("error", (error) => done({ code: 1, stdout, stderr: error.message }));
        child.on("close", (code) => done({ code: code ?? 1, stdout, stderr }));
    });

const assetUnits = (balance, assetId) =>
    toBigInt((balance.assets ?? []).find((item) => item.assetId === assetId)?.amount);

export async function bootstrapActors(config = process.env) {
    const project = config.TAXI_E2E_PROJECT;
    const base = config.TAXI_E2E_COMPOSE_BASE;
    const ark = config.TAXI_E2E_COMPOSE_ARK;
    const envFile = config.ARKADE_REGTEST_ENV;
    const secretFile = config.TAXI_E2E_SECRET_FILE;
    const fixtureFile = config.TAXI_E2E_FIXTURE_FILE;
    const arkdUrl = config.TAXI_E2E_ARKD_URL;
    const esploraUrl = config.TAXI_E2E_ESPLORA_URL;
    const password = config.ARKD_PASSWORD;
    const minHeadroomBlocks = config.TAXI_MIN_EXPIRY_HEADROOM_BLOCKS;
    const minHeadroomSeconds = config.TAXI_MIN_EXPIRY_HEADROOM_SECONDS;
    for (const [name, value] of Object.entries({
        TAXI_E2E_PROJECT: project,
        TAXI_E2E_COMPOSE_BASE: base,
        TAXI_E2E_COMPOSE_ARK: ark,
        ARKADE_REGTEST_ENV: envFile,
        TAXI_E2E_SECRET_FILE: secretFile,
        TAXI_E2E_FIXTURE_FILE: fixtureFile,
        TAXI_E2E_ARKD_URL: arkdUrl,
        TAXI_E2E_ESPLORA_URL: esploraUrl,
        ARKD_PASSWORD: password,
        TAXI_MIN_EXPIRY_HEADROOM_BLOCKS: minHeadroomBlocks,
        TAXI_MIN_EXPIRY_HEADROOM_SECONDS: minHeadroomSeconds,
    }))
        if (!value) throw new Error(`${name} is required`);

    const records = loadActorSecrets(secretFile);
    const actors = await createActorWallets(records, { arkdUrl, esploraUrl });
    const compose = [
        "compose",
        "-p",
        project,
        "-f",
        base,
        "-f",
        ark,
        "--env-file",
        envFile,
        "--profile",
        "base",
        "--profile",
        "ark",
        "--profile",
        "emulator",
        "exec",
        "-T",
        "arkd",
    ];
    const sendSats = async (actor, amount) => {
        const address = await actor.wallet.getAddress();
        const result = await run(
            "docker",
            [
                ...compose,
                "ark",
                "send",
                "--to",
                address,
                "--amount",
                String(amount),
                "--password",
                password,
            ],
            { env: config },
        );
        if (result.code !== 0)
            throw new Error(`actor funding failed: ${result.stderr || result.stdout}`);
    };
    const fund = async (actor, minimum) => {
        const current = toBigInt((await actor.wallet.getBalance()).available);
        if (current >= minimum) return;
        const address = await actor.wallet.getAddress();
        await sendSats(actor, minimum - current);
        await pollUntil({
            label: `${address} spendable funding`,
            timeoutMs: 60_000,
            intervalMs: 500,
            read: () => actor.wallet.getBalance(),
            ready: (balance) => toBigInt(balance.available) >= minimum,
        });
    };
    const renewFunding = async (actor, name, inputAmount, outputAmount) => {
        const input = await acquireNewAssetFreePreconfirmed({
            amount: inputAmount,
            list: (filter) => actor.wallet.getSpendableVtxos(filter),
            send: () => sendSats(actor, inputAmount),
        });
        await settleSelectedFunding(actor.wallet, {
            input,
            outputAmount,
            label: `${name}-final-renewal`,
        });
    };

    try {
        await fund(actors.sender, 500_000n);
        await fund(actors.receiverSats, 100_000n);
        await fund(actors.receiverWithAsset, 100_000n);
        for (const name of ["sender", "receiverSats", "receiverWithAsset"])
            await settleWallet(actors[name].wallet, name);

        const assetFile = `${secretFile}.asset`;
        const record = existsSync(assetFile)
            ? JSON.parse(readFileSync(assetFile, "utf8"))
            : undefined;
        const minted = await ensureMintedAsset({
            record,
            required: 10_000n,
            balance: async (assetId) => {
                const balances = await Promise.all(
                    Object.values(actors).map(({ wallet }) => wallet.getBalance()),
                );
                return balances.reduce((sum, balance) => sum + assetUnits(balance, assetId), 0n);
            },
            issue: async (amount) =>
                actors.sender.wallet.assetManager.issue({
                    amount,
                    metadata: { decimals: 0, name: "Taxi Test Asset", ticker: "TAXI" },
                }),
        });
        if (!record)
            writeFileSync(assetFile, `${JSON.stringify({ assetId: minted.assetId })}\n`, {
                mode: 0o600,
            });
        await pollUntil({
            label: `indexed minted asset ${minted.assetId}`,
            timeoutMs: 60_000,
            intervalMs: 500,
            read: () => actors.sender.wallet.getBalance(),
            ready: (balance) => assetUnits(balance, minted.assetId) > 0n,
        });
        const receiverBalance = await actors.receiverWithAsset.wallet.getBalance();
        if (assetUnits(receiverBalance, minted.assetId) < 1_000n) {
            await actors.sender.wallet.send({
                address: await actors.receiverWithAsset.wallet.getAddress(),
                amount: 10_000,
                assets: [{ assetId: minted.assetId, amount: 1_000n }],
            });
            await pollUntil({
                label: "receiver asset allocation",
                timeoutMs: 60_000,
                intervalMs: 500,
                read: () => actors.receiverWithAsset.wallet.getBalance(),
                ready: (balance) => assetUnits(balance, minted.assetId) >= 1_000n,
            });
            await settleWallet(actors.receiverWithAsset.wallet, "receiverWithAsset");
        }

        const senderFundingResult = await ensureFreshAssetFreeFunding({
            minimum: 100_000n,
            minHeadroomBlocks: BigInt(minHeadroomBlocks),
            minHeadroomSeconds: BigInt(minHeadroomSeconds),
            requiredDomain: "time",
            list: (filter) => actors.sender.wallet.getSpendableVtxos(filter),
            tip: () => actors.sender.wallet.onchainProvider.getChainTip(),
            renew: (amount) => renewFunding(actors.sender, "sender", amount, 100_000n),
        });
        const operatorFundingResult = await ensureFreshAssetFreeFunding({
            minimum: 500_000n,
            minHeadroomBlocks: BigInt(minHeadroomBlocks),
            minHeadroomSeconds: BigInt(minHeadroomSeconds),
            requiredDomain: "time",
            list: (filter) => actors.operator.wallet.getSpendableVtxos(filter),
            tip: () => actors.operator.wallet.onchainProvider.getChainTip(),
            renew: (amount) => renewFunding(actors.operator, "operator", amount, 500_000n),
        });

        const fixtures = {};
        for (const [name, actor] of Object.entries(actors))
            fixtures[name] = await publicWalletFixture(actor);
        const senderFunding = fixtures.sender.vtxos.find(
            (coin) =>
                coin.txid === senderFundingResult.coin.txid &&
                coin.vout === senderFundingResult.coin.vout,
        );
        if (!senderFunding) throw new Error("sender has no asset-free funding VTXO");
        if (senderFunding.expiry.kind !== "time")
            throw new Error("sender funding VTXO is not time-domain");
        const operatorFunding = fixtures.operator.vtxos.find(
            (coin) =>
                coin.txid === operatorFundingResult.coin.txid &&
                coin.vout === operatorFundingResult.coin.vout,
        );
        if (!operatorFunding) throw new Error("operator has no fresh asset-free funding VTXO");
        if (operatorFunding.expiry.kind !== "time")
            throw new Error("operator funding VTXO is not time-domain");
        fixtures.asset = { assetId: minted.assetId, supply: "10000", receiverUnits: "1000" };
        fixtures.senderFunding = senderFunding;
        fixtures.senderFundingTip = {
            height: String(senderFundingResult.tip.height),
            time: String(senderFundingResult.tip.time),
            minHeadroomBlocks,
            minHeadroomSeconds,
            headroomSeconds: String(
                BigInt(senderFunding.expiry.value) - BigInt(senderFundingResult.tip.time),
            ),
            reused: senderFundingResult.reused,
        };
        fixtures.operatorFunding = operatorFunding;
        fixtures.operatorFundingTip = {
            height: String(operatorFundingResult.tip.height),
            time: String(operatorFundingResult.tip.time),
            minHeadroomBlocks,
            minHeadroomSeconds,
            headroomSeconds: String(
                BigInt(operatorFunding.expiry.value) - BigInt(operatorFundingResult.tip.time),
            ),
            reused: operatorFundingResult.reused,
        };
        writeFileSync(fixtureFile, `${JSON.stringify(fixtures, null, 2)}\n`);
        return fixtures;
    } finally {
        await disposeActorWallets(actors);
    }
}

const mainPath = process.argv[1] ? resolve(process.argv[1]) : "";
if (mainPath && fileURLToPath(import.meta.url) === mainPath) {
    bootstrapActors()
        .then((fixtures) =>
            process.stdout.write(
                `${JSON.stringify({ actors: Object.keys(fixtures).filter((key) => fixtures[key]?.address), assetId: fixtures.asset.assetId })}\n`,
            ),
        )
        .catch((error) => {
            process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
            process.exitCode = 1;
        });
}
