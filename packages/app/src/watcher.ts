import {
    DustCovenantScript,
    Leaf,
    covenantSpendInput,
    payoutPkScript,
    refundTopup,
} from "@arkade-taxi/covenant";
import type { Advance } from "@arkade-taxi/core";
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
    scriptFromTapLeafScript,
    verifyTapscriptSignatures,
    type ArkProvider,
    type IndexerProvider,
    type TapLeafScript,
    type VirtualCoin,
} from "@arkade-os/sdk";
import { base64, hex } from "@scure/base";
import type { RuntimeConfig } from "./config.js";
import { decodeLockupEnvelope } from "./arkade/psbt.js";

const { AssetGroup, AssetId, AssetInput, AssetOutput, Packet } = asset;
const DEFAULT_SIGHASH = 0;

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
    blockers: WatcherBlocker[];
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
        | "clearSpendUnknown"
        | "recordSpendDisagreement"
        | "recordStableSpendObservation"
    >;
    policy: Pick<PolicyRepository, "get" | "update">;
    indexer: Pick<IndexerProvider, "getVtxos" | "getVirtualTxs">;
    config: RuntimeConfig;
    now(): number;
    tip(): Promise<{ hash: string; height: number; time: number }>;
    arkProvider?: Pick<ArkProvider, "getTransactionsStream">;
    onPrompt?: () => Promise<void>;
    sleep?: (milliseconds: number, signal: AbortSignal) => Promise<void>;
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

const exactTree = (tx: Transaction, index: number, expected: Uint8Array, label: string): void => {
    const fields = getArkPsbtFields(tx, index, VtxoTaprootTree);
    if (fields.length !== 1 || !sameBytes(fields[0], expected))
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
        verifyTapscriptSignatures(tx, index, [...expected], [], [DEFAULT_SIGHASH]);
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

const assetId = (advance: Advance): string | undefined =>
    advance.assetId
        ? AssetId.create(
              hex.encode(Uint8Array.from(advance.assetId.txid).reverse()),
              advance.assetId.groupIndex,
          ).toString()
        : undefined;

const expectedAssetPacket = (sources: Holding[][], destination: number): asset.Packet | null => {
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
                    [AssetOutput.create(destination, amount)],
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
): void => {
    const output = tx.getOutput(index);
    const script = output.script ?? fail("covenant extension output is missing or misplaced");
    if (output.amount !== 0n || !Extension.isExtension(script))
        fail("covenant extension output is missing or misplaced");
    const assets = expectedAssetPacket(sources, destination);
    const expected = Extension.create([
        ...(assets ? [assets] : []),
        EmulatorPacket.create([{ vin: 0, script: covenantScript }]),
    ]).serialize();
    if (!sameBytes(script, expected))
        fail("extension packet set does not exactly conserve and bind the covenant spend");
};

const exactAnchor = (tx: Transaction, index: number): void =>
    exactOutput(tx, index, P2A.amount, P2A.script, "P2A anchor");

const exactTransactionHeader = (tx: Transaction, lockTime: number, label: string): void => {
    const sequence = lockTime === 0 ? 0xffffffff : 0xfffffffe;
    if (tx.version !== 3 || tx.lockTime !== lockTime)
        fail(`${label} version or locktime differs from the SDK 0.4.72 graph`);
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
        params: {
            receiverKey: advance.receiverKey,
            senderKey: advance.senderKey,
            operatorKey: advance.operatorKey,
            dust: advance.dust,
            topup: advance.topup,
            locktime: advance.locktime,
            ...(advance.assetId ? { assetId: advance.assetId } : {}),
        },
    });
    const envelope = decodeLockupEnvelope(advance.unsignedLockupTx);
    if (
        envelope.unsignedTxId !== advance.unsignedLockupId ||
        envelope.covenantOutputIndex !== outpoint.vout ||
        envelope.serverUnrollScript !==
            hex.encode(CSVMultisigTapscript.decode(hex.decode(envelope.serverUnrollScript)).script)
    )
        fail("persisted lockup commitments are inconsistent");
    const lockup = Transaction.fromPSBT(base64.decode(envelope.arkTx));
    if (lockup.id !== outpoint.txid || lockup.outputsLength <= outpoint.vout)
        fail("persisted covenant outpoint does not belong to the lockup graph");
    exactOutput(lockup, outpoint.vout, advance.dust, script.pkScript, "lockup covenant");
    if (script.address(config.addressHrp, config.serverPubkey).encode() !== advance.covenantAddress)
        fail("persisted covenant address mismatch");
    const expectedAsset = assetId(advance);
    const units = envelope.assetUnits === undefined ? undefined : BigInt(envelope.assetUnits);
    if (
        (expectedAsset === undefined) !== (units === undefined) ||
        (units !== undefined && units <= 0n)
    )
        fail("persisted covenant asset facts mismatch");
    return {
        script,
        unroll: CSVMultisigTapscript.decode(hex.decode(envelope.serverUnrollScript)),
        expectedHoldings: expectedAsset ? [{ id: expectedAsset, amount: units! }] : [],
    };
};

