import { describe, expect, it, vi } from "vitest";
import { schnorr } from "@noble/curves/secp256k1.js";
import { DustCovenantScript } from "../src/vtxo.js";

vi.mock("@arkade-os/sdk", async (importOriginal) => {
    const sdk = await importOriginal<typeof import("@arkade-os/sdk")>();
    const programFromArtifact = () => {
        throw new Error("v2 artifact unreadable");
    };
    return { ...sdk, arkade: { ...sdk.arkade, programFromArtifact } };
});

const key = (fill: number) => schnorr.getPublicKey(new Uint8Array(32).fill(fill));

const opts = (v2: boolean) => ({
    serverKey: key(4),
    emulatorKey: key(5),
    vtxoMinAmount: 330n,
    params: {
        receiverKey: key(1),
        senderKey: key(2),
        operatorKey: key(3),
        operatorSignerKey: key(6),
        exitDelay: { value: 86_016n, type: "seconds" as const },
        dust: 330n,
        topup: 330n,
        // v2 demands a time-domain locktime; v1 accepts one too, so both shapes
        // reach the artifact load this test is about.
        locktime: 1_800_000_000n,
        ...(v2 && { covenantVersion: 2 as const }),
    },
});

// v1 is live and v2 is not, so an artifact the SDK rejects must not take v1 down.
describe("a v2 artifact the SDK cannot read", () => {
    it("still builds v1 and fails only v2", () => {
        expect(() => new DustCovenantScript(opts(false))).not.toThrow();
        expect(() => new DustCovenantScript(opts(true))).toThrow("v2 artifact unreadable");
    });
});
