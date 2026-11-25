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

/** Due once the coin's observed expiry is inside the window. A height expiry cannot be
 * measured against a window in seconds, so it is never due. */
export const renewalDue = (
    advance: Advance,
    expiry: ExpiryDeadline | undefined,
    now: bigint,
    window: { beforeExpirySeconds: bigint; guardSeconds: bigint },
): boolean =>
    renewable(advance, now, window.guardSeconds) &&
    expiry?.kind === "time" &&
    expiry.value - now <= window.beforeExpirySeconds;
