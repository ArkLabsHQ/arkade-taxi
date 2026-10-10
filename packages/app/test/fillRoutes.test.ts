import { beforeAll, describe, expect, it, vi } from "vitest";
import { base64, hex } from "@scure/base";
import {
    ArkAddress,
    Extension,
    P2A,
    Transaction,
    VtxoScript,
    VtxoTaprootTree,
    asset,
    scriptFromTapLeafScript,
    setArkPsbtField,
    SingleKey,
    type ExtendedVirtualCoin,
    type Identity,
    type VirtualCoin,
} from "@arkade-os/sdk";
import {
    AdvanceRepository,
    FillRepository,
    openDatabase,
    PolicyRepository,
    ReceiveQuoteRepository,
    type Database,
} from "@arkade-taxi/db";
import { submitFill, getFill, type FillDeps } from "../src/fills.js";
import type { ServiceError } from "../src/errors.js";
import { NOW, operatorPrivkey, runtimeSafety, serverUnroll } from "./fixtures.js";
import { insertReceiveQuote } from "./jointFillFixtures.js";
import { asIndexed } from "./graphFixtures.js";
import { receiverPaidFill, solverPrivkey } from "./realFillFixtures.js";

const state = vi.hoisted(() => ({
    contractVtxos: [] as unknown[],
    prevTxs: new Map<string, string>(),
    serverKey: "",
    checkpoint: "",
}));

vi.mock("@arkade-os/sdk", async (importOriginal) => {
    const mod = await importOriginal<typeof import("@arkade-os/sdk")>();
    return {
        ...mod,
        RestArkProvider: class {
            async getInfo() {
                return {
                    signerPubkey: `02${state.serverKey}`,
                    checkpointTapscript: state.checkpoint,
                };
            }
        },
        RestIndexerProvider: class {
            async getVtxos() {
                return { vtxos: state.contractVtxos };
            }
            async getVirtualTxs(txids: string[]) {
                return {
                    txs: txids
                        .map((t) => state.prevTxs.get(t))
                        .filter((p): p is string => p !== undefined),
                };
            }
        },
    };
});

const txOf = (psbt: string): Transaction => Transaction.fromPSBT(base64.decode(psbt));
const psbtOf = (tx: Transaction): string => base64.encode(tx.toPSBT());
const point = (o: { txid: string; vout: number }): string => `${o.txid}:${o.vout}`;
const same = (a: Uint8Array, b: Uint8Array): boolean => hex.encode(a) === hex.encode(b);

interface Built {
    arkTx: string;
    checkpoints: string[];
    taxiIndex: number;
    changeVout: number;
    solverVout: number;
    operatorCoin: ExtendedVirtualCoin;
    coins: ExtendedVirtualCoin[];
    operatorScript: Uint8Array;
    solverIndex: number;
}

let built: Built;

beforeAll(async () => {
    const fill = receiverPaidFill(state);
    try {
        const quoted = await fill.buildGraph();
        const operatorScript = new ArkAddress(
            fill.cfg.serverPubkey,
            fill.cfg.operatorKey,
            fill.cfg.addressHrp,
        ).pkScript;
        const owners = quoted.graph.inputs.map((input) => input.owner);
        built = {
            arkTx: quoted.graph.arkTx,
            checkpoints: [...quoted.graph.checkpoints],
            taxiIndex: owners.indexOf("sponsor"),
            solverIndex: owners.indexOf("solver"),
            changeVout: quoted.graph.outputs.find((o) =>
                same(hex.decode(o.script), operatorScript),
            )!.vout,
            solverVout: quoted.graph.outputs.find(
                (o) => o.vout !== 0 && !same(hex.decode(o.script), operatorScript),
            )!.vout,
            operatorCoin: fill.operatorCoin,
            coins: [fill.operatorCoin, fill.deposit, fill.solver],
            operatorScript,
        };
    } finally {
        fill.db.close();
    }
});

interface Harness {
    deps: FillDeps;
    db: Database;
    quoteId: string;
    body: Record<string, unknown>;
    emulatorCalls: number;
    arkCalls: number;
}

