import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
    ArkAddress,
    ContractManager,
    InMemoryContractRepository,
    InMemoryWalletRepository,
    EmulatorPacket,
    Extension,
    MultisigTapscript,
    P2A,
    SingleKey,
    Transaction,
    UnknownPacket,
    VtxoScript,
    VtxoTaprootTree,
    asset,
    buildOffchainTx,
    verifyTapscriptSignatures,
    type IndexerProvider,
    type SubscriptionResponse,
    type VirtualCoin,
} from "@arkade-os/sdk";
import { arkade } from "@arkade-os/sdk";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { base64, hex } from "@scure/base";
import {
    DustCovenantScript,
    Leaf,
    covenantSpendInput,
    loanSats,
    lockupSats,
    payoutPkScript,
    recycleFare,
    refundTopup,
    type ReceiverFare,
} from "@arkade-taxi/covenant";
import {
    AdvanceRepository,
    PolicyRepository,
    ProceedsRepository,
    ReservationRepository,
    openDatabase,
    type Database,
} from "@arkade-taxi/db";
import { covenantParamsOf, type Advance, type AdvanceState } from "@arkade-taxi/core";
import { buildLockupEnvelope } from "../src/arkade/lockupBuilder.js";
import { decodeLockupEnvelope } from "../src/arkade/psbt.js";
import { classifyObservedSpend, createSpendWatcher } from "../src/watcher.js";
import { buildRecoveryIntent, createRecoveryRunner } from "../src/arkade/recovery.js";
import { createProceedsCollector } from "../src/proceeds.js";
import {
    config,
    fundingCoin,
    NOW,
    operatorTree,
    policy as basePolicy,
    providerEmulatorKey,
    senderKey,
    serverKey,
} from "./fixtures.js";
import { arkInfo } from "./arkade/fixtures.js";
import { buildRequest, receiverPays, unroll } from "./arkade/lockupFixtures.js";

vi.mock("@arkade-os/sdk", async (importOriginal) => {
    const sdk = await importOriginal<typeof import("@arkade-os/sdk")>();
    return { ...sdk, verifyTapscriptSignatures: vi.fn(sdk.verifyTapscriptSignatures) };
});

const directories: string[] = [];
afterEach(() => {
    while (directories.length) rmSync(directories.pop()!, { recursive: true, force: true });
});

const bytesToNumber = (bytes: Uint8Array): bigint => BigInt(`0x${hex.encode(bytes)}`);
const numberToBytes = (value: bigint): Uint8Array =>
    hex.decode(value.toString(16).padStart(64, "0"));
const serverIdentity = SingleKey.fromPrivateKey(new Uint8Array(32).fill(4));
const senderIdentity = SingleKey.fromPrivateKey(new Uint8Array(32).fill(2));

const emulatorIdentity = (script: Uint8Array): SingleKey => {
    const curve = secp256k1.Point.CURVE();
    const original = bytesToNumber(new Uint8Array(32).fill(5));
    const point = secp256k1.Point.BASE.multiply(original);
    const normalized = (point.y & 1n) === 0n ? original : curve.n - original;
    return SingleKey.fromPrivateKey(
        numberToBytes((normalized + bytesToNumber(arkade.arkadeScriptHash(script))) % curve.n),
    );
};

const source = (script: Uint8Array, amount: bigint, fill: number): Transaction => {
    const tx = new Transaction({ version: 3, lockTime: 0 });
    tx.addInput({ txid: fill.toString(16).padStart(2, "0").repeat(32), index: 0 });
    tx.addOutput({ amount, script });
    return tx;
};

const setVersion = (tx: Transaction, version: number): void => {
    (tx as unknown as { global: { txVersion: number } }).global.txVersion = version;
};

const setLockTime = (tx: Transaction, lockTime: number): void => {
    (tx as unknown as { global: { fallbackLocktime?: number } }).global.fallbackLocktime = lockTime;
};

const compactSize = (length: number): number[] =>
    length < 0xfd ? [length] : [0xfd, length & 0xff, length >>> 8];

/** arkd's taptree encoder, whose per-leaf depth byte both decoders discard. */
const arkdTapTree = (scripts: readonly Uint8Array[]): Uint8Array =>
    Uint8Array.from(
        scripts.flatMap((script, index) => [
            Math.min(index + 1, scripts.length - 1),
            0xc0,
            ...compactSize(script.length),
            ...script,
        ]),
    );

const reencodeTapTrees = (txs: Iterable<Transaction>): void => {
    for (const tx of txs)
        for (let index = 0; index < tx.inputsLength; index++) {
            const entries = tx.getInput(index).unknown;
            if (!entries) continue;
            tx.updateInput(index, {
                unknown: entries.map((entry) => {
                    const raw = VtxoTaprootTree.decode(entry);
                    return raw === null
                        ? entry
                        : VtxoTaprootTree.encode(arkdTapTree(VtxoScript.decode(raw).scripts));
                }),
            });
        }
};

type SpendKind = "recycled" | "purchased" | "refunded" | "recovered";

