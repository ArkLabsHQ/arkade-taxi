import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import {
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

export async function createActorWallets(records, { arkdUrl, esploraUrl }) {
    const result = {};
    for (const [name, seed] of Object.entries(records)) {
        const identity = SingleKey.fromHex(seed);
        const wallet = await Wallet.create({
            identity,
            arkServerUrl: arkdUrl,
            esploraUrl,
            storage: storage(),
            settlementConfig: false,
        });
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

export const fundingInputOf = (coin) => ({
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
