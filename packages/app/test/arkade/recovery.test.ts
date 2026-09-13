import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
    CSVMultisigTapscript,
    Extension,
    P2A,
    PrevArkTxField,
    SingleKey,
    Transaction,
    asset,
    arkade,
    getArkPsbtFields,
    type EmulatorProvider,
} from "@arkade-os/sdk";
import { base64 } from "@scure/base";
import { hex } from "@scure/base";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { DustCovenantScript, payoutPkScript, refundTopup } from "@arkade-taxi/covenant";
import { AdvanceRepository, openDatabase, PolicyRepository, type Database } from "@arkade-taxi/db";
import { fundingInputToWire } from "@arkade-taxi/protocol";
import type { Advance } from "@arkade-taxi/core";
import {
    advance,
    config,
    emulatorKey,
    fundingCoin,
    operatorTree,
    NOW,
    senderTree,
    serverKey,
    serverUnroll,
} from "../fixtures.js";
import { buildLockupEnvelope, operatorFundingInput } from "../../src/arkade/lockupBuilder.js";
import {
    decodeLockupEnvelope,
    encodeLockupEnvelope,
    unsignedGraphId,
} from "../../src/arkade/psbt.js";
import {
    assertRecoveryStartupInvariants,
    buildRecoveryIntent,
    createRecoveryRunner,
    type RecoveryIntent,
} from "../../src/arkade/recovery.js";

const directories: string[] = [];
const databases: Database[] = [];
afterEach(() => {
    for (const database of databases.splice(0)) if (database.open) database.close();
    for (const directory of directories.splice(0))
        rmSync(directory, { recursive: true, force: true });
});

const sourceAdvance = (kind: "height" | "time" = "height", withAsset = false) => {
    const locktime = kind === "height" ? 850_000n : 1_757_000_000n;
    const cfg = config();
    const sdkAsset = withAsset ? asset.AssetId.create("12".repeat(32), 7) : undefined;
    const assetId = sdkAsset
        ? { txid: Uint8Array.from(sdkAsset.txid).reverse(), groupIndex: sdkAsset.groupIndex }
        : undefined;
    const base = advance({
        fare: { currency: "sats", units: 10n },
        ...(assetId ? { assetId } : {}),
    });
    const script = new DustCovenantScript({
        serverKey: cfg.serverPubkey,
        emulatorKey: cfg.emulatorPubkey,
        vtxoMinAmount: cfg.vtxoMinAmount,
        params: {
            receiverKey: base.receiverKey,
            senderKey: base.senderKey,
            operatorKey: base.operatorKey,
            dust: base.dust,
            topup: base.topup,
            locktime,
            ...(assetId ? { assetId } : {}),
        },
    });
    const expiry = locktime + (kind === "height" ? 100n : 10_000n);
    const expiryFields =
        kind === "height"
            ? { expiresAtHeight: Number(expiry), expiresAt: undefined }
            : { expiresAtHeight: undefined, expiresAt: new Date(Number(expiry) * 1000) };
    const senderInput = operatorFundingInput(
        fundingCoin({
            txid: "11".repeat(32),
            value: 20,
            script: hex.encode(senderTree.pkScript),
            tapTree: senderTree.encode(),
            forfeitTapLeafScript: senderTree.leaves[0],
            intentTapLeafScript: senderTree.leaves[0],
            ...expiryFields,
        }),
    );
    if (sdkAsset)
        senderInput.assetPacket = asset.Packet.create([
            asset.AssetGroup.create(
                sdkAsset,
                null,
                [],
                [asset.AssetOutput.create(senderInput.vout, 9_007_199_254_740_993n)],
                [],
            ),
        ]).serialize();
    const operatorCoin = fundingCoin({ ...expiryFields });
    let unsignedLockupTx = "";
    if (!sdkAsset)
        unsignedLockupTx = buildLockupEnvelope(
            {
                advanceId: `recovery-${kind}`,
                senderInputs: [senderInput],
                senderSats: senderInput.value,
                ...(sdkAsset ? { assetUnits: 9_007_199_254_740_993n } : {}),
                funding: {
                    inputs: [operatorCoin],
                    totalValue: BigInt(operatorCoin.value),
                    batchExpiry: { kind, value: expiry },
                },
                params: {
                    receiverKey: base.receiverKey,
                    senderKey: base.senderKey,
                    operatorKey: base.operatorKey,
                    dust: base.dust,
                    topup: base.topup,
                    locktime,
                    ...(assetId ? { assetId } : {}),
                },
                covenantAddress: script.address(cfg.addressHrp, cfg.serverPubkey).encode(),
                fare: base.fare,
            },
            cfg,
            serverUnroll,
        );
    if (sdkAsset) {
        const source = new Transaction({ version: 3, lockTime: 0 });
        source.addInput({ txid: "11".repeat(32), index: 0, sequence: 0xffffffff });
        source.addOutput({ amount: base.dust, script: script.pkScript });
        source.addOutput({
            amount: base.fare.units,
            script: payoutPkScript(base.operatorKey, base.fare.units, base.dust),
        });
        source.addOutput(
            Extension.create([
                asset.Packet.create([
                    asset.AssetGroup.create(
                        sdkAsset,
                        null,
                        [],
                        [asset.AssetOutput.create(0, 9_007_199_254_740_993n)],
                        [],
                    ),
                ]),
            ]).txOut(),
        );
        source.addOutput(P2A);
        unsignedLockupTx = base64.encode(
            new TextEncoder().encode(
                JSON.stringify({
                    arkTx: base64.encode(source.toPSBT()),
                    checkpoints: [],
                    senderInputs: [fundingInputToWire(senderInput)],
                    operatorInputs: [fundingInputToWire(operatorFundingInput(operatorCoin))],
                    serverUnrollScript: hex.encode(serverUnroll.script),
                    unsignedTxId: unsignedGraphId(source, []),
                    covenantOutputIndex: 0,
                    senderInputIndexes: [0],
                    operatorInputIndexes: [1],
                    assetUnits: "9007199254740993",
                }),
            ),
        );
    }
    const envelope = decodeLockupEnvelope(unsignedLockupTx);
    const source = Transaction.fromPSBT(base64.decode(envelope.arkTx));
    return advance({
        id: `recovery-${kind}`,
        ...(assetId ? { assetId } : {}),
        fare: base.fare,
        locktime,
        recoveryLocktime: { kind, value: locktime },
        batchExpiry: {
            kind,
            value: expiry,
        },
        covenantAddress: script.address(cfg.addressHrp, cfg.serverPubkey).encode(),
        unsignedLockupTx,
        unsignedLockupId: envelope.unsignedTxId,
        operatorInputs: [{ txid: operatorCoin.txid, vout: operatorCoin.vout }],
        outpoint: { txid: source.id, vout: 0 },
    });
};

