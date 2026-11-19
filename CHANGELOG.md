# Changelog

## Unreleased

### Added

- `POST /v1/fills` for caller-built graphs and `GET /v1/fills/{id}` for status.
- Fill reconciliation and health visibility for unresolved submissions.

### Changed

- Compiler cache reuse authenticates the pinned archive and restores the executable from it.
- Covenant and wire validation reject impossible reclaim deadlines and malformed asset IDs.
- The client candidate is `0.2.0-taxi.1` and requires SDK `0.5.9-taxi.0`; covenant and protocol remain `0.1.0`.
- The workspace pins authenticated SDK and swap `0.2.0-taxi.2` candidate archives with source provenance.
- Wallet sends and claims require durable input reservations and retain ambiguous submissions.
- Operator registration requires a durable matching proof; unresolved deletion keeps input locks.
- Registration rechecks current authorization after asynchronous preparation and records bounded phase outcomes.
- pnpm workspace settings apply in clean installs and packed-client tests.
- The E2E harness supports the current regtest signer and Redis services.
- Recovery evidence checks typed CLTV refusals against exact transaction, clock and owned log records.
- Receive quotes publish reserved `operatorInputs` and `operatorScript`.
- Receive-quote `makerPublicKey` is renamed to `senderKey`.
- Migration 18 requires coordinated server and client updates. Back up the
  database and policy before deployment; rollback restores that backup with
  the previous image.

### Removed

- The swap-fill quote/submit rail and Taxi-owned swap assembler.
- Swap and RFQ wallet helpers from the Taxi client.
- Custom candidate packaging and release verification scripts.
