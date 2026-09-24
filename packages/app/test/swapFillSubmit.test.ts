import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
    ArkAddress,
    CSVMultisigTapscript,
    MultisigTapscript,
    VtxoScript,
    asset,
    buildOffchainTx,
    Extension,
    SingleKey,
    Transaction,
    type ExtendedVirtualCoin,
    type Identity,
} from "@arkade-os/sdk";
import { schnorr } from "@noble/curves/secp256k1.js";
import type { SwapFill } from "@arkade-taxi/db";
import { bytesToHex } from "@arkade-taxi/protocol";
import { createSwapFillQuote, type SwapFillQuoteDeps } from "../src/swapFillQuotes.js";
import {
    SWAP_FILL_SUBMIT_LEASE_OWNER,
    assertSolverAuthorised,
    assertSolverGraphMatchesTrusted,
    productionSwapFillJointOps,
    submitSwapFill,
    type SwapFillJointOps,
    type SwapFillSubmitDeps,
} from "../src/swapFillSubmit.js";
import type { ServiceError } from "../src/errors.js";
import { base64, hex } from "@scure/base";
import {
    config,
    fundingCoin,
    MemoryAdvances,
    NOW,
    operatorKey,
    policy as basePolicy,
    runtimeSafety,
} from "./fixtures.js";
import {
    asIndexed,
    checkpointSpending,
    FAKE_COVENANT_SCRIPT,
    FAKE_MAKER_SCRIPT,
    FakeSwapFillGraphBuilder,
    fakeOfferTerms,
    MemorySwapFills,
    sealGraph,
    solverCoin,
    solverTaproot,
} from "./swapFillFixtures.js";
import {
    createBoundJointFill,
    foreignRecoveryPreflight,
    patchJointSource,
    type BoundJointFill,
} from "./jointFillFixtures.js";
import { jointGraphFromWire } from "../src/arkade/swapFillBuilder.js";
import { storedGraphToJoint } from "../src/arkade/swapFillBuilder.js";
import type { Policy } from "@arkade-taxi/core";
import type { SwapFillGraphWire, SwapFillQuoteResponse } from "@arkade-taxi/protocol";
import {
    JointSigningError,
    JointSubmissionAmbiguousError,
    setTapScriptSigEntries,
    tapLeavesOfInput,
    verifyOfferFillPlan,
    type JointGraph,
} from "@arkade-taxi/client";

const DEP = { txid: "dd".repeat(32), vout: 3 };
const SOLVER_COIN = { txid: "ee".repeat(32), vout: 1 };
const TAXI_0 = { txid: "cc".repeat(32), vout: 0 };
const TAXI_1 = { txid: "cc".repeat(32), vout: 1 };
const MAKER_SCRIPT = FAKE_MAKER_SCRIPT;
const PROCEEDS_SCRIPT = "51";
const WANT = 5000n;
const SOLVER_VALUE = 6000;
const CONTRIBUTION = 330n;
const FARE_ASSET = {
    txid: Buffer.from("1234".repeat(16), "hex").reverse().toString("hex"),
    groupIndex: 0,
};
const FARE_SWAP_ID = asset.AssetId.create("1234".repeat(16), 0).toString();
const FARE_UNITS = 5n;
const SOLVER_ASSET_AMOUNT = 100n;

let advances: MemoryAdvances;
let swapFills: MemorySwapFills;
let builder: FakeSwapFillGraphBuilder;
let indexerCoins: Map<string, ExtendedVirtualCoin>;
let taxiCoins: ExtendedVirtualCoin[];
let testPolicy: Policy;
let ids: number;
let leases: number;
let joint: FakeJointOps;
let emulator: FakeEmulator;
let taxiIdentity: FakeTaxiIdentity;
let clock: number;
let authCalls: { solver: JointGraph; trusted: JointGraph; solverKeys: string[] }[];
let authFailure: Error | null;

const key = (o: { txid: string; vout: number }): string => `${o.txid}:${o.vout}`;

const quoteBody = (over: Record<string, unknown> = {}) => ({
    operationId: "op-1",
    offerHex: "ab12",
    solverInputs: [
        {
            txid: SOLVER_COIN.txid,
            vout: SOLVER_COIN.vout,
            value: String(SOLVER_VALUE),
            ...solverTaproot(),
            assets: [{ assetId: FARE_ASSET, amount: String(SOLVER_ASSET_AMOUNT) }],
        },
    ],
    solverProceedsScript: PROCEEDS_SCRIPT,
    solverKeys: ["ab".repeat(32)],
    contributionSats: CONTRIBUTION.toString(),
    maxFare: { currency: "asset", assetId: FARE_ASSET, units: String(FARE_UNITS) },
    fundingTxid: DEP.txid,
    fundingVout: DEP.vout,
    ...over,
});

const quoteDeps = (): SwapFillQuoteDeps => ({
    runtime: {
        assertAdmission: async () => {},
        withAdmission: async (work) => work(() => {}),
        safety: () => runtimeSafety(),
    },
    policy: {
        get: () => testPolicy,
        getSnapshot: () => ({ policy: testPolicy, revision: 1n }),
    },
    advances,
    reservations: { listReservedOutpoints: () => [], expireQuotes: () => 0 },
    swapFills,
    inventory: {
        getSpendableVtxos: async () => taxiCoins,
        getLockedVtxoOutpoints: async () => [],
    },
    senderInventory: {
        getVtxos: async (opts) => ({
            vtxos:
                opts?.outpoints
                    ?.map((o) => indexerCoins.get(key(o))!)
                    .filter(Boolean)
                    .map(asIndexed) ?? [],
        }),
    },
    config: config(),
    now: () => NOW,
    nowMs: () => NOW * 1000,
    randomId: () => `fill-${++ids}`,
    swapFillBuilder: builder,
    offerCodec: { decodeOffer: () => fakeOfferTerms() },
    providerLimits: async () => ({ vtxoMaxAmount: 10_000_000n }),
});

