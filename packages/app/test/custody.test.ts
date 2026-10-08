import { beforeEach, describe, expect, it, vi } from "vitest";
import {
    buildOffchainTx,
    CSVMultisigTapscript,
    MultisigTapscript,
    SingleKey,
    Transaction,
    VtxoScript,
} from "@arkade-os/sdk";
import { schnorr } from "@noble/curves/secp256k1.js";
import { base64 } from "@scure/base";
import type { JointGraph } from "@arkade-taxi/client";
import type { Advance, Outpoint } from "@arkade-taxi/core";
import { AdvanceRepository, CustodyRepository, openDatabase, type Database } from "@arkade-taxi/db";
import {
    assertCustodyReleaseAuthorised,
    createCustodyReleaser,
    custodySolvencyView,
    CustodyAwaitingLiquidityError,
    CustodyReleaseError,
    planCustodyRelease,
} from "../src/custody.js";
import { swapAssetId } from "../src/proceeds.js";

const WINDOW = 8_640_000;
const INT64_MAX = 9_223_372_036_854_775_807n;
const V2_DEADLINE = 1_757_000_000n + 8_640_000n;
const RECLAIM = "12".repeat(32);
const TIP = { hash: "34".repeat(32), height: 700_000 };
const HELD_AT = 1_757_001_000;
const DUE = HELD_AT + WINDOW;
const DUST = 330n;

const OWNER_SEED = new Uint8Array(32).fill(21);
const SERVER_SEED = new Uint8Array(32).fill(22);
const STRANGER_SEED = new Uint8Array(32).fill(23);
const ownerX = schnorr.getPublicKey(OWNER_SEED);
const serverX = schnorr.getPublicKey(SERVER_SEED);
const ASSET = { txid: new Uint8Array(32).fill(9), groupIndex: 0 };

const tree = new VtxoScript([MultisigTapscript.encode({ pubkeys: [ownerX, serverX] }).script]);
const unroll = CSVMultisigTapscript.encode({
    timelock: { type: "blocks", value: 10n },
    pubkeys: [serverX],
});
const coin = (txid: string, value: number) => ({
    txid,
    vout: 0,
    value,
    tapLeafScript: tree.leaves[0],
    tapTree: tree.encode(),
});

const TAXI_COIN = { txid: "a1".repeat(32), vout: 0 };
const OWNER_COIN_SATS = 600n;

/** Taxi inputs first, the owner's last — the shape the authoriser pins. */
const releaseGraph = async (
    seed: Uint8Array | null,
    outputs = [
        { script: new Uint8Array([0x51, 0x20, ...new Uint8Array(32).fill(0xc3)]), amount: 330n },
        { script: new Uint8Array([0x51, 0x20, ...ownerX]), amount: 1_600n },
    ],
): Promise<JointGraph> => {
    const { arkTx, checkpoints } = buildOffchainTx(
        [coin(TAXI_COIN.txid, 1_330), coin("bb".repeat(32), Number(OWNER_COIN_SATS))],
        outputs,
        unroll,
    );
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
        inputOwners: ["taxi", "owner"],
    };
};

function advance(overrides: Partial<Advance> = {}): Advance {
    const result: Advance = {
        id: "adv-1",
        state: "locked",
        receiverKey: ownerX,
        senderKey: new Uint8Array(32).fill(0xb2),
        operatorKey: new Uint8Array(32).fill(0xc3),
        operatorSignerKey: new Uint8Array(32).fill(0xd4),
        exitDelay: { value: 5n, type: "blocks" },
        dust: DUST,
        topup: 330n,
        paymentSats: 1_000n,
        assetId: ASSET,
        assetUnits: 7n,
        receiverFare: { currency: "asset", units: 2n },
        covenantVersion: 2,
        // A v2 advance keeps no batch expiry; its CLTV is wall-clock.
        locktime: V2_DEADLINE,
        recoveryLocktime: { kind: "time", value: V2_DEADLINE },
        operatorInputs: [{ txid: "ab".repeat(32), vout: 7 }],
        unsignedLockupTx: "unsigned-lockup",
        unsignedLockupId: "cd".repeat(32),
        covenantAddress: "tark1qcovenantexample",
        fare: { currency: "sats", units: 25n },
        outpoint: { txid: "ef".repeat(32), vout: 0 },
        createdAt: 1_757_000_000,
        updatedAt: 1_757_000_001,
        expiresAt: 1_757_000_600,
        ...overrides,
    };
    result.recoveryLocktime ??= {
        kind: result.batchExpiry?.kind ?? "time",
        value: result.locktime,
    };
    return result;
}

let db: Database;
let advances: AdvanceRepository;
let custody: CustodyRepository;

const reclaim = (overrides: Partial<Advance> = {}) => {
    const row = advance(overrides);
    advances.insert(row);
    expect(
        advances.recordSpendObservation(row.id, "locked", "recovered", RECLAIM, HELD_AT, TIP),
    ).toBe("recorded");
};

