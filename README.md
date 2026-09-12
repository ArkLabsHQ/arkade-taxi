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

Four leaves over three scripts, from
[arkade-os/emulator#150](https://github.com/arkade-os/emulator/pull/150).

| #   | Leaf           | Closure                               | What it does                                                                         |
| --- | -------------- | ------------------------------------- | ------------------------------------------------------------------------------------ |
| 0   | `recycle`      | `Multisig[server, ⊕recycle]`          | receiver merges the covenant into an account they own, repaying the operator in sats |
| 1   | `purchase`     | `Multisig[server, ⊕purchase]`         | receiver keeps the whole covenant; the operator was paid at lockup                   |
| 2   | `refundSender` | `Multisig[server, sender, ⊕refund]`   | sender cancels, operator repaid                                                      |
| 3   | `recovery`     | `CLTV(L) + Multisig[server, ⊕refund]` | permissionless after timeout                                                         |

`⊕script` is the emulator's key tweaked by the Arkade Script it will only sign
under.

### Three properties worth understanding before reading the code

**The operator is a payout destination, never a signer.** No leaf carries the
operator's key in a multisig — it appears only inside covenant-pinned outputs.
So the operator **cannot censor a claim**: a receiver spends with the Arkade
Service and emulator signatures alone. The operator must be reachable at lockup
and is irrelevant afterwards.

**Transfer principal stays with the receiver or sender.** The operator lends
sats and receives the covenant's pinned sats repayment. A separately authorized
fare at lockup can be denominated in sats or an allowed asset. In v1 a sats
fare is an operator-funded self-payment, not customer revenue. An asset fare
is paid from sender asset funding and is operator revenue.

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

## Development

```bash
pnpm install
pnpm -r build
pnpm typecheck
pnpm test
pnpm format:check
```

Run all four gates. `build` passing while `typecheck` fails, and the reverse,
both happen.

Regenerate the golden vectors from the Go reference (requires Go):

```bash
pnpm vectors
```

## Release verification

The TypeScript covenant produces byte-identical scripts to the Go
reference at `49ae96d` across 10 parameter sets covering both the asset and
bitcoin variants and both output-pinning branches. The mutation guards were each
observed to fail before being reverted.

The production release gate additionally runs real joint lockups, all claim and
refund paths, premature and eligible recovery, lost responses, duplicate POSTs,
restarts, provider outages and pre-expiry warning/critical recovery against a
fresh, unpinned `ArkLabsHQ/arkade-regtest` `master` checkout:

```bash
pnpm e2e:stack
node e2e/assert-ran.mjs e2e-results.json
```

All 17 functional/resilience scenarios and both integrity assertions must pass,
with zero skips, using the built production image and packed client. The
harness records the exact master SHA, source identity, image identities and
SDK version in `e2e-artifacts/stack.json`; retain it with the results and logs.
It owns a unique project and leaves existing regtest resources untouched.

The npm registry reported stable `@arkade-os/sdk` **0.4.72** on 2026-09-12 via
`pnpm view @arkade-os/sdk version dist-tags --json`; that is the version used
by the lockfile. Repeat discovery before an upgrade and repeat the entire gate
against current regtest master. A successful run proves that recorded provider
combination, not every future deployment. See [E2E instructions](e2e/README.md).

## License

MIT