class FakeJointOps implements SwapFillJointOps {
    readonly calls: string[] = [];
    signArgs:
        | { expected: JointGraph; partial: JointGraph; bindings: { inputIndex: number }[] }
        | undefined;
    prepareOwnerKeys: unknown;
    submitPins: unknown;
    submitOwnerKeys: unknown;
    covenantArgs: { expected: JointGraph; emulatorXOnly: string } | undefined;
    failAt: { op: "sign" | "prepare" | "covenant" | "submit"; error: Error } | null = null;
    onSign: (() => void) | null = null;
    preparedTxid = "dd".repeat(32);
    submittedTxid = "ee".repeat(32);
    covenant = "cc".repeat(32);
    verifyPlan(): boolean {
        this.calls.push("verify");
        return true;
    }
    async signForTaxi(args: {
        expected: JointGraph;
        partial: JointGraph;
        bindings: { inputIndex: number; identity: unknown }[];
    }): Promise<JointGraph> {
        this.calls.push("sign");
        this.signArgs = args;
        this.onSign?.();
        if (this.failAt?.op === "sign") throw this.failAt.error;
        return args.partial;
    }
    prepare(args: { expected: JointGraph; partial: JointGraph; ownerKeys: unknown }): {
        arkTx: string;
        checkpointTxs: readonly string[];
        txid: string;
    } {
        this.calls.push("prepare");
        this.prepareOwnerKeys = args.ownerKeys;
        if (this.failAt?.op === "prepare") throw this.failAt.error;
        return {
            arkTx: args.partial.arkTx,
            checkpointTxs: [...args.partial.checkpoints],
            txid: this.preparedTxid,
        };
    }
    covenantKey(args: { expected: JointGraph; emulatorXOnly: string }): string {
        this.calls.push("covenant");
        this.covenantArgs = args;
        if (this.failAt?.op === "covenant") throw this.failAt.error;
        return this.covenant;
    }
    async submit(args: {
        expected: JointGraph;
        prepared: { arkTx: string; checkpointTxs: readonly string[]; txid: string };
        provider: {
            submitTx(
                arkTx: string,
                checkpoints: string[],
            ): Promise<{ signedArkTx: string; signedCheckpointTxs: string[] }>;
        };
        pins: unknown;
        ownerKeys: unknown;
    }): Promise<{ txid: string; signedArkTx: string; signedCheckpointTxs: string[] }> {
        this.calls.push("submit");
        this.submitPins = args.pins;
        this.submitOwnerKeys = args.ownerKeys;
        if (this.failAt?.op === "submit") throw this.failAt.error;
        const response = await args.provider.submitTx(args.prepared.arkTx, [
            ...args.prepared.checkpointTxs,
        ]);
        return {
            txid: args.prepared.txid,
            signedArkTx: response.signedArkTx,
            signedCheckpointTxs: [...response.signedCheckpointTxs],
        };
    }
}

class FakeEmulator {
    readonly calls: { arkTx: string; checkpoints: string[]; preparedAtCall: string | undefined }[] =
        [];
    fail: Error | null = null;
    onCall: (() => void) | null = null;
    constructor(private readonly store: MemorySwapFills) {}
    async submitTx(
        arkTx: string,
        checkpoints: string[],
    ): Promise<{ signedArkTx: string; signedCheckpointTxs: string[] }> {
        this.onCall?.();
        const preparedAtCall = [...this.store.rows.values()][0]?.preparedArkTx;
        this.calls.push({ arkTx, checkpoints, preparedAtCall });
        if (this.fail) throw this.fail;
        return { signedArkTx: arkTx, signedCheckpointTxs: [...checkpoints] };
    }
}

class FakeTaxiIdentity {
    signCalls = 0;
    async xOnlyPublicKey(): Promise<Uint8Array> {
        return operatorKey;
    }
    async sign(tx: unknown, indexes: number[]): Promise<unknown> {
        this.signCalls++;
        return tx;
    }
}

const deps = (over: Partial<SwapFillSubmitDeps> = {}): SwapFillSubmitDeps => ({
    swapFills,
    taxiIdentity: () => taxiIdentity as unknown as Identity,
    emulator,
    config: config(),
    now: () => clock,
    randomId: () => `lease-${++leases}`,
    leaseSeconds: 60,
    joint,
    assertSolverAuthorised: (args) => {
        authCalls.push(args);
        if (authFailure) throw authFailure;
    },
    ...over,
});

const caught = async (fn: () => Promise<unknown>): Promise<ServiceError> => {
    try {
        await fn();
    } catch (e) {
        return e as ServiceError;
    }
    throw new Error("expected a rejection");
};

const jointError = (message: string): Error => new JointSigningError(message);

const ambiguousError = (message: string): Error => new JointSubmissionAmbiguousError(message);

const signEntry = (pubKeys: Uint8Array[]) =>
    pubKeys.length
        ? {
              tapScriptSig: pubKeys.map(
                  (pubKey) =>
                      [{ pubKey, leafHash: new Uint8Array(32) }, new Uint8Array(64)] as [
                          { pubKey: Uint8Array; leafHash: Uint8Array },
                          Uint8Array,
                      ],
              ),
          }
        : {};

const authGraph = (args: {
    owners: JointGraph["inputOwners"];
    outpoints?: { txid: string; vout: number }[];
    arkSigs: Uint8Array[][];
    checkpointSigs: Uint8Array[][];
}): JointGraph => {
    const outpoints =
        args.outpoints ?? args.owners.map((_, index) => ({ txid: "bb".repeat(32), vout: index }));
    const checkpoints = args.checkpointSigs.map((sigs, i) => {
        const cp = checkpointSpending(outpoints[i]!);
        if (sigs.length) cp.updateInput(0, signEntry(sigs));
        return cp;
    });
    const tx = new Transaction({ version: 3, lockTime: 0 });
    for (const cp of checkpoints) tx.addInput({ txid: cp.id, index: 0 });
    tx.addOutput({ amount: 1000n, script: new Uint8Array([0x51]) });
    args.arkSigs.forEach((pubKeys, index) => {
        if (pubKeys.length) tx.updateInput(index, signEntry(pubKeys));
    });
    return {
        arkTx: base64.encode(tx.toPSBT()),
        checkpoints: checkpoints.map((cp) => base64.encode(cp.toPSBT())),
        graphId: "ab".repeat(32),
        inputOwners: [...args.owners],
    };
};

const PINNED = await SingleKey.fromPrivateKey(new Uint8Array(32).fill(11)).xOnlyPublicKey();
const UNPINNED = await SingleKey.fromPrivateKey(new Uint8Array(32).fill(13)).xOnlyPublicKey();
const PINNED_HEX = hex.encode(PINNED);