async function setup(
    kind?: SpendKind,
    path = ":memory:",
    assetSpend: boolean | "omitted" = false,
    observeLockup = true,
    mutateGraph?: (
        graph: ReturnType<typeof buildOffchainTx>,
        context: { emulatorScript: Uint8Array; spendPacket?: asset.Packet },
    ) => void,
    locktime?: bigint,
    receiverLeaf?: Uint8Array,
    receiverIdentity = SingleKey.fromPrivateKey(new Uint8Array(32).fill(6)),
    claimMode?: "recycle" | "purchase",
    recoveryRecipient?: "sender" | "receiver",
    receiverFare?: ReceiverFare,
    cfg = config(),
    receiverExtraLeaves: Uint8Array[] = [],
    paymentSats?: bigint,
    covenantVersion?: 2,
    strangerInput = false,
) {
    const receiverOwner = await receiverIdentity.xOnlyPublicKey();
    const receiverTree = new VtxoScript([
        receiverLeaf ?? MultisigTapscript.encode({ pubkeys: [serverKey, receiverOwner] }).script,
        ...receiverExtraLeaves,
    ]);
    const request = buildRequest();
    request.params.operatorKey = cfg.operatorKey;
    request.params.claimMode = "purchase";
    if (kind === "recycled" || kind === "refunded") request.params.claimMode = "recycle";
    if (claimMode !== undefined) request.params.claimMode = claimMode;
    if (recoveryRecipient !== undefined) request.params.recoveryRecipient = recoveryRecipient;
    if (receiverFare) receiverPays(request, receiverFare);
    if (locktime !== undefined) {
        request.params.locktime = locktime;
        if (locktime >= 500_000_000n) {
            const expiry = locktime + 86_401n;
            request.senderInputs[0]!.expiry = { kind: "time", value: expiry };
            delete request.funding.inputs[0]!.expiresAtHeight;
            request.funding.inputs[0]!.expiresAt = new Date(Number(expiry) * 1000);
            request.funding.batchExpiry = { kind: "time", value: expiry };
        }
    }
    const paymentAsset = assetSpend ? asset.AssetId.create("12".repeat(32), 7) : undefined;
    const paymentUnits = 9_007_199_254_740_993n;
    if (paymentAsset) {
        request.params.assetId = {
            txid: Uint8Array.from(paymentAsset.txid).reverse(),
            groupIndex: paymentAsset.groupIndex,
        };
        if (assetSpend !== "omitted") request.assetUnits = paymentUnits;
        request.senderInputs[0]!.assetPacket = asset.Packet.create([
            asset.AssetGroup.create(
                paymentAsset,
                null,
                [],
                [asset.AssetOutput.create(request.senderInputs[0]!.vout, paymentUnits)],
                [],
            ),
        ]).serialize();
    }
    if (kind === "recycled") request.params.receiverKey = receiverTree.tweakedPublicKey;
    if (paymentSats !== undefined) {
        request.params.topup = request.params.dust;
        request.params.paymentSats = paymentSats;
    }
    if (covenantVersion === 2) {
        request.params.topup = request.params.dust;
        request.params.covenantVersion = 2;
        // Every v2 lockup output reaches dust, so the fixture's 10-sat fare and
        // the sender change left by a whole-dust loan are both unbuildable.
        request.fare.units = request.params.dust;
        request.senderSats = request.senderInputs[0]!.value =
            request.params.dust + (paymentSats ?? 0n);
    }
    const lockupValue = lockupSats(request.params);
    const covenant = new DustCovenantScript({
        params: request.params,
        serverKey: cfg.serverPubkey,
        emulatorKey: cfg.emulatorPubkey,
        vtxoMinAmount: cfg.vtxoMinAmount,
    });
    request.covenantAddress = covenant.address(cfg.addressHrp, cfg.serverPubkey).encode();
    const unsignedLockupTx = buildLockupEnvelope(request, cfg, unroll);
    const envelope = decodeLockupEnvelope(unsignedLockupTx);
    const lockup = Transaction.fromPSBT(base64.decode(envelope.arkTx));
    const advance: Advance = {
        id: request.advanceId,
        state: "quoted",
        ...request.params,
        ...(envelope.assetUnits !== undefined ? { assetUnits: BigInt(envelope.assetUnits) } : {}),
        batchExpiry: request.funding.batchExpiry,
        recoveryLocktime: {
            kind: request.funding.batchExpiry.kind,
            value: request.params.locktime,
        },
        operatorInputs: request.funding.inputs.map(({ txid, vout }) => ({ txid, vout })),
        unsignedLockupTx,
        unsignedLockupId: envelope.unsignedTxId,
        covenantAddress: request.covenantAddress,
        fare: request.fare,
        createdAt: NOW,
        updatedAt: NOW,
        expiresAt: NOW + 60,
    };
    const db = openDatabase(path);
    // A v2 reclaim opens its custody row in the same transaction, and refuses
    // without a window, so the watcher fixture wires one as cli.ts does.
    const advances = new AdvanceRepository(db, {
        custodyWindowSeconds: Number(config().custodyWindowSeconds),
    });
    const policy = new PolicyRepository(db);
    const configuredPolicy = basePolicy();
    if (request.params.assetId) {
        configuredPolicy.assetRules.push({
            assetId: request.params.assetId,
            enabled: true,
            fares: [
                {
                    id: "asset-sats",
                    currency: { kind: "sats" },
                    pricing: { kind: "flat", units: 10n },
                },
            ],
            claim: "either",
            maxTopupSats: null,
        });
    }
    policy.update(configuredPolicy, "test");
    const reservations = new ReservationRepository(db);
    reservations.reserveQuote({
        advance,
        expectedPolicyRevision: policy.getSnapshot().revision,
        recoveryExecutionBudget: { kind: advance.batchExpiry.kind, value: 1n },
    });
    reservations.claimLockup(
        advance.id,
        advance.unsignedLockupId,
        "cc".repeat(32),
        "signed-envelope",
        () => NOW + 1,
    );
    const outpoint = { txid: lockup.id, vout: 0 };
    if (observeLockup) advances.recordLockupObserved(advance.id, outpoint, NOW + 2);

    const txs = new Map<string, Transaction>();
    const coins = new Map<string, VirtualCoin>();
    let finalArk: Transaction | undefined;
    if (kind) {
        const leaf = {
            purchased: Leaf.Purchase,
            recycled: Leaf.Recycle,
            refunded: Leaf.RefundSender,
            recovered: Leaf.Recovery,
        }[kind];
        const covenantPacket = paymentAsset
            ? asset.Packet.create([
                  asset.AssetGroup.create(
                      paymentAsset,
                      null,
                      [],
                      [asset.AssetOutput.create(outpoint.vout, paymentUnits)],
                      [],
                  ),
              ]).serialize()
            : undefined;
        const inputs = [covenantSpendInput(covenant, leaf, outpoint, lockupValue, covenantPacket)];
        const destination = new Uint8Array([0x51, 0x20, ...request.params.receiverKey]);
        const { operatorSats, assetFare } = recycleFare(request.params);
        // v2 leaf 2 spends a second coin the covenant never names, so the harness
        // lends the recycle fixture's tree to the refunder.
        const v2SecondInput = covenantVersion === 2 && kind === "refunded";
        let outputs: { script: Uint8Array; amount: bigint }[];
        let receiverSource: Transaction | undefined;
        if (kind === "purchased") {
            outputs = [{ script: destination, amount: lockupValue }];
        } else if (covenantVersion === 2 && kind === "recovered") {
            outputs = [
                {
                    script: payoutPkScript(
                        request.params.operatorKey,
                        lockupValue,
                        request.params.dust,
                    ),
                    amount: lockupValue,
                },
            ];
            if (strangerInput) {
                receiverSource = source(receiverTree.pkScript, 500n, 0x31);
                inputs.push({
                    txid: receiverSource.id,
                    vout: 0,
                    value: 500n,
                    tapTree: receiverTree.encode(),
                    tapLeafScript: receiverTree.findLeaf(hex.encode(receiverTree.scripts[0])),
                });
                outputs.push({ script: receiverTree.pkScript, amount: 500n });
            }
        } else if (v2SecondInput) {
            receiverSource = source(receiverTree.pkScript, 500n, 0x31);
            inputs.push({
                txid: receiverSource.id,
                vout: 0,
                value: 500n,
                tapTree: receiverTree.encode(),
                tapLeafScript: receiverTree.findLeaf(hex.encode(receiverTree.scripts[0])),
            });
            const loan = loanSats(request.params);
            outputs = [
                {
                    script: payoutPkScript(request.params.operatorKey, loan, request.params.dust),
                    amount: loan,
                },
                { script: receiverTree.pkScript, amount: lockupValue + 500n - loan },
            ];
        } else if (kind === "recycled") {
            receiverSource = source(receiverTree.pkScript, 500n, 0x31);
            inputs.push({
                txid: receiverSource.id,
                vout: 0,
                value: 500n,
                tapTree: receiverTree.encode(),
                tapLeafScript: receiverTree.findLeaf(hex.encode(receiverTree.scripts[0])),
            });
            outputs = [
                {
                    script: payoutPkScript(
                        request.params.operatorKey,
                        operatorSats,
                        request.params.dust,
                    ),
                    amount: operatorSats,
                },
                {
                    script: destination,
                    amount: lockupValue + 500n - operatorSats,
                },
            ];
        } else {
            const topup = refundTopup(request.params, cfg.vtxoMinAmount);
            const recoveryKey =
                request.params.recoveryRecipient === "receiver"
                    ? request.params.receiverKey
                    : request.params.senderKey;
            outputs = [
                {
                    script: payoutPkScript(request.params.operatorKey, topup, request.params.dust),
                    amount: topup,
                },
                {
                    script: payoutPkScript(recoveryKey, lockupValue - topup, request.params.dust),
                    amount: lockupValue - topup,
                },
            ];
            if (strangerInput) {
                receiverSource = source(receiverTree.pkScript, 500n, 0x31);
                inputs.push({
                    txid: receiverSource.id,
                    vout: 0,
                    value: 500n,
                    tapTree: receiverTree.encode(),
                    tapLeafScript: receiverTree.findLeaf(hex.encode(receiverTree.scripts[0])),
                });
                outputs.push({ script: receiverTree.pkScript, amount: 500n });
            }
        }
        const emulatorScript =
            leaf === Leaf.Recovery
                ? (covenant.covenant.reclaim ?? covenant.covenant.refund)
                : covenant.covenant[
                      leaf === Leaf.Recycle
                          ? "recycle"
                          : leaf === Leaf.Purchase
                            ? "purchase"
                            : "refund"
                  ];
        const spendPacket = paymentAsset
            ? asset.Packet.create([
                  asset.AssetGroup.create(
                      paymentAsset,
                      null,
                      [asset.AssetInput.create(0, paymentUnits)],
                      kind === "recycled" && assetFare > 0n
                          ? [
                                asset.AssetOutput.create(0, assetFare),
                                asset.AssetOutput.create(1, paymentUnits - assetFare),
                            ]
                          : [
                                asset.AssetOutput.create(
                                    kind === "purchased" ||
                                        (covenantVersion === 2 && kind === "recovered")
                                        ? 0
                                        : 1,
                                    paymentUnits,
                                ),
                            ],
                      [],
                  ),
              ])
            : undefined;
        const extension = Extension.create([
            ...(spendPacket ? [spendPacket] : []),
            EmulatorPacket.create([{ vin: 0, script: emulatorScript }]),
        ]).txOut();
        const threeReturns = outputs.filter(({ script }) => script[0] === 0x6a).length === 2;
        const graph = buildOffchainTx(
            inputs.map((input) => ({ ...input, value: Number(input.value) })),
            threeReturns ? outputs : [...outputs, extension],
            unroll,
        );
        if (threeReturns) {
            graph.arkTx.updateOutput(graph.arkTx.outputsLength - 1, extension);
            graph.arkTx.addOutput(P2A);
        }
        mutateGraph?.(graph, { emulatorScript, ...(spendPacket ? { spendPacket } : {}) });
        let ark = await serverIdentity.sign(
            graph.arkTx,
            Array.from({ length: graph.arkTx.inputsLength }, (_, index) => index),
        );
        ark = await emulatorIdentity(emulatorScript).sign(ark, [0]);
        if (kind === "refunded") ark = await senderIdentity.sign(ark, [0]);
        if (receiverSource && hex.encode(receiverOwner) !== hex.encode(serverKey))
            ark = await receiverIdentity.sign(ark, [1]);
        const checkpoints = await Promise.all(
            graph.checkpoints.map(async (checkpoint, index) => {
                let signed = await serverIdentity.sign(checkpoint, [0]);
                if (index === 0) signed = await emulatorIdentity(emulatorScript).sign(signed, [0]);
                if (index === 0 && kind === "refunded")
                    signed = await senderIdentity.sign(signed, [0]);
                if (
                    index === 1 &&
                    receiverSource &&
                    hex.encode(receiverOwner) !== hex.encode(serverKey)
                )
                    signed = await receiverIdentity.sign(signed, [0]);
                return signed;
            }),
        );
        finalArk = ark;
        txs.set(ark.id, ark);
        checkpoints.forEach((checkpoint) => txs.set(checkpoint.id, checkpoint));
        coins.set(
            `${outpoint.txid}:${outpoint.vout}`,
            fundingCoin({
                ...outpoint,
                value: Number(lockupValue),
                script: hex.encode(covenant.pkScript),
                isSpent: true,
                spentBy: checkpoints[0].id,
                arkTxId: ark.id,
                assets: paymentAsset
                    ? [{ assetId: paymentAsset.toString(), amount: paymentUnits }]
                    : [],
            }),
        );
        if (receiverSource)
            coins.set(
                `${receiverSource.id}:0`,
                fundingCoin({
                    txid: receiverSource.id,
                    vout: 0,
                    value: 500,
                    script: hex.encode(receiverTree.pkScript),
                    isSpent: true,
                    spentBy: checkpoints[1].id,
                    arkTxId: ark.id,
                    status: { confirmed: false, isLeaf: false },
                    commitmentTxIds: [],
                    assets: [],
                }),
            );
    } else {
        coins.set(
            `${outpoint.txid}:${outpoint.vout}`,
            fundingCoin({
                ...outpoint,
                value: Number(lockupValue),
                script: hex.encode(covenant.pkScript),
                assets: [],
            }),
        );
    }
    const indexer: Pick<IndexerProvider, "getVtxos" | "getVirtualTxs"> = {
        getVtxos: async (options) => ({
            vtxos:
                (options && "outpoints" in options ? options.outpoints : undefined)
                    ?.map(({ txid, vout }) => coins.get(`${txid}:${vout}`))
                    .filter((coin): coin is VirtualCoin => coin !== undefined) ?? [],
        }),
        getVirtualTxs: async (txids) => ({
            txs: txids
                .map((txid) => txs.get(txid))
                .filter((tx): tx is Transaction => tx !== undefined)
                .map((tx) => base64.encode(tx.toPSBT())),
        }),
    };
    const heightLock = request.params.locktime < 500_000_000n;
    let tip = {
        hash: "41".repeat(32),
        height: kind === "recovered" && heightLock ? Number(request.params.locktime) : 700000,
        time: kind === "recovered" && !heightLock ? Number(request.params.locktime) : NOW,
    };
    const watcher = createSpendWatcher({
        advances,
        policy,
        indexer,
        config: cfg,
        now: () => NOW + 10,
        tip: async () => tip,
    });
    return {
        db,
        advances,
        policy,
        reservations,
        advance,
        outpoint,
        coins,
        txs,
        indexer,
        finalArk,
        watcher,
        setTip: (next: typeof tip) => (tip = next),
    };
}

async function watcherWallet(state: Awaited<ReturnType<typeof setup>>) {
    let reportSpendable = true;
    let next: ((update: SubscriptionResponse | undefined) => void) | undefined;
    const indexer = {
        ...state.indexer,
        getVtxos: vi.fn(async (options: Parameters<IndexerProvider["getVtxos"]>[0]) => {
            if (!options || !("scripts" in options)) return state.indexer.getVtxos(options);
            return {
                vtxos: reportSpendable
                    ? [...state.coins.values()].filter(
                          (coin) => options.scripts?.includes(coin.script) && !coin.isSpent,
                      )
                    : [],
            };
        }),
        subscribeForScripts: vi.fn(async () => "taxi-test-subscription"),
        unsubscribeForScripts: vi.fn(async () => {}),
        getSubscription: (_id: string, signal: AbortSignal) =>
            (async function* () {
                while (!signal.aborted) {
                    const update = await new Promise<SubscriptionResponse | undefined>(
                        (resolve) => {
                            next = resolve;
                            signal.addEventListener("abort", () => resolve(undefined), {
                                once: true,
                            });
                        },
                    );
                    next = undefined;
                    if (update) yield update;
                }
            })(),
    } satisfies Pick<
        IndexerProvider,
        | "getVtxos"
        | "getVirtualTxs"
        | "subscribeForScripts"
        | "unsubscribeForScripts"
        | "getSubscription"
    >;
    const manager = await ContractManager.create({
        indexerProvider: indexer as unknown as IndexerProvider,
        contractRepository: new InMemoryContractRepository(),
        walletRepository: new InMemoryWalletRepository(),
        watcherConfig: { failsafePollIntervalMs: 20 },
    });
    return {
        manager,
        indexer,
        wallet: { getContractManager: async () => manager },
        setSpendableView: (enabled: boolean) => (reportSpendable = enabled),
        emit: async (update: SubscriptionResponse) => {
            await vi.waitFor(() => expect(next).toBeDefined());
            next!(update);
        },
    };
}

