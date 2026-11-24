import { advanceKind } from "./ledger.js";
import type { Advance } from "./types.js";

/** Whether a covenant may still be renewed at `now`, wall-clock unix seconds. Within
 * `guardSeconds` of the reclaim CLTV the coin belongs to recovery, which a renewal
 * moving its outpoint would race. */
export const renewable = (advance: Advance, now: bigint, guardSeconds: bigint): boolean =>
    advance.state === "locked" &&
    advanceKind(advance) === "covenant" &&
    advance.failureCode === undefined &&
    advance.recoveryLocktime?.kind === "time" &&
    advance.recoveryLocktime.value - now > guardSeconds;