const open = (): Harness => {
    const inserted = insertReceiveQuote({
        wantAmount: 5n,
        receiverFare: { currency: "sats", units: 4n },
        operatorCoin: built.operatorCoin,
    });
    const indexed = new Map<string, VirtualCoin>(
        built.coins.map((coin) => [point(coin), asIndexed(coin)]),
    );
    // The real signer for the operator tree the reserved coin pays to. A stub
    // that adds no signature is refused by the signing module, as it should be.
    const identity = SingleKey.fromPrivateKey(operatorPrivkey) as unknown as Identity;
    const harness: Harness = {
        db: inserted.db,
        quoteId: inserted.quoteId,
        emulatorCalls: 0,
        arkCalls: 0,
        body: {
            operationId: "op-fill-1",
            quoteId: inserted.quoteId,
            arkTx: built.arkTx,
            checkpoints: [...built.checkpoints],
            taxiInputIndexes: [built.taxiIndex],
            covenantOutputIndex: 0,
            assetUnits: "5",
        },
        deps: {
            runtime: {
                assertAdmission: async () => {},
                withAdmission: async (work) => work(() => {}),
                safety: () => runtimeSafety(),
            },
            policy: inserted.policies,
            fills: new FillRepository(inserted.db),
            receiveQuotes: new ReceiveQuoteRepository(inserted.db),
            inventory: { getLockedVtxoOutpoints: async () => [] },
            senderInventory: {
                getVtxos: async (opts) => ({
                    vtxos: (opts?.outpoints ?? [])
                        .map((o) => indexed.get(point(o))!)
                        .filter(Boolean),
                }),
            },
            config: inserted.cfg,
            now: () => NOW,
            nowMs: () => NOW * 1000,
            randomId: () => "fill-route",
            taxiIdentity: () => identity,
            emulator: {
                submitTx: async () => {
                    harness.emulatorCalls += 1;
                    throw new Error("emulator reached");
                },
            },
            arkProvider: {
                submitTx: async () => {
                    harness.arkCalls += 1;
                    throw new Error("arkd reached");
                },
                finalizeTx: async () => {},
            },
            providerLimits: async () => ({ vtxoMaxAmount: 10_000_000n }),
            getServerUnroll: () => serverUnroll,
            leaseSeconds: 60,
        },
    };
    return harness;
};

/** The named code a refused body answers with, and its HTTP status. */
const refusal = async (
    over: Record<string, unknown>,
): Promise<{ code: string; status: number }> => {
    const h = open();
    try {
        const error = (await submitFill(h.deps, { ...h.body, ...over }).then(
            () => undefined,
            (e: unknown) => e as ServiceError,
        )) as ServiceError | undefined;
        if (!error) throw new Error("the route accepted a fill it must refuse");
        return { code: error.code, status: error.status };
    } finally {
        h.db.close();
    }
};

const mutated = (mutate: (arkTx: Transaction) => Transaction): Record<string, unknown> => ({
    arkTx: psbtOf(mutate(txOf(built.arkTx))),
});

const repointArkInput = (arkTx: Transaction, index: number, txid: string): Transaction => {
    const out = new Transaction({ version: 3, lockTime: 0 });
    for (let i = 0; i < arkTx.inputsLength; i++) {
        const input = arkTx.getInput(i);
        out.addInput(i === index ? { ...input, txid: hex.decode(txid) } : input);
    }
    for (let i = 0; i < arkTx.outputsLength; i++) out.addOutput(arkTx.getOutput(i));
    return out;
};

const taxiCheckpoint = (coin: ExtendedVirtualCoin, outputScript?: Uint8Array): Transaction => {
    const leaf = scriptFromTapLeafScript(coin.forfeitTapLeafScript);
    const tree = new VtxoScript([serverUnroll.script, leaf]);
    const cp = new Transaction({ version: 3, lockTime: 0 });
    cp.addInput({
        txid: coin.txid,
        index: coin.vout,
        witnessUtxo: {
            script: VtxoScript.decode(coin.tapTree).pkScript,
            amount: BigInt(coin.value),
        },
        tapLeafScript: [coin.forfeitTapLeafScript],
    });
    setArkPsbtField(cp, 0, VtxoTaprootTree, coin.tapTree);
    cp.addOutput({ amount: BigInt(coin.value), script: outputScript ?? tree.pkScript });
    cp.addOutput(P2A);
    return cp;
};

const packetOf = (arkTx: Transaction): asset.Packet => {
    const found = Extension.fromTx(arkTx).getAssetPacket();
    if (!found) throw new Error("fixture graph carries no asset packet");
    return found;
};

