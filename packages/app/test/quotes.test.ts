import { beforeEach, describe, expect, it, vi } from "vitest";
import { DustCovenantScript } from "@arkade-taxi/covenant";
import { Transaction } from "@arkade-os/sdk";
import { base64 } from "@scure/base";
import { assetIdToWire, bytesToHex } from "@arkade-taxi/protocol";
import type { ServiceError } from "../src/errors.js";
import {
    covenantDeadline,
    createQuote,
    FakeLockupBuilder,
    getTransfer,
    submitLockup,
    type QuoteDeps,
    type QuotePhaseFields,
} from "../src/quotes.js";
import {
    advance,
    config,
    DUST,
    emulatorKey,
    EXPIRY_HEIGHT,
    MemoryAdvances,
    NOW,
    operatorKey,
    policy as basePolicy,
    quoteBody,
    receiverKey,
    senderKey,
    serverKey,
    VTXO_MIN,
    fundingCoin,
    runtimeSafety,
    quoteInfrastructure,
    serverUnroll,
    signedEnvelope,
} from "./fixtures.js";
import type { Policy } from "@arkade-taxi/core";
import { ProductionLockupBuilder } from "../src/arkade/lockupBuilder.js";
import { decodeLockupEnvelope, encodeLockupEnvelope } from "../src/arkade/psbt.js";
import {
    openDatabase,
    AdvanceRepository,
    PolicyRepository,
    ReservationRepository,
    ReservationConflictError,
} from "@arkade-taxi/db";

const MARGIN = 144;
const LOCKTIME = BigInt(NOW) + config().covenantDeadlineSeconds;
const ASSET = { txid: new Uint8Array(32).fill(0xde), groupIndex: 2 };

let advances: MemoryAdvances;
let lockupBuilder: FakeLockupBuilder;
let ids: number;

const deps = (over: { policy?: Partial<Policy>; expiry?: bigint } = {}): QuoteDeps => ({
    ...quoteInfrastructure(advances, () =>
        basePolicy({ locktimeMarginBlocks: MARGIN, ...over.policy }),
    ),
    advances,
    config: config(),
    now: () => NOW,
    randomId: () => `adv-${++ids}`,
    inventory: {
        getSpendableVtxos: async () => [
            fundingCoin({ expiresAtHeight: Number(over.expiry ?? EXPIRY_HEIGHT) }),
            fundingCoin({ vout: 1, expiresAtHeight: Number((over.expiry ?? EXPIRY_HEIGHT) + 1n) }),
        ],
        getLockedVtxoOutpoints: async () => [],
    },
    lockupBuilder,
    lockupSubmitter: lockupBuilder,
});

const satsFareRule = (assetId: typeof ASSET | null, units: bigint) => ({
    assetRules: [
        {
            assetId,
            enabled: true,
            fares: [
                {
                    id: "sats",
                    currency: { kind: "sats" as const },
                    pricing: { kind: "flat" as const, units },
                },
            ],
            claim: "either" as const,
            maxTopupSats: null,
        },
    ],
});

const caught = async (fn: () => Promise<unknown>): Promise<ServiceError> => {
    try {
        await fn();
    } catch (e) {
        return e as ServiceError;
    }
    throw new Error("expected a rejection");
};

beforeEach(() => {
    advances = new MemoryAdvances();
    lockupBuilder = new FakeLockupBuilder(config(), serverUnroll);
    ids = 0;
});

