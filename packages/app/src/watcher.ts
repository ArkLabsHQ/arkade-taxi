import {
    DustCovenantScript,
    Leaf,
    covenantSpendInput,
    loanSats,
    lockupSats,
    payoutPkScript,
    recycleFare,
    refundTopup,
} from "@arkade-taxi/covenant";
import type { Advance } from "@arkade-taxi/core";
import { advanceKind, covenantParamsOf } from "@arkade-taxi/core";
import type { AdvanceRepository, PolicyRepository } from "@arkade-taxi/db";
import {
    CSVMultisigTapscript,
    EmulatorPacket,
    Extension,
    MultisigTapscript,
    P2A,
    Transaction,
    VtxoScript,
    VtxoTaprootTree,
    asset,
    arkade,
    assertAllowedSighashTypes,
    getArkPsbtFields,
    isVtxoSpent,
    scriptFromTapLeafScript,
    verifyTapscriptSignatures,
    type IContractManager,
    type IndexerProvider,
    type TapLeafScript,
    type VirtualCoin,
    type Wallet,
} from "@arkade-os/sdk";
import { base64, hex } from "@scure/base";
import { createHash } from "node:crypto";
import type { RuntimeConfig } from "./config.js";
import { decodeLockupEnvelope } from "./arkade/psbt.js";
import { readFundingSource } from "./arkade/fundingSource.js";
import { sameTapTree } from "./arkade/tapTree.js";

const { AssetGroup, AssetId, AssetInput, AssetOutput, Packet } = asset;
const DEFAULT_SIGHASH = 0;
const SIGNATURE_CACHE_LIMIT = 1024;
/** Both reads carry every key in the URL, so a scan-wide batch still chunks. */
const CHUNK_KEYS = 100;
const UNROLLED = "covenant outpoint was unrolled; no off-chain claim or recovery is possible";

type SignatureCheck = (tx: Transaction, index: number, signers: string[]) => void;
const verifySignatures: SignatureCheck = (tx, index, signers) =>
    verifyTapscriptSignatures(tx, index, signers, [], [DEFAULT_SIGHASH]);

export type ObservedSpend =
    | { kind: "recycled"; txid: string }
    | { kind: "purchased"; txid: string }
    | { kind: "refunded"; txid: string }
    | { kind: "recovered"; txid: string }
    | { kind: "unknown"; txid: string; reason: string };

export interface WatcherBlocker {
    advanceId?: string;
    code: string;
    detail: string;
}

export interface SpendWatcherStatus {
    lastScanAt: number | null;
    watching: number;
    /** The live subset the per-tick scan classifies; `watching` stays the total. */
    activelyScanned: number;
    blockers: WatcherBlocker[];
    warnings: WatcherBlocker[];
}

export interface SpendWatcher {
    catchUp(): Promise<void>;
    start(): Promise<void>;
    stop(): Promise<void>;
    status(): SpendWatcherStatus;
    isRecoverable(id: string): boolean;
}

export interface SpendWatcherDeps {
    advances: Pick<
        AdvanceRepository,
        | "byState"
        | "recordSpendObservation"
        | "recordSpendUnknown"
        | "recordCovenantUnrolled"
        | "recordCovenantRenewed"
        | "clearSpendUnknown"
        | "recordSpendDisagreement"
        | "recordStableSpendObservation"
    >;
    policy: Pick<PolicyRepository, "get" | "update">;
    indexer: Pick<IndexerProvider, "getVtxos" | "getVirtualTxs">;
    config: RuntimeConfig;
    now(): number;
    tip(): Promise<{ hash: string; height: number; time: number }>;
    wallet?: () => Pick<Wallet, "getContractManager"> | undefined;
    onPrompt?: () => Promise<void>;
    onScanMetrics?: (metrics: {
        watching: number;
        activelyScanned: number;
        elapsedMs: number;
        getVtxos: number;
        getVirtualTxs: number;
        outpoints: number;
        txids: number;
    }) => void;
}

class EvidenceError extends Error {}

const fail = (message: string): never => {
    throw new EvidenceError(message);
};
const sameBytes = (a: Uint8Array, b: Uint8Array): boolean =>
    a.length === b.length && a.every((value, index) => value === b[index]);
const sameOutpoint = (
    value: { txid: string; vout: number },
    expected: { txid: string; vout: number },
): boolean => value.txid === expected.txid && value.vout === expected.vout;
const txid = (input: ReturnType<Transaction["getInput"]>): string =>
    input.txid ? hex.encode(input.txid) : fail("transaction input has no txid");

const exactOutput = (
    tx: Transaction,
    index: number,
    amount: bigint,
    script: Uint8Array,
    label: string,
): void => {
    const output = tx.getOutput(index);
    if (output.amount !== amount || !output.script || !sameBytes(output.script, script))
        fail(`${label} differs from the exact covenant shape`);
};

const exactTree = (tx: Transaction, index: number, expected: VtxoScript, label: string): void => {
    const fields = getArkPsbtFields(tx, index, VtxoTaprootTree);
    if (fields.length !== 1 || !sameTapTree(fields[0], expected))
        fail(`${label} taproot tree mismatch`);
};

const exactLeaf = (actual: TapLeafScript, expected: TapLeafScript, label: string): void => {
    if (
        actual[0].version !== expected[0].version ||
        !sameBytes(actual[0].internalKey, expected[0].internalKey) ||
        actual[0].merklePath.length !== expected[0].merklePath.length ||
        actual[0].merklePath.some(
            (node, index) => !sameBytes(node, expected[0].merklePath[index]!),
        ) ||
        !sameBytes(actual[1], expected[1])
    )
        fail(`${label} leaf or control proof mismatch`);
};

const selectedLeaf = (tx: Transaction, index: number, expected: TapLeafScript, label: string) => {
    const leaves = tx.getInput(index).tapLeafScript;
    if (!leaves || leaves.length !== 1) fail(`${label} must select exactly one leaf`);
    exactLeaf(leaves![0]!, expected, label);
    return leaves![0]!;
};

const exactSignatures = (
    tx: Transaction,
    index: number,
    leaf: TapLeafScript,
    signers: Uint8Array[],
    label: string,
    verify: SignatureCheck,
): void => {
    try {
        assertAllowedSighashTypes(tx, [DEFAULT_SIGHASH]);
    } catch {
        fail(`${label} uses a non-default sighash`);
    }
    const signatures = tx.getInput(index).tapScriptSig ?? [];
    const expected = new Set(signers.map(hex.encode));
    const leafHash = signatures[0]?.[0].leafHash;
    if (
        signatures.length !== expected.size ||
        !leafHash ||
        signatures.some(
            ([metadata, signature]) =>
                signature.length !== 64 ||
                !expected.has(hex.encode(metadata.pubKey)) ||
                !sameBytes(metadata.leafHash, leafHash),
        ) ||
        new Set(signatures.map(([metadata]) => hex.encode(metadata.pubKey))).size !== expected.size
    )
        fail(`${label} signer set mismatch`);
    try {
        verify(tx, index, [...expected]);
    } catch {
        fail(`${label} signature verification failed`);
    }
};

interface Holding {
    id: string;
    amount: bigint;
}

const holdings = (coin: VirtualCoin, label: string): Holding[] => {
    if (coin.assets !== undefined && !Array.isArray(coin.assets)) fail(`${label} assets malformed`);
    const values = (coin.assets ?? []).map(({ assetId: id, amount }) => {
        if (AssetId.fromString(id).toString() !== id || amount <= 0n)
            fail(`${label} asset holding malformed`);
        return { id, amount };
    });
    if (new Set(values.map(({ id }) => id)).size !== values.length)
        fail(`${label} contains duplicate asset groups`);
    return values.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
};

const holdingsDiffer = (actual: readonly Holding[], expected: readonly Holding[]): boolean =>
    actual.length !== expected.length ||
    actual.some(
        (holding, index) =>
            holding.id !== expected[index]!.id || holding.amount !== expected[index]!.amount,
    );

