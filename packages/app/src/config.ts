import { SingleKey } from "@arkade-os/sdk";
import { hexToBytes } from "@arkade-taxi/protocol";
import { z } from "zod";

export const LOG_LEVELS = ["trace", "debug", "info", "warn", "error", "fatal"] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

export interface TaxiConfig {
    dbPath: string;
    httpPort: number;
    arkdUrl: string;
    indexerUrl: string;
    esploraUrl: string;
    emulatorUrl: string;
    minExpiryHeadroomBlocks: bigint;
    recoveryBroadcastBlocks: bigint;
    recoveryCriticalBlocks: bigint;
    minExpiryHeadroomSeconds: bigint;
    recoveryBroadcastSeconds: bigint;
    recoveryCriticalSeconds: bigint;
    reconcileIntervalMs: number;
    operatorMinReserveSats: bigint;
    /** The operator signs its own funding inputs at lockup. It is never a
     * covenant signer — no leaf carries its key in a multisig. */
    operatorPrivkey: Uint8Array;
    serverPubkey: Uint8Array;
    emulatorPubkey: Uint8Array;
    dust: bigint;
    vtxoMinAmount: bigint;
    logLevel: LogLevel;
    addressHrp: string;
}

/** `operatorKey` is derived asynchronously, so it cannot come out of the
 * synchronous `loadConfig`. */
export interface RuntimeConfig extends TaxiConfig {
    operatorKey: Uint8Array;
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
        TAXI_INDEXER_URL: url,
        TAXI_ESPLORA_URL: url,
        TAXI_EMULATOR_URL: url,
        TAXI_MIN_EXPIRY_HEADROOM_BLOCKS: positiveSats.default("144"),
        TAXI_RECOVERY_BROADCAST_BLOCKS: positiveSats.default("72"),
        TAXI_RECOVERY_CRITICAL_BLOCKS: positiveSats.default("12"),
        TAXI_MIN_EXPIRY_HEADROOM_SECONDS: positiveSats.default("86400"),
        TAXI_RECOVERY_BROADCAST_SECONDS: positiveSats.default("43200"),
        TAXI_RECOVERY_CRITICAL_SECONDS: positiveSats.default("7200"),
        TAXI_RECONCILE_INTERVAL_MS: interval.default("30000"),
        TAXI_OPERATOR_MIN_RESERVE_SATS: positiveSats.default("10000"),
        TAXI_OPERATOR_PRIVKEY: hexKey,
        TAXI_SERVER_PUBKEY: hexKey,
        TAXI_EMULATOR_PUBKEY: hexKey,
        TAXI_DUST: positiveSats,
        TAXI_VTXO_MIN_AMOUNT: positiveSats,
        TAXI_LOG_LEVEL: z.enum(LOG_LEVELS).default("info"),
        TAXI_ADDRESS_HRP: z.string().min(1, "must not be empty").default("ark"),
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
        if (v.TAXI_VTXO_MIN_AMOUNT > v.TAXI_DUST) {
            ctx.addIssue({
                code: z.ZodIssueCode.custom,
                path: ["TAXI_VTXO_MIN_AMOUNT"],
                message: `must not exceed TAXI_DUST (${v.TAXI_DUST})`,
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
        indexerUrl: v.TAXI_INDEXER_URL,
        esploraUrl: v.TAXI_ESPLORA_URL,
        emulatorUrl: v.TAXI_EMULATOR_URL,
        minExpiryHeadroomBlocks: v.TAXI_MIN_EXPIRY_HEADROOM_BLOCKS,
        recoveryBroadcastBlocks: v.TAXI_RECOVERY_BROADCAST_BLOCKS,
        recoveryCriticalBlocks: v.TAXI_RECOVERY_CRITICAL_BLOCKS,
        minExpiryHeadroomSeconds: v.TAXI_MIN_EXPIRY_HEADROOM_SECONDS,
        recoveryBroadcastSeconds: v.TAXI_RECOVERY_BROADCAST_SECONDS,
        recoveryCriticalSeconds: v.TAXI_RECOVERY_CRITICAL_SECONDS,
        reconcileIntervalMs: v.TAXI_RECONCILE_INTERVAL_MS,
        operatorMinReserveSats: v.TAXI_OPERATOR_MIN_RESERVE_SATS,
        operatorPrivkey: v.TAXI_OPERATOR_PRIVKEY,
        serverPubkey: v.TAXI_SERVER_PUBKEY,
        emulatorPubkey: v.TAXI_EMULATOR_PUBKEY,
        dust: v.TAXI_DUST,
        vtxoMinAmount: v.TAXI_VTXO_MIN_AMOUNT,
        logLevel: v.TAXI_LOG_LEVEL,
        addressHrp: v.TAXI_ADDRESS_HRP,
    };
}

export async function resolveRuntimeConfig(cfg: TaxiConfig): Promise<RuntimeConfig> {
    let operatorKey: Uint8Array;
    try {
        operatorKey = await SingleKey.fromPrivateKey(cfg.operatorPrivkey).xOnlyPublicKey();
    } catch {
        throw new ConfigError([
            {
                variable: "TAXI_OPERATOR_PRIVKEY",
                message: "is not a valid secp256k1 private key",
            },
        ]);
    }
    return { ...cfg, operatorKey };
}
