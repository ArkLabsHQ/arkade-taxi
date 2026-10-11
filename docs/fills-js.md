# Caller-built fills

Use `requestVerifiedReceiveQuote` to obtain and verify the covenant, reserved
`operatorInputs`, `operatorScript`, fare and expiry floor. Build the whole graph
with the integration that owns the payment rail. Swap callers use
`buildOfferFillPlan` from `@arkade-os/swap`. Check the caller's own payouts and
sign only its inputs, leaving the declared Taxi inputs unsigned.

Call `TaxiClient.submitFill` once with the quote ID, a durable operation ID,
the signed Arkade PSBT and index-aligned checkpoints, Taxi input indexes,
covenant output index and asset units. Set `validUntil` to the caller's own
deadline when it is earlier than the quote's expiry. Persist the operation and
record liability before the call: a transport error can occur after submission.

Persist the returned fill ID and poll `fillStatus` to observe settlement. An
ambiguous response requires reconciliation; do not build a replacement spend
from the same inputs. The Taxi returns status rather than signed PSBTs. The
receiver verifies the incoming covenant before claiming.

`requestVerifiedSwapFillQuote` and `submitSwapFill` are removed. The claim and
send helpers, transfer builder and sponsored-transfer builder remain available.
Migration 18 and the strict receive-quote decoder require re-vendoring clients
together with the server cutover. See [the wire protocol](protocol.md#post-v1fills)
for the request and validation rules.
