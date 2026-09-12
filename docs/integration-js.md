# Integrating `@arkade-taxi/client`

Taxi supplies the sats needed to carry an Arkade asset in a covenant VTXO.
Alice funds the asset payment; Bob claims it into his existing Arkade account.
Taxi either receives its sats back when Bob recycles, or earns an agreed fare
at lockup when Bob purchases. Both wallets need access to their trusted Arkade
Service and emulator as well as Taxi.

## Recycle: send 200 USDT

1. Bob gives Alice his full Arkade address and Taxi URL.
2. Alice selects spendable VTXOs containing 200 USDT.
3. Alice requests and verifies the quote, then signs and submits the lockup.
   Taxi adds the required sats and Bob's feed reports the transfer as
   `locking`, then `locked` and claimable.
4. Bob verifies the incoming claim and recycles it with his own sats VTXO.
   Taxi gets its advanced sats back; Bob gets a normal VTXO holding 200 USDT
   and the remaining merged sats.

This example assumes a zero-fare recycle offer. Bob needs a compatible sats
input large enough to repay the top-up and keep his merged output above dust.

## Purchase: authorize 201 USDT, receive 200 USDT

1. Bob asks Alice for 200 USDT and supplies his Arkade address and Taxi URL.
2. Alice selects 201 USDT and authorizes a 1 USDT Taxi fare.
3. Alice requests and verifies the quote, then signs and submits the lockup.
   It pays Taxi 1 USDT immediately and puts 200 USDT in the Taxi-funded
   covenant. Bob's feed reports the claim.
4. Bob verifies and purchases the claim without adding a Bob-owned input.
   He receives 200 USDT and the Taxi-funded sats; Taxi keeps its 1 USDT fare.

The examples assume this USDT asset has six decimals. Use your verified asset
ID and metadata: the name “USDT” alone does not identify an asset.

## Alice: select, verify, submit

Install `@arkade-taxi/client` and `@arkade-os/sdk@0.4.72`. Call this function
with Alice's initialized wallet, Bob's full address, the selected offer's
`fareId`, and policy/trust facts from the wallet's own configuration.
`assetUnits` is Bob's payment quantity; the fare is additional.

```ts
import { TaxiClient, type RequestVerifiedQuoteArgs } from "@arkade-taxi/client";
import { asset, selectCoinsWithAsset, type IWallet } from "@arkade-os/sdk";

type AlicePolicy = Pick<
    RequestVerifiedQuoteArgs,
    | "receiverAddress"
    | "fareId"
    | "trustedServerKey"
    | "trustedEmulatorKey"
    | "trustedServerUnrollScript"
    | "vtxoMinAmount"
    | "hrp"
> & {
    taxiUrl: string;
    usdtId: string;
    mode: "recycle" | "purchase";
    maxTopupSats: bigint;
    minLocktime: bigint;
};

export async function sendUsdt(wallet: IWallet, policy: AlicePolicy) {
    const taxi = new TaxiClient({ baseUrl: policy.taxiUrl });
    const id = asset.AssetId.fromString(policy.usdtId);
    const assetId = { txid: Uint8Array.from(id.txid).reverse(), groupIndex: id.groupIndex };
    const fareUnits = policy.mode === "purchase" ? 1_000_000n : 0n;
    const { selected } = selectCoinsWithAsset(
        await wallet.getSpendableVtxos(),
        policy.usdtId,
        200_000_000n + fareUnits,
    );
    const { verified } = await taxi.requestVerifiedQuote({
        ...policy,
        senderKey: await wallet.identity.xOnlyPublicKey(),
        selectedVtxos: selected,
        assetId,
        assetUnits: 200_000_000n,
        expect: {
            maxTopupSats: policy.maxTopupSats,
            maxFare:
                policy.mode === "purchase"
                    ? { currency: "asset", assetId, units: fareUnits }
                    : { currency: "sats", units: 0n },
            minLocktime: policy.minLocktime,
        },
    });
    const lockup = await taxi.prepareAndSubmitLockup(verified, wallet.identity);
    return { verified, lockup };
}
```

