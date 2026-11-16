# arkade-taxi

Dust-free transfers on Arkade. An operator fronts the dust unit; a covenant guarantees repayment.

Taxi provides joint-funded lockups, wallet-side claims and refunds, durable
submission, canonical spend observation, and automatic recovery. It runs as one
Docker service with SQLite on persistent `/data`. See the [runbook](docs/runbook.md)
for deployment and recovery operations and [release verification](#release-verification)
for the production gate.

## The problem

A sender holds an asset but no bitcoin, or wants to send a sub-dust amount of
bitcoin. Arkade already permits this — sub-dust outputs (`OP_RETURN <xonly>`,
value in `[vtxoMinAmount, dust)`) exist and the SDK routes below-dust sends into
them. Two things make that unsatisfying:

- On a default-configured service the window is empty: `resolveMinAmounts` sets
  `vtxoMinAmount = dustAmount` when unset.
- Where the window is open, `OP_RETURN` is unspendable on-chain, so the receiver
  holds a virtual output they can never unilaterally exit.

So the covenant's job is not to make sub-dust payments possible — they already
are — but to **let a receiver end up with a fully exitable VTXO without the
sender funding the dust**.

The operator fronts that dust, like a taxi fronting the fare, and is repaid when
the ride ends.

## The covenant

One covenant, six leaves, compiled from
[`contracts/dust_covenant.ark`](packages/covenant/contracts/dust_covenant.ark).
Leaf order fixes the merkle root, so it is part of the address.

| #   | Leaf           | Closure                                     | What it does                                                                         |
| --- | -------------- | ------------------------------------------- | ------------------------------------------------------------------------------------ |
| 0   | `recycle`      | `Multisig[server, ⊕recycle]`                | receiver merges the covenant into an account they own, repaying the operator in sats |
| 1   | `purchase`     | `Multisig[server, ⊕purchase]`               | receiver keeps the whole covenant; the operator was paid at lockup                   |
| 2   | `repayRefund`  | `Multisig[server, sender, ⊕repayRefund]`    | sender cancels: the loan is repaid and the rest returns to the coin they brought     |
| 3   | `reclaimWhole` | `CLTV(L) + Multisig[server, ⊕reclaimWhole]` | after the deadline the whole lockup goes to the operator                             |
| 4   | `exit`         | `CSV(E) + Multisig[sender, signer]`         | emergency only; no output constraint, and currently does not preserve an asset       |
| 5   | `renew`        | `⊕renew`, intent-gated                      | re-dates the funding coins without moving the covenant                               |

`⊕script` is the emulator's key tweaked by the Arkade Script it will only sign
under. `E` is arkd's unilateral exit delay, counted from the unroll's
confirmation; `signer` is the Taxi's own signing key, not its payout key. `L` is
a wall-clock deadline measured from the quote, not a margin inside the funding
coins' batch expiry — it deliberately outlives them, so a renewal cannot push
the Taxi's own claim out.

### Four properties worth understanding before reading the code

**On leaves 0-3 the operator is a payout destination, never a signer.** None of
them carries the operator's key in a multisig — it appears only inside
covenant-pinned outputs. So the operator **cannot censor a claim**: a receiver
spends with the Arkade Service and emulator signatures alone. The operator must
be reachable at lockup and is irrelevant afterwards, except to co-sign an
emergency exit.

**Leaf 3 pays the operator, and the custody ledger is what makes that safe.**
Unlike leaves 0-2, `reclaimWhole` names the operator as the sole payee, so a
delivery that is never claimed leaves the Taxi holding sats it does not own. The
reclaim therefore opens a `custody` row naming the recovery owner — the payer on
the sender-paid rail, the receiver on the receive rail — and what is owed to
them. `packages/app/src/custody.ts` releases it.

**Transfer principal stays with the receiver or sender.** The operator lends
sats and receives the covenant's pinned sats repayment. A separately authorized
fare at lockup can be denominated in sats or an allowed asset. A sats fare is
paid from the sender's change, and an asset fare from sender asset funding;
both are operator revenue. Every covenant payout is a whole dust unit or more,
so a sub-dust fare is refused rather than paid to an `OP_RETURN` script.

**No fee is expressible inside the covenant.** `recycle` pins the operator's
output to _exactly_ `topup`, not a satoshi more. A sender-funded asset fare is
collected at lockup as a separate output in the verified funding graph. The quote binds
the fare currency, asset and exact units as well as the principal.

## Layout

| Package             | What it is                                                           |
| ------------------- | -------------------------------------------------------------------- |
| `packages/covenant` | script builders, taptree, address derivation, golden vectors         |
| `packages/core`     | policy, pricing, ledger state machine — pure, no I/O                 |
| `packages/db`       | SQLite persistence                                                   |
| `packages/protocol` | wire types shared by client and service                              |
| `packages/client`   | wallet-facing SDK                                                    |
| `packages/app`      | HTTP service, operator wallet, reconciliation, recovery and admin UI |

## Transfer lifecycle

The quote atomically reserves operator inputs and capacity. The client verifies
the complete funding graph against independently trusted provider identities,
then signs only sender inputs and sender checkpoints. Submission persists the
exact signed envelope before a worker performs the provider calls. An identical
retry is idempotent; an ambiguous outcome retains its reservations and exact
graph across restart.

Taxi records `locked` only when the exact covenant outpoint is observed
spendable. The receiver can `recycle` or `purchase`, and the sender can refund.
These wallet operations contact the Arkade Service and emulator directly. An
offline receiver does not need to participate in lockup. Taxi records terminal
states only after validating the canonical spend, including its signatures,
outputs, assets and repayment.

Taxi guarantees recovery of its covenant VTXOs before batch expiry through
admission headroom checks, persisted tagged deadlines, deadline-prioritized
recovery, restart reconciliation and warning/critical alerts. Operators must
keep recovery dependencies available and respond before the execution budget
is exhausted; an unspent covenant at expiry is a critical incident.

The deployed Arkade Service's special covenant settlement is an external
assumption. Taxi does not implement it, and a dedicated upstream forfeit
mechanism is outside Taxi's scope. Provider identity/version checks cannot
certify this assumption: the complete live covenant-spend suite is a deployment
gate. See [architecture](docs/architecture.md) for the exact boundary.

## Payment URIs (BIP321)

Taxi requests ride on the wallet's existing BIP21 encoding
(`arkade-os/wallet` `src/lib/bip21.ts`: `encodeBip21Asset`), plus one `taxi`
param for the operator. `assetid` is the 68-hex asset id; when present `amount`
is decimal asset units, otherwise BTC.

```
bitcoin:?ark=<ark1...>&assetid=<68-hex>&amount=<units>&taxi=<url-encoded-operator>
```

BTC sub-dust taxi omits `assetid` (`amount` is BTC as usual). Query keys are
case-insensitive. The address path stays empty and `taxi` is
mandatory-to-understand: a wallet without taxi support has nothing to pay and
must abort, never fall back to a plain `ark` send. Server/emulator trust still
comes from pinned wallet config, never from the URI.

## Development

```bash
pnpm verify:artifacts
pnpm install --frozen-lockfile
pnpm -r build
pnpm typecheck
pnpm test
pnpm format:check
```

Run all four gates. `build` passing while `typecheck` fails, and the reverse,
both happen.

The service uses the unpublished `@arkade-os/sdk@0.5.7-taxi.0` candidate in
`vendor/sdk`, whose source and archive hash are recorded in its manifest. The
workspace override applies those same bytes to every SDK consumer. The test suite
uses the compiler-defined `@arkade-os/swap@0.1.7-taxi.1` candidate recorded in
`vendor/swap`. The committed lockfile pins dependency integrity;
install with `pnpm install --frozen-lockfile`. The E2E harness builds and packs Taxi's
client, covenant and protocol packages, then installs those exact tarballs in a
fresh consumer and verifies their identity and resolution before testing.

Recompile the covenant from its Arkade source and prove no byte moved:

```bash
pnpm artifact && git diff --exit-code packages/covenant/contracts packages/covenant/src/dust-covenant-artifact.ts
node packages/covenant/test/engine/run.mjs
```

The diff, not the compiler tag, is what pins the covenant's bytes: `arkadec`
ships as a digest-pinned pre-release asset whose tag can move. The engine run
executes the leaves against the emulator rather than comparing bytes, so it
fails when a leaf's semantics change while its bytes still match a stale
fixture.

## Release verification

The covenant is compiled from `contracts/dust_covenant.ark` and its committed
artifact is diffed on every CI run; `test/v2-vectors.json` pins the leaf bytes
and addresses for every shape the covenant takes. The mutation guards were each
observed to fail before being reverted.

The production release gate additionally runs real joint lockups, all claim and
refund paths, premature and eligible recovery, lost responses, duplicate POSTs,
restarts, provider outages and pre-expiry warning/critical recovery against a
fresh, unpinned `ArkLabsHQ/arkade-regtest` `master` checkout:

```bash
pnpm e2e:stack
node e2e/assert-ran.mjs e2e-results.json
```

All 26 shared scenarios, three isolated scenarios and both integrity assertions must pass,
with zero skips, using the built production image and packed client. The
harness records the exact master SHA, source identity, image identities and
SDK version in `e2e-artifacts/stack.json`; retain it with the results and logs.
It owns a unique project and leaves existing regtest resources untouched.

For a local Alice/Bob pass without Solver or swap offers:

```bash
pnpm e2e:stack --direct
```

`--direct` requires all 21 direct Taxi scenarios and both integrity assertions.
Add `--emulator-image <local-image>` to test a local emulator build. These options
are local only; CI continues to require the complete suite. The harness records the
selected IDs and image identities in a unique `e2e-artifacts/direct-<run>/stack.json`
and publishes its results alongside it. Verify those results with
`node e2e/assert-ran.mjs --direct e2e-artifacts/direct-<run>/results.json`.

Wallet browser tests run from the wallet checkout with its pinned solver, Taxi,
regtest and provider images, as described in that repository's README:

```bash
node --experimental-eventsource scripts/taxi-native-ci.mjs "Google Chrome"
node --experimental-eventsource scripts/taxi-native-ci.mjs "Mobile Chrome"
```

That harness uses its own isolated stack and Electrum endpoint. Append `--manual`
for an interactive local session; its printed stop endpoint triggers owned cleanup.

Repeat the entire gate against current regtest
master after updating providers or artifacts. A successful run proves that
recorded provider combination. See [E2E instructions](e2e/README.md).

## License

MIT