beforeEach(() => {
    advances = new MemoryAdvances();
    swapFills = new MemorySwapFills();
    builder = new FakeSwapFillGraphBuilder(MAKER_SCRIPT, WANT);
    indexerCoins = new Map([
        [
            key(DEP),
            fundingCoin({
                txid: DEP.txid,
                vout: DEP.vout,
                value: 10000,
                script: FAKE_COVENANT_SCRIPT,
            }),
        ],
        [
            key(SOLVER_COIN),
            solverCoin({
                txid: SOLVER_COIN.txid,
                vout: SOLVER_COIN.vout,
                value: SOLVER_VALUE,
                assets: [{ assetId: FARE_SWAP_ID, amount: SOLVER_ASSET_AMOUNT }],
            }),
        ],
    ]);
    taxiCoins = [
        fundingCoin({ txid: TAXI_0.txid, vout: TAXI_0.vout }),
        fundingCoin({ txid: TAXI_1.txid, vout: TAXI_1.vout }),
    ];
    testPolicy = basePolicy();
    ids = 0;
    leases = 0;
    joint = new FakeJointOps();
    emulator = new FakeEmulator(swapFills);
    taxiIdentity = new FakeTaxiIdentity();
    clock = NOW;
    authCalls = [];
    authFailure = null;
});

const quote = async (): Promise<SwapFillQuoteResponse> =>
    createSwapFillQuote(quoteDeps(), quoteBody());

const submitQuoted = (
    fill: SwapFill,
    graph: SwapFillGraphWire,
    over: Partial<SwapFillSubmitDeps> = {},
) => submitSwapFill(deps(over), fill.id, { solverGraph: graph });

