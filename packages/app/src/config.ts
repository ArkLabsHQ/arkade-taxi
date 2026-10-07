import { DefaultVtxo, ESPLORA_URL, SingleKey } from "@arkade-os/sdk";
import { createProviders, verifyProviders } from "./arkade/providers.js";
import { exitTimelock, type RelativeTimelock } from "@arkade-taxi/covenant";
import { bytesToHex, hexToBytes } from "@arkade-taxi/protocol";
import { z } from "zod";

export const LOG_LEVELS = ["trace", "debug", "info", "warn", "error", "fatal"] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

export interface TaxiConfig {
    dbPath: string;
    httpPort: number;
    adminPort?: number;
    adminOperator?: string;
    arkdUrl: string;
    indexerUrl: string;
    emulatorUrl: string;
    esploraUrl?: string;
    publicArkdUrl?: string;
    publicEmulatorUrl?: string;
    minExpiryHeadroomBlocks: bigint;
    recoveryBroadcastBlocks: bigint;
    recoveryCriticalBlocks: bigint;
    minExpiryHeadroomSeconds: bigint;
    recoveryBroadcastSeconds: bigint;
    recoveryCriticalSeconds: bigint;
    vtxoRenewalThresholdSeconds: bigint;
    reconcileIntervalMs: number;
    operatorMinReserveSats: bigint;
    proceedsMaxFeeSats: bigint;
    /** Signs the operator's own funding inputs at lockup and co-signs every
     * covenant's emergency exit (leaf 4). Keep it until every advance quoted
     * under it is terminal, or those exits become unspendable. */
    operatorPrivkey: Uint8Array;
    /** Covenant version new quotes are built at. Only 1 starts; see SCHEMA. */
    covenantVersion: 1 | 2;
    /** The guarantee advertised beside `unclaimedMode: "custody"`, not an expiry:
     * past it a release is still honoured while the funds remain (spec §5.6). */
    custodyWindowSeconds: bigint;
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
    exitDelay: RelativeTimelock;
}

/** What the admin console may show of the running config, by the variable that
 * sets it; null is derived at startup. An allowlist: a key in neither this nor
 * SECRET_CONFIG fails config.test.ts. */
export const SHOWN_CONFIG = {
    httpPort: "TAXI_HTTP_PORT",
    adminPort: "TAXI_ADMIN_PORT",
    adminOperator: "TAXI_ADMIN_OPERATOR",
    dbPath: "TAXI_DB_PATH",
    arkdUrl: "TAXI_ARKD_URL",
    indexerUrl: "TAXI_ARKD_URL",
    emulatorUrl: "TAXI_EMULATOR_URL",
    publicArkdUrl: "TAXI_PUBLIC_ARKD_URL",
    publicEmulatorUrl: "TAXI_PUBLIC_EMULATOR_URL",
    operatorMinReserveSats: "TAXI_OPERATOR_MIN_RESERVE_SATS",
    minExpiryHeadroomBlocks: "TAXI_MIN_EXPIRY_HEADROOM_BLOCKS",
    recoveryBroadcastBlocks: "TAXI_RECOVERY_BROADCAST_BLOCKS",
    recoveryCriticalBlocks: "TAXI_RECOVERY_CRITICAL_BLOCKS",
    minExpiryHeadroomSeconds: "TAXI_MIN_EXPIRY_HEADROOM_SECONDS",
    recoveryBroadcastSeconds: "TAXI_RECOVERY_BROADCAST_SECONDS",
    recoveryCriticalSeconds: "TAXI_RECOVERY_CRITICAL_SECONDS",
    vtxoRenewalThresholdSeconds: "TAXI_VTXO_RENEWAL_THRESHOLD_SECONDS",
    reconcileIntervalMs: "TAXI_RECONCILE_INTERVAL_MS",
    proceedsMaxFeeSats: "TAXI_PROCEEDS_MAX_FEE_SATS",
    covenantVersion: "TAXI_COVENANT_VERSION",
    custodyWindowSeconds: "TAXI_CUSTODY_WINDOW_SECONDS",
    logLevel: "TAXI_LOG_LEVEL",
    operatorKey: null,
    operatorSignerKey: null,
    networkName: null,
    esploraUrl: "TAXI_ESPLORA_URL",
    serverPubkey: null,
    emulatorPubkey: null,
    dust: null,
    vtxoMinAmount: null,
    addressHrp: null,
    exitDelay: null,
} as const satisfies Partial<Record<keyof RuntimeConfig, string | null>>;

export const SECRET_CONFIG: readonly string[] = [
    "operatorPrivkey",
] satisfies (keyof RuntimeConfig)[];

