import { AsyncLocalStorage } from "node:async_hooks";
import {
    SingleKey,
    ArkAddress,
    Wallet,
    EsploraProvider,
    Transaction,
    canSpendOffchain,
    isSubdust,
    type WalletConfig,
    type ArkInfo,
    type ArkProvider,
    type ExtendedVirtualCoin,
} from "@arkade-os/sdk";
import { base64, hex } from "@scure/base";
import type { Database } from "@arkade-taxi/db";
import type { Outpoint } from "@arkade-taxi/core";
import { bytesToHex } from "@arkade-taxi/protocol";
import type { RuntimeConfig } from "../config.js";
import { ServiceError } from "../errors.js";
import { createProviders, verifyProviders, normalizeExpiry, renewing } from "./providers.js";
import { createOperatorStorage } from "./sqlExecutor.js";
import type { RuntimeSafety } from "./types.js";

const admissionOnlyBlockers = new Set([
    "vtxo_expiry_headroom",
    "vtxo_expiry_unknown",
    "operator_reserve_low",
    "renewal_threshold_exceeds_vtxo_lifetime",
]);

type SettlementGuard = (
    intent: Parameters<ArkProvider["registerIntent"]>[0],
) => Promise<() => void>;

/** Set inside the SDK's own background settlement (VtxoManager): its poll timers
 * inherit it from wallet creation, and its event-driven renewal is wrapped in it. */
const sdkBackground = new AsyncLocalStorage<true>();
const outpointKey = (o: Outpoint) => `${o.txid}:${o.vout}`;
/** How long past the renewal threshold a coin must live, or the SDK renews it soon after birth. */
const RENEWAL_MARGIN_SECONDS = 43_200n;

export interface OperatorRuntimeOptions {
    now?: () => number;
    providers?: Parameters<typeof verifyProviders>[1];
    walletFactory?: (config: WalletConfig) => Promise<Wallet>;
    onchainProvider?: WalletConfig["onchainProvider"];
    reservedOutpoints?: () => readonly Outpoint[] | Promise<readonly Outpoint[]>;
    /** Coins the SDK's background settlement must never spend. */
    heldOutpoints?: () => readonly Outpoint[] | Promise<readonly Outpoint[]>;
}

