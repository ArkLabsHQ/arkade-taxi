# Runbook

Run one Taxi process with persistent SQLite storage. Taxi guarantees that its
covenant VTXOs are recovered before batch expiry: operate the recovery worker,
maintain its dependencies and act on headroom alerts before the execution
budget runs out. The deployed Arkade Service's special covenant settlement is
an external assumption. Taxi does not implement that settlement, and a
dedicated upstream forfeit mechanism is outside this service's scope.

Operator proceeds are separate: a background collector validates fare and
repayment receipts against terminal persisted advances and consolidates only
those canonical wallet receipts, plus an ordinary unreserved operator coin
when required. It uses SDK `Wallet.settle`, preserves all asset groups and
never spends a covenant, sender or receiver input. Keep spare bitcoin-only
VTXOs above `TAXI_OPERATOR_MIN_RESERVE_SATS` available for carrier consolidation.
Collection prefers an existing spendable asset-bearing operator carrier, retaining
every asset group, before using bitcoin-only reserve. This avoids progressively
turning quoteable reserve into separate asset carriers. Keep distinct bitcoin-only
coins for quote funding and the minimum reserve after creating the first asset
carrier; the asset-bearing self-output is not quote inventory.
Reserve accounting applies the same expiry headroom as quote funding. Reusing an
asset carrier or other non-quoteable standard coin does not consume that reserve,
so collection can continue while quote admission is already reserve-blocked.

Inspect `proceeds` in `/health`, or `readiness.proceeds` in `/admin/api/status`:
it reports the active job,
state, blocker, exact authorized fee and commitment. New quotes wait while a
collection job is active, until its exact spendable self-output is verified;
`/ready` reports `proceeds_collecting` or
`proceeds_output_pending`. Existing covenant recovery continues independently.
The fee cap defaults to zero; `proceeds_fee_cap_exceeded` requires deliberately configuring
`TAXI_PROCEEDS_MAX_FEE_SATS` for the deployment's settlement fees. Existing
jobs retain their original authorization. An ambiguous settlement keeps its
inputs reserved across restart until every input and its spendable output
prove completion. SDK 0.4.72 intents have no default expiry; do not delete
these reservations or resubmit manually. Reconcile the recorded SDK intent
with the Arkade operator before any manual repair. Back up both `proceeds_*`
and `taxi_sdk_*` with the advance ledger, and drain collection before key rotation.

## Deployment

Build and verify the release before admitting funds:

```bash
pnpm -r build
pnpm typecheck
pnpm test
pnpm format:check
pnpm e2e:stack
node e2e/assert-ran.mjs e2e-results.json
docker build -t arkade-taxi:release-candidate .
```

The complete E2E uses the production image and packed client. Retain
`e2e-artifacts/stack.json`, results, Taxi logs and stack logs together: the
manifest identifies the exact freshly cloned regtest master SHA and images.
Provider identity and health alone do not prove the external settlement
assumption. Repeat the live deployment gate after changing providers.

Supply `TAXI_OPERATOR_PRIVKEY` from a secret manager in the process environment.
Store the other [environment settings](environment.md) in an access-controlled
deployment configuration. `/data` must be durable and writable by UID/GID
`10001:10001`; it contains both Taxi's ledger and the public SDK wallet tables
(`taxi_sdk_*`). Keep the private key backup separately. The key is not stored in
SQLite or diagnostic artifacts.

For example, after a secret-aware launcher has populated the environment:

```bash
docker run --name taxi --restart unless-stopped \
  --mount type=volume,source=taxi-data,target=/data \
  --env-file /secure/taxi/public.env \
  --env TAXI_OPERATOR_PRIVKEY \
  -p 127.0.0.1:8080:8080 \
  arkade-taxi:release-candidate
```

Use an immutable image digest for deployed releases. The image runs as
`10001:10001`, defaults to `/data/taxi.db`, and starts `dist/cli.js serve`.
Graceful termination drains owned work and preserves durable intents. Do not
start another writer against the same database during shutdown or restore.

