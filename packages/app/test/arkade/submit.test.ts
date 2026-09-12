import { describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runInNewContext } from "node:vm";
import {
    SingleKey,
    Transaction,
    VtxoTaprootTree,
    verifyTapscriptSignatures,
    type ArkProvider,
    type Identity,
} from "@arkade-os/sdk";
import { base64, hex } from "@scure/base";
import type { Advance } from "@arkade-taxi/core";
import {
    AdvanceRepository,
    openDatabase,
    PolicyRepository,
    ReservationRepository,
} from "@arkade-taxi/db";
import { buildLockupEnvelope } from "../../src/arkade/lockupBuilder.js";
import {
    createLockupSubmitter,
    createSubmissionResumer,
    productionLockupSubmitter,
    validateLockupSubmission,
} from "../../src/arkade/submit.js";
import { decodeLockupEnvelope, encodeLockupEnvelope } from "../../src/arkade/psbt.js";
import { createLockupReconciler } from "../../src/reconciler.js";
import {
    config,
    NOW,
    operatorKey,
    policy as basePolicy,
    receiverKey,
    senderKey,
    serverKey,
} from "../fixtures.js";
import { buildRequest, unroll } from "./lockupFixtures.js";

const senderIdentity = SingleKey.fromPrivateKey(new Uint8Array(32).fill(2));
const operatorIdentity = SingleKey.fromPrivateKey(new Uint8Array(32).fill(3));
const serverIdentity = SingleKey.fromPrivateKey(new Uint8Array(32).fill(4));

const unsigned = () => buildLockupEnvelope(buildRequest(), config(), unroll);

const signedEnvelope = async (encoded = unsigned()): Promise<string> => {
    const envelope = decodeLockupEnvelope(encoded);
    const arkTx = await senderIdentity.sign(
        Transaction.fromPSBT(base64.decode(envelope.arkTx)),
        envelope.senderInputIndexes,
    );
    const checkpoints = await Promise.all(
        envelope.checkpoints.map(async (encoded, index) =>
            envelope.senderInputIndexes.includes(index)
                ? base64.encode(
                      (
                          await senderIdentity.sign(
                              Transaction.fromPSBT(base64.decode(encoded)),
                              [0],
                          )
                      ).toPSBT(),
                  )
                : encoded,
        ),
    );
    return encodeLockupEnvelope({ ...envelope, arkTx: base64.encode(arkTx.toPSBT()), checkpoints });
};

const advance = (): Advance => {
    const request = buildRequest();
    const encoded = unsigned();
    return {
        id: request.advanceId,
        state: "quoted",
        receiverKey,
        senderKey,
        operatorKey,
        dust: request.params.dust,
        topup: request.params.topup,
        locktime: request.params.locktime,
        covenantAddress: request.covenantAddress,
        fare: request.fare,
        batchExpiry: request.funding.batchExpiry,
        recoveryLocktime: {
            kind: request.funding.batchExpiry.kind,
            value: request.params.locktime,
        },
        operatorInputs: request.funding.inputs.map(({ txid, vout }) => ({ txid, vout })),
        unsignedLockupTx: encoded,
        unsignedLockupId: decodeLockupEnvelope(encoded).unsignedTxId,
        createdAt: NOW,
        updatedAt: NOW,
        expiresAt: NOW + 60,
    };
};

const provider = () => {
    const finalizeTx = vi.fn<ArkProvider["finalizeTx"]>(async () => {});
    const submitTx = vi.fn<ArkProvider["submitTx"]>(async (ark, checkpoints) => {
        const tx = Transaction.fromPSBT(base64.decode(ark));
        const finalArkTx = await serverIdentity.sign(
            tx,
            Array.from({ length: tx.inputsLength }, (_, index) => index),
        );
        const signedCheckpointTxs = await Promise.all(
            checkpoints.map(async (encoded) =>
                base64.encode(
                    (
                        await serverIdentity.sign(Transaction.fromPSBT(base64.decode(encoded)), [0])
                    ).toPSBT(),
                ),
            ),
        );
        return {
            arkTxid: tx.id,
            finalArkTx: base64.encode(finalArkTx.toPSBT()),
            signedCheckpointTxs,
        };
    });
    return { submitTx, finalizeTx };
};

describe("persisted-fact submission validation", () => {
    it("digests exactly the canonical bytes returned for persistence", async () => {
        const signed = await signedEnvelope();
        const value = JSON.parse(new TextDecoder().decode(base64.decode(signed)));
        const pretty = base64.encode(
            new TextEncoder().encode(` \r\n${JSON.stringify(value, null, 4)}\n`),
        );

        const validated = validateLockupSubmission(advance(), pretty, config());
        expect(validated.encoded).not.toBe(pretty);
        expect(validated.digest).toBe(
            createHash("sha256").update(base64.decode(validated.encoded)).digest("hex"),
        );
    });

    it("rejects duplicate envelope keys even when the final JSON value is unchanged", async () => {
        const signed = await signedEnvelope();
        const json = new TextDecoder().decode(base64.decode(signed));
        const duplicate = base64.encode(
            new TextEncoder().encode(json.replace("{", `{"unsignedTxId":"${"00".repeat(32)}",`)),
        );

        expect(() => validateLockupSubmission(advance(), duplicate, config())).toThrow(
            /duplicate/i,
        );
    });

    it("normalizes a valid unpadded outer base64 envelope with transport whitespace", async () => {
        const signed = await signedEnvelope();
        const variant = `\r\n${signed.replace(/=+$/, "")} \n`;

        const validated = validateLockupSubmission(advance(), variant, config());
        expect(validated.encoded).toBe(encodeLockupEnvelope(decodeLockupEnvelope(signed)));
    });

    it("accepts the exact persisted earliest expiry when the sender expires first", async () => {
        const request = buildRequest();
        request.senderInputs[0]!.expiry.value = 900000n;
        request.funding.inputs[0]!.expiresAtHeight = 910000;
        request.funding.batchExpiry.value = 910000n;
        const encoded = buildLockupEnvelope(request, config(), unroll);
        const persisted = advance();
        persisted.unsignedLockupTx = encoded;
        persisted.unsignedLockupId = decodeLockupEnvelope(encoded).unsignedTxId;
        persisted.batchExpiry = { kind: "height", value: 900000n };
        const signed = await signedEnvelope(encoded);

        expect(() => validateLockupSubmission(persisted, signed, config())).not.toThrow();
    });

    it("rejects when the persisted fare no longer matches the original unsigned graph", async () => {
        const persisted = advance();
        persisted.fare = { currency: "sats", units: persisted.fare.units + 1n };
        const encoded = await signedEnvelope();
        expect(() => validateLockupSubmission(persisted, encoded, config())).toThrow(
            /fare|persisted|graph/,
        );
    });

    it("rejects a missing sender signature before returning a submission digest", () => {
        expect(() => validateLockupSubmission(advance(), unsigned(), config())).toThrow(
            /sender signature/,
        );
    });

    it("rejects a changed checkpoint signature owner", async () => {
        const encoded = await signedEnvelope();
        const envelope = decodeLockupEnvelope(encoded);
        envelope.checkpoints[1] = base64.encode(
            (
                await operatorIdentity.sign(
                    Transaction.fromPSBT(base64.decode(envelope.checkpoints[1])),
                    [0],
                )
            ).toPSBT(),
        );
        expect(() =>
            validateLockupSubmission(advance(), encodeLockupEnvelope(envelope), config()),
        ).toThrow(/operator checkpoint/);
    });
});