beforeEach(() => {
    db = openDatabase(":memory:");
    advances = new AdvanceRepository(db, { custodyWindowSeconds: WINDOW });
    custody = new CustodyRepository(db);
});

describe("planCustodyRelease", () => {
    beforeEach(() => reclaim());
    const plan = (over: Partial<Parameters<typeof planCustodyRelease>[0]> = {}) =>
        planCustodyRelease({
            row: custody.get("adv-1")!,
            ownerCoinSats: OWNER_COIN_SATS,
            dust: DUST,
            vtxoMinAmount: DUST,
            ...over,
        });

    it("pays the owner what is owed beside their own coin, and keeps the asset fare", () => {
        expect(plan()).toMatchObject({
            netSats: 1_000n,
            netUnits: 5n,
            assetFare: 2n,
            ownerAmount: OWNER_COIN_SATS + 1_000n,
            neededSats: 0n,
            ownerScript: new Uint8Array([0x51, 0x20, ...ownerX]),
        });
    });

    // The reclaim already repaid the loan, so a release never re-charges it.
    it("does not re-charge the loan the reclaim already repaid", () => {
        expect(custody.get("adv-1")?.loanSats).toBe(330n);
        expect(plan().netSats).toBe(custody.get("adv-1")!.owedSats);
    });

    it("funds the net plus dust, so a change output always exists", () => {
        expect(plan().fundingSats).toBe(1_000n + DUST);
    });

    it("takes a sats fare out of what is owed", () => {
        const row = { ...custody.get("adv-1")!, fare: { currency: "sats", units: 40n } as const };
        expect(plan({ row })).toMatchObject({ netSats: 960n, assetFare: 0n, netUnits: 7n });
    });

    it("refuses a fare larger than the debt", () => {
        const row = {
            ...custody.get("adv-1")!,
            fare: { currency: "sats", units: 2_000n } as const,
        };
        expect(() => plan({ row })).toThrow(/custody_fare_exceeds_owed/);
        const units = { ...custody.get("adv-1")!, fare: { currency: "asset", units: 9n } as const };
        expect(() => plan({ row: units })).toThrow(/custody_fare_exceeds_owed/);
    });

    it("refuses an owner output below dust and says what to bring", () => {
        const thin = { ...custody.get("adv-1")!, owedSats: 100n };
        expect(() => plan({ row: thin, ownerCoinSats: 0n })).toThrow(/custody_change_below_dust/);
        expect(plan({ row: thin, ownerCoinSats: 500n }).neededSats).toBe(230n);
    });
});

describe("assertCustodyReleaseAuthorised", () => {
    it("accepts a graph the owner really signed", async () => {
        const trusted = await releaseGraph(null);
        const signed = await releaseGraph(OWNER_SEED);
        expect(() =>
            assertCustodyReleaseAuthorised({ signed, trusted, ownerKey: ownerX }),
        ).not.toThrow();
    });

    it("refuses a release the owner did not sign", async () => {
        const trusted = await releaseGraph(null);
        expect(() =>
            assertCustodyReleaseAuthorised({ signed: trusted, trusted, ownerKey: ownerX }),
        ).toThrow(/custody_owner_unsigned/);
    });

    it("refuses a signature attributed to a key that is not the owner", async () => {
        const trusted = await releaseGraph(null);
        const signed = await releaseGraph(OWNER_SEED);
        const tx = Transaction.fromPSBT(base64.decode(signed.arkTx));
        const [[meta, sig]] = tx.getInput(1).tapScriptSig!;
        tx.updateInput(1, { tapScriptSig: undefined });
        tx.updateInput(1, {
            tapScriptSig: [[{ ...meta, pubKey: schnorr.getPublicKey(STRANGER_SEED) }, sig]],
        });
        expect(() =>
            assertCustodyReleaseAuthorised({
                signed: { ...signed, arkTx: base64.encode(tx.toPSBT()) },
                trusted,
                ownerKey: ownerX,
            }),
        ).toThrow(/custody_owner_unsigned/);
    });

    it("refuses an owner signature whose bytes do not verify", async () => {
        const trusted = await releaseGraph(null);
        const signed = await releaseGraph(OWNER_SEED);
        const tx = Transaction.fromPSBT(base64.decode(signed.arkTx));
        const [[meta, sig]] = tx.getInput(1).tapScriptSig!;
        const bad = new Uint8Array(sig);
        bad[10] ^= 0xff;
        tx.updateInput(1, { tapScriptSig: undefined });
        tx.updateInput(1, { tapScriptSig: [[meta, bad]] });
        expect(() =>
            assertCustodyReleaseAuthorised({
                signed: { ...signed, arkTx: base64.encode(tx.toPSBT()) },
                trusted,
                ownerKey: ownerX,
            }),
        ).toThrow(/custody_owner_unsigned/);
    });

    it("refuses a signed graph whose outputs differ from the one the Taxi built", async () => {
        const trusted = await releaseGraph(null);
        const signed = await releaseGraph(OWNER_SEED, [
            {
                script: new Uint8Array([0x51, 0x20, ...new Uint8Array(32).fill(0xc3)]),
                amount: 330n,
            },
            { script: new Uint8Array([0x51, 0x20, ...ownerX]), amount: 1_599n },
        ]);
        expect(() => assertCustodyReleaseAuthorised({ signed, trusted, ownerKey: ownerX })).toThrow(
            /custody_graph_mismatch/,
        );
    });
});

