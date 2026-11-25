import { advanceKind } from "./ledger.js";
import type { Advance, ExpiryDeadline } from "./types.js";

/** Whether a covenant may still be renewed at `now`, wall-clock unix seconds. Within
 * `guardSeconds` of the reclaim CLTV the coin belongs to recovery, which a renewal
 * moving its outpoint would race. */
export const renewable = (advance: Advance, now: bigint, guardSeconds: bigint): boolean =>
    advance.state === "locked" &&
    advanceKind(advance) === "covenant" &&
    advance.failureCode === undefined &&
    advance.recoveryLocktime?.kind === "time" &&
    advance.recoveryLocktime.value - now > guardSeconds;

/** Due once the coin's expiry is inside the window, capped at half the coin's own life: a
 * successor is born with all of it left, so a renewal cannot make it due at once. A coin
 * whose life cannot be measured in seconds, height expiry or unknown birth, is never due. */
export const renewalDue = (
    advance: Advance,
    coin: { expiry?: ExpiryDeadline; createdAt?: bigint } | undefined,
    now: bigint,
    window: { beforeExpirySeconds: bigint; guardSeconds: bigint },
): boolean => {
    const expiry = coin?.expiry;
    if (expiry?.kind !== "time" || coin?.createdAt === undefined) return false;
    const half = (expiry.value - coin.createdAt) / 2n;
    return (
        renewable(advance, now, window.guardSeconds) &&
        expiry.value - now <=
            (half < window.beforeExpirySeconds ? half : window.beforeExpirySeconds)
    );
};
