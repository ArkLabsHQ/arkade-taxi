import { afterEach, describe, expect, it, vi } from "vitest";
import {
    ArkAddress,
    CSVMultisigTapscript,
    type ExtendedCoin,
    type Wallet,
    type WalletConfig,
} from "@arkade-os/sdk";
import { openDatabase, type Database } from "@arkade-taxi/db";
import { bytesToHex } from "@arkade-taxi/protocol";
import { createOperatorRuntime } from "../src/arkade/operatorWallet.js";
import { createBoarding } from "../src/boarding.js";
import { config, fundingCoin, operatorKey, providerEmulatorKey, serverKey } from "./fixtures.js";
import { arkInfo } from "./arkade/fixtures.js";

const databases: Database[] = [];
afterEach(() => {
    vi.restoreAllMocks();
    for (const db of databases.splice(0)) db.close();
});

const address = new ArkAddress(serverKey, operatorKey, "tark").encode();
const deposit = (vout: number, value: number, confirmed = true, block_time?: number) =>
    ({
        txid: "dd".repeat(32),
        vout,
        value,
        status: block_time === undefined ? { confirmed } : { confirmed, block_time },
    }) as ExtendedCoin;
const EXIT_DELAY = 604_672;
const withFees = (intentFee: Record<string, string>) =>
    arkInfo({ fees: { intentFee, txFeeRate: "0" } });
const fees = withFees({ onchainInput: "100.0", offchainOutput: "50.0" });

function setup(boardingMaxFeeSats = 0n, info = withFees({})) {
    const db = openDatabase(":memory:");
    databases.push(db);
    const cfg = config({ addressHrp: "tark", boardingMaxFeeSats });
    let walletConfig!: WalletConfig;
    let held: Promise<void> | undefined;
    let deposits = [deposit(0, 60_000), deposit(1, 40_000), deposit(2, 5_000, false)];
    const settle = vi.fn(async (_params: unknown) => {
        await walletConfig.arkProvider!.registerIntent({} as never);
        await held;
        return "cc".repeat(32);
    });
    const providers = {
        arkProvider: { getInfo: async () => info },
        emulatorProvider: {
            getInfo: async () => ({ signerPubkey: bytesToHex(providerEmulatorKey) }),
        },
    };
    const wallet = {
        getAddress: async () => address,
        getSpendableVtxos: async () => [fundingCoin()],
        getBoardingUtxos: async () => deposits,
        boardingTapscript: {
            exitScript: bytesToHex(
                CSVMultisigTapscript.encode({
                    pubkeys: [operatorKey],
                    timelock: { type: "seconds", value: BigInt(EXIT_DELAY) },
                }).script,
            ),
        },
        getContractManager: async () => ({
            getSyncState: () => ({ mode: "online", lastSyncedAt: 1 }),
        }),
        getProviderConnectionState: () => ({ mode: "online" }),
        arkProvider: providers.arkProvider,
        onchainProvider: {
            getChainTip: async () => ({ height: 100, hash: "aa".repeat(32), time: 1789132000 }),
        },
        settle,
        dispose: async () => {},
    };
    const runtime = createOperatorRuntime(cfg, db, {
        providers,
        walletFactory: async (created) => {
            walletConfig = created;
            return wallet as unknown as Wallet;
        },
    });
    vi.spyOn(runtime.providers.arkProvider, "getInfo").mockImplementation(async () => info);
    vi.spyOn(runtime.providers.emulatorProvider, "getInfo").mockResolvedValue({
        signerPubkey: bytesToHex(providerEmulatorKey),
    } as never);
    const register = vi
        .spyOn(runtime.providers.arkProvider, "registerIntent")
        .mockResolvedValue("intent");
    return {
        runtime,
        settle,
        register,
        boarding: createBoarding({ config: cfg, runtime }),
        setDeposits(next: ExtendedCoin[]) {
            deposits = next;
        },
        hold() {
            let release!: () => void;
            held = new Promise<void>((resolve) => (release = resolve));
            return release;
        },
    };
}