describe("createQuote", () => {
    it.each([
        [true, undefined],
        [true, "0"],
        [false, "1"],
    ] as const)(
        "rejects builder quantity mismatch for asset %s and units %s",
        async (isAsset, quantity) => {
            const d = deps({
                policy: {
                    assetRules: [
                        {
                            assetId: isAsset ? ASSET : null,
                            enabled: true,
                            claim: "either",
                            maxTopupSats: null,
                            fares: [
                                {
                                    id: "sats",
                                    currency: { kind: "sats" },
                                    pricing: { kind: "flat", units: 0n },
                                },
                            ],
                        },
                    ],
                },
            });
            const build = lockupBuilder.buildUnsigned.bind(lockupBuilder);
            d.lockupBuilder = {
                buildUnsigned: async (request) => {
                    const funding = await build(request);
                    const envelope = decodeLockupEnvelope(funding.unsignedLockupTx);
                    if (quantity === undefined) delete envelope.assetUnits;
                    else envelope.assetUnits = quantity;
                    return { ...funding, unsignedLockupTx: encodeLockupEnvelope(envelope) };
                },
            };
            await expect(
                createQuote(d, quoteBody(isAsset ? { assetId: assetIdToWire(ASSET) } : {})),
            ).rejects.toThrow(/builder asset quantity/);
            expect(advances.rows.size).toBe(0);
            expect(d.reservations.listReservedOutpoints()).toEqual([]);
        },
    );
    it("keeps bitcoin claims free of an asset quantity", async () => {
        const response = await createQuote(deps(), quoteBody());
        expect(advances.get(response.transferId)?.assetUnits).toBeUndefined();
    });

    it("mirrors receiver lookup order and returns independent records in memory", () => {
        const BOB = new Uint8Array(32).fill(1);
        const ALICE = new Uint8Array(32).fill(2);
        for (const row of [
            advance({ id: "bob-terminal", receiverKey: BOB, state: "recycled", updatedAt: 30 }),
            advance({ id: "bob-tie-b", receiverKey: BOB, state: "locked", updatedAt: 20 }),
            advance({ id: "foreign", updatedAt: 5 }),
            advance({ id: "alice-tie-a", receiverKey: ALICE, updatedAt: 20 }),
            advance({ id: "bob-older", receiverKey: BOB, state: "quoted", updatedAt: 10 }),
        ])
            advances.insert(row);
        const rows = advances.byReceiverKeys([BOB, ALICE, BOB]);
        expect(rows.map(({ id }) => id)).toEqual([
            "bob-older",
            "alice-tie-a",
            "bob-tie-b",
            "bob-terminal",
        ]);
        rows[0]!.state = "expired";
        expect(advances.get("bob-older")?.state).toBe("quoted");
        expect(advances.byReceiverKeys([])).toEqual([]);
    });
    it("keeps the deadline off a timestamp funding expiry too", async () => {
        const testDeps = deps({ policy: { locktimeMarginBlocks: 999, locktimeMarginSeconds: 60 } });
        testDeps.inventory.getSpendableVtxos = async () => [
            fundingCoin({ expiresAtHeight: undefined, expiresAt: new Date(1789132933000) }),
            fundingCoin({
                vout: 1,
                expiresAtHeight: undefined,
                expiresAt: new Date(1789132934000),
            }),
        ];
        const response = await createQuote(
            testDeps,
            quoteBody({ senderExpiry: { kind: "time", value: "1789139999" } }),
        );
        expect(response.params.locktime).toBe(LOCKTIME.toString());
        expect(advances.get(response.transferId)?.batchExpiry).toBeUndefined();
    });
    it("anchors the locktime to now plus the configured deadline, with no expiry", async () => {
        const response = await createQuote(deps(), quoteBody());
        const deadline = BigInt(NOW) + config().covenantDeadlineSeconds;

        expect(response.params.locktime).toBe(deadline.toString());
        const stored = advances.get(response.transferId)!;
        expect(stored.locktime).toBe(deadline);
        expect(stored.recoveryLocktime).toEqual({ kind: "time", value: deadline });
        expect(stored.batchExpiry).toBeUndefined();
    });

    it("returns the QuoteResponse shape with amounts as decimal strings", async () => {
        const res = await createQuote(deps(), quoteBody());

        expect(res.transferId).toBe("adv-1");
        expect(res.params).toEqual({
            receiverKey: bytesToHex(receiverKey),
            senderKey: bytesToHex(senderKey),
            operatorKey: bytesToHex(operatorKey),
            operatorSignerKey: bytesToHex(config().operatorSignerKey),
            dust: "330",
            topup: "330",
            locktime: LOCKTIME.toString(),
            exitDelay: { value: "5", type: "blocks" },
            claimMode: "recycle",
        });
        expect(res.fare.units).toBe("0");
        expect(res.unsignedLockupTx).toBe(lockupBuilder.unsignedTx);
    });

    it("dates expiry in unix seconds from the policy TTL", async () => {
        const res = await createQuote(deps({ policy: { quoteTtlSeconds: 90 } }), quoteBody());
        expect(res.expiresAt).toBe(NOW + 90);
    });

    it("derives a covenant address the client can reproduce independently", async () => {
        const res = await createQuote(deps(), quoteBody());
        const expected = new DustCovenantScript({
            serverKey,
            emulatorKey,
            vtxoMinAmount: VTXO_MIN,
            params: {
                receiverKey,
                senderKey,
                operatorKey,
                operatorSignerKey: config().operatorSignerKey,
                exitDelay: config().exitDelay,
                dust: DUST,
                topup: DUST,
                locktime: LOCKTIME,
                claimMode: "recycle",
            },
        })
            .address("ark", serverKey)
            .encode();

        expect(res.covenantAddress).toBe(expected);
    });

    it("persists the advance in state quoted", async () => {
        const res = await createQuote(deps(), quoteBody());
        const stored = advances.get(res.transferId)!;

        expect(stored.state).toBe("quoted");
        expect(stored.topup).toBe(330n);
        expect(stored.fare).toEqual({ currency: "sats", units: 0n });
        expect(stored.locktime).toBe(LOCKTIME);
        expect(stored.batchExpiry).toBeUndefined();
        expect(stored.operatorInputs).toEqual([{ txid: "bb".repeat(32), vout: 0 }]);
        expect(stored.unsignedLockupId).toBe(lockupBuilder.unsignedId);
        expect(stored.unsignedLockupTx).toBe(lockupBuilder.unsignedTx);
        expect(stored.createdAt).toBe(NOW);
        expect(stored.covenantAddress).toBe(res.covenantAddress);
    });

    it("locks the sender's sats beside a whole-dust advance", async () => {
        const res = await createQuote(deps(), quoteBody({ senderSats: "100" }));
        expect(res.params.topup).toBe("330");
        expect(res.params.paymentSats).toBe("100");
    });

    it("refuses a sender whose coin already holds a whole dust unit", async () => {
        const error = await caught(() => createQuote(deps(), quoteBody({ senderSats: "1000" })));
        expect(error.code).toBe("invalid_request");
        expect(error.status).toBe(400);
    });

    it("locks an exact paymentSats beside a whole-dust advance", async () => {
        const res = await createQuote(
            deps(),
            quoteBody({ senderSats: "1000", paymentSats: "100" }),
        );
        expect(res.params.topup).toBe("330");
        expect(advances.get(res.transferId)!.paymentSats).toBe(100n);
        const envelope = decodeLockupEnvelope(lockupBuilder.unsignedTx);
        const tx = Transaction.fromPSBT(base64.decode(envelope.arkTx));
        expect([0, 1, 2].map((i) => tx.getOutput(i).amount)).toEqual([430n, 900n, 19_670n]);
    });

    it("leaves no sender change when paymentSats takes the whole coin", async () => {
        const res = await createQuote(deps(), quoteBody({ senderSats: "320", paymentSats: "320" }));
        expect(res.params.topup).toBe("330");
        const envelope = decodeLockupEnvelope(lockupBuilder.unsignedTx);
        const tx = Transaction.fromPSBT(base64.decode(envelope.arkTx));
        expect([0, 1].map((i) => tx.getOutput(i).amount)).toEqual([650n, 19_670n]);
    });

    it.each(["330", "9", "0"])("refuses the unsendable paymentSats %s", async (paymentSats) => {
        const d = deps();
        const error = await caught(() =>
            createQuote(d, quoteBody({ senderSats: "1000", paymentSats })),
        );
        expect(error.code).toBe("invalid_request");
        expect(error.status).toBe(400);
        expect(advances.rows.size).toBe(0);
        expect(d.reservations.listReservedOutpoints()).toEqual([]);
    });

    it("refuses a paymentSats above the sender's own funding", async () => {
        const error = await caught(() =>
            createQuote(deps(), quoteBody({ senderSats: "100", paymentSats: "200" })),
        );
        expect(error.code).toBe("invalid_request");
        expect(error.status).toBe(400);
    });

    it("refuses paymentSats on an asset transfer, where sats are the carrier", async () => {
        const d = deps({ policy: satsFareRule(ASSET, 0n) });
        const error = await caught(() =>
            createQuote(
                d,
                quoteBody({
                    assetId: assetIdToWire(ASSET),
                    senderSats: "1000",
                    paymentSats: "100",
                }),
            ),
        );
        expect(error.code).toBe("invalid_request");
        expect(error.status).toBe(400);
    });

    it("refuses a paymentSats the wire codec cannot read", async () => {
        const error = await caught(() =>
            createQuote(deps(), quoteBody({ senderSats: "1000", paymentSats: "-1" })),
        );
        expect(error.code).toBe("invalid_request");
        expect(error.status).toBe(400);
    });

    it("refuses a positive sats fare on a bitcoin transfer", async () => {
        const d = deps({ policy: satsFareRule(null, 10n) });
        const error = await caught(() => createQuote(d, quoteBody()));
        expect(error.code).toBe("fare_unavailable");
        expect(error.status).toBe(409);
        expect(advances.rows.size).toBe(0);
        expect(d.reservations.listReservedOutpoints()).toEqual([]);
    });

    it("refuses an asset sender that cannot cover the sats fare", async () => {
        const d = deps({ policy: satsFareRule(ASSET, 10n) });
        const error = await caught(() =>
            createQuote(d, quoteBody({ assetId: assetIdToWire(ASSET) })),
        );
        expect(error.code).toBe("fare_unavailable");
        expect(advances.rows.size).toBe(0);
    });

    it("bills a new asset lockup to the sender and lends only the loan", async () => {
        const d = deps({ policy: satsFareRule(ASSET, DUST) });
        const res = await createQuote(
            d,
            quoteBody({ assetId: assetIdToWire(ASSET), senderSats: "330" }),
        );
        expect(res.fare.units).toBe("330");
        expect(advances.get(res.transferId)!.fare).toEqual({ currency: "sats", units: DUST });
        const built = lockupBuilder.built[0]!;
        expect(built.satsFarePayer).toBe("sender");
        const envelope = decodeLockupEnvelope(lockupBuilder.unsignedTx);
        expect(envelope.satsFarePayer).toBe("sender");
        const tx = Transaction.fromPSBT(base64.decode(envelope.arkTx));
        expect([0, 1, 2].map((i) => tx.getOutput(i).amount)).toEqual([
            DUST,
            DUST,
            20000n - built.params.topup,
        ]);
    });

    it.each([
        [undefined, "sats", 100n, "330"],
        [undefined, "sameAsset", 90n, "0"],
        ["90", "sameAsset", 90n, "0"],
    ] as const)(
        "persists resolved units for request %s and fare %s",
        async (quantity, currency, expected, senderSats) => {
            const withAsset = deps({
                policy: {
                    assetRules: [
                        {
                            assetId: ASSET,
                            enabled: true,
                            fares: [
                                {
                                    id: "sats",
                                    currency: { kind: currency },
                                    pricing: {
                                        kind: "flat",
                                        units: currency === "sats" ? DUST : 10n,
                                    },
                                },
                            ],
                            claim: "either",
                            maxTopupSats: null,
                        },
                    ],
                },
            });
            const res = await createQuote(
                withAsset,
                quoteBody({ assetId: assetIdToWire(ASSET), assetUnits: quantity, senderSats }),
            );
            expect(res.params.assetId).toEqual(assetIdToWire(ASSET));
            expect(advances.get(res.transferId)!.assetId).toEqual(ASSET);
            expect(advances.get(res.transferId)!.assetUnits).toBe(expected);
        },
    );

    it("hands the builder the derived covenant, not a rebuilt one", async () => {
        const res = await createQuote(deps(), quoteBody());
        expect(lockupBuilder.built).toHaveLength(1);
        expect(lockupBuilder.built[0]!.covenantAddress).toBe(res.covenantAddress);
        expect(lockupBuilder.built[0]!.fare).toEqual({ currency: "sats", units: 0n });
    });

    it("leaves the deadline untouched by the policy margin", async () => {
        const res = await createQuote(
            deps({ policy: { locktimeMarginBlocks: 1_000 }, expiry: 800_000n }),
            quoteBody(),
        );
        expect(res.params.locktime).toBe(LOCKTIME.toString());
    });

    it("refuses to quote when the deadline is not a future time-domain locktime", async () => {
        const d = deps();
        d.config = config({ covenantDeadlineSeconds: 1n });
        d.runtime.safety = () => runtimeSafety({ chainTime: BigInt(NOW) + 100n });
        const e = await caught(() => createQuote(d, quoteBody()));
        expect(e.code).toBe("no_locktime_headroom");
        expect(e.status).toBe(503);
        expect(advances.rows.size).toBe(0);
    });

    it("refuses a deadline it cannot check against an unknown chain time", () => {
        expect(() => covenantDeadline({ chainTime: null }, config(), NOW)).toThrow(
            /not a future time-domain locktime/,
        );
    });
});

