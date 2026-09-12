import { afterEach, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { asset, arkade, Extension, SingleKey, Transaction } from "@arkade-os/sdk";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { base64, hex } from "@scure/base";
import {
    AdvanceRepository,
    openDatabase,
    PolicyRepository,
    ReservationRepository,
} from "@arkade-taxi/db";
import type { Advance } from "@arkade-taxi/core";
import { DustCovenantScript } from "@arkade-taxi/covenant";
import { fareToWire, quoteParamsToWire } from "@arkade-taxi/protocol";
import { verifyQuote, signLockup } from "../../../client/src/index.js";
import { args } from "../../../client/test/fixtures.js";
import { buildRequest, unroll } from "./lockupFixtures.js";
import { config, NOW, policy } from "../fixtures.js";
import { ProductionLockupBuilder } from "../../src/arkade/lockupBuilder.js";
import { decodeLockupEnvelope } from "../../src/arkade/psbt.js";
import { productionLockupSubmitter } from "../../src/arkade/submit.js";
import {
    assertRecoveryStartupInvariants,
    createRecoveryRunner,
} from "../../src/arkade/recovery.js";

const directories: string[] = [];
afterEach(() => {
    for (const directory of directories.splice(0))
        rmSync(directory, { recursive: true, force: true });
});

it.each([false, true])(
    "persists and recovers omitted asset units through real signing and SQLite restart (asset fare=%s)",
    async (assetFare) => {
        const req = buildRequest();
        const id = asset.AssetId.create("12".repeat(32), 7);
        req.params.assetId = { txid: Uint8Array.from(id.txid).reverse(), groupIndex: 7 };
        req.senderInputs[0]!.assetPacket = asset.Packet.create([
            asset.AssetGroup.create(
                id,
                null,
                [],
                [asset.AssetOutput.create(2, 9_007_199_254_740_993n)],
                [],
            ),
        ]).serialize();
        if (assetFare) req.fare = { currency: "asset", assetId: req.params.assetId, units: 3n };
        req.covenantAddress = new DustCovenantScript({
            params: req.params,
            serverKey: config().serverPubkey,
            emulatorKey: config().emulatorPubkey,
            vtxoMinAmount: 10n,
        })
            .address("ark", config().serverPubkey)
            .encode();
        const funding = await new ProductionLockupBuilder(config(), () => unroll).buildUnsigned(
            req,
        );
        const expected = assetFare ? 9_007_199_254_740_990n : 9_007_199_254_740_993n;
        const envelope = decodeLockupEnvelope(funding.unsignedLockupTx);
        expect(envelope.assetUnits).toBe(expected.toString());
        const verified = verifyQuote({
            ...args(),
            senderInputs: req.senderInputs,
            senderSats: req.senderSats,
            expect: { ...args().expect, assetId: req.params.assetId, maxFare: req.fare },
            quote: {
                transferId: req.advanceId,
                params: quoteParamsToWire(req.params),
                covenantAddress: req.covenantAddress,
                fare: fareToWire(req.fare),
                expiresAt: NOW + 60,
                unsignedLockupTx: funding.unsignedLockupTx,
                lockup: {
                    covenantOutputIndex: 0,
                    senderInputIndexes: [0],
                    operatorInputIndexes: [1],
                    unsignedTxId: funding.unsignedLockupId,
                },
            },
        });
        const signed = await signLockup({
            verified,
            identity: SingleKey.fromPrivateKey(new Uint8Array(32).fill(2)),
        });
        const row: Advance = {
            id: req.advanceId,
            state: "quoted",
            ...req.params,
            assetUnits: BigInt(envelope.assetUnits!),
            ...funding,
            fare: req.fare,
            covenantAddress: req.covenantAddress,
            batchExpiry: req.funding.batchExpiry,
            recoveryLocktime: { kind: "height", value: req.params.locktime },
            createdAt: NOW,
            updatedAt: NOW,
            expiresAt: NOW + 60,
        };
        const server = SingleKey.fromPrivateKey(new Uint8Array(32).fill(4));
        const signServer = async (encoded: string) => {
            const tx = Transaction.fromPSBT(base64.decode(encoded));
            return base64.encode(
                (
                    await server.sign(
                        tx,
                        Array.from({ length: tx.inputsLength }, (_, i) => i),
                    )
                ).toPSBT(),
            );
        };
        let finalized = false;
        const submitter = productionLockupSubmitter(
            config(),
            SingleKey.fromPrivateKey(new Uint8Array(32).fill(3)),
            {
                submitTx: async (arkTx, checkpoints) => ({
                    arkTxid: Transaction.fromPSBT(base64.decode(arkTx)).id,
                    finalArkTx: await signServer(arkTx),
                    signedCheckpointTxs: await Promise.all(checkpoints.map(signServer)),
                }),
                finalizeTx: async () => {
                    finalized = true;
                },
            },
        );
        const validated = submitter.validate(row, signed);
        const directory = mkdtempSync(join(tmpdir(), "taxi-omitted-asset-"));
        directories.push(directory);
        const path = join(directory, "taxi.sqlite");
        const db = openDatabase(path);
        const p = new PolicyRepository(db);
        const rules = policy();
        rules.assetRules.push({
            assetId: req.params.assetId,
            enabled: true,
            claim: "either",
            maxTopupSats: null,
            fares: [],
        });
        p.update(rules, "test");
        const reservations = new ReservationRepository(db);
        reservations.reserveQuote({
            advance: row,
            expectedPolicyRevision: p.getSnapshot().revision,
            recoveryExecutionBudget: { kind: "height", value: 72n },
        });
        reservations.claimLockup(
            row.id,
            validated.unsignedTxId,
            validated.digest,
            validated.encoded,
            () => NOW + 1,
        );
        const submitted = await submitter.submit(validated);
        expect(finalized).toBe(true);
        new AdvanceRepository(db).recordLockupObserved(row.id, submitted.outpoint, NOW + 2);
        db.close();
        const reopened = openDatabase(path);
        try {
            const advances = new AdvanceRepository(reopened);
            const locked = advances.get(row.id)!;
            expect(locked.assetUnits).toBe(expected);
            assertRecoveryStartupInvariants([locked], config());
            const runner = createRecoveryRunner({
                advances,
                config: config(),
                workerId: "restarted",
                now: () => NOW + 3,
                leaseSeconds: 30,
                backoffSeconds: 1,
                emulator: {
                    submitTx: async (arkTx, checkpoints) => {
                        const tx = Transaction.fromPSBT(base64.decode(arkTx));
                        const group = Extension.fromTx(tx).getAssetPacket()!.groups[0]!;
                        expect(group.outputs.map((output) => [output.vout, output.amount])).toEqual(
                            [[1, expected]],
                        );
                        const script = Extension.fromTx(tx).getEmulatorPacket()!.entries[0]!.script;
                        const number = (bytes: Uint8Array) => BigInt(`0x${hex.encode(bytes)}`);
                        const secret = number(new Uint8Array(32).fill(5));
                        const n = secp256k1.Point.CURVE().n;
                        const normalized =
                            secp256k1.Point.BASE.multiply(secret).y & 1n ? n - secret : secret;
                        const emulator = SingleKey.fromPrivateKey(
                            hex.decode(
                                ((normalized + number(arkade.arkadeScriptHash(script))) % n)
                                    .toString(16)
                                    .padStart(64, "0"),
                            ),
                        );
                        const sign = async (encoded: string) =>
                            base64.encode(
                                (
                                    await emulator.sign(
                                        Transaction.fromPSBT(
                                            base64.decode(await signServer(encoded)),
                                        ),
                                        [0],
                                    )
                                ).toPSBT(),
                            );
                        return {
                            signedArkTx: await sign(arkTx),
                            signedCheckpointTxs: await Promise.all(checkpoints.map(sign)),
                        };
                    },
                },
            });
            const recovered = await runner.recover(locked);
            expect(recovered?.txid).toMatch(/^[0-9a-f]{64}$/);
            expect(advances.get(row.id)?.recoveryPhase).toBe("submitted");
            assertRecoveryStartupInvariants([advances.get(row.id)!], config());
        } finally {
            reopened.close();
        }
    },
);