describe("submitSwapFill", () => {
    it("submits a quoted fill, persisting prepared bytes before touching the network", async () => {
        const q = await quote();
        const fill = swapFills.get(q.fillId)!;
        const res = await submitQuoted(fill, q.graph);
        expect(res).toMatchObject({
            fillId: q.fillId,
            operationId: "op-1",
            state: "submitting",
            txid: joint.preparedTxid,
            expiresAt: NOW + 60,
        });
        const stored = swapFills.get(q.fillId)!;
        expect(stored.state).toBe("submitting");
        expect(stored.submitInvoked).toBe(true);
        expect(stored.preparedArkTx).toBe(emulator.calls[0]!.arkTx);
        expect(stored.preparedCheckpoints).toEqual(emulator.calls[0]!.checkpoints);
        expect(emulator.calls[0]!.preparedAtCall).toBe(emulator.calls[0]!.arkTx);
        expect(emulator.calls).toHaveLength(1);
        expect(swapFills.listReservedOutpoints()).toEqual([TAXI_0]);
        expect(joint.calls).toEqual(["verify", "sign", "prepare", "covenant", "submit"]);
        expect(authCalls).toHaveLength(1);
        expect(taxiIdentity.signCalls).toBe(0);
    });

    it("authorises the solver graph before Taxi signs, and signs that same graph", async () => {
        const q = await quote();
        let authorised: JointGraph | undefined;
        await submitQuoted(swapFills.get(q.fillId)!, q.graph, {
            assertSolverAuthorised: ({ solver }) => {
                joint.calls.push("auth");
                authorised = solver;
            },
        });
        expect(joint.calls).toEqual(["verify", "auth", "sign", "prepare", "covenant", "submit"]);
        expect(authorised).toBeDefined();
        expect(joint.signArgs?.partial).toBe(authorised);
    });

    it("pins both solver and sponsor owner keys for prepare and submit", async () => {
        const q = await quote();
        await submitQuoted(swapFills.get(q.fillId)!, q.graph);
        const taxiXOnly = bytesToHex(operatorKey).toLowerCase();
        expect(joint.prepareOwnerKeys).toEqual({ solver: ["ab".repeat(32)], sponsor: [taxiXOnly] });
        expect(joint.submitOwnerKeys).toEqual({ solver: ["ab".repeat(32)], sponsor: [taxiXOnly] });
    });

    it("pins the covenant cosigner from the verified trusted graph, never the raw key", async () => {
        const q = await quote();
        await submitQuoted(swapFills.get(q.fillId)!, q.graph);
        expect(joint.covenantArgs?.emulatorXOnly).toBe(
            bytesToHex(config().emulatorPubkey).toLowerCase(),
        );
        expect(joint.covenant).not.toBe(joint.covenantArgs?.emulatorXOnly);
        expect(joint.submitPins).toEqual({
            emulatorXOnly: bytesToHex(config().emulatorPubkey).toLowerCase(),
            serverXOnly: bytesToHex(config().serverPubkey).toLowerCase(),
        });
        expect(joint.signArgs?.expected).toBe(joint.covenantArgs?.expected);
    });

    it("rejects a covenant pin equal to the raw emulator key without submitting", async () => {
        const q = await quote();
        joint.covenant = bytesToHex(config().emulatorPubkey).toLowerCase();
        const rejected = await caught(() => submitQuoted(swapFills.get(q.fillId)!, q.graph));
        expect(rejected.status).toBe(500);
        expect(rejected.code).toBe("swap_fill_covenant_pin_invalid");
        expect(rejected.message).toContain("(not submitted)");
        expect(emulator.calls).toHaveLength(0);
        expect(swapFills.get(q.fillId)!.state).toBe("quoted");
    });

    it("binds sponsor inputs to the wallet identity without minting keys", async () => {
        const q = await quote();
        await submitQuoted(swapFills.get(q.fillId)!, q.graph);
        const sponsorIndexes = q.graph.inputs
            .map((input, index) => ({ input, index }))
            .filter(({ input }) => input.owner === "sponsor")
            .map(({ index }) => index);
        expect(sponsorIndexes.length).toBeGreaterThan(0);
        expect(joint.signArgs?.bindings.map((b) => b.inputIndex)).toEqual(sponsorIndexes);
        for (const binding of joint.signArgs?.bindings ?? [])
            expect((binding as unknown as { identity: unknown }).identity).toBe(taxiIdentity);
    });

    it("rejects a caller-recomputed graph that passes integrity but diverts sponsor change", async () => {
        const q = await quote();
        const { jointGraphToWire } = await import("../src/arkade/swapFillBuilder.js");
        const recomputed = jointGraphFromWire(structuredClone(q.graph));
        const tx = Transaction.fromPSBT(base64.decode(recomputed.arkTx));
        let changeVout = -1;
        for (let i = 0; i < tx.outputsLength; i++)
            if (!Extension.isExtension(tx.getOutput(i).script!)) changeVout = i;
        const current = tx.getOutput(changeVout);
        tx.updateOutput(changeVout, { script: current.script!, amount: 1n });
        const diverted = sealGraph({
            ...structuredClone(recomputed),
            arkTx: base64.encode(tx.toPSBT()),
        });
        expect(verifyOfferFillPlan(diverted)).toBe(true);
        const taxiScript = new ArkAddress(
            config().serverPubkey,
            config().operatorKey,
            config().addressHrp,
        ).pkScript;
        const wire = jointGraphToWire(diverted, {
            receiverScript: hex.decode(MAKER_SCRIPT),
            solverScript: hex.decode(PROCEEDS_SCRIPT),
            sponsorScript: taxiScript,
        });
        const rejected = await caught(() => submitQuoted(swapFills.get(q.fillId)!, wire));
        expect(rejected.status).toBe(409);
        expect(rejected.code).toBe("swap_fill_graph_conflict");
        expect(rejected.message).toContain("(not submitted)");
        expect(joint.calls).not.toContain("sign");
        expect(emulator.calls).toHaveLength(0);
        expect(swapFills.get(q.fillId)!.state).toBe("quoted");
    });

    it("refuses submit of any fill that is not quoted without claiming a lease", async () => {
        const q = await quote();
        for (const state of ["submitting", "settled", "cancelled", "expired"] as const) {
            const current = swapFills.get(q.fillId)!;
            swapFills.rows.set(q.fillId, { ...current, state });
            const before = swapFills.events.length;
            const rejected = await caught(() => submitQuoted(swapFills.get(q.fillId)!, q.graph));
            expect(rejected.status).toBe(409);
            expect(joint.calls).toHaveLength(0);
            expect(emulator.calls).toHaveLength(0);
            expect(swapFills.events.slice(before)).not.toContain("claimSubmit");
        }
    });

    it("refuses a submit that relies on an expired quote before claiming", async () => {
        const q = await quote();
        const d = deps({ now: () => NOW + 61 });
        const rejected = await caught(() => submitSwapFill(d, q.fillId, { solverGraph: q.graph }));
        expect(rejected.code).toBe("quote_expired");
        expect(joint.calls).toHaveLength(0);
        expect(emulator.calls).toHaveLength(0);
        expect(swapFills.events).not.toContain("claimSubmit");
        expect(swapFills.get(q.fillId)!.state).toBe("expired");
    });

    it("establishes solver authorisation before any Taxi signature", async () => {
        const q = await quote();
        authFailure = jointError("solver input 1 carries no pinned solver signature");
        const rejected = await caught(() => submitQuoted(swapFills.get(q.fillId)!, q.graph));
        expect(rejected.status).toBe(409);
        expect(rejected.code).toBe("swap_fill_solver_unauthorised");
        expect(rejected.message).toContain("(not submitted)");
        expect(authCalls).toHaveLength(1);
        expect(authCalls[0]!.solverKeys).toEqual(["ab".repeat(32)]);
        expect(joint.calls).not.toContain("sign");
        expect(emulator.calls).toHaveLength(0);
        expect(swapFills.get(q.fillId)!.state).toBe("quoted");
    });

    it("returns a signing failure to quoted when Taxi signing fails", async () => {
        const q = await quote();
        joint.failAt = { op: "sign", error: jointError("signer refused the graph") };
        const rejected = await caught(() => submitQuoted(swapFills.get(q.fillId)!, q.graph));
        expect(rejected.status).toBe(503);
        expect(rejected.code).toBe("swap_fill_signing_failed");
        expect(rejected.message).toContain("(not submitted)");
        expect(emulator.calls).toHaveLength(0);
        const stored = swapFills.get(q.fillId)!;
        expect(stored.state).toBe("quoted");
        expect(stored.failureCode).toBe("swap_fill_signing_failed");
    });

    it("rejects a server-key-only partial at prepare without submitting", async () => {
        const q = await quote();
        joint.failAt = {
            op: "prepare",
            error: jointError("funding input 1 has no solver signature"),
        };
        const rejected = await caught(() => submitQuoted(swapFills.get(q.fillId)!, q.graph));
        expect(rejected.message).toContain("(not submitted)");
        expect(emulator.calls).toHaveLength(0);
        expect(swapFills.get(q.fillId)!.state).toBe("quoted");
    });

    it("holds the reservation and never retries once the provider is invoked", async () => {
        const q = await quote();
        emulator.fail = ambiguousError("emulator submitTx failed");
        const rejected = await caught(() => submitQuoted(swapFills.get(q.fillId)!, q.graph));
        expect(rejected.status).toBe(503);
        expect(rejected.code).toBe("swap_fill_submission_ambiguous");
        expect(rejected.message).toContain("(ambiguous:");
        expect(rejected.message).toContain("never auto-retry");
        expect(emulator.calls).toHaveLength(1);
        const stored = swapFills.get(q.fillId)!;
        expect(stored.state).toBe("submitting");
        expect(swapFills.listReservedOutpoints()).toEqual([TAXI_0]);
        expect(stored.failureCode).toBe("swap_fill_submission_ambiguous");
        expect(stored.nextAttemptAt).toBeGreaterThan(NOW);
    });

    it("treats a signing error from the submit step as not submitted, not ambiguous", async () => {
        const q = await quote();
        joint.failAt = { op: "submit", error: jointError("prepared bytes fail validation") };
        const rejected = await caught(() => submitQuoted(swapFills.get(q.fillId)!, q.graph));
        expect(rejected.message).toContain("(not submitted)");
        expect(rejected.message).not.toContain("(ambiguous:");
        expect(swapFills.get(q.fillId)!.state).toBe("quoted");
    });

    it("marks lease loss at recordPrepared as never submitted", async () => {
        const q = await quote();
        swapFills.recordPrepared = () => false;
        const rejected = await caught(() => submitQuoted(swapFills.get(q.fillId)!, q.graph));
        expect(rejected.status).toBe(409);
        expect(rejected.code).toBe("invalid_state");
        expect(rejected.message).toContain("(not submitted)");
        expect(emulator.calls).toHaveLength(0);
        expect(swapFills.get(q.fillId)!.state).toBe("submitting");
    });

    it("marks lease loss at recordSubmitInvoked as never submitted", async () => {
        const q = await quote();
        swapFills.recordSubmitInvoked = () => false;
        const rejected = await caught(() => submitQuoted(swapFills.get(q.fillId)!, q.graph));
        expect(rejected.status).toBe(409);
        expect(rejected.code).toBe("invalid_state");
        expect(rejected.message).toContain("(not submitted)");
        expect(emulator.calls).toHaveLength(0);
        expect(swapFills.get(q.fillId)!.state).toBe("submitting");
    });

    it("fences a second submitter while the first submit is in flight", async () => {
        const q = await quote();
        const fill = swapFills.get(q.fillId)!;
        let second: Promise<ServiceError> | undefined;
        const submitTx = emulator.submitTx.bind(emulator);
        emulator.submitTx = async (arkTx, checkpoints) => {
            second = caught(() => submitQuoted(fill, q.graph));
            return submitTx(arkTx, checkpoints);
        };
        const first = await submitQuoted(fill, q.graph);
        const rejected = await second!;
        expect(first.state).toBe("submitting");
        expect(rejected.status).toBe(409);
        expect(rejected.code).toBe("invalid_state");
        expect(emulator.calls).toHaveLength(1);
        expect(joint.calls).toEqual(["verify", "sign", "prepare", "covenant", "submit"]);
    });

    it("404s an unknown fill and 400s a malformed solver graph", async () => {
        const first = await quote();
        const missing = await caught(() =>
            submitSwapFill(deps(), "nope", { solverGraph: first.graph }),
        );
        expect(missing.status).toBe(404);
        const q = await quote();
        const malformed = await caught(() =>
            submitSwapFill(deps(), q.fillId, { solverGraph: { template: "taxi-fill/9" } }),
        );
        expect(malformed.status).toBe(400);
        expect(swapFills.get(q.fillId)!.state).toBe("quoted");
        expect(joint.calls).toHaveLength(0);
    });
});