const withPacket = (arkTx: Transaction, next: asset.Packet): Transaction => {
    const packets = Extension.fromTx(arkTx)
        .getPackets()
        .map((packet) => (packet.type() === asset.Packet.PACKET_TYPE ? next : packet));
    const replacement = Extension.create([...packets]).txOut();
    const out = new Transaction({ version: 3, lockTime: 0 });
    for (let i = 0; i < arkTx.inputsLength; i++) out.addInput(arkTx.getInput(i));
    for (let i = 0; i < arkTx.outputsLength; i++) {
        const output = arkTx.getOutput(i);
        out.addOutput(output.script && Extension.isExtension(output.script) ? replacement : output);
    }
    return out;
};

const regroup = (
    group: asset.AssetGroup,
    over: { inputs?: asset.AssetInput[]; outputs?: asset.AssetOutput[] },
): asset.Packet =>
    asset.Packet.create([
        asset.AssetGroup.create(
            group.assetId,
            group.controlAsset,
            over.inputs ?? group.inputs,
            over.outputs ?? group.outputs,
            [],
        ),
    ]);

const appendValueOutput = (
    arkTx: Transaction,
    output: { script: Uint8Array; amount: bigint },
): { tx: Transaction; vout: number } => {
    const out = new Transaction({ version: 3, lockTime: 0 });
    for (let i = 0; i < arkTx.inputsLength; i++) out.addInput(arkTx.getInput(i));
    const tail: ReturnType<Transaction["getOutput"]>[] = [];
    for (let i = 0; i < arkTx.outputsLength; i++) {
        const existing = arkTx.getOutput(i);
        const reserved =
            (existing.script && Extension.isExtension(existing.script)) ||
            i === arkTx.outputsLength - 1;
        if (reserved) tail.push(existing);
        else out.addOutput(existing);
    }
    const vout = out.outputsLength;
    out.addOutput(output);
    for (const existing of tail) out.addOutput(existing);
    return { tx: out, vout };
};

const SOMEONE_ELSE = hex.decode(`5120${"7c".repeat(32)}`);