const dbFile = () => {
    const directory = mkdtempSync(join(tmpdir(), "taxi-recovery-"));
    directories.push(directory);
    return join(directory, "taxi.db");
};
const open = (path: string) => {
    const database = openDatabase(path);
    databases.push(database);
    return database;
};

const digest = (intent: RecoveryIntent) =>
    createHash("sha256")
        .update(JSON.stringify({ arkTx: intent.arkTx, checkpoints: intent.checkpoints }))
        .digest("hex");

const mutateLockupGraph = (
    row: ReturnType<typeof sourceAdvance>,
    mutate: (arkTx: Transaction, checkpoints: Transaction[], operatorInputIndex: number) => void,
) => {
    const envelope = decodeLockupEnvelope(row.unsignedLockupTx);
    const arkTx = Transaction.fromPSBT(base64.decode(envelope.arkTx));
    const checkpoints = envelope.checkpoints.map((checkpoint) =>
        Transaction.fromPSBT(base64.decode(checkpoint)),
    );
    mutate(arkTx, checkpoints, envelope.operatorInputIndexes[0]!);
    const unsignedLockupId = unsignedGraphId(arkTx, checkpoints);
    return {
        ...row,
        unsignedLockupId,
        unsignedLockupTx: encodeLockupEnvelope({
            ...envelope,
            arkTx: base64.encode(arkTx.toPSBT()),
            checkpoints: checkpoints.map((checkpoint) => base64.encode(checkpoint.toPSBT())),
            unsignedTxId: unsignedLockupId,
        }),
        outpoint: { txid: arkTx.id, vout: envelope.covenantOutputIndex },
    };
};

const preparedRecovery = (row = sourceAdvance()): Advance => {
    const intent = buildRecoveryIntent(row, config());
    return {
        ...row,
        state: "recovering",
        recoveryPhase: "prepared",
        recoveryGraphDigest: intent.digest,
        recoveryExpectedTxid: intent.expectedTxid,
        recoveryPreparedArkTx: intent.arkTx,
        recoveryPreparedCheckpoints: intent.checkpoints,
    };
};

const submittedRecovery = async (row = sourceAdvance()): Promise<Advance> => {
    const prepared = preparedRecovery(row);
    const response = await signingEmulator().submitTx(
        prepared.recoveryPreparedArkTx!,
        prepared.recoveryPreparedCheckpoints!,
    );
    return {
        ...prepared,
        recoveryPhase: "submitted",
        recoveryResponseArkTx: response.signedArkTx,
        recoveryResponseCheckpoints: response.signedCheckpointTxs,
        recoveryTxid: prepared.recoveryExpectedTxid,
        recoverySubmittedAt: row.updatedAt,
    };
};

type AttemptPhase = "prepared" | "failed-before-prepare" | "failed-after-prepare" | "submitted";

const attemptedRecovery = async (phase: AttemptPhase): Promise<Advance> => {
    const failure = {
        recoveryAttempts: 1,
        recoveryLastAttemptAt: NOW,
        failureCode: "recovery_artifact_invalid",
        failureDetail: "retained",
    };
    if (phase === "prepared")
        return {
            ...preparedRecovery(),
            ...failure,
            recoveryNextAttemptAt: Number.MAX_SAFE_INTEGER,
        };
    if (phase === "submitted")
        return {
            ...(await submittedRecovery()),
            recoveryAttempts: 1,
            recoveryLastAttemptAt: NOW,
        };
    return {
        ...(phase === "failed-after-prepare" ? preparedRecovery() : sourceAdvance()),
        state: "recovering",
        recoveryPhase: "failed",
        ...failure,
    };
};

const startupError = (row: Advance): string | undefined => {
    try {
        assertRecoveryStartupInvariants([row], config());
        return undefined;
    } catch (cause) {
        return cause instanceof Error ? cause.message : String(cause);
    }
};

