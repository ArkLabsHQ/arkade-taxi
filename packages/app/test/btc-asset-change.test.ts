import { describe, expect, it } from "vitest";
import { Extension, Transaction, asset } from "@arkade-os/sdk";
import { verifyQuote } from "@arkade-taxi/client";
import { base64 } from "@scure/base";
import { args, fundingInputs, params, quote, senderTree } from "../../client/test/fixtures.js";

const usdt = asset.AssetId.create("12".repeat(32), 0);
const aas = asset.AssetId.create("34".repeat(32), 1);

const assetFunding = (value: bigint, vout: number, id: asset.AssetId, amount: bigint) => ({
    ...fundingInputs()[0],
    value,
    vout,
    assetPacket: asset.Packet.create([
        asset.AssetGroup.create(id, null, [], [asset.AssetOutput.create(vout, amount)], []),
    ]).serialize(),
});

describe("bitcoin lockups funded by asset-bearing coins", () => {
    it.each([false, true])(
        "returns every asset to one spendable sender change (aggregate: %s)",
        (aggregate) => {
            const senderInputs = aggregate
                ? [assetFunding(330n, 0, usdt, 3861n), assetFunding(660n, 1, aas, 1n)]
                : [assetFunding(660n, 1, aas, 1n)];
            const senderSats = senderInputs.reduce((sum, input) => sum + input.value, 0n);
            const p = {
                ...params(),
                topup: 320n,
                claimMode: "recycle" as const,
                recoveryRecipient: "sender" as const,
            };
            const authorization = {
                ...args(),
                senderInputs,
                senderSats,
                quote: quote(p, {
                    senderInputs,
                    senderSats,
                    fare: { currency: "sats", units: 0n },
                }),
                expect: {
                    ...args().expect,
                    paymentSats: 10n,
                    maxTopupSats: 320n,
                    maxFare: { currency: "sats" as const, units: 0n },
                },
            };
            const verified = verifyQuote(authorization);
            const tx = Transaction.fromPSBT(base64.decode(verified.envelope.arkTx));
            expect(tx.getOutput(0)).toMatchObject({
                amount: 330n,
                script: verified.script.pkScript,
            });
            expect(tx.getOutput(1)).toMatchObject({
                amount: aggregate ? 980n : 650n,
                script: senderTree.pkScript,
            });
            const groups = Extension.fromTx(tx).getAssetPacket()!.groups;
            expect(groups).toHaveLength(aggregate ? 2 : 1);
            expect(
                groups.map((group) => ({
                    id: group.assetId!.toString(),
                    outputs: group.outputs.map((output) => ({
                        vout: output.vout,
                        amount: output.amount,
                    })),
                })),
            ).toEqual(
                aggregate
                    ? [
                          { id: usdt.toString(), outputs: [{ vout: 1, amount: 3861n }] },
                          { id: aas.toString(), outputs: [{ vout: 1, amount: 1n }] },
                      ]
                    : [{ id: aas.toString(), outputs: [{ vout: 1, amount: 1n }] }],
            );
            expect(tx.getOutput(1).amount).toBeGreaterThanOrEqual(330n);
            expect(
                groups.every((group) => group.outputs.every((output) => output.vout === 1)),
            ).toBe(true);
            expect(() =>
                verifyQuote({
                    ...authorization,
                    senderInputs: senderInputs.map((input) => ({
                        ...input,
                        assetPacket: undefined,
                    })),
                }),
            ).toThrow();
        },
    );
});
