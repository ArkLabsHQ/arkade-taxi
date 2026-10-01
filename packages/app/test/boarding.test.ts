import { describe, expect, it } from "vitest";
import { CSVMultisigTapscript, type ExtendedCoin, type Wallet } from "@arkade-os/sdk";
import { bytesToHex } from "@arkade-taxi/protocol";
import { createBoarding } from "../src/boarding.js";
import { operatorKey } from "./fixtures.js";

const EXIT_DELAY = 604_672;
const deposit = (vout: number, value: number, confirmed: boolean, block_time?: number) =>
    ({
        txid: "dd".repeat(32),
        vout,
        value,
        status: block_time === undefined ? { confirmed } : { confirmed, block_time },
    }) as ExtendedCoin;

describe("on-chain deposits", () => {
    it("counts a deposit past its boarding exit delay as expired, never as confirmed", async () => {
        const now = Math.floor(Date.now() / 1000);
        const wallet = {
            getBoardingAddress: async () => "bcrt1pboarding",
            getBoardingUtxos: async () => [
                deposit(0, 60_000, true, now - 60),
                deposit(1, 40_000, true, now - EXIT_DELAY - 60),
                deposit(2, 5_000, false),
            ],
            boardingTapscript: {
                exitScript: bytesToHex(
                    CSVMultisigTapscript.encode({
                        pubkeys: [operatorKey],
                        timelock: { type: "seconds", value: BigInt(EXIT_DELAY) },
                    }).script,
                ),
            },
        } as unknown as Wallet;
        const boarding = createBoarding({ wallet });

        expect(await boarding.address()).toBe("bcrt1pboarding");
        expect(await boarding.deposits()).toEqual({
            confirmedSats: 60_000n,
            unconfirmedSats: 5_000n,
            expiredSats: 40_000n,
        });
        await expect(createBoarding({ wallet: undefined }).deposits()).rejects.toMatchObject({
            status: 503,
        });
    });
});