describe("canonical covenant observation", () => {
    it("allows an unobserved lockup to remain pending without pausing policy", async () => {
        const state = await setup(undefined, ":memory:", false, false);
        state.coins.clear();
        try {
            await state.watcher.catchUp();
            expect(state.advances.get(state.advance.id)?.state).toBe("locking");
            expect(state.advances.get(state.advance.id)?.failureCode).toBeUndefined();
            expect(state.policy.get().paused).toBe(false);
            expect(state.watcher.isRecoverable(state.advance.id)).toBe(false);
        } finally {
            state.db.close();
        }
    });
    it("observes recovery with an omitted public asset quantity", async () => {
        const state = await setup("recovered", ":memory:", "omitted");
        try {
            await state.watcher.catchUp();
            expect(state.advances.get(state.advance.id)).toMatchObject({
                state: "recovered",
                spentTxid: state.finalArk!.id,
            });
        } finally {
            state.db.close();
        }
    });
    it("re-derives a claim-only covenant from the persisted mode after a restart", async () => {
        const state = await setup(
            "recycled",
            ":memory:",
            false,
            true,
            undefined,
            undefined,
            undefined,
            undefined,
            "recycle",
        );
        try {
            await state.watcher.catchUp();
            expect(state.advances.get(state.advance.id)).toMatchObject({
                state: "recycled",
                claimMode: "recycle",
                spentTxid: state.finalArk!.id,
            });
            expect(state.policy.get().paused).toBe(false);
        } finally {
            state.db.close();
        }
    });
    it("clears a transient observation failure only after exact healthy unspent evidence", async () => {
        const state = await setup();
        const read = state.indexer.getVtxos;
        state.indexer.getVtxos = async () => {
            throw new Error("offline");
        };
        await state.watcher.catchUp();
        expect(state.watcher.isRecoverable(state.advance.id)).toBe(false);
        expect(state.advances.get(state.advance.id)?.failureCode).toBe("covenant_spend_unknown");
        state.indexer.getVtxos = read;
        await state.watcher.catchUp();
        expect(state.advances.get(state.advance.id)?.failureCode).toBeUndefined();
        expect(state.watcher.isRecoverable(state.advance.id)).toBe(true);
        expect(state.reservations.listForAdvance(state.advance.id)).toEqual(
            state.advance.operatorInputs,
        );
        expect(state.policy.get().paused).toBe(true);
        state.db.close();
    });

    it.each(["script", "value", "assets", "swept", "spentBy", "missing"])(
        "retains quarantine and blocks recovery for inconsistent unspent %s evidence",
        async (field) => {
            const state = await setup();
            const key = `${state.outpoint.txid}:${state.outpoint.vout}`;
            const coin = state.coins.get(key)!;
            state.advances.recordSpendUnknown(state.advance.id, undefined, "offline", NOW + 3, {
                hash: "41".repeat(32),
                height: 700000,
            });
            if (field === "missing") state.coins.delete(key);
            else if (field === "script") coin.script = "51";
            else if (field === "value") coin.value++;
            else if (field === "assets")
                coin.assets = [{ assetId: "12".repeat(32) + "0000", amount: 1n }];
            else if (field === "swept") coin.isSwept = true;
            else coin.spentBy = "ff".repeat(32);
            await state.watcher.catchUp();
            expect(state.watcher.isRecoverable(state.advance.id)).toBe(false);
            expect(state.advances.get(state.advance.id)?.failureCode).toBe(
                "covenant_spend_unknown",
            );
            expect(state.reservations.listForAdvance(state.advance.id)).toEqual(
                state.advance.operatorInputs,
            );
            state.db.close();
        },
    );

    it("names an unrolled covenant outpoint instead of a generic mismatch", async () => {
        const state = await setup();
        const key = `${state.outpoint.txid}:${state.outpoint.vout}`;
        state.coins.get(key)!.isUnrolled = true;
        await state.watcher.catchUp();
        expect(state.advances.get(state.advance.id)?.failureCode).toBe("covenant_unrolled");
        expect(state.advances.get(state.advance.id)?.failureDetail).toMatch(/unrolled/);
        expect(state.watcher.isRecoverable(state.advance.id)).toBe(false);
        expect(state.policy.get().paused).toBe(false);
        expect(state.reservations.listForAdvance(state.advance.id)).toEqual(
            state.advance.operatorInputs,
        );
        state.db.close();
    });

    it.each([
        ["unspent", {}],
        ["spent on-chain", { isSpent: true, spentBy: "ee".repeat(32), arkTxId: undefined }],
    ])("warns, without blocking readiness, about an unrolled covenant %s", async (_, shape) => {
        const state = await setup();
        Object.assign(state.coins.get(`${state.outpoint.txid}:${state.outpoint.vout}`)!, {
            isUnrolled: true,
            ...shape,
        });
        await state.watcher.catchUp();
        expect(state.advances.get(state.advance.id)?.failureCode).toBe("covenant_unrolled");
        expect(state.policy.get().paused).toBe(false);
        expect(state.watcher.status().blockers).toEqual([]);
        expect(state.watcher.status().warnings).toEqual([
            expect.objectContaining({ advanceId: state.advance.id, code: "covenant_unrolled" }),
        ]);
        state.db.close();
    });

    it.each([{ arkTxId: "dd".repeat(32) }, { settledBy: "cc".repeat(32) }])(
        "keeps an unrolled covenant's unclassified off-chain spend %o as unknown",
        async (offchain) => {
            const state = await setup();
            Object.assign(state.coins.get(`${state.outpoint.txid}:${state.outpoint.vout}`)!, {
                isUnrolled: true,
                isSpent: true,
                spentBy: "ee".repeat(32),
                arkTxId: undefined,
                ...offchain,
            });
            await state.watcher.catchUp();
            expect(state.advances.get(state.advance.id)?.failureCode).toBe(
                "covenant_spend_unknown",
            );
            expect(state.policy.get().paused).toBe(true);
            expect(state.watcher.status().blockers).toEqual([
                expect.objectContaining({ code: "covenant_spend_unknown" }),
            ]);
            expect(state.watcher.status().warnings).toEqual([]);
            state.db.close();
        },
    );

    it.each(["purchased", "recycled", "refunded"] as const)(
        "accepts canonical %s while recovery is prepared or submitted and rejects late responses",
        async (kind) => {
            for (const phase of ["prepared", "submitted"] as const) {
                const state = await setup(kind);
                const intent = buildRecoveryIntent(state.advances.get(state.advance.id)!, config());
                state.advances.claimRecoveryLease(
                    state.advance.id,
                    "worker",
                    "token",
                    NOW + 3,
                    NOW + 60,
                    intent,
                );
                if (phase === "submitted")
                    state.advances.recordRecoveryResponse(
                        state.advance.id,
                        "worker",
                        "token",
                        intent.expectedTxid,
                        intent.arkTx,
                        intent.checkpoints,
                        NOW + 4,
                    );
                await state.watcher.catchUp();
                expect(state.advances.get(state.advance.id)).toMatchObject({
                    state: kind,
                    spentTxid: state.finalArk!.id,
                });
                expect(state.advances.get(state.advance.id)?.failureCode).toBeUndefined();
                expect(state.advances.get(state.advance.id)?.recoveryLeaseToken).toBeUndefined();
                expect(state.reservations.listForAdvance(state.advance.id)).toEqual([]);
                expect(
                    state.advances.renewRecoveryLease(
                        state.advance.id,
                        "worker",
                        "token",
                        NOW + 11,
                        NOW + 60,
                    ),
                ).toBe(false);
                expect(
                    state.advances.recordRecoveryResponse(
                        state.advance.id,
                        "worker",
                        "token",
                        intent.expectedTxid,
                        intent.arkTx,
                        intent.checkpoints,
                        NOW + 11,
                    ),
                ).toBe(false);
                expect(state.advances.get(state.advance.id)?.state).toBe(kind);
                state.db.close();
            }
        },
    );

    it("ignores an emulator response arriving after a validated purchase wins", async () => {
        const state = await setup("purchased");
        const runner = createRecoveryRunner({
            advances: state.advances,
            config: config(),
            workerId: "worker",
            now: () => NOW + 3,
            leaseSeconds: 30,
            backoffSeconds: 1,
            emulator: {
                submitTx: async (arkTx, checkpoints) => {
                    await state.watcher.catchUp();
                    return { signedArkTx: arkTx, signedCheckpointTxs: checkpoints };
                },
            },
        });
        await expect(
            runner.recover(state.advances.get(state.advance.id)!),
        ).resolves.toBeUndefined();
        expect(state.advances.get(state.advance.id)).toMatchObject({
            state: "purchased",
            spentTxid: state.finalArk!.id,
        });
        expect(state.advances.get(state.advance.id)?.failureCode).toBeUndefined();
        state.db.close();
    });
    it("proves a recycle with the literal SDK owner-first spend leaf", async () => {
        const leaf = hex.decode(
            "20f006a18d5653c4edf5391ff23a61f03ff83d237e880ee61187fa9f379a028e0aad20462779ad4aad39514614751a71085f2f10e1c7a593e4e030efb5b8721ce55b0bac",
        );
        const state = await setup("recycled", ":memory:", false, true, undefined, undefined, leaf);
        await state.watcher.catchUp();
        expect(state.advances.get(state.advance.id)).toMatchObject({
            state: "recycled",
            spentTxid: state.finalArk!.id,
        });
        expect(state.reservations.listForAdvance(state.advance.id)).toEqual([]);
        state.db.close();
    });

    it("classifies a covenant spend whose taptrees arrive in arkd's depth encoding", async () => {
        const state = await setup("purchased");
        reencodeTapTrees(state.txs.values());
        await state.watcher.catchUp();
        expect(state.advances.get(state.advance.id)).toMatchObject({
            state: "purchased",
            spentTxid: state.finalArk!.id,
        });
        expect(state.advances.get(state.advance.id)?.failureCode).toBeUndefined();
        state.db.close();
    });

    it.each(["recycled", "refunded", "purchased"] as const)(
        "classifies a %s whole-dust bitcoin covenant carrying its payment",
        async (kind) => {
            const state = await setup(
                kind,
                ":memory:",
                false,
                true,
                undefined,
                undefined,
                undefined,
                undefined,
                undefined,
                undefined,
                undefined,
                config(),
                [],
                100n,
            );
            expect(state.advance).toMatchObject({ topup: 330n, paymentSats: 100n });
            await state.watcher.catchUp();
            expect(state.advances.get(state.advance.id)).toMatchObject({
                state: kind,
                spentTxid: state.finalArk!.id,
            });
            state.db.close();
        },
    );

    const setupV2 = (
        kind: SpendKind,
        payment = 100n,
        mutateGraph?: Parameters<typeof setup>[4],
        strangerInput = false,
    ) =>
        setup(
            kind,
            ":memory:",
            false,
            true,
            mutateGraph,
            undefined,
            undefined,
            undefined,
            undefined,
            undefined,
            undefined,
            config(),
            [],
            payment,
            2,
            strangerInput,
        );

    it("classifies a v2 refund repaying the whole loan to the operator", async () => {
        const state = await setupV2("refunded");
        expect(state.advance).toMatchObject({ covenantVersion: 2, topup: 330n, paymentSats: 100n });
        await state.watcher.catchUp();
        expect(state.advances.get(state.advance.id)).toMatchObject({
            state: "refunded",
            spentTxid: state.finalArk!.id,
        });
        const ark = state.finalArk!;
        expect(ark.inputsLength).toBe(2);
        expect(ark.getOutput(0)).toEqual({
            amount: 330n,
            script: payoutPkScript(state.advance.operatorKey, 330n, state.advance.dust),
        });
        expect(ark.getOutput(1).amount).toBe(430n + 500n - 330n);
        // The accepted out[1] script is input 1's own, and is neither key the leaf names.
        expect(ark.getOutput(1).script).not.toEqual(
            new Uint8Array([0x51, 0x20, ...state.advance.senderKey]),
        );
        expect(ark.getOutput(1).script).not.toEqual(
            new Uint8Array([0x51, 0x20, ...state.advance.receiverKey]),
        );
        state.db.close();
    });

    it("rejects a v2 refund paying senderKey instead of the refunder's own coin", async () => {
        const state = await setupV2("refunded", 100n, (graph) => {
            const out = graph.arkTx.getOutput(1);
            graph.arkTx.updateOutput(1, {
                ...out,
                script: new Uint8Array([0x51, 0x20, ...senderKey]),
            });
        });
        await state.watcher.catchUp();
        expect(state.advances.get(state.advance.id)).toMatchObject({
            state: "locked",
            failureCode: "covenant_spend_unknown",
        });
        await expect(
            classifyObservedSpend(
                state.advances.get(state.advance.id)!,
                state.coins.get(`${state.outpoint.txid}:${state.outpoint.vout}`)!,
                { indexer: state.indexer, config: config() },
                { height: 700000, time: NOW },
            ),
        ).resolves.toMatchObject({
            kind: "unknown",
            reason: "refund recovery output differs from the exact covenant shape",
        });
        state.db.close();
    });

    it("classifies a v2 reclaim as recovered and pins the whole lockup to the operator", async () => {
        const state = await setupV2("recovered");
        await state.watcher.catchUp();
        expect(state.advances.get(state.advance.id)).toMatchObject({
            state: "recovered",
            spentTxid: state.finalArk!.id,
        });
        const ark = state.finalArk!;
        expect(ark.outputsLength).toBe(3);
        expect(ark.getOutput(0)).toEqual({
            amount: 430n,
            script: payoutPkScript(state.advance.operatorKey, 430n, state.advance.dust),
        });
        expect(ark.getOutput(2)).toEqual(P2A);
        state.db.close();
    });

    // A reclaim is permissionless (Fork 3), so a stranger's broadcast must not
    // read as a disagreement: that pauses the Taxi and clearing it never unpauses.
    it("classifies a third party's v2 reclaim carrying its own input and change", async () => {
        const state = await setupV2("recovered", 100n, undefined, true);
        const ark = state.finalArk!;
        expect(ark.inputsLength).toBe(2);
        expect(ark.outputsLength).toBe(4);
        expect(ark.getOutput(0)).toEqual({
            amount: 430n,
            script: payoutPkScript(state.advance.operatorKey, 430n, state.advance.dust),
        });
        expect(ark.getOutput(1).amount).toBe(500n);
        expect(ark.getOutput(3)).toEqual(P2A);

        await state.watcher.catchUp();
        const row = state.advances.get(state.advance.id)!;
        expect(state.policy.get().paused).toBe(false);
        expect(row.failureCode).toBeUndefined();
        expect(row).toMatchObject({ state: "recovered", spentTxid: ark.id });
        state.db.close();
    });

    it.each([
        [
            "underpays the operator by a sat",
            (ark: Transaction) => {
                const operator = ark.getOutput(0);
                const change = ark.getOutput(1);
                ark.updateOutput(0, { ...operator, amount: operator.amount! - 1n });
                ark.updateOutput(1, { ...change, amount: change.amount! + 1n });
            },
        ],
        [
            "pays the wrong key",
            (ark: Transaction) => {
                ark.updateOutput(0, {
                    ...ark.getOutput(0),
                    script: new Uint8Array([0x51, 0x20, ...senderKey]),
                });
            },
        ],
    ] as const)("rejects a third party's v2 reclaim that %s", async (_, mutate) => {
        const state = await setupV2("recovered", 100n, (graph) => mutate(graph.arkTx), true);
        await expect(
            classifyObservedSpend(
                state.advances.get(state.advance.id)!,
                state.coins.get(`${state.outpoint.txid}:${state.outpoint.vout}`)!,
                { indexer: state.indexer, config: config() },
                { height: Number(state.advance.locktime), time: NOW },
            ),
        ).resolves.toMatchObject({
            kind: "unknown",
            reason: "reclaim repayment differs from the exact covenant shape",
        });
        state.db.close();
    });

    it.each(["refunded", "recovered"] as const)(
        "conserves a v2 asset %s through the covenant extension",
        async (kind) => {
            const state = await setup(
                kind,
                ":memory:",
                true,
                true,
                undefined,
                undefined,
                undefined,
                undefined,
                "recycle",
                "receiver",
                { currency: "sats", units: 7n },
                config(),
                [],
                undefined,
                2,
            );
            await state.watcher.catchUp();
            expect(state.advances.get(state.advance.id)).toMatchObject({
                state: kind,
                spentTxid: state.finalArk!.id,
            });
            expect(
                Extension.fromTx(state.finalArk!).getAssetPacket()!.groups[0]!.outputs,
            ).toMatchObject([
                { vout: kind === "recovered" ? 0 : 1, amount: 9_007_199_254_740_993n },
            ]);
            state.db.close();
        },
    );

    it("rejects a v2 reclaim whose CLTV is not mature at the canonical tip", async () => {
        const state = await setupV2("recovered");
        await expect(
            classifyObservedSpend(
                state.advances.get(state.advance.id)!,
                state.coins.get(`${state.outpoint.txid}:${state.outpoint.vout}`)!,
                { indexer: state.indexer, config: config() },
                { height: Number(state.advance.locktime) - 1, time: NOW },
            ),
        ).resolves.toMatchObject({
            kind: "unknown",
            reason: "recovery height CLTV is not mature at the canonical tip",
        });
        state.db.close();
    });

    // Spec 3.2: two v2 covenants differing only in paymentSats share one address, so
    // the exact value comparison is the only thing left binding the funded amount.
    it("rejects a v2 covenant funded at the wrong value by the value comparison alone", async () => {
        const state = await setupV2("recovered");
        const params = covenantParamsOf(state.advances.get(state.advance.id)!);
        const twin = new DustCovenantScript({
            params: { ...params, paymentSats: 999n },
            serverKey: config().serverPubkey,
            emulatorKey: config().emulatorPubkey,
            vtxoMinAmount: config().vtxoMinAmount,
        });
        expect(twin.address(config().addressHrp, config().serverPubkey).encode()).toBe(
            state.advance.covenantAddress,
        );

        const key = `${state.outpoint.txid}:${state.outpoint.vout}`;
        const coin = state.coins.get(key)!;
        const classify = (candidate: VirtualCoin) =>
            classifyObservedSpend(
                state.advances.get(state.advance.id)!,
                candidate,
                { indexer: state.indexer, config: config() },
                { height: Number(state.advance.locktime), time: NOW },
            );
        await expect(classify(coin)).resolves.toMatchObject({ kind: "recovered" });
        await expect(classify({ ...coin, value: 330 + 999 })).resolves.toEqual({
            kind: "unknown",
            txid: coin.arkTxId!,
            reason: "spent outpoint evidence is incomplete or inconsistent",
        });
        state.db.close();
    });

    it("accepts a three-leaf receiver funding tree in arkd's depth encoding", async () => {
        const receiverIdentity = SingleKey.fromPrivateKey(new Uint8Array(32).fill(6));
        const owner = await receiverIdentity.xOnlyPublicKey();
        const state = await setup(
            "recycled",
            ":memory:",
            false,
            true,
            undefined,
            undefined,
            undefined,
            receiverIdentity,
            undefined,
            undefined,
            undefined,
            config(),
            [unroll.script, MultisigTapscript.encode({ pubkeys: [owner, serverKey] }).script],
        );
        reencodeTapTrees(state.txs.values());
        await state.watcher.catchUp();
        expect(state.advances.get(state.advance.id)).toMatchObject({
            state: "recycled",
            spentTxid: state.finalArk!.id,
        });
        expect(state.advances.get(state.advance.id)?.failureCode).toBeUndefined();
        state.db.close();
    });

    it("rejects a recycled input whose two signers are the same server key", async () => {
        const leaf = MultisigTapscript.encode({ pubkeys: [serverKey, serverKey] }).script;
        const state = await setup(
            "recycled",
            ":memory:",
            false,
            true,
            undefined,
            undefined,
            leaf,
            serverIdentity,
        );
        await state.watcher.catchUp();
        expect(state.advances.get(state.advance.id)).toMatchObject({
            state: "locked",
            failureCode: "covenant_spend_unknown",
        });
        expect(state.reservations.listForAdvance(state.advance.id)).toEqual(
            state.advance.operatorInputs,
        );
        state.db.close();
    });

    it.each([
        ["Arkade", "missing"],
        ["Arkade", "rogue"],
        ["checkpoint", "missing"],
        ["checkpoint", "rogue"],
    ] as const)(
        "rejects an owner-first %s input with a %s owner signature",
        async (part, mutation) => {
            const leaf = hex.decode(
                "20f006a18d5653c4edf5391ff23a61f03ff83d237e880ee61187fa9f379a028e0aad20462779ad4aad39514614751a71085f2f10e1c7a593e4e030efb5b8721ce55b0bac",
            );
            const state = await setup(
                "recycled",
                ":memory:",
                false,
                true,
                undefined,
                undefined,
                leaf,
            );
            const target =
                part === "Arkade"
                    ? state.finalArk!
                    : state.txs.get(hex.encode(state.finalArk!.getInput(1).txid!))!;
            const index = part === "Arkade" ? 1 : 0;
            const signatures = target.getInput(index).tapScriptSig!;
            const owner = signatures.find(
                ([metadata]) => hex.encode(metadata.pubKey) !== hex.encode(serverKey),
            )!;
            const retained = signatures.filter((signature) => signature !== owner);
            if (mutation === "rogue")
                retained.push([
                    { ...owner[0], pubKey: await senderIdentity.xOnlyPublicKey() },
                    owner[1],
                ]);
            target.updateInput(index, { tapScriptSig: undefined });
            target.updateInput(index, { tapScriptSig: retained });
            await state.watcher.catchUp();
            expect(state.advances.get(state.advance.id)).toMatchObject({
                state: "locked",
                failureCode: "covenant_spend_unknown",
            });
            expect(state.reservations.listForAdvance(state.advance.id)).toEqual(
                state.advance.operatorInputs,
            );
            state.db.close();
        },
    );

    it("retains a covenant outpoint that remains unspent", async () => {
        const state = await setup();
        await state.watcher.catchUp();
        expect(state.advances.get(state.advance.id)?.state).toBe("locked");
        expect(state.reservations.listForAdvance(state.advance.id)).toEqual(
            state.advance.operatorInputs,
        );
        expect(state.watcher.status().blockers).toEqual([]);
        state.db.close();
    });

    it("pauses admission when canonical tip identity is unavailable", async () => {
        const state = await setup();
        const watcher = createSpendWatcher({
            advances: state.advances,
            policy: state.policy,
            indexer: state.indexer,
            config: config(),
            now: () => NOW + 10,
            tip: async () => {
                throw new Error("offline");
            },
        });
        await watcher.catchUp();
        expect(state.policy.get().paused).toBe(true);
        expect(watcher.status().blockers).toEqual([
            {
                code: "canonical_tip_unavailable",
                detail: "canonical chain tip hash, height, and time are unavailable",
            },
        ]);
        state.db.close();
    });

    it.each([
        ["hash", { hash: "", height: 700000, time: NOW }],
        ["height", { hash: "46".repeat(32), height: -1, time: NOW }],
        ["time", { hash: "46".repeat(32), height: 700000, time: Number.NaN }],
        ["missing time", { hash: "46".repeat(32), height: 700000 }],
    ] as const)("blocks a malformed canonical tip %s", async (_label, malformed) => {
        const state = await setup("purchased");
        await state.watcher.catchUp();
        const watcher = createSpendWatcher({
            advances: state.advances,
            policy: state.policy,
            indexer: state.indexer,
            config: config(),
            now: () => NOW + 10,
            tip: async () => malformed as { hash: string; height: number; time: number },
        });
        await watcher.catchUp();
        expect(state.policy.get().paused).toBe(true);
        expect(watcher.status().blockers).toContainEqual({
            code: "canonical_tip_unavailable",
            detail: "canonical chain tip hash, height, and time are unavailable",
        });
        state.db.close();
    });

    it.each([
        ["recycled", "recycled"],
        ["purchased", "purchased"],
        ["refunded", "refunded"],
        ["recovered", "recovered"],
    ] as const)("proves a %s spend from the raw transaction chain", async (kind, expected) => {
        const state = await setup(kind);
        await state.watcher.catchUp();
        expect(state.advances.get(state.advance.id)).toMatchObject({
            state: expected as AdvanceState,
            spentTxid: state.finalArk!.id,
            observationTipHash: "41".repeat(32),
        });
        expect(state.reservations.listForAdvance(state.advance.id)).toEqual([]);
        state.db.close();
    });

    const v1Stranger = (mutateGraph?: Parameters<typeof setup>[4], kind: SpendKind = "recovered") =>
        setup(
            kind,
            ":memory:",
            false,
            true,
            mutateGraph,
            undefined,
            undefined,
            undefined,
            undefined,
            undefined,
            undefined,
            config(),
            [],
            undefined,
            undefined,
            true,
        );

    // buildRefund has no INSPECTNUMINPUTS, so leaf 2 accepts a sender who brings
    // their own coin. senderKey signing it makes the sender the only builder, not
    // the shape the Taxi happens to emit.
    it("classifies a sender-built v1 refund carrying their own input and change", async () => {
        const state = await v1Stranger(undefined, "refunded");
        const ark = state.finalArk!;
        const topup = refundTopup(state.advance, config().vtxoMinAmount);

        expect(ark.inputsLength).toBe(2);
        expect(ark.getOutput(0)).toEqual({
            amount: topup,
            script: payoutPkScript(state.advance.operatorKey, topup, state.advance.dust),
        });
        expect(ark.getOutput(1)).toEqual({
            amount: state.advance.dust - topup,
            script: payoutPkScript(
                state.advance.senderKey,
                state.advance.dust - topup,
                state.advance.dust,
            ),
        });
        expect(ark.getOutput(2).amount).toBe(500n);

        await state.watcher.catchUp();
        const row = state.advances.get(state.advance.id)!;
        expect(state.policy.get().paused).toBe(false);
        expect(row.failureCode).toBeUndefined();
        expect(row).toMatchObject({ state: "refunded", spentTxid: ark.id });
        state.db.close();
    });

    it.each([
        ["underpays the operator", 0, "refund repayment"],
        ["shorts the sender", 1, "refund recovery output"],
    ] as const)("rejects a sender-built v1 refund that %s by a sat", async (_, vout, label) => {
        const state = await v1Stranger((graph) => {
            const pinned = graph.arkTx.getOutput(vout);
            const change = graph.arkTx.getOutput(2);
            graph.arkTx.updateOutput(vout, { ...pinned, amount: pinned.amount! - 1n });
            graph.arkTx.updateOutput(2, { ...change, amount: change.amount! + 1n });
        }, "refunded");
        await expect(
            classifyObservedSpend(
                state.advances.get(state.advance.id)!,
                state.coins.get(`${state.outpoint.txid}:${state.outpoint.vout}`)!,
                { indexer: state.indexer, config: config() },
                { height: 700000, time: NOW },
            ),
        ).resolves.toMatchObject({
            kind: "unknown",
            reason: `${label} differs from the exact covenant shape`,
        });
        state.db.close();
    });

    // v2 leaf 2 pins INSPECTNUMINPUTS 2 but no output count, so a zero-value extra
    // conserves value and is script-valid. Appended after P2A, it also proves the
    // anchor is found by content rather than at the end of the list.
    it("classifies a v2 refund carrying an extra zero-value output", async () => {
        const state = await setupV2("refunded", 100n, (graph) =>
            graph.arkTx.addOutput({
                amount: 0n,
                script: new Uint8Array([0x51, 0x20, ...senderKey]),
            }),
        );
        const ark = state.finalArk!;
        expect(ark.outputsLength).toBe(5);
        expect(ark.getOutput(3)).toEqual(P2A);
        expect(ark.getOutput(4).amount).toBe(0n);

        await state.watcher.catchUp();
        const row = state.advances.get(state.advance.id)!;
        expect(state.policy.get().paused).toBe(false);
        expect(row.failureCode).toBeUndefined();
        expect(row).toMatchObject({ state: "refunded", spentTxid: ark.id });
        state.db.close();
    });

    // Leaf 3 is arkade-only on v1 too, and buildRefund pins no input count, so a
    // stranger's broadcast is valid. Classified unknown it pauses the Taxi, and
    // clearSpendUnknown never unpauses.
    it("classifies a third party's v1 recovery carrying its own input and change", async () => {
        const state = await v1Stranger();
        const ark = state.finalArk!;
        const topup = refundTopup(state.advance, config().vtxoMinAmount);

        expect(ark.inputsLength).toBe(2);
        expect(ark.getOutput(0)).toEqual({
            amount: topup,
            script: payoutPkScript(state.advance.operatorKey, topup, state.advance.dust),
        });
        expect(ark.getOutput(1)).toEqual({
            amount: state.advance.dust - topup,
            script: payoutPkScript(
                state.advance.senderKey,
                state.advance.dust - topup,
                state.advance.dust,
            ),
        });
        expect(ark.getOutput(2).amount).toBe(500n);

        await state.watcher.catchUp();
        const row = state.advances.get(state.advance.id)!;
        expect(state.policy.get().paused).toBe(false);
        expect(row.failureCode).toBeUndefined();
        expect(row).toMatchObject({ state: "recovered", spentTxid: ark.id });
        state.db.close();
    });

    it.each([
        [
            "underpays the operator by a sat",
            "refund repayment",
            (ark: Transaction) => {
                const operator = ark.getOutput(0);
                const change = ark.getOutput(2);
                ark.updateOutput(0, { ...operator, amount: operator.amount! - 1n });
                ark.updateOutput(2, { ...change, amount: change.amount! + 1n });
            },
        ],
        [
            "pays the operator's share to the wrong key",
            "refund repayment",
            (ark: Transaction) => {
                const operator = ark.getOutput(0);
                ark.updateOutput(0, {
                    ...operator,
                    script: payoutPkScript(serverKey, operator.amount!, config().dust),
                });
            },
        ],
        [
            "shorts the recovery output by a sat",
            "refund recovery output",
            (ark: Transaction) => {
                const recovery = ark.getOutput(1);
                const change = ark.getOutput(2);
                ark.updateOutput(1, { ...recovery, amount: recovery.amount! - 1n });
                ark.updateOutput(2, { ...change, amount: change.amount! + 1n });
            },
        ],
    ] as const)("rejects a third party's v1 recovery that %s", async (_, label, mutate) => {
        const state = await v1Stranger((graph) => mutate(graph.arkTx));
        await expect(
            classifyObservedSpend(
                state.advances.get(state.advance.id)!,
                state.coins.get(`${state.outpoint.txid}:${state.outpoint.vout}`)!,
                { indexer: state.indexer, config: config() },
                { height: Number(state.advance.locktime), time: NOW },
            ),
        ).resolves.toMatchObject({
            kind: "unknown",
            reason: `${label} differs from the exact covenant shape`,
        });
        state.db.close();
    });

    it.each(["refunded", "recovered"] as const)(
        "proves receiver-owned %s without a sender output",
        async (kind) => {
            const state = await setup(
                kind,
                ":memory:",
                true,
                true,
                undefined,
                undefined,
                undefined,
                undefined,
                "recycle",
                "receiver",
            );
            await state.watcher.catchUp();
            expect(state.advances.get(state.advance.id)).toMatchObject({ state: kind });
            const topup = refundTopup(state.advance, config().vtxoMinAmount);
            const returned = state.advance.dust - topup;
            expect(state.finalArk!.getOutput(1).script).toEqual(
                payoutPkScript(state.advance.receiverKey, returned, state.advance.dust),
            );
            expect(state.finalArk!.getOutput(1).script).not.toEqual(
                payoutPkScript(state.advance.senderKey, returned, state.advance.dust),
            );
            expect(
                Extension.fromTx(state.finalArk!).getAssetPacket()!.groups[0]!.outputs[0],
            ).toMatchObject({ vout: 1, amount: 9_007_199_254_740_993n });
            state.db.close();
        },
    );

    it.each([
        ["sender-paid", undefined],
        ["sats-fare", { currency: "sats", units: 7n }],
        ["asset-fare", { currency: "asset", units: 9n }],
    ] as const)("rebuilds the quoted covenant for a persisted %s recovery", async (_, fare) => {
        const state = await setup(
            "recovered",
            ":memory:",
            true,
            true,
            undefined,
            undefined,
            undefined,
            undefined,
            "recycle",
            "receiver",
            fare,
        );
        try {
            const stored = state.advances.get(state.advance.id)!;
            expect(stored.receiverFare).toEqual(fare);
            const coin = state.coins.get(`${state.outpoint.txid}:${state.outpoint.vout}`)!;
            await expect(
                classifyObservedSpend(
                    stored,
                    coin,
                    { indexer: state.indexer, config: config() },
                    { height: Number(stored.locktime), time: NOW },
                ),
            ).resolves.toEqual({ kind: "recovered", txid: state.finalArk!.id });
        } finally {
            state.db.close();
        }
    });

    it.each([
        ["sats", { currency: "sats", units: 7n }],
        ["asset", { currency: "asset", units: 9n }],
    ] as const)("proves a receiver-paid recycle paying its %s fare", async (_, fare) => {
        const state = await setup(
            "recycled",
            ":memory:",
            true,
            true,
            undefined,
            undefined,
            undefined,
            undefined,
            "recycle",
            "receiver",
            fare,
        );
        await state.watcher.catchUp();
        expect(state.advances.get(state.advance.id)).toMatchObject({
            state: "recycled",
            spentTxid: state.finalArk!.id,
        });
        state.db.close();
    });

    it("proves a large asset purchase only when the extension conserves exact units", async () => {
        const state = await setup("purchased", ":memory:", true);
        await state.watcher.catchUp();
        expect(state.advances.get(state.advance.id)).toMatchObject({
            state: "purchased",
            spentTxid: state.finalArk!.id,
        });
        state.db.close();
    });

    it.each([
        [
            "Arkade transaction version",
            (graph: ReturnType<typeof buildOffchainTx>) => setVersion(graph.arkTx, 2),
        ],
        [
            "checkpoint version",
            (graph: ReturnType<typeof buildOffchainTx>) => setVersion(graph.checkpoints[0]!, 2),
        ],
        [
            "Arkade input sequence",
            (graph: ReturnType<typeof buildOffchainTx>) =>
                graph.arkTx.updateInput(0, { sequence: 0xfffffffd }),
        ],
        [
            "checkpoint input sequence",
            (graph: ReturnType<typeof buildOffchainTx>) =>
                graph.checkpoints[0]!.updateInput(0, { sequence: 0xfffffffd }),
        ],
        [
            "unexpected purchase locktime",
            (graph: ReturnType<typeof buildOffchainTx>) => setLockTime(graph.arkTx, 1),
        ],
    ] as const)("rejects a re-signed noncanonical %s", async (_label, mutate) => {
        const state = await setup("purchased", ":memory:", false, true, (graph) => mutate(graph));
        await state.watcher.catchUp();
        expect(state.advances.get(state.advance.id)).toMatchObject({
            state: "locked",
            failureCode: "covenant_spend_unknown",
        });
        expect(state.reservations.listForAdvance(state.advance.id)).toEqual(
            state.advance.operatorInputs,
        );
        state.db.close();
    });

    it("rejects an extension containing an unknown packet", async () => {
        const state = await setup(
            "purchased",
            ":memory:",
            false,
            true,
            (graph, { emulatorScript }) => {
                graph.arkTx.updateOutput(
                    1,
                    Extension.create([
                        new UnknownPacket(99, new Uint8Array([1])),
                        EmulatorPacket.create([{ vin: 0, script: emulatorScript }]),
                    ]).txOut(),
                );
            },
        );
        await state.watcher.catchUp();
        expect(state.advances.get(state.advance.id)).toMatchObject({
            state: "locked",
            failureCode: "covenant_spend_unknown",
        });
        expect(state.reservations.listForAdvance(state.advance.id)).toEqual(
            state.advance.operatorInputs,
        );
        state.db.close();
    });

    it("rejects an extension with known packets in noncanonical order", async () => {
        const state = await setup(
            "purchased",
            ":memory:",
            true,
            true,
            (graph, { emulatorScript, spendPacket }) => {
                graph.arkTx.updateOutput(
                    1,
                    Extension.create([
                        EmulatorPacket.create([{ vin: 0, script: emulatorScript }]),
                        spendPacket!,
                    ]).txOut(),
                );
            },
        );
        await state.watcher.catchUp();
        expect(state.advances.get(state.advance.id)).toMatchObject({
            state: "locked",
            failureCode: "covenant_spend_unknown",
        });
        expect(state.reservations.listForAdvance(state.advance.id)).toEqual(
            state.advance.operatorInputs,
        );
        state.db.close();
    });

    it("does not compare a height recovery locktime with tip time", async () => {
        const state = await setup("recovered");
        state.setTip({ hash: "4a".repeat(32), height: 899855, time: 2_000_000_000 });
        await state.watcher.catchUp();
        expect(state.advances.get(state.advance.id)).toMatchObject({
            state: "locked",
            failureCode: "covenant_spend_unknown",
        });
        state.db.close();
    });

    it("does not compare a time recovery locktime with tip height", async () => {
        const locktime = BigInt(NOW + 100);
        const state = await setup("recovered", ":memory:", false, true, undefined, locktime);
        state.setTip({ hash: "4b".repeat(32), height: 2_000_000_000, time: NOW + 99 });
        await state.watcher.catchUp();
        expect(state.advances.get(state.advance.id)).toMatchObject({
            state: "locked",
            failureCode: "covenant_spend_unknown",
        });
        state.db.close();
    });

    const contradictoryReceiverCases: ReadonlyArray<
        readonly [string, (coin: VirtualCoin) => void]
    > = [
        [
            "script",
            (coin) => {
                coin.script = "51";
            },
        ],
        [
            "missing expiry",
            (coin) => {
                delete coin.expiresAtHeight;
            },
        ],
        [
            "mixed expiry tags",
            (coin) => {
                coin.expiresAt = new Date((NOW + 10_000) * 1000);
            },
        ],
        [
            "preconfirmation status",
            (coin) => {
                coin.status = { confirmed: true };
            },
        ],
        [
            "unrolled status",
            (coin) => {
                coin.isUnrolled = true;
            },
        ],
    ];

    it.each(contradictoryReceiverCases)(
        "rejects receiver funding with contradictory canonical %s",
        async (_label, mutate) => {
            const state = await setup("recycled");
            const receiver = [...state.coins.entries()].find(
                ([key]) => key !== `${state.outpoint.txid}:${state.outpoint.vout}`,
            )![1];
            mutate(receiver);
            await state.watcher.catchUp();
            expect(state.advances.get(state.advance.id)).toMatchObject({
                state: "locked",
                failureCode: "covenant_spend_unknown",
            });
            expect(state.reservations.listForAdvance(state.advance.id)).toEqual(
                state.advance.operatorInputs,
            );
            state.db.close();
        },
    );

    it("accepts a first recycle observation whose receiver funding is already swept", async () => {
        const state = await setup("recycled");
        const receiver = [...state.coins.entries()].find(
            ([key]) => key !== `${state.outpoint.txid}:${state.outpoint.vout}`,
        )![1];
        receiver.isSwept = true;
        await state.watcher.catchUp();
        expect(state.advances.get(state.advance.id)).toMatchObject({
            state: "recycled",
            spentTxid: state.finalArk!.id,
        });
        expect(state.policy.get().paused).toBe(false);
        state.db.close();
    });

    it.each([
        ["version", (checkpoint: Transaction) => setVersion(checkpoint, 2)],
        ["locktime", (checkpoint: Transaction) => setLockTime(checkpoint, 1)],
        [
            "input sequence",
            (checkpoint: Transaction) => checkpoint.updateInput(0, { sequence: 0xfffffffd }),
        ],
    ] as const)(
        "rejects a re-linked and re-signed receiver checkpoint %s",
        async (_label, mutate) => {
            const state = await setup("recycled", ":memory:", false, true, (graph) => {
                const checkpoint = graph.checkpoints[1]!;
                mutate(checkpoint);
                graph.arkTx.updateInput(1, { txid: checkpoint.id });
            });
            await state.watcher.catchUp();
            expect(state.advances.get(state.advance.id)).toMatchObject({
                state: "locked",
                failureCode: "covenant_spend_unknown",
            });
            expect(state.reservations.listForAdvance(state.advance.id)).toEqual(
                state.advance.operatorInputs,
            );
            expect(state.policy.get().paused).toBe(true);
            state.db.close();
        },
    );

    it.each(["missing", "duplicate"] as const)(
        "rejects a %s canonical receiver funding record",
        async (mode) => {
            const state = await setup("recycled");
            const receiverEntry = [...state.coins.entries()].find(
                ([key]) => key !== `${state.outpoint.txid}:${state.outpoint.vout}`,
            )!;
            if (mode === "missing") state.coins.delete(receiverEntry[0]);
            else {
                const read = state.indexer.getVtxos;
                state.indexer.getVtxos = async (options) => {
                    const response = await read(options);
                    return options?.outpoints?.[0]?.txid === receiverEntry[1].txid
                        ? { vtxos: [receiverEntry[1], receiverEntry[1]] }
                        : response;
                };
            }
            await state.watcher.catchUp();
            expect(state.advances.get(state.advance.id)).toMatchObject({
                state: "locked",
                failureCode: "covenant_spend_unknown",
            });
            expect(state.reservations.listForAdvance(state.advance.id)).toEqual(
                state.advance.operatorInputs,
            );
            state.db.close();
        },
    );

    it("classifies a malformed signature as unknown and retains reservations", async () => {
        const state = await setup("purchased");
        state.finalArk!.updateInput(0, { tapScriptSig: undefined });
        await state.watcher.catchUp();
        expect(state.advances.get(state.advance.id)).toMatchObject({
            state: "locked",
            failureCode: "covenant_spend_unknown",
        });
        expect(state.reservations.listForAdvance(state.advance.id)).toEqual(
            state.advance.operatorInputs,
        );
        expect(state.policy.get().paused).toBe(true);
        expect(state.watcher.status().blockers[0]).toMatchObject({
            advanceId: state.advance.id,
            code: "covenant_spend_unknown",
        });
        expect(JSON.stringify(state.watcher.status())).not.toContain("cHNidP");
        state.db.close();
    });

    it("deduplicates an identical observation", async () => {
        const state = await setup("purchased");
        await state.watcher.catchUp();
        const first = state.advances.get(state.advance.id)!;
        await state.watcher.catchUp();
        expect(state.advances.get(state.advance.id)).toEqual(first);
        state.db.close();
    });

    it("reuses successful signature checks while refetching canonical recycle evidence", async () => {
        const state = await setup("recycled");
        const verify = vi.mocked(verifyTapscriptSignatures).mockClear();
        const coins = vi.spyOn(state.indexer, "getVtxos");
        const transactions = vi.spyOn(state.indexer, "getVirtualTxs");
        try {
            await state.watcher.catchUp();
            expect(verify).toHaveBeenCalledTimes(4);
            expect(coins).toHaveBeenCalledTimes(2);
            expect(transactions).toHaveBeenCalledTimes(2);
            state.setTip({ hash: "42".repeat(32), height: 700001, time: NOW + 1 });
            await state.watcher.catchUp();
            expect(verify).toHaveBeenCalledTimes(4);
            expect(coins).toHaveBeenCalledTimes(4);
            expect(transactions).toHaveBeenCalledTimes(4);
            expect(state.advances.get(state.advance.id)).toMatchObject({
                state: "recycled",
                observationTipHash: "42".repeat(32),
                observationTipHeight: 700001,
            });
        } finally {
            coins.mockRestore();
            transactions.mockRestore();
            state.db.close();
        }
    });

    it.each(["signature", "signer", "leaf", "witness"] as const)(
        "rejects changed %s evidence after caching a valid spend with the same txid",
        async (mutation) => {
            const state = await setup("purchased");
            const verify = vi.mocked(verifyTapscriptSignatures).mockClear();
            try {
                await state.watcher.catchUp();
                expect(verify).toHaveBeenCalledTimes(2);
                const tx = state.finalArk!;
                const id = tx.id;
                const input = tx.getInput(0);
                if (mutation === "witness") {
                    tx.updateInput(0, { tapScriptSig: undefined });
                    tx.updateInput(0, { witnessUtxo: undefined });
                    tx.updateInput(0, { witnessUtxo: { ...input.witnessUtxo!, amount: 331n } });
                    tx.updateInput(0, { tapScriptSig: input.tapScriptSig });
                } else {
                    const signatures = input.tapScriptSig!;
                    const [metadata, signature] = signatures[0]!;
                    const changed = Uint8Array.from(signature);
                    changed[0] ^= 1;
                    signatures[0] = [
                        {
                            ...metadata,
                            ...(mutation === "signer"
                                ? { pubKey: new Uint8Array(32).fill(7) }
                                : {}),
                        },
                        mutation === "signature" ? changed : signature,
                    ];
                    if (mutation === "leaf")
                        for (const entry of signatures)
                            entry[0] = { ...entry[0], leafHash: new Uint8Array(32).fill(8) };
                    tx.updateInput(0, { tapScriptSig: undefined });
                    tx.updateInput(0, { tapScriptSig: signatures });
                }
                expect(tx.id).toBe(id);
                await state.watcher.catchUp();
                expect(state.advances.get(state.advance.id)).toMatchObject({
                    state: "purchased",
                    failureCode: "covenant_observation_disagreement",
                });
                expect(state.policy.get().paused).toBe(true);
                if (mutation === "signature" || mutation === "leaf") {
                    const failed = verify.mock.calls.length;
                    expect(failed).toBeGreaterThan(2);
                    await state.watcher.catchUp();
                    expect(verify.mock.calls.length).toBeGreaterThan(failed);
                }
            } finally {
                state.db.close();
            }
        },
    );

    it("reverifies changed PSBT bytes even when signatures and transaction id are unchanged", async () => {
        const state = await setup("purchased");
        const verify = vi.mocked(verifyTapscriptSignatures).mockClear();
        try {
            await state.watcher.catchUp();
            expect(verify).toHaveBeenCalledTimes(2);
            const tx = state.finalArk!;
            const id = tx.id;
            tx.updateInput(0, {
                unknown: [
                    ...(tx.getInput(0).unknown ?? []),
                    [{ type: 0xfc, key: new Uint8Array([1]) }, new Uint8Array([2])],
                ],
            });
            expect(tx.id).toBe(id);
            await state.watcher.catchUp();
            expect(verify).toHaveBeenCalledTimes(3);
            expect(state.advances.get(state.advance.id)?.failureCode).toBeUndefined();
        } finally {
            state.db.close();
        }
    });

    it("rejects changed outputs and a newly observed spend after caching the original transaction", async () => {
        const state = await setup("purchased");
        const verify = vi.mocked(verifyTapscriptSignatures).mockClear();
        try {
            await state.watcher.catchUp();
            const tx = state.finalArk!;
            const original = tx.id;
            const signatures = tx.getInput(0).tapScriptSig;
            tx.updateInput(0, { tapScriptSig: undefined });
            tx.updateOutput(0, { amount: 331n });
            tx.updateInput(0, { tapScriptSig: signatures });
            expect(tx.id).not.toBe(original);
            state.coins.get(`${state.outpoint.txid}:${state.outpoint.vout}`)!.arkTxId = tx.id;
            state.txs.delete(original);
            state.txs.set(tx.id, tx);
            await state.watcher.catchUp();
            expect(verify).toHaveBeenCalledTimes(3);
            expect(state.advances.get(state.advance.id)).toMatchObject({
                state: "purchased",
                spentTxid: original,
                failureCode: "covenant_observation_disagreement",
            });
            expect(state.policy.get().paused).toBe(true);
        } finally {
            state.db.close();
        }
    });

    it("discards successful signature checks when the watcher stops", async () => {
        const state = await setup("purchased");
        const verify = vi.mocked(verifyTapscriptSignatures).mockClear();
        try {
            await state.watcher.start();
            await state.watcher.catchUp();
            expect(verify).toHaveBeenCalledTimes(2);
            await state.watcher.stop();
            await state.watcher.start();
            expect(verify).toHaveBeenCalledTimes(4);
        } finally {
            await state.watcher.stop();
            state.db.close();
        }
    });

    it("bounds retained successful checks and reverifies an evicted signed PSBT", async () => {
        const state = await setup("purchased");
        const verify = vi.mocked(verifyTapscriptSignatures).mockClear();
        const implementation = verify.getMockImplementation()!;
        const tx = state.finalArk!;
        const unknown = tx.getInput(0).unknown;
        try {
            await state.watcher.catchUp();
            await state.watcher.catchUp();
            expect(verify).toHaveBeenCalledTimes(2);
            verify.mockImplementation(() => {});
            for (let nonce = 0; nonce < 1024; nonce++) {
                tx.updateInput(0, { unknown: undefined });
                tx.updateInput(0, {
                    unknown: [
                        ...(unknown ?? []),
                        [
                            { type: 0xfc, key: new Uint8Array([1]) },
                            new Uint8Array([nonce >>> 8, nonce & 255]),
                        ],
                    ],
                });
                await state.watcher.catchUp();
            }
            tx.updateInput(0, { unknown: undefined });
            tx.updateInput(0, { unknown });
            verify.mockImplementation(implementation).mockClear();
            await state.watcher.catchUp();
            expect(verify).toHaveBeenCalled();
            expect(state.advances.get(state.advance.id)?.failureCode).toBeUndefined();
        } finally {
            verify.mockImplementation(implementation);
            state.db.close();
        }
    }, 30_000);

    it("catches up a missed spend after a real SQLite restart", async () => {
        const directory = mkdtempSync(join(tmpdir(), "taxi-watcher-"));
        directories.push(directory);
        const path = join(directory, "taxi.sqlite");
        const first = await setup("refunded", path);
        const provider = {
            getVtxos: first.indexer.getVtxos,
            getVirtualTxs: first.indexer.getVirtualTxs,
        };
        first.db.close();
        const db: Database = openDatabase(path);
        const advances = new AdvanceRepository(db);
        const watcher = createSpendWatcher({
            advances,
            policy: new PolicyRepository(db),
            indexer: provider,
            config: config(),
            now: () => NOW + 20,
            tip: async () => ({ hash: "42".repeat(32), height: 700001, time: NOW + 1 }),
        });
        await watcher.catchUp();
        expect(advances.get(first.advance.id)).toMatchObject({
            state: "refunded",
            spentTxid: first.finalArk!.id,
        });
        db.close();
    });

    it.each([
        ["purchased", "purchased"],
        ["refunded", "refunded"],
        ["recovered", "recovered"],
    ] as const)(
        "classifies a missed locking %s spend after a real SQLite restart",
        async (kind, expected) => {
            const directory = mkdtempSync(join(tmpdir(), "taxi-locking-watcher-"));
            directories.push(directory);
            const path = join(directory, "taxi.sqlite");
            const first = await setup(kind, path, false, false);
            expect(first.advances.get(first.advance.id)?.state).toBe("locking");
            first.db.close();
            const db: Database = openDatabase(path);
            const advances = new AdvanceRepository(db);
            const reservations = new ReservationRepository(db);
            const watcher = createSpendWatcher({
                advances,
                policy: new PolicyRepository(db),
                indexer: first.indexer,
                config: config(),
                now: () => NOW + 20,
                tip: async () => ({ hash: "42".repeat(32), height: 900000, time: NOW + 1 }),
            });
            let observed: Advance | undefined;
            let reserved: ReturnType<ReservationRepository["listForAdvance"]>;
            try {
                await watcher.catchUp();
                observed = advances.get(first.advance.id);
                reserved = reservations.listForAdvance(first.advance.id);
            } finally {
                db.close();
            }
            expect(observed).toMatchObject({
                state: expected,
                spentTxid: first.finalArk!.id,
            });
            expect(reserved!).toEqual([]);
        },
    );

    it("quarantines a malformed locking spend after a real SQLite restart", async () => {
        const directory = mkdtempSync(join(tmpdir(), "taxi-locking-unknown-"));
        directories.push(directory);
        const path = join(directory, "taxi.sqlite");
        const first = await setup("purchased", path, false, false);
        first.finalArk!.updateInput(0, { tapScriptSig: undefined });
        first.db.close();
        const db: Database = openDatabase(path);
        const advances = new AdvanceRepository(db);
        const policy = new PolicyRepository(db);
        const reservations = new ReservationRepository(db);
        const watcher = createSpendWatcher({
            advances,
            policy,
            indexer: first.indexer,
            config: config(),
            now: () => NOW + 20,
            tip: async () => ({ hash: "42".repeat(32), height: 900000, time: NOW + 1 }),
        });
        let observed: Advance | undefined;
        let reserved: ReturnType<ReservationRepository["listForAdvance"]>;
        let paused = false;
        try {
            await watcher.catchUp();
            observed = advances.get(first.advance.id);
            reserved = reservations.listForAdvance(first.advance.id);
            paused = policy.get().paused;
        } finally {
            db.close();
        }
        expect(observed).toMatchObject({
            state: "locking",
            failureCode: "covenant_spend_unknown",
        });
        expect(reserved!).toEqual(first.advance.operatorInputs);
        expect(paused).toBe(true);
    });

    it.each(["recovered", "purchased", "recycled", "refunded"] as const)(
        "retries canonical %s when the sweeper wins the watcher CAS race",
        async (kind) => {
            const state = await setup(kind);
            let race = true;
            const watcher = createSpendWatcher({
                advances: {
                    byState: (advanceState) => state.advances.byState(advanceState),
                    recordSpendObservation: (...args) => {
                        if (race) {
                            race = false;
                            expect(
                                state.advances.claimRecovery(state.advance.id, NOW + 9),
                            ).toBeDefined();
                        }
                        return state.advances.recordSpendObservation(...args);
                    },
                    recordSpendUnknown: (...args) => state.advances.recordSpendUnknown(...args),
                    recordCovenantUnrolled: (...args) =>
                        state.advances.recordCovenantUnrolled(...args),
                    clearSpendUnknown: (...args) => state.advances.clearSpendUnknown(...args),
                    recordSpendDisagreement: (...args) =>
                        state.advances.recordSpendDisagreement(...args),
                    recordStableSpendObservation: (...args) =>
                        state.advances.recordStableSpendObservation(...args),
                },
                policy: state.policy,
                indexer: state.indexer,
                config: config(),
                now: () => NOW + 10,
                tip: async () => ({ hash: "49".repeat(32), height: 900000, time: NOW + 10 }),
            });
            await watcher.catchUp();
            expect(state.advances.get(state.advance.id)).toMatchObject({ state: "recovering" });
            expect(state.advances.get(state.advance.id)?.failureCode).toBeUndefined();
            expect(state.policy.get().paused).toBe(false);
            expect(state.reservations.listForAdvance(state.advance.id)).toEqual(
                state.advance.operatorInputs,
            );
            await watcher.catchUp();
            expect(state.advances.get(state.advance.id)).toMatchObject({
                state: kind,
                spentTxid: state.finalArk!.id,
            });
            expect(state.reservations.listForAdvance(state.advance.id)).toEqual([]);
            state.db.close();
        },
    );

    it("blocks a same-height disappearance until two stable canonical rescans", async () => {
        const state = await setup("purchased");
        await state.watcher.catchUp();
        const coin = state.coins.get(`${state.outpoint.txid}:${state.outpoint.vout}`)!;
        state.setTip({ hash: "43".repeat(32), height: 700000, time: NOW + 1 });
        state.coins.delete(`${state.outpoint.txid}:${state.outpoint.vout}`);
        await state.watcher.catchUp();
        expect(state.advances.get(state.advance.id)).toMatchObject({
            state: "purchased",
            failureCode: "covenant_observation_disagreement",
        });
        expect(state.watcher.status().blockers).toEqual([
            expect.objectContaining({
                advanceId: state.advance.id,
                code: "covenant_observation_disagreement",
            }),
        ]);
        state.coins.set(`${state.outpoint.txid}:${state.outpoint.vout}`, coin);
        await state.watcher.catchUp();
        expect(state.advances.get(state.advance.id)?.failureCode).toBe(
            "covenant_observation_disagreement",
        );
        await state.watcher.catchUp();
        expect(state.advances.get(state.advance.id)?.failureCode).toBeUndefined();
        expect(state.watcher.status().blockers).toEqual([]);
        state.db.close();
    });

    it("blocks a same-height tip replacement even while the spend remains visible", async () => {
        const state = await setup("purchased");
        await state.watcher.catchUp();
        state.setTip({ hash: "45".repeat(32), height: 700000, time: NOW + 1 });
        await state.watcher.catchUp();
        expect(state.advances.get(state.advance.id)).toMatchObject({
            state: "purchased",
            failureCode: "covenant_observation_disagreement",
            observationStableTipHash: "45".repeat(32),
            observationStableCount: 1,
        });
        await state.watcher.catchUp();
        expect(state.advances.get(state.advance.id)?.failureCode).toBeUndefined();
        state.db.close();
    });

    it("blocks a terminal observation when the current height falls below its persisted tip", async () => {
        const state = await setup("purchased");
        await state.watcher.catchUp();
        state.setTip({ hash: "47".repeat(32), height: 699999, time: NOW + 1 });
        await state.watcher.catchUp();
        expect(state.advances.get(state.advance.id)).toMatchObject({
            state: "purchased",
            failureCode: "covenant_observation_disagreement",
        });
        expect(state.policy.get().paused).toBe(true);
        state.db.close();
    });

    it("blocks a terminal row missing its persisted tip identity", async () => {
        const state = await setup("purchased");
        await state.watcher.catchUp();
        state.db
            .prepare(
                "UPDATE advances SET observation_tip_hash = NULL, observation_tip_height = NULL WHERE id = ?",
            )
            .run(state.advance.id);
        await state.watcher.catchUp();
        expect(state.advances.get(state.advance.id)).toMatchObject({
            state: "purchased",
            failureCode: "covenant_observation_disagreement",
        });
        state.db.close();
    });

    it("accepts a higher tip with a different hash when the exact spend remains canonical", async () => {
        const state = await setup("purchased");
        await state.watcher.catchUp();
        state.setTip({ hash: "48".repeat(32), height: 700001, time: NOW + 1 });
        await state.watcher.catchUp();
        expect(state.advances.get(state.advance.id)).toMatchObject({
            state: "purchased",
            observationTipHash: "48".repeat(32),
            observationTipHeight: 700001,
        });
        expect(state.advances.get(state.advance.id)?.failureCode).toBeUndefined();
        state.setTip({ hash: "4d".repeat(32), height: 700001, time: NOW + 2 });
        await state.watcher.catchUp();
        expect(state.advances.get(state.advance.id)).toMatchObject({
            state: "purchased",
            failureCode: "covenant_observation_disagreement",
        });
        state.db.close();
    });

    it("blocks a terminal observation when the canonical indexer fails", async () => {
        const state = await setup("purchased");
        await state.watcher.catchUp();
        state.indexer.getVtxos = async () => {
            throw new Error("offline");
        };
        await state.watcher.catchUp();
        expect(state.advances.get(state.advance.id)).toMatchObject({
            state: "purchased",
            failureCode: "covenant_observation_disagreement",
        });
        expect(state.policy.get().paused).toBe(true);
        state.db.close();
    });

    it("blocks a terminal row whose persisted covenant outpoint disappears", async () => {
        const state = await setup("purchased");
        await state.watcher.catchUp();
        state.db
            .prepare("UPDATE advances SET outpoint_txid = NULL, outpoint_vout = NULL WHERE id = ?")
            .run(state.advance.id);
        await state.watcher.catchUp();
        expect(state.advances.get(state.advance.id)).toMatchObject({
            state: "purchased",
            failureCode: "covenant_observation_disagreement",
        });
        expect(state.policy.get().paused).toBe(true);
        state.db.close();
    });

    it("keeps a settled recycle whose receiver funding coin is later swept", async () => {
        const state = await setup("recycled");
        await state.watcher.catchUp();
        const receiver = [...state.coins.entries()].find(
            ([key]) => key !== `${state.outpoint.txid}:${state.outpoint.vout}`,
        )![1];
        receiver.isSwept = true;
        state.setTip({ hash: "4e".repeat(32), height: 700001, time: NOW + 1 });
        await state.watcher.catchUp();
        expect(state.advances.get(state.advance.id)?.failureDetail).toBeUndefined();
        expect(state.advances.get(state.advance.id)).toMatchObject({
            state: "recycled",
            observationTipHeight: 700001,
        });
        expect(state.policy.get().paused).toBe(false);
        expect(state.watcher.status().blockers).toEqual([]);
        state.db.close();
    });

    it("scans once per start and leaves the wallet's watcher running after stop", async () => {
        const state = await setup("purchased");
        const sdk = await watcherWallet(state);
        const onPrompt = vi.fn(async () => watcher.catchUp());
        const watcher = createSpendWatcher({
            advances: state.advances,
            policy: state.policy,
            indexer: state.indexer,
            config: config(),
            now: () => NOW + 30,
            tip: async () => ({ hash: "44".repeat(32), height: 700002, time: NOW + 2 }),
            wallet: () => sdk.wallet,
            onPrompt,
        });
        try {
            await Promise.all([watcher.start(), watcher.start()]);
            expect(onPrompt).toHaveBeenCalledOnce();
            expect(state.advances.get(state.advance.id)).toMatchObject({ state: "purchased" });
            expect(await sdk.manager.getWatchedScripts()).toEqual([]);
            await watcher.start();
            expect(onPrompt).toHaveBeenCalledOnce();
            await Promise.all([watcher.stop(), watcher.stop()]);
            expect(await sdk.manager.isWatching()).toBe(true);
            await watcher.start();
            expect(onPrompt).toHaveBeenCalledTimes(2);
        } finally {
            await watcher.stop();
            sdk.manager.dispose();
            state.db.close();
        }
    });

    it("syncs live covenant registrations and rebinds without removing foreign watches", async () => {
        const state = await setup();
        const other = await setup(undefined, ":memory:", false, true, undefined, 700011n);
        const first = await watcherWallet(state);
        const second = await watcherWallet(state);
        const initialScript = state.coins.get(`${state.outpoint.txid}:0`)!.script;
        const addedScript = other.coins.get(`${other.outpoint.txid}:0`)!.script;
        const foreignScript = hex.encode(operatorTree.pkScript);
        await first.manager.watchScript(initialScript, { label: "existing-owner" });
        await second.manager.watchScript(foreignScript, { label: "wallet-owner" });
        let wallet = first.wallet;
        const watcher = createSpendWatcher({
            advances: state.advances,
            policy: state.policy,
            indexer: state.indexer,
            config: config(),
            now: () => NOW + 30,
            tip: async () => ({ hash: "44".repeat(32), height: 700002, time: NOW + 2 }),
            wallet: () => wallet,
        });
        try {
            await watcher.start();
            const added = { ...other.advances.get(other.advance.id)!, id: "added-covenant" };
            state.advances.insert(added);
            for (const [key, coin] of other.coins) state.coins.set(key, coin);
            for (const [key, tx] of other.txs) state.txs.set(key, tx);
            await watcher.catchUp();
            await vi.waitFor(async () =>
                expect(await first.manager.getWatchedScripts()).toEqual([
                    { script: initialScript, label: "existing-owner" },
                    { script: addedScript, label: "taxi-covenant" },
                ]),
            );
            state.advances.update({ ...added, state: "expired" });
            await watcher.catchUp();
            await vi.waitFor(async () =>
                expect(await first.manager.getWatchedScripts()).toEqual([
                    { script: initialScript, label: "existing-owner" },
                ]),
            );
            state.advances.update({ ...added, covenantAddress: "invalid-address" });
            await watcher.catchUp();
            expect(state.advances.get(added.id)?.failureCode).toBe("covenant_spend_unknown");
            await vi.waitFor(async () =>
                expect(await first.manager.getWatchedScripts()).toHaveLength(1),
            );
            state.advances.update(added);
            await watcher.catchUp();
            wallet = second.wallet;
            await watcher.catchUp();
            await vi.waitFor(async () =>
                expect(await first.manager.getWatchedScripts()).toEqual([
                    { script: initialScript, label: "existing-owner" },
                ]),
            );
            await vi.waitFor(async () =>
                expect(await second.manager.getWatchedScripts()).toHaveLength(3),
            );
            await second.manager.watchScript(addedScript, { label: "later-owner" });
            await watcher.stop();
            expect(await second.manager.getWatchedScripts()).toEqual([
                { script: foreignScript, label: "wallet-owner" },
                { script: addedScript, label: "later-owner" },
            ]);
            expect(await first.manager.isWatching()).toBe(true);
        } finally {
            await watcher.stop();
            first.manager.dispose();
            second.manager.dispose();
            state.db.close();
            other.db.close();
        }
    });

    it("keeps canonical scans and stop independent of a pending wallet manager", async () => {
        const state = await setup();
        const sdk = await watcherWallet(state);
        let release!: (manager: ContractManager) => void;
        const held = new Promise<ContractManager>((resolve) => (release = resolve));
        const getManager = vi.spyOn(sdk.wallet, "getContractManager").mockReturnValueOnce(held);
        const watcher = createSpendWatcher({
            advances: state.advances,
            policy: state.policy,
            indexer: state.indexer,
            config: config(),
            now: () => NOW + 30,
            tip: async () => ({ hash: "44".repeat(32), height: 700002, time: NOW + 2 }),
            wallet: () => sdk.wallet,
        });
        try {
            await watcher.start();
            await vi.waitFor(() => expect(getManager).toHaveBeenCalledOnce());
            await watcher.catchUp();
            expect(watcher.status().lastScanAt).toBe(NOW + 30);
            await watcher.stop();
            release(sdk.manager);
            await held;
            expect(await sdk.manager.getWatchedScripts()).toEqual([]);
            await watcher.start();
            await vi.waitFor(async () =>
                expect(await sdk.manager.getWatchedScripts()).toHaveLength(1),
            );
        } finally {
            release(sdk.manager);
            await watcher.stop();
            sdk.manager.dispose();
            state.db.close();
        }
    });

    it("drains an in-flight SDK subscription before removing owned scripts", async () => {
        const state = await setup();
        const sdk = await watcherWallet(state);
        const covenantScript = state.coins.get(`${state.outpoint.txid}:0`)!.script;
        const foreignScript = hex.encode(operatorTree.pkScript);
        let release!: () => void;
        const held = new Promise<void>((resolve) => (release = resolve));
        let remoteScripts: string[] = [];
        const subscribe = vi
            .spyOn(sdk.indexer as unknown as IndexerProvider, "subscribeForScripts")
            .mockImplementation(async (scripts) => {
                if (scripts.includes(covenantScript)) await held;
                remoteScripts = [...scripts];
                return "taxi-test-subscription";
            });
        await sdk.manager.watchScript(foreignScript, { label: "wallet-owner" });
        const watcher = createSpendWatcher({
            advances: state.advances,
            policy: state.policy,
            indexer: state.indexer,
            config: config(),
            now: () => NOW + 30,
            tip: async () => ({ hash: "44".repeat(32), height: 700002, time: NOW + 2 }),
            wallet: () => sdk.wallet,
        });
        let stopped = false;
        let stopping: Promise<void> | undefined;
        try {
            await watcher.start();
            await vi.waitFor(() =>
                expect(subscribe).toHaveBeenCalledWith(
                    expect.arrayContaining([covenantScript]),
                    "taxi-test-subscription",
                ),
            );
            stopping = watcher.stop().then(() => {
                stopped = true;
            });
            await new Promise<void>((resolve) => setImmediate(resolve));
            expect(stopped).toBe(false);
            release();
            await stopping;
            expect(await sdk.manager.getWatchedScripts()).toEqual([
                { script: foreignScript, label: "wallet-owner" },
            ]);
            expect(remoteScripts).toEqual([foreignScript]);
            expect(await sdk.manager.isWatching()).toBe(true);
        } finally {
            release();
            await stopping;
            await watcher.stop();
            sdk.manager.dispose();
            state.db.close();
        }
    });
    it("removes owned scripts even when an in-flight canonical scan rejects", async () => {
        const state = await setup();
        const sdk = await watcherWallet(state);
        const watcher = createSpendWatcher({
            advances: state.advances,
            policy: state.policy,
            indexer: state.indexer,
            config: config(),
            now: () => NOW + 30,
            tip: async () => ({ hash: "44".repeat(32), height: 700002, time: NOW + 2 }),
            wallet: () => sdk.wallet,
        });
        try {
            await watcher.start();
            await vi.waitFor(async () =>
                expect(await sdk.manager.getWatchedScripts()).toHaveLength(1),
            );
            await watcher.catchUp();
            await new Promise<void>((resolve) => setImmediate(resolve));
            vi.spyOn(state.advances, "byState").mockImplementation(() => {
                throw new Error("database unavailable");
            });
            const results = await Promise.allSettled([watcher.catchUp(), watcher.stop()]);
            expect(results).toEqual([
                {
                    status: "rejected",
                    reason: expect.objectContaining({ message: "database unavailable" }),
                },
                {
                    status: "rejected",
                    reason: expect.objectContaining({ message: "database unavailable" }),
                },
            ]);
            expect(await sdk.manager.getWatchedScripts()).toEqual([]);
            expect(await sdk.manager.isWatching()).toBe(true);
        } finally {
            await watcher.stop();
            sdk.manager.dispose();
            state.db.close();
        }
    });

    it("uses SDK stream and failsafe deltas only to prompt canonical spend verification", async () => {
        const state = await setup();
        const spent = await setup("purchased");
        const sdk = await watcherWallet(state);
        const events = vi.fn();
        const unsubscribe = sdk.manager.onContractEvent(events);
        const onPrompt = vi.fn(async () => watcher.catchUp());
        const watcher = createSpendWatcher({
            advances: state.advances,
            policy: state.policy,
            indexer: state.indexer,
            config: config(),
            now: () => NOW + 30,
            tip: async () => ({ hash: "44".repeat(32), height: 700002, time: NOW + 2 }),
            wallet: () => sdk.wallet,
            onPrompt,
        });
        try {
            await watcher.start();
            const cached = state.coins.get(`${state.outpoint.txid}:0`)!;
            await sdk.emit({
                scripts: [cached.script],
                newVtxos: [],
                spentVtxos: [cached],
                sweptVtxos: [],
            });
            await vi.waitFor(() =>
                expect(events).toHaveBeenCalledWith(
                    expect.objectContaining({ type: "vtxo_spent" }),
                ),
            );
            await watcher.catchUp();
            expect(state.advances.get(state.advance.id)).toMatchObject({
                state: "locked",
            });
            expect(state.advances.get(state.advance.id)?.failureCode).toBeUndefined();
            events.mockClear();
            sdk.setSpendableView(false);
            await vi.waitFor(() =>
                expect(events).toHaveBeenCalledWith(
                    expect.objectContaining({ type: "vtxo_spent" }),
                ),
            );
            await watcher.catchUp();
            expect(state.advances.get(state.advance.id)).toMatchObject({
                state: "locked",
            });
            expect(state.advances.get(state.advance.id)?.failureCode).toBeUndefined();
            sdk.setSpendableView(true);
            await vi.waitFor(() =>
                expect(events).toHaveBeenCalledWith(
                    expect.objectContaining({ type: "vtxo_received" }),
                ),
            );
            for (const [key, coin] of spent.coins) state.coins.set(key, coin);
            for (const [key, tx] of spent.txs) state.txs.set(key, tx);
            await vi.waitFor(() =>
                expect(state.advances.get(state.advance.id)?.state).toBe("purchased"),
            );
            expect(onPrompt.mock.calls.length).toBeGreaterThan(3);
            await vi.waitFor(async () => expect(await sdk.manager.getWatchedScripts()).toEqual([]));
        } finally {
            await watcher.stop();
            unsubscribe();
            sdk.manager.dispose();
            state.db.close();
            spent.db.close();
        }
    });
});

