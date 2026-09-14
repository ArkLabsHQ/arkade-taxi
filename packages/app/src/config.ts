import { DefaultVtxo, ESPLORA_URL, SingleKey } from "@arkade-os/sdk";
import { createProviders, verifyProviders } from "./arkade/providers.js";
import { hexToBytes } from "@arkade-taxi/protocol";
import { z } from "zod";

export const LOG_LEVELS = ["trace", "debug", "info", "warn", "error", "fatal"] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

export interface TaxiConfig {
    dbPath: string;
    httpPort: number;
    arkdUrl: string;
    indexerUrl: string;
    emulatorUrl: string;
    minExpiryHeadroomBlocks: bigint;
    recoveryBroadcastBlocks: bigint;
    recoveryCriticalBlocks: bigint;
    minExpiryHeadroomSeconds: bigint;
    recoveryBroadcastSeconds: bigint;
    recoveryCriticalSeconds: bigint;
    reconcileIntervalMs: number;
    operatorMinReserveSats: bigint;
    proceedsMaxFeeSats: bigint;
    /** The operator signs its own funding inputs at lockup. It is never a
     * covenant signer — no leaf carries its key in a multisig. */
    operatorPrivkey: Uint8Array;
    logLevel: LogLevel;
}

/** Public payout destination and private-wallet funding signer are distinct. */
export interface RuntimeConfig extends TaxiConfig {
    operatorKey: Uint8Array;
    operatorSignerKey: Uint8Array;
    networkName: keyof typeof ESPLORA_URL;
    esploraUrl: string;
    serverPubkey: Uint8Array;
    emulatorPubkey: Uint8Array;
    dust: bigint;
    vtxoMinAmount: bigint;
    addressHrp: string;
}

export interface ConfigIssue {
    variable: string;
    message: string;
}

export class ConfigError extends Error {
    readonly code = "invalid_config";

    constructor(readonly issues: ConfigIssue[]) {
        super(
            `taxi config: ${issues.length} invalid environment variable(s)\n` +
                issues.map((i) => `  - ${i.variable}: ${i.message}`).join("\n"),
        );
        this.name = "ConfigError";
    }
}

const HEX_KEY = /^[0-9a-fA-F]{64}$/;
const DECIMAL = /^[0-9]+$/;

const hexKey = z
    .string()
    .regex(HEX_KEY, "must be 64 hex characters (32 bytes)")
    .transform((s) => hexToBytes(s.toLowerCase(), "key"));

const positiveSats = z
    .string()
    .regex(DECIMAL, "must be a non-negative decimal amount")
    .transform((s) => BigInt(s))
    .refine((v) => v > 0n, "must be greater than zero");

const port = z
    .string()
    .regex(DECIMAL, "must be a decimal port number")
    .transform((s) => Number(s))
    .refine((n) => n >= 1 && n <= 65535, "must be between 1 and 65535")
    .default("8080");

const url = z.string().url("must be an absolute URL");
const interval = positiveSats
    .refine((v) => v <= 2_147_483_647n, "must fit a positive timer interval")
    .transform(Number);

const SCHEMA = z
    .object({
        TAXI_DB_PATH: z.string().min(1, "must not be empty").default(":memory:"),
        TAXI_HTTP_PORT: port,
        TAXI_ARKD_URL: url,
        TAXI_EMULATOR_URL: url,
        TAXI_MIN_EXPIRY_HEADROOM_BLOCKS: positiveSats.default("144"),
        TAXI_RECOVERY_BROADCAST_BLOCKS: positiveSats.default("72"),
        TAXI_RECOVERY_CRITICAL_BLOCKS: positiveSats.default("12"),
        TAXI_MIN_EXPIRY_HEADROOM_SECONDS: positiveSats.default("86400"),
        TAXI_RECOVERY_BROADCAST_SECONDS: positiveSats.default("43200"),
        TAXI_RECOVERY_CRITICAL_SECONDS: positiveSats.default("7200"),
        TAXI_RECONCILE_INTERVAL_MS: interval.default("30000"),
        TAXI_OPERATOR_MIN_RESERVE_SATS: positiveSats.default("10000"),
        TAXI_PROCEEDS_MAX_FEE_SATS: z
            .string()
            .regex(DECIMAL, "must be a non-negative integer")
            .transform(BigInt)
            .default("0"),
        TAXI_OPERATOR_PRIVKEY: hexKey,
        TAXI_LOG_LEVEL: z.enum(LOG_LEVELS).default("info"),
    })
    .superRefine((v, ctx) => {
        if (v.TAXI_RECOVERY_CRITICAL_SECONDS >= v.TAXI_RECOVERY_BROADCAST_SECONDS) {
            ctx.addIssue({
                code: z.ZodIssueCode.custom,
                path: ["TAXI_RECOVERY_CRITICAL_SECONDS"],
                message: "must be less than TAXI_RECOVERY_BROADCAST_SECONDS",
            });
        }
        if (v.TAXI_RECOVERY_BROADCAST_SECONDS >= v.TAXI_MIN_EXPIRY_HEADROOM_SECONDS) {
            ctx.addIssue({
                code: z.ZodIssueCode.custom,
                path: ["TAXI_RECOVERY_BROADCAST_SECONDS"],
                message: "must be less than TAXI_MIN_EXPIRY_HEADROOM_SECONDS",
            });
        }
        if (v.TAXI_RECOVERY_CRITICAL_BLOCKS >= v.TAXI_RECOVERY_BROADCAST_BLOCKS) {
            ctx.addIssue({
                code: z.ZodIssueCode.custom,
                path: ["TAXI_RECOVERY_CRITICAL_BLOCKS"],
                message: "must be less than TAXI_RECOVERY_BROADCAST_BLOCKS",
            });
        }
        if (v.TAXI_RECOVERY_BROADCAST_BLOCKS >= v.TAXI_MIN_EXPIRY_HEADROOM_BLOCKS) {
            ctx.addIssue({
                code: z.ZodIssueCode.custom,
                path: ["TAXI_RECOVERY_BROADCAST_BLOCKS"],
                message: "must be less than TAXI_MIN_EXPIRY_HEADROOM_BLOCKS",
            });
        }
    });

