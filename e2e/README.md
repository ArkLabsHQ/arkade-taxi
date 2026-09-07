# e2e

End-to-end scenarios against [`ArkLabsHQ/arkade-regtest`](https://github.com/ArkLabsHQ/arkade-regtest).

Nine scenarios are registered. **Two run today; seven are skipped and say why in
their own names.** The suite is written so that number cannot quietly change.

## Running it

```bash
npx vitest run --config vitest.e2e.config.ts
```

That is the whole local command. The two scenarios that run today are pure logic
over `@arkade-taxi/core` and `@arkade-taxi/client` — no Docker, no build. The
config aliases `@arkade-taxi/*` straight at `packages/*/src`, because the root
has no `node_modules` link to the workspace packages and because source cannot
go stale the way a `dist/` can.

Expected output today:

```
Test Files  3 passed | 2 skipped (5)
     Tests  6 passed | 7 skipped (13)
```

Six rather than two: four of them are the integrity tests in
`suite-integrity.e2e.test.ts`.

The root `pnpm test` runs `vitest run --exclude e2e`, and the root
`vitest.config.ts` only includes `packages/*/test/**`, so nothing here is picked
up by the normal gates.

### With the stack

Not needed yet — no registered scenario talks to it. When the transaction layer
lands:

```bash
git clone https://github.com/ArkLabsHQ/arkade-regtest
cp .env.regtest.example .env.regtest      # at the repo root, not in arkade-regtest
node arkade-regtest/regtest.mjs start --profile emulator
```

`arkade-regtest` reads `../.env.regtest`, so the one file configures both it and
the service. Keep `AUTOMINE_INTERVAL=0`: arkd's regtest locktimes are
block-denominated, so a background miner advances the tip under the locktime
scenarios and makes them non-deterministic. Mine explicitly instead, with
`node arkade-regtest/regtest.mjs mine <n>`.

## The rule this suite exists to enforce

Ask **"did my test run?"**, never "did the job pass?". A suite that goes green
having asserted nothing is worse than no suite.

So:

- `scenarios.ts` is the single register. Every scenario is declared there once,
  with a scope and — if it cannot run — a stated reason.
- A blocked scenario is registered with `stackScenario(id)`. That emits an
  `it.skip` whose **name carries the reason**, and whose **body throws**:
  deleting the `.skip` without writing the test turns it red, not green.
- A scenario that runs is registered with `liveScenario(id, fn)`.
- `suite-integrity.e2e.test.ts` reads the sibling test files off disk and
  asserts that every declared scenario is registered exactly once, under its
  declared scope, and that the skip count equals `EXPECTED_STACK_SCENARIOS`. It
  also rejects any `it.skip` / `it.todo` / `.only` or bare `it(` written
  directly in a suite file — everything goes through the manifest.
- In CI, `assert-ran.mjs` re-checks vitest's own JSON report against that same
  constant, so "the job was green" and "the tests ran" are separate claims. It
  runs even when the suite step failed.

Each of those guards was mutated and observed to fail before being reverted:
lowering the constant, deleting a registration, un-skipping a blocked scenario,
adding an ad-hoc `it.skip`, and weakening the exposure control.

**When the transaction layer lands**, moving a scenario from `stack` to `logic`
means editing `scenarios.ts` — the scope, the now-empty `blocked` string, and
both constants. That is the point: it has to be a decision.

## What the two live scenarios do and do not prove

They exercise the packages, not the wire.

- `exposure.e2e.test.ts` asserts the admission decision refuses a quote that
  would breach `maxOutstandingSats` — and, more importantly, that the same
  request is admitted with headroom, and that the per-payment, concurrency and
  pause refusals carry distinct reasons. A cap test that fires because the
  policy was paused proves nothing.
- `verify-quote.e2e.test.ts` walks every rejection code in `verifyQuote`, then
  builds a quote naming a rogue emulator whose covenant address is internally
  consistent. It asserts that an unpinned client **accepts** that forgery and a
  pinned one rejects it at `UNTRUSTED_EMULATOR_KEY`, before the address is ever
  derived. That is the argument for pinning, as an executable assertion.

Neither starts a service or opens a socket. The HTTP surface, the ledger, the
sweeper and every covenant spend are in the seven that are skipped.