describe("POST /v1/fills refuses a bad graph with its own code", () => {
    it("V1 an arkTx input that does not spend its own checkpoint", async () => {
        expect(
            await refusal(mutated((tx) => repointArkInput(tx, built.taxiIndex, "ab".repeat(32)))),
        ).toEqual({ code: "fill_graph_invalid", status: 400 });
    });

    it("V2 a Taxi index naming a coin the quote never reserved", async () => {
        const foreign = built.taxiIndex === 0 ? 1 : 0;
        expect(await refusal({ taxiInputIndexes: [foreign] })).toEqual({
            code: "fill_taxi_inputs_differ",
            status: 400,
        });
    });

    it("V4 a checkpoint paying the Taxi's coin elsewhere", async () => {
        const checkpoint = taxiCheckpoint(built.operatorCoin, SOMEONE_ELSE);
        const checkpoints = [...built.checkpoints];
        checkpoints[built.taxiIndex] = psbtOf(checkpoint);
        expect(
            await refusal({
                checkpoints,
                arkTx: psbtOf(repointArkInput(txOf(built.arkTx), built.taxiIndex, checkpoint.id)),
            }),
        ).toEqual({ code: "fill_checkpoint_mismatch", status: 400 });
    });

    it("V5 a covenant output with the wrong value", async () => {
        expect(
            await refusal(
                mutated((tx) => {
                    tx.updateOutput(0, { amount: tx.getOutput(0).amount! + 1n });
                    return tx;
                }),
            ),
        ).toEqual({ code: "fill_covenant_output_mismatch", status: 400 });
    });

    // The handler, not the validator, chooses which output to check.
    it("V5 a covenant output index that names another output", async () => {
        expect(await refusal({ covenantOutputIndex: built.solverVout })).toEqual({
            code: "fill_covenant_output_mismatch",
            status: 400,
        });
    });

    it("V5 a declared delivery the covenant output does not carry", async () => {
        expect(await refusal({ assetUnits: "4" })).toEqual({
            code: "fill_covenant_asset_mismatch",
            status: 400,
        });
    });

    it("V6 an undeclared delivery", async () => {
        expect(await refusal({ assetUnits: "0" })).toEqual({
            code: "fill_asset_units_invalid",
            status: 400,
        });
    });

    it("V7 a Taxi payout short by one sat", async () => {
        expect(
            await refusal(
                mutated((tx) => {
                    tx.updateOutput(built.changeVout, {
                        amount: tx.getOutput(built.changeVout).amount! - 1n,
                    });
                    return tx;
                }),
            ),
        ).toEqual({ code: "fill_operator_payout_mismatch", status: 400 });
    });

    it("V7 an asset fare the quote never priced", async () => {
        expect(
            await refusal(
                mutated((arkTx) => {
                    const { tx, vout } = appendValueOutput(arkTx, {
                        script: built.operatorScript,
                        amount: 330n,
                    });
                    const group = packetOf(tx).groups[0]!;
                    return withPacket(
                        tx,
                        regroup(group, {
                            inputs: group.inputs.map((input, i) =>
                                i === 0
                                    ? asset.AssetInput.create(input.vin, input.amount + 1n)
                                    : input,
                            ),
                            outputs: [...group.outputs, asset.AssetOutput.create(vout, 1n)],
                        }),
                    );
                }),
            ),
        ).toEqual({ code: "fill_unpriced_fare", status: 400 });
    });

    it("V8 a sub-dust value output", async () => {
        expect(
            await refusal(
                mutated((tx) => {
                    tx.updateOutput(built.solverVout, { amount: 1n });
                    return tx;
                }),
            ),
        ).toEqual({ code: "fill_output_below_floor", status: 400 });
    });

    it("V8 a zero-sat value output", async () => {
        expect(
            await refusal(
                mutated((tx) => {
                    tx.updateOutput(built.solverVout, { amount: 0n });
                    return tx;
                }),
            ),
        ).toEqual({ code: "fill_output_below_floor", status: 400 });
    });

    it("V9 a packet declaring input units at a Taxi vin", async () => {
        expect(
            await refusal(
                mutated((arkTx) => {
                    const group = packetOf(arkTx).groups[0]!;
                    return withPacket(
                        arkTx,
                        regroup(group, {
                            inputs: [...group.inputs, asset.AssetInput.create(built.taxiIndex, 1n)],
                        }),
                    );
                }),
            ),
        ).toEqual({ code: "fill_taxi_input_assets", status: 400 });
    });

    it("V9 a minting group", async () => {
        expect(
            await refusal(
                mutated((arkTx) => {
                    const group = packetOf(arkTx).groups[0]!;
                    return withPacket(
                        arkTx,
                        regroup(group, {
                            outputs: [
                                ...group.outputs,
                                asset.AssetOutput.create(built.solverVout, 1n),
                            ],
                        }),
                    );
                }),
            ),
        ).toEqual({ code: "fill_asset_not_conserved", status: 400 });
    });

    it("V11 a Taxi input that arrives signed", async () => {
        expect(
            await refusal(
                mutated((tx) => {
                    tx.updateInput(built.taxiIndex, {
                        tapScriptSig: [
                            [
                                {
                                    pubKey: hex.decode("aa".repeat(32)),
                                    leafHash: hex.decode("bb".repeat(32)),
                                },
                                hex.decode("cc".repeat(64)),
                            ],
                        ],
                    });
                    return tx;
                }),
            ),
        ).toEqual({ code: "fill_taxi_input_signed", status: 400 });
    });
});

describe("POST /v1/fills request and quote state", () => {
    it("refuses a body that is not a fill request", async () => {
        const h = open();
        try {
            await expect(submitFill(h.deps, { operationId: "" })).rejects.toMatchObject({
                code: "invalid_request",
                status: 400,
            });
        } finally {
            h.db.close();
        }
    });

    it("refuses a quote id it does not know", async () => {
        expect(await refusal({ quoteId: "missing" })).toEqual({ code: "not_found", status: 404 });
    });

    it("refuses a second fill against a quote the first one bound", async () => {
        const h = open();
        try {
            await expect(submitFill(h.deps, h.body)).rejects.toMatchObject({
                code: "fill_submission_ambiguous",
            });
            expect(new ReceiveQuoteRepository(h.db).get(h.quoteId)!.state).toBe("bound");
            await expect(
                submitFill(h.deps, { ...h.body, operationId: "op-fill-2" }),
            ).rejects.toMatchObject({ code: "invalid_state", status: 409 });
        } finally {
            h.db.close();
        }
    });

    it("refuses a deadline that has already passed", async () => {
        expect(await refusal({ validUntil: NOW - 1 })).toEqual({
            code: "quote_expired",
            status: 409,
        });
    });

    it("answers a replayed operation id from the stored row, never a second signature", async () => {
        const h = open();
        try {
            const fills = new FillRepository(h.db);
            const advances = new AdvanceRepository(h.db);
            void advances;
            // The first call reaches the provider stub and throws; the row is
            // bound and leased by then, which is what a replay must find.
            await expect(submitFill(h.deps, h.body)).rejects.toMatchObject({
                code: "fill_submission_ambiguous",
            });
            const stored = fills.getByOperation("op-fill-1")!;
            expect(stored.submitInvoked).toBe(true);
            const replay = await submitFill(h.deps, h.body);
            expect(replay.fillId).toBe(stored.id);
            expect(Object.keys(replay).sort()).toEqual(
                ["expiresAt", "failureCode", "fillId", "operationId", "state", "updatedAt"].sort(),
            );
        } finally {
            h.db.close();
        }
    });

    it("refuses a replay of the same operation id under different terms", async () => {
        const h = open();
        try {
            await expect(submitFill(h.deps, h.body)).rejects.toMatchObject({
                code: "fill_submission_ambiguous",
            });
            await expect(submitFill(h.deps, { ...h.body, assetUnits: "4" })).rejects.toMatchObject({
                code: "operation_conflict",
                status: 409,
            });
        } finally {
            h.db.close();
        }
    });
});

