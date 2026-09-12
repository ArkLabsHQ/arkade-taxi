import { describe, expect, it } from "vitest";
import { ArkAddress, asset, SingleKey } from "@arkade-os/sdk";
import { DustCovenantScript } from "@arkade-taxi/covenant";
import { TERMINAL_STATES, type Advance } from "@arkade-taxi/core";
import { bytesToHex } from "@arkade-taxi/protocol";
import { ACTIVE_CLAIM_STATES, listReceiverClaims, parseReceiverAddresses } from "../src/claims.js";
import { ServiceError } from "../src/errors.js";
import { buildLockupEnvelope } from "../src/arkade/lockupBuilder.js";
import { decodeLockupEnvelope, encodeLockupEnvelope } from "../src/arkade/psbt.js";
import { buildRequest, unroll } from "./arkade/lockupFixtures.js";
import { config, MemoryAdvances, NOW, receiverKey, senderKey, serverKey } from "./fixtures.js";

const cfg = config();
const bob = new ArkAddress(serverKey, receiverKey, "ark");
const alice = new ArkAddress(serverKey, senderKey, "ark");
const assetUnits = 9_007_199_254_740_993n;

function persisted(over: Partial<Advance> = {}, withAsset = false): Advance {
    const request = buildRequest();
    request.advanceId = over.id ?? "transfer-1";
    if (withAsset) {
        const id = asset.AssetId.create("12".repeat(32), 7);
        request.params.assetId = { txid: Uint8Array.from(id.txid).reverse(), groupIndex: 7 };
        request.senderInputs[0]!.assetPacket = asset.Packet.create([
            asset.AssetGroup.create(id, null, [], [asset.AssetOutput.create(2, assetUnits)], []),
        ]).serialize();
        request.covenantAddress = new DustCovenantScript({
            params: request.params,
            serverKey,
            emulatorKey: cfg.emulatorPubkey,
            vtxoMinAmount: cfg.vtxoMinAmount,
        })
            .address("ark", serverKey)
            .encode();
    }
    const unsignedLockupTx = buildLockupEnvelope(request, cfg, unroll);
    const envelope = decodeLockupEnvelope(unsignedLockupTx);
    return {
        id: request.advanceId,
        state: "locked",
        ...request.params,
        ...(withAsset ? { assetUnits } : {}),
        covenantAddress: request.covenantAddress,
        fare: request.fare,
        batchExpiry: request.funding.batchExpiry,
        recoveryLocktime: { kind: "height", value: request.params.locktime },
        operatorInputs: request.funding.inputs.map(({ txid, vout }) => ({ txid, vout })),
        unsignedLockupTx,
        unsignedLockupId: envelope.unsignedTxId,
        outpoint: { txid: "cd".repeat(32), vout: 0 },
        createdAt: NOW,
        updatedAt: NOW,
        expiresAt: NOW + 60,
        ...over,
    };
}

function deps(...rows: Advance[]) {
    const advances = new MemoryAdvances();
    for (const row of rows) advances.insert(row);
    return { advances, config: cfg };
}

describe("parseReceiverAddresses", () => {
    it.each([
        ["empty", []],
        ["malformed bech32m", ["ark1broken"]],
        ["noncanonical uppercase", [bob.encode().toUpperCase()]],
        ["wrong network", [new ArkAddress(serverKey, receiverKey, "tark").encode()]],
        ["wrong server key", [new ArkAddress(senderKey, receiverKey, "ark").encode()]],
    ])("rejects %s with a stable bad-request code", (_name, addresses) => {
        expect(() => parseReceiverAddresses(addresses, cfg)).toThrow(ServiceError);
        expect(() => parseReceiverAddresses(addresses, cfg)).toThrow(
            expect.objectContaining({ code: "invalid_receiver_batch", status: 400 }),
        );
    });

    it("deduplicates canonical addresses and preserves receiver-key correspondence", () => {
        expect(parseReceiverAddresses([bob.encode(), alice.encode(), bob.encode()], cfg)).toEqual({
            addresses: [bob.encode(), alice.encode()],
            receiverKeys: [receiverKey, senderKey],
        });
    });

    it("counts unique addresses for the 64-address limit", async () => {
        const addresses = await Promise.all(
            Array.from({ length: 65 }, async (_, index) => {
                const key = await SingleKey.fromPrivateKey(
                    new Uint8Array(32).fill(index + 1),
                ).xOnlyPublicKey();
                return new ArkAddress(serverKey, key, "ark").encode();
            }),
        );
        expect(
            parseReceiverAddresses([...addresses.slice(0, 64), addresses[0]!], cfg).addresses,
        ).toHaveLength(64);
        expect(() => parseReceiverAddresses(addresses, cfg)).toThrow(
            expect.objectContaining({ code: "invalid_receiver_batch", status: 400 }),
        );
    });
});