A trusted reverse proxy owns TLS and authentication. Protect both `/admin` and
the bare `/api/*` admin aliases; they share Taxi's HTTP listener. Remove any
inbound `X-Taxi-Operator`, replace it with the authenticated operator identity,
and prevent direct access to the backend port. Taxi validates and audits this
header but does not authenticate it. Request JSON cannot choose the actor.

Pin the Arkade Service and emulator public keys independently of Taxi. Check
the configured network, dust, minimum amount, indexer and Esplora API URLs.
Taxi checks live provider identity and capabilities and closes admission on
drift. Clients independently verify the same trust facts before signing.

## Liveness, readiness and first admission

`GET /health` reports liveness after configuration/database initialization and
remains available during provider outages. Use it for the container healthcheck.
`GET /ready` reports operational readiness, including startup reconciliation,
fresh provider identity and clocks, usable reserves, submission/recovery
blockers and deadline headroom. Do not turn an upstream outage into a liveness
restart loop. Read its structured blockers, runtime and sweeper details.

First boot is paused, with zero caps and no asset rules. Through the
authenticated admin UI, configure the fee rules, limits and reserves, fund the
operator wallet, inspect synchronization and then resume. Resume refreshes
state and refuses while any safety blocker remains. Policy and operation
changes carry an audit actor.

In v1 a sats fare is an operator-funded self-payment, not customer revenue.
Budget operator liquidity for the topup, sats fare or asset-fare hosting sats,
and change requirements. A sender-funded asset fare is operator revenue.
Changing fare rules does not change these funding allocations.

## Monitoring and expiry response

Exposure includes `locking`, `locked` and `recovering` advances; quote
reservations consume operator inventory, and lockup claims atomically enforce
the outstanding-sat and concurrent-advance limits. A submitted recovery is not
repayment until its canonical spend is observed. Monitor active advance counts,
reserved capacity, `lastSuccessfulObservationAt`, `lastSuccessfulRecoveryAt`,
the latest recovery error, `sweeper.nearestDeadline`, `sweeper.blockers` and the
admin advance list's deadline details.

Deadlines are tagged `height` or `time`. Compare height with verified chain
height and time with chain median time past, never wall-clock time or a guessed
blocks-to-seconds conversion. Warning defaults are 72 blocks or 43,200 seconds
remaining; critical defaults are 12 blocks or 7,200 seconds. The independent
minimum admission headroom defaults are 144 blocks and 86,400 seconds.

Alert on `recovery_deadline_warning` and page immediately on
`recovery_deadline_critical`, `covenant_unspent_at_expiry`, missing clocks,
quarantined graphs or stale recovery observations. Critical/expired deadlines
automatically pause new admission. Recovery continues while admission is paused
or inventory is unsafe, provided recovery identities and chain clocks verify.

At warning: pause, inspect the exact advance/outpoint and deadline domain, check
Arkade Service/emulator/indexer/Esplora availability and pins, then rescan.
Inspect the durable submission/recovery phase, failure code, attempt count and
next attempt. If retryable and no live lease exists, use the matching retry
operation. At critical: retain the pause, prioritize restoring the existing
recovery path and keep observing its exact transaction until canonical
repayment is recorded. An unspent covenant at expiry is a failed recovery
incident; preserve evidence and escalate to the provider. Never mark it repaid
or clear reservations to make readiness green.

## Pause, rescan and retry

The admin UI exposes these audited operations. Their equivalent authenticated
routes accept `POST` with `Content-Type: application/json` and body `{}`:

| Route                                      | Effect                                                  |
| ------------------------------------------ | ------------------------------------------------------- |
| `/admin/api/pause`                         | Pause admission while recovery and observation continue |
| `/admin/api/resume`                        | Refresh and resume only if all safety checks pass       |
| `/admin/api/rescan`                        | Refresh runtime, reconcile and prompt recovery          |
| `/admin/api/advances/:id/retry-submission` | Expedite the retained retryable submission phase        |
| `/admin/api/advances/:id/retry-recovery`   | Expedite the retained retryable recovery graph          |