const REQUIRED = "must be set";

export function loadConfig(env: NodeJS.ProcessEnv): TaxiConfig {
    const parsed = SCHEMA.safeParse(env);
    if (!parsed.success) {
        const issues = parsed.error.issues.map((i) => ({
            variable: String(i.path[0] ?? "TAXI_*"),
            message: i.code === "invalid_type" && i.received === "undefined" ? REQUIRED : i.message,
        }));
        throw new ConfigError(issues);
    }

    const v = parsed.data;
    return {
        dbPath: v.TAXI_DB_PATH,
        httpPort: v.TAXI_HTTP_PORT,
        arkdUrl: v.TAXI_ARKD_URL,
        indexerUrl: v.TAXI_ARKD_URL,
        emulatorUrl: v.TAXI_EMULATOR_URL,
        minExpiryHeadroomBlocks: v.TAXI_MIN_EXPIRY_HEADROOM_BLOCKS,
        recoveryBroadcastBlocks: v.TAXI_RECOVERY_BROADCAST_BLOCKS,
        recoveryCriticalBlocks: v.TAXI_RECOVERY_CRITICAL_BLOCKS,
        minExpiryHeadroomSeconds: v.TAXI_MIN_EXPIRY_HEADROOM_SECONDS,
        recoveryBroadcastSeconds: v.TAXI_RECOVERY_BROADCAST_SECONDS,
        recoveryCriticalSeconds: v.TAXI_RECOVERY_CRITICAL_SECONDS,
        reconcileIntervalMs: v.TAXI_RECONCILE_INTERVAL_MS,
        operatorMinReserveSats: v.TAXI_OPERATOR_MIN_RESERVE_SATS,
        proceedsMaxFeeSats: v.TAXI_PROCEEDS_MAX_FEE_SATS,
        operatorPrivkey: v.TAXI_OPERATOR_PRIVKEY,
        logLevel: v.TAXI_LOG_LEVEL,
    };
}

export async function resolveRuntimeConfig(
    cfg: TaxiConfig,
    providers: Parameters<typeof verifyProviders>[1] = createProviders(cfg),
): Promise<RuntimeConfig> {
    let operatorSignerKey: Uint8Array;
    try {
        operatorSignerKey = await SingleKey.fromPrivateKey(cfg.operatorPrivkey).xOnlyPublicKey();
    } catch {
        throw new ConfigError([
            {
                variable: "TAXI_OPERATOR_PRIVKEY",
                message: "is not a valid secp256k1 private key",
            },
        ]);
    }
    const verified = await verifyProviders(cfg, providers);
    if (
        verified.blockers.length ||
        !verified.info ||
        !verified.network ||
        !verified.serverPubkey ||
        !verified.emulatorPubkey
    )
        throw new Error(
            `operator payout provider verification failed: ${verified.blockers.join(", ")}`,
        );
    const delay = verified.info.unilateralExitDelay;
    const networkName = verified.info.network as keyof typeof ESPLORA_URL;
    const script = new DefaultVtxo.Script({
        pubKey: operatorSignerKey,
        serverPubKey: verified.serverPubkey,
        csvTimelock: { value: delay, type: delay < 512n ? "blocks" : "seconds" },
    });
    return {
        ...cfg,
        networkName,
        esploraUrl: ESPLORA_URL[networkName],
        serverPubkey: verified.serverPubkey,
        emulatorPubkey: verified.emulatorPubkey,
        dust: verified.info.dust,
        vtxoMinAmount: verified.info.vtxoMinAmount,
        addressHrp: verified.network.hrp,
        operatorKey: script.tweakedPublicKey,
        operatorSignerKey,
    };
}