describe("public provider submission", () => {
    it("recovers a dropped HTTP submit response through an authenticated exact pending graph", async () => {
        const external = provider();
        let pending: Awaited<ReturnType<ArkProvider["submitTx"]>> | undefined;
        let lookup: any;
        let effects = 0;
        const server = createServer(async (request, response) => {
            const chunks: Buffer[] = [];
            for await (const chunk of request) chunks.push(Buffer.from(chunk));
            const body = JSON.parse(Buffer.concat(chunks).toString());
            if (request.url === "/submit") {
                pending = await external.submitTx(body.arkTx, body.checkpoints);
                effects++;
                response.destroy();
            } else {
                lookup = body;
                response.setHeader("content-type", "application/json");
                response.end(JSON.stringify([pending]));
            }
        });
        await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
        const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
        const post = async (path: string, body: unknown) =>
            fetch(`${url}/${path}`, { method: "POST", body: JSON.stringify(body) }).then((r) =>
                r.json(),
            );
        const submitter = createLockupSubmitter({
            identity: operatorIdentity,
            provider: {
                ...external,
                submitTx: (arkTx, checkpoints) => post("submit", { arkTx, checkpoints }),
                getPendingTxs: (intent: unknown) => post("pending", intent),
            },
            serverPubkey: serverKey,
        });
        const validated = validateLockupSubmission(advance(), await signedEnvelope(), config());
        try {
            expect(await submitter.submit(validated)).toEqual({
                arkTxid: validated.outpoint.txid,
                outpoint: validated.outpoint,
            });
            expect(effects).toBe(1);
            expect(external.finalizeTx).toHaveBeenCalledTimes(1);
            expect(lookup.message).toEqual({ type: "get-pending-tx", expire_at: 0 });
            const proof = Transaction.fromPSBT(base64.decode(lookup.proof));
            expect(proof.inputsLength).toBe(validated.operatorInputIndexes.length + 1);
            for (const [offset, index] of validated.operatorInputIndexes.entries()) {
                const original = validated.unsignedCheckpoints[index]!.getInput(0);
                expect(proof.getInput(offset + 1).txid).toEqual(original.txid);
                expect(proof.getInput(offset + 1).index).toBe(original.index);
                expect(() =>
                    verifyTapscriptSignatures(
                        proof,
                        offset + 1,
                        [hex.encode(operatorKey)],
                        [],
                        [1],
                    ),
                ).not.toThrow();
            }
        } finally {
            server.closeAllConnections();
            await new Promise<void>((resolve) => server.close(() => resolve()));
        }
    });

    it.each([
        "missing",
        "duplicate",
        "wrong txid",
        "missing server signature",
        "changed checkpoint",
    ])("rejects a %s pending lookup response without finalizing", async (failure) => {
        const external = provider();
        const getPendingTxs = vi.fn<ArkProvider["getPendingTxs"]>();
        const submitter = createLockupSubmitter({
            identity: operatorIdentity,
            provider: { ...external, getPendingTxs },
            serverPubkey: serverKey,
        });
        const validated = validateLockupSubmission(advance(), await signedEnvelope(), config());
        const prepared = await submitter.prepare(validated);
        const response = await external.submitTx(
            prepared.arkTx,
            validated.unsignedCheckpoints.map((tx) => base64.encode(tx.toPSBT())),
        );
        let candidates = [response];
        if (failure === "missing") candidates = [];
        if (failure === "duplicate") candidates = [response, response];
        if (failure === "wrong txid") candidates = [{ ...response, arkTxid: "ff".repeat(32) }];
        if (failure === "missing server signature") response.finalArkTx = prepared.arkTx;
        if (failure === "changed checkpoint") {
            const changed = Transaction.fromPSBT(base64.decode(response.signedCheckpointTxs[0]!));
            changed.updateInput(0, { tapScriptSig: undefined });
            changed.updateOutput(0, { amount: changed.getOutput(0).amount! + 1n });
            response.signedCheckpointTxs[0] = base64.encode(
                (await serverIdentity.sign(changed, [0])).toPSBT(),
            );
        }
        getPendingTxs.mockResolvedValue(candidates);
        external.submitTx.mockRejectedValue(new Error("duplicated offchain tx"));
        await expect(submitter.submitPrepared(validated, prepared)).rejects.toThrow();
        expect(getPendingTxs).toHaveBeenCalledTimes(1);
        expect(external.finalizeTx).not.toHaveBeenCalled();
    });

    it.each(["changed input", "missing signature"])(
        "rejects a pending lookup proof with %s before contacting the provider",
        async (failure) => {
            const external = provider();
            const getPendingTxs = vi.fn<ArkProvider["getPendingTxs"]>();
            let lookup = false;
            const identity = Object.assign(Object.create(operatorIdentity), {
                sign: async (tx: Transaction, indexes: number[]) => {
                    if (!lookup) return operatorIdentity.sign(tx, indexes);
                    if (failure === "missing signature") return tx;
                    tx.updateInput(1, { index: tx.getInput(1).index! + 1 });
                    return operatorIdentity.sign(tx, indexes);
                },
            }) as Identity;
            const submitter = createLockupSubmitter({
                identity,
                provider: { ...external, getPendingTxs },
                serverPubkey: serverKey,
            });
            const validated = validateLockupSubmission(advance(), await signedEnvelope(), config());
            const prepared = await submitter.prepare(validated);
            lookup = true;
            external.submitTx.mockRejectedValue(new Error("duplicated offchain tx"));
            await expect(submitter.submitPrepared(validated, prepared)).rejects.toMatchObject({
                permanentCode: "lockup_submission_invalid_pending_proof",
            });
            expect(getPendingTxs).not.toHaveBeenCalled();
            expect(external.finalizeTx).not.toHaveBeenCalled();
        },
    );

    it("signs only independently derived operator ownership and finalizes matched checkpoints", async () => {
        const external = provider();
        const sign = vi.fn(operatorIdentity.sign.bind(operatorIdentity));
        const identity = Object.assign(Object.create(operatorIdentity), { sign }) as Identity;
        const submitter = createLockupSubmitter({
            identity,
            provider: external,
            serverPubkey: serverKey,
        });

        const validated = validateLockupSubmission(advance(), await signedEnvelope(), config());
        const result = await submitter.submit(validated);

        expect(sign.mock.calls[0]?.[1]).toEqual(validated.operatorInputIndexes);
        expect(sign.mock.calls.slice(1).map((call) => call[1])).toEqual([[0]]);
        expect(external.submitTx).toHaveBeenCalledTimes(1);
        expect(external.finalizeTx).toHaveBeenCalledTimes(1);
        expect(result).toEqual({ arkTxid: validated.outpoint.txid, outpoint: validated.outpoint });
    });

    it("rejects a mismatched server txid without finalizing", async () => {
        const external = provider();
        external.submitTx.mockImplementationOnce(async () => ({
            arkTxid: "ff".repeat(32),
            finalArkTx: "bad",
            signedCheckpointTxs: [],
        }));
        const submitter = createLockupSubmitter({
            identity: operatorIdentity,
            provider: external,
            serverPubkey: serverKey,
        });
        await expect(
            submitter.submit(validateLockupSubmission(advance(), await signedEnvelope(), config())),
        ).rejects.toMatchObject({ stage: "submit" });
        expect(external.finalizeTx).not.toHaveBeenCalled();
    });

    it("rejects a server checkpoint response carrying a non-server signature", async () => {
        const external = provider();
        const implementation = external.submitTx.getMockImplementation()!;
        external.submitTx.mockImplementationOnce(async (...args) => {
            const response = await implementation(...args);
            const checkpoint = await senderIdentity.sign(
                Transaction.fromPSBT(base64.decode(response.signedCheckpointTxs[0]!)),
                [0],
            );
            response.signedCheckpointTxs[0] = base64.encode(checkpoint.toPSBT());
            return response;
        });
        const submitter = createLockupSubmitter({
            identity: operatorIdentity,
            provider: external,
            serverPubkey: serverKey,
        });

        await expect(
            submitter.submit(validateLockupSubmission(advance(), await signedEnvelope(), config())),
        ).rejects.toMatchObject({ stage: "submit" });
        expect(external.finalizeTx).not.toHaveBeenCalled();
    });

    it.each(
        [false, true].flatMap((reordered) =>
            ["witnessUtxo", "tapLeafScript", "ark metadata"].map((mutation) => ({
                reordered,
                mutation,
            })),
        ),
    )(
        "rejects a same-txid checkpoint $mutation mutation with a valid recomputed server signature (reordered=$reordered)",
        async ({ mutation, reordered }) => {
            const external = provider();
            const implementation = external.submitTx.getMockImplementation()!;
            external.submitTx.mockImplementationOnce(async (...args) => {
                const response = await implementation(...args);
                const checkpoint = Transaction.fromPSBT(
                    base64.decode(response.signedCheckpointTxs[0]!),
                );
                checkpoint.updateInput(0, { tapScriptSig: undefined });
                const input = checkpoint.getInput(0);
                if (mutation === "witnessUtxo")
                    checkpoint.updateInput(0, {
                        witnessUtxo: {
                            ...input.witnessUtxo!,
                            amount: input.witnessUtxo!.amount + 1n,
                        },
                    });
                if (mutation === "tapLeafScript") {
                    const leaves = structuredClone(input.tapLeafScript!);
                    leaves[0]![0].internalKey = new Uint8Array(32).fill(1);
                    checkpoint.updateInput(0, { tapLeafScript: undefined });
                    checkpoint.updateInput(0, { tapLeafScript: leaves });
                }
                if (mutation === "ark metadata") {
                    const entries = input.unknown!.map((entry) => {
                        const tree = VtxoTaprootTree.decode(entry);
                        if (tree === null) return entry;
                        const changed = Uint8Array.from(tree);
                        changed[0] ^= 1;
                        return VtxoTaprootTree.encode(changed);
                    });
                    checkpoint.updateInput(0, { unknown: entries });
                }
                response.signedCheckpointTxs[0] = base64.encode(
                    (await serverIdentity.sign(checkpoint, [0])).toPSBT(),
                );
                if (reordered) response.signedCheckpointTxs.reverse();
                return response;
            });
            const submitter = createLockupSubmitter({
                identity: operatorIdentity,
                provider: external,
                serverPubkey: serverKey,
            });

            const result = await submitter
                .submit(validateLockupSubmission(advance(), await signedEnvelope(), config()))
                .catch((error: unknown) => error);
            expect(result).toBeInstanceOf(Error);
            expect((result as Error).cause).toMatchObject({
                message: expect.stringMatching(/changed unsigned fields or metadata/),
            });
            expect(result).toMatchObject({
                stage: "submit",
                permanentCode: "lockup_submission_invalid_provider_response",
                cause: expect.objectContaining({
                    message: expect.stringMatching(/changed unsigned fields or metadata/),
                }),
            });
            expect(external.finalizeTx).not.toHaveBeenCalled();
        },
    );

    it.each([false, true])(
        "finalizes each matching graph and owner in local order (reordered=%s)",
        async (reordered) => {
            const external = provider();
            const implementation = external.submitTx.getMockImplementation()!;
            external.submitTx.mockImplementationOnce(async (...args) => {
                const response = await implementation(...args);
                if (reordered) response.signedCheckpointTxs.reverse();
                return response;
            });
            const submitter = createLockupSubmitter({
                identity: operatorIdentity,
                provider: external,
                serverPubkey: serverKey,
            });

            const validated = validateLockupSubmission(advance(), await signedEnvelope(), config());
            const prepared = await submitter.prepare(validated);
            const response = await submitter.submitPrepared(validated, prepared);
            const persisted = structuredClone(response);

            await submitter.finalizePrepared(validated, prepared, persisted);

            expect(external.finalizeTx).toHaveBeenCalledTimes(1);
            const [arkTxid, encoded] = external.finalizeTx.mock.calls[0]!;
            expect(arkTxid).toBe(validated.outpoint.txid);
            const finalized = encoded.map((checkpoint) =>
                Transaction.fromPSBT(base64.decode(checkpoint)),
            );
            expect(finalized.map((checkpoint) => checkpoint.id)).toEqual(
                validated.unsignedCheckpoints.map((checkpoint) => checkpoint.id),
            );
            finalized.forEach((checkpoint, index) => {
                const owner = validated.senderInputIndexes.includes(index)
                    ? senderKey
                    : operatorKey;
                const signatures = checkpoint.getInput(0).tapScriptSig!;
                expect(signatures).toHaveLength(2);
                verifyTapscriptSignatures(
                    checkpoint,
                    0,
                    [hex.encode(serverKey), hex.encode(owner)],
                    [],
                    [0],
                );
                const ownerCheckpoint = Transaction.fromPSBT(
                    base64.decode(prepared.ownerCheckpoints[index]!),
                );
                const serverCheckpoint = response.signedCheckpointTxs
                    .map((value) => Transaction.fromPSBT(base64.decode(value)))
                    .find((value) => value.id === checkpoint.id)!;
                expect(signatures).toEqual(
                    expect.arrayContaining([
                        ...ownerCheckpoint.getInput(0).tapScriptSig!,
                        ...serverCheckpoint.getInput(0).tapScriptSig!,
                    ]),
                );
                checkpoint.updateInput(0, { tapScriptSig: undefined });
                expect(checkpoint.toPSBT()).toEqual(validated.unsignedCheckpoints[index]!.toPSBT());
            });
            expect(persisted).toEqual(response);
        },
    );

    it.each(["duplicate", "missing", "unknown", "cross-associated server signatures"])(
        "rejects a reordered checkpoint list with $0 before finalize",
        async (mutation) => {
            const external = provider();
            const implementation = external.submitTx.getMockImplementation()!;
            external.submitTx.mockImplementationOnce(async (...args) => {
                const response = await implementation(...args);
                if (mutation === "duplicate")
                    response.signedCheckpointTxs[0] = response.signedCheckpointTxs[1]!;
                if (mutation === "missing") response.signedCheckpointTxs.pop();
                if (mutation === "unknown") {
                    const checkpoint = Transaction.fromPSBT(
                        base64.decode(response.signedCheckpointTxs[0]!),
                    );
                    checkpoint.updateInput(0, { tapScriptSig: undefined });
                    checkpoint.updateInput(0, { index: 999 });
                    response.signedCheckpointTxs[0] = base64.encode(
                        (await serverIdentity.sign(checkpoint, [0])).toPSBT(),
                    );
                }
                if (mutation === "cross-associated server signatures") {
                    const checkpoints = response.signedCheckpointTxs.map((value) =>
                        Transaction.fromPSBT(base64.decode(value)),
                    );
                    const signatures = checkpoints.map(
                        (checkpoint) => checkpoint.getInput(0).tapScriptSig!,
                    );
                    checkpoints.forEach((checkpoint, index) => {
                        checkpoint.updateInput(0, { tapScriptSig: undefined });
                        checkpoint.updateInput(0, { tapScriptSig: signatures[1 - index] });
                    });
                    response.signedCheckpointTxs = checkpoints.map((checkpoint) =>
                        base64.encode(checkpoint.toPSBT()),
                    );
                }
                response.signedCheckpointTxs.reverse();
                return response;
            });
            const submitter = createLockupSubmitter({
                identity: operatorIdentity,
                provider: external,
                serverPubkey: serverKey,
            });
            const message =
                mutation === "missing"
                    ? /returned 1 checkpoints, expected 2/
                    : mutation === "cross-associated server signatures"
                      ? /signature verification failed/
                      : /does not match any submitted checkpoint/;

            await expect(
                submitter.submit(
                    validateLockupSubmission(advance(), await signedEnvelope(), config()),
                ),
            ).rejects.toMatchObject({
                stage: "submit",
                permanentCode: "lockup_submission_invalid_provider_response",
                cause: expect.objectContaining({ message: expect.stringMatching(message) }),
            });
            expect(external.finalizeTx).not.toHaveBeenCalled();
        },
    );

    it("rejects cross-associated persisted owner signatures after a reordered response", async () => {
        const external = provider();
        const implementation = external.submitTx.getMockImplementation()!;
        external.submitTx.mockImplementationOnce(async (...args) => {
            const response = await implementation(...args);
            response.signedCheckpointTxs.reverse();
            return response;
        });
        const submitter = createLockupSubmitter({
            identity: operatorIdentity,
            provider: external,
            serverPubkey: serverKey,
        });
        const validated = validateLockupSubmission(advance(), await signedEnvelope(), config());
        const prepared = await submitter.prepare(validated);
        const response = await submitter.submitPrepared(validated, prepared);
        const checkpoints = prepared.ownerCheckpoints.map((value) =>
            Transaction.fromPSBT(base64.decode(value)),
        );
        const signatures = checkpoints.map((checkpoint) => checkpoint.getInput(0).tapScriptSig!);
        checkpoints.forEach((checkpoint, index) => {
            checkpoint.updateInput(0, { tapScriptSig: undefined });
            checkpoint.updateInput(0, { tapScriptSig: signatures[1 - index] });
        });
        prepared.ownerCheckpoints = checkpoints.map((checkpoint) =>
            base64.encode(checkpoint.toPSBT()),
        );

        await expect(
            submitter.finalizePrepared(validated, prepared, response),
        ).rejects.toMatchObject({
            stage: "finalize",
            permanentCode: "lockup_submission_invalid_persisted_artifact",
            cause: expect.objectContaining({ message: expect.stringMatching(/wrong owner/) }),
        });
        expect(external.finalizeTx).not.toHaveBeenCalled();
    });

    it("rejects same-txid final Ark metadata mutation with valid recomputed signatures", async () => {
        const external = provider();
        const implementation = external.submitTx.getMockImplementation()!;
        external.submitTx.mockImplementationOnce(async (...args) => {
            const response = await implementation(...args);
            let changed = Transaction.fromPSBT(base64.decode(response.finalArkTx));
            for (let index = 0; index < changed.inputsLength; index++)
                changed.updateInput(index, { tapScriptSig: undefined });
            const input = changed.getInput(0);
            changed.updateInput(0, {
                witnessUtxo: {
                    ...input.witnessUtxo!,
                    amount: input.witnessUtxo!.amount + 1n,
                },
            });
            changed = await senderIdentity.sign(changed, [0]);
            changed = await operatorIdentity.sign(changed, [1]);
            changed = await serverIdentity.sign(changed, [0, 1]);
            response.finalArkTx = base64.encode(changed.toPSBT());
            return response;
        });
        const submitter = createLockupSubmitter({
            identity: operatorIdentity,
            provider: external,
            serverPubkey: serverKey,
        });

        await expect(
            submitter.submit(validateLockupSubmission(advance(), await signedEnvelope(), config())),
        ).rejects.toMatchObject({ stage: "submit" });
        expect(external.finalizeTx).not.toHaveBeenCalled();
    });

    it("revalidates persisted owner checkpoint signatures before finalize", async () => {
        const external = provider();
        const submitter = createLockupSubmitter({
            identity: operatorIdentity,
            provider: external,
            serverPubkey: serverKey,
        });
        const validated = validateLockupSubmission(advance(), await signedEnvelope(), config());
        const prepared = await submitter.prepare(validated);
        const response = await submitter.submitPrepared(validated, prepared);
        const changed = Transaction.fromPSBT(base64.decode(prepared.ownerCheckpoints[0]!));
        const signatures = structuredClone(changed.getInput(0).tapScriptSig!);
        signatures[0]![1][0] ^= 1;
        changed.updateInput(0, { tapScriptSig: undefined });
        changed.updateInput(0, { tapScriptSig: signatures });

        await expect(
            submitter.finalizePrepared(
                validated,
                {
                    ...prepared,
                    ownerCheckpoints: [
                        base64.encode(changed.toPSBT()),
                        ...prepared.ownerCheckpoints.slice(1),
                    ],
                },
                response,
            ),
        ).rejects.toThrow();
        expect(external.finalizeTx).not.toHaveBeenCalled();
    });

    it("retains the validated ark txid when finalization is ambiguous", async () => {
        const external = provider();
        external.finalizeTx.mockRejectedValueOnce(new Error("timeout"));
        const submitter = createLockupSubmitter({
            identity: operatorIdentity,
            provider: external,
            serverPubkey: serverKey,
        });
        await expect(
            submitter.submit(validateLockupSubmission(advance(), await signedEnvelope(), config())),
        ).rejects.toMatchObject({ stage: "finalize", arkTxid: expect.any(String) });
    });

    it("does not invent an ark txid when submit times out before a response", async () => {
        const external = provider();
        external.submitTx.mockRejectedValueOnce(new Error("timeout"));
        const submitter = createLockupSubmitter({
            identity: operatorIdentity,
            provider: external,
            serverPubkey: serverKey,
        });
        await expect(
            submitter.submit(validateLockupSubmission(advance(), await signedEnvelope(), config())),
        ).rejects.toMatchObject({ stage: "submit", arkTxid: undefined });
        expect(external.finalizeTx).not.toHaveBeenCalled();
    });
});

