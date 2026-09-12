import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
    EmulatorPacket,
    Extension,
    MultisigTapscript,
    P2A,
    SingleKey,
    Transaction,
    UnknownPacket,
    VtxoScript,
    asset,
    buildOffchainTx,
    type IndexerProvider,
    type VirtualCoin,
} from "@arkade-os/sdk";
import { arkade } from "@arkade-os/sdk";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { base64, hex } from "@scure/base";
import {
    DustCovenantScript,
    Leaf,
    covenantSpendInput,
    payoutPkScript,
    refundTopup,
} from "@arkade-taxi/covenant";
import {
    AdvanceRepository,
    PolicyRepository,
    ReservationRepository,
    openDatabase,
    type Database,
} from "@arkade-taxi/db";
import type { Advance, AdvanceState } from "@arkade-taxi/core";
import { buildLockupEnvelope } from "../src/arkade/lockupBuilder.js";
import { decodeLockupEnvelope } from "../src/arkade/psbt.js";
import { createSpendWatcher } from "../src/watcher.js";
import { buildRecoveryIntent, createRecoveryRunner } from "../src/arkade/recovery.js";
import { config, fundingCoin, NOW, policy as basePolicy, serverKey } from "./fixtures.js";
import { buildRequest, unroll } from "./arkade/lockupFixtures.js";

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
) {
    const receiverOwner = await receiverIdentity.xOnlyPublicKey();
    const receiverTree = new VtxoScript([
        receiverLeaf ?? MultisigTapscript.encode({ pubkeys: [serverKey, receiverOwner] }).script,
    ]);
    const request = buildRequest();
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
    const covenant = new DustCovenantScript({
        params: request.params,
        serverKey: config().serverPubkey,
        emulatorKey: config().emulatorPubkey,
        vtxoMinAmount: config().vtxoMinAmount,
    });
    request.covenantAddress = covenant.address("ark", config().serverPubkey).encode();
    const unsignedLockupTx = buildLockupEnvelope(request, config(), unroll);
    const envelope = decodeLockupEnvelope(unsignedLockupTx);
    const lockup = Transaction.fromPSBT(base64.decode(envelope.arkTx));
    const advance: Advance = {
        id: request.advanceId,
        state: "quoted",
        ...request.params,
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
    const advances = new AdvanceRepository(db);
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
        const inputs = [
            covenantSpendInput(covenant, leaf, outpoint, request.params.dust, covenantPacket),
        ];
        const destination = new Uint8Array([0x51, 0x20, ...request.params.receiverKey]);
        let outputs: { script: Uint8Array; amount: bigint }[];
        let receiverSource: Transaction | undefined;
        if (kind === "purchased") {
            outputs = [{ script: destination, amount: request.params.dust }];
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
                        request.params.topup,
                        request.params.dust,
                    ),
                    amount: request.params.topup,
                },
                {
                    script: destination,
                    amount: request.params.dust + 500n - request.params.topup,
                },
            ];
        } else {
            const topup = refundTopup(request.params, config().vtxoMinAmount);
            outputs = [
                {
                    script: payoutPkScript(request.params.operatorKey, topup, request.params.dust),
                    amount: topup,
                },
                {
                    script: payoutPkScript(
                        request.params.senderKey,
                        request.params.dust - topup,
                        request.params.dust,
                    ),
                    amount: request.params.dust - topup,
                },
            ];
        }
        const emulatorScript =
            covenant.covenant[
                leaf === Leaf.Recycle ? "recycle" : leaf === Leaf.Purchase ? "purchase" : "refund"
            ];
        const spendPacket = paymentAsset
            ? asset.Packet.create([
                  asset.AssetGroup.create(
                      paymentAsset,
                      null,
                      [asset.AssetInput.create(0, paymentUnits)],
                      [asset.AssetOutput.create(kind === "purchased" ? 0 : 1, paymentUnits)],
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
        if (kind === "recycled" && hex.encode(receiverOwner) !== hex.encode(serverKey))
            ark = await receiverIdentity.sign(ark, [1]);
        const checkpoints = await Promise.all(
            graph.checkpoints.map(async (checkpoint, index) => {
                let signed = await serverIdentity.sign(checkpoint, [0]);
                if (index === 0) signed = await emulatorIdentity(emulatorScript).sign(signed, [0]);
                if (index === 0 && kind === "refunded")
                    signed = await senderIdentity.sign(signed, [0]);
                if (
                    index === 1 &&
                    kind === "recycled" &&
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
                value: Number(request.params.dust),
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
                value: Number(request.params.dust),
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
        config: config(),
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

    it.each(["script", "value", "assets", "swept", "unrolled", "spentBy", "missing"])(
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
            else if (field === "unrolled") coin.isUnrolled = true;
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
            "swept status",
            (coin) => {
                coin.isSwept = true;
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

    it("uses duplicate stream events only as polling prompts and aborts cleanly", async () => {
        const state = await setup("purchased");
        let streamAborted = false;
        let events = 0;
        const watcher = createSpendWatcher({
            advances: state.advances,
            policy: state.policy,
            indexer: state.indexer,
            config: config(),
            now: () => NOW + 30,
            tip: async () => ({ hash: "44".repeat(32), height: 700002, time: NOW + 2 }),
            arkProvider: {
                getTransactionsStream(signal) {
                    return (async function* () {
                        try {
                            yield {};
                            yield {};
                            await new Promise<void>((resolve) =>
                                signal.addEventListener("abort", () => resolve(), { once: true }),
                            );
                        } finally {
                            streamAborted = signal.aborted;
                        }
                    })();
                },
            },
            onPrompt: async () => {
                events++;
                await watcher.catchUp();
            },
            sleep: async () => {},
        });
        await watcher.start();
        await vi.waitFor(() => expect(events).toBeGreaterThanOrEqual(3));
        expect(state.advances.get(state.advance.id)).toMatchObject({ state: "purchased" });
        await watcher.stop();
        expect(streamAborted).toBe(true);
        expect(watcher.status().blockers).not.toContainEqual(
            expect.objectContaining({ code: "transaction_stream_disconnected" }),
        );
        state.db.close();
    });

    it("reconnects a gracefully completed stream and preserves health beside scan blockers", async () => {
        const state = await setup();
        let connections = 0;
        let tipOffline = false;
        const sleeps: number[] = [];
        const watcher = createSpendWatcher({
            advances: state.advances,
            policy: state.policy,
            indexer: state.indexer,
            config: config(),
            now: () => NOW + 30,
            tip: async () => {
                if (tipOffline) throw new Error("offline");
                return { hash: "4c".repeat(32), height: 700002, time: NOW + 2 };
            },
            arkProvider: {
                getTransactionsStream(signal) {
                    connections++;
                    if (connections === 1)
                        return (async function* () {
                            return;
                        })();
                    return (async function* () {
                        await new Promise<void>((resolve) =>
                            signal.addEventListener("abort", () => resolve(), { once: true }),
                        );
                    })();
                },
            },
            sleep: async (milliseconds) => {
                sleeps.push(milliseconds);
            },
        });
        await watcher.start();
        await vi.waitFor(() => expect(connections).toBe(2));
        expect(sleeps).toEqual([250]);
        expect(watcher.status().blockers).toContainEqual({
            code: "transaction_stream_disconnected",
            detail: "Arkade transaction stream disconnected; polling remains authoritative",
        });
        tipOffline = true;
        await watcher.catchUp();
        expect(watcher.status().blockers.map(({ code }) => code)).toEqual([
            "canonical_tip_unavailable",
            "transaction_stream_disconnected",
        ]);
        await watcher.stop();
        state.db.close();
    });
});