describe("createQuote admission", () => {
    it("revalidates sender expiry against the final synchronous safety sample", async () => {
        const d = deps({ policy: { locktimeMarginBlocks: 1 } });
        let reads = 0;
        d.inventory.getLockedVtxoOutpoints = async () => {
            if (++reads === 2) d.runtime.safety = () => runtimeSafety({ chainHeight: 799900n });
            return [];
        };
        await expect(
            createQuote(d, quoteBody({ senderExpiry: { kind: "height", value: "800000" } })),
        ).rejects.toMatchObject({ code: "runtime_unsafe" });
        expect(advances.rows.size).toBe(0);
    });
    it.each(["locked", "spent"])(
        "rereads operator funding after delayed sender verification becomes %s",
        async (state) => {
            const d = deps();
            const read = d.senderInventory.getVtxos.bind(d.senderInventory);
            let senderReads = 0;
            let changed = false;
            let release!: () => void;
            let started!: () => void;
            const pause = new Promise<void>((resolve) => {
                release = resolve;
            });
            const pending = new Promise<void>((resolve) => {
                started = resolve;
            });
            const events: string[] = [];
            d.runtime.safety = () => {
                events.push("safety");
                return runtimeSafety();
            };
            d.senderInventory.getVtxos = async (opts) => {
                const response = await read(opts);
                if (++senderReads === 2) {
                    started();
                    await pause;
                    events.push("sender-finished");
                }
                return response;
            };
            d.inventory.getSpendableVtxos = async () => {
                events.push("operator-inventory");
                return [
                    fundingCoin({ isSpent: changed && state === "spent" }),
                    fundingCoin({ vout: 1, expiresAtHeight: 900001 }),
                ];
            };
            d.inventory.getLockedVtxoOutpoints = async () => {
                events.push("operator-locks");
                return changed && state === "locked" ? [{ txid: "bb".repeat(32), vout: 0 }] : [];
            };
            const quote = createQuote(d, quoteBody());
            await pending;
            changed = true;
            release();
            await expect(quote).rejects.toMatchObject({ status: 503 });
            expect(advances.rows.size).toBe(0);
            expect(events.lastIndexOf("operator-inventory")).toBeGreaterThan(
                events.indexOf("sender-finished"),
            );
            expect(events.lastIndexOf("operator-locks")).toBeGreaterThan(
                events.lastIndexOf("operator-inventory"),
            );
            expect(events.lastIndexOf("safety")).toBeGreaterThan(events.indexOf("sender-finished"));
        },
    );
    it("reports the sender barrier when the concurrent funding read fails too", async () => {
        const d = deps();
        d.senderInventory.getVtxos = async () => ({ vtxos: [] });
        d.inventory.getSpendableVtxos = () => Promise.reject(new Error("wallet offline"));
        const failure = await caught(() => createQuote(d, quoteBody()));
        expect(failure).toMatchObject({ code: "invalid_request", status: 400 });
        // Flushes the macrotask an unhandled funding rejection would surface in.
        await new Promise((resolve) => setTimeout(resolve, 0));
        expect(advances.rows.size).toBe(0);
    });
    // A sats fare IS its hosting output, so the covenant dust floor is its floor.
    it("refuses a sats fare below the covenant dust floor before reservation", async () => {
        const d = deps({ policy: satsFareRule(ASSET, DUST - 1n) });
        await expect(
            createQuote(d, quoteBody({ assetId: assetIdToWire(ASSET), senderSats: "329" })),
        ).rejects.toThrow(/dust floor/);
        expect(advances.rows.size).toBe(0);
    });
    it("refuses a residual below dust even with a valid fare", async () => {
        const d = deps({ policy: satsFareRule(ASSET, 10n) });
        d.inventory.getSpendableVtxos = async () => [
            fundingCoin({ value: 339 }),
            fundingCoin({ vout: 1, value: 10000, expiresAtHeight: 900001 }),
        ];
        await expect(
            createQuote(d, quoteBody({ assetId: assetIdToWire(ASSET), senderSats: "10" })),
        ).rejects.toMatchObject({ code: "operator_inventory_insufficient" });
        expect(advances.rows.size).toBe(0);
    });
    it("refuses a sub-dust payout before reserving", async () => {
        const d = deps({ policy: satsFareRule(ASSET, DUST) });
        await expect(
            createQuote(d, quoteBody({ assetId: assetIdToWire(ASSET), senderSats: "340" })),
        ).rejects.toThrow(/dust floor/);
        expect(advances.rows.size).toBe(0);
    });
    it.each(["value", "script", "assets", "expiry", "spent", "missing"])(
        "refuses unverified sender %s without reserving",
        async (field) => {
            const d = deps();
            const body = quoteBody();
            const original = d.senderInventory.getVtxos.bind(d.senderInventory);
            d.senderInventory.getVtxos = async (opts) => {
                const response = structuredClone(await original(opts));
                if (field === "value") response.vtxos[0].value++;
                if (field === "script") response.vtxos[0].script = "00";
                if (field === "assets")
                    response.vtxos[0].assets = [{ assetId: "12".repeat(34), amount: 1n }];
                if (field === "expiry") response.vtxos[0].expiresAtHeight!++;
                if (field === "spent") response.vtxos[0].isSpent = true;
                if (field === "missing") response.vtxos = [];
                return response;
            };
            await expect(createQuote(d, body)).rejects.toMatchObject({ code: "invalid_request" });
            expect(advances.rows.size).toBe(0);
        },
    );
    it("uses the earliest compatible sender or operator expiry", async () => {
        const response = await createQuote(
            deps(),
            quoteBody({ senderExpiry: { kind: "height", value: "800000" } }),
        );
        expect(response.params.locktime).toBe(LOCKTIME.toString());
        expect(advances.get(response.transferId)?.batchExpiry).toBeUndefined();
    });
    it("rejects a sender coin spent during construction", async () => {
        const d = deps();
        const read = d.senderInventory.getVtxos.bind(d.senderInventory);
        let reads = 0;
        d.senderInventory.getVtxos = async (opts) => {
            const response = structuredClone(await read(opts));
            if (++reads === 2) response.vtxos[0].isSpent = true;
            return response;
        };
        await expect(createQuote(d, quoteBody())).rejects.toMatchObject({
            code: "invalid_request",
        });
        expect(advances.rows.size).toBe(0);
    });
    it("rejects a builder graph mutation even when its claimed input list remains correct", async () => {
        const d = deps();
        const build = lockupBuilder.buildUnsigned.bind(lockupBuilder);
        d.lockupBuilder.buildUnsigned = async (request) => {
            const funding = await build(request);
            const envelope = JSON.parse(Buffer.from(funding.unsignedLockupTx, "base64").toString());
            envelope.operatorInputIndexes = [0];
            funding.unsignedLockupTx = Buffer.from(JSON.stringify(envelope)).toString("base64");
            return funding;
        };
        await expect(createQuote(d, quoteBody())).rejects.toThrow(/ownership/);
        expect(advances.rows.size).toBe(0);
    });
    it("rejects funding that loses expiry headroom while the builder runs", async () => {
        const d = deps();
        const build = lockupBuilder.buildUnsigned.bind(lockupBuilder);
        d.lockupBuilder.buildUnsigned = async (request) => {
            const funding = await build(request);
            d.runtime.safety = () => runtimeSafety({ chainHeight: 899900n });
            return funding;
        };
        await expect(createQuote(d, quoteBody())).rejects.toMatchObject({ status: 503 });
        expect(advances.rows.size).toBe(0);
    });
    it("reserves the loan alone when the sender pays the sats fare", async () => {
        const d = deps({ policy: satsFareRule(ASSET, DUST) });
        d.inventory.getSpendableVtxos = async () => [
            fundingCoin({ value: 330 }),
            fundingCoin({ vout: 1, value: 10, expiresAtHeight: 900001 }),
            fundingCoin({ vout: 2, value: 10000, expiresAtHeight: 900002 }),
        ];
        const response = await createQuote(
            d,
            quoteBody({ assetId: assetIdToWire(ASSET), senderSats: "330" }),
        );
        expect(advances.get(response.transferId)?.operatorInputs).toEqual([
            { txid: "bb".repeat(32), vout: 0 },
        ]);
        expect(advances.get(response.transferId)?.batchExpiry).toBeUndefined();
    });
    it("reserves the hosting sats an asset fare needs on top of the loan", async () => {
        const d = deps({
            policy: {
                assetRules: [
                    {
                        assetId: ASSET,
                        enabled: true,
                        fares: [
                            {
                                id: "asset",
                                currency: { kind: "sameAsset" },
                                pricing: { kind: "flat", units: 10n },
                            },
                        ],
                        claim: "either",
                        maxTopupSats: null,
                    },
                ],
            },
        });
        d.inventory.getSpendableVtxos = async () => [
            fundingCoin({ value: 330 }),
            fundingCoin({ vout: 1, value: 330 }),
            fundingCoin({ vout: 2, value: 10_500 }),
        ];
        const response = await createQuote(d, quoteBody({ assetId: assetIdToWire(ASSET) }));
        // Two coins, because an asset fare's hosting output is a whole dust unit
        // on top of the loan and neither coin covers both.
        expect(advances.get(response.transferId)?.operatorInputs).toEqual([
            { txid: "bb".repeat(32), vout: 0 },
            { txid: "bb".repeat(32), vout: 1 },
        ]);
    });
    it("uses the millisecond clock for runtime freshness without rounding it down", async () => {
        const d = deps();
        d.nowMs = () => NOW * 1000 + 123;
        d.runtime.safety = () => runtimeSafety({ checkedAt: NOW * 1000 + 123 });
        await expect(createQuote(d, quoteBody())).resolves.toBeDefined();
    });
    it("rechecks intent locks acquired while constructing the quote", async () => {
        const d = deps();
        const build = lockupBuilder.buildUnsigned.bind(lockupBuilder);
        d.lockupBuilder.buildUnsigned = async (request) => {
            const funding = await build(request);
            d.inventory.getLockedVtxoOutpoints = async () => funding.operatorInputs;
            return funding;
        };
        expect((await caught(() => createQuote(d, quoteBody()))).code).toBe("runtime_unsafe");
        expect(advances.rows.size).toBe(0);
    });
    it("requires runtime verification even if the caller omits the gate", async () => {
        const d = deps();
        d.runtime = undefined as never;
        expect((await caught(() => createQuote(d, quoteBody()))).code).toBe("runtime_unsafe");
        expect(advances.rows.size).toBe(0);
    });
    it("refuses stale synchronization and explicit intent-lock read failures", async () => {
        const d = deps();
        d.runtime.safety = () => runtimeSafety({ walletSynced: false });
        expect((await caught(() => createQuote(d, quoteBody()))).code).toBe("runtime_unsafe");
        d.runtime.safety = () => runtimeSafety();
        d.inventory.getLockedVtxoOutpoints = async () => {
            throw new Error("lock read failed");
        };
        expect((await caught(() => createQuote(d, quoteBody()))).code).toBe("runtime_unsafe");
        expect(advances.rows.size).toBe(0);
    });
    it("reserves quoted inputs and never submits externally", async () => {
        const d = deps();
        const response = await createQuote(d, quoteBody());
        expect(d.reservations.listReservedOutpoints()).toEqual(
            advances.get(response.transferId)!.operatorInputs,
        );
        expect((await caught(() => createQuote(d, quoteBody()))).code).toBe(
            "operator_inventory_insufficient",
        );
        expect(lockupBuilder.submitted).toHaveLength(0);
    });
    it("rejects a builder which substitutes an unselected input", async () => {
        const d = deps();
        d.lockupBuilder.buildUnsigned = async () => ({
            unsignedLockupTx: "unsigned",
            unsignedLockupId: "cc".repeat(32),
            operatorInputs: [{ txid: "dd".repeat(32), vout: 0 }],
        });
        expect((await caught(() => createQuote(d, quoteBody()))).code).toBe(
            "funding_snapshot_invalid",
        );
        expect(advances.rows.size).toBe(0);
    });
    it("fails closed when the snapshot becomes stale while the builder is working", async () => {
        const d = deps();
        const build = lockupBuilder.buildUnsigned.bind(lockupBuilder);
        d.lockupBuilder.buildUnsigned = async (request) => {
            const funding = await build(request);
            d.runtime.safety = () => runtimeSafety({ blockers: ["runtime_stale"] });
            return funding;
        };
        expect((await caught(() => createQuote(d, quoteBody()))).code).toBe("runtime_unsafe");
        expect(advances.rows.size).toBe(0);
    });
    it.each(["locking", "recovering"] as const)(
        "counts %s toward deployed exposure",
        async (state) => {
            advances.insert(advance({ id: "deployed", state, topup: 330n }));
            const error = await caught(() =>
                createQuote(deps({ policy: { maxOutstandingSats: 400n } }), quoteBody()),
            );
            expect(error.code).toBe("exceeds_max_outstanding");
        },
    );
    it("surfaces paused as 503 with the reason verbatim", async () => {
        const e = await caught(() => createQuote(deps({ policy: { paused: true } }), quoteBody()));
        expect(e.code).toBe("paused");
        expect(e.status).toBe(503);
        expect(advances.rows.size).toBe(0);
    });

    it("counts locked advances toward the outstanding cap", async () => {
        advances.insert(advance({ id: "locked-1", state: "locked", topup: 330n }));
        const e = await caught(() =>
            createQuote(deps({ policy: { maxOutstandingSats: 400n } }), quoteBody()),
        );
        expect(e.code).toBe("exceeds_max_outstanding");
        expect(e.status).toBe(409);
    });

    it("ignores non-locked advances when computing exposure", async () => {
        advances.insert(advance({ id: "quoted-1", state: "quoted", topup: 330n }));
        await expect(
            createQuote(deps({ policy: { maxOutstandingSats: 400n } }), quoteBody()),
        ).resolves.toBeDefined();
    });

    it("rejects an asset the operator lists no rule for", async () => {
        const e = await caught(() =>
            createQuote(
                deps({ policy: { assetRules: [] } }),
                quoteBody({ assetId: { txid: "11".repeat(32), groupIndex: 0 } }),
            ),
        );
        expect(e.code).toBe("asset_not_served");
    });

    // Bitcoin has its own rule, so listing assets cannot silently stop it.
    it("distinguishes a disabled bitcoin rule from an absent one", async () => {
        const disabled = await caught(() =>
            createQuote(
                deps({
                    policy: {
                        assetRules: [
                            {
                                assetId: null,
                                enabled: false,
                                fares: [],
                                claim: "either",
                                maxTopupSats: null,
                            },
                        ],
                    },
                }),
                quoteBody(),
            ),
        );
        expect(disabled.code).toBe("asset_disabled");

        const absent = await caught(() =>
            createQuote(deps({ policy: { assetRules: [] } }), quoteBody()),
        );
        expect(absent.code).toBe("asset_not_served");
    });

    it("never calls the builder for a refused quote", async () => {
        await caught(() => createQuote(deps({ policy: { paused: true } }), quoteBody()));
        expect(lockupBuilder.built).toHaveLength(0);
    });
});

