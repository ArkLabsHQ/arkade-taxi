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

From the underlying Arkade operator and emulator **your wallet is already
talking to**, not from the taxi operator:

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

The same rule applies to `trustedServerUnrollScript`. Obtain it from the Arkade
operator your wallet already trusts and validate `arkdInfo.checkpointTapscript`
with the public SDK's `assertValidServerUnrollScript` and a policy derived from
your locally configured network. Pass the returned `.script`; never copy the
unroll script out of the taxi envelope and call that trusted.

## The flow

The same code runs in a browser and in Node.js 22.12 or newer. Browsers use
their native `fetch`, `TextEncoder`, and `TextDecoder`; Node uses the matching
globals. The client signing path does not require `Buffer`, `node:crypto`, or
the service's Node-only envelope parser. `TaxiClient({ fetch })` configures only
requests to the Taxi HTTP API; it does not replace the ambient fetch used by
the public SDK covenant providers.

```ts
import {
    TaxiClient,
    QuoteVerificationError,
    TaxiError,
    VerificationErrorCode,
    signLockup,
    verifyQuote,
    type QuoteExpectation,
    type VerifiedQuote,
} from "@arkade-taxi/client";
import { asset, scriptFromTapLeafScript } from "@arkade-os/sdk";

const taxi = new TaxiClient({ baseUrl: "https://taxi.example" });

// 1. What the operator advertises. Every field is decoded and checked; a
//    malformed body raises TaxiError rather than reaching your logic.
const info = await taxi.info();

// 2. Select spendable VTXOs using your wallet's coin-selection policy, then
//    preserve their exact funding evidence. Never synthesize these values.
const selectedVtxos = await selectTaxiFunding(wallet);
const expiryOf = (vtxo) => {
    if (vtxo.expiresAtHeight !== undefined)
        return { kind: "height", value: BigInt(vtxo.expiresAtHeight) };
    if (vtxo.expiresAt !== undefined)
        return { kind: "time", value: BigInt(Math.floor(vtxo.expiresAt.getTime() / 1000)) };
    throw new Error("selected VTXO has no tagged expiry");
};
const holdingsOf = (vtxo) => {
    const groups = [...(vtxo.assets ?? [])]
        .sort((a, b) => a.assetId.localeCompare(b.assetId))
        .map(({ assetId, amount }) =>
            asset.AssetGroup.create(
                asset.AssetId.fromString(assetId),
                null,
                [],
                [asset.AssetOutput.create(vtxo.vout, amount)],
                [],
            ),
        );
    return groups.length ? asset.Packet.create(groups).serialize() : undefined;
};
const senderInputs = selectedVtxos.map((vtxo) => {
    const assetPacket = holdingsOf(vtxo);
    return {
        txid: vtxo.txid,
        vout: vtxo.vout,
        value: BigInt(vtxo.value),
        tapTree: vtxo.tapTree,
        spendLeaf: scriptFromTapLeafScript(vtxo.forfeitTapLeafScript),
        expiry: expiryOf(vtxo),
        ...(assetPacket ? { assetPacket } : {}),
    };
});
const senderSats = senderInputs.reduce((sum, input) => sum + input.value, 0n);

// 3. Ask for a quote. assetUnits remains bigint and crosses the wire as an
//    exact decimal string, including values above Number.MAX_SAFE_INTEGER.
const quote = await taxi.requestQuote({
    senderInputs,
    receiverKey, // 32-byte x-only
    senderKey, // 32-byte x-only
    assetId, // optional; omit for a sub-dust bitcoin transfer
    assetUnits, // optional exact asset quantity
    fareId, // optional id selected from info.assetRules
    senderSats,
});

// 4. Verify. Everything you are willing to accept goes in `expect`; funding,
//    tagged expiries and the unroll script come from independent wallet state.
const expectation: QuoteExpectation = {
    receiverKey,
    senderKey,
    assetId,
    maxTopupSats: 330n,
    maxFare: { currency: "sats", units: 50n },
    minLocktime: 800_000n,
};

const verified: VerifiedQuote = verifyQuote({
    quote,
    info,
    expect: expectation,
    trustedServerKey,
    trustedEmulatorKey,
    vtxoMinAmount: BigInt(info.vtxoMinAmount),
    hrp: "tark", // "ark" on mainnet
    senderInputs,
    senderSats,
    assetUnits,
    trustedServerUnrollScript,
});

// 5. Sign. `identity` is the same public SDK Identity your Arkade wallet uses.
const signedLockupTx = await signLockup({ verified, identity: wallet.identity });

// 6. Submit. Takes the VerifiedQuote, never a caller-supplied transfer id.
const { txid, outpoint } = await taxi.submitLockup(verified, signedLockupTx);

// 7. Poll until your application reaches a terminal state.
let state = await taxi.status(verified.quote.transferId);
while (!terminalStates.has(state.state)) {
    await waitBeforePolling();
    state = await taxi.status(verified.quote.transferId);
}
```