describe("POST /v1/fills submission", () => {
    // V13: the Taxi signs last and answers with no PSBT bytes, so the caller
    // never holds a Taxi-signed graph to replay once the reservation lapses.
    it("binds, signs only the Taxi's inputs, submits and answers without bytes", async () => {
        const h = open();
        try {
            const error = (await submitFill(h.deps, h.body).then(
                () => undefined,
                (e: unknown) => e as ServiceError,
            ))!;
            expect(error.code).toBe("fill_submission_ambiguous");
            expect(h.emulatorCalls).toBe(1);
            expect(h.arkCalls).toBe(0);
            const fill = new FillRepository(h.db).getByOperation("op-fill-1")!;
            expect(fill.state).toBe("submitting");
            expect(fill.submitInvoked).toBe(true);
            expect(fill.covenantOutputIndex).toBe(0);
            expect(fill.assetUnits).toBe(5n);
            // Signed only where the quote reserved, nowhere else.
            const signed = txOf(fill.preparedArkTx!);
            for (let i = 0; i < signed.inputsLength; i++) {
                const sigs = signed.getInput(i).tapScriptSig?.length ?? 0;
                if (i === built.taxiIndex) expect(sigs).toBeGreaterThan(0);
            }
            const status = getFill(h.deps, fill.id);
            expect(Object.keys(status)).not.toContain("arkTx");
            expect(Object.keys(status)).not.toContain("checkpoints");
            expect(Object.keys(status)).not.toContain("preparedArkTx");
            expect(new ReceiveQuoteRepository(h.db).get(h.quoteId)!.state).toBe("bound");
            expect(new AdvanceRepository(h.db).get(h.quoteId)!.state).toBe("locking");
        } finally {
            h.db.close();
        }
    });

    /**
     * What a real caller sends. `/v1/fills` asks for every non-Taxi input signed
     * and the Taxi's left unsigned, so a graph whose foreign inputs already
     * carry their holder's signature must be accepted — the Taxi signs on top
     * of it. Only the gated covenant input must still arrive unsigned, because
     * the emulator signs that one and nobody else may.
     */
    it("accepts a graph whose ungated foreign input already carries a signature", async () => {
        const h = open();
        try {
            const arkTx = txOf(built.arkTx);
            const foreign = built.solverIndex;
            const signedArk = await SingleKey.fromPrivateKey(solverPrivkey).sign(arkTx, [foreign]);
            expect(signedArk.getInput(foreign).tapScriptSig?.length ?? 0).toBeGreaterThan(0);
            const checkpoints = [...built.checkpoints];
            const signedCp = await SingleKey.fromPrivateKey(solverPrivkey).sign(
                txOf(checkpoints[foreign]!),
                [0],
            );
            checkpoints[foreign] = psbtOf(signedCp);
            await expect(
                submitFill(h.deps, {
                    ...h.body,
                    arkTx: psbtOf(signedArk),
                    checkpoints,
                }),
            ).rejects.toMatchObject({ code: "fill_submission_ambiguous" });
            expect(h.emulatorCalls).toBe(1);
            const fill = new FillRepository(h.db).getByOperation("op-fill-1")!;
            // The caller's signature survived the Taxi's own signing round.
            const prepared = txOf(fill.preparedArkTx!);
            expect(prepared.getInput(foreign).tapScriptSig?.length ?? 0).toBeGreaterThan(0);
            expect(prepared.getInput(built.taxiIndex).tapScriptSig?.length ?? 0).toBeGreaterThan(0);
        } finally {
            h.db.close();
        }
    });

    it("routes to arkd when no input is emulator-gated", async () => {
        const h = open();
        try {
            // Strip the emulator packet: with no gated input the fill must not
            // reach the emulator at all (OD-5's zero-gated-input case).
            const arkTx = txOf(built.arkTx);
            const out = new Transaction({ version: 3, lockTime: 0 });
            for (let i = 0; i < arkTx.inputsLength; i++) out.addInput(arkTx.getInput(i));
            const packets = Extension.fromTx(arkTx)
                .getPackets()
                .filter((packet) => packet.type() === asset.Packet.PACKET_TYPE);
            const replacement = Extension.create([...packets]).txOut();
            for (let i = 0; i < arkTx.outputsLength; i++) {
                const output = arkTx.getOutput(i);
                out.addOutput(
                    output.script && Extension.isExtension(output.script) ? replacement : output,
                );
            }
            await expect(
                submitFill(h.deps, { ...h.body, arkTx: psbtOf(out) }),
            ).rejects.toMatchObject({ code: "fill_submission_ambiguous" });
            expect(h.arkCalls).toBe(1);
            expect(h.emulatorCalls).toBe(0);
        } finally {
            h.db.close();
        }
    });
});

