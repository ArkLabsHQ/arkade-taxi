import { describe, expect, it } from "vitest";
import {
    ConfigError,
    loadConfig,
    resolveRuntimeConfig,
    SECRET_CONFIG,
    SHOWN_CONFIG,
    shownConfig,
} from "../src/config.js";
import { verifyProviders } from "../src/arkade/providers.js";
import { sanitizeOperationalError } from "../src/errors.js";
import { bytesToHex } from "@arkade-taxi/protocol";
import {
    ArkAddress,
    DefaultVtxo,
    SingleKey,
    defaultEmulatorPubkey,
    ESPLORA_URL,
    networks,
} from "@arkade-os/sdk";
import { operatorPrivkey, serverKey } from "./fixtures.js";
import { arkInfo } from "./arkade/fixtures.js";

const HEX32 = "11".repeat(32);

const env = (over: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv => ({
    TAXI_ARKD_URL: "https://arkd.example",
    TAXI_EMULATOR_URL: "https://emulator.example",
    TAXI_OPERATOR_PRIVKEY: "03".repeat(32),
    ...over,
});

describe("loadConfig", () => {
    it("defaults proceeds fee authorization to zero and accepts only non-negative integers", () => {
        expect(loadConfig(env()).proceedsMaxFeeSats).toBe(0n);
        expect(loadConfig(env({ TAXI_PROCEEDS_MAX_FEE_SATS: "12" })).proceedsMaxFeeSats).toBe(12n);
        for (const value of ["-1", "0.5", "NaN", "1e3", ""])
            expect(() => loadConfig(env({ TAXI_PROCEEDS_MAX_FEE_SATS: value }))).toThrow(
                /TAXI_PROCEEDS_MAX_FEE_SATS/,
            );
    });
    it("renews at the SDK's 3-day default, and only before admission headroom runs out", () => {
        expect(loadConfig(env()).vtxoRenewalThresholdSeconds).toBe(259200n);
        expect(() => loadConfig(env({ TAXI_VTXO_RENEWAL_THRESHOLD_SECONDS: "86400" }))).toThrow(
            /TAXI_VTXO_RENEWAL_THRESHOLD_SECONDS/,
        );
    });
    it("orders time budgets independently", () => {
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
    it("uses the Arkade endpoint for its integrated indexer", () => {
        expect(loadConfig(env()).indexerUrl).toBe("https://arkd.example");
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

    it("takes an optional admin port that must differ from the HTTP port", () => {
        expect(loadConfig(env()).adminPort).toBeUndefined();
        expect(loadConfig(env({ TAXI_ADMIN_PORT: "9090" })).adminPort).toBe(9090);
        expect(() => loadConfig(env({ TAXI_ADMIN_PORT: "8080" }))).toThrow(
            /TAXI_ADMIN_PORT: must differ from TAXI_HTTP_PORT/,
        );
        for (const value of ["0", "65536", "80a"])
            expect(() => loadConfig(env({ TAXI_ADMIN_PORT: value }))).toThrow(/TAXI_ADMIN_PORT/);
    });

    it("takes an optional admin operator name, trimmed", () => {
        expect(loadConfig(env()).adminOperator).toBeUndefined();
        expect(loadConfig(env({ TAXI_ADMIN_OPERATOR: "  ops-team  " })).adminOperator).toBe(
            "ops-team",
        );
    });

    it("refuses an admin operator name the admin API would refuse as an actor", () => {
        for (const value of ["", "   ", "x".repeat(129), "ops\tteam", "ops\u007f"])
            expect(
                () => loadConfig(env({ TAXI_ADMIN_OPERATOR: value })),
                JSON.stringify(value),
            ).toThrow(/TAXI_ADMIN_OPERATOR/);
        expect(loadConfig(env({ TAXI_ADMIN_OPERATOR: "x".repeat(128) })).adminOperator).toBe(
            "x".repeat(128),
        );
    });

    it("decodes the operator private key to 32 bytes", () => {
        const cfg = loadConfig(env());
        expect(cfg.operatorPrivkey).toHaveLength(32);
    });

    it("does not require an emulator key already pinned by the SDK", () => {
        const cfg = loadConfig(env({ TAXI_EMULATOR_PUBKEY: undefined }));
        expect("emulatorPubkey" in cfg).toBe(false);
    });

    it("does not require provider facts derived from arkd and the SDK", () => {
        const cfg = loadConfig(
            env({
                TAXI_INDEXER_URL: undefined,
                TAXI_ESPLORA_URL: undefined,
                TAXI_SERVER_PUBKEY: undefined,
                TAXI_DUST: undefined,
                TAXI_VTXO_MIN_AMOUNT: undefined,
                TAXI_ADDRESS_HRP: undefined,
            }),
        );
        expect(cfg.indexerUrl).toBe(cfg.arkdUrl);
        for (const field of ["esploraUrl", "serverPubkey", "dust", "vtxoMinAmount", "addressHrp"])
            expect(field in cfg).toBe(false);
    });

    it("ignores unrelated environment variables", () => {
        expect(() => loadConfig(env({ PATH: "/usr/bin", HOME: "/root" }))).not.toThrow();
    });
});

describe("aggregated validation", () => {
    it("reports every invalid var, not just the first", () => {
        const bad = env({
            TAXI_ARKD_URL: "not-a-url",
            TAXI_HTTP_PORT: "99999",
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
            "TAXI_HTTP_PORT",
        ]);
    });

    it("names every offending var in the single thrown message", () => {
        expect(() => loadConfig(env({ TAXI_LOG_LEVEL: "chatty" }))).toThrow(/TAXI_LOG_LEVEL/);
    });

    // The refusal is the safety property, not the default: recovery still pins
    // the emulator packet to the refund leaf, so a v2 advance quoted today could
    // never be recovered. Phase 2b deletes this arm.
    it("defaults the covenant version to legacy and refuses to start on 2", () => {
        expect(loadConfig(env()).covenantVersion).toBe(1);
        expect(loadConfig(env({ TAXI_COVENANT_VERSION: "1" })).covenantVersion).toBe(1);
        expect(() => loadConfig(env({ TAXI_COVENANT_VERSION: "2" }))).toThrow(
            /TAXI_COVENANT_VERSION[\s\S]*recover/i,
        );
        for (const value of ["0", "3", "", "two"])
            expect(() => loadConfig(env({ TAXI_COVENANT_VERSION: value }))).toThrow(
                /TAXI_COVENANT_VERSION/,
            );
    });

    // cli.ts prints a startup failure through sanitizeOperationalError, which keeps
    // only the first line: a refusal whose variable is on line two is invisible.
    it("names the offending variables on the line a startup failure prints", () => {
        const refused = (over: NodeJS.ProcessEnv) => {
            try {
                loadConfig(env(over));
                return "";
            } catch (e) {
                return sanitizeOperationalError(e, "startup failed");
            }
        };
        expect(refused({ TAXI_COVENANT_VERSION: "2" })).toContain("TAXI_COVENANT_VERSION");
        expect(refused({ TAXI_ARKD_URL: "not-a-url", TAXI_HTTP_PORT: "99999" })).toContain(
            "TAXI_ARKD_URL, TAXI_HTTP_PORT",
        );
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
            expect.arrayContaining(["TAXI_ARKD_URL", "TAXI_EMULATOR_URL", "TAXI_OPERATOR_PRIVKEY"]),
        );
    });

    it("rejects invalid limits advertised by arkd", async () => {
        const configured = loadConfig(env());
        await expect(
            resolveRuntimeConfig(configured, {
                arkProvider: {
                    getInfo: async () =>
                        arkInfo({ dust: 330n, vtxoMinAmount: 331n, signerPubkey: HEX32 }),
                },
                emulatorProvider: {
                    getInfo: async () => ({
                        signerPubkey: defaultEmulatorPubkey(networks.regtest),
                    }),
                },
            }),
        ).rejects.toThrow(/provider_limits_invalid/);
    });
});

describe("resolveRuntimeConfig", () => {
    const pinned = defaultEmulatorPubkey(networks.regtest);
    const configured = () => loadConfig(env());
    const providers = (info = arkInfo()) => ({
        arkProvider: {
            getInfo: async () => ({ ...info, signerPubkey: bytesToHex(serverKey) }),
        },
        emulatorProvider: { getInfo: async () => ({ signerPubkey: pinned }) },
    });

    it.each([5n, 1024n])(
        "derives the canonical wallet payout separately from its signer at delay %s",
        async (delay) => {
            const signer = await SingleKey.fromPrivateKey(operatorPrivkey).xOnlyPublicKey();
            const tree = new DefaultVtxo.Script({
                pubKey: signer,
                serverPubKey: serverKey,
                csvTimelock: { value: delay, type: delay < 512n ? "blocks" : "seconds" },
            });
            const cfg = await resolveRuntimeConfig(
                configured(),
                providers(arkInfo({ unilateralExitDelay: delay })),
            );
            expect(cfg.operatorKey).toEqual(
                ArkAddress.decode(tree.address("tark", serverKey).encode()).vtxoTaprootKey,
            );
            expect(cfg.operatorKey).not.toEqual(signer);
            expect(cfg.operatorSignerKey).toEqual(signer);
        },
    );

    it.each([5n, 86_016n])("resolves the covenant exit delay from arkd at %s", async (delay) => {
        const cfg = await resolveRuntimeConfig(
            configured(),
            providers(arkInfo({ unilateralExitDelay: delay })),
        );
        expect(cfg.exitDelay).toEqual({ value: delay, type: delay < 512n ? "blocks" : "seconds" });
        expect(shownConfig(cfg).find((entry) => entry.key === "exitDelay")?.value).toBe(
            `${delay} ${delay < 512n ? "blocks" : "seconds"}`,
        );
    });

    it("refuses to start when arkd advertises an exit delay the Taxi cannot use", async () => {
        await expect(
            resolveRuntimeConfig(configured(), providers(arkInfo({ unilateralExitDelay: 0n }))),
        ).rejects.toThrow(/provider_exit_delay_invalid/);
    });

    it("pins the resolved server identity for later provider refreshes", async () => {
        const cfg = await resolveRuntimeConfig(configured(), providers());
        const result = await verifyProviders(cfg, {
            arkProvider: {
                getInfo: async () => arkInfo({ signerPubkey: "11".repeat(32) }),
            },
            emulatorProvider: { getInfo: async () => ({ signerPubkey: pinned }) },
        });
        expect(result.blockers).toContain("server_identity_mismatch");
    });

    it("derives the emulator key from the Arkade network pinned by the SDK", async () => {
        const cfg = await resolveRuntimeConfig(configured(), {
            arkProvider: { getInfo: async () => arkInfo() },
            emulatorProvider: { getInfo: async () => ({ signerPubkey: pinned }) },
        });
        expect(cfg.networkName).toBe("regtest");
        expect(cfg.indexerUrl).toBe(cfg.arkdUrl);
        expect(cfg.esploraUrl).toBe(ESPLORA_URL.regtest);
        const configuredEsplora = await resolveRuntimeConfig(
            loadConfig(env({ TAXI_ESPLORA_URL: "http://mempool_web:8080/api" })),
            {
                arkProvider: { getInfo: async () => arkInfo() },
                emulatorProvider: { getInfo: async () => ({ signerPubkey: pinned }) },
            },
        );
        expect(configuredEsplora.esploraUrl).toBe("http://mempool_web:8080/api");
        expect(() => loadConfig(env({ TAXI_ESPLORA_URL: "relative/path" }))).toThrow(
            /TAXI_ESPLORA_URL/,
        );
        expect(cfg.serverPubkey).toEqual(serverKey);
        expect(cfg.dust).toBe(330n);
        expect(cfg.vtxoMinAmount).toBe(10n);
        expect(cfg.addressHrp).toBe(networks.regtest.hrp);
        expect(bytesToHex(cfg.emulatorPubkey)).toBe(pinned.slice(2));
    });

    it("classifies every config key as shown in the console or secret", async () => {
        const classified = new Set<string>([...Object.keys(SHOWN_CONFIG), ...SECRET_CONFIG]);
        const runtime = await resolveRuntimeConfig(configured(), providers());
        for (const cfg of [configured(), runtime])
            expect(Object.keys(cfg).filter((key) => !classified.has(key))).toEqual([]);
        expect(SECRET_CONFIG.filter((key) => key in SHOWN_CONFIG)).toEqual([]);
    });

    it("shows neither a secret nor the credentials and query a URL carries", async () => {
        const runtime = await resolveRuntimeConfig(
            loadConfig(env({ TAXI_ARKD_URL: "https://user:pass@arkd.example/v1?token=abc#x" })),
            providers(),
        );
        const shown = shownConfig(runtime);
        expect(JSON.stringify(shown)).not.toContain(bytesToHex(runtime.operatorPrivkey));
        expect(JSON.stringify(shown)).not.toMatch(/user|pass|token|#x/);
        expect(shown.find((entry) => entry.key === "arkdUrl")).toEqual({
            key: "arkdUrl",
            env: "TAXI_ARKD_URL",
            value: "https://arkd.example/v1",
        });
        expect(shown.find((entry) => entry.key === "adminPort")?.value).toBeNull();
        const unparseable = shownConfig({ ...runtime, arkdUrl: "http://user:pass@" });
        expect(unparseable.find((entry) => entry.key === "arkdUrl")?.value).toBeNull();
    });
});
