import { classifyBoardingExpiry, decodeBoardingExit, type Coin, type Wallet } from "@arkade-os/sdk";
import type { createOperatorRuntime } from "./arkade/operatorWallet.js";
import { ServiceError } from "./errors.js";

export interface BoardingDeposits {
    confirmedSats: bigint;
    unconfirmedSats: bigint;
    expiredSats: bigint;
    unknownSats: bigint;
}

const total = (coins: readonly Coin[]) => coins.reduce((sum, c) => sum + BigInt(c.value), 0n);

/** Expiry as the SDK's VtxoManager judges it before auto-boarding (vtxo-manager.ts
 * runPeriodicSettle): an expired deposit is swept back, never boarded. */
async function boardingDeposits(wallet: Wallet): Promise<BoardingDeposits> {
    const utxos = await wallet.getBoardingUtxos();
    const provider = wallet.onchainProvider;
    const expiry = await classifyBoardingExpiry(
        utxos,
        () => provider.getChainTip(),
        provider.getMedianTimePast?.bind(provider),
    );
    const expired = new Set(expiry.expired);
    const unknown = new Set([
        ...expiry.unknown,
        ...utxos.filter((coin) => coin.status.confirmed && !decodeBoardingExit(coin)),
    ]);
    return {
        confirmedSats: total(
            utxos.filter((c) => c.status.confirmed && !expired.has(c) && !unknown.has(c)),
        ),
        unconfirmedSats: total(utxos.filter((c) => !c.status.confirmed)),
        expiredSats: total([...expired]),
        unknownSats: total([...unknown]),
    };
}

export function createBoarding(runtime: Pick<ReturnType<typeof createOperatorRuntime>, "wallet">) {
    const wallet = () => {
        if (!runtime.wallet)
            throw new ServiceError("runtime_unsafe", 503, "operator wallet unavailable");
        return runtime.wallet;
    };
    return {
        address: async () => wallet().getBoardingAddress(),
        deposits: async () => boardingDeposits(wallet()),
    };
}
