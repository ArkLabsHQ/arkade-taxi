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
    type ExtendedVirtualCoin,
    type VirtualCoin,
} from "@arkade-os/sdk";
import { DustCovenantScript } from "@arkade-taxi/covenant";
import { openDatabase, ReceiveQuoteRepository, type ReceiveQuote } from "@arkade-taxi/db";
import { createSwapFillQuote } from "../src/swapFillQuotes.js";
import { assertFillGraph, type FillGraphArgs } from "../src/fills.js";
import type { ServiceError } from "../src/errors.js";
import { runtimeSafety, serverUnroll } from "./fixtures.js";
import { WANTED_ASSET } from "./jointFillFixtures.js";
import { asIndexed } from "./swapFillFixtures.js";
import { receiverPaidFill } from "./realFillFixtures.js";

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

/** A copy with one input repointed, so a rebuilt checkpoint keeps its arkTx edge. */
const repointArkInput = (arkTx: Transaction, index: number, txid: string): Transaction => {
    const out = new Transaction({ version: 3, lockTime: 0 });
    for (let i = 0; i < arkTx.inputsLength; i++) {
        const input = arkTx.getInput(i);
        out.addInput(i === index ? { ...input, txid: hex.decode(txid) } : input);
    }
    for (let i = 0; i < arkTx.outputsLength; i++) out.addOutput(arkTx.getOutput(i));
    return out;
};

/** The checkpoint the Taxi accepts for one of its coins, or a chosen deviation. */
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

/** Swaps the asset packet for `next`, keeping every other packet in place. */
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

/** Appends a value output after the last one, so no existing vout shifts and
 * the extension and the trailing anchor keep their relative places. */
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

const SOMEONE_ELSE = hex.decode(`5120${"7c".repeat(32)}`);

interface Fixture {
    args: FillGraphArgs;
    taxiIndex: number;
    foreignIndex: number;
    changeVout: number;
    solverVout: number;
    operatorCoin: ExtendedVirtualCoin;
    quote: ReceiveQuote;
}

let fixture: Fixture;

beforeAll(async () => {
    const fill = receiverPaidFill(state);
    try {
        const quoted = await createSwapFillQuote(fill.deps, fill.body);
        const owners = quoted.graph.inputs.map((input) => input.owner);
        const operatorScript = new ArkAddress(
            fill.cfg.serverPubkey,
            fill.cfg.operatorKey,
            fill.cfg.addressHrp,
        ).pkScript;
        const change = quoted.graph.outputs.find((o) =>
            same(hex.decode(o.script), operatorScript),
        )!;
        const solver = quoted.graph.outputs.find(
            (o) => o.vout !== 0 && !same(hex.decode(o.script), operatorScript),
        )!;
        const safety = runtimeSafety();
        const quote = fill.quotes.get(fill.quoteId)!;
        fixture = {
            taxiIndex: owners.indexOf("sponsor"),
            foreignIndex: owners.indexOf("solver"),
            changeVout: change.vout,
            solverVout: solver.vout,
            operatorCoin: fill.operatorCoin,
            quote,
            args: {
                graph: { arkTx: quoted.graph.arkTx, checkpoints: quoted.graph.checkpoints },
                taxiInputIndexes: [owners.indexOf("sponsor")],
                covenantOutputIndex: 0,
                assetUnits: 5n,
                quote,
                operatorScript,
                observed: new Map<string, VirtualCoin>(
                    [fill.operatorCoin, fill.deposit, fill.solver].map((coin) => [
                        point(coin),
                        asIndexed(coin),
                    ]),
                ),
                serverUnroll,
                limits: { vtxoMaxAmount: 10_000_000n },
                dust: fill.cfg.dust,
                vtxoMinAmount: fill.cfg.vtxoMinAmount,
                serverKey: fill.cfg.serverPubkey,
                emulatorKey: fill.cfg.emulatorPubkey,
                clock: {
                    height: Number(safety.chainHeight),
                    timestamp: new Date(Number(safety.chainTime) * 1000),
                },
            },
        };
    } finally {
        fill.db.close();
    }
});

const refused = (over: Partial<FillGraphArgs>): ServiceError => {
    try {
        assertFillGraph({ ...fixture.args, ...over });
    } catch (thrown) {
        return thrown as ServiceError;
    }
    throw new Error("assertFillGraph accepted a graph it must refuse");
};