describe("submitSwapFill deadline gate", () => {
    it("refuses at a deadline the clock reaches during signing, before any provider call", async () => {
        const q = await quote();
        joint.onSign = () => {
            clock = q.expiresAt;
        };
        const rejected = await caught(() => submitQuoted(swapFills.get(q.fillId)!, q.graph));
        expect(rejected.status).toBe(409);
        expect(rejected.code).toBe("quote_expired");
        expect(rejected.message).toContain("(not submitted)");
        expect(joint.calls).toEqual(["verify", "sign", "prepare", "covenant"]);
        expect(emulator.calls).toHaveLength(0);
        expect(swapFills.events).not.toContain("recordSubmitInvoked");
        expect(swapFills.get(q.fillId)).toMatchObject({
            state: "expired",
            submitInvoked: false,
            failureCode: "quote_expired",
        });
        expect(swapFills.listReservedOutpoints()).toEqual([]);
    });

    it("submits with a second of the deadline left", async () => {
        const q = await quote();
        joint.onSign = () => {
            clock = q.expiresAt - 1;
        };
        const result = await submitQuoted(swapFills.get(q.fillId)!, q.graph);
        expect(result.state).toBe("submitting");
        expect(emulator.calls).toHaveLength(1);
        expect(swapFills.get(q.fillId)!.submitInvoked).toBe(true);
    });

    it("finishes settlement for a deadline that passes after the provider was invoked", async () => {
        const q = await quote();
        emulator.onCall = () => {
            clock = q.expiresAt + 3600;
        };
        const result = await submitQuoted(swapFills.get(q.fillId)!, q.graph);
        expect(result).toMatchObject({ state: "submitting", txid: joint.preparedTxid });
        expect(emulator.calls).toHaveLength(1);
        expect(swapFills.get(q.fillId)).toMatchObject({
            state: "submitting",
            submitInvoked: true,
        });
        expect(swapFills.listReservedOutpoints()).toEqual([TAXI_0]);
    });

    it("keeps an ambiguous outcome reserved once the deadline has passed", async () => {
        const q = await quote();
        emulator.fail = new Error("connection reset");
        emulator.onCall = () => {
            clock = q.expiresAt + 3600;
        };
        const rejected = await caught(() => submitQuoted(swapFills.get(q.fillId)!, q.graph));
        expect(rejected.code).toBe("swap_fill_submission_ambiguous");
        expect(swapFills.events).toContain("recordAmbiguous");
        expect(swapFills.get(q.fillId)).toMatchObject({
            state: "submitting",
            submitInvoked: true,
            failureCode: "swap_fill_submission_ambiguous",
        });
        expect(swapFills.listReservedOutpoints()).toEqual([TAXI_0]);
    });
});