describe("listReceiverClaims", () => {
    const receivers = { addresses: [bob.encode()], receiverKeys: [receiverKey] };

    it("returns an empty snapshot when none of the receivers match", () => {
        expect(listReceiverClaims(deps(), receivers, ACTIVE_CLAIM_STATES)).toEqual([]);
        expect(
            listReceiverClaims(
                deps(persisted({ receiverKey: senderKey })),
                receivers,
                ACTIVE_CLAIM_STATES,
            ),
        ).toEqual([]);
    });

    it("filters active states and orders by updatedAt, then transferId", () => {
        const rows = [
            persisted({ id: "c", state: "recovering", updatedAt: NOW + 1 }),
            persisted({ id: "b", state: "locked" }),
            persisted({ id: "a", state: "locking" }),
            persisted({ id: "quoted", state: "quoted" }),
            ...TERMINAL_STATES.map((state) => persisted({ id: state, state })),
        ];
        const claims = listReceiverClaims(deps(...rows), receivers, ACTIVE_CLAIM_STATES);
        expect(
            claims.map(({ transferId, state, claimable }) => ({ transferId, state, claimable })),
        ).toEqual([
            { transferId: "a", state: "locking", claimable: false },
            { transferId: "b", state: "locked", claimable: true },
            { transferId: "c", state: "recovering", claimable: false },
        ]);
        expect(claims[0]).not.toHaveProperty("claim");
        expect(claims[2]).not.toHaveProperty("claim");
    });

    it("projects the exact locked descriptor and canonical receiver address", () => {
        const row = persisted();
        expect(listReceiverClaims(deps(row), receivers, ACTIVE_CLAIM_STATES)).toEqual([
            {
                transferId: "transfer-1",
                receiverAddress: bob.encode(),
                state: "locked",
                claimable: true,
                updatedAt: NOW,
                claim: {
                    params: {
                        receiverKey: bytesToHex(receiverKey),
                        senderKey: bytesToHex(senderKey),
                        operatorKey: bytesToHex(cfg.operatorKey),
                        dust: "330",
                        topup: "230",
                        locktime: "899856",
                    },
                    covenantAddress: row.covenantAddress,
                    outpoint: { txid: "cd".repeat(32), vout: 0 },
                    fare: { currency: "sats", units: "10" },
                    batchExpiry: { kind: "height", value: "900000" },
                    recoveryLocktime: { kind: "height", value: "899856" },
                },
            },
        ]);
    });

    it("projects first-class asset units without losing integer precision", () => {
        const [claim] = listReceiverClaims(
            deps(persisted({}, true)),
            receivers,
            ACTIVE_CLAIM_STATES,
        );
        expect(claim?.claim?.assetUnits).toBe("9007199254740993");
        expect(claim?.claim?.params.assetId).toEqual({ txid: "12".repeat(32), groupIndex: 7 });
    });

    it.each(TERMINAL_STATES)("projects %s only when requested, without a descriptor", (state) => {
        const row = persisted({
            state,
            spentTxid: "ef".repeat(32),
            failureCode: "recovery_failed",
            failureDetail: "private operational detail",
            unsignedLockupTx: "unreadable terminal graph",
        });
        expect(listReceiverClaims(deps(row), receivers, ACTIVE_CLAIM_STATES)).toEqual([]);
        expect(listReceiverClaims(deps(row), receivers, [state])).toEqual([
            {
                transferId: row.id,
                receiverAddress: bob.encode(),
                state,
                claimable: false,
                updatedAt: NOW,
                spentTxid: "ef".repeat(32),
                failureCode: "recovery_failed",
            },
        ]);
    });

    it.each(["locking", "recovering"] as const)(
        "omits terminal details and does not require a graph for %s summaries",
        (state) => {
            const [claim] = listReceiverClaims(
                deps(persisted({ state, unsignedLockupTx: "pending", failureCode: "retrying" })),
                receivers,
                ACTIVE_CLAIM_STATES,
            );
            expect(claim).toEqual({
                transferId: "transfer-1",
                receiverAddress: bob.encode(),
                state,
                claimable: false,
                updatedAt: NOW,
            });
        },
    );

    it.each([
        ["missing outpoint", { outpoint: undefined }],
        ["wrong covenant output", { outpoint: { txid: "cd".repeat(32), vout: 1 } }],
        ["missing recovery locktime", { recoveryLocktime: undefined }],
        ["wrong recovery value", { recoveryLocktime: { kind: "height", value: 899855n } }],
        ["wrong recovery kind", { recoveryLocktime: { kind: "time", value: 899856n } }],
        ["wrong covenant params", { topup: 231n }],
        ["malformed graph", { unsignedLockupTx: "broken" }],
        ["asset units on bitcoin", { assetUnits: 1n }],
    ] satisfies [string, Partial<Advance>][])("fails the entire snapshot for %s", (_name, over) => {
        const source = deps(persisted({ id: "a" }), persisted({ id: "b", ...over }));
        expect(() => listReceiverClaims(source, receivers, ACTIVE_CLAIM_STATES)).toThrow();
    });

    it.each([undefined, 1n, 9_007_199_254_740_992n])(
        "rejects asset quantity %s when it disagrees with the validated graph",
        (units) => {
            expect(() =>
                listReceiverClaims(
                    deps(persisted({ assetUnits: units }, true)),
                    receivers,
                    ACTIVE_CLAIM_STATES,
                ),
            ).toThrow();
        },
    );

    it("validates the complete persisted graph before returning its descriptor", () => {
        const row = persisted({}, true);
        const envelope = decodeLockupEnvelope(row.unsignedLockupTx);
        envelope.assetUnits = "1";
        row.assetUnits = 1n;
        row.unsignedLockupTx = encodeLockupEnvelope(envelope);
        expect(() => listReceiverClaims(deps(row), receivers, ACTIVE_CLAIM_STATES)).toThrow();
    });
});