describe("the releaser", () => {
    const txidOf = (graph: JointGraph) => Transaction.fromPSBT(base64.decode(graph.arkTx)).id;

    const releaser = (
        over: {
            select?: (requiredSats: bigint) => readonly Outpoint[];
            submit?: (graph: JointGraph) => Promise<string>;
            now?: () => number;
            trusted?: JointGraph;
        } = {},
    ) =>
        createCustodyReleaser({
            custody,
            dust: DUST,
            vtxoMinAmount: DUST,
            selectFunding: over.select ?? (() => [TAXI_COIN]),
            build: async () => over.trusted ?? (await releaseGraph(null)),
            submit: over.submit ?? (async (g) => txidOf(g)),
            now: over.now ?? (() => HELD_AT + 10),
            workerId: "worker-1",
            leaseSeconds: 60,
        });

    it("claims the row, then selects coins, and binds what the graph spends", async () => {
        reclaim();
        const order: string[] = [];
        const release = releaser({
            select: (sats) => {
                order.push(`select:${sats}:${custody.get("adv-1")?.state}`);
                return [TAXI_COIN];
            },
        });
        const prepared = await release.prepare({
            advanceId: "adv-1",
            ownerCoinSats: OWNER_COIN_SATS,
        });
        // Probe while still `held`, then the authoritative pass once claimed.
        expect(order).toEqual([`select:1330:held`, `select:1330:releasing`]);
        expect(prepared.inputs).toEqual([TAXI_COIN]);
        expect(custody.get("adv-1")).toMatchObject({
            state: "releasing",
            releaseExpectedTxid: txidOf(prepared.trusted),
            releaseInputs: [TAXI_COIN],
        });
        expect(custody.listHeldOutpoints()).toEqual([TAXI_COIN]);
    });

    it("leaves the row held when liquidity is short, and says retry", async () => {
        reclaim();
        const select = vi.fn(() => {
            throw new Error("operator_inventory_insufficient");
        });
        const release = releaser({ select });
        await expect(
            release.prepare({ advanceId: "adv-1", ownerCoinSats: OWNER_COIN_SATS }),
        ).rejects.toThrow(CustodyAwaitingLiquidityError);
        expect(custody.get("adv-1")?.state).toBe("held");
        expect(select).toHaveBeenCalledTimes(1);
        expect(release.waiting()).toEqual([{ advanceId: "adv-1", since: HELD_AT + 10 }]);
    });

    it("returns the row to held when the authoritative selection races away", async () => {
        reclaim();
        let calls = 0;
        const release = releaser({
            select: () => {
                if (++calls === 2) throw new Error("raced");
                return [TAXI_COIN];
            },
        });
        await expect(
            release.prepare({ advanceId: "adv-1", ownerCoinSats: OWNER_COIN_SATS }),
        ).rejects.toThrow(/custody_release_awaiting_liquidity/);
        expect(custody.get("adv-1")?.state).toBe("held");
    });

    it("pays out once and records the chain txid", async () => {
        reclaim();
        const trusted = await releaseGraph(null);
        const signed = await releaseGraph(OWNER_SEED);
        const submit = vi.fn(async () => txidOf(trusted));
        const release = releaser({ trusted, submit });
        await release.prepare({ advanceId: "adv-1", ownerCoinSats: OWNER_COIN_SATS });
        expect(await release.complete({ advanceId: "adv-1", trusted, signed })).toEqual({
            txid: txidOf(trusted),
        });
        expect(custody.get("adv-1")).toMatchObject({
            state: "released",
            releaseTxid: txidOf(trusted),
            releaseInputs: [],
        });
        expect(submit).toHaveBeenCalledTimes(1);
    });

    it("refuses a second release through the compare-and-set", async () => {
        reclaim();
        const release = releaser();
        await release.prepare({ advanceId: "adv-1", ownerCoinSats: OWNER_COIN_SATS });
        await expect(
            release.prepare({ advanceId: "adv-1", ownerCoinSats: OWNER_COIN_SATS }),
        ).rejects.toThrow(/custody_release_in_progress/);
    });

    it("never submits a graph the owner did not sign", async () => {
        reclaim();
        const trusted = await releaseGraph(null);
        const submit = vi.fn(async () => txidOf(trusted));
        const release = releaser({ trusted, submit });
        await release.prepare({ advanceId: "adv-1", ownerCoinSats: OWNER_COIN_SATS });
        await expect(
            release.complete({ advanceId: "adv-1", trusted, signed: trusted }),
        ).rejects.toThrow(/custody_owner_unsigned/);
        expect(submit).not.toHaveBeenCalled();
    });

    it("refuses a graph the row never committed to", async () => {
        reclaim();
        const trusted = await releaseGraph(null);
        const release = releaser({ trusted });
        await release.prepare({ advanceId: "adv-1", ownerCoinSats: OWNER_COIN_SATS });
        const other = await releaseGraph(null, [
            {
                script: new Uint8Array([0x51, 0x20, ...new Uint8Array(32).fill(0xc3)]),
                amount: 331n,
            },
            { script: new Uint8Array([0x51, 0x20, ...ownerX]), amount: 1_599n },
        ]);
        const signedOther = await releaseGraph(OWNER_SEED, [
            {
                script: new Uint8Array([0x51, 0x20, ...new Uint8Array(32).fill(0xc3)]),
                amount: 331n,
            },
            { script: new Uint8Array([0x51, 0x20, ...ownerX]), amount: 1_599n },
        ]);
        await expect(
            release.complete({ advanceId: "adv-1", trusted: other, signed: signedOther }),
        ).rejects.toThrow(/custody_release_unconfirmed/);
    });

    it("releases a row past its window that has not been written off", async () => {
        reclaim();
        const trusted = await releaseGraph(null);
        const signed = await releaseGraph(OWNER_SEED);
        const release = releaser({ trusted, now: () => DUE + 1 });
        await release.prepare({ advanceId: "adv-1", ownerCoinSats: OWNER_COIN_SATS });
        await expect(release.complete({ advanceId: "adv-1", trusted, signed })).resolves.toEqual({
            txid: txidOf(trusted),
        });
    });

    it("refuses a release after a write-off, naming the actor and the time", async () => {
        reclaim();
        custody.writeOff("adv-1", "ops@example", DUE);
        const select = vi.fn(() => [TAXI_COIN]);
        let thrown: unknown;
        try {
            await releaser({ select, now: () => DUE + 1 }).prepare({
                advanceId: "adv-1",
                ownerCoinSats: OWNER_COIN_SATS,
            });
        } catch (error) {
            thrown = error;
        }
        expect(thrown).toMatchObject({ code: "custody_swept", actor: "ops@example", at: DUE });
        expect(select).not.toHaveBeenCalled();
    });

    it("leaves the row releasing when a submission is ambiguous", async () => {
        reclaim();
        const trusted = await releaseGraph(null);
        const signed = await releaseGraph(OWNER_SEED);
        const release = releaser({
            trusted,
            submit: async () => {
                throw new Error("provider timed out");
            },
        });
        await release.prepare({ advanceId: "adv-1", ownerCoinSats: OWNER_COIN_SATS });
        await expect(release.complete({ advanceId: "adv-1", trusted, signed })).rejects.toThrow(
            /provider timed out/,
        );
        expect(custody.get("adv-1")?.state).toBe("releasing");
    });

    it("refuses a release for an advance with no row", async () => {
        await expect(
            releaser().prepare({ advanceId: "missing", ownerCoinSats: OWNER_COIN_SATS }),
        ).rejects.toThrow(/custody_not_found/);
    });
});

describe("custodySolvencyView", () => {
    const coinWith = (units: bigint) =>
        ({
            txid: "cc".repeat(32),
            vout: 0,
            value: 5_000,
            // Keyed through the shared converter: the SDK string form reverses
            // the genesis txid, and re-deriving it here would only test itself.
            assets: [{ assetId: swapAssetId(ASSET), amount: units }],
        }) as never;

    it("matches held units to the liability's own asset id", () => {
        reclaim();
        const view = custodySolvencyView({
            liabilities: custody.liabilities(),
            coins: [coinWith(7n)],
            lendableSats: 10_000n,
            receivableSats: 0n,
        });
        expect(view).toMatchObject({
            owedSats: 1_000n,
            coverageSats: 9_000n,
            shortfall: false,
        });
        expect(view.coverageAssets).toEqual([{ assetId: ASSET, units: 0n }]);
    });

    it("is short when the held units fall below the liability", () => {
        reclaim();
        const view = custodySolvencyView({
            liabilities: custody.liabilities(),
            coins: [coinWith(6n)],
            lendableSats: 10_000n,
            receivableSats: 0n,
        });
        expect(view.shortfall).toBe(true);
        expect(view.shortAssets).toEqual([ASSET]);
    });
});
