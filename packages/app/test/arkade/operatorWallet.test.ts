import { afterEach, describe, expect, it, vi } from "vitest";
import { openDatabase, type Database } from "@arkade-taxi/db";
import {
    Wallet,
    ArkAddress,
    VtxoScript,
    CSVMultisigTapscript,
    networks,
    Transaction,
    type WalletConfig,
    type ExtendedVirtualCoin,
    type ContractManager,
    type ArkIntent,
} from "@arkade-os/sdk";
import { base64 } from "@scure/base";
import { bytesToHex } from "@arkade-taxi/protocol";
import { config, emulatorKey, operatorKey, providerEmulatorKey, serverKey } from "../fixtures.js";
import { arkInfo } from "./fixtures.js";
import { createOperatorRuntime } from "../../src/arkade/operatorWallet.js";
import { resolveRuntimeConfig } from "../../src/config.js";

const proofOf = (inputs: { txid: string; vout: number }[]) => {
    const tx = new Transaction();
    tx.addInput({ txid: "00".repeat(32), index: 0 });
    for (const { txid, vout } of inputs) tx.addInput({ txid, index: vout });
    return { proof: base64.encode(tx.toPSBT()) } as never;
};

/** A batch output (or, preconfirmed, an offchain receipt) whose expiry is `seconds` after birth. */
const livingFor = (seconds: number, isPreconfirmed = false): Partial<ExtendedVirtualCoin> => {
    const born = Math.floor(Date.now() / 1000);
    return {
        isPreconfirmed,
        createdAt: new Date(born * 1000),
        expiresAtHeight: undefined,
        expiresAt: new Date((born + seconds) * 1000),
    };
};

const databases: Database[] = [];
afterEach(() => {
    vi.restoreAllMocks();
    for (const db of databases.splice(0)) db.close();
});

