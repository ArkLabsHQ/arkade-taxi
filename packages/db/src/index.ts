import DatabaseCtor from "better-sqlite3";
import type { Database } from "better-sqlite3";
import { applyMigrations } from "./schema";

export {
    AdvanceRepository,
    type AdvanceRepositoryOptions,
    type PreparedRecoveryRecord,
} from "./advances";
export {
    CustodyError,
    CustodyReleaseInputConflictError,
    CustodyRepository,
    CustodySweptError,
    openCustodyRow,
    type CustodyCode,
    type CustodyLiabilities,
    type CustodyRecord,
    type CustodyState,
} from "./custody";
export { DEFAULT_POLICY, PolicyRepository, type AuditRow, type PolicySnapshot } from "./policy";
export {
    ReservationRepository,
    ReservationConflictError,
    PolicyRevisionConflictError,
    RecoveryBudgetConflictError,
    LockupClaimError,
    QuoteAdmissionError,
    totalExposure,
    type LockupClaimResult,
    type QuoteAdmissionCode,
    type ReserveQuoteRequest,
} from "./reservations";
export { ADVANCE_STATES, applyMigrations, MIGRATIONS, type Migration } from "./schema";
export {
    FillRepository,
    FillClaimError,
    FillReservationConflictError,
    type Fill,
    type FillAssetId,
    type FillFare,
    type FillGraph,
    type FillOutpoint,
    type FillState,
} from "./fills";
export { assetRulesFromJson, assetRulesToJson } from "./assetRules";
export type { Database } from "better-sqlite3";
export { assertNativeAccess, withSdkAccess, DatabaseBusyError } from "./coordination";

/** `path` may be `":memory:"`. Every INTEGER read on the returned handle is a
 * BigInt: sats above 2^53 do not survive the default number mode. */
export function openDatabase(path: string): Database {
    const db = new DatabaseCtor(path);
    db.pragma("journal_mode = WAL");
    db.pragma("synchronous = FULL");
    db.defaultSafeIntegers(true);
    applyMigrations(db);
    return db;
}
export * from "./proceeds";
export * from "./receiveQuotes";
