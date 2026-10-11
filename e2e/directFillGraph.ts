import {
    asset,
    buildOffchainTx,
    Extension,
    MultisigTapscript,
    Transaction,
    assertSubmittedArkTxid,
    matchServerCheckpoints,
    scriptFromTapLeafScript,
    type ArkProvider,
    type ArkTxInput,
    type CSVMultisigTapscript,
    type ExtendedVirtualCoin,
    type Identity,
    type Wallet,
} from "@arkade-os/sdk";
import {
    assertDefaultTapScriptSigs,
    setTapScriptSigEntries,
    tapLeavesOfInput,
} from "@arkade-taxi/client";
import { base64, hex } from "@scure/base";
type DirectCoin = ArkTxInput & { assets?: { assetId: string; amount: bigint }[] };
type DirectGraphArgs = {
    callerInputs: DirectCoin[];
    taxiInputs: DirectCoin[];
    callerScript: Uint8Array;
    covenantScript: Uint8Array;
    operatorScript: Uint8Array;
    callerKey: Uint8Array;
    operatorKey: Uint8Array;
    serverKey: Uint8Array;
    assetId: string;
    assetUnits: bigint;
    covenantSats: bigint;
    loanSats: bigint;
    senderFareSats: bigint;
    dust: bigint;
    vtxoMinAmount: bigint;
    unroll: CSVMultisigTapscript.Type;
};

const sameKeys = (a: string[], b: string[]) =>
    a.length === b.length && [...a].sort().every((key, index) => key === [...b].sort()[index]);
const parse = (psbt: string) => Transaction.fromPSBT(base64.decode(psbt));
const encode = (tx: Transaction) => base64.encode(tx.toPSBT());

export function buildDirectFillGraph(args: DirectGraphArgs) {
    if (!args.callerInputs.length || !args.taxiInputs.length)
        throw new Error("direct fill needs both owners");
    const inputs = [...args.callerInputs, ...args.taxiInputs];
    if (new Set(inputs.map((coin) => `${coin.txid}:${coin.vout}`)).size !== inputs.length)
        throw new Error("direct fill repeats an input");
    inputs.forEach((input, index) => {
        const script = scriptFromTapLeafScript(input.tapLeafScript);
        const leaf = MultisigTapscript.decode(script);
        const owner = index < args.callerInputs.length ? args.callerKey : args.operatorKey;
        if (
            !sameKeys(leaf.params.pubkeys.map(hex.encode), [
                hex.encode(owner),
                hex.encode(args.serverKey),
            ]) ||
            hex.encode(MultisigTapscript.encode(leaf.params).script) !== hex.encode(script)
        )
            throw new Error(`direct fill input ${index} is not canonical owner/server multisig`);
        if (!Number.isSafeInteger(input.value) || input.value <= 0)
            throw new Error(`direct fill input ${index} has an invalid amount`);
    });
    if (args.taxiInputs.some((coin) => coin.assets?.length))
        throw new Error("direct Taxi input carries assets");
    const callerSats = args.callerInputs.reduce((sum, coin) => sum + BigInt(coin.value), 0n);
    const taxiSats = args.taxiInputs.reduce((sum, coin) => sum + BigInt(coin.value), 0n);
    const operatorPayout = taxiSats - args.loanSats + args.senderFareSats;
    const callerChange = callerSats - (args.covenantSats - args.loanSats) - args.senderFareSats;
    const assets = new Map<string, { vin: number; amount: bigint }[]>();
    args.callerInputs.forEach((coin, vin) => {
        for (const held of coin.assets ?? []) {
            if (held.amount <= 0n) throw new Error("direct fill asset input is not positive");
            assets.set(held.assetId, [
                ...(assets.get(held.assetId) ?? []),
                { vin, amount: held.amount },
            ]);
        }
    });
    const available = (assets.get(args.assetId) ?? []).reduce((sum, held) => sum + held.amount, 0n);
    if (args.assetUnits <= 0n || available < args.assetUnits)
        throw new Error("direct fill asset shortfall");
    const callerHasAssets = [...assets].some(
        ([id, holdings]) =>
            holdings.reduce((sum, held) => sum + held.amount, 0n) >
            (id === args.assetId ? args.assetUnits : 0n),
    );
    if (callerChange < (callerHasAssets ? args.vtxoMinAmount : args.dust))
        throw new Error("direct fill caller change is below its floor");
    if (args.covenantSats < args.vtxoMinAmount || operatorPayout < args.dust)
        throw new Error("direct fill covenant or operator payout is below its floor");
    const groups = [...assets].map(([id, holdings]) => {
        const amount = holdings.reduce((sum, held) => sum + held.amount, 0n);
        const delivered = id === args.assetId ? args.assetUnits : 0n;
        return asset.AssetGroup.create(
            asset.AssetId.fromString(id),
            null,
            holdings.map((held) => asset.AssetInput.create(held.vin, held.amount)),
            [
                ...(delivered ? [asset.AssetOutput.create(0, delivered)] : []),
                ...(amount > delivered ? [asset.AssetOutput.create(1, amount - delivered)] : []),
            ],
            [],
        );
    });
    const graph = buildOffchainTx(
        inputs,
        [
            { script: args.covenantScript, amount: args.covenantSats },
            { script: args.callerScript, amount: callerChange },
            { script: args.operatorScript, amount: operatorPayout },
            Extension.create([asset.Packet.create(groups)]).txOut(),
        ],
        args.unroll,
    );
    return {
        ...graph,
        taxiInputIndexes: args.taxiInputs.map((_, index) => args.callerInputs.length + index),
        callerInputIndexes: args.callerInputs.map((_, index) => index),
        callerChange,
        operatorPayout,
    };
}