describe("submitSwapFill bound freshness gate", () => {
    let world: BoundJointFill;
    let freshAt: string[][];
    let freshFailures: (Error | null)[];

    const boundFresh = async (): Promise<void> => {
        freshAt.push([...joint.calls]);
        const failure = freshFailures[freshAt.length - 1];
        if (failure) throw failure;
    };

    const submitBound = (over: Partial<SwapFillSubmitDeps> = {}) =>
        submitSwapFill(
            deps({
                swapFills: world.swapFills,
                config: world.config,
                advances: world.advances,
                assertBoundFresh: boundFresh,
                ...over,
            }),
            world.fill.id,
            { solverGraph: world.quote.graph },
        );

    beforeEach(async () => {
        world = await createBoundJointFill();
        freshAt = [];
        freshFailures = [];
    });
    afterEach(() => world.close());

    it("straddles Taxi signing with two bound freshness checks before submitting", async () => {
        expect(world.fill.receiveQuoteId).toBe("receive-1");
        const result = await submitBound();
        expect(result.state).toBe("submitting");
        expect(freshAt).toEqual([["verify"], ["verify", "sign", "prepare", "covenant"]]);
        expect(emulator.calls).toHaveLength(1);
        expect(world.swapFills.get(world.fill.id)).toMatchObject({
            state: "submitting",
            submitInvoked: true,
        });
    });

    it("fails closed before any Taxi signature when the bound state is stale", async () => {
        freshFailures = [jointError("bound receive quote is missing, stale, or paused")];
        const rejected = await caught(() => submitBound());
        expect(rejected.status).toBe(409);
        expect(rejected.code).toBe("swap_fill_bound_unsafe");
        expect(rejected.message).toContain("(not submitted)");
        expect(joint.calls).not.toContain("sign");
        expect(emulator.calls).toHaveLength(0);
        expect(world.swapFills.get(world.fill.id)).toMatchObject({
            state: "quoted",
            submitInvoked: false,
            failureCode: "swap_fill_bound_unsafe",
        });
    });

    it("fails closed after prepare and before the provider when freshness lapses", async () => {
        freshFailures = [null, jointError("bound input cc..:0 changed")];
        const rejected = await caught(() => submitBound());
        expect(rejected.status).toBe(409);
        expect(rejected.code).toBe("swap_fill_bound_unsafe");
        expect(rejected.message).toContain("(not submitted)");
        expect(freshAt).toHaveLength(2);
        expect(joint.calls).toEqual(["verify", "sign", "prepare", "covenant"]);
        expect(emulator.calls).toHaveLength(0);
        const stored = world.swapFills.get(world.fill.id)!;
        expect(stored.state).toBe("quoted");
        expect(stored.submitInvoked).toBe(false);
        expect(stored.preparedArkTx).toBeDefined();
    });

    it("releases the bound receive quote when the deadline lapses before the provider", async () => {
        joint.onSign = () => {
            clock = world.fill.expiresAt;
        };
        const rejected = await caught(() => submitBound());
        expect(rejected.code).toBe("quote_expired");
        expect(rejected.message).toContain("(not submitted)");
        expect(emulator.calls).toHaveLength(0);
        expect(world.swapFills.get(world.fill.id)).toMatchObject({
            state: "expired",
            submitInvoked: false,
        });
        expect(world.receiveQuotes.get("receive-1")!.state).toBe("expired");
        expect(world.advances.get("receive-1")!.state).toBe("expired");
        expect(world.swapFills.listReservedOutpoints()).toEqual([]);
    });

    it("refuses a bound fill when no freshness verifier is wired", async () => {
        const rejected = await caught(() => submitBound({ assertBoundFresh: undefined }));
        expect(rejected.code).toBe("swap_fill_bound_unsafe");
        expect(rejected.message).toMatch(/freshness verifier is unavailable/);
        expect(joint.calls).not.toContain("sign");
        expect(emulator.calls).toHaveLength(0);
    });

    it("refuses a bound fill whose advance is missing", async () => {
        const rejected = await caught(() => submitBound({ advances: { get: () => undefined } }));
        expect(rejected.code).toBe("swap_fill_bound_unsafe");
        expect(rejected.message).toMatch(/bound advance is missing/);
        expect(freshAt).toHaveLength(0);
        expect(joint.calls).not.toContain("sign");
        expect(emulator.calls).toHaveLength(0);
    });

    it("refuses a bound advance whose persisted source names another fill", async () => {
        const swapped = patchJointSource(world.advance, (source) => {
            source.fillId = "fill-other";
        });
        const rejected = await caught(() => submitBound({ advances: { get: () => swapped } }));
        expect(rejected.code).toBe("swap_fill_bound_unsafe");
        expect(rejected.message).toMatch(/bound funding source association differs/);
        expect(freshAt).toHaveLength(0);
        expect(joint.calls).not.toContain("sign");
        expect(emulator.calls).toHaveLength(0);
    });

    it("refuses a bound advance whose persisted recovery no longer rebuilds", async () => {
        const drifted = patchJointSource(world.advance, (source) => {
            source.recoveryPreflight = foreignRecoveryPreflight();
        });
        const rejected = await caught(() => submitBound({ advances: { get: () => drifted } }));
        expect(rejected.code).toBe("swap_fill_bound_unsafe");
        expect(rejected.message).toMatch(/recovery preflight differs from reconstructed recovery/);
        expect(freshAt).toHaveLength(0);
        expect(joint.calls).not.toContain("sign");
        expect(emulator.calls).toHaveLength(0);
    });
});

describe("assertSolverGraphMatchesTrusted", () => {
    const tweakOutput = (
        graph: JointGraph,
        vout: number,
        over: { script?: Uint8Array; amount?: bigint },
    ): JointGraph => {
        const tx = Transaction.fromPSBT(base64.decode(graph.arkTx));
        const current = tx.getOutput(vout);
        tx.updateOutput(vout, {
            script: over.script ?? current.script!,
            amount: over.amount ?? current.amount!,
        });
        return { ...graph, arkTx: base64.encode(tx.toPSBT()) };
    };

    const tweakInputTxid = (graph: JointGraph, index: number, txid: string): JointGraph => {
        const tx = Transaction.fromPSBT(base64.decode(graph.arkTx));
        tx.updateInput(index, { txid: hex.decode(txid) });
        return { ...graph, arkTx: base64.encode(tx.toPSBT()) };
    };

    const tweakFareUnits = (graph: JointGraph, first: bigint, second: bigint): JointGraph => {
        const tx = Transaction.fromPSBT(base64.decode(graph.arkTx));
        const packet = Extension.fromTx(tx).getAssetPacket()!;
        const groups = packet.groups.map((group, gi) => {
            if (gi !== 0) return group;
            const [head, ...tail] = group.outputs;
            return new asset.AssetGroup(
                group.assetId,
                group.controlAsset,
                [...group.inputs],
                [
                    asset.AssetOutput.create(head!.vout, first),
                    ...tail.map((o, i) =>
                        asset.AssetOutput.create(o.vout, i === 0 ? second : o.amount),
                    ),
                ],
                [],
            );
        });
        const rebuilt = Extension.create([asset.Packet.create(groups)]).serialize();
        for (let i = 0; i < tx.outputsLength; i++)
            if (Extension.isExtension(tx.getOutput(i).script!)) {
                tx.updateOutput(i, { script: rebuilt, amount: 0n });
                break;
            }
        return { ...graph, arkTx: base64.encode(tx.toPSBT()) };
    };

    it("accepts an identical graph and rejects script, sats, id and checkpoint drift", async () => {
        const q = await quote();
        const fill = swapFills.get(q.fillId)!;
        const trusted = storedGraphToJoint(fill.graph);
        const domain = jointGraphFromWire(structuredClone(q.graph));
        expect(() => assertSolverGraphMatchesTrusted(domain, trusted)).not.toThrow();
        const scriptDrift = tweakOutput(domain, 0, { script: new Uint8Array([0x52]) });
        expect(() => assertSolverGraphMatchesTrusted(scriptDrift, trusted)).toThrow(
            /\(not submitted\)/,
        );
        const satsDrift = tweakOutput(domain, 0, { amount: 1n });
        expect(() => assertSolverGraphMatchesTrusted(satsDrift, trusted)).toThrow(
            /\(not submitted\)/,
        );
        const idDrift = { ...structuredClone(domain), graphId: "07".repeat(32) };
        expect(() => assertSolverGraphMatchesTrusted(idDrift, trusted)).toThrow(
            /\(not submitted\)/,
        );
        const cpDrift = {
            ...structuredClone(domain),
            checkpoints: [...domain.checkpoints, Buffer.from("extra").toString("base64")],
        };
        expect(() => assertSolverGraphMatchesTrusted(cpDrift, trusted)).toThrow(
            /\(not submitted\)/,
        );
        const ownerDrift = {
            ...structuredClone(domain),
            inputOwners: domain.inputOwners.map((owner, i) => (i === 1 ? "sponsor" : owner)),
        };
        expect(() => assertSolverGraphMatchesTrusted(ownerDrift, trusted)).toThrow(
            /\(not submitted\)/,
        );
        const txidDrift = tweakInputTxid(domain, 1, "ff".repeat(32));
        expect(() => assertSolverGraphMatchesTrusted(txidDrift, trusted)).toThrow(
            /\(not submitted\)/,
        );
        const assetDrift = tweakFareUnits(domain, 6n, 94n);
        expect(() => assertSolverGraphMatchesTrusted(assetDrift, trusted)).toThrow(
            /\(not submitted\)/,
        );
    });
});