/** `over` applied to the arkTx, re-encoded back into the graph. */
const mutated = (mutate: (arkTx: Transaction) => Transaction): Partial<FillGraphArgs> => ({
    graph: { ...fixture.args.graph, arkTx: psbtOf(mutate(txOf(fixture.args.graph.arkTx))) },
});

const observedWith = (index: number, over: Partial<VirtualCoin>): Partial<FillGraphArgs> => {
    const observed = new Map(fixture.args.observed);
    const input = txOf(fixture.args.graph.checkpoints[index]!).getInput(0);
    const key = `${hex.encode(input.txid!)}:${input.index}`;
    observed.set(key, { ...observed.get(key)!, ...over });
    return { observed };
};

describe("assertFillGraph against the graph today's builder emits", () => {
    it("accepts the production builder's own fill unchanged", () => {
        expect(fixture.taxiIndex).toBeGreaterThanOrEqual(0);
        expect(fixture.foreignIndex).toBeGreaterThanOrEqual(0);
        const covenant = new DustCovenantScript({
            serverKey: fixture.args.serverKey,
            emulatorKey: fixture.args.emulatorKey,
            vtxoMinAmount: fixture.args.vtxoMinAmount,
            params: fixture.quote.params,
        });
        const arkTx = txOf(fixture.args.graph.arkTx);
        expect(same(arkTx.getOutput(0).script!, covenant.pkScript)).toBe(true);
        expect(() => assertFillGraph(fixture.args)).not.toThrow();
    });

    /**
     * The phase-2 open claim, answered: V7's asset-fare branch was not merely
     * untested, it was unreachable. `encodeFare` in the receive-quote
     * repository refuses any currency but sats, and the bind requires the same,
     * so no quote this rail can load ever prices an asset fare. The branch is
     * gone; this pins the invariant it rested on.
     */
    it("V7 refuses a quote whose fare the rail cannot price, which no quote can be", () => {
        const quote: ReceiveQuote = {
            ...fixture.quote,
            fare: { currency: "asset", assetId: WANTED_ASSET, units: 2n },
        };
        expect(refused({ quote }).code).toBe("fill_fare_unsupported");
        // And the store will not hold one, so the refusal is unreachable in
        // production rather than merely unexercised.
        const db = openDatabase(":memory:");
        try {
            const quotes = new ReceiveQuoteRepository(db);
            expect(() =>
                quotes.insert({
                    quote,
                    expectedPolicyRevision: 0n,
                    recoveryExecutionBudget: { kind: "time", value: 43_200n },
                }),
            ).toThrow(/invalid fare/);
        } finally {
            db.close();
        }
    });

    it("V1 refuses an arkTx input that does not spend its own checkpoint", () => {
        expect(
            refused(mutated((arkTx) => repointArkInput(arkTx, fixture.taxiIndex, "ab".repeat(32))))
                .code,
        ).toBe("fill_graph_invalid");
    });

    it("V2 refuses a Taxi index naming a coin the quote never reserved", () => {
        expect(refused({ taxiInputIndexes: [fixture.foreignIndex] }).code).toBe(
            "fill_taxi_inputs_differ",
        );
    });

    it("V3 refuses a foreign input that is in fact a Taxi coin", () => {
        expect(
            refused(
                observedWith(fixture.foreignIndex, {
                    script: hex.encode(fixture.args.operatorScript),
                }),
            ).code,
        ).toBe("fill_foreign_taxi_coin");
    });

    it("V4 refuses a checkpoint paying the Taxi's coin elsewhere", () => {
        const checkpoint = taxiCheckpoint(fixture.operatorCoin, SOMEONE_ELSE);
        const checkpoints = [...fixture.args.graph.checkpoints];
        checkpoints[fixture.taxiIndex] = psbtOf(checkpoint);
        const arkTx = repointArkInput(
            txOf(fixture.args.graph.arkTx),
            fixture.taxiIndex,
            checkpoint.id,
        );
        expect(refused({ graph: { arkTx: psbtOf(arkTx), checkpoints } }).code).toBe(
            "fill_checkpoint_mismatch",
        );
    });

    it("V5 refuses a covenant output with the right script and the wrong value", () => {
        expect(
            refused(
                mutated((arkTx) => {
                    arkTx.updateOutput(0, { amount: arkTx.getOutput(0).amount! + 1n });
                    return arkTx;
                }),
            ).code,
        ).toBe("fill_covenant_output_mismatch");
    });

    it("V5 refuses a covenant output carrying the wrong asset amount", () => {
        expect(refused({ assetUnits: 4n }).code).toBe("fill_covenant_asset_mismatch");
    });

    it("V6 refuses an undeclared delivery", () => {
        expect(refused({ assetUnits: 0n }).code).toBe("fill_asset_units_invalid");
    });

    // The fare is a covenant param, so the output has to follow it or V5 fires first.
    it("V6 refuses an asset receiver fare at or above the delivery", () => {
        const quote: ReceiveQuote = {
            ...fixture.quote,
            params: {
                ...fixture.quote.params,
                receiverFare: { currency: "asset", units: 5n },
            },
        };
        const covenant = new DustCovenantScript({
            serverKey: fixture.args.serverKey,
            emulatorKey: fixture.args.emulatorKey,
            vtxoMinAmount: fixture.args.vtxoMinAmount,
            params: quote.params,
        });
        expect(
            refused({
                quote,
                ...mutated((arkTx) => {
                    arkTx.updateOutput(0, { script: covenant.pkScript });
                    return arkTx;
                }),
            }).code,
        ).toBe("fill_fare_exceeds_delivery");
    });

    it("V7 refuses a Taxi payout short by one sat", () => {
        expect(
            refused(
                mutated((arkTx) => {
                    const vout = fixture.changeVout;
                    arkTx.updateOutput(vout, { amount: arkTx.getOutput(vout).amount! - 1n });
                    return arkTx;
                }),
            ).code,
        ).toBe("fill_operator_payout_mismatch");
    });

    it("V7 refuses a Taxi output carrying an asset fare the quote never priced", () => {
        expect(
            refused(
                mutated((arkTx) => {
                    const { tx, vout } = appendValueOutput(arkTx, {
                        script: fixture.args.operatorScript,
                        amount: fixture.args.vtxoMinAmount,
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
            ).code,
        ).toBe("fill_unpriced_fare");
    });

    it("V8 refuses a zero-sat value output", () => {
        expect(
            refused(
                mutated((arkTx) => {
                    arkTx.updateOutput(fixture.solverVout, { amount: 0n });
                    return arkTx;
                }),
            ).code,
        ).toBe("fill_output_below_floor");
    });

    it("V8 refuses a sub-dust value output", () => {
        expect(
            refused(
                mutated((arkTx) => {
                    arkTx.updateOutput(fixture.solverVout, { amount: 1n });
                    return arkTx;
                }),
            ).code,
        ).toBe("fill_output_below_floor");
    });

    it("V9 refuses a packet declaring input units at a Taxi vin", () => {
        expect(
            refused(
                mutated((arkTx) => {
                    const group = packetOf(arkTx).groups[0]!;
                    return withPacket(
                        arkTx,
                        regroup(group, {
                            inputs: [
                                ...group.inputs,
                                asset.AssetInput.create(fixture.taxiIndex, 1n),
                            ],
                        }),
                    );
                }),
            ).code,
        ).toBe("fill_taxi_input_assets");
    });

    it("V9 refuses a minting group", () => {
        expect(
            refused(
                mutated((arkTx) => {
                    const group = packetOf(arkTx).groups[0]!;
                    return withPacket(
                        arkTx,
                        regroup(group, {
                            outputs: [
                                ...group.outputs,
                                asset.AssetOutput.create(fixture.solverVout, 1n),
                            ],
                        }),
                    );
                }),
            ).code,
        ).toBe("fill_asset_not_conserved");
    });

    it("V10 refuses a foreign input one below the expiry floor", () => {
        expect(
            refused(
                observedWith(fixture.foreignIndex, {
                    expiresAtHeight: Number(fixture.quote.inputExpiryFloor.value) - 1,
                }),
            ).code,
        ).toBe("fill_input_expiry_floor");
    });

    it("V11 refuses a Taxi arkTx input that arrives signed", () => {
        expect(
            refused(
                mutated((arkTx) => {
                    arkTx.updateInput(fixture.taxiIndex, {
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
                    return arkTx;
                }),
            ).code,
        ).toBe("fill_taxi_input_signed");
    });
});
