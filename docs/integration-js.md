# Integrating `@arkade-taxi/client`

A wallet-side guide. The flow is **quote → verify → sign → submit**, and the
middle step is the whole security argument.

```bash
pnpm add @arkade-taxi/client
```

You also need connectivity to **arkd and the emulator**, not only to the
operator. A client that can only reach the operator cannot check anything it is
told.

## Do not skip verification

`verifyQuote` rebuilds the covenant from the quoted parameters, using the same
package the operator used, and refuses unless the derived address equals the
`covenantAddress` you were handed.

**That check is worthless on its own.** It is only meaningful once you have
pinned `serverKey` and `emulatorKey` against keys you already trust. Otherwise
an operator names an emulator it controls, derives an address from it, and the
rebuild agrees with the forgery — a self-consistent lie.

So `verifyQuote` takes `trustedServerKey` and `trustedEmulatorKey` as separate
arguments from the `info` response, checks them **first**, and then builds the
script from the trusted values rather than from what `info` claimed. Weakening
the pin cannot quietly re-enable the attack, because the address it compares
against was never derived from the operator's keys in the first place.

`e2e/verify-quote.e2e.test.ts` asserts exactly this: an unpinned client accepts
a rogue-emulator quote, a pinned one rejects it at `UNTRUSTED_EMULATOR_KEY`
before the address is ever derived.

The API is shaped so this is awkward to skip. `TaxiClient.submitLockup` takes a
`VerifiedQuote`, and the only way to obtain one is `verifyQuote` — the brand is
unconstructible outside that module. There is no `submitLockup(transferId, …)`.

## Where the trusted keys come from

From the Arkade Service and emulator **your wallet is already talking to**, not
from the operator:

```ts
import { hex } from "@scure/base";

// arkd and the emulator both serve `signerPubkey` on GET /v1/info, compressed
// (33 bytes). The covenant leaves take the 32-byte x-only form.
const xOnly = (compressed: string): Uint8Array => hex.decode(compressed).slice(-32);

const trustedServerKey = xOnly(arkdInfo.signerPubkey);
const trustedEmulatorKey = xOnly(emulatorInfo.signerPubkey);
```

If your wallet ships a pinned key set, use that instead — the requirement is
that the value has an origin independent of the operator.

```ts
// ✗ Wrong. This is the attack, written out.
const trustedServerKey = hexToBytes(info.serverKey);
const trustedEmulatorKey = hexToBytes(info.emulatorKey);
```

Pinning against `info` compares the operator's claim to the operator's claim.

## The flow

```ts
import {
    TaxiClient,
    QuoteVerificationError,
    TaxiError,
    VerificationErrorCode,
    verifyQuote,
    type QuoteExpectation,
    type VerifiedQuote,
} from "@arkade-taxi/client";

const taxi = new TaxiClient({ baseUrl: "https://taxi.example" });

// 1. What the operator advertises. Every field is decoded and checked; a
//    malformed body raises TaxiError rather than reaching your logic.
const info = await taxi.info();

// 2. Ask for a quote.
const quote = await taxi.requestQuote({
    receiverKey, // 32-byte x-only
    senderKey, // 32-byte x-only
    assetId, // optional; omit for a sub-dust bitcoin transfer
    senderSats: 0n, // sats you contribute; 0n = the operator funds it all
});

// 3. Verify. Everything you are willing to accept goes in `expect`.
const expectation: QuoteExpectation = {
    receiverKey,
    senderKey,
    assetId,
    maxTopupSats: 330n,
    maxFeeSats: 50n,
    minLocktime: 800_000n,
};

const verified: VerifiedQuote = verifyQuote({
    quote,
    info,
    expect: expectation,
    trustedServerKey,
    trustedEmulatorKey,
    vtxoMinAmount: 1n,
    hrp: "tark", // "ark" on mainnet
});

// 4. Sign your own inputs on the PSBT the operator prepared. Its topup input is
//    already contributed; yours are not.
const signedLockupTx = await wallet.signPsbt(verified.quote.unsignedLockupTx);

// 5. Submit. Takes the VerifiedQuote, not an id.
const { txid, outpoint } = await taxi.submitLockup(verified, signedLockupTx);

// 6. Poll.
const state = await taxi.status(quote.transferId);
```

`verified` also carries `params` (decoded to `bigint`/`Uint8Array`) and `script`,
the `DustCovenantScript` you will need to build the receiver's claim later. Keep
it rather than re-deriving.

