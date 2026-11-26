import { describe, expect, it } from "vitest";
import { CSVMultisigTapscript, VtxoScript, type ExtendedCoin, type Wallet } from "@arkade-os/sdk";
import { bytesToHex } from "@arkade-taxi/protocol";
import { createBoarding } from "../src/boarding";
import { operatorKey } from "./fixtures";

const EXIT_DELAY = 604_672;
const exitScript = CSVMultisigTapscript.encode({
    pubkeys: [operatorKey],
    timelock: { type: "seconds", value: BigInt(EXIT_DELAY) },
}).script;
const boardingScript = new VtxoScript([exitScript]);
const deposit = (vout: number, value: number, confirmed: boolean, block_time?: number) =>
    ({
        txid: "dd".repeat(32),
        vout,
        value,
        tapTree: boardingScript.encode(),
        status:
            block_time === undefined
                ? { confirmed }
                : { confirmed, block_time, block_height: vout === 0 ? 1000 : 1 },
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
                exitScript: bytesToHex(exitScript),
            },
            onchainProvider: {
                getChainTip: async () => ({ height: 1010, time: now, hash: "11".repeat(32) }),
                getMedianTimePast: async (height: number) =>
                    height === 0 ? now - EXIT_DELAY - 60 : height === 999 ? now - 60 : now,
            },
        } as unknown as Wallet;
        const boarding = createBoarding({ wallet });

        expect(await boarding.address()).toBe("bcrt1pboarding");
        expect(await boarding.deposits()).toEqual({
            confirmedSats: 60_000n,
            unconfirmedSats: 5_000n,
            expiredSats: 40_000n,
            unknownSats: 0n,
        });
        await expect(createBoarding({ wallet: undefined }).deposits()).rejects.toMatchObject({
            status: 503,
        });
    });

    it.each(["missing-median-time", "undecodable-script"])(
        "keeps a confirmed deposit with %s outside the boardable balance",
        async (reason) => {
            const coin = deposit(0, 1000, true, 100);
            if (reason === "undecodable-script") coin.tapTree = new Uint8Array([0]);
            const wallet = {
                getBoardingUtxos: async () => [coin],
                onchainProvider: {
                    getChainTip: async () => ({ height: 1010, time: 200, hash: "11".repeat(32) }),
                },
            } as unknown as Wallet;
            await expect(createBoarding({ wallet }).deposits()).resolves.toEqual({
                confirmedSats: 0n,
                unconfirmedSats: 0n,
                expiredSats: 0n,
                unknownSats: 1000n,
            });
        },
    );
});
