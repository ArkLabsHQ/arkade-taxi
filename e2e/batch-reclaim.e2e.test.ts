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
    scriptFromTapLeafScript,
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
    CustodyRepository,
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
    payoutPkScript,
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
import { mineBlocks } from "../scripts/e2e-mine.mjs";
import { createActorWallets, disposeActorWallets } from "../scripts/e2e-wallets.mjs";
import { ownCleanup } from "../scripts/lib/scenario-cleanup.mjs";
import { artifactPath, fundingOf, poll, required } from "./fixtures.js";
import { liveScenario } from "./scenarios.js";

type Actor = { identity: SingleKey; wallet: Wallet };

const OPERATOR_FUNDING_SATS = 100_000;
const SENDER_FUNDING_SATS = 1_000;
const DEADLINE_SECONDS = 120n;

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
              commitmentTxIds: coin.commitmentTxIds ?? null,
              assets: (coin.assets ?? []).map(({ assetId, amount }) => ({
                  assetId,
                  amount: amount.toString(),
              })),
          };

/** The reclaim leaf is `[server, emulator:reclaimWhole]`, so no caller holds a
 * key on it and `SingleKey.sign` throws rather than returning the PSBT. */
const injectedSignaturesOnly = (session: SignerSession): Identity => ({
    sign: async (tx: Transaction) => tx,
    signerSession: () => session,
    signMessage: async () => new Uint8Array(),
    compressedPublicKey: async () => new Uint8Array(33),
    xOnlyPublicKey: async () => new Uint8Array(32),
});