type DirectGraph = ReturnType<typeof buildDirectFillGraph>;

export const mergeComplete = (original: Transaction, returned: Transaction): Transaction => {
    const merged = original.clone();
    for (let index = 0; index < original.inputsLength; index++) {
        const leaves = tapLeavesOfInput(original, index);
        if (leaves.length !== 1) throw new Error("direct fill has no unique spend leaf");
        const leaf = leaves[0]!;
        const keys = MultisigTapscript.decode(leaf.script).params.pubkeys.map(hex.encode);
        const entries = new Map<
            string,
            { pubKey: Uint8Array; leafHash: Uint8Array; signature: Uint8Array }
        >();
        for (const tx of [original, returned]) {
            const input = tx.getInput(index);
            if (
                input.tapKeySig?.length ||
                input.partialSig?.length ||
                input.finalScriptSig?.length ||
                input.finalScriptWitness?.length ||
                (input.sighashType !== undefined && input.sighashType !== 0)
            )
                throw new Error("direct fill returned an unsupported signature");
            for (const [data, signature] of input.tapScriptSig ?? []) {
                const id = `${hex.encode(data.pubKey)}:${hex.encode(data.leafHash)}`;
                const prior = entries.get(id);
                if (prior && hex.encode(prior.signature) !== hex.encode(signature))
                    throw new Error("direct fill returned conflicting owner signatures");
                entries.set(id, { ...data, signature });
            }
        }
        setTapScriptSigEntries(merged, index, [...entries.values()]);
        assertDefaultTapScriptSigs(merged, index, {
            allowedPubKeys: keys,
            leafHash: hex.decode(leaf.leafHashHex),
            context: `direct fill input ${index}`,
        });
        if (
            !sameKeys(
                [...entries.values()].map((entry) => hex.encode(entry.pubKey)),
                keys,
            )
        )
            throw new Error(`direct fill input ${index} is not fully signed`);
    }
    return merged;
};

export async function finalizeAcceptedDirectFill(args: {
    graph: DirectGraph;
    callerCoins: ExtendedVirtualCoin[];
    pendingWallet: Pick<Wallet, "makeGetPendingTxIntentSignature">;
    provider: Pick<ArkProvider, "getPendingTxs" | "finalizeTx">;
    operatorIdentity: Identity;
}) {
    const proof = await args.pendingWallet.makeGetPendingTxIntentSignature(args.callerCoins);
    const pending = await args.provider.getPendingTxs(proof);
    const accepted = pending.filter((candidate) => candidate.arkTxid === args.graph.arkTx.id);
    if (accepted.length !== 1)
        throw new Error("original accepted direct fill is not uniquely pending");
    const response = accepted[0]!;
    assertSubmittedArkTxid(response, args.graph.arkTx, "accepted direct fill");
    mergeComplete(args.graph.arkTx, parse(response.finalArkTx));
    const matched = matchServerCheckpoints(
        response.signedCheckpointTxs,
        args.graph.checkpoints,
        "accepted direct fill",
    );
    const byId = new Map(matched.map(({ local, server }) => [local.id, server]));
    const checkpoints = [] as string[];
    for (const [index, checkpoint] of args.graph.checkpoints.entries()) {
        const original = args.graph.taxiInputIndexes.includes(index)
            ? await args.operatorIdentity.sign(checkpoint.clone(), [0])
            : checkpoint;
        checkpoints.push(encode(mergeComplete(original, byId.get(checkpoint.id)!)));
    }
    await args.provider.finalizeTx(args.graph.arkTx.id, checkpoints);
    return args.graph.arkTx.id;
}
