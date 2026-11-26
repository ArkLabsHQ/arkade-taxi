import { describe, expect, it, vi } from "vitest";
import { Transaction, networks, type Proof } from "@arkade-os/sdk";
import { DustCovenantScript } from "@arkade-taxi/covenant";
import { covenantParamsOf } from "@arkade-taxi/core";
import { bytesToHex } from "@arkade-taxi/protocol";
import { covenantKeeper, renewCovenant, type RenewalProviders } from "../../src/arkade/renewal";
import { advance, config, fundingCoin, NOW } from "../fixtures";

const outpoint = { txid: "cc".repeat(32), vout: 0 };
// A claim-mode tree: the SDK's helper refuses it, since the artifact derives another script.
const covenantAdvance = advance({ outpoint, claimMode: "recycle" });
const covenant = new DustCovenantScript({
    serverKey: config().serverPubkey,
    emulatorKey: config().emulatorPubkey,
    vtxoMinAmount: config().vtxoMinAmount,
    params: covenantParamsOf(covenantAdvance),
});
const script = bytesToHex(covenant.pkScript);
const TREE = 172_800n;
const observed = (createdAgo: bigint, life: bigint) => ({
    swept: false,
    createdAt: BigInt(NOW) - createdAgo,
    expiry: { kind: "time" as const, value: BigInt(NOW) - createdAgo + life },
});
const expiringIn = (seconds: bigint) => observed(2_592_000n, 2_592_000n + seconds);

const keeper = (coin: object, intentFee: Record<string, string> = {}) => {
    const providers = {
        arkProvider: { getInfo: vi.fn(async () => ({ fees: { intentFee } })) },
        emulator: { submitIntent: vi.fn() },
        indexer: { getVtxos: vi.fn(async () => ({ vtxos: [coin] })) },
        network: {},
    };
    const renew = covenantKeeper({
        providers: providers as unknown as RenewalProviders,
        config: config(),
        now: () => NOW,
        signal: new AbortController().signal,
        onRenewed: vi.fn(),
    });
    return { providers, renew };
};

describe("covenant keeper", () => {
    it("waits until the coin's expiry is inside the renewal window", () => {
        const { providers, renew } = keeper(fundingCoin({ ...outpoint, script }));
        const window = config().renewalBeforeExpirySeconds;
        expect(renew(covenantAdvance, expiringIn(window + 1n))).toBeUndefined();
        expect(renew(covenantAdvance, undefined)).toBeUndefined();
        expect(providers.indexer.getVtxos).not.toHaveBeenCalled();
    });

    it.each([
        ["a covenant created now with 1.5 days left", observed(0n, 129_600n)],
        ["a renewal successor a minute into its 2-day tree", observed(60n, TREE)],
        ["a coin of unknown age", { swept: false, expiry: expiringIn(3_600n).expiry }],
        ["a coin of unknown expiry", { swept: false, createdAt: BigInt(NOW) }],
    ])("does not renew %s under the 3-day default window", (_, seen) => {
        const { providers, renew } = keeper(fundingCoin({ ...outpoint, script }));
        expect(config().renewalBeforeExpirySeconds).toBe(259_200n);
        expect(renew(covenantAdvance, seen)).toBeUndefined();
        expect(providers.indexer.getVtxos).not.toHaveBeenCalled();
    });

    it("renews a coin once it is inside half its own life", async () => {
        const { providers, renew } = keeper(fundingCoin({ ...outpoint, script, value: 330 }));
        // Due, so it renews, here up to the prevout lookup this fixture leaves unanswered.
        await expect(renew(covenantAdvance, observed(TREE / 2n, TREE))).rejects.toThrow();
        expect(providers.indexer.getVtxos).toHaveBeenCalledOnce();
    });

    it("leaves a coin a batch already consumed to the watcher", async () => {
        const { providers, renew } = keeper(fundingCoin({ ...outpoint, script, isSpent: true }));
        await expect(renew(covenantAdvance, expiringIn(3_600n))).resolves.toBeUndefined();
        expect(providers.arkProvider.getInfo).not.toHaveBeenCalled();
    });

    it("refuses a claim-mode coin's renewal when the server charges an intent fee", async () => {
        const { providers, renew } = keeper(fundingCoin({ ...outpoint, script, value: 330 }), {
            offchainInput: "1.0",
        });
        await expect(renew(covenantAdvance, expiringIn(3_600n))).rejects.toThrow(/charges 1 sats/);
        expect(providers.emulator.submitIntent).not.toHaveBeenCalled();
    });

    it("registers with the register proof alone, the only message renew() admits", async () => {
        const funding = new Transaction();
        funding.addInput({ txid: "00".repeat(32), index: 0 });
        funding.addOutput({ script: covenant.pkScript, amount: 330n });
        const coin = {
            ...fundingCoin({ txid: funding.id, vout: 0, script, value: 330 }),
            prevTx: funding.toBytes(),
        };
        const stop = new AbortController();
        const submitIntent = vi.fn(async (intent: { proof: string; message: Proof.Message }) => {
            if (intent.message.type !== "register") throw new Error("renew refuses the message");
            return intent.proof;
        });
        const registerIntent = vi.fn(async () => {
            stop.abort();
            return "intent-1";
        });
        const providers = {
            arkProvider: {
                getInfo: async () => ({ fees: { intentFee: {} } }),
                registerIntent,
                getEventStream: () => (async function* () {})(),
            },
            emulator: { submitIntent },
            indexer: {},
            network: networks.regtest,
        };

        await expect(
            renewCovenant(
                providers as unknown as RenewalProviders,
                covenant,
                coin,
                covenant.address("ark", config().serverPubkey).encode(),
                { signal: stop.signal },
            ),
        ).rejects.toThrow(/aborted/);
        expect(submitIntent.mock.calls.map(([intent]) => intent.message.type)).toEqual([
            "register",
        ]);
        expect(registerIntent).toHaveBeenCalledOnce();
    });
});
