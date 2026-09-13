import { AsyncLocalStorage } from "node:async_hooks";

const context = new AsyncLocalStorage();

export function ownedPayoutOutpoints(rows) {
    return rows.flatMap((row) => {
        if (
            !["recycled", "purchased", "refunded", "recovered"].includes(row.state) ||
            !row.arkTxid ||
            !row.spentTxid
        )
            return [];
        return [
            ...(BigInt(row.fare.units) > 0n ? [{ txid: row.arkTxid, vout: 1 }] : []),
            ...(row.state !== "purchased" ? [{ txid: row.spentTxid, vout: 0 }] : []),
        ];
    });
}

export function assertScenarioBoundary(rows) {
    const active = rows.find((row) =>
        ["quoted", "locking", "locked", "recovering"].includes(row.state),
    );
    if (active)
        throw new Error(`prior scenario still owns active advance ${active.id} (${active.state})`);
}

export async function unwindAll(items, release) {
    const errors = [];
    for (const item of items) {
        try {
            await release(item);
        } catch (error) {
            errors.push(error);
        }
    }
    if (errors.length)
        throw new AggregateError(errors, "owned advance cleanup failed", { cause: errors[0] });
}

export function ownCleanup(cleanup) {
    const scope = context.getStore();
    if (!scope) throw new Error("cleanup requires an active scenario");
    let pending;
    const close = () =>
        (pending ??= Promise.resolve()
            .then(cleanup)
            .catch((error) => {
                scope.errors.push(error);
            }));
    scope.cleanups.push(close);
    return close;
}

export async function runWithCleanup(work) {
    return context.run({ cleanups: [], errors: [] }, async () => {
        const scope = context.getStore();
        let value;
        let failure;
        let failed = false;
        try {
            value = await work();
        } catch (error) {
            failed = true;
            failure = error;
        }
        for (const cleanup of [...scope.cleanups].reverse()) await cleanup();
        if (scope.errors.length)
            throw new AggregateError(
                [...(failed ? [failure] : []), ...scope.errors],
                `${failure?.message ?? "scenario cleanup failed"}; ${scope.errors.map((error) => error?.message ?? String(error)).join("; ")}`,
                { cause: failed ? failure : scope.errors[0] },
            );
        if (failed) throw failure;
        return value;
    });
}
