# Wire protocol

HTTP/REST, operator-orchestrated. Amounts cross the wire as **decimal strings**
and byte fields as **lowercase hex**: JSON has no bigint, and a sats value
silently losing precision above 2^53 is a bug that only appears on a large
payment.

## `GET /v1/info`

Returns the operator, Arkade Service and emulator public keys and endpoints,
plus `dust`, `vtxoMinAmount`, the asset allowlist, the fee schedule and limits.

The server and emulator keys are here because a client cannot re-derive the
covenant address without them. **A client must check both against ones it
already trusts** — see [Verification](#verification).

## `POST /v1/transfers`

Request: `receiverKey`, `senderKey`, `senderSats`, exact `senderInputs` funding
facts and optional `assetId`, `assetUnits` and `fareId`. Each input carries its
outpoint, value, tree, spend leaf, tagged expiry and asset packet when present.
Taxi verifies this evidence against the indexer and atomically reserves its
own inputs. Outstanding-sat and concurrent-advance capacity is checked atomically
again when a quote is claimed for lockup. Quote expiry releases only unsubmitted
reservations; ambiguous submitted work retains them.

Response: `transferId`, the full covenant `params`, the derived
`covenantAddress`, fare terms, `expiresAt`, and `unsignedLockupTx` — a base64
versioned envelope containing the joint Arkade transaction, checkpoints and
funding graph. It is not a single PSBT. `expiresAt` is the quote deadline in
Unix seconds; the tagged VTXO batch expiry and recovery locktime are separate.

The lockup output is jointly funded: the sender brings the asset and any sats
remainder, the operator brings `topup`. Outputs are the covenant at `dust`, the
operator's fare output, and sender and operator change. In v1 the operator funds
the sats fare itself: it is a self-payment, not customer revenue. An asset fare
is funded by sender asset units and is operator revenue; the operator supplies
its hosting sats. Omitting `assetUnits` transfers the sender's remaining units
of the payment asset after any fare in that asset. The envelope records that
resolved quantity, which the client independently verifies before signing.

## `POST /v1/transfers/:id/lockup`

The client returns the envelope with the joint Arkade transaction signed only at
its input indexes and checkpoint input 0 pre-signed only for its original
inputs. The POST verifies and atomically persists that exact envelope, then
returns without an inline provider call. A leased worker signs only the
operator's corresponding inputs and checkpoints, persists that prepared
payload, submits through Arkade Service, validates and persists the returned
Arkade transaction and server checkpoints, combines the correct owner checkpoint
signature, and finalizes. Restarts resume from the persisted phase.

The submitted envelope is canonicalized before the atomic claim. Duplicate
JSON keys are invalid; insignificant JSON whitespace and valid outer-base64
padding/transport whitespace produce the same persisted bytes and digest.
Transient provider ambiguity retries with bounded exponential backoff. A graph,
signature, persisted-artifact or provider-response validation failure is
quarantined and pauses admission rather than being retried.

The response contains the candidate txid and covenant outpoint. HTTP 202 means
the exact outpoint is not yet observed spendable and the transfer remains
`locking`; identical retries are safe. HTTP 200 means it is already `locked`.

Transfer status can include `submissionPhase`, `failureCode`, and
`failureDetail` when operator action is required.

## `GET /v1/transfers/:id`

Current ledger state and retained submission, recovery, failure and observation
facts. The lifecycle is `quoted` → `locking` → `locked`, then an observed
`recycled`, `purchased` or `refunded` spend, or `recovering` → observed
`recovered`. Unsubmitted quotes can become `expired`. A candidate transaction
ID, HTTP success or stream notification is not a terminal-state proof.

## `GET /v1/claims`

Read-only receiver discovery. Pass repeated URL-encoded `receiver` query keys,
for example `/v1/claims?receiver=<address-a>&receiver=<address-b>`. A batch must
contain 1–64 unique canonical Arkade addresses for Taxi's configured network and
Arkade server key; duplicate addresses are deduplicated. Invalid batches return
HTTP 400 with `invalid_receiver_batch`.

The snapshot is `{ "claims": [...] }` containing active `locking`, `locked` and
`recovering` transfers for those receivers. Each entry identifies the transfer,
receiver, ledger state and update time. A validated locked transfer includes the
public descriptor needed for independent claim verification. `locking` and
`recovering` entries are not claimable. Discovery is not proof that an output is
currently spendable.

## `GET /v1/claims/events`

A batched Server-Sent Events subscription uses the same repeated `receiver`
query keys and validation. One connection covers the whole batch. The initial
`claims-snapshot` event contains `{ "claims": [...] }` with active transfers;
subsequent `claims-changed` events use the same shape and include changed active
or terminal transfers. Terminal entries are not claimable. Clients should
replace their active snapshot on connection or reconnect and apply changes by
`transferId`; this is not a durable event replay or terminal-state proof.

Both discovery endpoints are unauthenticated. Anyone who knows a receiver
address can discover its Taxi transfer metadata, amounts and public claim
descriptors; putting multiple addresses in one query can also correlate them
in server, proxy or access logs. Treat receiver addresses and discovery URLs as
privacy-sensitive. Discovery neither authenticates a receiver nor authorizes
a payment or spend.

The client must run `verifyIncomingClaim` with independently trusted provider
pins and fresh chain/indexer evidence before calling its local verified
`purchase` or `recycle` flow. HTTP data and SSE notifications cannot replace
that verification or the caller's payment authorization.

## No claim-spend or refund-submission endpoints

Both are client-side by construction. Every leaf is
`Multisig[server, ⊕script]` — the operator is a payout destination, never a
signer — so a receiver claims with Arkade Service and emulator signatures alone,
and a sender refunds with its own signature plus those two.

The service validates the canonical spending transaction, signatures, covenant
leaf, pinned outputs, assets and repayment before reconciling. Its own recovery
worker persists and submits the exact permissionless recovery graph after the
tagged locktime and before batch expiry. Warning/critical deadlines close
unsafe admission and remain visible through readiness and the admin API.

Taxi owns recovery before expiry. The deployed Arkade Service's special
covenant settlement remains an external assumption verified by the complete
live deployment gate; Taxi does not implement an upstream forfeit mechanism.

## Verification

`verifyQuote` in `@arkade-taxi/client` rebuilds the covenant from the quoted
parameters and refuses unless the derived address equals `covenantAddress`. It
also checks the quoted receiver, sender and asset against what the caller asked
to pay, and that `topup`, fare currency/asset/units and `locktime` are within the caller's
authorisation.

The address check alone is not sufficient. It is only meaningful once the client
has pinned `serverKey` and `emulatorKey` against values it already trusts —
otherwise an operator could name an emulator it controls and the derivation
would agree with itself.

The client API is shaped to make skipping this awkward: submitting a lockup
requires a value obtainable only from `verifyQuote`.

## Transaction-building constraints

These come from the upstream covenant work and cost several iterations to find:

- **Never put two outputs with the same script in one transaction.** Sighash
  commits to the prevout amount and the wallet resolves inputs by script, taking
  the first match, so the second output signs for the wrong amount.
- **Wait on the outpoints, not the transaction.** A transaction is returned
  before arkd has registered its outputs as spendable.
- **`PrevArkTxField` must be set per input**, or `OP_INSPECTINPUTSCRIPTPUBKEY`
  cannot resolve the input it inspects — it reads the virtual-output prevout
  script path, not the generic one.
