import { describe, expect, it } from "vitest";
import { ConfigError, loadConfig, resolveRuntimeConfig } from "../src/config.js";
import { bytesToHex } from "@arkade-taxi/protocol";
import { operatorKey } from "./fixtures.js";

const HEX32 = "11".repeat(32);

const env = (over: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv => ({
    TAXI_ARKD_URL: "https://arkd.example",
    TAXI_INDEXER_URL: "https://indexer.example",
    TAXI_ESPLORA_URL: "https://esplora.example/api",
    TAXI_EMULATOR_URL: "https://emulator.example",
    TAXI_OPERATOR_PRIVKEY: "03".repeat(32),
    TAXI_SERVER_PUBKEY: HEX32,
    TAXI_EMULATOR_PUBKEY: "22".repeat(32),
    TAXI_DUST: "330",
    TAXI_VTXO_MIN_AMOUNT: "10",
    ...over,
});

describe("loadConfig", () => {
    it("requires an explicit chain endpoint and orders time budgets independently", () => {
        expect(() => loadConfig(env({ TAXI_ESPLORA_URL: undefined }))).toThrow(/TAXI_ESPLORA_URL/);
        expect(() =>
            loadConfig(
                env({
                    TAXI_RECOVERY_CRITICAL_SECONDS: "60",
                    TAXI_RECOVERY_BROADCAST_SECONDS: "60",
                }),
            ),
        ).toThrow(/TAXI_RECOVERY_CRITICAL_SECONDS/);
        expect(() =>
            loadConfig(
                env({
                    TAXI_RECOVERY_BROADCAST_SECONDS: "120",
                    TAXI_MIN_EXPIRY_HEADROOM_SECONDS: "120",
                }),
            ),
        ).toThrow(/TAXI_RECOVERY_BROADCAST_SECONDS/);
    });
    it("requires an explicit indexer endpoint rather than guessing its deployment", () => {
        expect(() => loadConfig(env({ TAXI_INDEXER_URL: undefined }))).toThrow(/TAXI_INDEXER_URL/);
        expect(loadConfig(env()).indexerUrl).toBe("https://indexer.example");
    });

    it("validates ordered recovery thresholds and exact reserve amounts", () => {
        const cfg = loadConfig(env({ TAXI_OPERATOR_MIN_RESERVE_SATS: "9007199254740993" }));
        expect(cfg.operatorMinReserveSats).toBe(9007199254740993n);
        expect(cfg.recoveryCriticalBlocks < cfg.recoveryBroadcastBlocks).toBe(true);
        expect(cfg.recoveryBroadcastBlocks < cfg.minExpiryHeadroomBlocks).toBe(true);
        expect(() =>
            loadConfig(
                env({ TAXI_RECOVERY_CRITICAL_BLOCKS: "12", TAXI_RECOVERY_BROADCAST_BLOCKS: "12" }),
            ),
        ).toThrow(/TAXI_RECOVERY_CRITICAL_BLOCKS/);
        expect(() =>
            loadConfig(
                env({
                    TAXI_RECOVERY_BROADCAST_BLOCKS: "144",
                    TAXI_MIN_EXPIRY_HEADROOM_BLOCKS: "144",
                }),
            ),
        ).toThrow(/TAXI_RECOVERY_BROADCAST_BLOCKS/);
        for (const value of ["0", "-1", "1.5", "9007199254740993"]) {
            expect(() => loadConfig(env({ TAXI_RECONCILE_INTERVAL_MS: value }))).toThrow(
                /TAXI_RECONCILE_INTERVAL_MS/,
            );
        }
    });
    it("applies defaults for the optional vars", () => {
        const cfg = loadConfig(env());
        expect(cfg.dbPath).toBe(":memory:");
        expect(cfg.httpPort).toBe(8080);
        expect(cfg.logLevel).toBe("info");
    });

    it("decodes amounts as bigint, never number", () => {
        const cfg = loadConfig(env({ TAXI_DUST: "9007199254740993" }));
        expect(cfg.dust).toBe(9_007_199_254_740_993n);
        expect(cfg.vtxoMinAmount).toBe(10n);
    });

    it("decodes hex keys to 32 bytes", () => {
        const cfg = loadConfig(env());
        expect(cfg.serverPubkey).toEqual(new Uint8Array(32).fill(0x11));
        expect(cfg.emulatorPubkey).toHaveLength(32);
        expect(cfg.operatorPrivkey).toHaveLength(32);
    });

    it("ignores unrelated environment variables", () => {
        expect(() => loadConfig(env({ PATH: "/usr/bin", HOME: "/root" }))).not.toThrow();
    });

    it("accepts uppercase hex", () => {
        const cfg = loadConfig(env({ TAXI_SERVER_PUBKEY: "AB".repeat(32) }));
        expect(bytesToHex(cfg.serverPubkey)).toBe("ab".repeat(32));
    });
});

describe("aggregated validation", () => {
    it("reports every invalid var, not just the first", () => {
        const bad = env({
            TAXI_ARKD_URL: "not-a-url",
            TAXI_DUST: "three-hundred",
            TAXI_HTTP_PORT: "99999",
            TAXI_SERVER_PUBKEY: "abcd",
        });

        const err = (() => {
            try {
                loadConfig(bad);
                return null;
            } catch (e) {
                return e as ConfigError;
            }
        })();

        expect(err).toBeInstanceOf(ConfigError);
        expect(err!.issues.map((i) => i.variable).sort()).toEqual([
            "TAXI_ARKD_URL",
            "TAXI_DUST",
            "TAXI_HTTP_PORT",
            "TAXI_SERVER_PUBKEY",
        ]);
    });

    it("names every offending var in the single thrown message", () => {
        const bad = env({ TAXI_DUST: "x", TAXI_VTXO_MIN_AMOUNT: "y", TAXI_LOG_LEVEL: "chatty" });
        expect(() => loadConfig(bad)).toThrow(/TAXI_DUST[\s\S]*TAXI_LOG_LEVEL/);
        expect(() => loadConfig(bad)).toThrow(/TAXI_VTXO_MIN_AMOUNT/);
    });

    it("reports missing required vars together", () => {
        const err = (() => {
            try {
                loadConfig({});
                return null;
            } catch (e) {
                return e as ConfigError;
            }
        })();
        expect(err!.issues.map((i) => i.variable)).toEqual(
            expect.arrayContaining([
                "TAXI_ARKD_URL",
                "TAXI_EMULATOR_URL",
                "TAXI_OPERATOR_PRIVKEY",
                "TAXI_SERVER_PUBKEY",
                "TAXI_EMULATOR_PUBKEY",
                "TAXI_DUST",
                "TAXI_VTXO_MIN_AMOUNT",
            ]),
        );
    });

    it("rejects a zero or negative amount", () => {
        expect(() => loadConfig(env({ TAXI_DUST: "0" }))).toThrow(/TAXI_DUST/);
        expect(() => loadConfig(env({ TAXI_VTXO_MIN_AMOUNT: "-1" }))).toThrow(
            /TAXI_VTXO_MIN_AMOUNT/,
        );
    });

    // A covenant whose window is empty admits nothing, and the failure would
    // otherwise surface per quote rather than at boot.
    it("rejects vtxoMinAmount above dust", () => {
        expect(() => loadConfig(env({ TAXI_VTXO_MIN_AMOUNT: "331" }))).toThrow(
            /TAXI_VTXO_MIN_AMOUNT/,
        );
    });

    it("rejects a key that is not 32 bytes", () => {
        expect(() => loadConfig(env({ TAXI_EMULATOR_PUBKEY: "22".repeat(31) }))).toThrow(
            /TAXI_EMULATOR_PUBKEY/,
        );
    });
});

describe("resolveRuntimeConfig", () => {
    it("derives the operator x-only pubkey from the privkey", async () => {
        const cfg = await resolveRuntimeConfig(loadConfig(env()));
        expect(cfg.operatorKey).toEqual(operatorKey);
        expect(cfg.dust).toBe(330n);
    });
});
