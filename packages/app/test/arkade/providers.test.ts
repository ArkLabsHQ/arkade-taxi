import { describe, expect, it } from "vitest";
import { bytesToHex } from "@arkade-taxi/protocol";
import { config, emulatorKey } from "../fixtures.js";
import { verifyProviders, withinVtxoMaxAmount } from "../../src/arkade/providers.js";
import { arkInfo } from "./fixtures.js";
import { defaultEmulatorPubkey, networks } from "@arkade-os/sdk";

const pinnedEmulatorKey = defaultEmulatorPubkey(networks.regtest);

const providers = (info = arkInfo()) => ({
    arkProvider: { getInfo: async () => info },
    emulatorProvider: { getInfo: async () => ({ signerPubkey: pinnedEmulatorKey }) },
});

describe("withinVtxoMaxAmount", () => {
    it("treats -1 as no ceiling and holds a finite ceiling inclusively", () => {
        for (const amount of [0n, 330n, 2n ** 62n])
            expect(withinVtxoMaxAmount(amount, -1n)).toBe(true);
        expect(withinVtxoMaxAmount(1000n, 1000n)).toBe(true);
        expect(withinVtxoMaxAmount(1001n, 1000n)).toBe(false);
        expect(withinVtxoMaxAmount(1n, 0n)).toBe(false);
    });
});

describe("provider verification", () => {
    it("normalizes compressed identities and decodes a public server unroll script", async () => {
        const result = await verifyProviders(config({ addressHrp: "tark" }), providers());
        expect(result.blockers).toEqual([]);
        expect(result.providerIdentityOk).toBe(true);
        expect(result.serverUnrollScript?.params.timelock).toEqual({ type: "blocks", value: 5n });
    });

    it.each([
        [{ signerPubkey: "11".repeat(32) }, "server_identity_mismatch"],
        [{ network: "bitcoin" }, "network_mismatch"],
        [{ network: "testnet" }, "emulator_key_unavailable"],
        [{ network: "unknown" }, "network_unknown"],
        [{ checkpointTapscript: "" }, "server_unroll_invalid"],
        [{ forfeitPubkey: "02" + bytesToHex(emulatorKey) }, "server_unroll_invalid"],
    ] as const)("fails closed for incompatible info %j", async (over, blocker) => {
        const result = await verifyProviders(
            config({ addressHrp: "tark" }),
            providers(arkInfo(over)),
        );
        expect(result.blockers).toContain(blocker);
    });

    it("does not expose provider errors or accept an unknown emulator", async () => {
        const deps = providers();
        deps.emulatorProvider.getInfo = async () => {
            throw new Error("secret payload");
        };
        const result = await verifyProviders(config({ addressHrp: "tark" }), deps);
        expect(result.providerIdentityOk).toBe(false);
        expect(result.blockers).toEqual(["emulator_unavailable"]);
        expect(JSON.stringify(result.blockers)).not.toContain("secret payload");
    });

    it("rejects an emulator identity that differs from the SDK network pin", async () => {
        const deps = providers();
        deps.emulatorProvider.getInfo = async () => ({ signerPubkey: "11".repeat(32) });
        const result = await verifyProviders(config({ addressHrp: "tark" }), deps);
        expect(result.providerIdentityOk).toBe(false);
        expect(result.blockers).toContain("emulator_identity_mismatch");
    });

    it("uses the MutinyNet emulator key pinned by the SDK", async () => {
        const pinned = defaultEmulatorPubkey(networks.mutinynet);
        const deps = providers(arkInfo({ network: "mutinynet" }));
        deps.emulatorProvider.getInfo = async () => ({ signerPubkey: pinned });
        const result = await verifyProviders(config({ addressHrp: "tark" }), deps);
        expect(bytesToHex(result.emulatorPubkey!)).toBe(pinned.slice(2));
        expect(result.blockers).not.toContain("emulator_identity_mismatch");
    });
});
