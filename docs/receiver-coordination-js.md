# Receiver coordination for JavaScript wallets

Use this adapter with [Bob's receiving flow](integration-js.md#bob-subscribe-verify-claim).
Save that example as `receiver.ts` and this implementation as
`receiver-store.ts`. Supply `createReceiverStore(walletNetworkKey)` to Bob.
Web Locks serialize atomic updates across tabs; each update is persisted before
its caller continues. Use one stable wallet/network storage key across Taxi providers; operation IDs
include the Taxi URL. This local
example requires a secure browser context with Web Locks and persistent
localStorage; every spend path using this wallet must share the reservation
authority. For a multi-device wallet, implement the same interface in its shared
transactional store.

`ReceiverCoordinator.claimOnce` atomically deduplicates a transfer before running its
preparation; `reserveFunding` atomically excludes outpoints already reserved or
observed spent. `coordinateClaim` persists the submission lifecycle and releases
funding only after a definite pre-submission failure or exact canonical observation.
It holds no shared lock during verification, signing or observation, so independent
claims can progress concurrently. The preparation callback must never submit.
The supplied `observeSpend` resolves only after trusted canonical evidence confirms
the exact transaction and consumption of the reserved outpoint. Observation or
storage errors after submission retain the reservation. A multi-descriptor wallet
must supply each reserved input's own signing identity.

```ts
// receiver-store.ts
import {
    CovenantSpendAmbiguousError,
    fundingInputsFromVtxos,
    type ReceiverWalletInput,
} from "@arkade-taxi/client";
import type { IWallet } from "@arkade-os/sdk";

export type PendingClaim = {
    transferId: string;
    expectedTxid?: string;
    fundingOutpoint?: { txid: string; vout: number };
};
export interface ReceiverCoordinator {
    claimOnce(id: string, operation: () => Promise<void>): Promise<void>;
    reserveFunding(
        id: string,
        candidates: readonly ReceiverWalletInput[],
    ): Promise<ReceiverWalletInput>;
    submitting(id: string): Promise<void>;
    submitted(id: string, txid: string): Promise<void>;
    retainAmbiguous(id: string, expectedTxid: string): Promise<void>;
    failedBeforeSubmission(id: string): Promise<void>;
    observedSpend(id: string, txid: string): Promise<void>;
    pending(): Promise<PendingClaim[]>;
}

export type ObserveSpend = (
    txid: string,
    funding?: PendingClaim["fundingOutpoint"],
) => Promise<void>;

export async function receiverFundingCandidates(
    wallet: IWallet,
    destination: Uint8Array,
    minimum: bigint,
) {
    const script = Array.from(destination, (byte) => byte.toString(16).padStart(2, "0")).join("");
    return (await wallet.getSpendableVtxos())
        .filter(
            (coin) =>
                coin.script === script && !coin.assets?.length && BigInt(coin.value) >= minimum,
        )
        .map((coin) => {
            const [{ expiry, spendLeaf, ...input }] = fundingInputsFromVtxos([coin]);
            return {
                input: { ...input, tapLeafScript: coin.forfeitTapLeafScript },
                expiry,
                identity: wallet.identity,
            };
        });
}

export function coordinateClaim(
    store: ReceiverCoordinator,
    id: string,
    prepare: () => Promise<{ funding?: ReceiverWalletInput; submit: () => Promise<string> }>,
    observeSpend: ObserveSpend,
): Promise<void> {
    return store.claimOnce(id, async () => {
        let submitted = false;
        try {
            const plan = await prepare();
            await store.submitting(id);
            let txid: string;
            try {
                txid = await plan.submit();
                submitted = true;
                await store.submitted(id, txid);
            } catch (error) {
                if (!(error instanceof CovenantSpendAmbiguousError)) throw error;
                submitted = true;
                txid = error.expectedTxid;
                await store.retainAmbiguous(id, txid);
            }
            await observeSpend(txid, plan.funding?.input);
            await store.observedSpend(id, txid);
        } catch (error) {
            if (!submitted) await store.failedBeforeSubmission(id);
            throw error;
        }
    });
}

type RecordState = {
    phase: "running" | "submitting" | "submitted" | "ambiguous" | "done" | "failed";
    expectedTxid?: string;
    fundingOutpoint?: PendingClaim["fundingOutpoint"];
};
type State = { claims: Map<string, RecordState>; spent: Set<string> };
const outpointKey = (point: { txid: string; vout: number }) => `${point.txid}:${point.vout}`;

export function createReceiverStore(storageKey: string): ReceiverCoordinator {
    const transaction = <T>(update: (state: State) => T): Promise<T> =>
        navigator.locks.request("taxi-receiver:" + storageKey, () => {
            const saved = localStorage.getItem(storageKey);
            const raw = saved ? JSON.parse(saved) : { claims: [], spent: [] };
            const state: State = { claims: new Map(raw.claims), spent: new Set(raw.spent) };
            const result = update(state);
            localStorage.setItem(
                storageKey,
                JSON.stringify({
                    claims: [...state.claims],
                    spent: [...state.spent],
                }),
            );
            return result;
        });
    const requireClaim = (state: State, id: string) => {
        const record = state.claims.get(id);
        if (!record) throw new Error("Missing durable claim");
        return record;
    };
    const recordSubmission = (id: string, txid: string, phase: "submitted" | "ambiguous") =>
        transaction((state) => {
            const record = requireClaim(state, id);
            if (record.phase !== "submitting") throw new Error("Claim is not submitting");
            record.phase = phase;
            record.expectedTxid = txid;
        });
    return {
        async claimOnce(id, operation) {
            const acquired = await transaction((state) => {
                if (state.claims.has(id)) return false;
                state.claims.set(id, { phase: "running" });
                return true;
            });
            if (acquired) await operation();
        },
        reserveFunding(id, candidates) {
            return transaction((state) => {
                const record = requireClaim(state, id);
                if (record.phase !== "running" || record.fundingOutpoint)
                    throw new Error("Claim cannot reserve funding");
                const held = new Set(
                    [...state.claims.values()].flatMap((record) =>
                        record.fundingOutpoint ? [outpointKey(record.fundingOutpoint)] : [],
                    ),
                );
                const selected = candidates.find(
                    (candidate) =>
                        !held.has(outpointKey(candidate.input)) &&
                        !state.spent.has(outpointKey(candidate.input)),
                );
                if (!selected) throw new Error("No unreserved sats input");
                record.fundingOutpoint = { txid: selected.input.txid, vout: selected.input.vout };
                return selected;
            });
        },
        submitting(id) {
            return transaction((state) => {
                const record = requireClaim(state, id);
                if (record.phase !== "running") throw new Error("Claim already attempted");
                record.phase = "submitting";
            });
        },
        submitted: (id, txid) => recordSubmission(id, txid, "submitted"),
        retainAmbiguous: (id, txid) => recordSubmission(id, txid, "ambiguous"),
        failedBeforeSubmission(id) {
            return transaction((state) => {
                const record = requireClaim(state, id);
                if (record.phase !== "running" && record.phase !== "submitting")
                    throw new Error("Cannot release a possibly submitted input");
                record.phase = "failed";
                delete record.fundingOutpoint;
            });
        },
        observedSpend(id, txid) {
            return transaction((state) => {
                const record = requireClaim(state, id);
                if (
                    record.expectedTxid !== txid ||
                    (record.phase !== "submitted" && record.phase !== "ambiguous")
                )
                    throw new Error("Observation does not match pending submission");
                if (record.fundingOutpoint) state.spent.add(outpointKey(record.fundingOutpoint));
                delete record.fundingOutpoint;
                record.phase = "done";
            });
        },
        pending() {
            return transaction((state) =>
                [...state.claims].flatMap(([transferId, record]) =>
                    record.phase === "done" || record.phase === "failed"
                        ? []
                        : [
                              {
                                  transferId,
                                  expectedTxid: record.expectedTxid,
                                  fundingOutpoint: record.fundingOutpoint,
                              },
                          ],
                ),
            );
        },
    };
}

export async function resumeReceiver(
    store: ReceiverCoordinator,
    observeSpend: ObserveSpend,
    onError: (error: unknown) => void,
) {
    for (const pending of await store.pending()) {
        if (!pending.expectedTxid) continue;
        const txid = pending.expectedTxid;
        void Promise.resolve()
            .then(() => observeSpend(txid, pending.fundingOutpoint))
            .then(() => store.observedSpend(pending.transferId, txid))
            .catch(onError);
    }
}
```

Run `resumeReceiver(store, observeSpend, onError)` after restart. It starts each
known observation independently and returns after dispatch, so an unobserved
claim cannot block other reconciliation or a new subscription. A crash with no
recorded transaction ID leaves the claim and funding reserved for explicit
reconciliation; absence of a transaction is not proof that submission failed.
Do not clear this storage to retry. Failed claims also need explicit retry
policy. The implementation retains spent outpoint tombstones so stale wallet
snapshots cannot select canonically consumed inputs. Storage failure stops
progress; production stores should manage retention without weakening these
invariants.