describe("recovery graph", () => {
    it.each([
        ["height", 850_000n],
        ["time", 1_757_000_000n],
    ] as const)("builds the exact %s recovery leaf graph", (kind, locktime) => {
        const row = sourceAdvance(kind);
        const intent = buildRecoveryIntent(row, config());
        const arkTx = Transaction.fromPSBT(base64.decode(intent.arkTx));
        const checkpoint = Transaction.fromPSBT(base64.decode(intent.checkpoints[0]!));
        const topup = refundTopup(row, config().vtxoMinAmount);

        expect(arkTx.lockTime).toBe(Number(locktime));
        expect(checkpoint.lockTime).toBe(Number(locktime));
        expect(arkTx.getInput(0).sequence).toBe(0xfffffffe);
        expect(arkTx.getOutput(0)).toEqual({
            amount: topup,
            script: payoutPkScript(row.operatorKey, topup, row.dust),
        });
        expect(arkTx.getOutput(1)).toEqual({
            amount: row.dust - topup,
            script: payoutPkScript(row.senderKey, row.dust - topup, row.dust),
        });
        expect(Extension.fromTx(arkTx).getEmulatorPacket()?.entries).toMatchObject([{ vin: 0 }]);
        expect(arkTx.getOutput(3)).toEqual(P2A);
        expect(getArkPsbtFields(arkTx, 0, PrevArkTxField)).toHaveLength(1);
        expect(intent.expectedTxid).toBe(arkTx.id);
        expect(intent.digest).toBe(digest(intent));
    });

    it("moves the exact persisted asset units to the sender receipt", () => {
        const intent = buildRecoveryIntent(sourceAdvance("height", true), config());
        const packet = Extension.fromTx(
            Transaction.fromPSBT(base64.decode(intent.arkTx)),
        ).getAssetPacket()!.groups[0]!;

        expect(packet.inputs.map((input) => [input.vin, input.amount])).toEqual([
            [0, 9_007_199_254_740_993n],
        ]);
        expect(packet.outputs.map((output) => [output.vout, output.amount])).toEqual([
            [1, 9_007_199_254_740_993n],
        ]);
    });

    it("rejects drift in persisted operator funding and fare facts", () => {
        const row = sourceAdvance();
        expect(() =>
            buildRecoveryIntent(
                { ...row, operatorInputs: [{ txid: "ff".repeat(32), vout: 0 }] },
                config(),
            ),
        ).toThrow(/operator funding/);
        expect(() =>
            buildRecoveryIntent({ ...row, fare: { currency: "sats", units: 11n } }, config()),
        ).toThrow(/fare/);
    });

    it("rejects a persisted unsigned graph id that does not commit to the graph", () => {
        const row = sourceAdvance();
        const envelope = decodeLockupEnvelope(row.unsignedLockupTx);
        const unsignedLockupId = "ff".repeat(32);
        expect(() =>
            buildRecoveryIntent(
                {
                    ...row,
                    unsignedLockupId,
                    unsignedLockupTx: encodeLockupEnvelope({
                        ...envelope,
                        unsignedTxId: unsignedLockupId,
                    }),
                },
                config(),
            ),
        ).toThrow(/unsigned graph/);
    });
});

