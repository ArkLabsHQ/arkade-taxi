import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { expect } from "vitest";
import {
    ArkAddress,
    Batch,
    EmulatorPacket,
    EsploraProvider,
    Extension,
    Intent,
    RestArkProvider,
    RestEmulatorProvider,
    RestIndexerProvider,
    SingleKey,
    Transaction,
    arkade,
    isVtxoSpent,
    networks,
    withPrevTxs,
    type ExtendedVirtualCoin,
    type Identity,
    type SignerSession,
    type VirtualCoin,
    type Wallet,
} from "@arkade-os/sdk";
import { base64, hex } from "@scure/base";
import {
    AdvanceRepository,
    DEFAULT_POLICY,
    PolicyRepository,
    ReceiveQuoteRepository,
    ReservationRepository,
    SwapFillRepository,
    openDatabase,
} from "@arkade-taxi/db";
import {
    DustCovenantScript,
    Leaf,
    lockupSats,
    type DustCovenantParams,
} from "@arkade-taxi/covenant";
import type { Advance } from "@arkade-taxi/core";
import {
    loadConfig,
    resolveRuntimeConfig,
    type RuntimeConfig,
} from "../packages/app/src/config.js";
import { createOperatorRuntime } from "../packages/app/src/arkade/operatorWallet.js";
import { ProductionLockupBuilder } from "../packages/app/src/arkade/lockupBuilder.js";
import { decodeLockupEnvelope, encodeLockupEnvelope } from "../packages/app/src/arkade/psbt.js";
import type { LockupBuildRequest } from "../packages/app/src/quotes.js";
import { productionLockupSubmitter } from "../packages/app/src/arkade/submit.js";
import { normalizeExpiry } from "../packages/app/src/arkade/providers.js";
import { unionReservedOutpoints } from "../packages/app/src/arkade/reservedOutpoints.js";
import { createSpendWatcher } from "../packages/app/src/watcher.js";
import { buildArkFundingArgs } from "../scripts/lib/harness.mjs";
import { createActorWallets, disposeActorWallets } from "../scripts/e2e-wallets.mjs";
import { ownCleanup } from "../scripts/lib/scenario-cleanup.mjs";
import { artifactPath, fundingOf, poll, required } from "./fixtures.js";
import { liveScenario } from "./scenarios.js";

type Actor = { identity: SingleKey; wallet: Wallet };

const OPERATOR_FUNDING_SATS = 100_000;
const SENDER_FUNDING_SATS = 1_000;

/** Every fact R2 asks for about the coin a renewal batch consumed. */
const coinReport = (coin: VirtualCoin | undefined) =>
    coin === undefined
        ? null
        : {
              txid: coin.txid,
              vout: coin.vout,
              value: coin.value,
              isSpent: coin.isSpent ?? null,
              spentBy: coin.spentBy ?? null,
              settledBy: coin.settledBy ?? null,
              arkTxId: coin.arkTxId ?? null,
              isSwept: coin.isSwept ?? null,
              isPreconfirmed: coin.isPreconfirmed ?? null,
              isUnrolled: coin.isUnrolled ?? null,
          };

/**
 * The renew leaf is `[server, emulator:renew]`, so no caller holds a key on it
 * and `SingleKey.sign` throws rather than returning an untouched PSBT. The
 * forfeit's signatures are both injected downstream — by the emulator at
 * `submitFinalization` and by arkd on receipt.
 */
const injectedSignaturesOnly = (session: SignerSession): Identity => ({
    sign: async (tx: Transaction) => tx,
    signerSession: () => session,
    signMessage: async () => new Uint8Array(),
    compressedPublicKey: async () => new Uint8Array(33),
    xOnlyPublicKey: async () => new Uint8Array(32),
});

const senderSignedEnvelope = async (
    encoded: string,
    identity: Identity,
    senderInputCount: number,
): Promise<string> => {
    const envelope = decodeLockupEnvelope(encoded);
    // lockupPlan orders the joint inputs sender-first, so the sender owns
    // exactly the leading indexes and the checkpoints that mirror them.
    const indexes = Array.from({ length: senderInputCount }, (_, index) => index);
    const ark = await identity.sign(Transaction.fromPSBT(base64.decode(envelope.arkTx)), indexes);
    const checkpoints: string[] = [];
    for (const [index, encodedCheckpoint] of envelope.checkpoints.entries()) {
        const checkpoint = Transaction.fromPSBT(base64.decode(encodedCheckpoint));
        checkpoints.push(
            base64.encode(
                (indexes.includes(index)
                    ? await identity.sign(checkpoint, [0])
                    : checkpoint
                ).toPSBT(),
            ),
        );
    }
    return encodeLockupEnvelope({
        ...envelope,
        arkTx: base64.encode(ark.toPSBT()),
        checkpoints,
    });
};

