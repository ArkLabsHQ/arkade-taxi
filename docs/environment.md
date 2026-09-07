# Environment

Every variable `loadConfig` reads, its default, and what a wrong value does.
The source of truth is `packages/app/src/config.ts`; `.env.regtest.example` is a
filled-in copy for a local `arkade-regtest` stack.

Configuration arrives in three layers, and only the first is here:

1. **environment** — the values below. Read once, at boot.
2. **config file** — same names, lower precedence than the environment.
3. **live overrides in the database** — fee policy, exposure caps, asset
   allowlist, pause switch. These win, and every edit is audited.

The consequence worth knowing before you go looking for a missing knob: **the
caps and the fee schedule are not environment variables.** They live in the
`policy` row, and `DEFAULT_POLICY` in `packages/db/src/policy.ts` seeds
`paused: true` with every cap at zero and an empty asset allowlist. A correctly
configured service quotes nothing until an operator sets them. That is
deliberate — it refuses to guess a price.

## Variables

| Variable                | Default    | Required | Shape                           |
| ----------------------- | ---------- | -------- | ------------------------------- |
| `TAXI_DB_PATH`          | `:memory:` | no       | path                            |
| `TAXI_HTTP_PORT`        | `8080`     | no       | 1–65535                         |
| `TAXI_ARKD_URL`         | —          | **yes**  | absolute URL                    |
| `TAXI_EMULATOR_URL`     | —          | **yes**  | absolute URL                    |
| `TAXI_OPERATOR_PRIVKEY` | —          | **yes**  | 64 hex (32-byte private key)    |
| `TAXI_SERVER_PUBKEY`    | —          | **yes**  | 64 hex (32-byte x-only)         |
| `TAXI_EMULATOR_PUBKEY`  | —          | **yes**  | 64 hex (32-byte x-only)         |
| `TAXI_DUST`             | —          | **yes**  | positive decimal sats           |
| `TAXI_VTXO_MIN_AMOUNT`  | —          | **yes**  | positive decimal, ≤ `TAXI_DUST` |
| `TAXI_LOG_LEVEL`        | `info`     | no       | `trace`…`fatal`                 |
| `TAXI_ADDRESS_HRP`      | `ark`      | no       | bech32m prefix                  |

A missing or malformed value raises `ConfigError` at boot, listing every
offending variable at once rather than the first one.

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

Pointing at the wrong instance is worse than pointing at nothing: the keys below
must belong to _these_ endpoints. Naming one arkd while pinning another's key
derives covenants that arkd will never sign.

The emulator is on the critical path for the operator's **own** recovery, not
only for claims. Every leaf, including the timelocked `recovery` one, is
`Multisig[server, ⊕script]` — an emulator that is unreachable when a sweep is
due means the advance cannot be recovered at all. Monitor it like a dependency
you cannot route around, because it is one.

### `TAXI_OPERATOR_PRIVKEY`

A 32-byte secp256k1 private key, 64 lowercase hex. The operator signs its own
funding inputs at lockup with it and is never a covenant signer.

Malformed, or not a valid key, and the service refuses to start. Valid but _not
the key you meant_ is the dangerous case: the derived x-only public key goes
into the pinned payout output of every covenant, so every repayment lands
somewhere the operator cannot spend from. Nothing detects this until money has
moved.

It is a credential. Not in the image, not in the repository, not in a workflow
file.

### `TAXI_SERVER_PUBKEY` and `TAXI_EMULATOR_PUBKEY`

The Arkade Service key that appears in every leaf, and the emulator key each
leaf's script is tweaked from. 32-byte x-only, 64 hex.

Both endpoints serve these on `GET /v1/info` as `signerPubkey`, **compressed** —
66 hex with a leading `02`/`03`. Drop the parity byte; the config rejects the
66-hex form with `must be 64 hex characters (32 bytes)`.

Wrong here and the taproot address derives cleanly and is unspendable by anyone.
The leaves name a server or an emulator that will not sign, so neither the
receiver's claim, nor the sender's refund, nor the operator's recovery can be
satisfied. Funds sent to it are pinned. Verify these against the endpoints
before the first lockup, not after.

### `TAXI_DUST` and `TAXI_VTXO_MIN_AMOUNT`

The dust unit the operator fronts, and the floor on any virtual output. Both
must match what the Arkade Service actually enforces. `TAXI_VTXO_MIN_AMOUNT`
must not exceed `TAXI_DUST`, and the config rejects the pair if it does.

Set `TAXI_DUST` below arkd's dust and outputs are refused at submission. Set it
above and the operator fronts more capital per payment than it needs, inflating
exposure for nothing.

`TAXI_VTXO_MIN_AMOUNT` matters more than its name suggests, because it is an
input to the covenant scripts and therefore to the address:

- `validateParams` rejects a `topup` below it.
- `refundTopup` holds one unit back when the operator funded the whole dust unit,
  so the sender's returned asset has an output to sit in — an asset cannot
  occupy an output on its own.

That second one means the `refundSender` and `recovery` leaves are built from
the _current configured_ value. It is not persisted per advance. **Do not change
`TAXI_VTXO_MIN_AMOUNT` while advances are locked**: the sweeper would rebuild a
different refund script, derive a different taptree, and be unable to satisfy the
recovery leaf on covenants already committed to the old one. Drain to zero
outstanding first. (The rebuild only differs where `topup > dust −
vtxoMinAmount`, which is every pure-asset payment, since those set
`topup = dust`.)

The same reasoning applies to `TAXI_DUST`, which enters both the pinned payout
amounts and `refundTopup`.

### `TAXI_LOG_LEVEL`

`trace`, `debug`, `info`, `warn`, `error` or `fatal`. Default `info`.

Raising it to `error` silences the sweeper's own warnings, and the sweeper is the
one component you must not run blind. Lowering it to `trace` in production is
noisy and widens what ends up in logs.

### `TAXI_ADDRESS_HRP`

The bech32m prefix on derived covenant addresses: `ark` on mainnet, `tark` on
regtest, testnet, signet and mutinynet. The default is `ark`, so **every
non-mainnet deployment must set it.**

Get it wrong and nothing is unspendable — but no client will proceed. A wallet
re-derives the address with its own network's prefix and compares; a mismatch
raises `COVENANT_ADDRESS_MISMATCH` on every quote you issue. If integrators
report that error universally and the keys check out, look here first.
