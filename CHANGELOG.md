# Changelog

## 1.1.2 (unreleased)

- An Executor that answers the renewal template under an id other than the Taxi's raises
  `TemplateMismatchError`, so the Taxi renews in process; `TemplateRefusedError` carries the 403
  as `status`, like every other `DelegateeError`.
- The renewal keeper treats a covenant coin born at the epoch, the SDK's reading of a zero or null
  birth, as of unknown age, leaving it to the overdue alarm instead of renewing it at once.
- A covenant a renewal batch has already settled raises `CovenantSpendBusyError` before anything
  is submitted and releases its capability, so `TaxiClient` re-binds a transfer verified before
  the renewal to the renewed coin and claims there rather than failing it as spent. The re-bind
  checks the renewed coin itself, so a failure the Taxi reports on the locked transfer no longer
  blocks it.
- The spend watcher keeps validating a covenant after adopting its renewal successor. It had
  flagged every renewed covenant `covenant_spend_unknown` and paused the Taxi on each later scan,
  and could not classify a claim of the renewed coin.
- An isolated e2e scenario proves the in-process keeper renews a short-lived covenant once, and
  not again while its successor is fresh, and that the receiver claims the renewed coin.

## 1.1.1 (unreleased)

- A covenant spend arkd refuses with `VTXO_ALREADY_REGISTERED` raises `CovenantSpendBusyError` and
  releases its capability; `TaxiClient` waits for the renewed coin and spends it there.
- The in-process renewal keeper waits for half a covenant coin's own life, so neither a fresh
  covenant nor its renewed successor is due at once when arkd advertises no VTXO lifetime.

## 1.1.0 (unreleased)

- Caller-built fills of directed asset-swap offers, whose deposit arrives signed by its taker.
- SDK `0.5.14-taxi.1` and Swap `0.1.16-taxi.1` snapshots; the Swap negotiates only directed contracts.

## 1.0.0 (unreleased)

- One Taxi release, wire protocol and compiler-defined covenant.
- Direct Bitcoin and asset transfers, sponsored transfers and caller-built fills.
- Verified receive quotes with reserved operator funding, fees and deadlines.
- Durable input ownership before signing; ambiguous submissions retain their original journals and holds.
- Persisted registration, claims, refunds, renewal and recovery with restart reconciliation.
- A single initial database schema with current financial constraints.
- Shared wallet orchestration and minimal ordinary send flows.
- Authenticated SDK and Swap snapshots with public package and regtest validation.