describe("proceeds of a receiver-paid recycle", () => {
    it.each([
        ["7 sats", { currency: "sats", units: 7n }],
        ["9 asset units", { currency: "asset", units: 9n }],
        ["zero", { currency: "sats", units: 0n }],
    ] as const)("collects the operator's repayment for a fare of %s", async (_, fare) => {
        const cfg = config({ operatorKey: operatorTree.tweakedPublicKey, addressHrp: "tark" });
        const state = await setup(
            "recycled",
            ":memory:",
            true,
            true,
            undefined,
            undefined,
            undefined,
            undefined,
            "recycle",
            "receiver",
            fare,
            cfg,
        );
        await state.watcher.catchUp();
        const repaid = state.finalArk!.getOutput(0);
        const assets = Extension.fromTx(state.finalArk!)
            .getAssetPacket()!
            .groups.flatMap((group) =>
                group.outputs
                    .filter(({ vout }) => vout === 0)
                    .map(({ amount }) => ({ assetId: group.assetId!.toString(), amount })),
            );
        // Expired, as it must be to reach proceeds: funding never spends an asset-carrying coin.
        const repayment = fundingCoin({
            txid: state.finalArk!.id,
            value: Number(repaid.amount),
            isSwept: true,
            assets,
        });
        expect(repayment.script).toBe(hex.encode(repaid.script!));
        state.coins.set(`${repayment.txid}:0`, repayment);
        const address = new ArkAddress(cfg.serverPubkey, cfg.operatorKey, cfg.addressHrp).encode();
        const info = arkInfo({ fees: { intentFee: {}, txFeeRate: "0" } });
        const tip = { hash: "41".repeat(32), height: 700000, time: NOW };
        let owned = [repayment];
        const settle = vi.fn(async (_params: unknown) => "cc".repeat(32));
        const wallet = {
            getAddress: async () => address,
            getSpendableVtxos: async () => owned,
            arkProvider: { getInfo: async () => info },
            onchainProvider: { getChainTip: async () => tip },
            settle,
        };
        const jobs = new ProceedsRepository(state.db);
        const collector = createProceedsCollector({
            config: cfg,
            runtime: {
                wallet,
                assertRecovery: async () => {},
                providers: {
                    arkProvider: wallet.arkProvider,
                    emulatorProvider: {
                        getInfo: async () => ({ signerPubkey: hex.encode(providerEmulatorKey) }),
                    },
                    indexerProvider: state.indexer,
                },
                storage: {
                    intentRepository: {
                        getIntents: async () => [],
                        getLockedVtxoOutpoints: async () => [],
                    },
                },
                withSettlement: async (work: (w: typeof wallet) => Promise<void>) => work(wallet),
            },
            advances: state.advances,
            reservations: state.reservations,
            jobs,
            now: () => NOW,
        } as unknown as Parameters<typeof createProceedsCollector>[0]);
        await collector.tick();
        expect(collector.status().blocker).toBe("proceeds_output_pending");
        expect(settle).toHaveBeenCalledExactlyOnceWith({
            inputs: [repayment],
            outputs: [{ address, amount: repaid.amount }],
        });
        state.coins.set(`${repayment.txid}:0`, {
            ...repayment,
            isSpent: true,
            settledBy: "cc".repeat(32),
        });
        owned = [
            fundingCoin({
                txid: "dd".repeat(32),
                value: Number(repaid.amount),
                commitmentTxIds: ["cc".repeat(32)],
                assets,
            }),
        ];
        await collector.tick();
        expect(jobs.active()).toBeUndefined();
        expect(collector.status().blocker).toBeNull();
        state.db.close();
    });
});

