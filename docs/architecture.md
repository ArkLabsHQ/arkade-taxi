# Architecture

## Roles

| Party                   | Holds              | Role                                                        |
| ----------------------- | ------------------ | ----------------------------------------------------------- |
| Sender wallet           | asset, maybe sats  | requests the transfer, signs lockup inputs, can refund      |
| Operator (this service) | sats, agreed fares | fronts `topup`, co-signs lockup, sweeps on timeout          |
| Receiver wallet         | —                  | claims via `recycle` or `purchase`; offline at payment time |
| Arkade Service (arkd)   | server key         | signs every leaf                                            |
| Emulator                | emulator key       | signs a leaf iff its Arkade Script is satisfied             |

A wallet integrating this needs connectivity to **arkd and the emulator**, not
only to the operator. `GET /v1/info` returns both endpoints and both keys,
because a client cannot re-derive the covenant address without them.

## Why the service is small

Because the operator cannot censor a claim, the API surface is minimal: quote,
lockup, status. Claim and refund have no endpoints at all — they are client-side
by construction. The service watches for the spend and reconciles its ledger.

What remains is not request routing. It is **capital management**:

- an inventory of operator VTXOs to source `topup` from
- a ledger of outstanding advances
- a sweeper that runs the permissionless recovery leaf after `locktime`
- exposure caps that decide when to stop quoting

The sweeper is the only component whose failure costs the operator money rather
than merely blocking a payment.

## Ledger

```
quoted → locking → locked → { recycled | purchased | refunded }
   └──→ expired       └──→ recovering → recovered
```

Quotes reserve exact operator outpoints and admission capacity atomically;
unsubmitted expired quotes release those reservations. `locking` and
`recovering` are durable intents. `locked` requires the exact spendable indexed
covenant outpoint, and every funded terminal state requires the matching
canonical spend, signatures, scripts, assets and repayment. `expired` requires
no canonical spend: an unsubmitted quote reaches it when its deadline passes.
Submission responses and stream notifications alone cannot establish a funded
terminal state.

`locking` is durable submission intent. It never returns to `quoted`: a crash or
provider timeout can hide a transaction that already exists. Its internal
submission phase advances from `claimed` to `prepared`, `responded`, then
`finalized`. Each phase stores the exact signed envelope or provider payload
before the next network effect. A leased background worker resumes only that
persisted graph; an ambiguous submit or finalize retries the identical payload
after bounded exponential backoff. A token-bound heartbeat renews ownership
during slow signing, submission and finalization; losing the token prevents the
worker from starting another effect or persisting its stale result.

The signed envelope is decoded strictly, rejects duplicate JSON keys, and is
re-encoded with recursively sorted keys. Its digest covers exactly those
canonical persisted bytes, so transport whitespace or valid outer-base64
padding differences cannot strand a claim. A deterministic graph/signature or
provider-response validation failure changes the internal phase to `failed`,
pauses admission, and requires operator action instead of retrying. All local
prepare failures, including a signer rejection or a malformed, mutating,
non-DEFAULT, or invalid signer result, are permanent because the SDK identity
contract exposes no distinct transient signer-infrastructure error. After a
thrown submit, authenticated pending-transaction readback can recover the exact
signed graph when the upstream effect succeeded but its response was lost.
Readback is restricted to proved operator input ownership and passes the same
strict graph validation. Exact retries and finalization remain a live
deployment E2E requirement.

Databases upgraded from the pre-phase schema mark existing `locking` rows as
`legacy`. Those rows are never reconstructed or submitted automatically; they
retain reservations, block readiness, and remain eligible only for promotion
after exact covenant-outpoint observation.

The reconciler promotes `locking` to `locked` only after observing the exact
spendable covenant outpoint and retains the operator-input reservations while
the result is ambiguous.

## Exposure

Outstanding capital is the sum of `topup` over `locking`, `locked` and
`recovering` advances. Quoted reservations consume admission capacity separately.
Neither a timeout nor a successful recovery POST releases financial exposure;
canonical observation closes it. The real risks are capital lockup and recovery
failing.

## The locktime constraint

The covenant output is itself a virtual output with a batch expiry, and it
**cannot be renewed by the operator alone**: renewing means spending it, which
means satisfying a leaf. So `locktime` must be derived from the covenant VTXO's
expiry with margin, and the service must refuse to quote when it cannot leave
enough.

Taxi owns the guarantee that its covenant VTXOs are recovered before batch
expiry. It persists the exact funding, covenant and recovery facts, enforces
`recovery locktime + execution budget < batch expiry`, checks that invariant at
startup, and refuses unsafe admission. Height deadlines use chain height; time
deadlines use chain median time past. The units are never converted or compared
across domains.

The sweeper schedules eligible work by deadline urgency. Atomically persisting
the exact recovery intent changes `locked` to `recovering` with phase `prepared`,
before the emulator call. The worker retains ambiguous graphs for bounded retry
and resumes them after restart. A validated submission response advances the
phase to `submitted` while the state remains `recovering`; the canonical watcher
alone establishes `recovered`. Warning and critical headroom appear in readiness
and admin diagnostics; critical or expired work automatically pauses admission.
Admission inventory degradation does not prevent recovery using fresh verified
provider identities and chain clocks.

The deployed Arkade Service must supply its special covenant settlement
behavior. That is an external assumption, not a Taxi implementation or a
capability advertised by `/v1/info`. A dedicated upstream forfeit mechanism is
out of scope. The full master-stack E2E proves covenant spends and recovery
before expiry for the recorded provider images; operators must maintain those
dependencies and enough execution headroom in production.

## Trust

The client verifies rather than trusts. `verifyQuote` independently rebuilds the
covenant from the quoted parameters — using the same package the operator used —
and refuses unless the derived address matches.

That check is only worth something if the client also pins the Arkade Service
and emulator keys against ones it already trusts. Otherwise an operator could
name an emulator it controls, and the address check would be self-consistent and
worthless.
