# Environment

Every variable `loadConfig` reads, its default, and what a wrong value does.
The source of truth is `packages/app/src/config.ts`; `.env.regtest.example` is a
filled-in copy for a local `arkade-regtest` stack.

`loadConfig` reads the process environment once at boot. There is no application
config-file loader; `docker --env-file` is one way to populate that environment.
Live fee rules, exposure caps and the pause switch are separate database policy,
and every operator edit is audited.

The consequence worth knowing before you go looking for a missing knob: **the
customer pricing caps and fare schedule are not environment variables.** They live in the
`policy` row, and `DEFAULT_POLICY` in `packages/db/src/policy.ts` seeds
`paused: true` with every cap at zero and an empty asset allowlist. A correctly
configured service quotes nothing until an operator sets them. That is
deliberate — it refuses to guess a price.

## Variables

| Variable                     | Default    | Required | Shape                        |
| ---------------------------- | ---------- | -------- | ---------------------------- |
| `TAXI_DB_PATH`               | `:memory:` | no       | path                         |
| `TAXI_HTTP_PORT`             | `8080`     | no       | 1–65535                      |
| `TAXI_ARKD_URL`              | —          | **yes**  | absolute URL                 |
| `TAXI_EMULATOR_URL`          | —          | **yes**  | absolute URL                 |
| `TAXI_OPERATOR_PRIVKEY`      | —          | **yes**  | 64 hex (32-byte private key) |
| `TAXI_LOG_LEVEL`             | `info`     | no       | `trace`…`fatal`              |
| `TAXI_PROCEEDS_MAX_FEE_SATS` | `0`        | no       | non-negative integer sats    |

A missing or malformed value raises `ConfigError` at boot, listing every
offending variable at once rather than the first one.

Taxi uses `TAXI_ARKD_URL` for the SDK's integrated indexer. It selects the SDK's
Esplora endpoint from the network advertised by arkd. The same verified network
selects the address HRP and emulator trust anchor; arkd supplies its signer,
dust and minimum VTXO amount through `GET /v1/info`.

Runtime budgets are positive decimal integers. Height budgets are
`TAXI_MIN_EXPIRY_HEADROOM_BLOCKS=144`, `TAXI_RECOVERY_BROADCAST_BLOCKS=72`, and
`TAXI_RECOVERY_CRITICAL_BLOCKS=12`. Time budgets are
`TAXI_MIN_EXPIRY_HEADROOM_SECONDS=86400`, `TAXI_RECOVERY_BROADCAST_SECONDS=43200`,
and `TAXI_RECOVERY_CRITICAL_SECONDS=7200`. Each set independently requires
critical < broadcast < minimum headroom. No conversion between units occurs.
`TAXI_RECONCILE_INTERVAL_MS=30000` controls refresh and snapshot staleness;
`TAXI_OPERATOR_MIN_RESERVE_SATS=10000` requires verified usable wallet capacity.
The live policy has separate `locktimeMarginBlocks=144` and
`locktimeMarginSeconds=86400` fields. Timestamp CLTV is compared with chain
median time past (BIP-113), never the process clock or chain height.

### `TAXI_DB_PATH`

The SQLite file holding the ledger. The default `:memory:` is fine for a test
and wrong for anything else: on restart the operator loses the record of which
advances are outstanding, and the sweeper no longer knows what to recover. That
is the one loss that costs money rather than blocking a payment. The same
applies to a path on a container layer or a tmpfs — the Docker image sets
`/data/taxi.db` against a declared volume for exactly this reason.

### `TAXI_HTTP_PORT`

The listener. The image's healthcheck reads the same variable, so they follow
each other; what does not follow is the `EXPOSE`d port and any published mapping.
A mismatch there shows up as a container that keeps being restarted by a probe
that cannot reach it.

### `TAXI_ARKD_URL` and `TAXI_EMULATOR_URL`

Where the Arkade Service and the emulator live. Both absolute URLs.

Pointing at the wrong instance is worse than pointing at nothing. Taxi pins the
signer returned by arkd at startup, while the emulator identity must match the
key pinned for arkd's advertised network by `@arkade-os/sdk`. Later refreshes
fail closed if the signer, network, limits or capabilities drift.

The emulator is on the critical path for the operator's **own** recovery, not
only for claims. Every leaf, including the timelocked `recovery` one, is
`Multisig[server, ⊕script]` — an emulator that is unreachable when a sweep is
due means the advance cannot be recovered at all. Monitor it like a dependency
you cannot route around, because it is one.

