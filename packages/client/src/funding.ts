import {
    VtxoScript,
    asset,
    canSpendOffchain,
    scriptFromTapLeafScript,
    type ExtendedVirtualCoin,
} from "@arkade-os/sdk";
import {
    bytesToHex,
    fundingInputFromWire,
    fundingInputToWire,
    type FundingInputValue,
} from "@arkade-taxi/protocol";

export function fundingInputsFromVtxos(vtxos: readonly ExtendedVirtualCoin[]): FundingInputValue[] {
    const seen = new Set<string>();
    return vtxos.map((coin) => {
        if (
            !canSpendOffchain(coin, { timestamp: new Date() }) ||
            coin.virtualStatus.state === "spent" ||
            coin.virtualStatus.state === "swept"
        )
            throw new Error("taxi: selected VTXO is not spendable");
        if (!Number.isSafeInteger(coin.value) || coin.value <= 0)
            throw new Error("taxi: invalid selected VTXO value");
        const key = `${coin.txid}:${coin.vout}`;
        if (seen.has(key)) throw new Error("taxi: duplicate selected VTXO");
        seen.add(key);
        if ((coin.expiresAt !== undefined) === (coin.expiresAtHeight !== undefined))
            throw new Error("taxi: unknown or ambiguous selected VTXO expiry");
        const expiry =
            coin.expiresAt !== undefined
                ? { kind: "time" as const, value: BigInt(coin.expiresAt.getTime() / 1000) }
                : { kind: "height" as const, value: BigInt(coin.expiresAtHeight!) };
        const tree = VtxoScript.decode(coin.tapTree);
        const spendLeaf = scriptFromTapLeafScript(coin.forfeitTapLeafScript);
        if (
            bytesToHex(tree.pkScript) !== coin.script ||
            !tree.scripts.some((script) => bytesToHex(script) === bytesToHex(spendLeaf))
        )
            throw new Error("taxi: selected VTXO tree or spend leaf mismatch");
        const [proof, leaf] = tree.findLeaf(bytesToHex(spendLeaf));
        const [suppliedProof, suppliedLeaf] = coin.forfeitTapLeafScript;
        if (
            proof.version !== suppliedProof.version ||
            bytesToHex(leaf) !== bytesToHex(suppliedLeaf) ||
            bytesToHex(proof.internalKey) !== bytesToHex(suppliedProof.internalKey) ||
            proof.merklePath.length !== suppliedProof.merklePath.length ||
            proof.merklePath.some(
                (path, index) => bytesToHex(path) !== bytesToHex(suppliedProof.merklePath[index]),
            )
        )
            throw new Error("taxi: selected VTXO leaf proof mismatch");
        const assets = new Set<string>();
        const groups = (coin.assets ?? []).map((holding) => {
            const id = asset.AssetId.fromString(holding.assetId);
            if (
                typeof holding.amount !== "bigint" ||
                holding.amount <= 0n ||
                assets.has(id.toString())
            )
                throw new Error("taxi: invalid or duplicate selected VTXO asset");
            assets.add(id.toString());
            return asset.AssetGroup.create(
                id,
                null,
                [],
                [asset.AssetOutput.create(coin.vout, holding.amount)],
                [],
            );
        });
        groups.sort((a, b) => (a.assetId!.toString() < b.assetId!.toString() ? -1 : 1));
        return fundingInputFromWire(
            fundingInputToWire({
                txid: coin.txid,
                vout: coin.vout,
                value: BigInt(coin.value),
                tapTree: tree.encode(),
                spendLeaf,
                expiry,
                ...(groups.length ? { assetPacket: asset.Packet.create(groups).serialize() } : {}),
            }),
        );
    });
}