const assetId = (advance: Advance): string | undefined =>
    advance.assetId
        ? AssetId.create(
              hex.encode(Uint8Array.from(advance.assetId.txid).reverse()),
              advance.assetId.groupIndex,
          ).toString()
        : undefined;

type AssetFare = { id: string; vout: number; units: bigint };

const expectedAssetPacket = (
    sources: Holding[][],
    destination: number,
    fare?: AssetFare,
): asset.Packet | null => {
    const totals = new Map<string, bigint>();
    sources.forEach((source) =>
        source.forEach(({ id, amount }) => totals.set(id, (totals.get(id) ?? 0n) + amount)),
    );
    if (!totals.size) return null;
    return Packet.create(
        [...totals]
            .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
            .map(([id, amount]) =>
                AssetGroup.create(
                    AssetId.fromString(id),
                    null,
                    sources.flatMap((source, vin) =>
                        source.some((holding) => holding.id === id)
                            ? [
                                  AssetInput.create(
                                      vin,
                                      source.find((holding) => holding.id === id)!.amount,
                                  ),
                              ]
                            : [],
                    ),
                    fare?.id === id
                        ? [
                              AssetOutput.create(fare.vout, fare.units),
                              AssetOutput.create(destination, amount - fare.units),
                          ]
                        : [AssetOutput.create(destination, amount)],
                    [],
                ),
            ),
    );
};

const exactExtension = (
    tx: Transaction,
    index: number,
    covenantScript: Uint8Array,
    sources: Holding[][],
    destination: number,
    fare?: AssetFare,
): void => {
    const output = tx.getOutput(index);
    const script = output.script ?? fail("covenant extension output is missing or misplaced");
    if (output.amount !== 0n || !Extension.isExtension(script))
        fail("covenant extension output is missing or misplaced");
    const assets = expectedAssetPacket(sources, destination, fare);
    const expected = Extension.create([
        ...(assets ? [assets] : []),
        EmulatorPacket.create([{ vin: 0, script: covenantScript }]),
    ]).serialize();
    if (!sameBytes(script, expected))
        fail("extension packet set does not exactly conserve and bind the covenant spend");
};

const exactAnchor = (tx: Transaction, index: number): void =>
    exactOutput(tx, index, P2A.amount, P2A.script, "P2A anchor");

/** A leaf's own output by content: only out[0..1] are pinned, the rest is the spender's. */
const soleOutput = (
    tx: Transaction,
    matches: (output: ReturnType<Transaction["getOutput"]>) => boolean,
    label: string,
): number => {
    const found = Array.from({ length: tx.outputsLength }, (_, index) => index).filter((index) =>
        matches(tx.getOutput(index)),
    );
    if (found.length !== 1) fail(`${label} output is missing or ambiguous`);
    return found[0]!;
};

const extensionIndex = (tx: Transaction): number =>
    soleOutput(
        tx,
        (output) => output.script !== undefined && Extension.isExtension(output.script),
        "covenant extension",
    );

const anchorIndex = (tx: Transaction): number =>
    soleOutput(
        tx,
        (output) =>
            output.amount === P2A.amount &&
            output.script !== undefined &&
            sameBytes(output.script, P2A.script),
        "P2A anchor",
    );

const exactTransactionHeader = (
    tx: Transaction,
    lockTime: number,
    label: string,
    /** A v2 reclaim can be taken early off a swept coin, so its CLTV is a
     * ceiling, not an equality: refusing it would open no custody row. */
    atMost = false,
): void => {
    if (tx.version !== 3 || (atMost ? tx.lockTime > lockTime : tx.lockTime !== lockTime))
        fail(`${label} version or locktime differs from the SDK 0.4.72 graph`);
    const sequence = tx.lockTime === 0 ? 0xffffffff : 0xfffffffe;
    for (let index = 0; index < tx.inputsLength; index++) {
        if (tx.getInput(index).sequence !== sequence)
            fail(`${label} input ${index} sequence differs from the SDK 0.4.72 graph`);
    }
};

const rawTransactions = async (
    provider: SpendWatcherDeps["indexer"],
    ids: string[],
): Promise<Map<string, Transaction>> => {
    let response: Awaited<ReturnType<IndexerProvider["getVirtualTxs"]>>;
    try {
        response = await provider.getVirtualTxs(ids);
    } catch {
        return fail("canonical transaction evidence is unavailable");
    }
    if (!response || !Array.isArray(response.txs) || response.txs.length !== ids.length)
        fail("indexer omitted a required transaction in the spend chain");
    const result = new Map<string, Transaction>();
    for (const encoded of response.txs) {
        let tx: Transaction;
        try {
            tx = Transaction.fromPSBT(base64.decode(encoded));
        } catch {
            return fail("indexer returned a malformed transaction PSBT");
        }
        if (!ids.includes(tx.id) || result.has(tx.id))
            fail("indexer returned duplicate or unrelated transaction evidence");
        result.set(tx.id, tx);
    }
    return result;
};

const exactCoin = async (
    provider: SpendWatcherDeps["indexer"],
    outpoint: { txid: string; vout: number },
): Promise<VirtualCoin | undefined> => {
    let response: Awaited<ReturnType<IndexerProvider["getVtxos"]>>;
    try {
        response = await provider.getVtxos({ outpoints: [outpoint] });
    } catch {
        return fail("canonical outpoint evidence is unavailable");
    }
    if (!response || !Array.isArray(response.vtxos) || response.vtxos.length > 1)
        fail("indexer returned ambiguous outpoint evidence");
    const coin = response.vtxos[0];
    if (coin && !sameOutpoint(coin, outpoint)) fail("indexer returned a different outpoint");
    return coin;
};

const covenantFacts = (advance: Advance, config: RuntimeConfig) => {
    if (!advance.outpoint) fail("advance has no persisted covenant outpoint");
    const outpoint = advance.outpoint!;
    const script = new DustCovenantScript({
        serverKey: config.serverPubkey,
        emulatorKey: config.emulatorPubkey,
        vtxoMinAmount: config.vtxoMinAmount,
        params: covenantParamsOf(advance),
    });
    const tagged = readFundingSource(advance.unsignedLockupTx);
    const envelope =
        tagged.kind === "legacy" ? decodeLockupEnvelope(advance.unsignedLockupTx) : undefined;
    const graphId =
        tagged.kind === "joint-fill" ? tagged.source.graph.graphId : envelope!.unsignedTxId;
    const covenantOutputIndex =
        tagged.kind === "joint-fill" ? tagged.covenantOutpoint.vout : envelope!.covenantOutputIndex;
    const serverUnrollScript =
        tagged.kind === "joint-fill"
            ? tagged.source.serverUnrollScript
            : envelope!.serverUnrollScript;
    if (
        graphId !== advance.unsignedLockupId ||
        covenantOutputIndex !== outpoint.vout ||
        serverUnrollScript !==
            hex.encode(CSVMultisigTapscript.decode(hex.decode(serverUnrollScript)).script)
    )
        fail("persisted lockup commitments are inconsistent");
    const lockup = Transaction.fromPSBT(
        base64.decode(tagged.kind === "joint-fill" ? tagged.source.graph.arkTx : envelope!.arkTx),
    );
    if (lockup.id !== outpoint.txid || lockup.outputsLength <= outpoint.vout)
        fail("persisted covenant outpoint does not belong to the lockup graph");
    const value = lockupSats(script.options.params);
    exactOutput(lockup, outpoint.vout, value, script.pkScript, "lockup covenant");
    if (script.address(config.addressHrp, config.serverPubkey).encode() !== advance.covenantAddress)
        fail("persisted covenant address mismatch");
    const expectedAsset = assetId(advance);
    const units =
        tagged.kind === "joint-fill"
            ? tagged.assetUnits
            : envelope!.assetUnits === undefined
              ? undefined
              : BigInt(envelope!.assetUnits);
    if (
        (expectedAsset === undefined) !== (units === undefined) ||
        (units !== undefined && units <= 0n)
    )
        fail("persisted covenant asset facts mismatch");
    return {
        script,
        value,
        unroll: CSVMultisigTapscript.decode(hex.decode(serverUnrollScript)),
        expectedHoldings: expectedAsset ? [{ id: expectedAsset, amount: units! }] : [],
    };
};