The retry routes return 409 for live leases or incompatible phases. They do
not replace a graph, release reservations, clear quarantine or force a terminal
state. Repeated lockup POSTs must carry the identical signed envelope. A
successful rescan/retry response means the operation was accepted, not that
financial recovery is complete.

For `locking`, the worker resumes `claimed`, `prepared` or `responded` facts.
A lost submit response can be reconciled by authenticated lookup of the exact
pending signed graph. `failed` and `legacy` phases require diagnosis; the
service will not manufacture missing signed facts. For `recovering`, a
prepared graph survives a timeout and restart; a submitted graph waits for
canonical observation. Do not edit leases, phases or signed artifacts by hand.
For a spent covenant still shown active, rescan and inspect the actual spending
transaction. The watcher verifies its leaf and outputs before classifying it.

Pause closes new admission, including new lockup acceptance. Existing durable
work, claims, refunds and recovery continue. Let unsubmitted quotes expire and
verify their reservations release before declaring the service drained.

## Backup and restore

1. Pause admission and inspect every active deadline. Schedule a backup only
   when the remaining headroom exceeds the shutdown, backup and restart budget.
2. Gracefully stop the sole Taxi process and confirm it exited. Copy the entire
   `/data` volume, including any SQLite journal/WAL sidecars, using a consistent
   volume snapshot or backup tool. Never copy only a live database file.
3. Encrypt the backup and record its checksum, image digest, configuration and
   key identifier. Back up the private key independently through the secret
   manager. Resume the same deployment and verify readiness and active advances.
4. Rehearse restore into a new volume and one process with the same image,
   configuration and operator key. Restrict public admission during restore;
   allow the required provider connections for startup reconciliation.
5. Confirm SQLite opens, SDK wallet state reloads, every outstanding advance and
   reservation is present, and startup reconciles canonical spends and resumes
   exact durable graphs. Use pause before reopening public traffic, inspect
   readiness and deadline diagnostics, then explicitly resume.

An old backup may omit advances accepted after it. Do not admit traffic from
such a snapshot until those obligations are reconstructed from authoritative
records; the service cannot infer missing history from the operator key alone.
Keep the original volume recoverable until the restored deployment is verified.

## Key rotation

Pause admission, wait for quote expiry and resolve all `locking`, `locked` and
`recovering` advances to canonically observed terminal states. Verify zero
reservations and exposure, and separately account for the old wallet balance.
Back up the database and old key, gracefully stop, install the new secret and
provision/fund its wallet in a separate persistent deployment. Recheck provider
pins, policy, reserve and readiness before resuming. Retain the old key and
database for reconciliation and old-wallet funds. Do not replace the key on a
deployment with outstanding advances or discard the old payout key.

Use the same drain procedure before changing provider keys, dust, minimum
amount or recovery budgets. Startup validates active graphs against the current
configuration and refuses incompatible recovery; bypassing that guard destroys
the operational guarantee.

## Upgrade and rollback

Discover the current stable SDK with
`pnpm view @arkade-os/sdk version dist-tags --json`; the 2026-09-12 registry
checkpoint is stable `0.4.72` (the `rc` tag is a separate prerelease). Run all
repository, image, package and fresh-master E2E gates after dependency changes.
Record the actual master SHA from the current run's `stack.json`, not a previous
log or a pinned checkout.

Pause, drain when changing recovery-sensitive configuration, take a consistent
backup, stop the old process and start the tested image against the persistent
volume. Database migrations run at open; retain the pre-upgrade snapshot and
image. Confirm startup reconciliation, exact active obligations and readiness,
then resume. If startup fails, preserve diagnostics and the current volume.
Rollback to the old image with its compatible pre-upgrade backup only after
accounting for every network effect since that snapshot; never run an old image
against an unsupported newer schema or erase newer financial facts.
