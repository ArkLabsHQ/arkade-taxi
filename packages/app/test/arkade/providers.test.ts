import { describe, expect, it } from "vitest";
import { bytesToHex } from "@arkade-taxi/protocol";
import { config, emulatorKey } from "../fixtures.js";
import { verifyProviders } from "../../src/arkade/providers.js";
import { arkInfo } from "./fixtures.js";

const providers = (info = arkInfo()) => ({
    arkProvider: { getInfo: async () => info },
    emulatorProvider: { getInfo: async () => ({ signerPubkey: bytesToHex(emulatorKey) }) },
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
});