const senderSignedEnvelope = async (encoded: string, identity: Identity): Promise<string> => {
    const envelope = decodeLockupEnvelope(encoded);
    const indexes = envelope.senderInputIndexes;
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

liveScenario("v2-covenant-batch-reclaim", async () => {
    const arkdUrl = required("TAXI_E2E_ARKD_URL");
    const emulatorUrl = required("TAXI_E2E_EMULATOR_URL");
    const esploraUrl = required("ARKADE_ESPLORA_URL");
    const cli = required("ARKADE_REGTEST_CLI");
    const config: RuntimeConfig = await resolveRuntimeConfig(
        loadConfig({
            ...process.env,
            TAXI_OPERATOR_PRIVKEY: randomBytes(32).toString("hex"),
            TAXI_COVENANT_DEADLINE_SECONDS: DEADLINE_SECONDS.toString(),
        }),
    );

    const root = mkdtempSync(join(tmpdir(), "taxi-v2-batch-reclaim-"));
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
    // Off the chain's own clock, not the wall clock: `setmocktime` below must
    // only ever move time forward, whatever an earlier scenario left behind.
    const chainTime = (await runtime.getChainTip()).time;
    const params: DustCovenantParams = {
        receiverKey: ArkAddress.decode(await actors.receiverSats!.wallet.getAddress())
            .vtxoTaprootKey,
        senderKey: await actors.sender!.identity.xOnlyPublicKey(),
        operatorKey: config.operatorKey,
        operatorSignerKey: config.operatorSignerKey,
        exitDelay: config.exitDelay,
        dust: config.dust,
        topup: config.dust,
        locktime: BigInt(chainTime) + config.covenantDeadlineSeconds,
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
    const payoutScript = payoutPkScript(params.operatorKey, covenantValue, params.dust);
    const senderInput = fundingOf(senderCoin);
    const request: LockupBuildRequest = {
        senderInputs: [senderInput],
        funding: {
            inputs: [operatorCoin],
            totalValue: BigInt(operatorCoin.value),
            batchExpiry: normalizeExpiry(operatorCoin),
        },
        advanceId: `batch-reclaim-${randomBytes(8).toString("hex")}`,
        params,
        covenantAddress,
        fare: { currency: "sats", units: 0n },
        senderSats: senderInput.value,
    };
    const funding = await new ProductionLockupBuilder(
        config,
        runtime.getServerUnroll,
    ).buildUnsigned(request);

    const seeded = policy.update(
        {
            paused: false,
            maxOutstandingSats: 10_000_000n,
            maxPerPaymentTopupSats: 100_000n,
            maxConcurrentAdvances: 20,
            quoteTtlSeconds: 600,
            assetRules: [
                {
                    assetId: null,
                    enabled: true,
                    fares: [
                        {
                            id: "sats",
                            currency: { kind: "sats" },
                            pricing: { kind: "flat", units: 0n },
                        },
                    ],
                    claim: "either",
                    maxTopupSats: null,
                },
            ],
        },
        "batch-reclaim-e2e",
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
        expiresAt: now + seeded.quoteTtlSeconds,
    };
    reservations.reserveQuote({
        advance,
        expectedPolicyRevision: policy.getSnapshot().revision,
        recoveryExecutionBudget: { kind: "time", value: 1n },
    });
    const signedEnvelope = await senderSignedEnvelope(
        funding.unsignedLockupTx,
        actors.sender!.identity,
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

    // arkd#151 enforces the leaf's timelock on a batch-settled covenant, so the
    // deadline has to be behind canonical median time before the intent is sent.
    execFileSync(
        process.execPath,
        [cli, "rpc", "setmocktime", String(Number(params.locktime) + 1)],
        { stdio: "pipe", timeout: 30_000 },
    );
    await mineBlocks(11);
    const matured = await poll(
        "canonical median time past the covenant deadline",
        () => runtime.getChainTip(),
        (tip) => BigInt(tip.time) >= params.locktime,
        180_000,
    );

    const reclaimLeaf = covenant.findLeaf(hex.encode(covenant.scripts[Leaf.Recovery]!));
    const [proofCoin] = await withPrevTxs(
        [
            {
                ...funded,
                tapTree: covenant.encode(),
                forfeitTapLeafScript: reclaimLeaf,
                intentTapLeafScript: reclaimLeaf,
            },
        ],
        indexer,
    );
    const session = actors.sender!.identity.signerSession();
    const sessionPubKey = hex.encode(await session.getPublicKey());
    // `reclaimWhole` pins the whole lockup to the operator's payout script, so
    // that is the only batch output the intent may register.
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
            { script: payoutScript, amount: covenantValue },
            Extension.create([
                EmulatorPacket.create([
                    { vin: 1, script: covenant.covenant.reclaim!, witness: new Uint8Array() },
                ]),
            ]).txOut(),
        ],
    );
    let intentId: string | undefined;
    let commitmentTxid: string | undefined;
    let reclaimError: unknown;
    try {
        const signedProof = await emulator.submitIntent({
            proof: base64.encode(proof.toPSBT()),
            message,
        });
        intentId = await arkProvider.registerIntent({ proof: signedProof, message });
        const handler = arkade.createArkadeBatchHandler(
            intentId,
            [{ ...proofCoin, arkadeScriptBytes: covenant.covenant.reclaim! }],
            injectedSignaturesOnly(session),
            signedProof,
            message,
            session,
            arkProvider,
            emulator,
            networks[config.networkName],
        );
        commitmentTxid = await Batch.join(
            arkProvider.getEventStream(abort.signal, [
                sessionPubKey,
                `${funded.txid}:${funded.vout}`,
            ]),
            handler,
            { abortController: abort },
        );
    } catch (error) {
        reclaimError = error;
    }

    const consumed = (await indexer.getVtxos({ outpoints: [submitted.outpoint] })).vtxos[0];
    // What the classifier reads: the forfeit arkd stored under `spentBy` and the
    // leaf its input 0 selected. A swept coin leaves neither.
    let forfeit: { txid: string; found: boolean; leaf: string | null } | null = null;
    if (/^[0-9a-f]{64}$/.test(consumed?.spentBy ?? "")) {
        const { txs } = await indexer
            .getVirtualTxs([consumed!.spentBy!])
            .catch(() => ({ txs: [] }));
        const decoded = txs[0] ? Transaction.fromPSBT(base64.decode(txs[0])) : undefined;
        const selected = decoded?.getInput(0).tapLeafScript;
        forfeit = {
            txid: consumed!.spentBy!,
            found: decoded !== undefined,
            leaf: selected?.length === 1 ? hex.encode(scriptFromTapLeafScript(selected[0]!)) : null,
        };
    }
    const evidence = {
        project: required("TAXI_E2E_PROJECT"),
        covenantScript,
        covenantValue: Number(covenantValue),
        payoutScript: hex.encode(payoutScript),
        reclaimLeafScript: hex.encode(covenant.scripts[Leaf.Recovery]!),
        locktime: Number(params.locktime),
        chainTimeAtIntent: matured.time,
        intentId: intentId ?? null,
        commitmentTxid: commitmentTxid ?? null,
        reclaimError: reclaimError === undefined ? null : String(reclaimError),
        consumed: coinReport(consumed),
        forfeit,
        atPayoutScript: (await indexer.getVtxos({ scripts: [hex.encode(payoutScript)] })).vtxos.map(
            coinReport,
        ),
    };
    writeFileSync(artifactPath("batch-reclaim-r2.json"), `${JSON.stringify(evidence, null, 2)}\n`);
    console.info("v2 batch reclaim evidence", JSON.stringify(evidence));
    if (reclaimError !== undefined) throw reclaimError;
    expect(commitmentTxid).toMatch(/^[0-9a-f]{64}$/);

    const settled = await poll(
        "covenant coin settled in the reclaim batch",
        async () => (await indexer.getVtxos({ outpoints: [submitted.outpoint] })).vtxos[0],
        (coin) => coin?.settledBy === commitmentTxid && !coin?.arkTxId,
    );
    expect(settled!.isSpent).toBe(true);
    expect(settled!.spentBy).toMatch(/^[0-9a-f]{64}$/);

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
        state: "recovered",
        spentTxid: commitmentTxid,
    });
    expect(advances.get(advance.id)?.failureCode).toBeUndefined();
    expect(new CustodyRepository(db).get(advance.id)).toMatchObject({
        state: "held",
        loanSats: params.topup,
    });
});