const spendableCoin = async (
    wallet: Wallet,
    label: string,
    match: (coin: ExtendedVirtualCoin) => boolean,
) =>
    poll(
        label,
        async () =>
            (await wallet.getSpendableVtxos({ withRecoverable: false })).filter(
                (coin) => !coin.assets?.length && match(coin),
            ),
        (coins) => coins.length === 1,
    ).then((coins) => coins[0] as ExtendedVirtualCoin);

liveScenario("v2-covenant-batch-renewal", async () => {
    const arkdUrl = required("TAXI_E2E_ARKD_URL");
    const emulatorUrl = required("TAXI_E2E_EMULATOR_URL");
    const esploraUrl = required("ARKADE_ESPLORA_URL");
    const cli = required("ARKADE_REGTEST_CLI");
    const resolved = await resolveRuntimeConfig(
        loadConfig({ ...process.env, TAXI_OPERATOR_PRIVKEY: randomBytes(32).toString("hex") }),
    );
    // `loadConfig` refuses TAXI_COVENANT_VERSION=2 and lifting that is Phase 6,
    // so the version is set on the resolved object: the production gate is
    // untouched and this Taxi exists only inside the scenario.
    const config: RuntimeConfig = { ...resolved, covenantVersion: 2 };

    const root = mkdtempSync(join(tmpdir(), "taxi-v2-renewal-"));
    const db = openDatabase(join(root, "taxi.sqlite"));
    const advances = new AdvanceRepository(db, {
        custodyWindowSeconds: Number(config.custodyWindowSeconds),
    });
    const policy = new PolicyRepository(db);
    const reservations = new ReservationRepository(db);
    const swapFills = new SwapFillRepository(db);
    const receiveQuotes = new ReceiveQuoteRepository(db);
    const runtime = createOperatorRuntime(config, db, {
        onchainProvider: new EsploraProvider(esploraUrl),
        reservedOutpoints: () => unionReservedOutpoints(reservations, swapFills, receiveQuotes),
        heldOutpoints: () => [],
    });
    const actors = (await createActorWallets(
        JSON.parse(readFileSync(required("TAXI_E2E_SECRET_FILE"), "utf8")),
        { arkdUrl, esploraUrl },
    )) as Record<string, Actor>;
    const abort = new AbortController();
    ownCleanup(async () => {
        abort.abort();
        try {
            await disposeActorWallets(actors);
        } finally {
            await runtime.dispose();
            if (db.open) db.close();
            const target = resolve(root);
            if (!target.startsWith(resolve(tmpdir()) + sep))
                throw new Error("refusing cleanup outside temp");
            rmSync(target, { recursive: true, force: true });
        }
    });

    await runtime.refresh();
    const operatorWallet = runtime.wallet;
    expect(operatorWallet, JSON.stringify(runtime.safety().blockers)).toBeDefined();
    execFileSync(
        process.execPath,
        [
            cli,
            ...buildArkFundingArgs({
                address: await operatorWallet!.getAddress(),
                amount: OPERATOR_FUNDING_SATS,
                password: process.env.ARKD_PASSWORD,
            }),
        ],
        { timeout: 120_000, stdio: "pipe" },
    );
    const operatorCoin = await spendableCoin(
        operatorWallet!,
        `isolated operator ${OPERATOR_FUNDING_SATS}-sat funding`,
        (coin) => coin.value === OPERATOR_FUNDING_SATS,
    );
    // The builder reads the coin, the submitter reads the runtime's own view.
    await runtime.refresh();
    const senderWallet = actors.sender!.wallet;
    const senderTxid = await senderWallet.send({
        address: await senderWallet.getAddress(),
        amount: SENDER_FUNDING_SATS,
    });
    const senderCoin = await spendableCoin(
        senderWallet,
        `exact ${SENDER_FUNDING_SATS}-sat sender funding`,
        (coin) => coin.txid === senderTxid && coin.value === SENDER_FUNDING_SATS,
    );

    const now = Math.floor(Date.now() / 1000);
    const params: DustCovenantParams = {
        receiverKey: ArkAddress.decode(await actors.receiverSats!.wallet.getAddress())
            .vtxoTaprootKey,
        senderKey: await actors.sender!.identity.xOnlyPublicKey(),
        operatorKey: config.operatorKey,
        operatorSignerKey: config.operatorSignerKey,
        exitDelay: config.exitDelay,
        dust: config.dust,
        topup: config.dust,
        locktime: BigInt(now) + config.covenantDeadlineSeconds,
        covenantVersion: 2,
    };
    const covenant = new DustCovenantScript({
        serverKey: config.serverPubkey,
        emulatorKey: config.emulatorPubkey,
        params,
        vtxoMinAmount: config.vtxoMinAmount,
    });
    const covenantAddress = covenant.address(config.addressHrp, config.serverPubkey).encode();
    const covenantScript = hex.encode(covenant.pkScript);
    const covenantValue = lockupSats(params);
    const request: LockupBuildRequest = {
        senderInputs: [fundingOf(senderCoin)],
        funding: {
            inputs: [operatorCoin],
            totalValue: BigInt(operatorCoin.value),
            batchExpiry: normalizeExpiry(operatorCoin),
        },
        advanceId: `renewal-${randomBytes(8).toString("hex")}`,
        params,
        covenantAddress,
        fare: { currency: "sats", units: 0n },
        senderSats: BigInt(SENDER_FUNDING_SATS),
    };
    const funding = await new ProductionLockupBuilder(
        config,
        runtime.getServerUnroll,
    ).buildUnsigned(request);

    policy.update(
        {
            ...DEFAULT_POLICY,
            paused: false,
            maxOutstandingSats: 10_000_000n,
            maxPerPaymentTopupSats: 100_000n,
            maxConcurrentAdvances: 20,
        },
        "renewal-e2e",
    );
    const advance: Advance = {
        id: request.advanceId,
        state: "quoted",
        ...params,
        recoveryLocktime: { kind: "time", value: params.locktime },
        operatorInputs: funding.operatorInputs,
        unsignedLockupTx: funding.unsignedLockupTx,
        unsignedLockupId: funding.unsignedLockupId,
        covenantAddress,
        fare: request.fare,
        createdAt: now,
        updatedAt: now,
        expiresAt: now + 600,
    };
    reservations.reserveQuote({
        advance,
        expectedPolicyRevision: policy.getSnapshot().revision,
        recoveryExecutionBudget: { kind: "time", value: 1n },
    });
    const signedEnvelope = await senderSignedEnvelope(
        funding.unsignedLockupTx,
        actors.sender!.identity,
        request.senderInputs.length,
    );
    reservations.claimLockup(
        advance.id,
        advance.unsignedLockupId,
        hex.encode(randomBytes(32)),
        signedEnvelope,
        () => now + 1,
    );
    const submitter = productionLockupSubmitter(
        config,
        SingleKey.fromPrivateKey(config.operatorPrivkey),
        runtime.providers.arkProvider,
    );
    const submitted = await submitter.submit(
        submitter.validate(advances.get(advance.id)!, signedEnvelope),
    );
    advances.recordLockupObserved(advance.id, submitted.outpoint, now + 2);
    expect(advances.get(advance.id)).toMatchObject({
        state: "locked",
        outpoint: submitted.outpoint,
    });

    const indexer = new RestIndexerProvider(arkdUrl);
    const arkProvider = new RestArkProvider(arkdUrl);
    const emulator = new RestEmulatorProvider(emulatorUrl);
    const funded = await poll(
        "funded v2 covenant coin",
        async () => (await indexer.getVtxos({ outpoints: [submitted.outpoint] })).vtxos,
        (vtxos) => vtxos.length === 1 && !isVtxoSpent(vtxos[0]!),
    ).then((vtxos) => vtxos[0]!);
    expect(funded.script).toBe(covenantScript);
    expect(BigInt(funded.value)).toBe(covenantValue);

    const renewLeaf = covenant.findLeaf(hex.encode(covenant.scripts[Leaf.Renew]!));
    const [proofCoin] = await withPrevTxs(
        [
            {
                ...funded,
                tapTree: covenant.encode(),
                forfeitTapLeafScript: renewLeaf,
                intentTapLeafScript: renewLeaf,
            },
        ],
        indexer,
    );
    const session = actors.sender!.identity.signerSession();
    const sessionPubKey = hex.encode(await session.getPublicKey());
    // The leaf accepts a register intent with no on-chain outputs and at most
    // one cosigner, and tunnels output[activeInputIndex - 1]: the proof's real
    // input is 1, so output 0 is what must preserve script, value and assets.
    const message: Intent.RegisterMessage = {
        type: "register",
        onchain_output_indexes: [],
        valid_at: 0,
        expire_at: 0,
        cosigners_public_keys: [sessionPubKey],
    };
    const proof = Intent.create(
        message,
        [proofCoin],
        [
            { script: covenant.pkScript, amount: covenantValue },
            Extension.create([
                EmulatorPacket.create([
                    { vin: 1, script: covenant.covenant.renew!, witness: new Uint8Array() },
                ]),
            ]).txOut(),
        ],
    );
    const signedProof = await emulator.submitIntent({
        proof: base64.encode(proof.toPSBT()),
        message,
    });
    const intentId = await arkProvider.registerIntent({ proof: signedProof, message });
    const handler = arkade.createArkadeBatchHandler(
        intentId,
        [{ ...proofCoin, arkadeScriptBytes: covenant.covenant.renew! }],
        injectedSignaturesOnly(session),
        signedProof,
        message,
        session,
        arkProvider,
        emulator,
        networks[config.networkName],
    );
    // R2 is answered by the coin reports, so they are recorded before any
    // assertion and whether or not the batch itself succeeded.
    let commitmentTxid: string | undefined;
    let renewalError: unknown;
    try {
        commitmentTxid = await Batch.join(
            arkProvider.getEventStream(abort.signal, [
                sessionPubKey,
                `${funded.txid}:${funded.vout}`,
            ]),
            handler,
            { abortController: abort },
        );
    } catch (error) {
        renewalError = error;
    }
    const evidence = {
        project: required("TAXI_E2E_PROJECT"),
        covenantScript,
        covenantValue: Number(covenantValue),
        intentId,
        commitmentTxid: commitmentTxid ?? null,
        renewalError: renewalError === undefined ? null : String(renewalError),
        consumed: coinReport(
            (await indexer.getVtxos({ outpoints: [submitted.outpoint] })).vtxos[0],
        ),
        atScript: (await indexer.getVtxos({ scripts: [covenantScript] })).vtxos.map(coinReport),
    };
    writeFileSync(artifactPath("renewal-r2.json"), `${JSON.stringify(evidence, null, 2)}\n`);
    console.info("v2 renewal R2 evidence", JSON.stringify(evidence));
    if (renewalError !== undefined) throw renewalError;
    expect(commitmentTxid).toMatch(/^[0-9a-f]{64}$/);

    // The same binding Phase 4 makes: one live coin at the covenant's script
    // and value that is not the coin the batch consumed.
    const bindable = (coin: VirtualCoin) =>
        !isVtxoSpent(coin) &&
        coin.value === Number(covenantValue) &&
        !(coin.txid === submitted.outpoint.txid && coin.vout === submitted.outpoint.vout);
    const successor = await poll(
        "renewal successor at the same script and value",
        async () => (await indexer.getVtxos({ scripts: [covenantScript] })).vtxos.filter(bindable),
        (vtxos) => vtxos.length === 1,
    ).then((vtxos) => vtxos[0]!);
    expect(successor.script).toBe(covenantScript);
    expect(successor.isPreconfirmed).toBe(false);
    expect(isVtxoSpent(successor)).toBe(false);
    expect(successor.assets ?? []).toEqual(funded.assets ?? []);

    const watcher = createSpendWatcher({
        advances,
        policy,
        indexer,
        config,
        now: () => Math.floor(Date.now() / 1000),
        tip: runtime.getChainTip,
    });
    await watcher.catchUp();
    expect(advances.get(advance.id)).toMatchObject({
        state: "locked",
        outpoint: { txid: successor.txid, vout: successor.vout },
        renewals: 1,
    });
    expect(advances.get(advance.id)?.failureCode).toBeUndefined();
});