describe("startup recovery invariant", () => {
    it("fails closed on persisted quotes bound to a different operator payout after restart", () => {
        const db = openDatabase(":memory:");
        databases.push(db);
        const advances = new AdvanceRepository(db);
        const row = sourceAdvance();
        advances.insert(row);
        const persisted = advances.get(row.id)!;
        expect(() => assertRecoveryStartupInvariants([persisted], config())).not.toThrow();
        expect(() =>
            assertRecoveryStartupInvariants(
                [persisted],
                config({ operatorKey: operatorTree.tweakedPublicKey }),
            ),
        ).toThrow(/persisted lockup graph/);
    });
    it.each([
        [
            "actual Arkade input",
            (arkTx: Transaction, _checkpoints: Transaction[], operatorInputIndex: number) =>
                arkTx.updateInput(operatorInputIndex, { txid: "ff".repeat(32) }),
        ],
        [
            "zero checkpoints",
            (_arkTx: Transaction, checkpoints: Transaction[]) => checkpoints.splice(0),
        ],
        [
            "missing checkpoint",
            (_arkTx: Transaction, checkpoints: Transaction[]) => checkpoints.pop(),
        ],
        [
            "reordered checkpoints",
            (_arkTx: Transaction, checkpoints: Transaction[]) => checkpoints.reverse(),
        ],
        [
            "checkpoint amount",
            (_arkTx: Transaction, checkpoints: Transaction[]) => {
                const input = checkpoints[0]!.getInput(0);
                checkpoints[0]!.updateInput(0, {
                    witnessUtxo: { ...input.witnessUtxo!, amount: input.witnessUtxo!.amount + 1n },
                });
            },
        ],
        [
            "checkpoint script",
            (_arkTx: Transaction, checkpoints: Transaction[]) => {
                const input = checkpoints[0]!.getInput(0);
                checkpoints[0]!.updateInput(0, {
                    witnessUtxo: { ...input.witnessUtxo!, script: new Uint8Array([0x51]) },
                });
            },
        ],
        [
            "checkpoint input",
            (_arkTx: Transaction, checkpoints: Transaction[]) =>
                checkpoints[0]!.updateInput(0, { index: 17 }),
        ],
    ] as const)("rejects a self-consistent graph with mutated %s", (_label, mutate) => {
        const row = mutateLockupGraph(sourceAdvance(), mutate);
        expect(() => assertRecoveryStartupInvariants([row], config())).toThrow(
            new RegExp(`${row.id}.*persisted lockup graph`),
        );
    });

    it("proves every locked row can reconstruct its exact recovery graph", () => {
        const corrupt = { ...sourceAdvance(), unsignedLockupTx: "not-base64" };
        expect(() => assertRecoveryStartupInvariants([corrupt], config())).toThrow(
            /recovery-height.*persisted lockup graph is invalid/,
        );
        expect(() => assertRecoveryStartupInvariants([sourceAdvance()], config())).not.toThrow();
    });

    it.each([
        ["locking", { state: "locking", outpoint: undefined }],
        ["locked", { state: "locked" }],
    ] as const)("accepts a valid %s graph without recovery artifacts", (_label, patch) => {
        expect(() =>
            assertRecoveryStartupInvariants([{ ...sourceAdvance(), ...patch }], config()),
        ).not.toThrow();
    });

    it.each([
        ["phase", { recoveryPhase: "prepared" }],
        ["prepared graph", { recoveryGraphDigest: "aa".repeat(32) }],
        ["expected txid", { recoveryExpectedTxid: "aa".repeat(32) }],
        ["prepared Arkade transaction", { recoveryPreparedArkTx: "ark" }],
        ["prepared checkpoints", { recoveryPreparedCheckpoints: [] }],
        ["response Arkade transaction", { recoveryResponseArkTx: "ark" }],
        ["response checkpoints", { recoveryResponseCheckpoints: [] }],
        ["recovery txid", { recoveryTxid: "aa".repeat(32) }],
        ["submitted time", { recoverySubmittedAt: 10 }],
        ["lease", { recoveryLeaseOwner: "worker" }],
        ["attempt count", { recoveryAttempts: 1 }],
        ["attempt time", { recoveryLastAttemptAt: 10 }],
        ["backoff", { recoveryNextAttemptAt: 11 }],
    ] satisfies [string, Partial<Advance>][])(
        "rejects orphan %s facts before recovery",
        (_label, patch) => {
            const row = { ...sourceAdvance(), ...patch };
            expect(() => assertRecoveryStartupInvariants([row], config())).toThrow(
                new RegExp(`${row.id}.*before recovery`),
            );
        },
    );

    it.each([
        ["response", { recoveryResponseArkTx: "ark", recoveryResponseCheckpoints: [] }],
        ["txid", { recoveryTxid: "aa".repeat(32) }],
        ["submitted time", { recoverySubmittedAt: 10 }],
        ["partial lease", { recoveryLeaseOwner: "worker" }],
        ["attempt without time", { recoveryAttempts: 1 }],
        ["backoff without attempt", { recoveryNextAttemptAt: 11 }],
        [
            "failure code without detail",
            { recoveryAttempts: 1, recoveryLastAttemptAt: 10, failureCode: "retry" },
        ],
    ] satisfies [string, Partial<Advance>][])(
        "rejects contradictory prepared %s facts",
        (_label, patch) => {
            const row = { ...preparedRecovery(), ...patch };
            expect(() => assertRecoveryStartupInvariants([row], config())).toThrow(
                new RegExp(`${row.id}.*recovery`),
            );
        },
    );

    it("accepts prepared retry and lease states with internally complete facts", () => {
        const prepared = preparedRecovery();
        expect(() =>
            assertRecoveryStartupInvariants(
                [
                    {
                        ...prepared,
                        recoveryAttempts: 1,
                        recoveryLastAttemptAt: NOW,
                        recoveryNextAttemptAt: NOW + 1,
                        failureCode: "recovery_submission_ambiguous",
                        failureDetail: "retry retained",
                    },
                    {
                        ...prepared,
                        recoveryLeaseOwner: "worker",
                        recoveryLeaseToken: "token",
                        recoveryLeaseUntil: NOW,
                    },
                ],
                config(),
            ),
        ).not.toThrow();
    });

    it.each([
        ["negative", -1],
        ["NaN", Number.NaN],
        ["non-integer", 10.5],
    ] as const)("rejects a %s recovery submission timestamp", async (_label, timestamp) => {
        const row = { ...(await submittedRecovery()), recoverySubmittedAt: timestamp };
        expect(() => assertRecoveryStartupInvariants([row], config())).toThrow(
            new RegExp(`${row.id}.*recovery submission time`),
        );
    });

    it.each([
        [
            "negative lease",
            {
                recoveryLeaseOwner: "worker",
                recoveryLeaseToken: "token",
                recoveryLeaseUntil: -1,
            },
        ],
        [
            "NaN lease",
            {
                recoveryLeaseOwner: "worker",
                recoveryLeaseToken: "token",
                recoveryLeaseUntil: Number.NaN,
            },
        ],
        [
            "non-integer lease",
            {
                recoveryLeaseOwner: "worker",
                recoveryLeaseToken: "token",
                recoveryLeaseUntil: 10.5,
            },
        ],
        [
            "negative attempt",
            {
                recoveryAttempts: 1,
                recoveryLastAttemptAt: -1,
                recoveryNextAttemptAt: NOW + 1,
                failureCode: "retry",
                failureDetail: "retained",
            },
        ],
        [
            "NaN attempt",
            {
                recoveryAttempts: 1,
                recoveryLastAttemptAt: Number.NaN,
                recoveryNextAttemptAt: NOW + 1,
                failureCode: "retry",
                failureDetail: "retained",
            },
        ],
        [
            "non-integer attempt",
            {
                recoveryAttempts: 1,
                recoveryLastAttemptAt: 10.5,
                recoveryNextAttemptAt: NOW + 1,
                failureCode: "retry",
                failureDetail: "retained",
            },
        ],
        [
            "negative retry",
            {
                recoveryAttempts: 1,
                recoveryLastAttemptAt: 0,
                recoveryNextAttemptAt: -1,
                failureCode: "retry",
                failureDetail: "retained",
            },
        ],
        [
            "NaN retry",
            {
                recoveryAttempts: 1,
                recoveryLastAttemptAt: 0,
                recoveryNextAttemptAt: Number.NaN,
                failureCode: "retry",
                failureDetail: "retained",
            },
        ],
        [
            "non-integer retry",
            {
                recoveryAttempts: 1,
                recoveryLastAttemptAt: 0,
                recoveryNextAttemptAt: 10.5,
                failureCode: "retry",
                failureDetail: "retained",
            },
        ],
    ] satisfies [string, Partial<Advance>][])("rejects a %s timestamp", (_label, patch) => {
        const row = { ...preparedRecovery(), ...patch };
        expect(() => assertRecoveryStartupInvariants([row], config())).toThrow(
            new RegExp(`${row.id}.*recovery.*time`),
        );
    });

    it.each([
        ["advance creation", { recoverySubmittedAt: NOW - 1 }],
        [
            "last recovery attempt",
            {
                recoveryAttempts: 1,
                recoveryLastAttemptAt: NOW + 1,
                recoverySubmittedAt: NOW,
                updatedAt: NOW + 1,
            },
        ],
        ["persisted update", { recoverySubmittedAt: NOW + 1 }],
    ] satisfies [string, Partial<Advance>][])(
        "rejects a recovery submission before or beyond its %s chronology",
        async (_label, patch) => {
            const row = { ...(await submittedRecovery()), ...patch };
            expect(() => assertRecoveryStartupInvariants([row], config())).toThrow(
                new RegExp(`${row.id}.*recovery submission time`),
            );
        },
    );

    it.each([
        ["lease owner", { recoveryLeaseOwner: "   " }],
        ["lease token", { recoveryLeaseToken: "   " }],
    ] satisfies [string, Partial<Advance>][])(
        "rejects a whitespace-only recovery %s",
        (_label, patch) => {
            const row = {
                ...preparedRecovery(),
                recoveryLeaseOwner: "worker",
                recoveryLeaseToken: "token",
                recoveryLeaseUntil: NOW,
                ...patch,
            };
            expect(() => assertRecoveryStartupInvariants([row], config())).toThrow(
                new RegExp(`${row.id}.*recovery lease`),
            );
        },
    );

    it.each([
        ["prepared", "empty code", "", "detail"],
        ["prepared", "whitespace code", "   ", "detail"],
        ["prepared", "empty detail", "code", ""],
        ["prepared", "whitespace detail", "code", "   "],
        ["failed", "empty code", "", "detail"],
        ["failed", "whitespace code", "   ", "detail"],
        ["failed", "empty detail", "code", ""],
        ["failed", "whitespace detail", "code", "   "],
    ] as const)("rejects %s recovery with %s", (phase, _label, failureCode, failureDetail) => {
        const prepared = preparedRecovery();
        const row: Advance = {
            ...(phase === "prepared" ? prepared : sourceAdvance()),
            state: "recovering",
            recoveryPhase: phase,
            recoveryAttempts: 1,
            recoveryLastAttemptAt: NOW,
            ...(phase === "prepared" ? { recoveryNextAttemptAt: NOW + 1 } : {}),
            failureCode,
            failureDetail,
        };
        expect(() => assertRecoveryStartupInvariants([row], config())).toThrow(
            new RegExp(`${row.id}.*recovery failure facts`),
        );
    });

    it("accepts zero timestamp boundaries and trimmed non-empty failure facts", async () => {
        const base = sourceAdvance();
        const epoch = { ...base, createdAt: 0, updatedAt: 0 };
        const prepared = preparedRecovery(epoch);
        const submitted = {
            ...(await submittedRecovery(epoch)),
            recoveryAttempts: 1,
            recoveryLastAttemptAt: 0,
            recoverySubmittedAt: 0,
        };
        const failed: Advance = {
            ...epoch,
            state: "recovering",
            recoveryPhase: "failed",
            recoveryAttempts: 1,
            recoveryLastAttemptAt: 0,
            failureCode: " recovery_artifact_invalid ",
            failureDetail: " quarantined ",
        };
        expect(() =>
            assertRecoveryStartupInvariants(
                [
                    submitted,
                    failed,
                    {
                        ...prepared,
                        recoveryAttempts: 1,
                        recoveryLastAttemptAt: 0,
                        recoveryNextAttemptAt: 1,
                        failureCode: " recovery_submission_ambiguous ",
                        failureDetail: " retry retained ",
                    },
                    {
                        ...prepared,
                        recoveryLeaseOwner: " worker ",
                        recoveryLeaseToken: " token ",
                        recoveryLeaseUntil: 0,
                    },
                ],
                config(),
            ),
        ).not.toThrow();
    });

    describe.each([
        "prepared",
        "failed-before-prepare",
        "failed-after-prepare",
        "submitted",
    ] as const)("%s recovery attempt chronology", (phase) => {
        it.each([
            ["before creation", (row: Advance) => row.createdAt - 1],
            ["after update", (row: Advance) => row.updatedAt + 1],
        ] as const)("rejects a last attempt %s directly and after SQLite", async (_label, at) => {
            const valid = await attemptedRecovery(phase);
            const row = { ...valid, recoveryLastAttemptAt: at(valid) };
            const directError = startupError(row);
            const database = open(":memory:");
            const advances = new AdvanceRepository(database);
            advances.insert(row);
            const persistedError = startupError(advances.get(row.id)!);

            expect.soft(directError).toMatch(new RegExp(`${row.id}.*recovery attempt time`));
            expect.soft(persistedError).toMatch(new RegExp(`${row.id}.*recovery attempt time`));
        });
    });

    it("accepts maximum safe future retry and lease deadlines directly and after SQLite", () => {
        const prepared = preparedRecovery();
        const rows: Advance[] = [
            {
                ...prepared,
                recoveryAttempts: 1,
                recoveryLastAttemptAt: prepared.updatedAt,
                recoveryNextAttemptAt: Number.MAX_SAFE_INTEGER,
                failureCode: "recovery_submission_ambiguous",
                failureDetail: "retry retained",
            },
            {
                ...prepared,
                recoveryLeaseOwner: "worker",
                recoveryLeaseToken: "token",
                recoveryLeaseUntil: Number.MAX_SAFE_INTEGER,
            },
        ];
        for (const row of rows) {
            expect(startupError(row)).toBeUndefined();
            const database = open(":memory:");
            const advances = new AdvanceRepository(database);
            advances.insert(row);
            expect(startupError(advances.get(row.id)!)).toBeUndefined();
        }
    });

    it.each([
        ["response", { recoveryResponseArkTx: "ark", recoveryResponseCheckpoints: [] }],
        ["txid", { recoveryTxid: "aa".repeat(32) }],
        ["submitted time", { recoverySubmittedAt: 10 }],
        ["partial prepared", { recoveryGraphDigest: "aa".repeat(32) }],
        ["partial lease", { recoveryLeaseToken: "token" }],
    ] satisfies [string, Partial<Advance>][])(
        "rejects contradictory failed %s facts",
        (_label, patch) => {
            const row = {
                ...sourceAdvance(),
                state: "recovering" as const,
                recoveryPhase: "failed" as const,
                recoveryAttempts: 1,
                recoveryLastAttemptAt: 10,
                failureCode: "recovery_artifact_invalid",
                failureDetail: "quarantined",
                ...patch,
            };
            expect(() => assertRecoveryStartupInvariants([row], config())).toThrow(
                new RegExp(`${row.id}.*recovery`),
            );
        },
    );

    it("accepts exact prepared, submitted, and failed phase matrices", async () => {
        const prepared = preparedRecovery();
        const response = await signingEmulator().submitTx(
            prepared.recoveryPreparedArkTx!,
            prepared.recoveryPreparedCheckpoints!,
        );
        const submitted = {
            ...prepared,
            recoveryPhase: "submitted" as const,
            recoveryResponseArkTx: response.signedArkTx,
            recoveryResponseCheckpoints: response.signedCheckpointTxs,
            recoveryTxid: prepared.recoveryExpectedTxid,
            recoverySubmittedAt: NOW,
        };
        const failed = {
            ...prepared,
            recoveryPhase: "failed" as const,
            recoveryAttempts: 1,
            recoveryLastAttemptAt: NOW,
            failureCode: "recovery_artifact_invalid",
            failureDetail: "quarantined",
        };
        const failedBeforePrepare = {
            ...sourceAdvance(),
            state: "recovering" as const,
            recoveryPhase: "failed" as const,
            recoveryAttempts: 1,
            recoveryLastAttemptAt: NOW,
            failureCode: "recovery_artifact_invalid",
            failureDetail: "preparation failed",
        };
        expect(() =>
            assertRecoveryStartupInvariants(
                [prepared, submitted, failed, failedBeforePrepare],
                config(),
            ),
        ).not.toThrow();
        expect(() =>
            assertRecoveryStartupInvariants(
                [
                    {
                        ...submitted,
                        recoveryAttempts: 1,
                        recoveryLastAttemptAt: NOW,
                        recoveryNextAttemptAt: NOW + 1,
                    },
                ],
                config(),
            ),
        ).toThrow(/completed recovery retains retry facts/);
    });

    it("rejects a missing or mismatched recovery locktime tag with the advance id", () => {
        const missing = { ...sourceAdvance(), recoveryLocktime: undefined };
        expect(() => assertRecoveryStartupInvariants([missing], config())).toThrow(
            /recovery-height.*recovery locktime/,
        );
        const mismatch = {
            ...sourceAdvance(),
            recoveryLocktime: { kind: "time" as const, value: 850_000n },
        };
        expect(() => assertRecoveryStartupInvariants([mismatch], config())).toThrow(
            /recovery-height.*kind/,
        );
    });

    it.each([
        ["height", 12n],
        ["time", 7_200n],
    ] as const)(
        "requires the %s execution budget to fit strictly before expiry",
        (kind, budget) => {
            const row = sourceAdvance(kind);
            const exact = { ...row, batchExpiry: { kind, value: row.locktime + budget } };
            expect(() => assertRecoveryStartupInvariants([exact], config())).toThrow(
                new RegExp(`${row.id}.*strictly before batch expiry`),
            );
        },
    );

    it("rejects an active legacy or incomplete recovery phase", () => {
        const legacy = {
            ...sourceAdvance(),
            state: "recovering" as const,
            recoveryPhase: "legacy" as const,
        };
        expect(() => assertRecoveryStartupInvariants([legacy], config())).toThrow(
            /recovery-height.*legacy recovery phase/,
        );
    });
});

