import { asset, type Outpoint, type TapLeafScript } from "@arkade-os/sdk";
import { hex } from "@scure/base";
import { DustCovenantScript, Leaf } from "./vtxo.js";

const { AssetGroup, AssetId, AssetOutput, Packet } = asset;

export interface CovenantSpendInput {
    txid: string;
    vout: number;
    value: bigint;
    tapTree: Uint8Array;
    tapLeafScript: TapLeafScript;
    assetPacket?: Uint8Array;
}

const sameBytes = (a: Uint8Array, b: Uint8Array): boolean =>
    a.length === b.length && a.every((value, index) => value === b[index]);

const canonicalAssetPacket = (encoded: Uint8Array, vout: number): Uint8Array => {
    const packet = Packet.fromBytes(encoded);
    if (!sameBytes(packet.serialize(), encoded))
        throw new Error("covenant spend: assetPacket encoding");
    const groups = packet.groups.map((group) => {
        if (!group.assetId || group.controlAsset || group.inputs.length)
            throw new Error("covenant spend: assetPacket must contain existing holdings only");
        if (group.outputs.length !== 1 || group.outputs[0].vout !== vout)
            throw new Error("covenant spend: assetPacket output mismatch");
        return [group.assetId.toString(), group.outputs[0].amount] as const;
    });
    if (new Set(groups.map(([id]) => id)).size !== groups.length)
        throw new Error("covenant spend: duplicate asset group");
    const canonical = Packet.create(
        [...groups]
            .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
            .map(([id, amount]) =>
                AssetGroup.create(
                    AssetId.fromString(id),
                    null,
                    [],
                    [AssetOutput.create(vout, amount)],
                    [],
                ),
            ),
    ).serialize();
    if (!sameBytes(canonical, encoded))
        throw new Error("covenant spend: non-canonical assetPacket");
    return Uint8Array.from(encoded);
};

export function covenantSpendInput(
    script: DustCovenantScript,
    leaf: Leaf,
    outpoint: Outpoint,
    value: bigint,
    assetPacket?: Uint8Array,
): CovenantSpendInput {
    if (!/^[0-9a-f]{64}$/.test(outpoint.txid))
        throw new Error("covenant spend: txid must be 32-byte lowercase hex");
    if (!Number.isSafeInteger(outpoint.vout) || outpoint.vout < 0 || outpoint.vout > 0xffffffff)
        throw new Error("covenant spend: invalid vout");
    if (typeof value !== "bigint" || value <= 0n)
        throw new Error("covenant spend: value must be a positive bigint");
    if (!Number.isInteger(leaf) || leaf < Leaf.Recycle || leaf > Leaf.Recovery)
        throw new Error("covenant spend: invalid leaf");
    const selected = script.findLeaf(hex.encode(script.scripts[leaf]));
    return {
        txid: outpoint.txid,
        vout: outpoint.vout,
        value,
        tapTree: Uint8Array.from(script.encode()),
        tapLeafScript: [
            {
                version: selected[0].version,
                internalKey: Uint8Array.from(selected[0].internalKey),
                merklePath: selected[0].merklePath.map((path) => Uint8Array.from(path)),
            },
            Uint8Array.from(selected[1]),
        ],
        ...(assetPacket === undefined
            ? {}
            : { assetPacket: canonicalAssetPacket(assetPacket, outpoint.vout) }),
    };
}
