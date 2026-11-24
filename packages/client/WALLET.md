# Wallet integration

Import wallet orchestration from `@arkade-taxi/client/wallet`. The root client entry retains its low-level protocol and verification API. The wallet entry provides verified sends, sequential receiver claims, Bitcoin-to-asset RFQ routing and persisted activity.

- `createTaxiSender` takes trusted Arkade context, the server checkpoint script, storage, fresh unreserved coins and transaction coordination. `reserveInputs` must durably exclude selected inputs from every wallet spend before signing. Key the hold by wallet/network, Taxi and `record.transferId`: repeated calls for the same transfer and exact inputs must reacquire its existing hold across retries and restarts. Reject changed inputs under that key. Its journal precedes submission and retains uncertain payments for reconciliation.
- Sender and claim reservation adapters release without a txid only for a proven unsent attempt. A release carrying the successful txid must retain the hold until every selected input is observed spent. Never release an ambiguous submission on a timeout or tab closure.
- `createClaimWatch` verifies configured server, emulator and operator keys before exposing offers.
- `TaxiClaimQueue` coordinates claims against fresh unreserved coins. Free verified claims are automatic with coordination enabled; paid claims require `claim(key)`. `setActive(false)` revokes in-flight authorization, and `dispose()` revokes the departed wallet context.
- `TaxiActivityStore` persists and reconciles activity without turning a history failure into a payment failure.
- `payAssetRequest` negotiates receiver-paid carriers, falls back before funding and preserves uncertain funding results.

Pending-send recovery keeps the original `PendingTaxiRecord` and uses the same wallet, network, Taxi and durable reservation adapter. Restore the hold from `record.attempt.senderInputs`, then call `resumePendingDirectTaxi(wallet, network, transferId)` to reconcile the original transfer under the payment lock. Missing reservation support rejects recovery before submission; restore the adapter and retry that same record. A record without its original authorization can only observe the original transfer's status. Do not clear an uncertain record or create a replacement payment to bypass this guard.

The reservation adapter owns its recovery journal independently of `TaxiClaimQueue` and the sender's payment journal. It must restore unresolved holds before wallet spending and reconcile them on startup or in the background, reacquiring current wallet-backed release handles from their stable IDs after restart. Keep ambiguous claim holds when the queue is disposed; retry their release callback only after independent spend evidence and local wallet state permit cleanup. A transfer ID or claimed txid alone is not spend evidence. Retain the adapter journal if verification or release fails.

A confirmed send still returns its txid if reservation release fails; `onHistoryError` receives the cleanup error. Retry cleanup from the adapter journal rather than resubmitting the payment. Likewise, a successful claim stays consumed before `recordClaim` runs: a history error is reported through `onError` and does not authorize a second claim. Repair history from wallet transaction facts.

Wallet adapters must supply all reservations, a transaction lock shared by sends and claims, active authorization and wallet reload. `FailedDirectTaxi.forget()` overrides the local journal only. The operator may still finish that submission, so retrying can pay twice.

The shared-regtest test uses two real SDK wallets to send exactly 50 sats, recycle the verified delivery into one spendable receiver coin, and prove the Taxi float is repaid. It runs the Taxi profile of `ArkLabsHQ/arkade-regtest` at `185da8e2863fb461d12b898a0a692b0623476254`.

```sh
git clone https://github.com/ArkLabsHQ/arkade-regtest.git arkade-regtest
git -C arkade-regtest checkout 185da8e2863fb461d12b898a0a692b0623476254
pnpm -r build
docker build -t arkade-taxi:regtest .
pnpm regtest:up:client
pnpm regtest:test:client
pnpm regtest:down:client
```

Set `ARKADE_REGTEST_DIR` to use an existing checkout at that revision. `pnpm test:integration:client` cleans that shared profile, starts it, tests it and stops it. It is separate from the existing production-artifact `pnpm e2e:stack` acceptance suite; both run in CI.