`requestVerifiedQuote` derives the exact total sats from Alice's selected inputs;
it is funding evidence, not an amount she can choose independently. Taxi advances
the shortfall below dust, with a minimum advance of `vtxoMinAmount`. Sender change
is `input total + top-up − dust`; asset change needs at least the minimum hosting
sats. The complete graph is verified before signing and submission in one call.
Alice's application must reserve its selected inputs until the outcome is known.

## Bob: subscribe, verify, claim

Call this function with Bob's initialized wallet and the full addresses it owns.
It uses one batched SSE subscription for up to 64 distinct addresses. Both
snapshot and change events enter the same handler; only locked claims are
eligible. The expected 200 USDT and trusted keys come from Bob's payment request
and wallet configuration, independently of the inbox.

Use the durable coordinator below as `store`; it atomically deduplicates claims
and reserves each sats outpoint for at most one transfer, including across tabs
and reloads. `getSpendableVtxos` only lists candidates. The supplied
`observeSpend` resolves only after trusted canonical evidence confirms the
exact transaction and consumption of the reserved outpoint. See the compact
browser implementation in the advanced reference. Closing the returned
subscription does not cancel a claim already submitting.

**Privacy: this inbox is unauthenticated. Anyone who knows an Arkade address
can inspect its incoming Taxi transfers. URLs and batched addresses can also
expose account relationships to Taxi and infrastructure logs.**

```ts
// receiver.ts
import {
    TaxiClient,
    fundingInputsFromVtxos,
    CovenantSpendAmbiguousError,
    type CovenantSpendConfig,
    type IncomingClaimTrust,
    type ReceiverWalletInput,
} from "@arkade-taxi/client";
import { ArkAddress, asset, type IWallet } from "@arkade-os/sdk";

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

export function receiveUsdt(options: {
    wallet: IWallet;
    taxiUrl: string;
    receiverAddresses: string[];
    usdtId: string;
    mode: "recycle" | "purchase";
    trusted: IncomingClaimTrust;
    config: CovenantSpendConfig;
    store: ReceiverCoordinator;
    observeSpend: (txid: string, funding?: PendingClaim["fundingOutpoint"]) => Promise<void>;
    onError: (error: unknown) => void;
}) {
    const taxi = new TaxiClient({ baseUrl: options.taxiUrl });
    const { store } = options;
    const id = asset.AssetId.fromString(options.usdtId);
    const assetId = { txid: Uint8Array.from(id.txid).reverse(), groupIndex: id.groupIndex };
    let queue = Promise.resolve();
    const handle = (batch: Awaited<ReturnType<TaxiClient["listClaims"]>>) => {
        queue = queue
            .then(async () => {
                for (const claim of batch.claims) {
                    if (
                        !claim.claimable ||
                        claim.state !== "locked" ||
                        !options.receiverAddresses.includes(claim.receiverAddress)
                    )
                        continue;
                    const operationId = `${options.taxiUrl}:${claim.transferId}`;
                    await store
                        .claimOnce(operationId, async () => {
                            let submitted = false;
                            let funding: ReceiverWalletInput | undefined;
                            try {
                                const transfer = await taxi.verifyIncomingClaim(
                                    claim,
                                    {
                                        receiverAddress: claim.receiverAddress,
                                        assetId,
                                        assetUnits: 200_000_000n,
                                    },
                                    options.trusted,
                                    options.config,
                                );
                                const destination = ArkAddress.decode(
                                    claim.receiverAddress,
                                ).pkScript;
                                if (options.mode === "recycle") {
                                    const script = Array.from(destination, (byte) =>
                                        byte.toString(16).padStart(2, "0"),
                                    ).join("");
                                    const candidates = (await options.wallet.getSpendableVtxos())
                                        .filter(
                                            (coin) =>
                                                coin.script === script &&
                                                !coin.assets?.length &&
                                                BigInt(coin.value) >= transfer.value,
                                        )
                                        .map((coin) => {
                                            const [{ expiry, spendLeaf, ...input }] =
                                                fundingInputsFromVtxos([coin]);
                                            return {
                                                input: {
                                                    ...input,
                                                    tapLeafScript: coin.forfeitTapLeafScript,
                                                },
                                                expiry,
                                                identity: options.wallet.identity,
                                            };
                                        });
                                    funding = await store.reserveFunding(operationId, candidates);
                                }
                                await store.submitting(operationId);
                                let txid: string;
                                try {
                                    txid = funding
                                        ? await taxi.recycle(transfer, funding, destination)
                                        : await taxi.purchase(transfer, destination);
                                    submitted = true;
                                    await store.submitted(operationId, txid);
                                } catch (error) {
                                    if (!(error instanceof CovenantSpendAmbiguousError))
                                        throw error;
                                    submitted = true;
                                    txid = error.expectedTxid;
                                    await store.retainAmbiguous(operationId, txid);
                                }
                                await options.observeSpend(txid, funding?.input);
                                await store.observedSpend(operationId, txid);
                            } catch (error) {
                                if (!submitted) await store.failedBeforeSubmission(operationId);
                                throw error;
                            }
                        })
                        .catch(options.onError);
                }
            })
            .catch(options.onError);
    };
    return taxi.subscribeClaims({
        receiverAddresses: options.receiverAddresses,
        onSnapshot: handle,
        onChanged: handle,
        onError: options.onError,
    });
}
```

