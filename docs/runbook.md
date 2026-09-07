# Runbook

Operating the taxi. Read [architecture](./architecture.md) for why the service
is shaped this way and [environment](./environment.md) for the variables.

> **State of the service.** `packages/app` currently holds configuration and
> error mapping only. The HTTP surface, the admin UI, the sweeper and the
> transaction-building layer are not built yet, and the e2e scenarios that would
> exercise them are registered as explicit skips (see `e2e/README.md`). What
> follows describes operating the service as designed; sections covering a
> surface that does not exist yet say so.

## The one sentence that matters

**The sweeper is the only component whose failure costs the operator money
rather than merely blocking a payment.** Everything else fails loudly and
expensively in someone's time. A sweeper that stops running quietly converts
recoverable capital into capital nobody is coming back for.

Rank incidents by that. A dead HTTP listener means no new business. A dead
sweeper means the business you already did stops being repaid.

## Starting

The image runs `dist/cli.js serve` and expects a writable volume at `/data`:

```bash
docker run --rm \
  -v taxi-data:/data \
  --env-file .env \
  -p 8080:8080 \
  ghcr.io/<owner>/arkade-taxi:<X.Y.Z>
```

The tag is `X.Y.Z`, not `vX.Y.Z` — the release workflow strips the `v`. Pinning
`:vX.Y.Z` gets `manifest unknown`.

Locally:

```bash
pnpm -r build
node packages/app/dist/cli.js serve
```

Boot fails fast and loudly on bad configuration: `ConfigError` lists every
offending variable at once. It does not start half-configured.

The container healthcheck polls `/health` on `TAXI_HTTP_PORT` — _not built yet_.
Until it is, an unhealthy container is indistinguishable from a healthy one.

### First boot quotes nothing

This is not a fault. `DEFAULT_POLICY` seeds `paused: true` with every cap at
zero and an empty asset allowlist, because the service refuses to guess an
operator's pricing. Set the fee schedule, the caps and the allowlist through the
admin UI, then unpause. Every edit is written to `policy_audit` with the actor
that made it.

## Reading exposure

Outstanding capital is `Σ topup` over advances in state `locked`. It is **locked
capital, not expected loss** — every advance is recoverable at its `locktime`.
The real risks are capital lockup and recovery failing, in that order of
frequency and the reverse order of cost.

`computeExposure` returns three numbers, and the admin UI surfaces them:

| Field                   | What it tells you                                       |
| ----------------------- | ------------------------------------------------------- |
| `outstandingSats`       | capital currently fronted                               |
| `lockedCount`           | how many advances are carrying it                       |
| `oldestUnsweptLocktime` | the earliest locktime still unswept — the sweeper's lag |

`oldestUnsweptLocktime` is the number to alert on. Compare it against the chain
tip: once the tip passes it and the advance is still `locked`, the sweeper is
behind. A single number that only moves forward when the sweeper does its job.

Quotes are refused when a cap would be breached, and each refusal has its own
reason, returned verbatim as the wire error code:

| Reason                          | HTTP | Meaning                                    |
| ------------------------------- | ---- | ------------------------------------------ |
| `paused`                        | 503  | the operator chose not to quote; retryable |
| `asset_not_allowed`             | 409  | not on the allowlist                       |
| `topup_exceeds_max_per_payment` | 409  | one payment too large                      |
| `exceeds_max_outstanding`       | 409  | the aggregate cap                          |
| `max_concurrent_advances`       | 409  | the count cap                              |
| `topup_outside_covenant_range`  | 409  | a misconfigured dust/vtxoMinAmount pair    |

`paused` is 503 because it is transient and a client should come back. The rest
are 409: the same request keeps losing until the operator's state changes.

The last one is a configuration bug wearing a policy refusal's clothes. If you
see it, check `TAXI_DUST` and `TAXI_VTXO_MIN_AMOUNT` against arkd rather than
adjusting caps.

## When the sweeper falls behind

Symptoms, in the order you will notice them: `oldestUnsweptLocktime` older than
the chain tip; `lockedCount` that stops falling; advances sitting in `locked`
well past their `locktime`.