const claimedAdvance = async (transportEnvelope?: string): Promise<Advance> => {
    const persisted = advance();
    const signed = transportEnvelope ?? (await signedEnvelope());
    const validated = validateLockupSubmission(persisted, signed, config());
    return {
        ...persisted,
        state: "locking",
        submissionKey: `lockup:${persisted.id}:${persisted.unsignedLockupId}`,
        signedEnvelopeDigest: validated.digest,
        signedLockupEnvelope: validated.encoded,
        submissionPhase: "claimed",
        submittedAt: NOW,
    };
};

describe("durable submission resumption", () => {
    it("sanitizes provider credentials before persisting an ambiguous failure", async () => {
        const external = provider();
        external.submitTx.mockRejectedValue(new Error("Authorization: Bearer ghp_PRIVATE_TOKEN"));
        const db = openDatabase(":memory:");
        const advances = new AdvanceRepository(db);
        const claimed = await claimedAdvance();
        advances.insert(claimed);
        const resumer = createSubmissionResumer({
            advances,
            submitter: productionLockupSubmitter(config(), operatorIdentity, external),
            workerId: "sanitizer-worker",
            now: () => NOW + 1,
            leaseSeconds: 30,
            backoffSeconds: 1,
        });

        await resumer.resume(claimed.id);

        expect(advances.get(claimed.id)?.failureDetail).toBe(
            "lockup submit outcome requires reconciliation",
        );
        db.close();
    });

    it.each(["local Uint8Array", "cross-realm Uint8Array", "Buffer"] as const)(
        "accepts signer PSBT bytes from a %s through the durable resumer",
        async (source) => {
            const external = provider();
            const sign = vi.fn<Identity["sign"]>(async (tx, inputIndexes) => {
                const signed = await operatorIdentity.sign(tx, inputIndexes);
                const bytes = signed.toPSBT();
                const result =
                    source === "cross-realm Uint8Array"
                        ? runInNewContext(
                              "const data = Uint8Array.from(bytes); const backing = new Uint8Array(data.length + 7); backing.set(data, 3); backing.subarray(3, 3 + data.length)",
                              { bytes: [...bytes] },
                          )
                        : source === "Buffer"
                          ? Buffer.from(bytes)
                          : (() => {
                                const backing = new Uint8Array(bytes.length + 7);
                                backing.set(bytes, 3);
                                return backing.subarray(3, 3 + bytes.length);
                            })();
                return { toPSBT: () => result } as Transaction;
            });
            const identity = Object.assign(Object.create(operatorIdentity), { sign }) as Identity;
            const db = openDatabase(":memory:");
            const advances = new AdvanceRepository(db);
            const claimed = await claimedAdvance();
            advances.insert(claimed);
            const resumer = createSubmissionResumer({
                advances,
                submitter: productionLockupSubmitter(config(), identity, external),
                workerId: `byte-source-${source}`,
                now: () => NOW + 1,
                leaseSeconds: 30,
                backoffSeconds: 1,
            });

            expect(await resumer.resume(claimed.id)).toBe(true);
            expect(advances.get(claimed.id)?.submissionPhase).toBe("finalized");
            expect(external.submitTx).toHaveBeenCalledTimes(1);
            expect(external.finalizeTx).toHaveBeenCalledTimes(1);
            db.close();
        },
    );

    it.each([
        "non-default signature",
        "invalid signature",
        "undefined transaction",
        "malformed transaction",
        "DataView bytes",
        "Uint16Array bytes",
        "spoofed byte view",
        "accessor byte view",
        "proxied byte view",
        "unsigned mutation",
        "signer rejection",
    ] as const)(
        "permanently quarantines a deterministic %s across ticks and restart",
        async (failure) => {
            const directory = mkdtempSync(join(tmpdir(), "taxi-signer-failure-"));
            const path = join(directory, "state.sqlite");
            const external = provider();
            let byteViewReads = 0;
            const sign = vi.fn<Identity["sign"]>(async (tx, inputIndexes) => {
                if (failure === "signer rejection") throw new Error("operator HSM rejected");
                if (failure === "undefined transaction") return undefined as unknown as Transaction;
                if (failure === "malformed transaction")
                    return { toPSBT: () => new Uint8Array() } as unknown as Transaction;
                if (failure === "DataView bytes")
                    return {
                        toPSBT: () => new DataView(new ArrayBuffer(4)),
                    } as unknown as Transaction;
                if (failure === "Uint16Array bytes")
                    return { toPSBT: () => new Uint16Array(2) } as unknown as Transaction;
                if (failure === "spoofed byte view")
                    return {
                        toPSBT: () => ({
                            [Symbol.toStringTag]: "Uint8Array",
                            byteOffset: 0,
                            byteLength: 4,
                            0: 0x70,
                        }),
                    } as unknown as Transaction;
                if (failure === "accessor byte view")
                    return {
                        toPSBT: () =>
                            Object.defineProperties(
                                {},
                                {
                                    [Symbol.toStringTag]: {
                                        get: () => {
                                            byteViewReads++;
                                            return "Uint8Array";
                                        },
                                    },
                                    byteOffset: {
                                        get: () => {
                                            byteViewReads++;
                                            return 0;
                                        },
                                    },
                                    byteLength: {
                                        get: () => {
                                            byteViewReads++;
                                            return 4;
                                        },
                                    },
                                },
                            ),
                    } as unknown as Transaction;
                if (failure === "proxied byte view")
                    return {
                        toPSBT: () =>
                            new Proxy(new Uint8Array(4), {
                                get: (target, key, receiver) => {
                                    byteViewReads++;
                                    return Reflect.get(target, key, receiver);
                                },
                            }),
                    } as unknown as Transaction;

                const signed = await operatorIdentity.sign(tx, inputIndexes);
                const index = inputIndexes?.[0] ?? 0;
                if (failure === "unsigned mutation") {
                    signed.updateInput(index, { tapScriptSig: undefined });
                    const input = signed.getInput(index);
                    signed.updateInput(index, {
                        witnessUtxo: {
                            ...input.witnessUtxo!,
                            amount: input.witnessUtxo!.amount + 1n,
                        },
                    });
                    return operatorIdentity.sign(signed, inputIndexes);
                }

                const signatures = structuredClone(signed.getInput(index).tapScriptSig!);
                if (failure === "non-default signature")
                    signatures[0]![1] = Uint8Array.from([...signatures[0]![1], 1]);
                else signatures[0]![1][0] ^= 1;
                signed.updateInput(index, { tapScriptSig: undefined });
                signed.updateInput(index, { tapScriptSig: signatures });
                return signed;
            });
            const identity = Object.assign(Object.create(operatorIdentity), { sign }) as Identity;
            let db: ReturnType<typeof openDatabase> | undefined;
            try {
                db = openDatabase(path);
                let advances = new AdvanceRepository(db);
                let policy = new PolicyRepository(db);
                let reservations = new ReservationRepository(db);
                policy.update(basePolicy(), "test");
                const persisted = advance();
                reservations.reserveQuote({
                    advance: persisted,
                    expectedPolicyRevision: policy.getSnapshot().revision,
                    recoveryExecutionBudget: { kind: "height", value: 1n },
                });
                const validated = validateLockupSubmission(
                    persisted,
                    await signedEnvelope(),
                    config(),
                );
                reservations.claimLockup(
                    persisted.id,
                    validated.unsignedTxId,
                    validated.digest,
                    validated.encoded,
                    () => NOW + 1,
                );
                const make = (now: number) =>
                    createSubmissionResumer({
                        advances,
                        submitter: productionLockupSubmitter(config(), identity, external),
                        workerId: `failed-signer-${failure}`,
                        now: () => now,
                        leaseSeconds: 30,
                        backoffSeconds: 1,
                    });

                expect(await make(NOW + 2).resume(persisted.id)).toBe(false);
                db.close();
                db = openDatabase(path);
                advances = new AdvanceRepository(db);
                policy = new PolicyRepository(db);
                reservations = new ReservationRepository(db);
                expect(await make(NOW + 1_000).resume(persisted.id)).toBe(false);

                expect(sign).toHaveBeenCalledTimes(1);
                if (failure === "accessor byte view" || failure === "proxied byte view")
                    expect(byteViewReads).toBe(0);
                expect(external.submitTx).not.toHaveBeenCalled();
                expect(external.finalizeTx).not.toHaveBeenCalled();
                expect(advances.get(persisted.id)).toMatchObject({
                    submissionPhase: "failed",
                    failureCode: "lockup_submission_invalid_prepared_artifact",
                });
                expect(reservations.listForAdvance(persisted.id)).toEqual(persisted.operatorInputs);
                expect(policy.get().paused).toBe(true);
                const reconciler = createLockupReconciler({
                    advances,
                    reservations,
                    policy,
                    submission: make(NOW + 1_000),
                    indexer: { getVtxos: async () => ({ vtxos: [] }) },
                    now: () => NOW + 1_000,
                    clock: () => ({ height: 700_000, timestamp: new Date(NOW * 1_000) }),
                });
                expect(reconciler.status().blockers).toEqual([
                    "lockup_submission_invalid_prepared_artifact",
                ]);
                db.close();
                db = undefined;
            } finally {
                db?.close();
                rmSync(directory, { recursive: true, force: true });
            }
        },
    );

    it("persists and resumes canonical bytes from a pretty transport envelope", async () => {
        const signed = await signedEnvelope();
        const pretty = base64.encode(
            new TextEncoder().encode(
                JSON.stringify(
                    JSON.parse(new TextDecoder().decode(base64.decode(signed))),
                    null,
                    2,
                ),
            ),
        );
        const directory = mkdtempSync(join(tmpdir(), "taxi-canonical-"));
        const path = join(directory, "state.sqlite");
        const external = provider();
        try {
            let db = openDatabase(path);
            const claimed = await claimedAdvance(pretty);
            expect(claimed.signedLockupEnvelope).not.toBe(pretty);
            new AdvanceRepository(db).insert(claimed);
            db.close();
            db = openDatabase(path);
            const advances = new AdvanceRepository(db);
            const resumer = createSubmissionResumer({
                advances,
                submitter: productionLockupSubmitter(config(), operatorIdentity, external),
                workerId: "canonical-worker",
                now: () => NOW + 1,
                leaseSeconds: 30,
                backoffSeconds: 1,
            });
            expect(await resumer.resume(claimed.id)).toBe(true);
            expect(advances.get(claimed.id)?.submissionPhase).toBe("finalized");
            db.close();
        } finally {
            rmSync(directory, { recursive: true, force: true });
        }
    });

    it("heartbeats a slow provider phase so another connection cannot take over", async () => {
        const directory = mkdtempSync(join(tmpdir(), "taxi-heartbeat-"));
        const path = join(directory, "state.sqlite");
        const external = provider();
        const implementation = external.submitTx.getMockImplementation()!;
        let release!: () => void;
        const blocked = new Promise<void>((resolve) => {
            release = resolve;
        });
        let started!: () => void;
        const submitted = new Promise<void>((resolve) => {
            started = resolve;
        });
        external.submitTx.mockImplementation(async (...args) => {
            started();
            await blocked;
            return implementation(...args);
        });
        let dbA: ReturnType<typeof openDatabase> | undefined;
        let dbB: ReturnType<typeof openDatabase> | undefined;
        try {
            dbA = openDatabase(path);
            dbB = openDatabase(path);
            const advancesA = new AdvanceRepository(dbA);
            advancesA.insert(await claimedAdvance());
            const submitter = productionLockupSubmitter(config(), operatorIdentity, external);
            const make = (advances: AdvanceRepository, workerId: string) =>
                createSubmissionResumer({
                    advances,
                    submitter,
                    workerId,
                    now: () => Date.now() / 1000,
                    leaseSeconds: 1,
                    backoffSeconds: 1,
                });

            const first = make(advancesA, "slow-worker").resume(buildRequest().advanceId);
            await submitted;
            await new Promise((resolve) => setTimeout(resolve, 1_200));
            const second = make(new AdvanceRepository(dbB), "takeover-worker").resume(
                buildRequest().advanceId,
            );
            await new Promise((resolve) => setTimeout(resolve, 100));
            const callsBeforeRelease = external.submitTx.mock.calls.length;
            release();
            const results = await Promise.all([first, second]);
            expect(callsBeforeRelease).toBe(1);
            expect(results).toEqual([true, false]);
            dbA.close();
            dbB.close();
            dbA = undefined;
            dbB = undefined;
        } finally {
            release();
            dbA?.close();
            dbB?.close();
            rmSync(directory, { recursive: true, force: true });
        }
    });

    it("heartbeats a slow signer so another connection cannot prepare", async () => {
        const directory = mkdtempSync(join(tmpdir(), "taxi-signer-heartbeat-"));
        const path = join(directory, "state.sqlite");
        let release!: () => void;
        const blocked = new Promise<void>((resolve) => {
            release = resolve;
        });
        let started!: () => void;
        const signing = new Promise<void>((resolve) => {
            started = resolve;
        });
        const sign = vi.fn<Identity["sign"]>(async (...args) => {
            if (sign.mock.calls.length === 1) {
                started();
                await blocked;
            }
            return operatorIdentity.sign(...args);
        });
        const identity = Object.assign(Object.create(operatorIdentity), { sign }) as Identity;
        let dbA: ReturnType<typeof openDatabase> | undefined;
        let dbB: ReturnType<typeof openDatabase> | undefined;
        try {
            dbA = openDatabase(path);
            dbB = openDatabase(path);
            const advancesA = new AdvanceRepository(dbA);
            advancesA.insert(await claimedAdvance());
            const submitter = productionLockupSubmitter(config(), identity, provider());
            const make = (advances: AdvanceRepository, workerId: string) =>
                createSubmissionResumer({
                    advances,
                    submitter,
                    workerId,
                    now: () => Date.now() / 1000,
                    leaseSeconds: 1,
                    backoffSeconds: 1,
                });
            const first = make(advancesA, "slow-signer").resume(buildRequest().advanceId);
            await signing;
            await new Promise((resolve) => setTimeout(resolve, 1_200));
            const second = make(new AdvanceRepository(dbB), "signer-takeover").resume(
                buildRequest().advanceId,
            );
            await new Promise((resolve) => setTimeout(resolve, 100));
            const callsBeforeRelease = sign.mock.calls.length;
            release();
            expect(await Promise.all([first, second])).toEqual([true, false]);
            expect(callsBeforeRelease).toBe(1);
            dbA.close();
            dbB.close();
            dbA = undefined;
            dbB = undefined;
        } finally {
            release();
            dbA?.close();
            dbB?.close();
            rmSync(directory, { recursive: true, force: true });
        }
    });

    it("heartbeats slow finalize so another connection cannot finalize", async () => {
        const directory = mkdtempSync(join(tmpdir(), "taxi-finalize-heartbeat-"));
        const path = join(directory, "state.sqlite");
        const external = provider();
        let release!: () => void;
        const blocked = new Promise<void>((resolve) => {
            release = resolve;
        });
        let started!: () => void;
        const finalizing = new Promise<void>((resolve) => {
            started = resolve;
        });
        external.finalizeTx.mockImplementation(async () => {
            started();
            await blocked;
        });
        let dbA: ReturnType<typeof openDatabase> | undefined;
        let dbB: ReturnType<typeof openDatabase> | undefined;
        try {
            dbA = openDatabase(path);
            dbB = openDatabase(path);
            const advancesA = new AdvanceRepository(dbA);
            advancesA.insert(await claimedAdvance());
            const submitter = productionLockupSubmitter(config(), operatorIdentity, external);
            const make = (advances: AdvanceRepository, workerId: string) =>
                createSubmissionResumer({
                    advances,
                    submitter,
                    workerId,
                    now: () => Date.now() / 1000,
                    leaseSeconds: 1,
                    backoffSeconds: 1,
                });
            const first = make(advancesA, "slow-finalize").resume(buildRequest().advanceId);
            await finalizing;
            await new Promise((resolve) => setTimeout(resolve, 1_200));
            const second = make(new AdvanceRepository(dbB), "finalize-takeover").resume(
                buildRequest().advanceId,
            );
            await new Promise((resolve) => setTimeout(resolve, 100));
            const callsBeforeRelease = external.finalizeTx.mock.calls.length;
            release();
            expect(await Promise.all([first, second])).toEqual([true, false]);
            expect(callsBeforeRelease).toBe(1);
            expect(external.submitTx).toHaveBeenCalledTimes(1);
            dbA.close();
            dbB.close();
            dbA = undefined;
            dbB = undefined;
        } finally {
            release();
            dbA?.close();
            dbB?.close();
            rmSync(directory, { recursive: true, force: true });
        }
    });

    it("resumes a claimed envelope after a real SQLite restart", async () => {
        const directory = mkdtempSync(join(tmpdir(), "taxi-submit-"));
        const path = join(directory, "state.sqlite");
        const external = provider();
        try {
            let db = openDatabase(path);
            new AdvanceRepository(db).insert(await claimedAdvance());
            db.close();
            db = openDatabase(path);
            const advances = new AdvanceRepository(db);
            const submitter = productionLockupSubmitter(config(), operatorIdentity, external);
            const resumer = createSubmissionResumer({
                advances,
                submitter,
                workerId: "restart-worker",
                now: () => NOW + 1,
                leaseSeconds: 30,
                backoffSeconds: 1,
            });

            await expect(resumer.resume(buildRequest().advanceId)).resolves.toBe(true);
            expect(advances.get(buildRequest().advanceId)).toMatchObject({
                submissionPhase: "finalized",
                preparedArkTx: expect.any(String),
                preparedCheckpoints: expect.any(Array),
                serverFinalArkTx: expect.any(String),
                serverCheckpoints: expect.any(Array),
                finalizedAt: NOW + 1,
            });
            expect(external.submitTx).toHaveBeenCalledTimes(1);
            expect(external.finalizeTx).toHaveBeenCalledTimes(1);
            db.close();
        } finally {
            rmSync(directory, { recursive: true, force: true });
        }
    });

    it("retries the exact prepared payload after a submit effect loses its response", async () => {
        const external = provider();
        const implementation = external.submitTx.getMockImplementation()!;
        let response: Awaited<ReturnType<ArkProvider["submitTx"]>> | undefined;
        external.submitTx.mockImplementation(async (...args) => {
            response ??= await implementation(...args);
            if (external.submitTx.mock.calls.length <= 4) throw new Error("response lost");
            return response;
        });
        const db = openDatabase(":memory:");
        const advances = new AdvanceRepository(db);
        advances.insert(await claimedAdvance());
        const submitter = productionLockupSubmitter(config(), operatorIdentity, external);
        let now = NOW + 1;
        const resumer = createSubmissionResumer({
            advances,
            submitter,
            workerId: "retry-worker",
            now: () => now,
            leaseSeconds: 30,
            backoffSeconds: 1,
            maxBackoffSeconds: 4,
        });

        expect(await resumer.resume(buildRequest().advanceId)).toBe(false);
        expect(advances.get(buildRequest().advanceId)?.submissionNextAttemptAt).toBe(NOW + 2);
        now = NOW + 2;
        expect(await resumer.resume(buildRequest().advanceId)).toBe(false);
        expect(advances.get(buildRequest().advanceId)?.submissionNextAttemptAt).toBe(NOW + 4);
        now = NOW + 4;
        expect(await resumer.resume(buildRequest().advanceId)).toBe(false);
        expect(advances.get(buildRequest().advanceId)?.submissionNextAttemptAt).toBe(NOW + 8);
        now = NOW + 8;
        expect(await resumer.resume(buildRequest().advanceId)).toBe(false);
        expect(advances.get(buildRequest().advanceId)?.submissionNextAttemptAt).toBe(NOW + 12);
        now = NOW + 12;
        expect(await resumer.resume(buildRequest().advanceId)).toBe(true);
        expect(external.submitTx).toHaveBeenCalledTimes(5);
        for (const call of external.submitTx.mock.calls.slice(1))
            expect(call).toEqual(external.submitTx.mock.calls[0]);
        expect(advances.get(buildRequest().advanceId)?.submissionPhase).toBe("finalized");
        db.close();
    });

    it("stops retrying a malicious provider response and pauses admission", async () => {
        const external = provider();
        external.submitTx.mockResolvedValue({
            arkTxid: "ff".repeat(32),
            finalArkTx: "invalid",
            signedCheckpointTxs: [],
        });
        const db = openDatabase(":memory:");
        const advances = new AdvanceRepository(db);
        const policy = new PolicyRepository(db);
        advances.insert(await claimedAdvance());
        let now = NOW + 1;
        const resumer = createSubmissionResumer({
            advances,
            submitter: productionLockupSubmitter(config(), operatorIdentity, external),
            workerId: "validation-worker",
            now: () => now,
            leaseSeconds: 30,
            backoffSeconds: 1,
        });

        expect(await resumer.resume(buildRequest().advanceId)).toBe(false);
        expect(advances.get(buildRequest().advanceId)).toMatchObject({
            submissionPhase: "failed",
            failureCode: "lockup_submission_invalid_provider_response",
            failureDetail: expect.stringMatching(/txid/i),
        });
        expect(policy.get().paused).toBe(true);
        now += 1_000;
        expect(await resumer.resume(buildRequest().advanceId)).toBe(false);
        expect(external.submitTx).toHaveBeenCalledTimes(1);
        expect(external.finalizeTx).not.toHaveBeenCalled();
        db.close();
    });

    it("does not persist a provider result after heartbeat renewal loses its token", async () => {
        const external = provider();
        const implementation = external.submitTx.getMockImplementation()!;
        external.submitTx.mockImplementation(async (...args) => {
            await new Promise((resolve) => setTimeout(resolve, 100));
            return implementation(...args);
        });
        const db = openDatabase(":memory:");
        const advances = new AdvanceRepository(db);
        advances.insert(await claimedAdvance());
        let renewals = 0;
        const store = {
            get: advances.get.bind(advances),
            claimSubmissionLease: advances.claimSubmissionLease.bind(advances),
            renewSubmissionLease: (
                ...args: Parameters<AdvanceRepository["renewSubmissionLease"]>
            ) => (++renewals === 4 ? false : advances.renewSubmissionLease(...args)),
            recordPreparedSubmission: advances.recordPreparedSubmission.bind(advances),
            recordSubmissionResponse: advances.recordSubmissionResponse.bind(advances),
            recordSubmissionFinalized: advances.recordSubmissionFinalized.bind(advances),
            recordSubmissionAttemptFailure: advances.recordSubmissionAttemptFailure.bind(advances),
            recordPermanentSubmissionFailure:
                advances.recordPermanentSubmissionFailure.bind(advances),
        };
        const resumer = createSubmissionResumer({
            advances: store,
            submitter: productionLockupSubmitter(config(), operatorIdentity, external),
            workerId: "lost-renewal-worker",
            now: () => Date.now() / 1000,
            leaseSeconds: 0.15,
            backoffSeconds: 1,
        });

        expect(await resumer.resume(buildRequest().advanceId)).toBe(false);
        expect(advances.get(buildRequest().advanceId)).toMatchObject({
            submissionPhase: "prepared",
        });
        expect(advances.get(buildRequest().advanceId)?.serverFinalArkTx).toBeUndefined();
        expect(external.submitTx).toHaveBeenCalledTimes(1);
        expect(external.finalizeTx).not.toHaveBeenCalled();
        db.close();
    });

    it("does not start or persist when the initial lease renewal cannot be confirmed", async () => {
        const external = provider();
        const db = openDatabase(":memory:");
        const advances = new AdvanceRepository(db);
        advances.insert(await claimedAdvance());
        const store = {
            get: advances.get.bind(advances),
            claimSubmissionLease: advances.claimSubmissionLease.bind(advances),
            renewSubmissionLease: () => {
                throw new Error("sqlite unavailable");
            },
            recordPreparedSubmission: advances.recordPreparedSubmission.bind(advances),
            recordSubmissionResponse: advances.recordSubmissionResponse.bind(advances),
            recordSubmissionFinalized: advances.recordSubmissionFinalized.bind(advances),
            recordSubmissionAttemptFailure: advances.recordSubmissionAttemptFailure.bind(advances),
            recordPermanentSubmissionFailure:
                advances.recordPermanentSubmissionFailure.bind(advances),
        };
        const resumer = createSubmissionResumer({
            advances: store,
            submitter: productionLockupSubmitter(config(), operatorIdentity, external),
            workerId: "renewal-error-worker",
            now: () => NOW + 1,
            leaseSeconds: 30,
            backoffSeconds: 1,
        });

        expect(await resumer.resume(buildRequest().advanceId)).toBe(false);
        expect(advances.get(buildRequest().advanceId)?.submissionPhase).toBe("claimed");
        expect(advances.get(buildRequest().advanceId)?.submissionAttempts).toBeUndefined();
        expect(advances.get(buildRequest().advanceId)?.failureCode).toBeUndefined();
        expect(external.submitTx).not.toHaveBeenCalled();
        db.close();
    });

    it("quarantines corrupted persisted response before a second finalize attempt", async () => {
        const external = provider();
        external.finalizeTx.mockRejectedValueOnce(new Error("finalize timeout"));
        const db = openDatabase(":memory:");
        const advances = new AdvanceRepository(db);
        const policy = new PolicyRepository(db);
        advances.insert(await claimedAdvance());
        let now = NOW + 1;
        const resumer = createSubmissionResumer({
            advances,
            submitter: productionLockupSubmitter(config(), operatorIdentity, external),
            workerId: "persisted-validation-worker",
            now: () => now,
            leaseSeconds: 30,
            backoffSeconds: 1,
        });
        expect(await resumer.resume(buildRequest().advanceId)).toBe(false);
        expect(advances.get(buildRequest().advanceId)?.submissionPhase).toBe("responded");
        db.prepare("UPDATE advances SET server_final_ark_tx = 'invalid' WHERE id = ?").run(
            buildRequest().advanceId,
        );
        now++;

        expect(await resumer.resume(buildRequest().advanceId)).toBe(false);
        expect(advances.get(buildRequest().advanceId)).toMatchObject({
            submissionPhase: "failed",
            failureCode: "lockup_submission_invalid_persisted_artifact",
        });
        expect(policy.get().paused).toBe(true);
        expect(external.submitTx).toHaveBeenCalledTimes(1);
        expect(external.finalizeTx).toHaveBeenCalledTimes(1);
        db.close();
    });

    it("does not re-sign a prepared payload after a real SQLite restart", async () => {
        const directory = mkdtempSync(join(tmpdir(), "taxi-prepared-"));
        const path = join(directory, "state.sqlite");
        const external = provider();
        const sign = vi.fn(operatorIdentity.sign.bind(operatorIdentity));
        const identity = Object.assign(Object.create(operatorIdentity), { sign }) as Identity;
        const submitter = productionLockupSubmitter(config(), identity, external);
        try {
            let db = openDatabase(path);
            let advances = new AdvanceRepository(db);
            const claimed = await claimedAdvance();
            advances.insert(claimed);
            expect(
                advances.claimSubmissionLease(
                    claimed.id,
                    "prepare-worker",
                    "prepare-token",
                    NOW,
                    NOW + 30,
                ),
            ).toBeDefined();
            const validated = submitter.validate(claimed, claimed.signedLockupEnvelope!);
            const prepared = await submitter.prepare(validated);
            expect(
                advances.recordPreparedSubmission(
                    claimed.id,
                    "prepare-worker",
                    "prepare-token",
                    prepared.arkTx,
                    prepared.ownerCheckpoints,
                    NOW,
                ),
            ).toBe(true);
            const callsAfterPrepare = sign.mock.calls.length;
            db.close();

            db = openDatabase(path);
            advances = new AdvanceRepository(db);
            const resumer = createSubmissionResumer({
                advances,
                submitter,
                workerId: "restart-worker",
                now: () => NOW + 31,
                leaseSeconds: 30,
                backoffSeconds: 1,
            });
            expect(await resumer.resume(claimed.id)).toBe(true);
            expect(sign).toHaveBeenCalledTimes(callsAfterPrepare);
            expect(external.submitTx.mock.calls[0]?.[0]).toBe(prepared.arkTx);
            expect(advances.get(claimed.id)?.submissionPhase).toBe("finalized");
            db.close();
        } finally {
            rmSync(directory, { recursive: true, force: true });
        }
    });

    it("resumes persisted response at finalize and leases concurrent workers", async () => {
        const external = provider();
        external.finalizeTx.mockRejectedValueOnce(new Error("finalize timeout"));
        const directory = mkdtempSync(join(tmpdir(), "taxi-finalize-"));
        const path = join(directory, "state.sqlite");
        try {
            let db = openDatabase(path);
            const first = new AdvanceRepository(db);
            first.insert(await claimedAdvance());
            const submitter = productionLockupSubmitter(config(), operatorIdentity, external);
            let now = NOW + 1;
            const initial = createSubmissionResumer({
                advances: first,
                submitter,
                workerId: "initial-worker",
                now: () => now,
                leaseSeconds: 30,
                backoffSeconds: 1,
            });
            expect(await initial.resume(buildRequest().advanceId)).toBe(false);
            expect(first.get(buildRequest().advanceId)?.submissionPhase).toBe("responded");
            expect(external.submitTx).toHaveBeenCalledTimes(1);
            db.close();

            now++;
            const dbA = openDatabase(path);
            const dbB = openDatabase(path);
            const make = (advances: AdvanceRepository, workerId: string) =>
                createSubmissionResumer({
                    advances,
                    submitter,
                    workerId,
                    now: () => now,
                    leaseSeconds: 30,
                    backoffSeconds: 1,
                });
            const results = await Promise.all([
                make(new AdvanceRepository(dbA), "worker-a").resume(buildRequest().advanceId),
                make(new AdvanceRepository(dbB), "worker-b").resume(buildRequest().advanceId),
            ]);
            expect(results.filter(Boolean)).toHaveLength(1);
            expect(external.submitTx).toHaveBeenCalledTimes(1);
            expect(external.finalizeTx).toHaveBeenCalledTimes(2);
            expect(new AdvanceRepository(dbA).get(buildRequest().advanceId)?.submissionPhase).toBe(
                "finalized",
            );
            dbA.close();
            dbB.close();
        } finally {
            rmSync(directory, { recursive: true, force: true });
        }
    });

    it("does not write a late finalize response after shutdown starts", async () => {
        const external = provider();
        let release!: () => void;
        const gate = new Promise<void>((resolve) => {
            release = resolve;
        });
        external.finalizeTx.mockImplementation(() => gate);
        const db = openDatabase(":memory:");
        const advances = new AdvanceRepository(db);
        const claimed = await claimedAdvance();
        advances.insert(claimed);
        const resumer = createSubmissionResumer({
            advances,
            submitter: productionLockupSubmitter(config(), operatorIdentity, external),
            workerId: "shutdown-worker",
            now: () => NOW + 1,
            leaseSeconds: 30,
            backoffSeconds: 1,
        });

        const pending = resumer.resume(claimed.id);
        await vi.waitFor(() => expect(external.finalizeTx).toHaveBeenCalledOnce());
        resumer.stop();
        const draining = resumer.drain();
        release();

        await expect(pending).resolves.toBe(false);
        await expect(draining).resolves.toBeUndefined();
        expect(advances.get(claimed.id)?.submissionPhase).toBe("responded");
        db.close();
    });
});