export function createOperatorRuntime(
    config: RuntimeConfig,
    db: Database,
    options: OperatorRuntimeOptions = {},
) {
    const now = options.now ?? Date.now;
    const providers = createProviders(config);
    const storage = createOperatorStorage(db);
    let wallet: Wallet | undefined;
    let pending: Promise<RuntimeSafety> | undefined;
    let admission: Promise<void> | undefined;
    let activeAdmission: Promise<void> | undefined;
    let queuedRefresh: Promise<RuntimeSafety> | undefined;
    let settlement: Promise<void> | undefined;
    let settlementGuard: SettlementGuard | undefined;
    let backgroundSettling = false;
    let turns: Promise<unknown> = Promise.resolve();
    // One settlement at a time, the proceeds worker's or the SDK's, in arrival order.
    const oneSettlement = <T>(work: () => Promise<T>): Promise<T> => {
        const turn = turns.then(work);
        turns = turn.catch(() => {});
        return turn;
    };
    const held = async () => new Set(((await options.heldOutpoints?.()) ?? []).map(outpointKey));
    const tooShort = (lifetime: bigint) =>
        lifetime - config.vtxoRenewalThresholdSeconds < RENEWAL_MARGIN_SECONDS;
    // arkd advertises no VTXO lifetime; a batch output's own span is it. Below 512 it counts blocks.
    const shortLived = (coin: ExtendedVirtualCoin) => {
        if (coin.isPreconfirmed !== false || coin.expiresAt === undefined) return false;
        const born = new Date(coin.createdAt).getTime();
        const span = Math.floor((new Date(coin.expiresAt).getTime() - born) / 1000);
        return Number.isSafeInteger(span) && tooShort(BigInt(span));
    };
    const advertisesShortLife = (info?: ArkInfo) =>
        info?.vtxoTreeExpiry !== undefined &&
        info.vtxoTreeExpiry >= 512n &&
        tooShort(info.vtxoTreeExpiry);
    let stopped = false;
    let infoFingerprint: string | undefined;
    let serverUnrollScript: Awaited<ReturnType<typeof verifyProviders>>["serverUnrollScript"];
    const closed = (reason: string): RuntimeSafety => ({
        checkedAt: now(),
        chainHeight: null,
        chainTime: null,
        walletSynced: false,
        providerIdentityOk: false,
        blockers: [reason],
    });
    let snapshot = closed("runtime_unchecked");

    const safety = (): RuntimeSafety => {
        const state = stopped ? closed("runtime_stopped") : snapshot;
        const stale =
            now() - state.checkedAt >= config.reconcileIntervalMs || now() < state.checkedAt;
        return { ...state, blockers: [...state.blockers, ...(stale ? ["runtime_stale"] : [])] };
    };

    const check = async (): Promise<RuntimeSafety> => {
        snapshot = closed("runtime_checking");
        const verified = await verifyProviders(config, options.providers ?? providers);
        serverUnrollScript = verified.blockers.length ? undefined : verified.serverUnrollScript;
        const result: RuntimeSafety = {
            checkedAt: now(),
            chainHeight: null,
            chainTime: null,
            walletSynced: false,
            providerIdentityOk: verified.providerIdentityOk,
            blockers: [...verified.blockers],
            provider: {
                network: verified.info?.network ?? null,
                identityOk: verified.providerIdentityOk,
                serverPubkey: bytesToHex(config.serverPubkey),
                emulatorPubkey: bytesToHex(config.emulatorPubkey),
            },
            inventory: {
                usableSats: 0n,
                reservedSats: 0n,
                usableVtxos: 0,
                reservedVtxos: 0,
            },
        };
        const fingerprint = JSON.stringify(verified.info, (_, value) =>
            typeof value === "bigint" ? value.toString() : value,
        );
        if (wallet && (result.blockers.length || fingerprint !== infoFingerprint)) {
            if (settlement || backgroundSettling) {
                result.blockers.push("operator_settlement_provider_changed");
                return result;
            }
            await wallet.dispose();
            wallet = undefined;
        }
        if (result.blockers.length || stopped) return result;
        try {
            if (!wallet) {
                const created = await sdkBackground.run(true, () =>
                    (options.walletFactory ?? Wallet.create)({
                        identity: SingleKey.fromPrivateKey(config.operatorPrivkey),
                        arkProvider: Object.assign(Object.create(providers.arkProvider), {
                            getInfo: async () => verified.info!,
                            registerIntent: async (
                                intent: Parameters<typeof providers.arkProvider.registerIntent>[0],
                            ) => {
                                if (sdkBackground.getStore()) {
                                    if (!backgroundSettling || stopped)
                                        throw new Error("background_settlement_not_authorized");
                                    const proof = Transaction.fromPSBT(base64.decode(intent.proof));
                                    const taken = await held();
                                    // Input 0 is the proof's BIP-322 toSpend reference.
                                    for (let i = 1; i < proof.inputsLength; i++) {
                                        const { txid, index } = proof.getInput(i);
                                        if (taken.has(`${hex.encode(txid!)}:${index}`))
                                            throw new Error(
                                                "background_settlement_spends_held_coin",
                                            );
                                    }
                                    return providers.arkProvider.registerIntent(intent);
                                }
                                if (!settlementGuard)
                                    throw new Error("proceeds_submission_not_authorized");
                                const enter = await settlementGuard(intent);
                                enter();
                                return providers.arkProvider.registerIntent(intent);
                            },
                        }),
                        indexerProvider: providers.indexerProvider,
                        onchainProvider:
                            options.onchainProvider ?? new EsploraProvider(config.esploraUrl),
                        storage,
                        settlementConfig: {
                            vtxoThreshold: Number(config.vtxoRenewalThresholdSeconds),
                            deprecatedSignerMigration: false,
                        },
                    }),
                );
                const settle = created.settle.bind(created);
                created.settle = (...args) =>
                    sdkBackground.getStore()
                        ? oneSettlement(async () => {
                              backgroundSettling = true;
                              try {
                                  return await settle(...args);
                              } finally {
                                  backgroundSettling = false;
                              }
                          })
                        : settle(...args);
                const spendable = created.getSpendableVtxos.bind(created);
                const shortLife = advertisesShortLife(verified.info);
                created.getSpendableVtxos = async (filter) => {
                    const coins = await spendable(filter);
                    if (!sdkBackground.getStore()) return coins;
                    // Renewing such a coin only buys another, a fee each minute; boarding goes on.
                    if (shortLife || coins.some(shortLived)) return [];
                    const taken = await held();
                    return coins.filter(
                        (c) => !taken.has(outpointKey(c)) && !isSubdust(c, config.dust),
                    );
                };
                const manager = await created.getVtxoManager();
                const renew = manager.renewVtxos.bind(manager);
                manager.renewVtxos = (...args) => sdkBackground.run(true, () => renew(...args));
                wallet = created;
                infoFingerprint = fingerprint;
            }
            if (stopped) {
                await wallet.dispose();
                wallet = undefined;
                return closed("runtime_stopped");
            }
            const address = ArkAddress.decode(await wallet.getAddress());
            if (
                address.encode() !==
                new ArkAddress(config.serverPubkey, config.operatorKey, config.addressHrp).encode()
            ) {
                result.blockers.push("operator_payout_mismatch");
                await wallet.dispose();
                wallet = undefined;
                return result;
            }
            const [tip, coins] = await Promise.allSettled([
                wallet.onchainProvider.getChainTip(),
                wallet.getSpendableVtxos(),
            ]);
            if (
                tip.status === "fulfilled" &&
                Number.isSafeInteger(tip.value.height) &&
                tip.value.height >= 0 &&
                Number.isSafeInteger(tip.value.time) &&
                tip.value.time > 0
            ) {
                result.chainHeight = BigInt(tip.value.height);
                result.chainTime = BigInt(tip.value.time);
            } else result.blockers.push("chain_tip_unavailable");
            const manager = await wallet.getContractManager();
            const sync = manager.getSyncState();
            result.walletSynced =
                coins.status === "fulfilled" &&
                sync.mode === "online" &&
                sync.lastSyncedAt !== undefined &&
                wallet.getProviderConnectionState().mode === "online";
            if (!result.walletSynced) result.blockers.push("wallet_unsynced");
            if (coins.status === "fulfilled") {
                let sdkLocks: readonly Outpoint[];
                try {
                    sdkLocks = await storage.intentRepository.getLockedVtxoOutpoints();
                } catch {
                    result.blockers.push("intent_locks_unavailable");
                    return result;
                }
                let taxiLocks: readonly Outpoint[] = [];
                try {
                    taxiLocks = (await options.reservedOutpoints?.()) ?? [];
                } catch {
                    result.blockers.push("reservation_locks_unavailable");
                    return result;
                }
                const locked = new Set(
                    [...sdkLocks, ...taxiLocks].map((o) => `${o.txid}:${o.vout}`),
                );
                let reserve = 0n;
                let reserved = 0n;
                let usableVtxos = 0;
                let reservedVtxos = 0;
                for (const coin of coins.value) {
                    if (!Number.isSafeInteger(coin.value) || coin.value <= 0) {
                        result.blockers.push("wallet_value_invalid");
                        continue;
                    }
                    const isReserved = locked.has(`${coin.txid}:${coin.vout}`);
                    if (isReserved) {
                        reserved += BigInt(coin.value);
                        reservedVtxos++;
                    }
                    let expiry;
                    try {
                        expiry = normalizeExpiry(coin);
                    } catch {
                        result.blockers.push("vtxo_expiry_unknown");
                        continue;
                    }
                    if (shortLived(coin))
                        result.blockers.push("renewal_threshold_exceeds_vtxo_lifetime");
                    const clock = expiry.kind === "height" ? result.chainHeight : result.chainTime;
                    const headroom =
                        expiry.kind === "height"
                            ? config.minExpiryHeadroomBlocks
                            : config.minExpiryHeadroomSeconds;
                    if (clock === null || expiry.value - clock < headroom) {
                        result.blockers.push("vtxo_expiry_headroom");
                        continue;
                    }
                    if (isReserved) continue;
                    if (
                        !coin.assets?.length &&
                        !renewing(coin, config.vtxoRenewalThresholdSeconds) &&
                        result.chainTime !== null &&
                        result.chainHeight !== null &&
                        canSpendOffchain(coin, {
                            timestamp: new Date(Number(result.chainTime) * 1000),
                            height: Number(result.chainHeight),
                        })
                    ) {
                        reserve += BigInt(coin.value);
                        usableVtxos++;
                    }
                }
                result.inventory = {
                    usableSats: reserve,
                    reservedSats: reserved,
                    usableVtxos,
                    reservedVtxos,
                };
                if (reserve < config.operatorMinReserveSats)
                    result.blockers.push("operator_reserve_low");
            }
        } catch {
            result.walletSynced = false;
            result.blockers.push("wallet_unavailable");
        }
        if (advertisesShortLife(verified.info))
            result.blockers.push("renewal_threshold_exceeds_vtxo_lifetime");
        result.blockers = [...new Set(result.blockers)];
        return result;
    };

    const refreshNow = (): Promise<RuntimeSafety> => {
        if (stopped) return Promise.resolve(safety());
        if (!pending) {
            pending = check()
                .then((result) => {
                    snapshot = result;
                    return safety();
                })
                .catch(() => {
                    snapshot = closed("runtime_check_failed");
                    return safety();
                })
                .finally(() => {
                    pending = undefined;
                });
        }
        return pending;
    };

    const refresh = (): Promise<RuntimeSafety> => {
        if (!admission) return refreshNow();
        if (!queuedRefresh) {
            queuedRefresh = Promise.resolve(activeAdmission)
                .then(refreshNow)
                .finally(() => {
                    queuedRefresh = undefined;
                });
        }
        return queuedRefresh;
    };

    const stop = () => {
        stopped = true;
        snapshot = closed("runtime_stopped");
    };

    return {
        providers,
        storage,
        safety,
        refresh,
        getServerUnroll() {
            if (!serverUnrollScript || safety().blockers.length)
                throw new ServiceError(
                    "runtime_unsafe",
                    503,
                    "verified Arkade Service unroll script unavailable",
                );
            return serverUnrollScript;
        },
        get wallet() {
            return wallet;
        },
        stop,
        async withSettlement<T>(
            work: (wallet: Wallet) => Promise<T>,
            guard: SettlementGuard,
        ): Promise<T> {
            if (settlement) throw new Error("proceeds_worker_active");
            await refresh();
            if (settlement || !wallet || stopped) throw new Error("proceeds_wallet_unavailable");
            let release!: () => void;
            settlement = new Promise<void>((resolve) => {
                release = resolve;
            });
            try {
                return await oneSettlement(async () => {
                    if (!wallet || stopped) throw new Error("proceeds_wallet_unavailable");
                    settlementGuard = guard;
                    try {
                        return await work(wallet);
                    } finally {
                        settlementGuard = undefined;
                    }
                });
            } finally {
                settlement = undefined;
                release();
            }
        },
        async assertRecovery() {
            const state = await refresh();
            const blockers = state.blockers.filter((code) => !admissionOnlyBlockers.has(code));
            if (blockers.length) throw new ServiceError("runtime_unsafe", 503, blockers.join(", "));
            return state;
        },
        async assertAdmission() {
            const state = await refresh();
            if (state.blockers.length)
                throw new ServiceError("runtime_unsafe", 503, state.blockers.join(", "));
        },
        async withAdmission<T>(work: (assertCurrent: () => void) => Promise<T>): Promise<T> {
            const previous = admission;
            let release!: () => void;
            const current = new Promise<void>((resolve) => (release = resolve));
            admission = current;
            await previous;
            await queuedRefresh;
            activeAdmission = current;
            let active = true;
            let timer: ReturnType<typeof setTimeout> | undefined;
            const finish = () => {
                active = false;
                if (admission === current) admission = undefined;
                if (activeAdmission === current) activeAdmission = undefined;
                release();
            };
            try {
                const state = await refreshNow();
                if (state.blockers.length)
                    throw new ServiceError("runtime_unsafe", 503, state.blockers.join(", "));
                const assertCurrent = () => {
                    if (
                        !active ||
                        stopped ||
                        now() < state.checkedAt ||
                        now() - state.checkedAt >= config.reconcileIntervalMs
                    )
                        throw new ServiceError(
                            "runtime_unsafe",
                            503,
                            stopped ? "runtime_stopped" : "runtime_stale",
                        );
                };
                timer = setTimeout(finish, state.checkedAt + config.reconcileIntervalMs - now());
                return await work(assertCurrent);
            } finally {
                if (timer) clearTimeout(timer);
                finish();
            }
        },
        async dispose() {
            stop();
            await admission;
            await pending;
            await settlement;
            await turns;
            await wallet?.dispose();
            wallet = undefined;
        },
    };
}
