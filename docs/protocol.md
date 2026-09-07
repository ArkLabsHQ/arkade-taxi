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

Request: `receiverKey`, `senderKey`, optional `assetId`, and `senderSats` — the
sats the sender contributes toward the dust unit, `0` for a pure-asset payment
where the operator funds the whole thing.

Response: `transferId`, the full covenant `params`, the derived
`covenantAddress`, `feeSats`, `expiresAt`, and `unsignedLockupTx` — a base64
PSBT with the operator's topup input already contributed.

The lockup output is jointly funded: the sender brings the asset and any sats
remainder, the operator brings `topup`. Outputs are the covenant at `dust`, the
operator's fee, and sender change.

## `POST /v1/transfers/:id/lockup`

The client returns the PSBT with its own inputs signed. The operator co-signs
and submits, and responds with the txid and the covenant outpoint.

## `GET /v1/transfers/:id`

Current ledger state.

## No claim or refund endpoints

Both are client-side by construction. Every leaf is
`Multisig[server, ⊕script]` — the operator is a payout destination, never a
signer — so a receiver claims with Arkade Service and emulator signatures alone,
and a sender refunds with its own signature plus those two.

The service only watches for the spend and reconciles.

## Verification

`verifyQuote` in `@arkade-taxi/client` rebuilds the covenant from the quoted
parameters and refuses unless the derived address equals `covenantAddress`. It
also checks the quoted receiver, sender and asset against what the caller asked
to pay, and that `topup`, `feeSats` and `locktime` are within the caller's
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