Bob verifies fresh Taxi and independent provider/indexer evidence; he needs no
quote or PSBT from Alice. Use the signing identity for the reserved input's
descriptor. Ordinary covenant-call errors occur before submission; ambiguous
ones retain reservations until canonical observation. Observation/storage errors
after submission also retain them.

## Who signs what?

- Taxi builds the complete Arkade transaction and every input checkpoint PSBT.
- Alice reconstructs the graph and signs only her inputs/checkpoints.
- Taxi verifies Alice, then signs only Taxi inputs/checkpoints.
- Batch signers may use one `signMultiple` prompt.
- Every signature is `SIGHASH_DEFAULT`, not `SINGLE | ANYONECANPAY`.
- Full-graph signing commits to the claim, fare, change, and asset allocation.
- Bob signs his sats input for recycle; purchase has no Bob-owned input.
- Covenant introspection pins Bob's output and, for recycle, Taxi repayment.

## Errors and recovery

`QuoteVerificationError` extends `TaxiError`; handle it first and never sign
a rejected quote. `TaxiError.code` identifies HTTP, transport, malformed-response
and service failures. Invalid addresses and incomplete funding evidence fail
locally before a quote request. Input-conversion errors are ordinary errors.

SSE decoding rejects a malformed batch as a whole and calls `onError`.
Transport errors also reach that callback; the browser's EventSource reconnects
and receives a fresh complete snapshot. There is no durable event replay log.
Node needs a compatible `eventSourceFactory` when EventSource is unavailable.
A UI replaces its active inbox on snapshots and applies changed records,
including terminal ones, to remove completed claims.

`CovenantSpendAmbiguousError.expectedTxid` identifies a spend that may already
have reached the emulator. Persist it and observe that exact transaction and
outpoint before recovery; do not blindly rebuild and resubmit. Apply the same
discipline to an uncertain lockup submission. Capability replay guards are
in-memory and do not replace the wallet's durable operation store.

If Bob stays offline, Taxi's persisted worker uses the permissionless recovery
leaf after the tagged locktime and before batch expiry. `recovering` means an
intent or submission exists; `recovered` requires canonical observation.
Alice can also verify her retained quote and lockup with `verifyTransfer`
and use `refund(transfer, aliceIdentity)`. There are no Taxi claim/refund
HTTP endpoints; covenant spends go directly through the public SDK providers.

## Advanced reference

### Durable browser receiver coordinator

Save the preceding example as `receiver.ts` and this implementation as
`receiver-store.ts`. Supply `createReceiverStore(walletNetworkKey)` to Bob.
Web Locks serialize atomic updates across tabs; each update is persisted before
its caller continues. Use one stable wallet/network storage key across Taxi providers; operation IDs
include the Taxi URL. This local
example requires a secure browser context with Web Locks and persistent
localStorage; every spend path using this wallet must share the reservation
authority. For a multi-device wallet, implement the same interface in its shared
transactional store.