function setup() {
    const db = openDatabase(":memory:");
    databases.push(db);
    let now = 1000;
    let info = arkInfo();
    let online = true;
    let height = 100;
    let time = 1789132000;
    let expiryTime: Date | undefined;
    let expiry: number | undefined = 400;
    let release: (() => void) | undefined;
    let pause: Promise<void> | undefined;
    let created = 0;
    let disposed = 0;
    let providerReads = 0;
    let inventoryReads = 0;
    let coins: Partial<ExtendedVirtualCoin>[] = [{}];
    let taxiReserved: { txid: string; vout: number }[] = [];
    let held: { txid: string; vout: number }[] = [];
    let reservationReadFails = false;
    let address = new ArkAddress(serverKey, operatorKey, "tark").encode();
    let walletConfig: WalletConfig;
    const events: string[] = [];
    let settleGate: Promise<void> | undefined;
    let startBackground!: () => void;
    const backgroundStart = new Promise<void>((resolve) => (startBackground = resolve));
    let backgroundPoll: Promise<string> | undefined;
    const settle = async (params: {
        inputs: { txid: string; vout: number }[];
        outputs: unknown[];
    }) => {
        events.push(`settle:${params.inputs.map(({ txid }) => txid.slice(0, 2)).join()}`);
        const id = await walletConfig.arkProvider!.registerIntent(proofOf(params.inputs));
        await settleGate;
        events.push("settle:end");
        return id;
    };
    const manager = {
        renewVtxos: async () =>
            wallet.settle({ inputs: await wallet.getSpendableVtxos(), outputs: [] }),
    };
    const wallet = {
        settle,
        getVtxoManager: async () => manager,
        getAddress: async () => address,
        getSpendableVtxos: async () => {
            inventoryReads++;
            await pause;
            return coins.map((overrides) => ({
                txid: "aa".repeat(32),
                vout: 0,
                value: 20000,
                expiresAtHeight: expiry,
                expiresAt: expiryTime,
                ...overrides,
            }));
        },
        getContractManager: async () => ({
            getSyncState: () => ({ mode: online ? "online" : "degraded", lastSyncedAt: now }),
        }),
        getProviderConnectionState: () => ({ mode: online ? "online" : "degraded" }),
        onchainProvider: { getChainTip: async () => ({ height, hash: "aa".repeat(32), time }) },
        dispose: async () => {
            disposed++;
        },
    };
    const runtime = createOperatorRuntime(config({ addressHrp: "tark" }), db, {
        now: () => now,
        providers: {
            arkProvider: {
                getInfo: async () => {
                    providerReads++;
                    return info;
                },
            },
            emulatorProvider: {
                getInfo: async () => ({ signerPubkey: bytesToHex(providerEmulatorKey) }),
            },
        },
        walletFactory: async (_cfg: WalletConfig) => {
            walletConfig = _cfg;
            created++;
            // Born at creation, like the SDK's poll timer: boards a deposit plus what renewal selects.
            backgroundPoll ??= backgroundStart.then(async () =>
                wallet.settle({
                    inputs: [
                        { txid: "bd".repeat(32), vout: 0 },
                        ...(await wallet.getSpendableVtxos()),
                    ],
                    outputs: [],
                }),
            );
            return wallet as unknown as Wallet;
        },
        reservedOutpoints: () => {
            if (reservationReadFails) throw new Error("reservation read failed");
            return taxiReserved;
        },
        heldOutpoints: () => held,
    });
    return {
        runtime,
        db,
        events,
        get walletConfig() {
            return walletConfig;
        },
        get backgroundPoll() {
            return backgroundPoll!;
        },
        startBackground: () => startBackground(),
        renew: async () => (await runtime.wallet!.getVtxoManager()).renewVtxos(),
        holdSettle: () => {
            let open!: () => void;
            settleGate = new Promise<void>((resolve) => (open = resolve));
            return () => {
                settleGate = undefined;
                open();
            };
        },
        setHeld: (value: { txid: string; vout: number }[]) => {
            held = value;
        },
        setAddress: (value: string) => {
            address = value;
        },
        setCoin: (v: Partial<ExtendedVirtualCoin>) => {
            coins = [v];
        },
        setCoins: (values: Partial<ExtendedVirtualCoin>[]) => {
            coins = values;
        },
        setExpiry: (v: number | undefined) => {
            expiry = v;
        },
        setTime: (v: number) => {
            time = v;
        },
        setExpiryTime: (v: Date) => {
            expiry = undefined;
            expiryTime = v;
        },
        setOnline: (v: boolean) => {
            online = v;
        },
        setHeight: (v: number) => {
            height = v;
        },
        setNow: (v: number) => {
            now = v;
        },
        setInfo: (v: typeof info) => {
            info = v;
        },
        setTaxiReserved: (value: { txid: string; vout: number }[]) => {
            taxiReserved = value;
        },
        failReservationRead: () => {
            reservationReadFails = true;
        },
        counts: () => ({ created, disposed }),
        ioCounts: () => ({ providerReads, inventoryReads }),
        pause: () => {
            pause = new Promise<void>((resolve) => {
                release = resolve;
            });
        },
        release: () => release?.(),
    };
}

