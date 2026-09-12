import type { Database } from "better-sqlite3";

const sdkTransactions = new WeakSet<Database>();

export class DatabaseBusyError extends Error {
    readonly code = "database_busy";
    readonly retryable = true;

    constructor() {
        super("database is busy with another transaction owner; retry after it completes");
        this.name = "DatabaseBusyError";
    }
}

export function assertNativeAccess(db: Database): void {
    if (sdkTransactions.has(db)) throw new DatabaseBusyError();
}

export function withSdkAccess<T>(db: Database, sql: string, execute: () => T): T {
    const begins = /^\s*BEGIN\b/i.test(sql);
    if ((db.inTransaction && !sdkTransactions.has(db)) || (begins && sdkTransactions.has(db)))
        throw new DatabaseBusyError();
    try {
        const result = execute();
        if (begins && db.inTransaction) sdkTransactions.add(db);
        return result;
    } finally {
        if (!db.inTransaction) sdkTransactions.delete(db);
    }
}