/**
 * Whether a coin still carries the recorded terminal verdict. `spentTxid` is the
 * arkTx id — never `coin.spentBy`, the checkpoint, which the classifier requires
 * to differ from it; comparing that pair would disagree on every row at once.
 */
const agrees = (
    advance: Advance,
    coin: VirtualCoin,
    facts: ReturnType<typeof covenantFacts>,
): boolean => {
    try {
        return (
            coin.isSpent === true &&
            coin.arkTxId === advance.spentTxid &&
            coin.value === Number(facts.value) &&
            coin.script === hex.encode(facts.script.pkScript) &&
            !holdingsDiffer(holdings(coin, "covenant outpoint"), facts.expectedHoldings)
        );
    } catch {
        return false;
    }
};

/** A batch settlement, not a checkpoint+arkTx pair: `settledBy` is the signal. */
const renewalCommitment = (coin: VirtualCoin): string | undefined =>
    /^[0-9a-f]{64}$/.test(coin.settledBy ?? "") && !coin.spentBy && !coin.arkTxId
        ? coin.settledBy
        : undefined;

/** Script, value and assets: the only facts a renewal preserves. */
const sameCovenant = (coin: VirtualCoin, facts: ReturnType<typeof covenantFacts>): boolean => {
    try {
        return (
            coin.value === Number(facts.value) &&
            coin.script === hex.encode(facts.script.pkScript) &&
            !holdingsDiffer(holdings(coin, "covenant outpoint"), facts.expectedHoldings)
        );
    } catch {
        return false;
    }
};

const exactSuccessor = async (
    provider: SpendWatcherDeps["indexer"],
    predecessor: VirtualCoin,
    facts: ReturnType<typeof covenantFacts>,
): Promise<VirtualCoin> => {
    let response: Awaited<ReturnType<IndexerProvider["getVtxos"]>>;
    try {
        response = await provider.getVtxos({ scripts: [predecessor.script] });
    } catch {
        return fail("canonical renewal successor evidence is unavailable");
    }
    if (!response || !Array.isArray(response.vtxos))
        fail("indexer returned no renewal successor evidence");
    const live = response.vtxos.filter(
        (coin) =>
            !isVtxoSpent(coin) &&
            coin.isSwept === false &&
            coin.isUnrolled === false &&
            sameCovenant(coin, facts),
    );
    // Two v2 covenants differing only in paymentSats share one address, so an
    // ambiguous pair is refused rather than guessed at.
    if (live.length !== 1) fail("renewal successor is missing or ambiguous");
    return live[0]!;
};

const lockingOutpoint = (advance: Advance): { txid: string; vout: number } => {
    const tagged = readFundingSource(advance.unsignedLockupTx);
    if (tagged.kind === "joint-fill") {
        if (tagged.source.graph.graphId !== advance.unsignedLockupId)
            fail("persisted lockup commitments are inconsistent");
        return tagged.covenantOutpoint;
    }
    const envelope = decodeLockupEnvelope(advance.unsignedLockupTx);
    if (envelope.unsignedTxId !== advance.unsignedLockupId)
        fail("persisted lockup commitments are inconsistent");
    const lockup = Transaction.fromPSBT(base64.decode(envelope.arkTx));
    if (lockup.outputsLength <= envelope.covenantOutputIndex)
        fail("persisted covenant output is missing from the lockup graph");
    return { txid: lockup.id, vout: envelope.covenantOutputIndex };
};

const directCheckpoint = (
    tx: Transaction,
    outpoint: { txid: string; vout: number },
    value: bigint,
    sourceTree: VtxoScript,
    leaf: TapLeafScript,
    unroll: CSVMultisigTapscript.Type,
    signers: Uint8Array[],
    label: string,
    verify: SignatureCheck,
): VtxoScript => {
    if (tx.inputsLength !== 1 || tx.outputsLength !== 2) fail(`${label} shape mismatch`);
    const input = tx.getInput(0);
    if (
        txid(input) !== outpoint.txid ||
        input.index !== outpoint.vout ||
        input.witnessUtxo?.amount !== value ||
        !input.witnessUtxo.script ||
        !sameBytes(input.witnessUtxo.script, sourceTree.pkScript)
    )
        fail(`${label} does not spend the exact persisted prevout`);
    exactTree(tx, 0, sourceTree, label);
    const selected = selectedLeaf(tx, 0, leaf, label);
    exactSignatures(tx, 0, selected, signers, label, verify);
    const tree = new VtxoScript([unroll.script, scriptFromTapLeafScript(leaf)]);
    exactOutput(tx, 0, value, tree.pkScript, `${label} output`);
    exactAnchor(tx, 1);
    return tree;
};

const arkInput = (
    arkTx: Transaction,
    index: number,
    checkpoint: Transaction,
    value: bigint,
    tree: VtxoScript,
    leaf: Uint8Array,
    signers: Uint8Array[],
    label: string,
    verify: SignatureCheck,
): void => {
    const input = arkTx.getInput(index);
    if (
        txid(input) !== checkpoint.id ||
        input.index !== 0 ||
        input.witnessUtxo?.amount !== value ||
        !input.witnessUtxo.script ||
        !sameBytes(input.witnessUtxo.script, tree.pkScript)
    )
        fail(`${label} does not spend its exact checkpoint`);
    exactTree(arkTx, index, tree, label);
    const expected = tree.findLeaf(hex.encode(leaf));
    const selected = selectedLeaf(arkTx, index, expected, label);
    exactSignatures(arkTx, index, selected, signers, label, verify);
};

/**
 * The claimant's own coin at input 1 of a two-input covenant spend. `expected`
 * pins its script to a persisted key; v2's refund leaf binds it to out[1]
 * instead, so that caller passes none.
 */
