import type { Fill } from "@arkade-taxi/db";
import type { FillDeps } from "../src/fills.js";

/** The fills store, in memory, for route tests that stub the whole database. */
export class MemoryFills {
    readonly rows = new Map<string, Fill>();

    insert(fill: Fill): void {
        this.rows.set(fill.id, structuredClone(fill));
    }
    get(id: string): Fill | undefined {
        const row = this.rows.get(id);
        return row && structuredClone(row);
    }
    getByOperation(operationId: string): Fill | undefined {
        for (const row of this.rows.values())
            if (row.operationId === operationId) return structuredClone(row);
        return undefined;
    }
    #held(id: string, leaseToken: string): Fill | undefined {
        const row = this.rows.get(id);
        return row?.state === "submitting" && row.leaseToken === leaseToken ? row : undefined;
    }
    recordPrepared(
        id: string,
        leaseToken: string,
        arkTx: string,
        checkpoints: string[],
        now: number,
    ): boolean {
        const row = this.#held(id, leaseToken);
        if (!row) return false;
        Object.assign(row, {
            preparedArkTx: arkTx,
            preparedCheckpoints: [...checkpoints],
            updatedAt: now,
        });
        return true;
    }
    recordSubmitInvoked(id: string, leaseToken: string, now: number): boolean {
        const row = this.#held(id, leaseToken);
        if (!row) return false;
        Object.assign(row, { submitInvoked: true, updatedAt: now });
        return true;
    }
    recordSubmitted(id: string, leaseToken: string, txid: string, now: number): boolean {
        const row = this.#held(id, leaseToken);
        if (!row) return false;
        Object.assign(row, { txid, updatedAt: now });
        return true;
    }
    recordSettled(
        id: string,
        leaseToken: string,
        txid: string,
        outpoint: { txid: string; vout: number },
        now: number,
    ): Fill {
        const row = this.#held(id, leaseToken);
        if (!row) throw new Error(`fill ${id}: invalid_state`);
        Object.assign(row, { state: "settled", txid, outpoint, updatedAt: now });
        delete row.leaseOwner;
        delete row.leaseToken;
        return structuredClone(row);
    }
    recordAmbiguous(
        id: string,
        leaseToken: string,
        code: string,
        detail: string,
        nextAttemptAt: number,
        now: number,
    ): void {
        const row = this.#held(id, leaseToken);
        if (!row) return;
        Object.assign(row, {
            failureCode: code,
            failureDetail: detail,
            nextAttemptAt,
            updatedAt: now,
        });
        delete row.leaseOwner;
        delete row.leaseToken;
    }
    recordSigningFailure(
        id: string,
        leaseToken: string,
        code: string,
        detail: string,
        now: number,
    ): void {
        const row = this.#held(id, leaseToken);
        if (!row) return;
        Object.assign(row, {
            state: "cancelled",
            failureCode: code,
            failureDetail: detail,
            submitInvoked: false,
            updatedAt: now,
        });
        delete row.leaseOwner;
        delete row.leaseToken;
    }
    expire(at: number): number {
        let count = 0;
        for (const row of this.rows.values())
            if (row.state === "submitting" && !row.submitInvoked && row.expiresAt <= at) {
                row.state = "expired";
                count++;
            }
        return count;
    }
}

/** A `FillDeps` no test in this file's callers drives: it exists so `RouteDeps`
 * is complete for the routes they do drive. */
export const idleFillDeps = (over: Partial<FillDeps>): FillDeps =>
    ({
        inventory: { getLockedVtxoOutpoints: async () => [] },
        senderInventory: { getVtxos: async () => ({ vtxos: [] }) },
        nowMs: () => Date.now(),
        taxiIdentity: () => {
            throw new Error("fill route is not driven by this suite");
        },
        emulator: {
            submitTx: async () => {
                throw new Error("fill route is not driven by this suite");
            },
        },
        arkProvider: {
            submitTx: async () => {
                throw new Error("fill route is not driven by this suite");
            },
            finalizeTx: async () => {},
        },
        providerLimits: async () => ({ vtxoMaxAmount: -1n }),
        leaseSeconds: 60,
        ...over,
    }) as FillDeps;