describe("assertSolverAuthorised", () => {
    it("rejects a graph that is not a parsable PSBT without signing anything", () => {
        const unsigned = {
            arkTx: "aGVsbG8=",
            checkpoints: ["d29ybGQ="],
            graphId: "ab".repeat(32),
            inputOwners: [null, "solver"],
        } as unknown as JointGraph;
        expect(() =>
            assertSolverAuthorised({ solver: unsigned, trusted: unsigned, solverKeys: [] }),
        ).toThrow(/\(not submitted\)/);
    });

    it("rejects same-length graphs with drifted owners or outpoints before touching PSBTs", () => {
        const trusted = authGraph({
            owners: [null, "solver"],
            arkSigs: [[], []],
            checkpointSigs: [[], []],
        });
        const ownerDrift: JointGraph = {
            ...trusted,
            inputOwners: [null, "sponsor"],
        };
        expect(() =>
            assertSolverAuthorised({ solver: ownerDrift, trusted, solverKeys: [] }),
        ).toThrow(/shape differs/);
        const txidDrift = authGraph({
            owners: [null, "solver"],
            outpoints: [
                { txid: "bb".repeat(32), vout: 0 },
                { txid: "cc".repeat(32), vout: 1 },
            ],
            arkSigs: [[], []],
            checkpointSigs: [[], []],
        });
        expect(() =>
            assertSolverAuthorised({ solver: txidDrift, trusted, solverKeys: [] }),
        ).toThrow(/shape differs/);
        const voutDrift = authGraph({
            owners: [null, "solver"],
            outpoints: [
                { txid: "bb".repeat(32), vout: 0 },
                { txid: "bb".repeat(32), vout: 9 },
            ],
            arkSigs: [[], []],
            checkpointSigs: [[], []],
        });
        expect(() =>
            assertSolverAuthorised({ solver: voutDrift, trusted, solverKeys: [] }),
        ).toThrow(/shape differs/);
    });

    it("rejects an unpinned key on a solver input without verifying signatures", () => {
        const graph = authGraph({
            owners: [null, "solver"],
            arkSigs: [[], [UNPINNED]],
            checkpointSigs: [[], [PINNED]],
        });
        expect(() =>
            assertSolverAuthorised({ solver: graph, trusted: graph, solverKeys: [PINNED_HEX] }),
        ).toThrow(/carries a signature from unpinned key/);
    });

    it("rejects a solver-supplied signature on the covenant input", () => {
        const graph = authGraph({
            owners: [null, "solver"],
            arkSigs: [[PINNED], []],
            checkpointSigs: [[], []],
        });
        expect(() =>
            assertSolverAuthorised({ solver: graph, trusted: graph, solverKeys: [PINNED_HEX] }),
        ).toThrow(/signs the covenant input/);
    });

    it("rejects a solver-supplied signature on a sponsor input", () => {
        const graph = authGraph({
            owners: [null, "sponsor"],
            arkSigs: [[], [PINNED]],
            checkpointSigs: [[], []],
        });
        expect(() =>
            assertSolverAuthorised({ solver: graph, trusted: graph, solverKeys: [PINNED_HEX] }),
        ).toThrow(/signs sponsor input 1/);
    });
});

/**
 * The accept path needs signatures that actually verify, so `authGraph`'s
 * zero-filled entries cannot reach it — every case above stops at a shape or
 * key check. Without this, `assertSolverAuthorised` could reject everything and
 * the suite would still pass.
 */
