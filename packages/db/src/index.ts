import DatabaseCtor from "better-sqlite3";
import type { Database } from "better-sqlite3";
import { applyMigrations } from "./schema.js";

export { AdvanceRepository, type PreparedRecoveryRecord } from "./advances.js";
export { DEFAULT_POLICY, PolicyRepository, type AuditRow, type PolicySnapshot } from "./policy.js";
export {
    ReservationRepository,
    ReservationConflictError,
    PolicyRevisionConflictError,
    RecoveryBudgetConflictError,
    LockupClaimError,
    type LockupClaimResult,
    type ReserveQuoteRequest,
} from "./reservations.js";
export { ADVANCE_STATES, applyMigrations, MIGRATIONS, type Migration } from "./schema.js";
export { assetRulesFromJson, assetRulesToJson } from "./assetRules.js";
export type { Database } from "better-sqlite3";
export { assertNativeAccess, withSdkAccess, DatabaseBusyError } from "./coordination.js";

/** `path` may be `":memory:"`. Every INTEGER read on the returned handle is a
 * BigInt: sats above 2^53 do not survive the default number mode. */
export function openDatabase(path: string): Database {
    const db = new DatabaseCtor(path);
    db.defaultSafeIntegers(true);
    applyMigrations(db);
    return db;
}
export * from "./proceeds.js";
