import { canSpendOffchain, type ExtendedVirtualCoin } from "@arkade-os/sdk";
import type { ExpiryDeadline, Outpoint } from "@arkade-taxi/core";
import { ServiceError } from "../errors.js";
import { normalizeExpiry } from "./providers.js";
import type { RuntimeSafety } from "./types.js";

export interface FundingSelection {
    inputs: ExtendedVirtualCoin[];
    totalValue: bigint;
    batchExpiry: ExpiryDeadline;
}

export function assertFreshSafety(safety: RuntimeSafety, nowMs: number, maxAgeMs: number): void {
    if (
        !safety ||
        !safety.walletSynced ||
        !safety.providerIdentityOk ||
        safety.blockers.length ||
        !Number.isFinite(safety.checkedAt) ||
        nowMs < safety.checkedAt ||
        nowMs - safety.checkedAt >= maxAgeMs ||
        safety.chainHeight === null ||
        safety.chainTime === null ||
        safety.chainHeight < 0n ||
        safety.chainHeight > BigInt(Number.MAX_SAFE_INTEGER) ||
        safety.chainTime <= 0n ||
        safety.chainTime > 8640000000000n
    )
        throw new ServiceError(
            "runtime_unsafe",
            503,
            "fresh verified wallet and chain state required",
        );
}

export function selectOperatorFunding(options: {
    spendable: readonly ExtendedVirtualCoin[];
    reserved: readonly Outpoint[];
    requiredSats: bigint;
    safety: RuntimeSafety;
    nowMs: number;
    maxSnapshotAgeMs: number;
    minExpiryHeadroomBlocks: bigint;
    minExpiryHeadroomSeconds: bigint;
    minReserveSats: bigint;
}): FundingSelection {
    const { safety, requiredSats, minReserveSats } = options;
    assertFreshSafety(safety, options.nowMs, options.maxSnapshotAgeMs);
    if (requiredSats <= 0n || minReserveSats < 0n)
        throw new Error("inventory: invalid funding requirement");
    const reserved = new Set(options.reserved.map(outpointKey));
    const seen = new Set<string>();
    const candidates: { coin: ExtendedVirtualCoin; expiry: ExpiryDeadline }[] = [];
    for (const coin of options.spendable) {
        const key = outpointKey(coin);
        if (seen.has(key))
            throw new ServiceError("runtime_unsafe", 503, "duplicate wallet outpoint");
        seen.add(key);
        if (
            !/^[0-9a-f]{64}$/.test(coin.txid) ||
            !Number.isInteger(coin.vout) ||
            coin.vout < 0 ||
            coin.vout > 0xffff_ffff
        )
            continue;
        if (reserved.has(key) || coin.assets?.length) continue;
        if (!Number.isSafeInteger(coin.value) || coin.value <= 0) continue;
        let expiry: ExpiryDeadline;
        try {
            expiry = normalizeExpiry(coin);
        } catch {
            continue;
        }
        const clock = expiry.kind === "height" ? safety.chainHeight! : safety.chainTime!;
        const headroom =
            expiry.kind === "height"
                ? options.minExpiryHeadroomBlocks
                : options.minExpiryHeadroomSeconds;
        if (
            expiry.value - clock < headroom ||
            !canSpendOffchain(coin, {
                height: Number(safety.chainHeight),
                timestamp: new Date(Number(safety.chainTime) * 1000),
            })
        )
            continue;
        candidates.push({ coin, expiry });
    }
    const available = candidates.reduce((sum, { coin }) => sum + BigInt(coin.value), 0n);
    // Expiry domains have no shared ordering; use a stable domain preference.
    for (const kind of ["height", "time"] as const) {
        const group = candidates
            .filter((c) => c.expiry.kind === kind)
            .sort(
                (a, b) =>
                    compare(a.expiry.value, b.expiry.value) ||
                    compare(a.coin.value, b.coin.value) ||
                    compare(a.coin.txid, b.coin.txid) ||
                    compare(a.coin.vout, b.coin.vout),
            );
        const inputs: ExtendedVirtualCoin[] = [];
        let totalValue = 0n;
        for (const { coin } of group) {
            inputs.push(coin);
            totalValue += BigInt(coin.value);
            if (totalValue >= requiredSats) break;
        }
        if (totalValue >= requiredSats && available - totalValue >= minReserveSats)
            return { inputs, totalValue, batchExpiry: group[0].expiry };
    }
    throw new ServiceError(
        "operator_inventory_insufficient",
        503,
        "insufficient compatible safe inventory after reservations and reserve",
    );
}

const outpointKey = (outpoint: Outpoint): string => `${outpoint.txid}:${outpoint.vout}`;
const compare = <T extends bigint | number | string>(a: T, b: T): number =>
    a < b ? -1 : a > b ? 1 : 0;