Work the diagnosis in this order, cheapest first.

1. **Is the sweeper running at all?** Its structured log lines and its metric are
   the first check. A crash loop and a silent no-op look identical from the
   ledger.
2. **Is the emulator reachable?** The recovery leaf is a CLTV over
   `Multisig[server, ⊕refund]`, so the emulator signature is required. An
   emulator that is down blocks the operator's own recovery, not just
   receivers' claims. Most common cause, least intuitive.
3. **Is arkd reachable, and is it the same arkd?** If `TAXI_SERVER_PUBKEY` no
   longer matches the `signerPubkey` at `TAXI_ARKD_URL` — an operator signer
   rotation, or a pointer moved to a different instance — recovery spends will
   not validate.
4. **Has `TAXI_VTXO_MIN_AMOUNT` or `TAXI_DUST` changed since those advances were
   locked?** Neither is persisted per advance, so the sweeper rebuilds the refund
   script from today's configuration. A changed value derives a different
   taptree and cannot satisfy a covenant committed to the old one. Put the old
   value back; do not "fix forward".
5. **Has the chain tip actually passed `locktime`?** On a regtest stack with the
   auto-miner disabled it may simply not have. `sweepable` filters on
   `locktime <= currentHeight` and returns the oldest first.

**Pause quoting while you work.** It stops new exposure accumulating on top of
the exposure you are already failing to retire.

### The failure the design has not ruled out

The covenant output is itself a virtual output with its own batch expiry, and it
cannot be renewed by the operator alone — renewing means spending it, which means
satisfying a leaf. So `locktime` must sit far enough inside that expiry for
recovery to fire first, and `locktimeMarginBlocks` is the headroom.

**This is inferred from the covenant's structure and has not been confirmed
against arkd.** If a sweep fails at a locktime that has demonstrably passed, and
the checks above are clean, suspect that the covenant VTXO expired first.
Capture the outpoint and its batch before doing anything else — that observation
is worth more than the recovery.

## Pausing quoting

Set `paused: true` through the admin UI. It takes effect on the next quote; no
restart. `admit` returns `paused` first, before any other check, so no cap or
allowlist reasoning runs.

What pausing does **not** do:

- It does not stop the sweeper, and must not. Pausing is how you stop taking on
  new exposure while retiring the old.
- It does not touch advances already `locked`, or quotes already issued and not
  yet locked up. An outstanding quote can still be taken up until it expires.
- It does not block claims or refunds. Those have no endpoints — the operator is
  a payout destination, never a signer, and cannot censor a claim by design.

To stop new work _and_ let outstanding quotes die out, pause and wait
`quoteTtlSeconds`; `quoted` advances become `expired` on their own.

## Recovering from a stuck advance

Identify which state it is stuck in first. The ledger only moves on observed
chain state, so "stuck" nearly always means an observation was missed, not that
a transition was refused.

**Stuck in `locking`.** The lockup was handed to the client and nothing came
back. The `locking → quoted` edge exists to release it — but check the chain
first. If the lockup actually confirmed and you release the quote, you have an
untracked covenant on chain: capital the sweeper does not know to recover. Look
for the covenant outpoint before releasing. If it exists, drive the advance to
`locked` instead.

**Stuck in `locked` with the covenant already spent.** The receiver claimed, or
the sender refunded, and the watcher missed the spend. The terminal state is
decided by the transaction, not by the service: read the spending txid and
reconcile to `recycled`, `purchased` or `refunded` accordingly. Do not guess
from which party you expected to act.

**Stuck in `locked` past `locktime`.** That is the sweeper section above.

**Stuck in `quoted` past `expiresAt`.** Harmless. `isExpired` only applies to
`quoted`, and no capital has moved — nothing was locked up.

Two things to hold on to while working any of these:

- **Never mark a terminal state from optimism.** `recycled` on a claim you did
  not observe is a lie in the ledger, and the sweeper trusts the ledger.
- **The operator cannot censor.** If a receiver is claiming and you would rather
  they did not, there is no lever here. That is the security property, working.
