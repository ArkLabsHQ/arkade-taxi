import { afterEach, describe, expect, it, vi } from "vitest";
import { openDatabase, type Database } from "@arkade-taxi/db";
import {
    Wallet,
    ArkAddress,
    VtxoScript,
    CSVMultisigTapscript,
    networks,
    type WalletConfig,
    type ExtendedVirtualCoin,
    type ContractManager,
} from "@arkade-os/sdk";
import { bytesToHex } from "@arkade-taxi/protocol";
import { config, emulatorKey, operatorKey, serverKey } from "../fixtures.js";
import { arkInfo } from "./fixtures.js";
import { createOperatorRuntime } from "../../src/arkade/operatorWallet.js";
import { resolveRuntimeConfig } from "../../src/config.js";

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
    let reservationReadFails = false;
    let address = new ArkAddress(serverKey, operatorKey, "tark").encode();
    let walletConfig: WalletConfig;
    const wallet = {
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
            emulatorProvider: { getInfo: async () => ({ signerPubkey: bytesToHex(emulatorKey) }) },
        },
        walletFactory: async (_cfg: WalletConfig) => {
            walletConfig = _cfg;
            created++;
            return wallet as unknown as Wallet;
        },
        reservedOutpoints: () => {
            if (reservationReadFails) throw new Error("reservation read failed");
            return taxiReserved;
        },
    });
    return {
        runtime,
        db,
        get walletConfig() {
            return walletConfig;
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
        const work = s.runtime.withSettlement(
            async () => s.walletConfig.arkProvider!.registerIntent({} as never),
            async () => {
                checking = true;
                await gate;
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
            () => {},
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
            emulatorProvider: { getInfo: async () => ({ signerPubkey: bytesToHex(emulatorKey) }) },
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