describe("persistent operator runtime safety", () => {
    it("awaits the current settlement guard before registering an intent", async () => {
        const s = setup();
        const register = vi
            .spyOn(s.runtime.providers.arkProvider, "registerIntent")
            .mockResolvedValue("intent");
        let release!: () => void;
        const gate = new Promise<void>((resolve) => {
            release = resolve;
        });
        let checking = false;
        let yieldedAfterMarker = false;
        const boundary = vi.fn(() => {
            queueMicrotask(() => {
                yieldedAfterMarker = true;
            });
        });
        register.mockImplementation(async () => {
            expect(boundary).toHaveBeenCalledTimes(1);
            expect(yieldedAfterMarker).toBe(false);
            return "intent";
        });
        const work = s.runtime.withSettlement(
            async () => s.walletConfig.arkProvider!.registerIntent({} as never),
            async () => {
                checking = true;
                await gate;
                return boundary;
            },
        );
        try {
            await vi.waitFor(() => expect(checking).toBe(true));
            expect(register).not.toHaveBeenCalled();
        } finally {
            release();
            await work;
        }
        expect(register).toHaveBeenCalledTimes(1);
    });
    it("does not register when the synchronous durable boundary marker fails", async () => {
        const s = setup();
        const register = vi
            .spyOn(s.runtime.providers.arkProvider, "registerIntent")
            .mockResolvedValue("intent");
        await expect(
            s.runtime.withSettlement(
                async () => s.walletConfig.arkProvider!.registerIntent({} as never),
                async () => () => {
                    throw new Error("SQLITE_FULL");
                },
            ),
        ).rejects.toThrow("SQLITE_FULL");
        expect(register).not.toHaveBeenCalled();
    });
    it("pins an active settlement wallet across provider refresh and drains before disposal", async () => {
        const s = setup();
        await s.runtime.refresh();
        let release!: () => void;
        const gate = new Promise<void>((resolve) => {
            release = resolve;
        });
        let entered = false;
        const work = s.runtime.withSettlement(
            async () => {
                entered = true;
                await gate;
            },
            async () => () => {},
        );
        await vi.waitFor(() => expect(entered).toBe(true));
        s.setInfo(arkInfo({ digest: "changed" }));
        expect((await s.runtime.refresh()).blockers).toContain(
            "operator_settlement_provider_changed",
        );
        expect(s.counts().disposed).toBe(0);
        const dispose = s.runtime.dispose();
        await Promise.resolve();
        expect(s.counts().disposed).toBe(0);
        release();
        await Promise.all([work, dispose]);
        expect(s.counts().disposed).toBe(1);
    });
    it("counts spendable subdust repayment but excludes asset fare carriers from the sats funding reserve", async () => {
        const s = setup();
        s.setCoins([
            { vout: 0, value: 20000 },
            { vout: 1, value: 1, isPreconfirmed: true, virtualStatus: { state: "preconfirmed" } },
            { vout: 2, value: 1, assets: [{ assetId: "12".repeat(34), amount: 1000000n }] },
        ]);
        expect((await s.runtime.refresh()).inventory).toEqual({
            usableSats: 20001n,
            usableVtxos: 2,
            reservedSats: 0n,
            reservedVtxos: 0,
        });
    });
    it("closes admission before reading inventory when the wallet payout differs from configuration", async () => {
        const s = setup();
        s.setAddress(new ArkAddress(serverKey, emulatorKey, "tark").encode());
        const snapshot = await s.runtime.refresh();
        expect(snapshot.blockers).toContain("operator_payout_mismatch");
        expect(s.ioCounts().inventoryReads).toBe(0);
        expect(s.runtime.wallet).toBeUndefined();
    });
    it("publishes cached provider identity and exact usable inventory without I/O on read", async () => {
        const s = setup();
        await s.runtime.refresh();
        const before = s.ioCounts();

        expect(s.runtime.safety()).toMatchObject({
            provider: {
                network: "regtest",
                identityOk: true,
                serverPubkey: bytesToHex(serverKey),
                emulatorPubkey: bytesToHex(emulatorKey),
            },
            inventory: {
                usableSats: 20000n,
                reservedSats: 0n,
                usableVtxos: 1,
                reservedVtxos: 0,
            },
        });
        s.runtime.safety();
        expect(s.ioCounts()).toEqual(before);
    });

    it("does not trust the real Wallet's fulfilled fallback when its intent read fails", async () => {
        const db = openDatabase(":memory:");
        databases.push(db);
        const info = arkInfo({
            forfeitAddress: new VtxoScript([
                CSVMultisigTapscript.encode({
                    pubkeys: [serverKey],
                    timelock: { type: "blocks", value: 5n },
                }).script,
            ]).onchainAddress(networks.regtest),
        });
        let coin: ExtendedVirtualCoin;
        const providers = {
            arkProvider: { getInfo: async () => info },
            emulatorProvider: {
                getInfo: async () => ({ signerPubkey: bytesToHex(providerEmulatorKey) }),
            },
        };
        const resolved = await resolveRuntimeConfig(config({ addressHrp: "tark" }), providers);
        const runtime = createOperatorRuntime(resolved, db, {
            providers,
            onchainProvider: {
                getChainTip: async () => ({ height: 100, time: 1789132000, hash: "aa".repeat(32) }),
            } as WalletConfig["onchainProvider"],
            walletFactory: async (cfg) => {
                expect(await cfg.arkProvider!.getInfo()).toEqual(info);
                const wallet = await Wallet.create(cfg);
                const script = wallet.offchainTapscript;
                coin = {
                    txid: "aa".repeat(32),
                    vout: 0,
                    value: 20000,
                    expiresAtHeight: 400,
                    status: { confirmed: false },
                    createdAt: new Date(1789132000000),
                    script: bytesToHex(script.pkScript),
                    isUnrolled: false,
                    isSwept: false,
                    isSpent: false,
                    isPreconfirmed: true,
                    virtualStatus: { state: "preconfirmed" },
                    tapTree: script.encode(),
                    forfeitTapLeafScript: script.forfeit(),
                    intentTapLeafScript: script.forfeit(),
                };
                vi.spyOn(wallet, "getContractManager").mockResolvedValue({
                    getSyncState: () => ({ mode: "online", lastSyncedAt: Date.now() }),
                    getContractsWithVtxos: async () => [
                        {
                            contract: {
                                type: "default",
                                script: coin.script,
                                address: await wallet.getAddress(),
                                state: "active",
                                params: {},
                                createdAt: Date.now(),
                            },
                            vtxos: [coin],
                        },
                    ],
                } as unknown as ContractManager);
                return wallet;
            },
        });
        try {
            expect((await runtime.refresh()).blockers).toEqual([]);
            vi.spyOn(runtime.storage.intentRepository, "getLockedVtxoOutpoints").mockRejectedValue(
                new Error("injected intent read failure"),
            );
            const warning = vi.spyOn(console, "error").mockImplementation(() => {});
            expect(await runtime.wallet!.getSpendableVtxos()).toHaveLength(1);
            expect(warning).toHaveBeenCalled();
            await expect(runtime.assertAdmission()).rejects.toMatchObject({
                code: "runtime_unsafe",
                status: 503,
            });
            expect(runtime.safety().blockers).toContain("intent_locks_unavailable");
        } finally {
            await runtime.dispose();
        }
    });

    it("excludes explicit locked outpoints from the verified reserve", async () => {
        const s = setup();
        expect((await s.runtime.refresh()).blockers).toEqual([]);
        vi.spyOn(s.runtime.storage.intentRepository, "getLockedVtxoOutpoints").mockResolvedValue([
            { txid: "aa".repeat(32), vout: 0 },
        ]);
        await expect(s.runtime.assertAdmission()).rejects.toMatchObject({ status: 503 });
        expect(s.runtime.safety().blockers).toContain("operator_reserve_low");
        expect(s.runtime.safety().inventory).toEqual({
            usableSats: 0n,
            reservedSats: 20000n,
            usableVtxos: 0,
            reservedVtxos: 1,
        });
    });

    it("counts a reserved valid-value coin before low-expiry filtering", async () => {
        const s = setup();
        s.setExpiry(200);
        vi.spyOn(s.runtime.storage.intentRepository, "getLockedVtxoOutpoints").mockResolvedValue([
            { txid: "aa".repeat(32), vout: 0 },
        ]);

        const snapshot = await s.runtime.refresh();

        expect(snapshot.blockers).toContain("vtxo_expiry_headroom");
        expect(snapshot.inventory).toEqual({
            usableSats: 0n,
            reservedSats: 20000n,
            usableVtxos: 0,
            reservedVtxos: 1,
        });
    });

    it("keeps an unknown-expiry Taxi reservation visible in cached runtime status", async () => {
        const s = setup();
        s.setExpiry(undefined);
        s.setTaxiReserved([{ txid: "aa".repeat(32), vout: 0 }]);

        await s.runtime.refresh();

        expect(s.runtime.safety().blockers).toContain("vtxo_expiry_unknown");
        expect(s.runtime.safety().inventory).toEqual({
            usableSats: 0n,
            reservedSats: 20000n,
            usableVtxos: 0,
            reservedVtxos: 1,
        });
    });

    it("reserves Taxi-only outpoints and releases them from inventory when they disappear", async () => {
        const s = setup();
        s.setTaxiReserved([{ txid: "aa".repeat(32), vout: 0 }]);

        expect((await s.runtime.refresh()).inventory).toEqual({
            usableSats: 0n,
            reservedSats: 20000n,
            usableVtxos: 0,
            reservedVtxos: 1,
        });
        expect(s.runtime.safety().blockers).toContain("operator_reserve_low");

        s.setTaxiReserved([]);
        expect((await s.runtime.refresh()).inventory).toEqual({
            usableSats: 20000n,
            reservedSats: 0n,
            usableVtxos: 1,
            reservedVtxos: 0,
        });
        expect(s.runtime.safety().blockers).not.toContain("operator_reserve_low");
    });

    it("deduplicates overlap between SDK and Taxi reservation locks", async () => {
        const s = setup();
        const first = { txid: "aa".repeat(32), vout: 0 };
        const second = { txid: "bb".repeat(32), vout: 1 };
        s.setCoins([
            { ...first, value: 20000 },
            { ...second, value: 25000 },
        ]);
        vi.spyOn(s.runtime.storage.intentRepository, "getLockedVtxoOutpoints").mockResolvedValue([
            first,
        ]);
        s.setTaxiReserved([first, second]);

        expect((await s.runtime.refresh()).inventory).toEqual({
            usableSats: 0n,
            reservedSats: 45000n,
            usableVtxos: 0,
            reservedVtxos: 2,
        });
    });

    it("closes readiness and counts no uncertain coin usable when Taxi reservations cannot be read", async () => {
        const s = setup();
        s.failReservationRead();

        const snapshot = await s.runtime.refresh();

        expect(snapshot.blockers).toContain("reservation_locks_unavailable");
        expect(snapshot.inventory).toEqual({
            usableSats: 0n,
            reservedSats: 0n,
            usableVtxos: 0,
            reservedVtxos: 0,
        });
    });

    it.each([
        { isSpent: true },
        { isSwept: true },
        { isUnrolled: true },
        { spentBy: "tx" },
        { settledBy: "tx" },
    ])("does not count unspendable coins %s toward reserve", async (coin) => {
        const s = setup();
        s.setCoin(coin);
        await expect(s.runtime.assertAdmission()).rejects.toMatchObject({ status: 503 });
        expect(s.runtime.safety().blockers).toContain("operator_reserve_low");
    });
    it("does not count a coin the SDK is about to renew as usable inventory", async () => {
        const s = setup();
        s.setExpiryTime(new Date((Math.floor(Date.now() / 1000) + 2 * 86_400) * 1000));
        const state = await s.runtime.refresh();
        expect(state.inventory).toMatchObject({ usableSats: 0n, usableVtxos: 0 });
        expect(state.blockers).not.toContain("vtxo_expiry_headroom");
    });
    it("closes admission, not recovery, unless batch coins outlive the renewal threshold by 12 h", async () => {
        const s = setup();
        const flagged = async () =>
            (await s.runtime.refresh()).blockers.includes(
                "renewal_threshold_exceeds_vtxo_lifetime",
            );

        s.setCoin(livingFor(259_200 + 43_200));
        expect(await flagged()).toBe(false);
        // Received offchain, a coin keeps its batch's expiry: its own span is not the lifetime.
        s.setCoin(livingFor(3_600, true));
        expect(await flagged()).toBe(false);
        s.setCoin(livingFor(259_200 + 43_199));
        expect(await flagged()).toBe(true);
        await expect(s.runtime.assertRecovery()).resolves.toBeDefined();
        await expect(s.runtime.assertAdmission()).rejects.toMatchObject({ status: 503 });

        s.setCoin({});
        s.setInfo(arkInfo({ vtxoTreeExpiry: 259_200n + 43_199n }));
        expect(await flagged()).toBe(true);
        s.setInfo(arkInfo({ vtxoTreeExpiry: 180n }));
        expect(await flagged()).toBe(false);
    });
    it("uses MTP and seconds budgets for timestamp expiry and rejects unknown MTP", async () => {
        const s = setup();
        s.setExpiryTime(new Date((1789132000 + 86401) * 1000));
        expect((await s.runtime.refresh()).blockers).toEqual([]);
        expect(s.runtime.safety().chainTime).toBe(1789132000n);
        s.setTime(1789132002);
        expect((await s.runtime.refresh()).blockers).toContain("vtxo_expiry_headroom");
        s.setTime(NaN);
        expect((await s.runtime.refresh()).chainTime).toBeNull();
        expect(s.runtime.safety().blockers).toContain("chain_tip_unavailable");
    });
    it("runs the SDK's background settlement at the configured threshold, without signer migration", async () => {
        const s = setup();
        await s.runtime.refresh();
        expect(s.walletConfig.settlementConfig).toEqual({
            vtxoThreshold: 259_200,
            deprecatedSignerMigration: false,
        });
    });
    it("starts closed, opens only after fresh provider/wallet/tip checks, and preserves DB ownership", async () => {
        const { runtime, db } = setup();
        expect(runtime.safety().blockers).toContain("runtime_unchecked");
        expect((await runtime.refresh()).blockers).toEqual([]);
        await expect(runtime.assertAdmission()).resolves.toBeUndefined();
        await runtime.dispose();
        expect(db.open).toBe(true);
        expect(runtime.safety().blockers).toContain("runtime_stopped");
    });

    it.each([undefined, 0, 200, NaN, 1.5])(
        "blocks unknown or insufficient expiry %s",
        async (expiry) => {
            const { runtime, setExpiry } = setup();
            setExpiry(expiry);
            await expect(runtime.assertAdmission()).rejects.toMatchObject({ status: 503 });
            expect(runtime.safety().blockers.length).toBeGreaterThan(0);
        },
    );

    it("does not mistake a cached wallet result for successful synchronization", async () => {
        const { runtime, setOnline } = setup();
        await runtime.refresh();
        setOnline(false);
        await expect(runtime.assertAdmission()).rejects.toMatchObject({ code: "runtime_unsafe" });
        expect(runtime.safety().walletSynced).toBe(false);
    });

    it("invalidates readiness while a refresh is pending and when its snapshot expires", async () => {
        const s = setup();
        await s.runtime.refresh();
        s.setNow(32000);
        expect(s.runtime.safety().blockers).toContain("runtime_stale");
        s.pause();
        const refresh = s.runtime.refresh();
        expect(s.runtime.safety().blockers).toContain("runtime_checking");
        s.release();
        await refresh;
        expect(s.runtime.safety().blockers).toEqual([]);
    });

    it("rejects signer rotation and reopens with a new wallet only after revalidation", async () => {
        const s = setup();
        await s.runtime.refresh();
        s.setInfo(arkInfo({ signerPubkey: bytesToHex(emulatorKey) }));
        await expect(s.runtime.assertAdmission()).rejects.toThrow();
        s.setInfo(arkInfo());
        await s.runtime.refresh();
        expect(s.counts()).toEqual({ created: 2, disposed: 1 });
    });

    it("rejects an invalid chain tip without falling back to a previous height", async () => {
        const s = setup();
        await s.runtime.refresh();
        s.setHeight(NaN);
        const snapshot = await s.runtime.refresh();
        expect(snapshot.chainHeight).toBeNull();
        expect(snapshot.blockers).toContain("chain_tip_unavailable");
    });
});

