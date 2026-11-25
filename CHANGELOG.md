# Changelog

## 1.1.1 (unreleased)

- A covenant spend arkd refuses with `VTXO_ALREADY_REGISTERED` raises `CovenantSpendBusyError` and
  releases its capability; `TaxiClient` waits for the renewed coin and spends it there.
- A transfer verified before its renewal settled raises the same error before submitting, so
  `TaxiClient` claims it at the renewed coin rather than failing it as spent.
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
