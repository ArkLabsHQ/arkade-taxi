# e2e

End-to-end scenarios against the production Taxi image and the current
[`ArkLabsHQ/arkade-regtest`](https://github.com/ArkLabsHQ/arkade-regtest) `master`.

Twenty-five live scenarios in the main run, two isolated scenarios each on a
stack of its own, and two integrity assertions must all pass. Skips,
todos, missing registrations, duplicate registrations, and partial JSON results
fail the run.

## Candidate packages this suite runs against

`pnpm-lock.yaml` resolves `@arkade-os/sdk` and `@arkade-os/swap` from
`vendor/carrier/*.tgz`, which are **tracked** and hash-pinned against
`vendor/carrier/manifest.json`, so `pnpm install`, `docker build` and the
harness's client pack all work from a clean checkout. The temporary consumer
takes its overrides from that same manifest, so the packed client is exercised
against the frozen candidates rather than silently falling back to the registry
build of the same version numbers.

The override alone is not the proof. Those version numbers are published, so an
override that stopped applying would install cleanly against other bytes. After
the consumer installs, the harness resolves both packages from the installed
client and requires the frozen version plus a symbol only the `adc6b329` build
exports; an import that merely succeeds cannot tell the two apart.

## Running it

Run the complete isolated stack harness:

```bash
pnpm e2e:stack
node e2e/assert-ran.mjs e2e-results.json
```

For local direct Taxi testing without Solver or swap offers, use `pnpm e2e:stack
--direct`. Add `--emulator-image <local-image>` to exercise a local emulator
build and `--wallet <checkout>` to run its live `playwright.taxi.config.ts` on the
same stack before the SDK actor scenarios. This explicit local mode requires
20 named scenarios and both integrity assertions plus the isolated run below,
stores each run in `e2e-artifacts/direct-<run>/`, and is rejected in CI.
The wallet run is stopped after 15 minutes; set `TAXI_E2E_WALLET_TIMEOUT_MS`
(whole milliseconds, at most 2147483647) to allow longer. An invalid value fails
the run before any stack starts.

### The renewal scenario

`covenant-batch-renewal` needs **no emulator bump**: `OP_TUNNEL` and
`OP_INSPECTINTENTMESSAGE` have both been in the emulator since `v0.0.8-rc.0`,
and the covenant uses no other new opcode. Read the version a run actually
resolved from `stack.json`'s `images.emulator` rather than trusting this line,
and do not re-introduce an `--emulator-image` requirement for the scenario by
reflex.

Every scenario now builds the same covenant through the production config path:
there is one covenant and no version to select. The renewal scenario still
stands up its own in-process Taxi — a fresh operator key, its own SQLite ledger,
the production lockup builder, submitter and spend watcher — because it drives
the renewal directly rather than through a delegatee.

It renews the covenant itself through leaf 5 with a `register` intent the
emulator co-signs, so it needs no delegatee. Its `renewal-r2.json` artifact
records what the indexer reports for the coin a renewal batch consumed —
`isSpent`, `spentBy`, `settledBy`, `arkTxId`, `isSwept` — and is written even when
the batch fails, because that record is the answer the watcher's discriminator
depends on.

### Isolated scenarios

`covenant-unilateral-exit-with-arkd-down` exits a covenant on-chain, which
leaves its advance `locked` for good, as a warning rather than a pause, and moves
chain time a day ahead. `fill-undersigned-foreign-input` leaves a bound quote whose
advance stays `locking` and whose operator inputs stay reserved, because nothing
reconciles a fill. Both modes therefore run each of them before the shared suite,
on a fresh stack of its own.
`node e2e/assert-ran.mjs --isolated <test> <results.json>`
checks one such run, whose artifacts land in `e2e-artifacts/isolated/<test>/` (or
its own `direct-<run>/`).

Check registration integrity without starting network services:

```bash
pnpm vitest run --config vitest.e2e.config.ts e2e/suite-integrity.e2e.test.ts
```

The harness shallow-clones unpinned `master`, discovers the current emulator
profile, rewrites fixed upstream Compose names into a unique project, assigns
unique host ports, sets `AUTOMINE_INTERVAL=0`, and validates the rendered
configuration. Before stack startup it builds the production Docker image and
uses that exact owned local image for Taxi. The client and its local workspace
dependencies are also packed, installed in a temporary consumer, checked for
mutation, and imported from the tarballs during the suite.

Wallet seeds and stack credentials live only in the run's temporary secret
directory and child-process environment. Artifacts are recursively scanned for
secret keys and known secret values before they are written. Cleanup verifies
the exact project, image, container, network, and volume ownership before
removing only those resources. `SIGINT` and `SIGTERM` stop normal work and drain
owned child processes before cleanup. Linux uses each command's exact process
group; Windows uses its exact PID tree. If termination cannot be confirmed
within the bound, cleanup fails closed, records the retained run root in the
redacted failure artifact and skips resource deletion. A normal full run is the
release gate; do not induce cancellation in a funded acceptance run.

## Required CI and release gate

Pull requests and pushes to `main` call the reusable E2E workflow from
`ci.yml`. Release tags call the same workflow from `release.yml`; both the image
and package publication jobs depend on that E2E job. Manual dispatch remains
available for the complete suite.

CI checks out `ArkLabsHQ/arkade-regtest` at unpinned `master` with depth one and
prints the resolved commit. The isolated harness records its actual resolved
master SHA, image identities, source identity, public fixtures, ports, profile,
and UTC start in `e2e-artifacts/stack.json`. The workflow uploads that manifest,
the Vitest JSON results, Taxi logs, and redacted stack diagnostics of both stacks
on success or failure.

## The rule this suite exists to enforce

Ask **"did my test run?"**, never "did the job pass?". A suite that goes green
having asserted nothing is worse than no suite.

- `scenarios.ts` is the single register. Every scenario is declared there once.
- A scenario is registered with `liveScenario(id, fn)`, which requires the
  isolated harness, production image, and packed client environment.
- `suite-integrity.e2e.test.ts` reads the sibling test files and asserts that
  every declared scenario is registered exactly once. It rejects direct
  skipped, todo, focused, or bare test registrations in scenario files.
- `assert-ran.mjs` validates Vitest's JSON report independently: the shared
  run's twenty-four scenarios and both integrity assertions, and the isolated
  run's scenario, must pass with zero failures, skips, or todos.

## What the scenarios prove

The suite exercises production HTTP and provider boundaries, real covenant
purchase/recycle/refund/recovery flows, exposure and admission controls, packed
client verification, persistent operator state, and restart reconciliation.
An on-chain deposit to the operator's boarding address is mined and boarded by
the SDK's own background settlement, with no operator action, into usable
inventory. The stack's VTXOs live two days, inside the SDK's three-day renewal
default, so the harness sets `TAXI_VTXO_RENEWAL_THRESHOLD_SECONDS` to 30 hours:
above the one-day expiry headroom, and at least 12 hours short of the lifetime,
or the Taxi stops renewal and closes admission. The reclaim deadline is
wall-clock from the quote and owes the funding nothing, so the shipped 100-day
default would expire every coin in the stack the first time a scenario mined
past one: the harness sets `TAXI_COVENANT_DEADLINE_SECONDS` to four hours, which
is how far ahead of the wall clock those scenarios leave chain time.
It also covers lost submit responses, duplicate requests, stale provider
identity, the warning and critical alarms a covenant raises as the coin it sits
on nears expiry unrenewed, and one two-owner offer fill in which a solver and a
sponsor each sign only their own inputs while the offer covenant is co-signed by
nobody but the emulator and the Arkade Service. `receiver-paid-fill-claim` builds
the same shape for `POST /v1/fills` instead, with a receiver-paid sats fare: the
caller's own inputs arrive signed, the Taxi's arrive unsigned and the gated
covenant carries the emulator's tweaked key alone. With arkd and the emulator paused, the SDK's pre-signed exit
package puts a covenant on-chain and the sender and Taxi spend its exit leaf
once the exit delay matures on median time past. The package skips the 330-sat
covenant as uneconomic, so it reaches the chain only because the Taxi's change
output in the same lockup shares its branch: a sender cannot drive this exit
alone.

The sender and the sats receiver hold delegate VTXOs, the production wallet's
three-leaf shape, whose taptree depth bytes arkd re-encodes: a stub delegate
provider adds the third leaf, so every lockup the sender signs and every recycle
claim by that receiver spends one. Actor setup recomputes each of their
addresses and fails rather than let the SDK fall back to two leaves. The
operator stays two-leaf, the shape the Taxi derives for its own key.

The receiver scenarios mint dedicated six-decimal regtest USDT assets. They
select a single asset VTXO carrying 1,000 sats, with no separate bitcoin input,
verify and submit the sender lockup, and discover `locking` then `locked` through
one SSE subscription containing two receiver addresses, with live transfers to both
addresses received over that same subscription. Bob verifies the incoming
claim independently, recycles 200 USDT with his own sats input, or purchases
200 USDT after Alice authorizes 201 USDT and Taxi receives a 1 USDT fare output.
Both flows check the indexed transaction graph and exact wallet balances.

An asset transfer's sats are only a carrier, so Taxi advances the whole 330-sat
dust unit and the sender keeps its own carrier, less any sats fare it is billed.
A sub-dust bitcoin transfer gets the same whole-dust advance, with the payment
locked beside it in the covenant; a positive sats fare is refused there,
because a bitcoin transfer has no amount to take one from that is not the
payment. Repayment and fare outputs target the canonical Arkade wallet output
key, independently of its funding signing key.
The live Bitcoin cases pay 329 sats, and exactly 100 sats via `paymentSats`,
from a 1,000-sat coin whose remainder returns to the sender as change.

Taxi's production proceeds collector consolidates canonical subdust receipts
with an ordinary operator coin using the standard SDK wallet settlement path.
The sponsored rail is what still hosts a fare below dust, so `sponsored-direct-send`
is the scenario that waits for that service-owned collection and checks the
receipt's settlement commitment and its spendable wallet output. A covenant
hosts its asset fare at dust and merges the operator change onto it, so every
payout on that rail is spendable as it lands and the claim scenarios assert the
receipt rather than a collection. No test-only recovery
or manual consolidation is performed. The zero-default collection fee cap is
zero on regtest. The harness explicitly sets all four upstream intent fee
programs to `0.0`, verifies the advertised values and records them in `stack.json`;
upstream defaults are not assumed to be zero. Recycling repays the whole advance
as an ordinary operator coin, so Bob keeps exactly the input he brought and
Taxi's spendable sats are restored without the collector. Purchase increases
Taxi's spendable USDT by exactly 1,000,000 base units and leaves it 330 sats
down: the carrier it bought Bob is never repaid.
The provider fixture allocates its existing 100,000 sats as two 50,000-sat coins,
alongside the bootstrapped 500,000-sat coin, leaving separate quote and reserve
coins after the first asset carrier is created. Cleanup waits for every owned
terminal advance's payout receipts and an idle collector before releasing the
scenario. Only exact pre-effect collection/readiness refusals are retried, with
the original expiry and three-attempt bound retained.
Both indexed outputs and wallet-recognized proceeds are asserted. Public evidence
in `receiver-sse-recycle.json` and `receiver-sse-purchase.json` includes the exact
run project, asset IDs, base units, event order, and transaction IDs.

Taxi guarantees recovery of its covenant VTXOs before batch expiry. The
deployed Arkade Service's special covenant settlement is an external
assumption; this suite exercises that deployment behavior and does not imply
that Taxi implements upstream settlement or a dedicated forfeit mechanism.

Before release, record `pnpm view @arkade-os/sdk version dist-tags --json`.
The harness always clones master afresh; read the tested SHA from the current
`stack.json` and retain it with all 27 passing assertions. Capture the existing
default project's container, volume and network inventory before and after, and
verify that no resources with the run's exact ownership labels remain after
successful cleanup.

Discovery on 2026-09-12 via `git ls-remote` resolved regtest master to
`d9e08ac0552aa12a23b688642aa9a82cf5dc1b7d`. This is an evidence checkpoint, not
a configured ref: each run fetches current master and records what it tested.