type WatcherDeps = Parameters<typeof createSpendWatcher>[0];
type ScanMetrics = Parameters<NonNullable<WatcherDeps["onScanMetrics"]>>[0];

const canonicalTip = { hash: "41".repeat(32), height: 700000, time: NOW };

describe("canonical scan round trips", () => {
    it("reports one scan's indexer round trips", async () => {
        const state = await setup("purchased");
        const observed: ScanMetrics[] = [];
        const watcher = createSpendWatcher({
            advances: state.advances,
            policy: state.policy,
            indexer: state.indexer,
            config: config(),
            now: () => NOW + 10,
            tip: async () => canonicalTip,
            onScanMetrics: (metrics) => void observed.push(metrics),
        });
        await watcher.catchUp();
        expect(observed).toHaveLength(1);
        expect(observed[0]).toMatchObject({
            watching: 1,
            getVtxos: 1,
            getVirtualTxs: 1,
            outpoints: 1,
            txids: 2,
        });
        expect(observed[0]!.elapsedMs).toBeGreaterThanOrEqual(0);
        state.db.close();
    });

    it("reports a scan the canonical tip aborted", async () => {
        const state = await setup("purchased");
        const observed: ScanMetrics[] = [];
        const watcher = createSpendWatcher({
            advances: state.advances,
            policy: state.policy,
            indexer: state.indexer,
            config: config(),
            now: () => NOW + 10,
            tip: async () => {
                throw new Error("canonical tip unavailable");
            },
            onScanMetrics: (metrics) => void observed.push(metrics),
        });
        await watcher.catchUp();
        expect(observed).toHaveLength(1);
        expect(observed[0]).toMatchObject({ watching: 1, getVtxos: 0, getVirtualTxs: 0 });
        expect(state.policy.get().paused).toBe(true);
        state.db.close();
    });
});