describe("durable recovery runner", () => {
    it("stops heartbeat ownership without waiting for a hung emulator response", async () => {
        vi.useFakeTimers();
        try {
            const database = open(":memory:");
            const advances = new AdvanceRepository(database);
            const row = sourceAdvance();
            advances.insert(row);
            let reject!: (error: Error) => void;
            const response = new Promise<never>((_, fail) => {
                reject = fail;
            });
            const emulator = {
                submitTx: vi.fn(() => response),
            } as unknown as Pick<EmulatorProvider, "submitTx">;
            const runner = createRecoveryRunner({
                advances,
                emulator,
                config: config(),
                workerId: "worker",
                now: () => 100,
                leaseSeconds: 30,
                backoffSeconds: 1,
            });
            const pending = runner.recover(row);
            await Promise.resolve();
            expect(emulator.submitTx).toHaveBeenCalledOnce();
            expect(vi.getTimerCount()).toBeGreaterThan(0);
            runner.stop();
            expect(vi.getTimerCount()).toBe(0);
            reject(new Error("late transport failure"));
            await expect(pending).resolves.toBeUndefined();
            await expect(runner.recover(row)).resolves.toBeUndefined();
        } finally {
            vi.useRealTimers();
        }
    });

    it("quarantines a deterministic preparation failure before any network effect", async () => {
        const database = open(":memory:");
        const advances = new AdvanceRepository(database);
        const row = { ...sourceAdvance(), unsignedLockupTx: "not-base64" };
        advances.insert(row);
        const emulator = { submitTx: vi.fn() } as unknown as Pick<EmulatorProvider, "submitTx"> & {
            submitTx: ReturnType<typeof vi.fn>;
        };
        const runner = createRecoveryRunner({
            advances,
            emulator,
            config: config(),
            workerId: "worker",
            now: () => 100,
            leaseSeconds: 30,
            backoffSeconds: 1,
        });

        await expect(runner.recover(row)).rejects.toThrow(/recovery/);
        expect(emulator.submitTx).not.toHaveBeenCalled();
        expect(advances.get(row.id)).toMatchObject({
            state: "recovering",
            recoveryPhase: "failed",
            failureCode: "recovery_artifact_invalid",
            recoveryLastAttemptAt: 100,
        });
        expect(new PolicyRepository(database).get().paused).toBe(true);
    });

    it("reopens after an ambiguous submit and retries byte-identical persisted artifacts", async () => {
        const path = dbFile();
        const firstDb = open(path);
        const firstRepo = new AdvanceRepository(firstDb);
        const row = sourceAdvance();
        firstRepo.insert(row);
        const calls: [string, string[]][] = [];
        const ambiguous = {
            submitTx: vi.fn(async (arkTx: string, checkpoints: string[]) => {
                calls.push([arkTx, checkpoints]);
                throw new Error("response lost");
            }),
        } as unknown as Pick<EmulatorProvider, "submitTx">;
        const first = createRecoveryRunner({
            advances: firstRepo,
            emulator: ambiguous,
            config: config(),
            workerId: randomUUID(),
            now: () => NOW + 100,
            leaseSeconds: 30,
            backoffSeconds: 1,
        });

        await expect(first.recover(row)).rejects.toThrow(/response lost/);
        const prepared = firstRepo.get(row.id)!;
        expect(prepared).toMatchObject({ state: "recovering", recoveryPhase: "prepared" });
        expect(prepared.recoveryTxid).toBeUndefined();
        firstDb.close();

        const secondDb = open(path);
        const secondRepo = new AdvanceRepository(secondDb);
        const response = signingEmulator();
        const second = createRecoveryRunner({
            advances: secondRepo,
            emulator: response,
            config: config(),
            workerId: randomUUID(),
            now: () => NOW + 102,
            leaseSeconds: 30,
            backoffSeconds: 1,
        });
        const submitted = await second.recover(secondRepo.get(row.id)!);

        expect(response.submitTx.mock.calls[0]).toEqual(calls[0]);
        expect(submitted).toMatchObject({
            txid: prepared.recoveryExpectedTxid,
            alreadyKnown: false,
        });
        const persisted = secondRepo.get(row.id)!;
        expect(persisted).toMatchObject({
            state: "recovering",
            recoveryPhase: "submitted",
            recoveryTxid: prepared.recoveryExpectedTxid,
            recoverySubmittedAt: NOW + 102,
        });
        expect(persisted.recoveryNextAttemptAt).toBeUndefined();
        expect(() =>
            assertRecoveryStartupInvariants(
                [{ ...persisted, recoveryTxid: "00".repeat(32) }],
                config(),
            ),
        ).toThrow(/recovery-height.*submitted recovery facts/);
        secondDb.close();
    });

    it("allows one emulator effect across concurrent database connections", async () => {
        const path = dbFile();
        const dbA = open(path);
        const dbB = open(path);
        const repoA = new AdvanceRepository(dbA);
        const repoB = new AdvanceRepository(dbB);
        const row = sourceAdvance();
        repoA.insert(row);
        let release!: () => void;
        const wait = new Promise<void>((resolve) => (release = resolve));
        const emulator = signingEmulator(wait);
        const make = (advances: AdvanceRepository, workerId: string) =>
            createRecoveryRunner({
                advances,
                emulator,
                config: config(),
                workerId,
                now: () => 100,
                leaseSeconds: 30,
                backoffSeconds: 1,
            });

        const first = make(repoA, "worker-a").recover(row);
        await vi.waitFor(() => expect(emulator.submitTx).toHaveBeenCalledTimes(1));
        const second = await make(repoB, "worker-b").recover(repoB.get(row.id)!);
        expect(second).toBeUndefined();
        release();
        await first;
        expect(emulator.submitTx).toHaveBeenCalledTimes(1);
        dbA.close();
        dbB.close();
    });

    it("heartbeats an in-flight emulator effect so an expired initial lease is not stolen", async () => {
        vi.useFakeTimers();
        try {
            const path = dbFile();
            const dbA = open(path);
            const dbB = open(path);
            const repoA = new AdvanceRepository(dbA);
            const repoB = new AdvanceRepository(dbB);
            const row = sourceAdvance();
            repoA.insert(row);
            let now = 100;
            let release!: () => void;
            const wait = new Promise<void>((resolve) => (release = resolve));
            const emulator = signingEmulator(wait);
            const make = (advances: AdvanceRepository, workerId: string) =>
                createRecoveryRunner({
                    advances,
                    emulator,
                    config: config(),
                    workerId,
                    now: () => now,
                    leaseSeconds: 1,
                    backoffSeconds: 1,
                });

            const first = make(repoA, "worker-a").recover(row);
            await Promise.resolve();
            expect(emulator.submitTx).toHaveBeenCalledTimes(1);
            for (const current of [100.5, 101, 101.5]) {
                now = current;
                await vi.advanceTimersByTimeAsync(400);
            }
            now = 101.6;

            expect(await make(repoB, "worker-b").recover(repoB.get(row.id)!)).toBeUndefined();
            expect(emulator.submitTx).toHaveBeenCalledTimes(1);
            release();
            await first;
        } finally {
            vi.useRealTimers();
        }
    });

    it("quarantines a deterministic response mismatch without releasing reservations", async () => {
        const database = open(":memory:");
        const advances = new AdvanceRepository(database);
        const row = sourceAdvance();
        advances.insert(row);
        database
            .prepare(
                `INSERT INTO operator_input_reservations
                 (outpoint_txid, outpoint_vout, advance_id, batch_expiry_kind,
                  batch_expiry_value, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
            )
            .run("aa".repeat(32), 0, row.id, row.batchExpiry.kind, row.batchExpiry.value, 1);
        const malformed = {
            submitTx: vi.fn(async (arkTx: string, checkpoints: string[]) => ({
                signedArkTx: arkTx,
                signedCheckpointTxs: checkpoints,
            })),
        } as unknown as Pick<EmulatorProvider, "submitTx">;
        const runner = createRecoveryRunner({
            advances,
            emulator: malformed,
            config: config(),
            workerId: "worker",
            now: () => 100,
            leaseSeconds: 30,
            backoffSeconds: 1,
        });

        await expect(runner.recover(row)).rejects.toThrow(/signer set mismatch/);
        expect(advances.get(row.id)).toMatchObject({
            state: "recovering",
            recoveryPhase: "failed",
            failureCode: "recovery_artifact_invalid",
        });
        expect(new PolicyRepository(database).get().paused).toBe(true);
        expect(
            database
                .prepare(
                    "SELECT count(*) AS total FROM operator_input_reservations WHERE advance_id = ?",
                )
                .get(row.id),
        ).toEqual({ total: 1n });
    });
});

const bytesToNumber = (bytes: Uint8Array): bigint => BigInt(`0x${hex.encode(bytes)}`);
const numberToBytes = (value: bigint): Uint8Array =>
    hex.decode(value.toString(16).padStart(64, "0"));
const serverIdentity = SingleKey.fromPrivateKey(new Uint8Array(32).fill(4));
const emulatorIdentity = (script: Uint8Array): SingleKey => {
    const curve = secp256k1.Point.CURVE();
    const original = bytesToNumber(new Uint8Array(32).fill(5));
    const point = secp256k1.Point.BASE.multiply(original);
    const normalized = (point.y & 1n) === 0n ? original : curve.n - original;
    return SingleKey.fromPrivateKey(
        numberToBytes((normalized + bytesToNumber(arkade.arkadeScriptHash(script))) % curve.n),
    );
};

function signingEmulator(wait?: Promise<void>) {
    return {
        submitTx: vi.fn(async (arkTx: string, checkpoints: string[]) => {
            await wait;
            const unsignedArk = Transaction.fromPSBT(base64.decode(arkTx));
            const script = Extension.fromTx(unsignedArk).getEmulatorPacket()!.entries[0]!.script;
            let signedArk = await serverIdentity.sign(unsignedArk, [0]);
            signedArk = await emulatorIdentity(script).sign(signedArk, [0]);
            const signedCheckpoints = await Promise.all(
                checkpoints.map(async (encoded) => {
                    let checkpoint = await serverIdentity.sign(
                        Transaction.fromPSBT(base64.decode(encoded)),
                        [0],
                    );
                    checkpoint = await emulatorIdentity(script).sign(checkpoint, [0]);
                    return base64.encode(checkpoint.toPSBT());
                }),
            );
            return {
                signedArkTx: base64.encode(signedArk.toPSBT()),
                signedCheckpointTxs: signedCheckpoints,
            };
        }),
    } as unknown as Pick<EmulatorProvider, "submitTx"> & {
        submitTx: ReturnType<typeof vi.fn<EmulatorProvider["submitTx"]>>;
    };
}