describe("quote reservation integration", () => {
    it.each(["expired", "missing-reservation"])(
        "never broadcasts after an atomic claim rejects %s",
        (failure) => {
            const db = openDatabase(":memory:");
            return (async () => {
                try {
                    const ledger = new AdvanceRepository(db);
                    const terms = new PolicyRepository(db);
                    terms.update(basePolicy(), "test");
                    const reservations = new ReservationRepository(db);
                    const d: QuoteDeps = {
                        ...deps(),
                        advances: ledger,
                        policy: terms,
                        reservations,
                    };
                    const response = await createQuote(d, quoteBody());
                    d.now = () => NOW + 59;
                    d.reservations = {
                        reserveQuote: (request) => reservations.reserveQuote(request),
                        listReservedOutpoints: () => reservations.listReservedOutpoints(),
                        expireQuotes: (at) => reservations.expireQuotes(at),
                        claimLockup: (id, unsignedTxId, digest, envelope, at) => {
                            if (failure === "expired") reservations.expireQuotes(NOW + 60);
                            else db.prepare("DELETE FROM operator_input_reservations").run();
                            return reservations.claimLockup(id, unsignedTxId, digest, envelope, at);
                        },
                    };
                    await expect(
                        submitLockup(d, response.transferId, "signed"),
                    ).rejects.toMatchObject({
                        code:
                            failure === "expired" ? "quote_expired" : "funding_reservation_invalid",
                        status: 409,
                    });
                    expect(lockupBuilder.submitted).toEqual([]);
                    expect(ledger.get(response.transferId)?.state).toBe(
                        failure === "expired" ? "expired" : "quoted",
                    );
                } finally {
                    db.close();
                }
            })();
        },
    );
    it("preserves claimed reservations during cleanup and queues one exact envelope", async () => {
        const db = openDatabase(":memory:");
        try {
            const ledger = new AdvanceRepository(db);
            const terms = new PolicyRepository(db);
            terms.update(basePolicy(), "test");
            const reservations = new ReservationRepository(db);
            const d = { ...deps(), advances: ledger, policy: terms, reservations };
            const response = await createQuote(d, quoteBody());
            d.now = () => NOW + 59;
            await submitLockup(d, response.transferId, "signed");
            expect(reservations.expireQuotes(NOW + 60)).toBe(0);
            expect(ledger.get(response.transferId)).toMatchObject({
                state: "locking",
                submissionPhase: "claimed",
                signedLockupEnvelope: "signed",
            });
            expect(reservations.listForAdvance(response.transferId)).toEqual([
                { txid: "bb".repeat(32), vout: 0 },
            ]);
            await expect(
                submitLockup(d, response.transferId, "signed-again"),
            ).rejects.toMatchObject({ code: "envelope_conflict" });
            expect(lockupBuilder.submitted).toEqual([]);
        } finally {
            db.close();
        }
    });
    it("does not silently replace builder-bound inputs when another selection remains affordable", async () => {
        const db = openDatabase(":memory:");
        try {
            const ledger = new AdvanceRepository(db);
            const terms = new PolicyRepository(db);
            terms.update(basePolicy(), "test");
            const reservations = new ReservationRepository(db);
            const d = { ...deps(), advances: ledger, policy: terms, reservations };
            let built = false;
            let reads = 0;
            d.inventory.getSpendableVtxos = async () => {
                reads++;
                return [
                    fundingCoin({ value: 1000, isSpent: built }),
                    fundingCoin({ vout: 1, value: 1000, expiresAtHeight: 900001 }),
                    fundingCoin({ vout: 2, value: 10000, expiresAtHeight: 900002 }),
                ];
            };
            const build = lockupBuilder.buildUnsigned.bind(lockupBuilder);
            d.lockupBuilder.buildUnsigned = async (request) => {
                const funding = await build(request);
                built = true;
                return funding;
            };
            await expect(createQuote(d, quoteBody())).rejects.toMatchObject({
                code: "runtime_unsafe",
            });
            expect(reads).toBe(2);
            expect(lockupBuilder.built).toHaveLength(1);
            expect(ledger.byState("quoted")).toEqual([]);
            expect(reservations.listReservedOutpoints()).toEqual([]);
        } finally {
            db.close();
        }
    });
    it.each(["selected", "reserve"])(
        "rereads and refuses a %s coin spent during construction",
        async (spent) => {
            const db = openDatabase(":memory:");
            try {
                const ledger = new AdvanceRepository(db);
                const terms = new PolicyRepository(db);
                terms.update(basePolicy(), "test");
                const reservations = new ReservationRepository(db);
                const d = { ...deps(), advances: ledger, policy: terms, reservations };
                let built = false;
                let reads = 0;
                d.inventory.getSpendableVtxos = async () => {
                    reads++;
                    return [
                        fundingCoin({ value: 1000, isSpent: built && spent === "selected" }),
                        fundingCoin({
                            vout: 1,
                            value: 10000,
                            expiresAtHeight: 900001,
                            isSpent: built && spent === "reserve",
                        }),
                    ];
                };
                const build = lockupBuilder.buildUnsigned.bind(lockupBuilder);
                d.lockupBuilder.buildUnsigned = async (request) => {
                    const funding = await build(request);
                    built = true;
                    return funding;
                };
                await expect(createQuote(d, quoteBody())).rejects.toMatchObject({ status: 503 });
                expect(reads).toBe(2);
                expect(lockupBuilder.built).toHaveLength(1);
                expect(ledger.byState("quoted")).toEqual([]);
                expect(reservations.listReservedOutpoints()).toEqual([]);
            } finally {
                db.close();
            }
        },
    );
    it.each(["submit", "abandoned"])(
        "releases %s expired quote funding using real SQLite",
        async (action) => {
            const db = openDatabase(":memory:");
            try {
                const ledger = new AdvanceRepository(db);
                const terms = new PolicyRepository(db);
                terms.update(basePolicy(), "test");
                const reservations = new ReservationRepository(db);
                const d = { ...deps(), advances: ledger, policy: terms, reservations };
                const response = await createQuote(d, quoteBody());
                d.now = () => NOW + 60;
                if (action === "submit") {
                    await expect(
                        submitLockup(d, response.transferId, "signed"),
                    ).rejects.toMatchObject({ code: "quote_expired" });
                    expect(reservations.listReservedOutpoints()).toEqual([]);
                    await expect(
                        submitLockup(d, response.transferId, "signed"),
                    ).rejects.toMatchObject({ code: "quote_expired" });
                } else {
                    const next = await createQuote(d, quoteBody());
                    expect(reservations.listForAdvance(response.transferId)).toEqual([]);
                    expect(reservations.listForAdvance(next.transferId)).toEqual([
                        { txid: "bb".repeat(32), vout: 0 },
                    ]);
                }
                expect(ledger.get(response.transferId)?.state).toBe("expired");
                expect(lockupBuilder.submitted).toEqual([]);
            } finally {
                db.close();
            }
        },
    );
    it.each([2, 3])(
        "reselects on %s conflicts and stops after three attempts",
        async (conflicts) => {
            const db = openDatabase(":memory:");
            try {
                const ledger = new AdvanceRepository(db);
                const terms = new PolicyRepository(db);
                terms.update(basePolicy(), "test");
                const reservations = new ReservationRepository(db);
                const d: QuoteDeps = {
                    ...deps(),
                    advances: ledger,
                    policy: terms,
                    reservations,
                    inventory: {
                        getSpendableVtxos: async () =>
                            [0, 1, 2, 3, 4].map((vout) =>
                                fundingCoin({
                                    vout,
                                    value: vout === 4 ? 10000 : 1000,
                                    expiresAtHeight: 900000 + vout,
                                }),
                            ),
                        getLockedVtxoOutpoints: async () => [],
                    },
                };
                let attempts = 0;
                d.reservations = {
                    claimLockup: (id, unsignedTxId, digest, envelope, now) =>
                        reservations.claimLockup(id, unsignedTxId, digest, envelope, now),
                    expireQuotes: (at) => reservations.expireQuotes(at),
                    listReservedOutpoints: () => reservations.listReservedOutpoints(),
                    reserveQuote: (request) => {
                        attempts++;
                        if (attempts <= conflicts)
                            reservations.reserveQuote({
                                advance: { ...request.advance, id: `competitor-${attempts}` },
                                expectedPolicyRevision: terms.getSnapshot().revision,
                                recoveryExecutionBudget: request.recoveryExecutionBudget,
                            });
                        reservations.reserveQuote(request);
                    },
                };
                if (conflicts === 2) {
                    const response = await createQuote(d, quoteBody());
                    expect(ledger.get(response.transferId)?.operatorInputs).toEqual([
                        { txid: "bb".repeat(32), vout: 2 },
                    ]);
                    expect(reservations.listForAdvance(response.transferId)).toEqual([
                        { txid: "bb".repeat(32), vout: 2 },
                    ]);
                } else {
                    expect((await caught(() => createQuote(d, quoteBody()))).code).toBe(
                        "reservation_conflict",
                    );
                    expect(
                        ledger
                            .byState("quoted")
                            .map((a) => a.id)
                            .sort(),
                    ).toEqual(["competitor-1", "competitor-2", "competitor-3"]);
                }
                expect(attempts).toBe(3);
                expect(lockupBuilder.built).toHaveLength(3);
                expect(lockupBuilder.submitted).toHaveLength(0);
            } finally {
                db.close();
            }
        },
    );
    it("does not retry a policy revision change during construction", async () => {
        const db = openDatabase(":memory:");
        try {
            const terms = new PolicyRepository(db);
            terms.update(basePolicy(), "test");
            const ledger = new AdvanceRepository(db);
            const reservations = new ReservationRepository(db);
            const d = { ...deps(), policy: terms, advances: ledger, reservations };
            const build = lockupBuilder.buildUnsigned.bind(lockupBuilder);
            d.lockupBuilder.buildUnsigned = async (request) => {
                const funding = await build(request);
                terms.update({ paused: true }, "operator");
                return funding;
            };
            await expect(createQuote(d, quoteBody())).rejects.toMatchObject({
                code: "policy_changed",
                message: expect.stringMatching(/policy.*changed/),
            });
            expect(lockupBuilder.built).toHaveLength(1);
            expect(reservations.listReservedOutpoints()).toEqual([]);
            expect(ledger.byState("quoted")).toEqual([]);
        } finally {
            db.close();
        }
    });
});

