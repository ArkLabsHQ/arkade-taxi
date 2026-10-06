# Wallet integration

Import wallet orchestration from `@arkade-taxi/client/wallet`. The root client entry retains its low-level protocol and verification API. The wallet entry provides verified sends, sequential receiver claims, Bitcoin-to-asset RFQ routing and persisted activity.

- `createTaxiSender` takes trusted Arkade context, the server checkpoint script, storage, fresh unreserved coins and transaction coordination. Its journal precedes submission and retains uncertain payments for reconciliation.
- `createClaimWatch` verifies configured server, emulator and operator keys before exposing offers.
- `TaxiClaimQueue` coordinates claims against fresh unreserved coins. Free verified claims are automatic with coordination enabled; paid claims require `claim(key)`. `setActive(false)` revokes in-flight authorization, and `dispose()` revokes the departed wallet context.
- `TaxiActivityStore` persists and reconciles activity without turning a history failure into a payment failure.
- `payAssetRequest` negotiates receiver-paid carriers, falls back before funding and preserves uncertain funding results.

Wallet adapters must supply all reservations, a transaction lock shared by sends and claims, active authorization and wallet reload. `FailedDirectTaxi.forget()` overrides the local journal only. The operator may still finish that submission, so retrying can pay twice.

The shared-regtest test uses two real SDK wallets to send exactly 50 sats, recycle the verified delivery into one spendable receiver coin, and prove the Taxi float is repaid. It runs the Taxi profile of `ArkLabsHQ/arkade-regtest` at `78d0b7a9677077ca64bf09b4e825520ba462446b`.

```sh
git clone https://github.com/ArkLabsHQ/arkade-regtest.git arkade-regtest
git -C arkade-regtest checkout 78d0b7a9677077ca64bf09b4e825520ba462446b
pnpm -r build
docker build -t arkade-taxi:regtest .
pnpm regtest:up:client
pnpm regtest:test:client
pnpm regtest:down:client
```

Set `ARKADE_REGTEST_DIR` to use an existing checkout at that revision. `pnpm test:integration:client` cleans that shared profile, starts it, tests it and stops it. It is separate from the existing production-artifact `pnpm e2e:stack` acceptance suite; both run in CI.