describe("on-chain boarding", () => {
    it("settles exactly the confirmed deposits into the operator's address, net of the fee", async () => {
        const s = setup(250n, fees);

        await s.boarding.start("alice");
        await vi.waitFor(() => expect(s.boarding.status().state).toBe("succeeded"));

        expect(s.settle.mock.calls).toEqual([
            [
                {
                    inputs: [deposit(0, 60_000), deposit(1, 40_000)],
                    outputs: [{ address, amount: 99_750n }],
                },
            ],
        ]);
        expect(s.register).toHaveBeenCalledTimes(1);
        expect(s.boarding.status()).toEqual({
            state: "succeeded",
            actor: "alice",
            amountSats: "99750",
            authorizedFeeSats: "250",
            maxFeeSats: "250",
            commitmentTxid: "cc".repeat(32),
            error: null,
        });
    });

    it("boards a fresh deposit but never an expired one, which it reports as expiredSats", async () => {
        const s = setup();
        const now = Math.floor(Date.now() / 1000);
        const fresh = deposit(0, 60_000, true, now - 60);
        const expired = deposit(1, 40_000, true, now - EXIT_DELAY - 60);
        s.setDeposits([fresh, expired, deposit(2, 5_000, false)]);

        await s.boarding.start("alice");
        await vi.waitFor(() => expect(s.boarding.status().state).toBe("succeeded"));
        expect(s.settle.mock.calls).toEqual([
            [{ inputs: [fresh], outputs: [{ address, amount: 60_000n }] }],
        ]);
        expect(await s.boarding.deposits()).toEqual({
            confirmedSats: 60_000n,
            unconfirmedSats: 5_000n,
            expiredSats: 40_000n,
        });

        s.setDeposits([expired]);
        await expect(s.boarding.start("alice")).rejects.toMatchObject({
            code: "boarding_nothing_confirmed",
            status: 409,
        });
    });

    it("refuses a fee above the cap, and one that changed before registration", async () => {
        const capped = setup(249n, fees);
        await expect(capped.boarding.start("alice")).rejects.toMatchObject({
            code: "boarding_fee_cap_exceeded",
            status: 409,
        });
        expect(capped.settle).not.toHaveBeenCalled();
        expect(capped.boarding.status().state).toBe("idle");

        const s = setup(1_000n, fees);
        vi.spyOn(s.runtime.providers.arkProvider, "getInfo").mockResolvedValue(
            withFees({ onchainInput: "101.0", offchainOutput: "50.0" }),
        );
        await s.boarding.start("alice");
        await vi.waitFor(() =>
            expect(s.boarding.status()).toMatchObject({
                state: "failed",
                error: "boarding_fee_authorization_changed",
            }),
        );
        expect(s.register).not.toHaveBeenCalled();
    });

    it("waits out another settlement, and holds the proceeds worker off while it boards", async () => {
        const s = setup();
        let release: (() => void) | undefined;
        const proceeds = s.runtime.withSettlement(
            () => new Promise<void>((resolve) => (release = resolve)),
            async () => () => {},
        );
        await vi.waitFor(() => expect(release).toBeDefined());
        await expect(s.boarding.start("alice")).rejects.toMatchObject({
            code: "settlement_active",
            status: 409,
        });
        release!();
        await proceeds;
        expect(s.settle).not.toHaveBeenCalled();
        expect(s.boarding.status().state).toBe("idle");

        const finish = s.hold();
        await s.boarding.start("alice");
        await vi.waitFor(() => expect(s.settle).toHaveBeenCalledTimes(1));
        await expect(
            s.runtime.withSettlement(
                async () => {},
                async () => () => {},
            ),
        ).rejects.toThrow("proceeds_worker_active");
        await expect(s.boarding.start("bob")).rejects.toMatchObject({
            code: "boarding_active",
            status: 409,
        });
        finish();
        await vi.waitFor(() => expect(s.boarding.status().state).toBe("succeeded"));
    });

    it("leaves the deposit boardable when its settlement fails", async () => {
        const s = setup();
        s.settle.mockRejectedValueOnce(new Error("batch failed"));

        await s.boarding.start("alice");
        await vi.waitFor(() =>
            expect(s.boarding.status()).toMatchObject({ state: "failed", error: "batch failed" }),
        );
        await s.boarding.start("alice");
        await vi.waitFor(() => expect(s.boarding.status().state).toBe("succeeded"));

        expect(s.settle).toHaveBeenCalledTimes(2);
        expect(s.settle.mock.calls[1]).toEqual(s.settle.mock.calls[0]);
    });
});
