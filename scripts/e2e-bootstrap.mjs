/**
 * Bring a regtest wallet into existence and report what it holds, so the
 * lockup path can be exercised against a live stack.
 *
 *   node scripts/e2e-bootstrap.mjs [arkdUrl]
 *
 * Prints a boarding address and exits when unfunded; funding is a separate,
 * deliberate step because it mines a block.
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
import { hex } from "@scure/base";

const ARKD = process.argv[2] ?? "http://127.0.0.1:7070";
const SEED = process.env.TAXI_E2E_SEED ?? "11".repeat(32);

configureEventSource((url) => new EventSource(url));

const identity = SingleKey.fromHex(SEED);
const xonly = await identity.xOnlyPublicKey();
console.log(`identity xonly ${hex.encode(xonly)}`);

// Storage defaults to IndexedDB, which does not exist in Node.
const wallet = await Wallet.create({
    identity,
    arkServerUrl: ARKD,
    storage: {
        walletRepository: new InMemoryWalletRepository(),
        contractRepository: new InMemoryContractRepository(),
        intentRepository: new InMemoryIntentRepository(),
        virtualTxRepository: new InMemoryVirtualTxRepository(),
    },
});

const [address, boarding, balance] = await Promise.all([
    wallet.getAddress(),
    wallet.getBoardingAddress(),
    wallet.getBalance(),
]);

console.log(`arkade address ${address}`);
console.log(`boarding       ${boarding}`);
console.log(
    `balance        ${JSON.stringify(balance, (_, v) => (typeof v === "bigint" ? v.toString() : v))}`,
);

// The wallet holds an open subscription, so the event loop never drains.
process.exit(0);