export interface ShownConfigEntry {
    key: keyof typeof SHOWN_CONFIG;
    env: string | null;
    value: string | null;
}

const isRelativeTimelock = (value: unknown): value is RelativeTimelock =>
    typeof value === "object" &&
    value !== null &&
    typeof (value as RelativeTimelock).value === "bigint" &&
    ((value as RelativeTimelock).type === "blocks" ||
        (value as RelativeTimelock).type === "seconds");

const shownValue = (value: unknown): string | null => {
    if (value === undefined || value === null) return null;
    if (value instanceof Uint8Array) return bytesToHex(value);
    if (isRelativeTimelock(value)) return `${value.value} ${value.type}`;
    const text = String(value);
    if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(text)) return text;
    // A URL can carry credentials in its userinfo or query; neither is shown, and
    // an unparseable one is withheld rather than echoed with them.
    try {
        const url = new URL(text);
        return `${url.protocol}//${url.host}${url.pathname}`;
    } catch {
        return null;
    }
};

export const shownConfig = (cfg: RuntimeConfig): ShownConfigEntry[] =>
    (Object.keys(SHOWN_CONFIG) as (keyof typeof SHOWN_CONFIG)[]).map((key) => ({
        key,
        env: SHOWN_CONFIG[key],
        value: shownValue(cfg[key]),
    }));

export interface ConfigIssue {
    variable: string;
    message: string;
}

export class ConfigError extends Error {
    readonly code = "invalid_config";

    constructor(readonly issues: ConfigIssue[]) {
        // Variables on the first line: a startup failure is printed through
        // sanitizeOperationalError, which keeps that line and drops the rest.
        super(
            `taxi config: ${issues.length} invalid environment variable(s): ` +
                `${[...new Set(issues.map((i) => i.variable))].sort().join(", ")}\n` +
                issues.map((i) => `  - ${i.variable}: ${i.message}`).join("\n"),
        );
        this.name = "ConfigError";
    }
}

const HEX_KEY = /^[0-9a-fA-F]{64}$/;
const DECIMAL = /^[0-9]+$/;

/** What the admin API accepts as an actor, from the operator header, the basic-auth
 * user or TAXI_ADMIN_OPERATOR alike. */
export const MAX_ACTOR_LENGTH = 128;
export const ACTOR_CONTROL_CHARS = /[\u0000-\u001f\u007f]/;

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
    .refine((n) => n >= 1 && n <= 65535, "must be between 1 and 65535");

const url = z.string().url("must be an absolute URL");
const interval = positiveSats
    .refine((v) => v <= 2_147_483_647n, "must fit a positive timer interval")
    .transform(Number);

