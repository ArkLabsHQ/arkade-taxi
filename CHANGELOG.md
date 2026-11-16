# Changelog

## Unreleased

### Added

- `POST /v1/fills` for caller-built graphs and `GET /v1/fills/{id}` for status.
- Fill reconciliation and health visibility for unresolved submissions.

### Changed

- Compiler cache reuse authenticates the pinned archive and restores the executable from it.
- Covenant and wire validation reject impossible reclaim deadlines and malformed asset IDs.
- Taxi packages are version `0.1.0`, with published SDK `0.5.6` and swap `0.1.6` dependencies.
- Operator registration requires a durable matching proof; unresolved deletion keeps input locks.
- pnpm workspace settings apply in clean installs and packed-client tests.
- The E2E harness supports the current regtest signer and Redis services.
- Receive quotes publish reserved `operatorInputs` and `operatorScript`.
- Receive-quote `makerPublicKey` is renamed to `senderKey`.
- Migration 18 requires coordinated server and client updates. Back up the
  database and policy before deployment; rollback restores that backup with
  the previous image.

### Removed

- The swap-fill quote/submit rail and Taxi-owned swap assembler.
- Swap and RFQ wallet helpers from the Taxi client.
- Frozen SDK/swap archives and their candidate verification and release machinery.