const secondInput = async (
    arkTx: Transaction,
    unroll: CSVMultisigTapscript.Type,
    deps: Pick<SpendWatcherDeps, "indexer" | "config">,
    verify: SignatureCheck,
    label: string,
    expected?: Uint8Array,
): Promise<VirtualCoin> => {
    const checkpointId = txid(arkTx.getInput(1));
    const raw = await rawTransactions(deps.indexer, [checkpointId]);
    const checkpoint = raw.get(checkpointId)!;
    exactTransactionHeader(checkpoint, 0, `${label} checkpoint`);
    const spent = checkpoint.getInput(0);
    const outpoint = { txid: txid(spent), vout: spent.index! };
    const found = await exactCoin(deps.indexer, outpoint);
    if (!found || !found.isSpent || found.spentBy !== checkpoint.id || found.arkTxId !== arkTx.id)
        fail(`${label} funding outpoint lacks exact canonical spend evidence`);
    const coin = found!;
    const trees = getArkPsbtFields(checkpoint, 0, VtxoTaprootTree);
    if (trees.length !== 1) fail(`${label} funding tree is missing or ambiguous`);
    const tree = VtxoScript.decode(trees[0]!);
    if (
        !sameTapTree(trees[0]!, tree) ||
        (expected !== undefined && !sameBytes(tree.pkScript, expected)) ||
        coin.script !== hex.encode(tree.pkScript)
    )
        fail(`${label} funding tree does not belong to the persisted ${label}`);
    const heightExpiry = coin.expiresAtHeight;
    const timeExpiry = coin.expiresAt;
    if (
        (heightExpiry === undefined) === (timeExpiry === undefined) ||
        (heightExpiry !== undefined &&
            (!Number.isSafeInteger(heightExpiry) || heightExpiry <= 0)) ||
        (timeExpiry !== undefined &&
            (!(timeExpiry instanceof Date) ||
                !Number.isSafeInteger(timeExpiry.getTime()) ||
                timeExpiry.getTime() <= 0)) ||
        !(coin.createdAt instanceof Date) ||
        !Number.isSafeInteger(coin.createdAt.getTime()) ||
        coin.createdAt.getTime() < 0 ||
        coin.isUnrolled !== false ||
        // Already spent above, so its batch may since have been swept.
        typeof coin.isSwept !== "boolean" ||
        typeof coin.isPreconfirmed !== "boolean" ||
        typeof coin.status?.confirmed !== "boolean" ||
        typeof coin.status.isLeaf !== "boolean" ||
        coin.status.confirmed === coin.isPreconfirmed ||
        coin.status.isLeaf === coin.isPreconfirmed ||
        !Array.isArray(coin.commitmentTxIds) ||
        coin.commitmentTxIds.some((id) => !/^[0-9a-f]{64}$/.test(id)) ||
        !Number.isSafeInteger(coin.value) ||
        coin.value <= 0
    )
        fail(`${label} funding canonical status or expiry is inconsistent`);
    const leaves = checkpoint.getInput(0).tapLeafScript;
    if (!leaves || leaves.length !== 1) fail(`${label} checkpoint leaf is ambiguous`);
    const leafBody = scriptFromTapLeafScript(leaves![0]!);
    const closure = MultisigTapscript.decode(leafBody);
    if (
        closure.params.pubkeys.length !== 2 ||
        sameBytes(closure.params.pubkeys[0]!, closure.params.pubkeys[1]!) ||
        !closure.params.pubkeys.some((pubkey) => sameBytes(pubkey, deps.config.serverPubkey))
    )
        fail(`${label} funding leaf has unexpected signers`);
    const signers = closure.params.pubkeys;
    const checkpointTree = directCheckpoint(
        checkpoint,
        outpoint,
        BigInt(coin.value),
        tree,
        tree.findLeaf(hex.encode(leafBody)),
        unroll,
        signers,
        `${label} checkpoint`,
        verify,
    );
    arkInput(
        arkTx,
        1,
        checkpoint,
        BigInt(coin.value),
        checkpointTree,
        leafBody,
        signers,
        `${label} Arkade input`,
        verify,
    );
    return coin;
};

async function classifySpend(
    advance: Advance,
    coin: VirtualCoin,
    deps: Pick<SpendWatcherDeps, "indexer" | "config">,
    tip: Pick<Awaited<ReturnType<SpendWatcherDeps["tip"]>>, "height" | "time">,
    verify: SignatureCheck,
): Promise<ObservedSpend> {
    const candidate = /^[0-9a-f]{64}$/.test(coin.arkTxId ?? "") ? coin.arkTxId! : "unknown";
    try {
        if (!advance.outpoint || !sameOutpoint(coin, advance.outpoint))
            fail("spent coin is not the persisted covenant outpoint");
        const outpoint = advance.outpoint!;
        const facts = covenantFacts(advance, deps.config);
        if (
            coin.value !== Number(facts.value) ||
            coin.script !== hex.encode(facts.script.pkScript) ||
            !coin.isSpent ||
            !/^[0-9a-f]{64}$/.test(coin.spentBy ?? "") ||
            !/^[0-9a-f]{64}$/.test(coin.arkTxId ?? "") ||
            coin.spentBy === coin.arkTxId
        )
            fail("spent outpoint evidence is incomplete or inconsistent");
        const spentBy = coin.spentBy!;
        const arkTxId = coin.arkTxId!;
        const covenantHoldings = holdings(coin, "covenant outpoint");
        if (holdingsDiffer(covenantHoldings, facts.expectedHoldings))
            fail("spent covenant asset facts differ from the persisted lockup");
        const first = await rawTransactions(deps.indexer, [arkTxId, spentBy]);
        const arkTx = first.get(arkTxId)!;
        const checkpoint = first.get(spentBy)!;
        const leafIndex = [Leaf.Recycle, Leaf.Purchase, Leaf.RefundSender, Leaf.Recovery].find(
            (leaf) => {
                const selected = checkpoint.getInput(0).tapLeafScript;
                if (!selected || selected.length !== 1) return false;
                return sameBytes(scriptFromTapLeafScript(selected[0]!), facts.script.scripts[leaf]);
            },
        );
        if (leafIndex === undefined) fail("checkpoint selects no recognized covenant leaf");
        const leaf = leafIndex as Leaf;
        const v2Reclaim = advance.covenantVersion === 2 && leaf === Leaf.Recovery;
        const recoveryLocktime = advance.recoveryLocktime;
        if (
            leaf === Leaf.Recovery &&
            (!recoveryLocktime ||
                // v1 only: a v2 advance keeps no batch expiry at all, and D2
                // makes its deadline wall-clock where an expiry may be a height.
                (advance.covenantVersion !== 2 &&
                    recoveryLocktime.kind !== (advance.batchExpiry?.kind ?? "time")) ||
                recoveryLocktime.value !== advance.locktime)
        )
            fail("recovery locktime tag is missing or inconsistent");
        const expectedLockTime = leaf === Leaf.Recovery ? Number(recoveryLocktime!.value) : 0;
        exactTransactionHeader(checkpoint, expectedLockTime, "covenant checkpoint", v2Reclaim);
        exactTransactionHeader(arkTx, expectedLockTime, "covenant Arkade transaction", v2Reclaim);
        const expectedLeaf = covenantSpendInput(
            facts.script,
            leaf,
            outpoint,
            facts.value,
        ).tapLeafScript;
        const covenantProgram =
            leaf === Leaf.Recycle
                ? facts.script.covenant.recycle
                : leaf === Leaf.Purchase
                  ? facts.script.covenant.purchase
                  : leaf === Leaf.Recovery
                    ? (facts.script.covenant.reclaim ?? facts.script.covenant.refund)
                    : facts.script.covenant.refund;
        const covenantSigners = [
            deps.config.serverPubkey,
            ...(leaf === Leaf.RefundSender ? [advance.senderKey] : []),
            arkade.computeArkadeScriptPublicKey(deps.config.emulatorPubkey, covenantProgram),
        ];
        const checkpointTree = directCheckpoint(
            checkpoint,
            outpoint,
            facts.value,
            facts.script,
            expectedLeaf,
            facts.unroll,
            covenantSigners,
            "covenant checkpoint",
            verify,
        );
        arkInput(
            arkTx,
            0,
            checkpoint,
            facts.value,
            checkpointTree,
            facts.script.scripts[leaf],
            covenantSigners,
            "covenant Arkade input",
            verify,
        );

        if (leaf === Leaf.Purchase) {
            if (arkTx.inputsLength !== 1 || arkTx.outputsLength !== 3)
                fail("purchase input or output count mismatch");
            exactOutput(
                arkTx,
                0,
                facts.value,
                new Uint8Array([0x51, 0x20, ...advance.receiverKey]),
                "purchase receiver output",
            );
            if (facts.value < deps.config.vtxoMinAmount)
                fail("purchase receiver output is below the provider minimum");
            exactExtension(arkTx, 1, covenantProgram, [covenantHoldings], 0);
            exactAnchor(arkTx, 2);
            return { kind: "purchased", txid: arkTx.id };
        }

        if (leaf === Leaf.Recycle) {
            if (arkTx.inputsLength !== 2 || arkTx.outputsLength !== 4)
                fail("recycle input or output count mismatch");
            const exactReceiverCoin = await secondInput(
                arkTx,
                facts.unroll,
                deps,
                verify,
                "receiver",
                new Uint8Array([0x51, 0x20, ...advance.receiverKey]),
            );
            const { operatorSats, assetFare } = recycleFare(covenantParamsOf(advance));
            const merged = facts.value + BigInt(exactReceiverCoin.value) - operatorSats;
            if (merged < advance.dust || merged < deps.config.vtxoMinAmount)
                fail("recycle receiver output is below dust or provider minimum");
            exactOutput(
                arkTx,
                0,
                operatorSats,
                payoutPkScript(advance.operatorKey, operatorSats, advance.dust),
                "recycle repayment",
            );
            exactOutput(
                arkTx,
                1,
                merged,
                new Uint8Array([0x51, 0x20, ...advance.receiverKey]),
                "recycle receiver output",
            );
            const receiverHoldings = holdings(exactReceiverCoin, "receiver funding outpoint");
            exactExtension(
                arkTx,
                2,
                covenantProgram,
                [covenantHoldings, receiverHoldings],
                1,
                assetFare > 0n ? { id: assetId(advance)!, vout: 0, units: assetFare } : undefined,
            );
            exactAnchor(arkTx, 3);
            return { kind: "recycled", txid: arkTx.id };
        }

        const params = covenantParamsOf(advance);
        if (params.covenantVersion === 2 && leaf === Leaf.Recovery) {
            // A reclaim is permissionless and the leaf pins only out[0] against
            // in[0], so a stranger's own input and change must still classify. Read
            // as a disagreement it would pause the Taxi, and clearing never unpauses.
            exactOutput(
                arkTx,
                0,
                facts.value,
                payoutPkScript(advance.operatorKey, facts.value, advance.dust),
                "reclaim repayment",
            );
            exactExtension(arkTx, extensionIndex(arkTx), covenantProgram, [covenantHoldings], 0);
            exactAnchor(arkTx, anchorIndex(arkTx));
        } else if (params.covenantVersion === 2) {
            // The leaf pins INSPECTNUMINPUTS 2 and no output count, so neither do we.
            if (arkTx.inputsLength !== 2) fail("refund input count mismatch");
            const refunderCoin = await secondInput(arkTx, facts.unroll, deps, verify, "refunder");
            const loan = loanSats(params);
            exactOutput(
                arkTx,
                0,
                loan,
                payoutPkScript(advance.operatorKey, loan, advance.dust),
                "refund repayment",
            );
            // The leaf pins out[1] to in[1]'s own script; senderKey only signs it.
            exactOutput(
                arkTx,
                1,
                facts.value + BigInt(refunderCoin.value) - loan,
                hex.decode(refunderCoin.script),
                "refund recovery output",
            );
            exactExtension(
                arkTx,
                extensionIndex(arkTx),
                covenantProgram,
                [covenantHoldings, holdings(refunderCoin, "refunder funding outpoint")],
                1,
            );
            exactAnchor(arkTx, anchorIndex(arkTx));
        } else {
            // buildRefund pins no input count on either v1 leaf, so a spender who
            // brings their own coin is script-valid; out[0] and out[1] stay pinned.
            const topup = refundTopup(params, deps.config.vtxoMinAmount);
            exactOutput(
                arkTx,
                0,
                topup,
                payoutPkScript(advance.operatorKey, topup, advance.dust),
                "refund repayment",
            );
            exactOutput(
                arkTx,
                1,
                facts.value - topup,
                payoutPkScript(
                    advance.recoveryRecipient === "receiver"
                        ? advance.receiverKey
                        : advance.senderKey,
                    facts.value - topup,
                    advance.dust,
                ),
                "refund recovery output",
            );
            exactExtension(arkTx, extensionIndex(arkTx), covenantProgram, [covenantHoldings], 1);
            exactAnchor(arkTx, anchorIndex(arkTx));
        }
        if (leaf === Leaf.Recovery) {
            const ceiling = Number(recoveryLocktime!.value);
            if (
                arkTx.lockTime !== checkpoint.lockTime ||
                (v2Reclaim ? arkTx.lockTime > ceiling : arkTx.lockTime !== ceiling)
            )
                fail("recovery does not carry the exact persisted CLTV");
            // An early reclaim matures against its own CLTV, not the ceiling.
            const matured = v2Reclaim ? BigInt(arkTx.lockTime) : recoveryLocktime!.value;
            const chainClock = recoveryLocktime!.kind === "height" ? tip.height : tip.time;
            if (!Number.isSafeInteger(chainClock) || BigInt(chainClock) < matured)
                fail(
                    recoveryLocktime!.kind === "height"
                        ? "recovery height CLTV is not mature at the canonical tip"
                        : "recovery time CLTV is not mature at canonical median time",
                );
            return { kind: "recovered", txid: arkTx.id };
        }
        if (arkTx.lockTime !== 0 || checkpoint.lockTime !== 0)
            fail("sender refund unexpectedly carries a locktime");
        return { kind: "refunded", txid: arkTx.id };
    } catch (error) {
        return {
            kind: "unknown",
            txid: candidate,
            reason:
                error instanceof EvidenceError
                    ? error.message
                    : "provider transaction evidence could not be validated",
        };
    }
}