describe("POST /v1/fills when the provider refuses the signed graph", () => {
    /**
     * What an under-signed foreign input looks like from the Taxi's side: it
     * validates, binds, signs and submits, and the provider refuses the whole
     * transaction. Nothing partial can have moved — one submission, atomically
     * refused — so the row must land in the documented ambiguous state with its
     * reservation still held, never a terminal one and never stuck leased.
     */
    it("keeps the reservation and records an ambiguous submission, not a terminal state", async () => {
        const h = open();
        try {
            await expect(submitFill(h.deps, h.body)).rejects.toMatchObject({
                code: "fill_submission_ambiguous",
                status: 503,
            });
            const fill = new FillRepository(h.db).getByOperation("op-fill-1")!;
            expect(fill.state).toBe("submitting");
            expect(fill.failureCode).toBe("fill_submission_ambiguous");
            expect(fill.submitInvoked).toBe(true);
            expect(fill.txid).toBeUndefined();
            // The lease is released so a reconciler can pick the row up, and
            // the row is not expired away while its submission is unresolved.
            expect(fill.leaseToken).toBeUndefined();
            expect(fill.nextAttemptAt).toBeGreaterThan(NOW);
            expect(new FillRepository(h.db).expire(fill.expiresAt + 1)).toBe(0);
            expect(new FillRepository(h.db).get(fill.id)!.state).toBe("submitting");
            // The coins stay reserved, now by the advance rather than the quote.
            const reserved = h.db
                .prepare<[], { outpoint_txid: string; advance_id: string }>(
                    "SELECT outpoint_txid, advance_id FROM operator_input_reservations",
                )
                .all();
            expect(reserved).toHaveLength(1);
            expect(reserved[0]!.advance_id).toBe(h.quoteId);
            expect(new AdvanceRepository(h.db).get(h.quoteId)!.state).toBe("locking");
        } finally {
            h.db.close();
        }
    });
});

describe("GET /v1/fills/{id}", () => {
    /** A status read is useless without the txid, and only `recordSubmitted`
     * writes one before a reconciler exists. Fenced by the submit lease. */
    it("reports the submitted txid, and only to the lease that holds the row", async () => {
        const h = open();
        try {
            await expect(submitFill(h.deps, h.body)).rejects.toMatchObject({
                code: "fill_submission_ambiguous",
            });
            const fills = new FillRepository(h.db);
            const fill = fills.getByOperation("op-fill-1")!;
            expect(fill.txid).toBeUndefined();
            const txid = "ab".repeat(32);
            expect(fills.recordSubmitted(fill.id, "not-the-lease", txid, NOW)).toBe(false);
            h.db.prepare("UPDATE fills SET lease_token = 'lease' WHERE id = ?").run(fill.id);
            expect(fills.recordSubmitted(fill.id, "lease", txid, NOW)).toBe(true);
            expect(getFill(h.deps, fill.id).txid).toBe(txid);
            expect(fills.get(fill.id)!.state).toBe("submitting");
        } finally {
            h.db.close();
        }
    });

    it("refuses an id it does not know", () => {
        const h = open();
        try {
            expect(() => getFill(h.deps, "nope")).toThrow(/not found/);
        } finally {
            h.db.close();
        }
    });
});