const lockingOutpoint = (advance: Advance): { txid: string; vout: number } => {
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
    exactTree(tx, 0, sourceTree.encode(), label);
    const selected = selectedLeaf(tx, 0, leaf, label);
    exactSignatures(tx, 0, selected, signers, label);
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
    exactTree(arkTx, index, tree.encode(), label);
    const expected = tree.findLeaf(hex.encode(leaf));
    const selected = selectedLeaf(arkTx, index, expected, label);
    exactSignatures(arkTx, index, selected, signers, label);
};

export async function classifyObservedSpend(
    advance: Advance,
    coin: VirtualCoin,
    deps: Pick<SpendWatcherDeps, "indexer" | "config">,
    tip: Pick<Awaited<ReturnType<SpendWatcherDeps["tip"]>>, "height" | "time">,
): Promise<ObservedSpend> {
    const candidate = /^[0-9a-f]{64}$/.test(coin.arkTxId ?? "") ? coin.arkTxId! : "unknown";
    try {
        if (!advance.outpoint || !sameOutpoint(coin, advance.outpoint))
            fail("spent coin is not the persisted covenant outpoint");
        const outpoint = advance.outpoint!;
        const facts = covenantFacts(advance, deps.config);
        if (
            coin.value !== Number(advance.dust) ||
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
        if (
            covenantHoldings.length !== facts.expectedHoldings.length ||
            covenantHoldings.some(
                (holding, index) =>
                    holding.id !== facts.expectedHoldings[index]!.id ||
                    holding.amount !== facts.expectedHoldings[index]!.amount,
            )
        )
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
        const recoveryLocktime = advance.recoveryLocktime;
        if (
            leaf === Leaf.Recovery &&
            (!recoveryLocktime ||
                recoveryLocktime.kind !== advance.batchExpiry.kind ||
                recoveryLocktime.value !== advance.locktime)
        )
            fail("recovery locktime tag is missing or inconsistent");
        const expectedLockTime = leaf === Leaf.Recovery ? Number(recoveryLocktime!.value) : 0;
        exactTransactionHeader(checkpoint, expectedLockTime, "covenant checkpoint");
        exactTransactionHeader(arkTx, expectedLockTime, "covenant Arkade transaction");
        const expectedLeaf = covenantSpendInput(
            facts.script,
            leaf,
            outpoint,
            advance.dust,
        ).tapLeafScript;
        const covenantProgram =
            facts.script.covenant[
                leaf === Leaf.Recycle ? "recycle" : leaf === Leaf.Purchase ? "purchase" : "refund"
            ];
        const covenantSigners = [
            deps.config.serverPubkey,
            ...(leaf === Leaf.RefundSender ? [advance.senderKey] : []),
            arkade.computeArkadeScriptPublicKey(deps.config.emulatorPubkey, covenantProgram),
        ];
        const checkpointTree = directCheckpoint(
            checkpoint,
            outpoint,
            advance.dust,
            facts.script,
            expectedLeaf,
            facts.unroll,
            covenantSigners,
            "covenant checkpoint",
        );
        arkInput(
            arkTx,
            0,
            checkpoint,
            advance.dust,
            checkpointTree,
            facts.script.scripts[leaf],
            covenantSigners,
            "covenant Arkade input",
        );

        if (leaf === Leaf.Purchase) {
            if (arkTx.inputsLength !== 1 || arkTx.outputsLength !== 3)
                fail("purchase input or output count mismatch");
            exactOutput(
                arkTx,
                0,
                advance.dust,
                new Uint8Array([0x51, 0x20, ...advance.receiverKey]),
                "purchase receiver output",
            );
            if (advance.dust < deps.config.vtxoMinAmount)
                fail("purchase receiver output is below the provider minimum");
            exactExtension(arkTx, 1, covenantProgram, [covenantHoldings], 0);
            exactAnchor(arkTx, 2);
            return { kind: "purchased", txid: arkTx.id };
        }

        if (leaf === Leaf.Recycle) {
            if (arkTx.inputsLength !== 2 || arkTx.outputsLength !== 4)
                fail("recycle input or output count mismatch");
            const receiverCheckpointId = txid(arkTx.getInput(1));
            const receiverRaw = await rawTransactions(deps.indexer, [receiverCheckpointId]);
            const receiverCheckpoint = receiverRaw.get(receiverCheckpointId)!;
            exactTransactionHeader(receiverCheckpoint, 0, "receiver checkpoint");
            const receiverInput = receiverCheckpoint.getInput(0);
            const receiverOutpoint = { txid: txid(receiverInput), vout: receiverInput.index! };
            const receiverCoin = await exactCoin(deps.indexer, receiverOutpoint);
            if (
                !receiverCoin ||
                !receiverCoin.isSpent ||
                receiverCoin.spentBy !== receiverCheckpoint.id ||
                receiverCoin.arkTxId !== arkTx.id
            )
                fail("receiver funding outpoint lacks exact canonical spend evidence");
            const exactReceiverCoin = receiverCoin!;
            const trees = getArkPsbtFields(receiverCheckpoint, 0, VtxoTaprootTree);
            if (trees.length !== 1) fail("receiver funding tree is missing or ambiguous");
            const receiverTree = VtxoScript.decode(trees[0]!);
            if (
                !sameBytes(receiverTree.encode(), trees[0]!) ||
                !sameBytes(
                    receiverTree.pkScript,
                    new Uint8Array([0x51, 0x20, ...advance.receiverKey]),
                ) ||
                exactReceiverCoin.script !== hex.encode(receiverTree.pkScript)
            )
                fail("receiver funding tree does not belong to the persisted receiver");
            const heightExpiry = exactReceiverCoin.expiresAtHeight;
            const timeExpiry = exactReceiverCoin.expiresAt;
            if (
                (heightExpiry === undefined) === (timeExpiry === undefined) ||
                (heightExpiry !== undefined &&
                    (!Number.isSafeInteger(heightExpiry) || heightExpiry <= 0)) ||
                (timeExpiry !== undefined &&
                    (!(timeExpiry instanceof Date) ||
                        !Number.isSafeInteger(timeExpiry.getTime()) ||
                        timeExpiry.getTime() <= 0)) ||
                !(exactReceiverCoin.createdAt instanceof Date) ||
                !Number.isSafeInteger(exactReceiverCoin.createdAt.getTime()) ||
                exactReceiverCoin.createdAt.getTime() < 0 ||
                exactReceiverCoin.isUnrolled !== false ||
                exactReceiverCoin.isSwept !== false ||
                typeof exactReceiverCoin.isPreconfirmed !== "boolean" ||
                typeof exactReceiverCoin.status?.confirmed !== "boolean" ||
                typeof exactReceiverCoin.status.isLeaf !== "boolean" ||
                exactReceiverCoin.status.confirmed === exactReceiverCoin.isPreconfirmed ||
                exactReceiverCoin.status.isLeaf === exactReceiverCoin.isPreconfirmed ||
                !Array.isArray(exactReceiverCoin.commitmentTxIds) ||
                exactReceiverCoin.commitmentTxIds.some((id) => !/^[0-9a-f]{64}$/.test(id)) ||
                !Number.isSafeInteger(exactReceiverCoin.value) ||
                exactReceiverCoin.value <= 0
            )
                fail("receiver funding canonical status or expiry is inconsistent");
            const leaves = receiverCheckpoint.getInput(0).tapLeafScript;
            if (!leaves || leaves.length !== 1) fail("receiver checkpoint leaf is ambiguous");
            const receiverLeafBody = scriptFromTapLeafScript(leaves![0]!);
            const closure = MultisigTapscript.decode(receiverLeafBody);
            if (
                closure.params.pubkeys.length !== 2 ||
                sameBytes(closure.params.pubkeys[0]!, closure.params.pubkeys[1]!) ||
                !closure.params.pubkeys.some((pubkey) =>
                    sameBytes(pubkey, deps.config.serverPubkey),
                )
            )
                fail("receiver funding leaf has unexpected signers");
            const receiverLeaf = receiverTree.findLeaf(hex.encode(receiverLeafBody));
            const receiverSigners = closure.params.pubkeys;
            const receiverCheckpointTree = directCheckpoint(
                receiverCheckpoint,
                receiverOutpoint,
                BigInt(exactReceiverCoin.value),
                receiverTree,
                receiverLeaf,
                facts.unroll,
                receiverSigners,
                "receiver checkpoint",
            );
            arkInput(
                arkTx,
                1,
                receiverCheckpoint,
                BigInt(exactReceiverCoin.value),
                receiverCheckpointTree,
                receiverLeafBody,
                receiverSigners,
                "receiver Arkade input",
            );
            const merged = advance.dust + BigInt(exactReceiverCoin.value) - advance.topup;
            if (merged < advance.dust || merged < deps.config.vtxoMinAmount)
                fail("recycle receiver output is below dust or provider minimum");
            exactOutput(
                arkTx,
                0,
                advance.topup,
                payoutPkScript(advance.operatorKey, advance.topup, advance.dust),
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
            exactExtension(arkTx, 2, covenantProgram, [covenantHoldings, receiverHoldings], 1);
            exactAnchor(arkTx, 3);
            return { kind: "recycled", txid: arkTx.id };
        }

        if (arkTx.inputsLength !== 1 || arkTx.outputsLength !== 4)
            fail("refund input or output count mismatch");
        const topup = refundTopup(
            {
                receiverKey: advance.receiverKey,
                senderKey: advance.senderKey,
                operatorKey: advance.operatorKey,
                dust: advance.dust,
                topup: advance.topup,
                locktime: advance.locktime,
                ...(advance.assetId ? { assetId: advance.assetId } : {}),
            },
            deps.config.vtxoMinAmount,
        );
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
            advance.dust - topup,
            payoutPkScript(advance.senderKey, advance.dust - topup, advance.dust),
            "refund sender output",
        );
        exactExtension(arkTx, 2, covenantProgram, [covenantHoldings], 1);
        exactAnchor(arkTx, 3);
        if (leaf === Leaf.Recovery) {
            if (
                arkTx.lockTime !== Number(recoveryLocktime!.value) ||
                checkpoint.lockTime !== Number(recoveryLocktime!.value)
            )
                fail("recovery does not carry the exact persisted CLTV");
            const chainClock = recoveryLocktime!.kind === "height" ? tip.height : tip.time;
            if (!Number.isSafeInteger(chainClock) || BigInt(chainClock) < recoveryLocktime!.value)
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

const activeStates = ["locking", "locked", "recovering"] as const;
const terminalStates = ["recycled", "purchased", "refunded", "recovered"] as const;

export function createSpendWatcher(deps: SpendWatcherDeps): SpendWatcher {
    let lastScanAt: number | null = null;
    let watching = 0;
    let scanBlockers: WatcherBlocker[] = [];
    let streamBlockers: WatcherBlocker[] = [];
    let pending: Promise<void> | undefined;
    let controller: AbortController | undefined;
    let streamTask: Promise<void> | undefined;
    const recoverable = new Set<string>();

    const rows = () => [
        ...activeStates.flatMap((state) => deps.advances.byState(state)),
        ...terminalStates.flatMap((state) => deps.advances.byState(state)),
    ];
    const persistedBlockers = (): WatcherBlocker[] =>
        rows()
            .filter((advance) =>
                ["covenant_spend_unknown", "covenant_observation_disagreement"].includes(
                    advance.failureCode ?? "",
                ),
            )
            .map((advance) => ({
                advanceId: advance.id,
                code: advance.failureCode!,
                detail: advance.failureDetail ?? "canonical spend evidence requires attention",
            }));

    const scan = async (): Promise<void> => {
        recoverable.clear();
        const current = rows();
        watching = current.length;
        scanBlockers = [];
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
            return;
        }
        for (const advance of current) {
            const terminal = terminalStates.includes(
                advance.state as (typeof terminalStates)[number],
            );
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
                if (terminal)
                    deps.advances.recordSpendDisagreement(
                        advance.id,
                        "persisted terminal covenant outpoint is missing",
                        deps.now(),
                        tip,
                    );
                else
                    deps.advances.recordSpendUnknown(
                        advance.id,
                        undefined,
                        "persisted covenant outpoint is missing",
                        deps.now(),
                        tip,
                    );
                continue;
            }
            if (
                terminal &&
                (advance.observationTipHeight === undefined ||
                    advance.observationTipHash === undefined)
            ) {
                deps.advances.recordSpendDisagreement(
                    advance.id,
                    "persisted terminal observation tip identity is missing",
                    deps.now(),
                    tip,
                );
            } else if (terminal && tip.height < advance.observationTipHeight!) {
                deps.advances.recordSpendDisagreement(
                    advance.id,
                    `canonical tip height ${tip.height} is below persisted observation height ${advance.observationTipHeight}`,
                    deps.now(),
                    tip,
                );
            } else if (
                terminal &&
                advance.observationTipHeight === tip.height &&
                advance.observationTipHash !== undefined &&
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
            let coin: VirtualCoin | undefined;
            try {
                coin = await exactCoin(deps.indexer, observedAdvance.outpoint);
            } catch (error) {
                const reason =
                    error instanceof EvidenceError
                        ? error.message
                        : "canonical outpoint evidence is unavailable";
                if (terminalStates.includes(advance.state as (typeof terminalStates)[number]))
                    deps.advances.recordSpendDisagreement(advance.id, reason, deps.now(), tip);
                else
                    deps.advances.recordSpendUnknown(
                        advance.id,
                        undefined,
                        reason,
                        deps.now(),
                        tip,
                    );
                continue;
            }
            if (!coin || !coin.isSpent) {
                if (terminal)
                    deps.advances.recordSpendDisagreement(
                        advance.id,
                        coin
                            ? "persisted terminal spend disappeared from the canonical outpoint"
                            : "persisted terminal outpoint disappeared from the canonical indexer",
                        deps.now(),
                        tip,
                    );
                else if (coin) {
                    try {
                        const facts = covenantFacts(observedAdvance, deps.config);
                        const assets = holdings(coin, "covenant outpoint");
                        if (
                            coin.isSpent !== false ||
                            coin.spentBy ||
                            coin.isSwept !== false ||
                            coin.isUnrolled !== false ||
                            coin.value !== Number(advance.dust) ||
                            coin.script !== hex.encode(facts.script.pkScript) ||
                            assets.length !== facts.expectedHoldings.length ||
                            assets.some(
                                (holding, index) =>
                                    holding.id !== facts.expectedHoldings[index]!.id ||
                                    holding.amount !== facts.expectedHoldings[index]!.amount,
                            )
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
            const observed = await classifyObservedSpend(observedAdvance, coin, deps, tip);
            if (observed.kind === "unknown") {
                if (terminal)
                    deps.advances.recordSpendDisagreement(
                        advance.id,
                        `persisted terminal spend no longer validates: ${observed.reason}`,
                        deps.now(),
                        tip,
                    );
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
            if (terminal) {
                if (advance.state !== observed.kind || advance.spentTxid !== observed.txid)
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
        }
        lastScanAt = deps.now();
    };

    const catchUp = () => {
        if (!pending)
            pending = scan().finally(() => {
                pending = undefined;
            });
        return pending;
    };
    const sleep =
        deps.sleep ??
        ((milliseconds: number, signal: AbortSignal) =>
            new Promise<void>((resolve) => {
                if (signal.aborted) return resolve();
                const timer = setTimeout(resolve, milliseconds);
                signal.addEventListener(
                    "abort",
                    () => {
                        clearTimeout(timer);
                        resolve();
                    },
                    { once: true },
                );
            }));
    const prompt = deps.onPrompt ?? catchUp;

    return {
        catchUp,
        isRecoverable: (id) => recoverable.has(id),
        async start() {
            await prompt();
            if (!deps.arkProvider || streamTask) return;
            controller = new AbortController();
            const signal = controller.signal;
            streamTask = (async () => {
                let backoff = 250;
                while (!signal.aborted) {
                    try {
                        for await (const _event of deps.arkProvider!.getTransactionsStream(
                            signal,
                        )) {
                            if (signal.aborted) break;
                            streamBlockers = [];
                            await prompt();
                            backoff = 250;
                        }
                        if (!signal.aborted)
                            streamBlockers = [
                                {
                                    code: "transaction_stream_disconnected",
                                    detail: "Arkade transaction stream disconnected; polling remains authoritative",
                                },
                            ];
                    } catch {
                        if (signal.aborted) break;
                        streamBlockers = [
                            {
                                code: "transaction_stream_disconnected",
                                detail: "Arkade transaction stream disconnected; polling remains authoritative",
                            },
                        ];
                    }
                    if (!signal.aborted) {
                        await sleep(backoff, signal);
                        backoff = Math.min(backoff * 2, 30_000);
                    }
                }
            })().finally(() => {
                streamTask = undefined;
                controller = undefined;
            });
        },
        async stop() {
            controller?.abort();
            await streamTask;
        },
        status: () => ({
            lastScanAt,
            watching,
            blockers: [...scanBlockers, ...streamBlockers, ...persistedBlockers()],
        }),
    };
}