export async function classifyObservedSpend(
    advance: Advance,
    coin: VirtualCoin,
    deps: Pick<SpendWatcherDeps, "indexer" | "config">,
    tip: Pick<Awaited<ReturnType<SpendWatcherDeps["tip"]>>, "height" | "time">,
): Promise<ObservedSpend> {
    return classifySpend(advance, coin, deps, tip, verifySignatures);
}

const activeStates = ["locking", "locked", "recovering"] as const;
const terminalStates = ["recycled", "purchased", "refunded", "recovered"] as const;

const chunk = <T>(items: readonly T[], size: number): T[][] =>
    Array.from({ length: Math.ceil(items.length / size) }, (_, index) =>
        items.slice(index * size, index * size + size),
    );

const outpointKey = ({ txid, vout }: { txid: string; vout: number }): string => `${txid}:${vout}`;

/**
 * One scan's reads in four waves, each key set derived locally from the wave
 * before, so the count holds however many rows are watched. Best-effort
 * throughout: a key the batch misses falls through to the same narrow read the
 * row takes today, so one pruned transaction cannot condemn the others, and no
 * row's evidence rule is ever answered out of another row's response.
 */
const prefetch = async (
    provider: SpendWatcherDeps["indexer"],
    outpoints: readonly { txid: string; vout: number }[],
    coinOnly: readonly { txid: string; vout: number }[] = [],
): Promise<{
    indexer: SpendWatcherDeps["indexer"];
    cached(outpoint: { txid: string; vout: number }): boolean;
}> => {
    const coins = new Map<string, VirtualCoin[]>();
    const resolved = new Set<string>();
    const byScript = new Map<string, VirtualCoin[]>();
    const resolvedScripts = new Set<string>();
    const txs = new Map<string, string>();

    const loadScripts = async (wanted: readonly string[]) => {
        for (const group of chunk([...new Set(wanted)], CHUNK_KEYS)) {
            const keys = new Set(group);
            const found = new Map<string, VirtualCoin[]>();
            let usable = true;
            try {
                const response = await provider.getVtxos({ scripts: group });
                if (!response || !Array.isArray(response.vtxos)) usable = false;
                else
                    for (const coin of response.vtxos) {
                        if (!keys.has(coin.script)) usable = false;
                        else found.set(coin.script, [...(found.get(coin.script) ?? []), coin]);
                    }
            } catch {
                usable = false;
            }
            if (!usable) continue;
            for (const [key, hits] of found) byScript.set(key, hits);
            for (const key of keys) resolvedScripts.add(key);
        }
    };

    const loadCoins = async (wanted: readonly { txid: string; vout: number }[]) => {
        const unique = [...new Map(wanted.map((o) => [outpointKey(o), o])).values()];
        for (const group of chunk(unique, CHUNK_KEYS)) {
            const keys = new Set(group.map(outpointKey));
            const found = new Map<string, VirtualCoin[]>();
            let usable = true;
            try {
                const response = await provider.getVtxos({ outpoints: group });
                if (!response || !Array.isArray(response.vtxos)) usable = false;
                else
                    for (const coin of response.vtxos) {
                        const key = outpointKey(coin);
                        // An answer carrying outpoints nobody asked for is not
                        // answering this question; its chunk takes the per-row path.
                        if (!keys.has(key)) usable = false;
                        else found.set(key, [...(found.get(key) ?? []), coin]);
                    }
            } catch {
                usable = false;
            }
            if (!usable) continue;
            // Every coin the chunk returned for a key is kept, so exactCoin still
            // rejects an ambiguous outpoint on its own evidence.
            for (const [key, hits] of found) coins.set(key, hits);
            for (const key of keys) resolved.add(key);
        }
    };

    const loadTxs = async (ids: readonly string[]) => {
        const unique = [...new Set(ids)].filter((id) => /^[0-9a-f]{64}$/.test(id));
        for (const group of chunk(unique, CHUNK_KEYS)) {
            const keys = new Set(group);
            const found = new Map<string, string>();
            let usable = true;
            try {
                const response = await provider.getVirtualTxs(group);
                if (!response || !Array.isArray(response.txs)) usable = false;
                else
                    for (const encoded of response.txs) {
                        let id: string;
                        try {
                            id = Transaction.fromPSBT(base64.decode(encoded)).id;
                        } catch {
                            continue;
                        }
                        // Unrequested or repeated: rawTransactions rejects both per
                        // row, so the chunk must not answer around that rule.
                        if (!keys.has(id) || found.has(id)) usable = false;
                        else found.set(id, encoded);
                    }
            } catch {
                usable = false;
            }
            if (usable) for (const [id, encoded] of found) txs.set(id, encoded);
        }
    };

    const parse = (id: string | undefined): Transaction | undefined => {
        const encoded = id === undefined ? undefined : txs.get(id);
        if (encoded === undefined) return undefined;
        try {
            return Transaction.fromPSBT(base64.decode(encoded));
        } catch {
            return undefined;
        }
    };

    await loadCoins([...outpoints, ...coinOnly]);
    // One scan-wide wave off wave A's own coins; nothing renewed reads nothing.
    await loadScripts(
        outpoints.flatMap((outpoint) => {
            const hits = coins.get(outpointKey(outpoint)) ?? [];
            return hits.length === 1 && renewalCommitment(hits[0]!) ? [hits[0]!.script] : [];
        }),
    );
    // Only the classified rows pull the transaction waves; a coin-only row rides
    // wave A and stops there.
    const spent = outpoints.flatMap((outpoint) => {
        const hits = coins.get(outpointKey(outpoint)) ?? [];
        return hits.length === 1 && hits[0]!.isSpent ? [hits[0]!] : [];
    });
    await loadTxs(spent.flatMap(({ arkTxId, spentBy }) => [arkTxId ?? "", spentBy ?? ""]));
    const checkpoints = spent.flatMap(({ arkTxId }) => {
        try {
            const arkTx = parse(arkTxId);
            return arkTx?.inputsLength === 2 ? [txid(arkTx.getInput(1))] : [];
        } catch {
            return [];
        }
    });
    await loadTxs(checkpoints);
    await loadCoins(
        checkpoints.flatMap((id) => {
            try {
                const input = parse(id)?.getInput(0);
                return input?.index === undefined ? [] : [{ txid: txid(input), vout: input.index }];
            } catch {
                return [];
            }
        }),
    );

    return {
        cached: (outpoint) => resolved.has(outpointKey(outpoint)),
        indexer: {
            getVtxos: (options) => {
                const narrow = options && Object.keys(options).length === 1;
                const scripts = narrow ? options.scripts : undefined;
                if (scripts?.every((script) => resolvedScripts.has(script)))
                    return Promise.resolve({
                        vtxos: scripts.flatMap((script) => byScript.get(script) ?? []),
                    });
                const keys = (narrow ? options.outpoints : undefined)?.map(outpointKey);
                return keys?.every((key) => resolved.has(key))
                    ? Promise.resolve({ vtxos: keys.flatMap((key) => coins.get(key) ?? []) })
                    : provider.getVtxos(options);
            },
            getVirtualTxs: (ids, options) =>
                !options && ids.every((id) => txs.has(id))
                    ? Promise.resolve({ txs: ids.map((id) => txs.get(id)!) })
                    : provider.getVirtualTxs(ids, options),
        },
    };
};