## What `verifyQuote` checks, in order

Order matters when you are reading an error: the first failure wins, so a quote
with two problems reports the earlier one.

| Step | Check                                      | Code on failure             |
| ---- | ------------------------------------------ | --------------------------- |
| 1    | `info` decodes                             | `MALFORMED_INFO`            |
| 2    | protocol version matches this client       | `PROTOCOL_VERSION_MISMATCH` |
| 3    | `info.serverKey` == `trustedServerKey`     | `UNTRUSTED_SERVER_KEY`      |
| 4    | `info.emulatorKey` == `trustedEmulatorKey` | `UNTRUSTED_EMULATOR_KEY`    |
| 5    | `quote` decodes                            | `MALFORMED_QUOTE`           |
| 6    | quoted receiver is the one you named       | `RECEIVER_KEY_MISMATCH`     |
| 7    | quoted sender is the one you named         | `SENDER_KEY_MISMATCH`       |
| 8    | quoted asset is the one you are paying     | `ASSET_ID_MISMATCH`         |
| 9    | quoted operator matches `/v1/info`         | `OPERATOR_KEY_MISMATCH`     |
| 10   | quoted `dust` matches `/v1/info`           | `DUST_MISMATCH`             |
| 11   | `topup` ≤ `maxTopupSats`                   | `TOPUP_ABOVE_MAX`           |
| 12   | `feeSats` ≤ `maxFeeSats`                   | `FEE_ABOVE_MAX`             |
| 13   | `locktime` ≥ `minLocktime`                 | `LOCKTIME_BELOW_MIN`        |
| 14   | not expired                                | `QUOTE_EXPIRED`             |
| 15   | parameters build a valid covenant          | `INVALID_COVENANT_PARAMS`   |
| 16   | re-derived address == `covenantAddress`    | `COVENANT_ADDRESS_MISMATCH` |

Steps 3 and 4 are what make step 16 mean anything.

## Errors

Two classes, deliberately distinguishable, so "the operator is lying" never
looks like "the network is down":

- `QuoteVerificationError` — a quote you must not fund. `code` is one of
  `VerificationErrorCode`. Do not retry; the answer will not change.
- `TaxiError` — transport and shape. `code` is one of `ClientErrorCode`
  (`NETWORK_ERROR`, `HTTP_ERROR`, `INVALID_RESPONSE`), or the operator's own
  code when the body parsed as an `ErrorResponse` — `paused` is retryable, the
  rest of the admission reasons are not.

```ts
try {
    const verified = verifyQuote({ ...args });
} catch (e) {
    if (e instanceof QuoteVerificationError) {
        if (e.code === VerificationErrorCode.EmulatorKey) {
            // The operator named an emulator you do not trust. Stop.
        }
        throw e;
    }
    throw e;
}
```

`QuoteVerificationError` extends `TaxiError`, so order your `instanceof` checks
narrowest first.

## Two details that cost time to rediscover

**`expiresAt` is unix seconds, not milliseconds.** The unit is part of the wire
contract because getting it wrong fails _open_: a millisecond timestamp compared
as seconds is always far-future, so every expired quote reads as valid. Reject
at or after the instant, never merely past it. `verifyQuote` takes an optional
`now` (seconds) so this is testable.

**Amounts cross the wire as decimal strings and byte fields as lowercase hex.**
JSON has no bigint, and a sats value silently losing precision above 2^53 is a
bug that only appears on a large payment. The client decodes both for you;
`quote.params` on the raw response is wire-shaped, while `verified.params` is
decoded. Read the decoded one.

## After the lockup

There are no claim or refund endpoints, and that is the design rather than an
omission. Every leaf is `Multisig[server, ⊕script]` — the operator is a payout
destination and never a signer — so a receiver claims with the Arkade Service
and emulator signatures alone, and a sender refunds with its own signature plus
those two. The operator cannot censor either, and only watches for the spend to
reconcile its ledger.

Which means the wallet, not the operator, owns what happens next:

- `recycle` — the receiver merges the covenant into an account it owns, repaying
  the operator in sats.
- `purchase` — the receiver keeps the whole covenant; the operator was paid at
  lockup.
- `refundSender` — the sender cancels before `locktime`.

The transaction-building for these is not yet in this repository; see
`e2e/README.md` for the scenarios that will cover it and what each of them is
waiting on.