describe("createQuote request validation", () => {
    it("rejects recovery ownership on the generic sender quote endpoint", async () => {
        const body = quoteBody() as Record<string, unknown>;
        body.recoveryRecipient = "receiver";
        await expect(createQuote(deps(), body)).rejects.toMatchObject({
            code: "invalid_request",
            status: 400,
        });
        expect(advances.rows.size).toBe(0);
    });

    it.each(["missing", "duplicate", "sum"])(
        "rejects %s sender funding before admission",
        async (kind) => {
            const body = quoteBody() as Record<string, any>;
            if (kind === "missing") delete body.senderInputs;
            if (kind === "duplicate")
                body.senderInputs = [
                    {
                        txid: "aa".repeat(32),
                        vout: 0,
                        value: "0",
                        tapTree: "00",
                        spendLeaf: "51",
                        expiry: { kind: "height", value: "910000" },
                    },
                    {
                        txid: "aa".repeat(32),
                        vout: 0,
                        value: "0",
                        tapTree: "00",
                        spendLeaf: "51",
                        expiry: { kind: "height", value: "910000" },
                    },
                ];
            if (kind === "sum") {
                body.senderInputs = [
                    {
                        txid: "aa".repeat(32),
                        vout: 0,
                        value: "100",
                        tapTree: "00",
                        spendLeaf: "51",
                        expiry: { kind: "height", value: "910000" },
                    },
                ];
            }
            await expect(createQuote(deps(), body)).rejects.toMatchObject({
                code: "invalid_request",
                status: 400,
            });
            expect(advances.rows.size).toBe(0);
        },
    );
    it.each([
        ["non-hex key", quoteBody({ receiverKey: "zz".repeat(32) })],
        ["missing key", quoteBody({ senderKey: undefined })],
        ["negative sats", quoteBody({ senderSats: "-5" })],
        ["sats as a number", quoteBody({ senderSats: 100 })],
    ])("rejects a %s with 400", async (_label, body) => {
        const e = await caught(() => createQuote(deps(), body));
        expect(e.status).toBe(400);
        expect(e.code).toBe("invalid_request");
    });

    it("rejects a body that is not an object", async () => {
        const e = await caught(() => createQuote(deps(), null as never));
        expect(e.status).toBe(400);
    });

    it("rejects a key that is not 32 bytes with 400, not 500", async () => {
        const e = await caught(() =>
            createQuote(deps(), quoteBody({ receiverKey: "11".repeat(31) })),
        );
        expect(e.status).toBe(400);
        expect(e.message).toMatch(/32 bytes/);
    });

    it("rejects receiver and sender being the same key with 400", async () => {
        const e = await caught(() =>
            createQuote(deps(), quoteBody({ senderKey: bytesToHex(receiverKey) })),
        );
        expect(e.status).toBe(400);
        expect(e.code).toBe("invalid_request");
    });
});