describe("the SDK's background settlement", () => {
    const tick = () => new Promise((resolve) => setTimeout(resolve, 10));

    it("is the only intent source besides the proceeds worker", async () => {
        const s = setup();
        const register = vi
            .spyOn(s.runtime.providers.arkProvider, "registerIntent")
            .mockResolvedValue("intent");
        await s.runtime.refresh();

        await expect(
            s.walletConfig.arkProvider!.registerIntent(
                proofOf([{ txid: "aa".repeat(32), vout: 0 }]),
            ),
        ).rejects.toThrow("proceeds_submission_not_authorized");
        await expect(s.runtime.wallet!.settle({ inputs: [], outputs: [] })).rejects.toThrow(
            "proceeds_submission_not_authorized",
        );
        expect(register).not.toHaveBeenCalled();

        s.startBackground();
        await expect(s.backgroundPoll).resolves.toBe("intent");
        await expect(s.renew()).resolves.toBe("intent");
        expect(register).toHaveBeenCalledTimes(2);
    });

    it("never runs alongside the proceeds worker's settlement, in either order", async () => {
        const s = setup();
        vi.spyOn(s.runtime.providers.arkProvider, "registerIntent").mockResolvedValue("intent");
        await s.runtime.refresh();
        let finishProceeds!: () => void;
        const proceeds = s.runtime.withSettlement(
            async () => {
                s.events.push("proceeds");
                await new Promise<void>((resolve) => (finishProceeds = resolve));
                s.events.push("proceeds:end");
            },
            async () => () => {},
        );
        await vi.waitFor(() => expect(s.events).toEqual(["proceeds"]));
        const renewal = s.renew();
        await tick();
        expect(s.events).toEqual(["proceeds"]);
        finishProceeds();
        await Promise.all([proceeds, renewal]);
        expect(s.events).toEqual(["proceeds", "proceeds:end", "settle:aa", "settle:end"]);

        s.events.length = 0;
        const finishBackground = s.holdSettle();
        const background = s.renew();
        await vi.waitFor(() => expect(s.events).toEqual(["settle:aa"]));
        const next = s.runtime.withSettlement(
            async () => void s.events.push("proceeds"),
            async () => () => {},
        );
        await tick();
        expect(s.events).toEqual(["settle:aa"]);
        finishBackground();
        await Promise.all([background, next]);
        expect(s.events).toEqual(["settle:aa", "settle:end", "proceeds"]);
    });

    it("leaves the proceeds worker's own guard on its intents, and only on them", async () => {
        const s = setup();
        const register = vi
            .spyOn(s.runtime.providers.arkProvider, "registerIntent")
            .mockResolvedValue("intent");
        await s.runtime.refresh();
        const refusing = vi.fn(async () => {
            throw new Error("proceeds_fee_authorization_changed");
        });
        await expect(
            s.runtime.withSettlement(
                (wallet) => wallet.settle({ inputs: [], outputs: [] }),
                refusing,
            ),
        ).rejects.toThrow("proceeds_fee_authorization_changed");
        expect(register).not.toHaveBeenCalled();
        s.events.length = 0;

        const guard = vi.fn(async () => () => {});
        let renewal: Promise<string> | undefined;
        await s.runtime.withSettlement(async (wallet) => {
            renewal = s.renew();
            return wallet.settle({
                inputs: [{ txid: "cc".repeat(32), vout: 1 }] as never,
                outputs: [],
            });
        }, guard);
        await renewal;
        expect(guard).toHaveBeenCalledTimes(1);
        expect(register).toHaveBeenCalledTimes(2);
        expect(s.events).toEqual(["settle:cc", "settle:end", "settle:aa", "settle:end"]);
    });

    it("never lets a hung settle stop recovery when the provider changes, nor register after", async () => {
        const s = setup();
        const register = vi
            .spyOn(s.runtime.providers.arkProvider, "registerIntent")
            .mockResolvedValue("intent");
        await s.runtime.refresh();
        const retired = s.walletConfig;
        s.holdSettle();
        const hung = s.renew();
        await vi.waitFor(() => expect(s.events).toEqual(["settle:aa"]));

        s.setInfo(arkInfo({ digest: "changed" }));
        await expect(s.runtime.assertRecovery()).resolves.toBeDefined();
        await expect(hung).rejects.toThrow("background_settlement_not_authorized");
        await expect(
            s.runtime.withSettlement(
                async () => retired.arkProvider!.registerIntent(proofOf([])),
                async () => () => {},
            ),
        ).rejects.toThrow("proceeds_submission_not_authorized");
        expect(register).toHaveBeenCalledTimes(1);
    });

    it("stops renewing coins that cannot outlive the threshold, and keeps boarding", async () => {
        const s = setup();
        vi.spyOn(s.runtime.providers.arkProvider, "registerIntent").mockResolvedValue("intent");
        s.setCoin(livingFor(259_200));
        await s.runtime.refresh();

        s.startBackground();
        await s.backgroundPoll;
        expect(s.events).toEqual(["settle:bd", "settle:end"]);
    });

    it("never selects or registers a coin the Taxi holds, nor a subdust one", async () => {
        const s = setup();
        const register = vi
            .spyOn(s.runtime.providers.arkProvider, "registerIntent")
            .mockResolvedValue("intent");
        s.setCoins([{}, { txid: "cc".repeat(32), value: 1 }, { txid: "dd".repeat(32) }]);
        s.setHeld([{ txid: "dd".repeat(32), vout: 0 }]);
        await s.runtime.refresh();

        expect(await s.runtime.wallet!.getSpendableVtxos()).toHaveLength(3);
        await s.renew();
        expect(s.events).toEqual(["settle:aa", "settle:end"]);

        s.setHeld([{ txid: "bd".repeat(32), vout: 0 }]);
        s.startBackground();
        await expect(s.backgroundPoll).rejects.toThrow("background_settlement_spends_held_coin");
        expect(register).toHaveBeenCalledTimes(1);
    });
});

