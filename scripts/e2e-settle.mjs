/**
 * Settle boarding UTXOs into VTXOs, so the wallet holds something spendable
 * offchain. Run with --experimental-eventsource; the batch reports progress
 * over server-sent events and without one the SDK falls back to slow polling.
 *
 *   node --experimental-eventsource scripts/e2e-settle.mjs [arkdUrl]
 */

import {
    InMemoryContractRepository,
    InMemoryIntentRepository,
    InMemoryVirtualTxRepository,
    InMemoryWalletRepository,
    SingleKey,
    Wallet,
    configureEventSource,
} from "@arkade-os/sdk";

const ARKD = process.argv[2] ?? "http://127.0.0.1:7070";
const SEED = process.env.TAXI_E2E_SEED ?? "11".repeat(32);

/**
 * KNOWN BLOCKER, not yet solved. Against arkd v0.9.16 this reaches
 * `batch_failed` with `not enough intent confirmations received`: arkd logs
 * "started confirmation stage", but the SDK's callback only ever sees
 * `stream_started` then `batch_failed` — it never observes the stage it is
 * supposed to confirm in, so the round times out and the intent lingers.
 *
 * Wiring EventSource explicitly (below) did NOT fix it, so the missing SSE
 * delivery is a symptom rather than the cause. Boarding funds are confirmed and
 * visible, so everything up to the batch works.
 */
configureEventSource((url) => new EventSource(url));

const show = (v) => JSON.stringify(v, (_, x) => (typeof x === "bigint" ? x.toString() : x));

const wallet = await Wallet.create({
    identity: SingleKey.fromHex(SEED),
    arkServerUrl: ARKD,
    storage: {
        walletRepository: new InMemoryWalletRepository(),
        contractRepository: new InMemoryContractRepository(),
        intentRepository: new InMemoryIntentRepository(),
        virtualTxRepository: new InMemoryVirtualTxRepository(),
    },
});

const before = await wallet.getBalance();
console.log(`before ${show(before)}`);

if (before.boarding.confirmed === 0 && before.settled === 0) {
    console.log("nothing to settle — fund the boarding address first");
    process.exit(1);
}

const txid = await wallet.settle(undefined, (event) =>
    console.log(`  event ${event.type} ${event.type.includes("fail") ? show(event) : ""}`),
);
console.log(`settled in ${txid}`);

const after = await wallet.getBalance();
console.log(`after  ${show(after)}`);

const vtxos = await wallet.getVtxos();
console.log(`vtxos  ${vtxos.length}`);
for (const v of vtxos) console.log(`  ${v.txid}:${v.vout} = ${v.value}`);

process.exit(0);