const SCHEMA = z
    .object({
        TAXI_DB_PATH: z.string().min(1, "must not be empty").default(":memory:"),
        TAXI_HTTP_PORT: port.default("8080"),
        TAXI_ADMIN_PORT: port.optional(),
        TAXI_ADMIN_OPERATOR: z
            .string()
            .trim()
            .min(1, "must not be empty")
            .max(MAX_ACTOR_LENGTH, `must be at most ${MAX_ACTOR_LENGTH} characters`)
            .refine((s) => !ACTOR_CONTROL_CHARS.test(s), "must not contain control characters")
            .optional(),
        TAXI_ARKD_URL: url,
        TAXI_EMULATOR_URL: url,
        TAXI_ESPLORA_URL: url.optional(),
        TAXI_PUBLIC_ARKD_URL: url.optional(),
        TAXI_PUBLIC_EMULATOR_URL: url.optional(),
        TAXI_MIN_EXPIRY_HEADROOM_BLOCKS: positiveSats.default("144"),
        TAXI_RECOVERY_BROADCAST_BLOCKS: positiveSats.default("72"),
        TAXI_RECOVERY_CRITICAL_BLOCKS: positiveSats.default("12"),
        TAXI_MIN_EXPIRY_HEADROOM_SECONDS: positiveSats.default("86400"),
        TAXI_RECOVERY_BROADCAST_SECONDS: positiveSats.default("43200"),
        TAXI_RECOVERY_CRITICAL_SECONDS: positiveSats.default("7200"),
        // The SDK's own default (VtxoManager DEFAULT_THRESHOLD_SECONDS, 3 days).
        TAXI_VTXO_RENEWAL_THRESHOLD_SECONDS: positiveSats.default("259200"),
        TAXI_RECONCILE_INTERVAL_MS: interval.default("30000"),
        TAXI_OPERATOR_MIN_RESERVE_SATS: positiveSats.default("10000"),
        TAXI_PROCEEDS_MAX_FEE_SATS: z
            .string()
            .regex(DECIMAL, "must be a non-negative integer")
            .transform(BigInt)
            .default("0"),
        TAXI_OPERATOR_PRIVKEY: hexKey,
        TAXI_COVENANT_VERSION: z
            .enum(["1", "2"])
            .default("1")
            .transform((s) => Number(s) as 1 | 2),
        // 100 days (decision 7). Baked into every custody row at reclaim, so a
        // later change never moves a window a payer was already quoted.
        TAXI_CUSTODY_WINDOW_SECONDS: positiveSats.default("8640000"),
        TAXI_LOG_LEVEL: z.enum(LOG_LEVELS).default("info"),
    })
    .superRefine((v, ctx) => {
        // Recovery and the watcher now handle v2, but a reclaim moves the whole
        // covenant to the operator and there is no custody ledger to hand it back
        // from. Lift this with that, not before — the flip is one-way for as long
        // as a v2 advance is live.
        if (v.TAXI_COVENANT_VERSION === 2) {
            ctx.addIssue({
                code: z.ZodIssueCode.custom,
                path: ["TAXI_COVENANT_VERSION"],
                message:
                    "must be 1: v2 quote terms and the custody ledger are not built, so a reclaimed v2 delivery could never be recovered by its receiver",
            });
        }
        if (v.TAXI_ADMIN_PORT === v.TAXI_HTTP_PORT) {
            ctx.addIssue({
                code: z.ZodIssueCode.custom,
                path: ["TAXI_ADMIN_PORT"],
                message: "must differ from TAXI_HTTP_PORT",
            });
        }
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
        if (v.TAXI_VTXO_RENEWAL_THRESHOLD_SECONDS <= v.TAXI_MIN_EXPIRY_HEADROOM_SECONDS) {
            ctx.addIssue({
                code: z.ZodIssueCode.custom,
                path: ["TAXI_VTXO_RENEWAL_THRESHOLD_SECONDS"],
                message: "must exceed TAXI_MIN_EXPIRY_HEADROOM_SECONDS",
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
        adminPort: v.TAXI_ADMIN_PORT,
        adminOperator: v.TAXI_ADMIN_OPERATOR,
        arkdUrl: v.TAXI_ARKD_URL,
        indexerUrl: v.TAXI_ARKD_URL,
        emulatorUrl: v.TAXI_EMULATOR_URL,
        ...(v.TAXI_ESPLORA_URL ? { esploraUrl: v.TAXI_ESPLORA_URL } : {}),
        ...(v.TAXI_PUBLIC_ARKD_URL ? { publicArkdUrl: v.TAXI_PUBLIC_ARKD_URL } : {}),
        ...(v.TAXI_PUBLIC_EMULATOR_URL ? { publicEmulatorUrl: v.TAXI_PUBLIC_EMULATOR_URL } : {}),
        minExpiryHeadroomBlocks: v.TAXI_MIN_EXPIRY_HEADROOM_BLOCKS,
        recoveryBroadcastBlocks: v.TAXI_RECOVERY_BROADCAST_BLOCKS,
        recoveryCriticalBlocks: v.TAXI_RECOVERY_CRITICAL_BLOCKS,
        minExpiryHeadroomSeconds: v.TAXI_MIN_EXPIRY_HEADROOM_SECONDS,
        recoveryBroadcastSeconds: v.TAXI_RECOVERY_BROADCAST_SECONDS,
        recoveryCriticalSeconds: v.TAXI_RECOVERY_CRITICAL_SECONDS,
        vtxoRenewalThresholdSeconds: v.TAXI_VTXO_RENEWAL_THRESHOLD_SECONDS,
        reconcileIntervalMs: v.TAXI_RECONCILE_INTERVAL_MS,
        operatorMinReserveSats: v.TAXI_OPERATOR_MIN_RESERVE_SATS,
        proceedsMaxFeeSats: v.TAXI_PROCEEDS_MAX_FEE_SATS,
        operatorPrivkey: v.TAXI_OPERATOR_PRIVKEY,
        covenantVersion: v.TAXI_COVENANT_VERSION,
        custodyWindowSeconds: v.TAXI_CUSTODY_WINDOW_SECONDS,
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
        csvTimelock: exitTimelock(delay),
    });
    return {
        ...cfg,
        networkName,
        esploraUrl: cfg.esploraUrl ?? ESPLORA_URL[networkName],
        serverPubkey: verified.serverPubkey,
        emulatorPubkey: verified.emulatorPubkey,
        dust: verified.info.dust,
        vtxoMinAmount: verified.info.vtxoMinAmount,
        addressHrp: verified.network.hrp,
        operatorKey: script.tweakedPublicKey,
        operatorSignerKey,
        exitDelay: exitTimelock(delay),
    };
}