describe("SDK intents left waiting", () => {
    const coin = (id: string) => ({ txid: id.repeat(32), vout: 0 });
    const intent = (id: string, over: Partial<ArkIntent> = {}): ArkIntent => ({
        intentTxId: id.repeat(32),
        state: "waiting_for_batch",
        createdAt: 500,
        updatedAt: 500,
        registerProof: "register",
        registerProofMessage: "{}",
        deleteProof: `delete-${id}`,
        deleteProofMessage: JSON.stringify({ type: "delete", expire_at: 0 }),
        partialForfeits: [],
        intentVtxos: [coin(id)],
        ...over,
    });

    it("cancels an earlier process's unheld, unspent waiting intent at startup, and only that", async () => {
        const s = setup();
        const intents = s.runtime.storage.intentRepository;
        for (const record of [
            intent("a1"),
            intent("a2"),
            intent("a3", { state: "batch_in_progress" }),
            intent("a4"),
            intent("a5", { createdAt: 1000 }),
        ])
            await intents.saveIntent(record);
        s.setHeld([coin("a2")]);
        const remove = vi
            .spyOn(s.runtime.providers.arkProvider, "deleteIntent")
            .mockResolvedValue();
        vi.spyOn(s.runtime.providers.indexerProvider, "getVtxos").mockImplementation(
            async (options) => ({
                vtxos: options!.outpoints!.map(
                    (o) => ({ ...o, isSpent: o.txid === coin("a4").txid }) as never,
                ),
            }),
        );

        await s.runtime.refresh();
        expect(remove).toHaveBeenCalledTimes(1);
        expect(remove).toHaveBeenCalledWith({
            proof: "delete-a1",
            message: { type: "delete", expire_at: 0 },
        });
        expect(
            Object.fromEntries(
                (await intents.getIntents()).map((i) => [i.intentTxId.slice(0, 2), i.state]),
            ),
        ).toEqual({
            a1: "cancelled",
            a2: "waiting_for_batch",
            a3: "batch_in_progress",
            a4: "waiting_for_batch",
            a5: "waiting_for_batch",
        });
    });

    it("reports an intent still waiting after an hour, without stopping recovery", async () => {
        const s = setup();
        await s.runtime.storage.intentRepository.saveIntent(intent("b1", { createdAt: 1000 }));
        const stale = async () =>
            (await s.runtime.refresh()).blockers.includes("operator_intent_stale");

        s.setNow(1000 + 3_600_000);
        expect(await stale()).toBe(false);
        s.setNow(1000 + 3_600_001);
        expect(await stale()).toBe(true);
        await expect(s.runtime.assertRecovery()).resolves.toBeDefined();
    });
});
