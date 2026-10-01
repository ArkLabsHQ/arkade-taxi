import {
    CSVMultisigTapscript,
    hasBoardingTxExpired,
    type Coin,
    type ExtendedCoin,
    type Wallet,
} from "@arkade-os/sdk";
import { hex } from "@scure/base";
import type { createOperatorRuntime } from "./arkade/operatorWallet.js";
import { ServiceError } from "./errors.js";

export interface BoardingDeposits {
    confirmedSats: bigint;
    unconfirmedSats: bigint;
    expiredSats: bigint;
}

const total = (coins: readonly Coin[]) => coins.reduce((sum, c) => sum + BigInt(c.value), 0n);

/** Expiry as the SDK's VtxoManager judges it before auto-boarding (vtxo-manager.ts
 * runPeriodicSettle): an expired deposit is swept back, never boarded. */
async function boardingDeposits(wallet: Wallet): Promise<BoardingDeposits> {
    const utxos = await wallet.getBoardingUtxos();
    const exit = CSVMultisigTapscript.decode(hex.decode(wallet.boardingTapscript.exitScript));
    const { timelock } = exit.params;
    const height =
        timelock.type === "blocks"
            ? (await wallet.onchainProvider.getChainTip()).height
            : undefined;
    const expired = (c: ExtendedCoin) => hasBoardingTxExpired(c, timelock, height);
    return {
        confirmedSats: total(utxos.filter((c) => c.status.confirmed && !expired(c))),
        unconfirmedSats: total(utxos.filter((c) => !c.status.confirmed)),
        expiredSats: total(utxos.filter(expired)),
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