`prepareAndSubmitLockup(verified, identity)` safely composes steps 5 and 6 when
you do not need to retain the signed envelope. `signLockup` first reconstructs
and validates the complete graph from the original authorization, then calls
`identity.sign` with only the independently derived sender input indexes. It
also pre-signs checkpoint input 0 for checkpoints belonging to sender inputs.
Batch-capable identities receive the Arkade transaction and sender checkpoints in
one `signMultiple` interaction. It accepts only canonical `SigHash.DEFAULT`,
verifies every returned sender signature, refuses signatures on operator-owned
inputs or checkpoints, and preserves all unsigned graph bytes.

Submission is queued and idempotent. A successful POST normally returns HTTP
202 after atomically storing the exact signed envelope; a leased background
worker performs and resumes provider submission/finalization. Poll status until
it becomes `locked`. Repeating the identical signed envelope reports the
current state and does not start a second inline network effect. A different
envelope for the same transfer is a conflict. A timeout or ambiguous provider
result remains `locking`; keep polling instead of constructing a replacement
transaction.

Status may carry `submissionPhase`, `failureCode`, and `failureDetail`. A phase
of `failed` or `legacy` requires operator action and blocks new admission; the
client should keep the transfer identifier and must not construct a replacement
graph.

`verified` also carries `params` (decoded to `bigint`/`Uint8Array`), `script`,
the independently decoded `envelope`, and the validated `senderInputIndexes`.
It is a runtime capability as well as a TypeScript brand: copying or mutating it
does not produce another usable signing/submission capability.

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
| 12   | fare currency/asset/units are authorized   | `FEE_ABOVE_MAX`             |
| 13   | `locktime` ≥ `minLocktime`                 | `LOCKTIME_BELOW_MIN`        |
| 14   | not expired                                | `QUOTE_EXPIRED`             |
| 15   | parameters build a valid covenant          | `INVALID_COVENANT_PARAMS`   |
| 16   | re-derived address == `covenantAddress`    | `COVENANT_ADDRESS_MISMATCH` |
| 17   | full lockup graph matches original funding | `MALFORMED_QUOTE`           |

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

There are no Taxi claim or refund endpoints. These are wallet-side covenant
spends submitted through the configured public SDK `EmulatorProvider`; the Taxi
service only watches the resulting outpoint spend to reconcile its ledger. The
Taxi payout key is a destination, not a leaf signer. The actual leaves require
the Arkade Service and the covenant's tweaked emulator key, while `refundSender`
also requires the verified sender key.

Which means the wallet, not the operator, owns what happens next:

- `recycle` — the receiver merges the covenant into an account it owns, repaying
  the operator in sats.
- `purchase` — the receiver keeps the whole covenant; the operator was paid at
  lockup.
- `refund` (`refundSender` leaf) — the sender cancels with its own identity.

Never pass a transfer id or a status object to these operations. First exchange
the verified quote, the exact lockup response and fresh Taxi/indexer/provider
facts for an opaque `CovenantTransfer` capability:

```ts
const transfer = await taxi.verifyTransfer(verified, lockup, {
    arkdUrl,
    emulatorUrl,
    network,
    serverUnrollScript: serverUnrollScriptHex,
    chainHeight: currentHeight,
});

const txid = await taxi.purchase(transfer, verifiedReceiverAccountScript);
// or: await taxi.recycle(transfer, receiverWalletInput, verifiedReceiverAccountScript)
// or: await taxi.refund(transfer, senderIdentity)
```

The capability binds the provider URLs and keys, network, asset/fare/top-up,
parties, locktime, covenant output index/value/script and the currently
spendable indexed outpoint. Its displayed properties are a detached snapshot,
not authorization. `recycle` additionally requires a `ReceiverWalletInput`
whose exact outpoint, value, canonical tree/leaf proof, expiry, assets and
identity are independently checked; it is always input 1 after the covenant at
input 0.

Provider destinations and implementations are isolated when the capability is
created. The public config contains only primitive URLs and trust facts; custom
provider objects and functions are rejected. The client constructs private SDK
REST providers for the Arkade Service, indexer and emulator from the verified
URLs. Their URLs and private prototype snapshots cannot be replaced through
caller-held objects.
The SDK REST providers use the realm's `globalThis.fetch`, independently of the
Taxi client's ordinary HTTP option: `TaxiClient({ fetch })` does not configure
covenant provider calls. Consequently, same-realm code that can replace or
intercept the global fetch remains inside the transport trust boundary and can
observe, redirect or forge those calls. Applications must initialize and
protect a trusted global fetch before using covenant spends, prevent untrusted
code from running in that realm, use TLS, and enforce the expected reverse
proxy trust policy. Current Arkade Service and emulator information is checked
again before graph construction, before any owner signature, and immediately
before submission. Network, keys, checkpoint script, dust, minimum amount or
required OP_RETURN-capacity drift aborts that operation.

The owner identity signs only Arkade transaction and checkpoint inputs it owns.
The emulator call then supplies the server/emulator covenant signatures and
returns the final graph. The client rejects changed unsigned fields or metadata, reordered
checkpoints, a changed txid, unexpected keys or leaf hashes, non-default
sighashes, malformed signatures and loss of an owner's signature. It returns
only that independently verified Arkade transaction id. It does not call a generic
forfeit builder or make a second Arkade Service submission.

`EmulatorProvider.submitTx` is a network effect. A transport failure can be
ambiguous. Each capability and exact outpoint/provider tuple is one-shot within
the process while any matching capability remains live: concurrent use, replay
after success, and replay after an ambiguous response are rejected. The shared
registry holds only weak lifecycle references and cleans dead outpoint entries;
each live opaque capability holds its lifecycle strongly. A
`CovenantSpendAmbiguousError` includes the independently known `expectedTxid`;
persist the operation/outpoint in the calling application and observe that txid
and the exact covenant outpoint before deciding recovery. Do not blindly rebuild
and resubmit. Pre-submission validation failures also consume the capability
conservatively. Browser restarts erase in-memory guards, so durable caller
idempotency and exact-transaction retry behavior must be verified against the
live emulator. Live Arkade Service/emulator acceptance, including the
three-`OP_RETURN` refund shape supported by this client, remains part of the
provider E2E suite described in `e2e/README.md`.

If the receiver remains offline, Taxi's persisted recovery worker returns funds
through the permissionless recovery leaf after its tagged locktime and before
batch expiry. Applications should retain transfer identifiers and observe
terminal status after reconnecting. `recovering` means an exact recovery intent
or submission exists; `recovered` requires canonical observation. Height and
time deadlines use independent chain clocks, and quote `expiresAt` is a separate
Unix-seconds deadline.

Taxi owns this pre-expiry recovery guarantee. The deployed Arkade Service's
special covenant settlement is an external assumption, not a client capability
flag or a Taxi implementation. A dedicated upstream forfeit mechanism is out
of scope. Run all 17 live scenarios and both integrity checks against current
regtest master before adopting a changed provider deployment; retain that run's
`stack.json` master SHA and image identities with its results. The stable SDK
registry checkpoint on 2026-09-12 is `@arkade-os/sdk` 0.4.72.