describe("submitLockup", () => {
    it("rejects an unsigned sender envelope before mutating the quote", async () => {
        const response = await createQuote(deps(), quoteBody());
        const d = deps();
        let admissionCalls = 0;
        const withAdmission = d.runtime.withAdmission;
        d.runtime.withAdmission = async (work) => {
            admissionCalls += 1;
            return withAdmission(work);
        };

        await expect(
            submitLockup(d, response.transferId, response.unsignedLockupTx),
        ).rejects.toMatchObject({ code: "invalid_lockup_signature", status: 400 });
        expect(admissionCalls).toBe(0);
        expect(advances.get(response.transferId)?.state).toBe("quoted");
        expect(lockupBuilder.submitted).toEqual([]);
    });

    it("returns the current locking result for an exact duplicate envelope", async () => {
        const response = await createQuote(deps(), quoteBody());
        const signed = await signedEnvelope(response.unsignedLockupTx);

        const first = await submitLockup(deps(), response.transferId, signed);
        const duplicateDeps = deps();
        duplicateDeps.runtime.withAdmission = async () => {
            throw new Error("runtime offline");
        };
        const duplicate = await submitLockup(duplicateDeps, response.transferId, signed);

        expect(duplicate).toEqual(first);
        await expect(
            submitLockup(duplicateDeps, response.transferId, signed, () => {
                throw new Error("service not ready");
            }),
        ).rejects.toThrow("service not ready");
        expect(lockupBuilder.submitted).toEqual([]);
    });

    const quoted = async () => (await createQuote(deps(), quoteBody())).transferId;

    it("prompts only after the durable claim and admission lock release without awaiting work", async () => {
        const id = await quoted();
        const d = deps();
        let admitting = false;
        const admission = d.runtime.withAdmission;
        d.runtime.withAdmission = async (work) => {
            admitting = true;
            try {
                return await admission(work);
            } finally {
                admitting = false;
            }
        };
        const prompt = vi.fn(async (claimedId: string) => {
            expect(admitting).toBe(false);
            expect(advances.get(claimedId)).toMatchObject({
                state: "locking",
                submissionPhase: "claimed",
            });
            await new Promise<void>(() => {});
        });
        d.onLockupClaimed = prompt;
        await expect(submitLockup(d, id, "signed-psbt")).resolves.toBeDefined();
        expect(prompt).toHaveBeenCalledExactlyOnceWith(id);
        await submitLockup(d, id, "signed-psbt");
        expect(prompt).toHaveBeenCalledTimes(1);
    });

    it.each(["throw", "reject"])(
        "keeps a durable accepted claim when its prompt %ss",
        async (failure) => {
            const id = await quoted();
            const d = deps();
            d.onLockupClaimed = vi.fn(() => {
                if (failure === "throw") throw new Error("wake failed");
                return Promise.reject(new Error("wake failed"));
            });
            await expect(submitLockup(d, id, "signed-psbt")).resolves.toBeDefined();
            expect(d.onLockupClaimed).toHaveBeenCalledWith(id);
            expect(advances.get(id)?.state).toBe("locking");
        },
    );

    it("never prompts when persisting the submission fails", async () => {
        const id = await quoted();
        const d = deps();
        d.onLockupClaimed = vi.fn();
        advances.failUpdateAt = 1;
        await expect(submitLockup(d, id, "signed-psbt")).rejects.toThrow("db write failed");
        expect(d.onLockupClaimed).not.toHaveBeenCalled();
    });

    it("persists the exact submission intent without an inline network effect", async () => {
        const id = await quoted();
        const d = deps();
        const submit = vi.fn(lockupBuilder.submit.bind(lockupBuilder));
        d.lockupSubmitter.submit = submit;
        await submitLockup(d, id, "signed-psbt");
        expect(advances.get(id)).toMatchObject({
            state: "locking",
            submissionPhase: "claimed",
            submissionKey: `lockup:${id}:${lockupBuilder.unsignedId}`,
            signedLockupEnvelope: "signed-psbt",
            submittedAt: NOW,
            unsignedLockupTx: lockupBuilder.unsignedTx,
        });
        expect(submit).not.toHaveBeenCalled();
    });

    it("does not attempt submission when the intent write fails", async () => {
        const id = await quoted();
        advances.failUpdateAt = 1;
        await expect(submitLockup(deps(), id, "signed-psbt")).rejects.toThrow("db write failed");
        expect(advances.get(id)!.state).toBe("quoted");
        expect(lockupBuilder.submitted).toEqual([]);
    });

    it("keeps queued lockups locking until the background worker advances them", async () => {
        const id = await quoted();
        const res = await submitLockup(deps(), id, "signed-psbt");

        expect(res).toEqual({
            txid: lockupBuilder.outpoint.txid,
            outpoint: lockupBuilder.outpoint,
        });
        const stored = advances.get(id)!;
        expect(stored.state).toBe("locking");
        expect(stored.arkTxid).toBeUndefined();
        expect(stored.submissionPhase).toBe("claimed");
        expect(stored.submittedAt).toBe(NOW);
        expect(stored.submissionKey).toBeDefined();
        expect(stored.outpoint).toBeUndefined();
        expect(lockupBuilder.submitted).toEqual([]);
    });

    it("does not expose inline provider failures because POST only queues", async () => {
        const id = await quoted();
        lockupBuilder.failSubmit = new Error("arkd refused the transaction");

        await expect(submitLockup(deps(), id, "signed-psbt")).resolves.toBeDefined();
        expect(advances.get(id)!.state).toBe("locking");
        expect(advances.get(id)!.failureCode).toBeUndefined();
        expect(lockupBuilder.submitted).toEqual([]);
    });

    it("does not submit duplicate POSTs and rejects any different envelope", async () => {
        const id = await quoted();
        const first = await submitLockup(deps(), id, "psbt-1");

        await expect(submitLockup(deps(), id, "psbt-1")).resolves.toEqual(first);
        await expect(submitLockup(deps(), id, "psbt-2")).rejects.toMatchObject({
            code: "envelope_conflict",
        });
        expect(advances.get(id)!.state).toBe("locking");
        expect(lockupBuilder.submitted).toEqual([]);
    });

    it("404s an unknown transfer", async () => {
        const e = await caught(() => submitLockup(deps(), "nope", "psbt"));
        expect(e.status).toBe(404);
        expect(e.code).toBe("not_found");
    });

    it("replays a matching transfer that is already locking", async () => {
        const id = await quoted();
        const first = await submitLockup(deps(), id, "psbt");

        await expect(submitLockup(deps(), id, "psbt")).resolves.toEqual(first);
        expect(advances.get(id)!.state).toBe("locking");
    });

    it("expires a stale quote rather than locking it", async () => {
        const id = await quoted();
        const late = { ...deps(), now: () => NOW + 61 };

        const e = await caught(() => submitLockup(late, id, "psbt"));
        expect(e.code).toBe("quote_expired");
        expect(e.status).toBe(409);
        expect(advances.get(id)!.state).toBe("expired");
        expect(lockupBuilder.submitted).toHaveLength(0);
    });
});

