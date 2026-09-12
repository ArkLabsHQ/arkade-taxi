import { withSdkAccess, type Database } from "@arkade-taxi/db";
import {
    type SQLExecutor,
    SQLiteWalletRepository,
    SQLiteContractRepository,
    SQLiteIntentRepository,
    SQLiteVirtualTxRepository,
    sanitizeTablePrefix,
} from "@arkade-os/sdk/repositories/sqlite";

const executors = new WeakMap<Database, SQLExecutor>();

function sdkRow<T>(row: unknown): T {
    if (!row) return row as T;
    return Object.fromEntries(
        Object.entries(row).map(([key, value]) => [
            key,
            typeof value === "bigint" &&
            value >= BigInt(Number.MIN_SAFE_INTEGER) &&
            value <= BigInt(Number.MAX_SAFE_INTEGER)
                ? Number(value)
                : value,
        ]),
    ) as T;
}

export function createSqlExecutor(db: Database): SQLExecutor {
    const existing = executors.get(db);
    if (existing) return existing;
    const executor: SQLExecutor = {
        async run(sql, params = []) {
            withSdkAccess(db, sql, () => db.prepare(sql).run(...params));
        },
        async get<T>(sql: string, params: unknown[] = []) {
            return withSdkAccess(db, sql, () =>
                sdkRow<T | undefined>(
                    db
                        .prepare(sql)
                        .safeIntegers(true)
                        .get(...params),
                ),
            );
        },
        async all<T>(sql: string, params: unknown[] = []) {
            return withSdkAccess(db, sql, () =>
                db
                    .prepare(sql)
                    .safeIntegers(true)
                    .all(...params)
                    .map((row) => sdkRow<T>(row)),
            );
        },
    };
    executors.set(db, executor);
    return executor;
}

export function createOperatorStorage(db: Database, prefix = "taxi_sdk_") {
    const options = { prefix: sanitizeTablePrefix(prefix) };
    const executor = createSqlExecutor(db);
    return {
        walletRepository: new SQLiteWalletRepository(executor, options),
        contractRepository: new SQLiteContractRepository(executor, options),
        intentRepository: new SQLiteIntentRepository(executor, options),
        virtualTxRepository: new SQLiteVirtualTxRepository(executor, options),
    };
}
