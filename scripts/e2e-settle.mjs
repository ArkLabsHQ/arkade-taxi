import { pollUntil } from "./lib/harness.mjs";

const amount = (value) => BigInt(value ?? 0);

export async function settleWallet(wallet, label, timeoutMs = 120_000) {
    const before = await wallet.getBalance();
    if (amount(before.preconfirmed) === 0n) return { settled: false, balance: before };
    const events = [];
    const operation = wallet.settle(undefined, (event) => events.push(event.type));
    let timeoutHandle;
    const timeout = new Promise(
        (_, reject) =>
            (timeoutHandle = setTimeout(
                () =>
                    reject(
                        new Error(`timed out settling ${label}; last=${events.at(-1) ?? "none"}`),
                    ),
                timeoutMs,
            )),
    );
    let txid;
    try {
        txid = await Promise.race([operation, timeout]);
    } finally {
        clearTimeout(timeoutHandle);
    }
    const balance = await pollUntil({
        label: `${label} settled balance`,
        timeoutMs,
        intervalMs: 500,
        read: () => wallet.getBalance(),
        ready: (current) => amount(current.preconfirmed) === 0n && amount(current.settled) > 0n,
    });
    return { settled: true, txid, balance };
}

export async function settleSelectedFunding(
    wallet,
    { input, outputAmount, label, timeoutMs = 120_000 },
) {
    const inputAssets = input?.assets;
    if (
        input?.isPreconfirmed !== true ||
        !(inputAssets === undefined || (Array.isArray(inputAssets) && inputAssets.length === 0))
    )
        throw new Error(`${label} settlement input must be asset-free and preconfirmed`);
    if (
        typeof outputAmount !== "bigint" ||
        outputAmount <= 0n ||
        amount(input.value) < outputAmount
    )
        throw new Error(`${label} settlement output amount is invalid`);
    const address = await wallet.getAddress();
    const events = [];
    const operation = wallet.settle(
        { inputs: [input], outputs: [{ address, amount: outputAmount }] },
        (event) => events.push(event.type),
    );
    let timeoutHandle;
    const timeout = new Promise(
        (_, reject) =>
            (timeoutHandle = setTimeout(
                () =>
                    reject(
                        new Error(
                            `timed out settling selected ${label}; last=${events.at(-1) ?? "none"}`,
                        ),
                    ),
                timeoutMs,
            )),
    );
    let txid;
    try {
        txid = await Promise.race([operation, timeout]);
    } finally {
        clearTimeout(timeoutHandle);
    }
    return { settled: true, txid };
}