```ts
// receiver-store.ts
import type { ReceiverCoordinator, PendingClaim } from "./receiver.js";

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
    observeSpend: (txid: string, funding?: PendingClaim["fundingOutpoint"]) => Promise<void>,
) {
    for (const pending of await store.pending()) {
        if (!pending.expectedTxid) continue;
        await observeSpend(pending.expectedTxid, pending.fundingOutpoint);
        await store.observedSpend(pending.transferId, pending.expectedTxid);
    }
}
```

Run `resumeReceiver` against trusted observation after restart. A crash with no
recorded transaction ID leaves the claim and funding reserved for explicit
reconciliation; absence of a transaction is not proof that submission failed.
Do not clear this storage to retry. Failed claims also need explicit retry
policy. The implementation retains spent outpoint tombstones so stale wallet
snapshots cannot select canonically consumed inputs. Storage failure stops
progress; production stores should manage retention without weakening these
invariants.

### Trust facts

Obtain Arkade/emulator signer keys independently from the services your wallet
already trusts, or a pinned deployment configuration. Decode their compressed
`signerPubkey` to the 32-byte x-only form. Never copy Taxi's `/v1/info`
keys into the trusted fields. Bob also pins Taxi's operator repayment key.
The address HRP and embedded server key must agree with these trusted facts.

Validate the trusted Arkade Service's `checkpointTapscript` with SDK
`assertValidServerUnrollScript` and `defaultCheckpointExitDelayPolicy`
for your locally configured network. Pass the validated `.script` to
Alice's `trustedServerUnrollScript`; Bob's `config.serverUnrollScript`
is the same validated script encoded as lowercase hex. His config also names
the trusted `arkdUrl`, `emulatorUrl`, `network` and current `chainHeight`
for height-based expiry checks.

The SDK REST providers use the realm's `globalThis.fetch`.
`TaxiClient({ fetch })` does not configure covenant provider calls.
Consequently, same-realm code that can replace or intercept the global fetch
is inside the transport trust boundary. Protect that realm, use TLS and enforce
your expected reverse proxy policy. Provider network, keys, checkpoint script,
dust, minimum amount and OP_RETURN capacity are checked again before graph
construction, owner signing and submission.

### Exact funding and wire amounts

`fundingInputsFromVtxos` accepts selected SDK `ExtendedVirtualCoin` values;
it never selects coins. Use the wallet's spendability, current chain height,
expiry headroom and reservation checks before conversion. The converter rejects
spent, swept, unrolled or incomplete coins, invalid amounts, duplicate outpoints,
wrong script/leaf proofs and ambiguous expiry. It preserves explicit
`expiresAtHeight` or converts `expiresAt: Date` to Unix seconds; the
deprecated `virtualStatus.batchExpiry` is not a substitute. Conversion alone
cannot decide whether a height deadline has passed without a current chain tip.

The converter builds canonical holdings packets from SDK `assets`, preserving
bigint quantities and the selected output index. Protocol asset IDs use
display-order txid bytes; SDK `AssetId.txid` uses the opposite byte order.
For lower-level integrations, `requestQuote`, `verifyQuote`, `signLockup`
and `submitLockup` remain public. The combined helper returns
`{ verified, senderInputs }` if the application also needs the converted inputs.

Wire amounts are decimal strings and byte fields are lowercase hex.
`verified.params` contains decoded values; `verified.quote` remains wire-shaped.
Quote `expiresAt` and verification `now` use Unix seconds. Quote validity,
covenant recovery locktime and funding batch expiry are separate deadlines;
height and time locks use different chain clocks.

### Complete graph validation and submission

Verification reconstructs the full Arkade transaction, checkpoints, claim output,
fare, change and asset allocation. Each signer signs only owned inputs. The
client rejects changed unsigned fields or metadata, reordered checkpoints,
unexpected signing keys or leaf hashes, non-default sighashes, missing owner
signatures and changed transaction IDs in the returned graph. A displayed
capability property is a snapshot, not authorization.

Each spend capability and matching outpoint/provider tuple is one-shot within
the process, including concurrent use and ambiguous results. Pre-submission
validation failures also consume the capability conservatively. Recovery after
a restart requires the application's durable record and canonical observation.
Live Arkade/emulator acceptance, recovery and settlement assumptions must be
checked with the production-artifact E2E suite in [e2e/README.md](../e2e/README.md)
for the deployed provider versions.
