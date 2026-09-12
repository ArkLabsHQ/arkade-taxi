# e2e

End-to-end scenarios against the production Taxi image and the current
[`ArkLabsHQ/arkade-regtest`](https://github.com/ArkLabsHQ/arkade-regtest) `master`.

Nineteen live scenarios and two integrity assertions must all pass. Skips,
todos, missing registrations, duplicate registrations, and partial JSON results
fail the run.

## Running it

Run the complete isolated stack harness:

```bash
pnpm e2e:stack
node e2e/assert-ran.mjs e2e-results.json
```

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
the Vitest JSON results, Taxi logs, and redacted stack diagnostics on success or
failure.

## The rule this suite exists to enforce

Ask **"did my test run?"**, never "did the job pass?". A suite that goes green
having asserted nothing is worse than no suite.

- `scenarios.ts` is the single register. Every scenario is declared there once.
- A scenario is registered with `liveScenario(id, fn)`, which requires the
  isolated harness, production image, and packed client environment.
- `suite-integrity.e2e.test.ts` reads the sibling test files and asserts that
  every declared scenario is registered exactly once. It rejects direct
  skipped, todo, focused, or bare test registrations in scenario files.
- `assert-ran.mjs` validates Vitest's JSON report independently: all nineteen
  scenarios and both integrity assertions must pass with zero failures, skips,
  or todos.

## What the scenarios prove

The suite exercises production HTTP and provider boundaries, real covenant
purchase/recycle/refund/recovery flows, exposure and admission controls, packed
client verification, persistent operator state, and restart reconciliation.
It also covers lost submit responses, duplicate requests, stale provider
identity, and warning/critical recovery deadlines before VTXO expiry.

The receiver scenarios mint dedicated six-decimal regtest USDT assets. They
select a single asset VTXO carrying 1,000 sats, with no separate bitcoin input,
verify and submit the sender lockup, and discover `locking` then `locked` through
one SSE subscription containing two receiver addresses. Bob verifies the incoming
claim independently, recycles 200 USDT with his own sats input, or purchases
200 USDT after Alice authorizes 201 USDT and Taxi receives a 1 USDT fare output.
Both flows check the indexed transaction graph and exact wallet balances.

For these selected inputs Taxi advances 1 sat. The current covenant pins the
recycle repayment to a 1-sat operator-key OP_RETURN receipt; the purchase fare
also has a 1-sat OP_RETURN carrier. These outputs are verified in the indexed
transactions and do not increase Taxi's spendable wallet balance. Public evidence
in `receiver-sse-recycle.json` and `receiver-sse-purchase.json` includes the exact
run project, asset IDs, base units, event order, and transaction IDs.

Taxi guarantees recovery of its covenant VTXOs before batch expiry. The
deployed Arkade Service's special covenant settlement is an external
assumption; this suite exercises that deployment behavior and does not imply
that Taxi implements upstream settlement or a dedicated forfeit mechanism.

Before release, record `pnpm view @arkade-os/sdk version dist-tags --json`.
The registry's stable/latest version on 2026-09-13 is 0.4.72. The harness always
clones master afresh; read the tested SHA from the current `stack.json` and
retain it with all 21 passing assertions. Capture the existing default project's
container, volume and network inventory before and after, and verify that no
resources with the run's exact ownership labels remain after successful cleanup.

Discovery on 2026-09-12 via `git ls-remote` resolved regtest master to
`d9e08ac0552aa12a23b688642aa9a82cf5dc1b7d`. This is an evidence checkpoint, not
a configured ref: each run fetches current master and records what it tested.
