# Architecture

## Roles

| Party                   | Holds             | Role                                                        |
| ----------------------- | ----------------- | ----------------------------------------------------------- |
| Sender wallet           | asset, maybe sats | requests the transfer, signs lockup inputs, can refund      |
| Operator (this service) | sats only         | fronts `topup`, co-signs lockup, sweeps on timeout          |
| Receiver wallet         | —                 | claims via `recycle` or `purchase`; offline at payment time |
| Arkade Service (arkd)   | server key        | signs every leaf                                            |
| Emulator                | emulator key      | signs a leaf iff its Arkade Script is satisfied             |

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
quoted → locking → locked → { recycled | purchased | refunded | recovered }
   └──────────────→ expired
```

Transitions are driven by observed chain state, never by optimism: `locked` on
seeing the covenant outpoint spendable, terminal states on seeing the spend.
`expired` is the only state reached without a chain event.

`locking → quoted` exists because a lockup can fail and release the quote.

## Exposure

Outstanding capital is the sum of `topup` over `locked` advances. This is locked
capital, not expected loss — every advance is recoverable at its `locktime`. The
real risks are capital lockup and recovery failing.

## The locktime constraint

The covenant output is itself a virtual output with a batch expiry, and it
**cannot be renewed by the operator alone**: renewing means spending it, which
means satisfying a leaf. So `locktime` must be derived from the covenant VTXO's
expiry with margin, and the service must refuse to quote when it cannot leave
enough.

**This is inferred from the covenant's structure and has not been confirmed
against arkd.** It is the first thing to verify in end-to-end testing, and the
margin is a config value so a wrong guess is a config change rather than a
rebuild.

## Trust

The client verifies rather than trusts. `verifyQuote` independently rebuilds the
covenant from the quoted parameters — using the same package the operator used —
and refuses unless the derived address matches.

That check is only worth something if the client also pins the Arkade Service
and emulator keys against ones it already trusts. Otherwise an operator could
name an emulator it controls, and the address check would be self-consistent and
worthless.