describe("getTransfer", () => {
    it("reports the current ledger state", async () => {
        const id = (await createQuote(deps(), quoteBody())).transferId;
        expect(getTransfer(deps(), id)).toEqual({
            transferId: id,
            state: "quoted",
            updatedAt: NOW,
        });
    });

    it("includes the outpoint once locked", async () => {
        const id = (await createQuote(deps(), quoteBody())).transferId;
        await submitLockup(deps(), id, "psbt");
        advances.update({
            ...advances.get(id)!,
            state: "locked",
            outpoint: lockupBuilder.outpoint,
            lastObservedAt: NOW + 1,
            updatedAt: NOW + 1,
        });
        expect(getTransfer(deps(), id).outpoint).toEqual(lockupBuilder.outpoint);
    });

    it("exposes an actionable quarantined submission status", async () => {
        const id = (await createQuote(deps(), quoteBody())).transferId;
        advances.update({
            ...advances.get(id)!,
            state: "locking",
            submissionPhase: "failed",
            failureCode: "lockup_submission_invalid_provider_response",
            failureDetail: "server changed checkpoint metadata",
        });

        expect(getTransfer(deps(), id)).toMatchObject({
            submissionPhase: "failed",
            failureCode: "lockup_submission_invalid_provider_response",
            failureDetail: "server changed checkpoint metadata",
        });
    });

    it("404s an unknown transfer", async () => {
        await expect(async () => getTransfer(deps(), "nope")).rejects.toThrow(/not found/i);
    });
});