type WatchedState = (typeof activeStates | typeof terminalStates)[number];

export function createSpendWatcher(deps: SpendWatcherDeps): SpendWatcher {
    let lastScanAt: number | null = null;
    let watching = 0;
    let activelyScanned = 0;
    let scanBlockers: WatcherBlocker[] = [];
    let persistedBlockers: WatcherBlocker[] = [];
    let persistedWarnings: WatcherBlocker[] = [];
    let reviewWarnings: WatcherBlocker[] = [];
    let lastReviewAt: number | null = null;
    let reviewRequested = false;
    let terminalScripts = new Map<string, string>();
    const reclassify = new Set<string>();
    let subscriptionBlockers: WatcherBlocker[] = [];
    let pending: Promise<void> | undefined;
    let started = false;
    let starting: Promise<void> | undefined;
    let stopping: Promise<void> | undefined;
    let syncing: Promise<void> | undefined;
    let resync = false;
    let generation = 0;
    let binding:
        | {
              wallet: Pick<Wallet, "getContractManager">;
              manager: IContractManager;
              scripts: Set<string>;
              owned: Set<string>;
              unsubscribe: () => void;
          }
        | undefined;
    const label = "taxi-covenant";
    const recoverable = new Set<string>();
    const signatureChecks = new Set<string>();
    const verify: SignatureCheck = (tx, index, signers) => {
        const key = [
            createHash("sha256").update(tx.toPSBT()).digest("hex"),
            index,
            ...[...signers].sort(),
        ].join(":");
        if (signatureChecks.has(key)) return;
        verifySignatures(tx, index, signers);
        if (signatureChecks.size >= SIGNATURE_CACHE_LIMIT)
            signatureChecks.delete(signatureChecks.values().next().value!);
        signatureChecks.add(key);
    };

    const covenantRows = (states: readonly WatchedState[]) =>
        states
            .flatMap((state) => deps.advances.byState(state))
            // Sponsored direct sends are covenant-spend evidence this watcher
            // cannot classify; the reconciler settles them on exact-outpoint
            // observation instead.
            .filter((advance) => advanceKind(advance) === "covenant");
    const persisted = (current: Advance[], codes: string[]): WatcherBlocker[] =>
        current
            .filter((advance) => codes.includes(advance.failureCode ?? ""))
            .map((advance) => ({
                advanceId: advance.id,
                code: advance.failureCode!,
                detail: advance.failureDetail ?? "canonical spend evidence requires attention",
            }));
    // status() answers from here, so the readiness snapshot a quote reads nine
    // times does not re-hydrate every advance that ever settled.
    const cache = (active: Advance[], terminal: Advance[]) => {
        watching = active.length + terminal.length;
        activelyScanned = active.length;
        const all = [...active, ...terminal];
        persistedBlockers = persisted(all, [
            "covenant_spend_unknown",
            "covenant_observation_disagreement",
        ]);
        persistedWarnings = persisted(all, ["covenant_unrolled"]);
    };

    const scan = async (): Promise<void> => {
        const startedAt = performance.now();
        const counts = { getVtxos: 0, getVirtualTxs: 0, outpoints: 0, txids: 0 };
        const counted: SpendWatcherDeps["indexer"] = {
            getVtxos: (options) => {
                counts.getVtxos++;
                counts.outpoints += options?.outpoints?.length ?? 0;
                return deps.indexer.getVtxos(options);
            },
            getVirtualTxs: (ids, options) => {
                counts.getVirtualTxs++;
                counts.txids += ids.length;
                return deps.indexer.getVirtualTxs(ids, options);
            },
        };
        const report = () =>
            deps.onScanMetrics?.({
                watching,
                activelyScanned,
                elapsedMs: performance.now() - startedAt,
                ...counts,
            });
        recoverable.clear();
        const at = deps.now();
        const current = covenantRows(activeStates);
        const settled = covenantRows(terminalStates);
        // A confirmed transaction's bytes cannot change, so a terminal verdict is
        // re-examined from its coin and only when a window could have been missed.
        const reviewing =
            lastReviewAt === null ||
            reviewRequested ||
            at - lastReviewAt >= Number(deps.config.terminalReviewSeconds);
        cache(current, settled);
        scanBlockers = [];
        let advanced = false;
        let tip: Awaited<ReturnType<SpendWatcherDeps["tip"]>>;
        try {
            tip = await deps.tip();
            if (
                !/^[0-9a-f]{64}$/.test(tip.hash) ||
                !Number.isSafeInteger(tip.height) ||
                tip.height < 0 ||
                !Number.isSafeInteger(tip.time) ||
                tip.time < 0
            )
                throw new Error();
        } catch {
            if (!deps.policy.get().paused) deps.policy.update({ paused: true }, "spend-watcher");
            scanBlockers = [
                {
                    code: "canonical_tip_unavailable",
                    detail: "canonical chain tip hash, height, and time are unavailable",
                },
            ];
            report();
            return;
        }
        // Derived here and discarded: a row whose lockup will not decode is left
        // out of the batch rather than poisoning it, and still records its own
        // failure below, in loop order.
        const batched = await prefetch(
            counted,
            current.flatMap((advance) => {
                if (advance.outpoint) return [advance.outpoint];
                if (advance.state !== "locking") return [];
                try {
                    return [lockingOutpoint(advance)];
                } catch {
                    return [];
                }
            }),
            reviewing
                ? settled.flatMap((advance) => (advance.outpoint ? [advance.outpoint] : []))
                : [],
        );
        for (const advance of current) {
            let observedAdvance = advance;
            if (!observedAdvance.outpoint && observedAdvance.state === "locking") {
                try {
                    observedAdvance = {
                        ...observedAdvance,
                        outpoint: lockingOutpoint(observedAdvance),
                    };
                } catch (error) {
                    deps.advances.recordSpendUnknown(
                        observedAdvance.id,
                        undefined,
                        error instanceof EvidenceError
                            ? error.message
                            : "persisted lockup evidence could not be validated",
                        deps.now(),
                        tip,
                    );
                    continue;
                }
            }
            if (!observedAdvance.outpoint) {
                deps.advances.recordSpendUnknown(
                    advance.id,
                    undefined,
                    "persisted covenant outpoint is missing",
                    deps.now(),
                    tip,
                );
                continue;
            }
            let coin: VirtualCoin | undefined;
            try {
                coin = await exactCoin(batched.indexer, observedAdvance.outpoint);
            } catch (error) {
                deps.advances.recordSpendUnknown(
                    advance.id,
                    undefined,
                    error instanceof EvidenceError
                        ? error.message
                        : "canonical outpoint evidence is unavailable",
                    deps.now(),
                    tip,
                );
                continue;
            }
            // Ahead of the spend paths: a renewed coin may arrive with `isSpent`
            // unset, which would otherwise read as healthy at a dead outpoint.
            if (coin && observedAdvance.covenantVersion === 2 && renewalCommitment(coin)) {
                try {
                    const facts = covenantFacts(observedAdvance, deps.config);
                    if (!sameCovenant(coin, facts))
                        fail("renewed covenant evidence differs from persisted facts");
                    const successor = await exactSuccessor(batched.indexer, coin, facts);
                    if (!deps.advances.recordCovenantRenewed(advance.id, successor, deps.now()))
                        fail("renewal successor could not be adopted");
                    recoverable.add(advance.id);
                } catch (error) {
                    deps.advances.recordSpendUnknown(
                        advance.id,
                        undefined,
                        error instanceof EvidenceError
                            ? error.message
                            : "covenant renewal evidence could not be validated",
                        deps.now(),
                        tip,
                    );
                }
                continue;
            }
            if (!coin || !coin.isSpent) {
                if (coin) {
                    if (coin.isUnrolled) {
                        deps.advances.recordCovenantUnrolled(advance.id, UNROLLED, deps.now(), tip);
                        continue;
                    }
                    try {
                        const facts = covenantFacts(observedAdvance, deps.config);
                        const assets = holdings(coin, "covenant outpoint");
                        if (
                            coin.isSpent !== false ||
                            coin.spentBy ||
                            coin.isSwept !== false ||
                            coin.isUnrolled !== false ||
                            coin.value !== Number(facts.value) ||
                            coin.script !== hex.encode(facts.script.pkScript) ||
                            holdingsDiffer(assets, facts.expectedHoldings)
                        )
                            fail("unspent covenant evidence differs from persisted facts");
                        deps.advances.clearSpendUnknown(advance.id, advance.state, deps.now());
                        recoverable.add(advance.id);
                    } catch {
                        deps.advances.recordSpendUnknown(
                            advance.id,
                            undefined,
                            "unspent covenant evidence could not be validated",
                            deps.now(),
                            tip,
                        );
                    }
                } else if (advance.state !== "locking") {
                    deps.advances.recordSpendUnknown(
                        advance.id,
                        undefined,
                        "canonical covenant outpoint is unavailable",
                        deps.now(),
                        tip,
                    );
                }
                continue;
            }
            const observed = await classifySpend(
                observedAdvance,
                coin,
                { ...deps, indexer: batched.indexer },
                tip,
                verify,
            );
            if (observed.kind === "unknown") {
                // Spent on-chain, as arkd's IsOnchainSpent reads it: the covenant's own exit.
                if (coin.isUnrolled && !coin.arkTxId && !coin.settledBy)
                    deps.advances.recordCovenantUnrolled(advance.id, UNROLLED, deps.now(), tip);
                else
                    deps.advances.recordSpendUnknown(
                        advance.id,
                        observed.txid === "unknown" ? undefined : observed.txid,
                        observed.reason,
                        deps.now(),
                        tip,
                    );
                continue;
            }
            deps.advances.recordSpendObservation(
                advance.id,
                advance.state as "locking" | "locked" | "recovering",
                observed.kind,
                observed.txid,
                deps.now(),
                tip,
            );
            advanced = true;
        }
        if (reviewing) await review(settled, batched, tip, at);
        // Re-read what this scan wrote to, and nothing else: the terminal rows
        // are the group that grows forever.
        cache(
            covenantRows(activeStates),
            reviewing || advanced ? covenantRows(terminalStates) : settled,
        );
        report();
        lastScanAt = deps.now();
    };

    /**
     * Terminal rows, from the coin alone. Evidence that is merely unavailable is
     * a warning and retried; a coin that contradicts the recorded verdict earns
     * the full classification, for that one row.
     */
    const review = async (
        rows: Advance[],
        batched: Awaited<ReturnType<typeof prefetch>>,
        tip: Awaited<ReturnType<SpendWatcherDeps["tip"]>>,
        at: number,
    ): Promise<void> => {
        const warnings: WatcherBlocker[] = [];
        const scripts = new Map<string, string>();
        const unavailable = (advance: Advance, detail: string) =>
            void warnings.push({
                advanceId: advance.id,
                code: "covenant_terminal_evidence_unavailable",
                detail,
            });
        for (const advance of rows) {
            const terminalState = advance.state as (typeof terminalStates)[number];
            if (!advance.outpoint) {
                deps.advances.recordSpendDisagreement(
                    advance.id,
                    "persisted terminal covenant outpoint is missing",
                    deps.now(),
                    tip,
                );
                continue;
            }
            if (
                advance.observationTipHeight === undefined ||
                advance.observationTipHash === undefined
            ) {
                deps.advances.recordSpendDisagreement(
                    advance.id,
                    "persisted terminal observation tip identity is missing",
                    deps.now(),
                    tip,
                );
            } else if (tip.height < advance.observationTipHeight) {
                deps.advances.recordSpendDisagreement(
                    advance.id,
                    `canonical tip height ${tip.height} is below persisted observation height ${advance.observationTipHeight}`,
                    deps.now(),
                    tip,
                );
            } else if (
                advance.observationTipHeight === tip.height &&
                advance.observationTipHash !== tip.hash &&
                !(
                    advance.failureCode === "covenant_observation_disagreement" &&
                    advance.observationStableTipHash === tip.hash &&
                    advance.observationStableTipHeight === tip.height
                )
            ) {
                deps.advances.recordSpendDisagreement(
                    advance.id,
                    `same-height canonical tip changed from ${advance.observationTipHash} to ${tip.hash}`,
                    deps.now(),
                    tip,
                );
            }
            // No `continue` after a tip disagreement: an agreeing coin below records the
            // first stable observation, which is what starts the two-observation clear.
            let facts: ReturnType<typeof covenantFacts> | undefined;
            try {
                facts = covenantFacts(advance, deps.config);
                scripts.set(hex.encode(facts.script.pkScript), advance.id);
            } catch {
                facts = undefined;
            }
            if (!batched.cached(advance.outpoint)) {
                unavailable(advance, "canonical outpoint evidence is unavailable");
                continue;
            }
            let coin: VirtualCoin | undefined;
            try {
                coin = await exactCoin(batched.indexer, advance.outpoint);
            } catch (error) {
                unavailable(
                    advance,
                    error instanceof EvidenceError
                        ? error.message
                        : "canonical outpoint evidence is unavailable",
                );
                continue;
            }
            if (!coin) {
                unavailable(advance, "persisted terminal outpoint is absent from the indexer");
                continue;
            }
            const named = reclassify.delete(advance.id);
            if (!named && facts && agrees(advance, coin, facts)) {
                deps.advances.recordStableSpendObservation(
                    advance.id,
                    terminalState,
                    advance.spentTxid!,
                    deps.now(),
                    tip,
                );
                continue;
            }
            const observed = await classifySpend(
                advance,
                coin,
                { ...deps, indexer: batched.indexer },
                tip,
                verify,
            );
            if (observed.kind === "unknown")
                deps.advances.recordSpendDisagreement(
                    advance.id,
                    `persisted terminal spend no longer validates: ${observed.reason}`,
                    deps.now(),
                    tip,
                );
            else if (advance.state !== observed.kind || advance.spentTxid !== observed.txid)
                deps.advances.recordSpendDisagreement(
                    advance.id,
                    `canonical ${observed.kind}/${observed.txid} conflicts with persisted ${advance.state}/${advance.spentTxid ?? "none"}`,
                    deps.now(),
                    tip,
                );
            else
                deps.advances.recordStableSpendObservation(
                    advance.id,
                    observed.kind,
                    observed.txid,
                    deps.now(),
                    tip,
                );
        }
        reviewWarnings = warnings;
        terminalScripts = scripts;
        reviewRequested = false;
        lastReviewAt = at;
    };

    const removeOwned = async (current: NonNullable<typeof binding>, scripts: string[]) => {
        if (!scripts.length) return;
        const registered = await current.manager.getWatchedScripts!();
        const removable = registered
            .filter((entry) => scripts.includes(entry.script) && entry.label === label)
            .map((entry) => entry.script);
        if (removable.length) await current.manager.unwatchScript!(removable);
        for (const script of scripts) current.owned.delete(script);
    };
    const detach = async () => {
        const previous = binding;
        binding = undefined;
        if (!previous) return;
        previous.unsubscribe();
        await removeOwned(previous, [...previous.owned]);
    };
    const syncSubscriptions = async () => {
        if (!started || !deps.wallet) return;
        const epoch = generation;
        try {
            const wallet = deps.wallet();
            if (wallet !== binding?.wallet) await detach();
            if (!wallet || !started || epoch !== generation) return;
            if (!binding) {
                const manager = await wallet.getContractManager();
                if (!started || epoch !== generation || deps.wallet() !== wallet) return;
                if (!manager.watchScript || !manager.unwatchScript || !manager.getWatchedScripts)
                    throw new Error("contract manager cannot watch scripts");
                const current = {
                    wallet,
                    manager,
                    scripts: new Set<string>(),
                    owned: new Set<string>(),
                    unsubscribe: () => {},
                };
                binding = current;
                current.unsubscribe = manager.onContractEvent((event) => {
                    if (!started || binding !== current) return;
                    if (event.type === "connection_reset") reviewRequested = true;
                    else {
                        // A terminal row leaves the watch set, so its script is
                        // matched against the last review's own map.
                        const named = terminalScripts.get(event.contractScript);
                        if (named !== undefined) {
                            reclassify.add(named);
                            reviewRequested = true;
                        } else if (!current.scripts.has(event.contractScript)) return;
                    }
                    void Promise.resolve()
                        .then(prompt)
                        .catch(() => {
                            if (!started || binding !== current) return;
                            subscriptionBlockers = [
                                {
                                    code: "transaction_stream_disconnected",
                                    detail: "contract event reconciliation failed; operational polling remains authoritative",
                                },
                            ];
                        });
                });
            }
            const scripts = new Set(
                activeStates
                    .flatMap((state) => deps.advances.byState(state))
                    .filter((advance) => advanceKind(advance) === "covenant")
                    .flatMap((advance) => {
                        try {
                            return [
                                hex.encode(
                                    covenantFacts(
                                        {
                                            ...advance,
                                            outpoint: advance.outpoint ?? lockingOutpoint(advance),
                                        },
                                        deps.config,
                                    ).script.pkScript,
                                ),
                            ];
                        } catch {
                            return [];
                        }
                    }),
            );
            const current = binding;
            const registered = await current.manager.getWatchedScripts!();
            if (!started || epoch !== generation || binding !== current || deps.wallet() !== wallet)
                return;
            const additions = [...scripts].filter(
                (script) => !registered.some((entry) => entry.script === script),
            );
            current.scripts = scripts;
            for (const script of additions) current.owned.add(script);
            if (additions.length) await current.manager.watchScript!(additions, { label });
            if (!started || epoch !== generation || binding !== current || deps.wallet() !== wallet)
                return;
            await removeOwned(
                current,
                [...current.owned].filter((script) => !scripts.has(script)),
            );
            if (started && epoch === generation) subscriptionBlockers = [];
        } catch {
            if (!started || epoch !== generation) return;
            subscriptionBlockers = [
                {
                    code: "transaction_stream_disconnected",
                    detail: "covenant subscription unavailable; operational polling remains authoritative",
                },
            ];
        }
    };
    const requestSync = () => {
        if (!started) return;
        if (syncing) {
            resync = true;
            return;
        }
        resync = false;
        syncing = syncSubscriptions().finally(() => {
            syncing = undefined;
            if (resync) requestSync();
        });
    };
    const catchUp = () => {
        if (!pending)
            pending = scan().finally(() => {
                pending = undefined;
                requestSync();
            });
        return pending;
    };
    const prompt = deps.onPrompt ?? catchUp;

    return {
        catchUp,
        isRecoverable: (id) => recoverable.has(id),
        async start() {
            if (stopping) await stopping;
            // Without a wallet, repeated starts preserve the polling-only prompt.
            if (starting || (started && deps.wallet)) return starting;
            started = true;
            generation++;
            starting = prompt().finally(() => {
                starting = undefined;
                requestSync();
            });
            return starting;
        },
        stop() {
            if (stopping) return stopping;
            started = false;
            generation++;
            stopping = (async () => {
                const results = await Promise.allSettled([
                    starting,
                    pending,
                    binding ? syncing : undefined,
                ]);
                const [cleanup] = await Promise.allSettled([detach()]);
                signatureChecks.clear();
                // The next start is a catch-up: it owes the terminal rows a read.
                lastReviewAt = null;
                const failure = [...results, cleanup].find(
                    (result) => result.status === "rejected",
                );
                if (failure?.status === "rejected") throw failure.reason;
            })().finally(() => {
                stopping = undefined;
            });
            return stopping;
        },
        status: () => ({
            lastScanAt,
            watching,
            activelyScanned,
            blockers: [...scanBlockers, ...subscriptionBlockers, ...persistedBlockers],
            // Unrolled: its funds can only leave on-chain through the exit leaf,
            // and it costs one advance. Missing terminal evidence: retried.
            warnings: [...persistedWarnings, ...reviewWarnings],
        }),
    };
}
