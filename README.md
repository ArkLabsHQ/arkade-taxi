# arkade-taxi

Dust-free transfers on Arkade. An operator fronts the dust unit; a covenant guarantees repayment.

> **Status: early.** The covenant is ported and vector-verified against its Go
> reference, but nothing here has yet been exercised against a live emulator or
> arkd. See [What is and is not verified](#what-is-and-is-not-verified).

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

**The operator never touches the asset.** Every operator payout is a sats value.
The asset always lands on the receiver or returns to the sender. This is a sats
liquidity service, not an asset custodian.

**No fee is expressible inside the covenant.** `recycle` pins the operator's
output to _exactly_ `topup`, not a satoshi more. Revenue is therefore collected
out-of-band at lockup, as a separate output. That is a constraint, not a choice.

## Layout

| Package             | What it is                                                   |
| ------------------- | ------------------------------------------------------------ |
| `packages/covenant` | script builders, taptree, address derivation, golden vectors |
| `packages/core`     | policy, pricing, ledger state machine — pure, no I/O         |
| `packages/db`       | SQLite persistence                                           |
| `packages/protocol` | wire types shared by client and service                      |
| `packages/client`   | wallet-facing SDK                                            |

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

## What is and is not verified

**Verified.** The TypeScript covenant produces byte-identical scripts to the Go
reference at `49ae96d` across 10 parameter sets covering both the asset and
bitcoin variants and both output-pinning branches. The mutation guards were each
observed to fail before being reverted.

That byte-identity carries VM assurance transitively: the Go reference's own
tests execute those exact bytes through `arkade.NewEngine`, so "these scripts
run correctly under the Arkade VM" is established without this repo re-proving
it. What it does not establish is that a spend of a real covenant succeeds.

`scripts/probe-live.mjs` derives a covenant against a running arkd and emulator
and prints the address. Against arkd `v0.9.16` and emulator `v0.0.7` on regtest
— `dust=330`, `vtxoMinAmount=1`, so the sub-dust window is open — both variants
derive four-leaf `tark1…` addresses from the live signer keys. It is read-only:
it signs nothing and submits nothing.

**Not verified.** No spend has been constructed or broadcast. `LockupBuilder`
and `RecoveryRunner` are injectable interfaces awaiting a live transaction
layer, so the joint-funded lockup, the emulator co-signing a claim, and arkd
accepting it are all untested. The relationship between the covenant's recovery
`locktime` and the covenant VTXO's own batch expiry is inferred from the
covenant's structure and not yet confirmed; it is kept as a config value for
that reason.

The upstream covenant PR is still open, so the scripts may change in review.
`packages/covenant` is deliberately small and isolated so that stays a
one-package edit.

## License

MIT