### `TAXI_OPERATOR_PRIVKEY`

A 32-byte secp256k1 private key, 64 lowercase hex. The operator signs its own
funding inputs at lockup with it and is never a covenant signer.

Malformed or invalid keys stop startup. After verifying the provider identity,
Taxi derives the SDK wallet's canonical Arkade output key from this signing
key, the pinned server key and its exit delay. Quotes persist that output key;
the raw x-only signing key is not the payout destination. Runtime checks the
actual wallet address before reading inventory or admitting funds. A different
valid key creates a different wallet, so back up the intended identity and check
the funded wallet address before enabling admission.

Supply it through the deployment's secret manager as `TAXI_OPERATOR_PRIVKEY`.
The application has no `_FILE` setting: a secret-aware launcher must inject the
value into the process environment. Never bake it into an image, commit it,
put it on a command line or include it in logs. Keep an encrypted, independently
recoverable backup of the key separate from the database backup. See the
[key rotation procedure](runbook.md#key-rotation).

### `TAXI_PROCEEDS_MAX_FEE_SATS`

Maximum fee authorized for one ordinary wallet settlement collecting Taxi's
validated proceeds. Defaults to `0`. Subdust repayments and asset fares can be
recoverable receipts rather than immediately spendable VTXOs; Taxi consolidates
them with an unreserved ordinary operator coin while preserving every asset
group and the configured funding reserve. It never settles covenant inputs here.

If quoted fees exceed the cap, receipts remain recoverable and health/admin
status reports `proceeds_fee_cap_exceeded`. Deliberately configure a higher cap
and restart for a fee-charging deployment. Each created job persists its exact
fee and authorization; changing the environment cannot widen an in-flight job.
Ambiguous intents retain reservations for reconciliation, including after restart.

### Provider identities and network parameters

Taxi derives the emulator key from `@arkade-os/sdk` using the network returned by
arkd. There is deliberately no `TAXI_EMULATOR_PUBKEY`: the deployment must not
replace a network trust anchor already pinned by the SDK. Taxi still fetches the
emulator's `GET /v1/info` and refuses startup unless its `signerPubkey` matches
the SDK key. Networks without an SDK-pinned emulator key cannot start Taxi.

arkd also serves the Arkade operator signer on `GET /v1/info`. Taxi normalizes
that key, pins it in the resolved runtime configuration and uses it to derive
the operator payout address. No duplicate server-key environment variable is
accepted.

Wrong here and the taproot address derives cleanly and is unspendable by anyone.
The leaves name a server or an emulator that will not sign, so neither the
receiver's claim, nor the sender's refund, nor the operator's recovery can be
satisfied. Funds sent to it are pinned. Verify these against the endpoints
before the first lockup, not after.

The dust unit the operator fronts and the minimum virtual-output amount also
come from the verified arkd info. Taxi refuses startup if either is non-positive
or the minimum exceeds dust. The minimum matters more than its name suggests,
because it is an
input to the covenant scripts and therefore to the address:

- `validateParams` rejects a `topup` below it.
- `refundTopup` holds one unit back when the operator funded the whole dust unit,
  so the sender's returned asset has an output to sit in — an asset cannot
  occupy an output on its own.

That second one means the `refundSender` and `recovery` leaves are built from
the _current provider_ value. It is not persisted per advance. **Do not change
arkd's minimum VTXO amount while advances are locked**: the sweeper would rebuild a
different refund script, derive a different taptree, and be unable to satisfy the
recovery leaf on covenants already committed to the old one. Drain to zero
outstanding first. (The rebuild only differs where `topup > dust −
vtxoMinAmount`, which is every pure-asset payment, since those set
`topup = dust`.)

`dust` and the parties are persisted per advance, along with funding and signed
graph facts. Runtime provider pins, the provider minimum amount and recovery
budgets must nevertheless remain compatible with those graphs. Startup
reconstructs and validates every active recovery and fails closed on a mismatch.
Drain `quoted`, `locking`, `locked` and `recovering` work before changing these
provider parameters; do not work around a failed startup by deleting rows.

### `TAXI_LOG_LEVEL`

`trace`, `debug`, `info`, `warn`, `error` or `fatal`. Default `info`.

Raising it to `error` silences the sweeper's own warnings, and the sweeper is the
one component you must not run blind. Lowering it to `trace` in production is
noisy and widens what ends up in logs.

The SDK network definition supplies the bech32m prefix for derived covenant
addresses. Clients still re-derive and compare the address before signing.
