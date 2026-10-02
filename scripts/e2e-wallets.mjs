import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import {
    ArkAddress,
    DelegateVtxo,
    InMemoryContractRepository,
    InMemoryIntentRepository,
    InMemoryVirtualTxRepository,
    InMemoryWalletRepository,
    SingleKey,
    Wallet,
    configureEventSource,
    scriptFromTapLeafScript,
} from "@arkade-os/sdk";
import { hex } from "@scure/base";
import { ensureActorSecrets } from "./lib/harness.mjs";

if (globalThis.EventSource) configureEventSource((url) => new EventSource(url));

const storage = () => ({
    walletRepository: new InMemoryWalletRepository(),
    contractRepository: new InMemoryContractRepository(),
    intentRepository: new InMemoryIntentRepository(),
    virtualTxRepository: new InMemoryVirtualTxRepository(),
});

export function loadActorSecrets(path) {
    const existing = existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : {};
    const records = ensureActorSecrets(existing, () => randomBytes(32).toString("hex"));
    mkdirSync(dirname(path), { recursive: true });
    const temporary = `${path}.tmp`;
    writeFileSync(temporary, `${JSON.stringify(records)}\n`, { mode: 0o600 });
    renameSync(temporary, path);
    return records;
}

// The operator stays 2-leaf: the Taxi derives its own key from a DefaultVtxo.
const DELEGATED_ACTORS = new Set(["sender", "receiverSats"]);
// secp256k1's generator, a real key nobody needs to hold: with settlementConfig: false
// the SDK never asks this provider to delegate, so it only shapes the address.
const STUB_DELEGATE_PUBKEY = "0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798";

export const stubDelegateProvider = {
    getDelegateInfo: async () => ({ pubkey: STUB_DELEGATE_PUBKEY, fee: "0", delegateAddress: "" }),
    delegate: async () => {
        throw new Error("the e2e stub delegate provider never delegates");
    },
};

export function assertDelegateLeaf(address, { pubKey, serverPubKey, csvTimelock }) {
    const expected = new DelegateVtxo.Script({
        pubKey,
        serverPubKey,
        csvTimelock,
        delegatePubKey: hex.decode(STUB_DELEGATE_PUBKEY).subarray(1),
    });
    if (hex.encode(ArkAddress.decode(address).pkScript) !== hex.encode(expected.pkScript))
        throw new Error(`${address} is not the 3-leaf delegate address`);
}

export async function createActorWallets(records, { arkdUrl, esploraUrl }) {
    const result = {};
    for (const [name, seed] of Object.entries(records)) {
        const identity = SingleKey.fromHex(seed);
        const delegated = DELEGATED_ACTORS.has(name);
        const wallet = await Wallet.create({
            identity,
            arkServerUrl: arkdUrl,
            esploraUrl,
            storage: storage(),
            settlementConfig: false,
            ...(delegated ? { delegateProvider: stubDelegateProvider } : {}),
        });
        if (delegated)
            assertDelegateLeaf(await wallet.getAddress(), wallet.offchainTapscript.options);
        result[name] = { identity, wallet };
    }
    return result;
}

export const expiryOf = (coin) => {
    if (Number.isSafeInteger(coin.expiresAtHeight) && coin.expiresAtHeight > 0)
        return { kind: "height", value: String(coin.expiresAtHeight) };
    if (coin.expiresAt instanceof Date) {
        const milliseconds = coin.expiresAt.getTime();
        if (Number.isSafeInteger(milliseconds) && milliseconds > 0 && milliseconds % 1000 === 0)
            return { kind: "time", value: String(milliseconds / 1000) };
    }
    throw new Error(`VTXO ${coin.txid}:${coin.vout} has no canonical expiry`);
};

const fundingInputOf = (coin) => ({
    txid: coin.txid,
    vout: coin.vout,
    value: String(coin.value),
    tapTree: hex.encode(coin.tapTree),
    spendLeaf: hex.encode(scriptFromTapLeafScript(coin.forfeitTapLeafScript)),
    expiry: expiryOf(coin),
});

const safeBalance = (balance) =>
    JSON.parse(
        JSON.stringify(balance, (_, value) =>
            typeof value === "bigint" ? value.toString() : value,
        ),
    );

export async function publicWalletFixture(actor) {
    const [address, pubkey, balance, coins] = await Promise.all([
        actor.wallet.getAddress(),
        actor.identity.xOnlyPublicKey(),
        actor.wallet.getBalance(),
        actor.wallet.getSpendableVtxos(),
    ]);
    return {
        address,
        pubkey: hex.encode(pubkey),
        balance: safeBalance(balance),
        vtxos: coins.map((coin) => ({
            ...fundingInputOf(coin),
            assets: safeBalance(coin.assets ?? []),
            virtualStatus: coin.virtualStatus,
        })),
    };
}

export async function disposeActorWallets(actors) {
    await Promise.all(Object.values(actors).map(({ wallet }) => wallet.dispose().catch(() => {})));
}
