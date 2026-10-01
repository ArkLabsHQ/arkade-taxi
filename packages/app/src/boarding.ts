import {
    ArkAddress,
    CSVMultisigTapscript,
    Estimator,
    hasBoardingTxExpired,
    type Coin,
    type ExtendedCoin,
    type IntentFeeConfig,
    type Wallet,
} from "@arkade-os/sdk";
import { hex } from "@scure/base";
import type { RuntimeConfig } from "./config.js";
import type { createOperatorRuntime } from "./arkade/operatorWallet.js";
import { verifyProviders } from "./arkade/providers.js";
import { sanitizeOperationalError, ServiceError } from "./errors.js";

export interface BoardingStatus {
    state: "idle" | "running" | "succeeded" | "failed";
    actor: string | null;
    amountSats: string | null;
    authorizedFeeSats: string | null;
    maxFeeSats: string;
    commitmentTxid: string | null;
    error: string | null;
}

export interface BoardingDeposits {
    confirmedSats: bigint;
    unconfirmedSats: bigint;
    expiredSats: bigint;
}

const fail = (code: string): never => {
    throw new Error(code);
};
const checkedFee = (sats: number) =>
    Number.isSafeInteger(sats) && sats >= 0 ? BigInt(sats) : fail("boarding_fee_invalid");
const total = (coins: readonly Coin[]) => coins.reduce((sum, c) => sum + BigInt(c.value), 0n);

/** Priced the way the SDK's own `settle()` prices a boarding: each input, then
 * the one output left after the input fees. */
export function boardingFee(inputs: readonly Coin[], fees: IntentFeeConfig, script: string) {
    const estimator = new Estimator(fees);
    const inputFees = inputs.reduce(
        (sum, c) =>
            sum + checkedFee(estimator.evalOnchainInput({ amount: BigInt(c.value) }).satoshis),
        0n,
    );
    const amount = total(inputs) - inputFees;
    return inputFees + checkedFee(estimator.evalOffchainOutput({ amount, script }).satoshis);
}

/** Expiry exactly as `Wallet.settle()` drops it from its default inputs (SDK 0.4.77,
 * dist/chunk-S453MR7E.js:15408-15419): once the exit path matures, arkd refuses it. */
async function boardingDeposits(wallet: Wallet) {
    const utxos = await wallet.getBoardingUtxos();
    const exit = CSVMultisigTapscript.decode(hex.decode(wallet.boardingTapscript.exitScript));
    const { timelock } = exit.params;
    const height =
        timelock.type === "blocks"
            ? (await wallet.onchainProvider.getChainTip()).height
            : undefined;
    const expired = (c: ExtendedCoin) => hasBoardingTxExpired(c, timelock, height);
    return {
        boardable: utxos.filter((c) => c.status.confirmed && !expired(c)),
        unconfirmed: utxos.filter((c) => !c.status.confirmed),
        expired: utxos.filter(expired),
    };
}

export function createBoarding({
    config,
    runtime,
}: {
    config: RuntimeConfig;
    runtime: Pick<
        ReturnType<typeof createOperatorRuntime>,
        "wallet" | "providers" | "withSettlement"
    >;
}) {
    const operator = new ArkAddress(config.serverPubkey, config.operatorKey, config.addressHrp);
    const address = operator.encode();
    const script = hex.encode(operator.pkScript);
    let status: BoardingStatus = {
        state: "idle",
        actor: null,
        amountSats: null,
        authorizedFeeSats: null,
        maxFeeSats: config.boardingMaxFeeSats.toString(),
        commitmentTxid: null,
        error: null,
    };
    let active: Promise<void> | undefined;
    let stopped = false;
    const wallet = () => {
        if (!runtime.wallet)
            throw new ServiceError("runtime_unsafe", 503, "operator wallet unavailable");
        return runtime.wallet;
    };

    return {
        status: () => status,
        address: async () => wallet().getBoardingAddress(),
        deposits: async (): Promise<BoardingDeposits> => {
            const { boardable, unconfirmed, expired } = await boardingDeposits(wallet());
            return {
                confirmedSats: total(boardable),
                unconfirmedSats: total(unconfirmed),
                expiredSats: total(expired),
            };
        },
        stop() {
            stopped = true;
        },
        async start(actor: string): Promise<void> {
            if (active)
                throw new ServiceError("boarding_active", 409, "a boarding job is already running");
            let plan: { inputs: ExtendedCoin[]; fee: bigint } | undefined;
            let accept!: () => void;
            const accepted = new Promise<void>((resolve) => (accept = resolve));
            const job = runtime.withSettlement(
                async (wallet) => {
                    const inputs = (await boardingDeposits(wallet)).boardable;
                    if (!inputs.length)
                        throw new ServiceError(
                            "boarding_nothing_confirmed",
                            409,
                            "no confirmed, unexpired on-chain deposit to board",
                        );
                    const info = await wallet.arkProvider.getInfo();
                    const fee = boardingFee(inputs, info.fees?.intentFee ?? {}, script);
                    const amount = total(inputs) - fee;
                    if (fee > config.boardingMaxFeeSats)
                        throw new ServiceError(
                            "boarding_fee_cap_exceeded",
                            409,
                            `boarding fee ${fee} sats exceeds TAXI_BOARDING_MAX_FEE_SATS (${config.boardingMaxFeeSats})`,
                        );
                    if (amount <= 0n)
                        throw new ServiceError(
                            "boarding_amount_invalid",
                            409,
                            "the confirmed deposits do not cover the boarding fee",
                        );
                    plan = { inputs, fee };
                    status = {
                        ...status,
                        state: "running",
                        actor,
                        amountSats: amount.toString(),
                        authorizedFeeSats: fee.toString(),
                        commitmentTxid: null,
                        error: null,
                    };
                    accept();
                    return wallet.settle({ inputs, outputs: [{ address, amount }] });
                },
                async () => {
                    if (stopped) fail("boarding_stopped");
                    const verified = await verifyProviders(config, runtime.providers);
                    if (verified.blockers.length || !verified.info)
                        fail("boarding_provider_unsafe");
                    const fees = verified.info!.fees?.intentFee ?? {};
                    if (boardingFee(plan!.inputs, fees, script) !== plan!.fee)
                        fail("boarding_fee_authorization_changed");
                    return () => {
                        if (stopped) fail("boarding_stopped");
                    };
                },
            );
            active = job.then(
                (commitmentTxid) => {
                    active = undefined;
                    status = { ...status, state: "succeeded", commitmentTxid };
                },
                (error) => {
                    active = undefined;
                    if (plan)
                        status = {
                            ...status,
                            state: "failed",
                            error: sanitizeOperationalError(error, "boarding failed"),
                        };
                },
            );
            // Answers once the settlement lock is held and the fee authorized; the
            // batch round itself runs on as the job.
            try {
                await Promise.race([accepted, job]);
            } catch (error) {
                const code = error instanceof Error ? error.message : "";
                if (code === "proceeds_worker_active")
                    throw new ServiceError(
                        "settlement_active",
                        409,
                        "another settlement is running; board once it finishes",
                    );
                if (code === "proceeds_wallet_unavailable")
                    throw new ServiceError("runtime_unsafe", 503, "operator wallet unavailable");
                throw error;
            }
        },
    };
}