describe("assertSolverAuthorised accepts a properly signed solver graph", () => {
    const SOLVER_SEED = new Uint8Array(32).fill(21);
    const SERVER_SEED = new Uint8Array(32).fill(22);
    const solverX = schnorr.getPublicKey(SOLVER_SEED);
    const serverX = schnorr.getPublicKey(SERVER_SEED);
    const solverHex = hex.encode(solverX);

    const tree = new VtxoScript([MultisigTapscript.encode({ pubkeys: [solverX, serverX] }).script]);
    const unroll = CSVMultisigTapscript.encode({
        timelock: { type: "blocks", value: BigInt(10) },
        pubkeys: [serverX],
    });
    const coin = (txid: string) => ({
        txid,
        vout: 0,
        value: 5_000,
        tapLeafScript: tree.leaves[0],
        tapTree: tree.encode(),
    });

    /** Two inputs — covenant at 0, solver at 1 — with real checkpoints. */
    const build = () =>
        buildOffchainTx(
            [coin("aa".repeat(32)), coin("bb".repeat(32))],
            [{ script: new Uint8Array([0x51, 0x20, ...solverX]), amount: BigInt(9_000) }],
            unroll,
        );

    const graphOf = async (seed: Uint8Array | null) => {
        const { arkTx, checkpoints } = build();
        const signer = seed ? SingleKey.fromPrivateKey(seed) : undefined;
        const ark = signer ? await signer.sign(arkTx.clone(), [1]) : arkTx;
        const cps = await Promise.all(
            checkpoints.map(async (cp, i) =>
                signer && i === 1 ? await signer.sign(cp.clone(), [0]) : cp,
            ),
        );
        return {
            arkTx: base64.encode(ark.toPSBT()),
            checkpoints: cps.map((c) => base64.encode(c.toPSBT())),
            graphId: "cd".repeat(32),
            inputOwners: [null, "solver"] as JointGraph["inputOwners"],
        };
    };

    it("accepts a graph the pinned solver key really signed", async () => {
        const signed = await graphOf(SOLVER_SEED);
        const trusted = await graphOf(null);
        expect(() =>
            assertSolverAuthorised({ solver: signed, trusted, solverKeys: [solverHex] }),
        ).not.toThrow();
    });

    // Pinned key, right leaf, wrong bytes: the only case that reaches
    // verifyTapscriptSignatures instead of stopping at a shape or key check.
    it("rejects a pinned signature whose bytes do not verify", async () => {
        const signed = await graphOf(SOLVER_SEED);
        const tx = Transaction.fromPSBT(base64.decode(signed.arkTx));
        const [[meta, sig]] = tx.getInput(1).tapScriptSig!;
        const bad = new Uint8Array(sig);
        bad[10] ^= 0xff;
        // Clear first: updateInput merges, so writing alone keeps the good one.
        tx.updateInput(1, { tapScriptSig: undefined });
        tx.updateInput(1, { tapScriptSig: [[meta, bad]] });
        const tampered = { ...signed, arkTx: base64.encode(tx.toPSBT()) };
        const trusted = await graphOf(null);
        expect(() =>
            assertSolverAuthorised({ solver: tampered, trusted, solverKeys: [solverHex] }),
        ).toThrow(/invalid solver signature/);
    });

    it("rejects a solver input carrying no signature at all", async () => {
        const unsigned = await graphOf(null);
        expect(() =>
            assertSolverAuthorised({
                solver: unsigned,
                trusted: unsigned,
                solverKeys: [solverHex],
            }),
        ).toThrow(/no pinned solver signature/);
    });

    it("passes a pinned signature on another trusted leaf, which signForTaxi refuses unsigned", async () => {
        const sponsorSeed = new Uint8Array(32).fill(24);
        const sponsorTree = new VtxoScript([
            MultisigTapscript.encode({ pubkeys: [schnorr.getPublicKey(sponsorSeed), serverX] })
                .script,
        ]);
        const offLeaf = MultisigTapscript.encode({
            pubkeys: [schnorr.getPublicKey(new Uint8Array(32).fill(23)), serverX],
        }).script;
        const { arkTx, checkpoints } = buildOffchainTx(
            [
                coin("aa".repeat(32)),
                coin("bb".repeat(32)),
                {
                    ...coin("cc".repeat(32)),
                    tapLeafScript: sponsorTree.leaves[0],
                    tapTree: sponsorTree.encode(),
                },
            ],
            [{ script: new Uint8Array([0x51, 0x20, ...solverX]), amount: BigInt(14_000) }],
            unroll,
        );
        const ownLeaf = MultisigTapscript.encode({ pubkeys: [solverX, serverX] }).script;
        const twin = new VtxoScript([ownLeaf, offLeaf]);
        arkTx.updateInput(1, {
            tapLeafScript: [...arkTx.getInput(1).tapLeafScript!, twin.leaves[1]],
        });
        const trusted = sealGraph({
            arkTx: base64.encode(arkTx.toPSBT()),
            checkpoints: checkpoints.map((cp) => base64.encode(cp.toPSBT())),
            graphId: "",
            inputOwners: [null, "solver", "sponsor"],
        });

        const off = tapLeavesOfInput(arkTx, 1).find(
            (l) => hex.encode(l.script) === hex.encode(offLeaf),
        )!;
        const prevouts = [0, 1, 2].map((i) => arkTx.getInput(i).witnessUtxo!);
        const message = arkTx.preimageWitnessV1(
            1,
            prevouts.map((p) => p.script),
            0,
            prevouts.map((p) => p.amount),
            undefined,
            off.script,
            off.version,
        );
        const signedArk = arkTx.clone();
        setTapScriptSigEntries(signedArk, 1, [
            {
                pubKey: solverX,
                leafHash: hex.decode(off.leafHashHex),
                signature: schnorr.sign(message, SOLVER_SEED),
            },
        ]);
        const solverCp = await SingleKey.fromPrivateKey(SOLVER_SEED).sign(
            checkpoints[1]!.clone(),
            [0],
        );
        const solver: JointGraph = {
            ...trusted,
            arkTx: base64.encode(signedArk.toPSBT()),
            checkpoints: trusted.checkpoints.map((cp, i) =>
                i === 1 ? base64.encode(solverCp.toPSBT()) : cp,
            ),
        };

        expect(() =>
            assertSolverAuthorised({ solver, trusted, solverKeys: [solverHex] }),
        ).not.toThrow();
        const sponsor = SingleKey.fromPrivateKey(sponsorSeed);
        let taxiSigned = 0;
        const identity = {
            xOnlyPublicKey: () => sponsor.xOnlyPublicKey(),
            sign: (tx: Transaction, indexes?: number[]) => {
                taxiSigned++;
                return sponsor.sign(tx, indexes);
            },
        } as unknown as Identity;
        await expect(
            productionSwapFillJointOps.signForTaxi({
                expected: trusted,
                partial: solver,
                bindings: [{ inputIndex: 2, identity }],
            }),
        ).rejects.toThrow(/input 1 signature is not on its selected leaf/);
        expect(taxiSigned).toBe(0);
    });
});