describe("quote phase diagnostics", () => {
    const diagnosticDeps = () => {
        const ledger = new MemoryAdvances();
        const cfg = config({ reconcileIntervalMs: 5000 });
        const d: QuoteDeps = {
            ...deps(),
            ...quoteInfrastructure(ledger, () => basePolicy({ locktimeMarginBlocks: MARGIN })),
            advances: ledger,
            config: cfg,
            randomId: () => "diagnostic-fixture",
            lockupBuilder: new ProductionLockupBuilder(cfg, () => serverUnroll),
        };
        return { d, ledger };
    };
    it("observes actual production subphases using only bounded safe fields", async () => {
        const { d } = diagnosticDeps();
        const rows: QuotePhaseFields[] = [];
        d.phaseLogger = {
            debug: (fields) => {
                rows.push(fields);
            },
        };
        await createQuote(d, quoteBody());
        const starts = rows.filter((row) => row.outcome === "start").map((row) => row.phase);
        expect(starts).toEqual([
            "quote.total",
            "quote.admission",
            "quote.initial-guard",
            "quote.attempt-guard",
            "quote.inventory.first",
            "quote.locks.first",
            "quote.sender.first",
            "quote.selection.first",
            "quote.covenant",
            "quote.builder",
            "quote.graph.build",
            "quote.graph.self-parse",
            "quote.outer-parse",
            "quote.sender.second",
            "quote.after-sender-snapshot",
            "quote.inventory.second",
            "quote.locks.second",
            "quote.selection.second",
            "quote.final-guard",
            "quote.persist",
        ]);
        expect(rows.filter((row) => row.outcome === "ok")).toHaveLength(starts.length);
        expect(rows).toHaveLength(40);
        expect(new Set(rows.map((row) => row.quoteSequence)).size).toBe(1);
        expect(rows.map((row) => row.sequence)).toEqual(rows.map((_, index) => index + 1));
        for (const row of rows) {
            expect(Number.isSafeInteger(row.quoteSequence) && row.quoteSequence > 0).toBe(true);
            expect(Number.isFinite(row.elapsedMs) && row.elapsedMs >= 0).toBe(true);
            expect(
                Object.keys(row).every((key) =>
                    [
                        "quoteSequence",
                        "sequence",
                        "attempt",
                        "phase",
                        "outcome",
                        "elapsedMs",
                        "sampledOriginalSnapshotAgeMs",
                        "snapshotAgeSampleElapsedMs",
                    ].includes(key),
                ),
            ).toBe(true);
        }
        expect(
            rows.find((row) => row.phase === "quote.final-guard" && row.outcome === "ok")
                ?.sampledOriginalSnapshotAgeMs,
        ).toBe(0);
    });
    it("contains logging failure without changing clocks, guards, funding calls or bytes", async () => {
        const run = async (enabled: boolean) => {
            const { d, ledger } = diagnosticDeps();
            const calls: string[] = [];
            const safety = d.runtime.safety;
            d.runtime.safety = () => {
                calls.push("safety");
                return safety();
            };
            d.nowMs = () => {
                calls.push("nowMs");
                return NOW * 1000;
            };
            d.now = () => {
                calls.push("now");
                return NOW;
            };
            const sender = d.senderInventory.getVtxos.bind(d.senderInventory);
            d.senderInventory.getVtxos = (input) => {
                calls.push("sender");
                return sender(input);
            };
            const inventory = d.inventory.getSpendableVtxos.bind(d.inventory);
            d.inventory.getSpendableVtxos = () => {
                calls.push("inventory");
                return inventory();
            };
            const locks = d.inventory.getLockedVtxoOutpoints.bind(d.inventory);
            d.inventory.getLockedVtxoOutpoints = () => {
                calls.push("locks");
                return locks();
            };
            const reserve = d.reservations.reserveQuote.bind(d.reservations);
            d.reservations.reserveQuote = (input) => {
                calls.push("persist");
                return reserve(input);
            };
            if (enabled)
                d.phaseLogger = {
                    debug: () => {
                        throw new Error("logger failed");
                    },
                };
            const response = await createQuote(d, quoteBody(), () => {
                calls.push("ready");
            });
            return { response, calls, advance: ledger.get(response.transferId) };
        };
        const baseline = await run(false);
        const observed = await run(true);
        expect(observed).toEqual(baseline);
        expect(observed.calls.filter((call) => call === "sender")).toHaveLength(2);
        expect(observed.calls.filter((call) => call === "inventory")).toHaveLength(2);
        expect(observed.calls.filter((call) => call === "locks")).toHaveLength(2);
        expect(observed.calls.filter((call) => call === "persist")).toHaveLength(1);
    });
    it("keeps the second sender barrier and refuses expired safety before persistence", async () => {
        const { d, ledger } = diagnosticDeps();
        const rows: QuotePhaseFields[] = [];
        d.phaseLogger = {
            debug: (fields) => {
                rows.push(fields);
            },
        };
        let nowMs = NOW * 1000;
        d.nowMs = () => nowMs;
        const read = d.senderInventory.getVtxos.bind(d.senderInventory);
        let reads = 0;
        let release!: () => void;
        let started!: () => void;
        const pause = new Promise<void>((resolve) => {
            release = resolve;
        });
        const pending = new Promise<void>((resolve) => {
            started = resolve;
        });
        d.senderInventory.getVtxos = async (input) => {
            const result = await read(input);
            if (++reads === 2) {
                started();
                await pause;
            }
            return result;
        };
        const quote = createQuote(d, quoteBody());
        await pending;
        expect(ledger.rows.size).toBe(0);
        nowMs += d.config.reconcileIntervalMs + 1;
        release();
        await expect(quote).rejects.toMatchObject({ code: "runtime_unsafe" });
        expect(reads).toBe(2);
        expect(ledger.rows.size).toBe(0);
        expect(d.reservations.listReservedOutpoints()).toEqual([]);
        expect(
            rows.find((row) => row.phase === "quote.selection.second" && row.outcome === "error"),
        ).toMatchObject({ sampledOriginalSnapshotAgeMs: 5001 });
        expect(rows.some((row) => row.phase === "quote.persist")).toBe(false);
    });
    it("caps rows and discards nonallowlisted phases from a builder observer", async () => {
        const { d } = diagnosticDeps();
        const rows: QuotePhaseFields[] = [];
        d.phaseLogger = {
            debug: (fields) => {
                rows.push(fields);
            },
        };
        const builder = d.lockupBuilder;
        d.lockupBuilder = {
            buildUnsigned: (request, observe) => {
                for (let index = 0; index < 300; index++) {
                    observe?.("untrusted-private-phase" as never, "start");
                    observe?.("quote.graph.build", "start");
                    observe?.("quote.graph.build", "ok");
                }
                return builder.buildUnsigned(request, observe);
            },
        };
        await createQuote(d, quoteBody());
        expect(rows).toHaveLength(128);
        expect(JSON.stringify(rows)).not.toContain("untrusted-private-phase");
    });
    it("preserves a rejected funding cause while emitting only fixed outcomes", async () => {
        const { d, ledger } = diagnosticDeps();
        const rows: QuotePhaseFields[] = [];
        d.phaseLogger = {
            debug: (fields) => {
                rows.push(fields);
            },
        };
        const original = new Error("private-provider-error");
        d.senderInventory.getVtxos = () => Promise.reject(original);
        const failure = await caught(() => createQuote(d, quoteBody()));
        expect(failure).toMatchObject({ code: "runtime_unsafe", cause: original });
        expect(failure.cause).toBe(original);
        expect(
            rows.some((row) => row.phase === "quote.sender.first" && row.outcome === "error"),
        ).toBe(true);
        expect(rows.some((row) => row.phase === "quote.total" && row.outcome === "error")).toBe(
            true,
        );
        expect(JSON.stringify(rows)).not.toContain(original.message);
        expect(ledger.rows.size).toBe(0);
    });
    it("keeps concurrent request sequences and phase rows separate", async () => {
        const left = diagnosticDeps();
        const right = diagnosticDeps();
        const rows: QuotePhaseFields[] = [];
        const logger = {
            debug: (fields: QuotePhaseFields) => {
                rows.push(fields);
            },
        };
        left.d.phaseLogger = logger;
        right.d.phaseLogger = logger;
        await Promise.all([createQuote(left.d, quoteBody()), createQuote(right.d, quoteBody())]);
        const sequences = [...new Set(rows.map((row) => row.quoteSequence))];
        expect(sequences).toHaveLength(2);
        for (const sequence of sequences) {
            const requestRows = rows.filter((row) => row.quoteSequence === sequence);
            expect(requestRows).toHaveLength(40);
            expect(requestRows.map((row) => row.sequence)).toEqual(
                requestRows.map((_, index) => index + 1),
            );
            expect(requestRows.at(-1)).toMatchObject({
                phase: "quote.total",
                outcome: "ok",
                attempt: 1,
            });
        }
    });
    it("keeps exactly three reservation attempts with bounded failure rows", async () => {
        const { d, ledger } = diagnosticDeps();
        const rows: QuotePhaseFields[] = [];
        d.phaseLogger = {
            debug: (fields) => {
                rows.push(fields);
            },
        };
        const reserve = d.reservations.reserveQuote.bind(d.reservations);
        let attempts = 0;
        d.reservations.reserveQuote = (input) => {
            if (++attempts < 3) throw new ReservationConflictError();
            return reserve(input);
        };
        await createQuote(d, quoteBody());
        expect(attempts).toBe(3);
        expect(ledger.rows.size).toBe(1);
        expect(rows.length).toBeLessThanOrEqual(128);
        expect(
            rows
                .filter((row) => row.phase === "quote.persist" && row.outcome === "error")
                .map((row) => row.attempt),
        ).toEqual([1, 2]);
        expect(rows.at(-1)).toMatchObject({ phase: "quote.total", outcome: "ok", attempt: 3 });
    });
});
