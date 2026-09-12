/**
 * The operator's JSON API. Every bigint leaves as a decimal string and every
 * byte field as lowercase hex, matching `@arkade-taxi/protocol`: JSON has no
 * bigint, and a sats value losing precision above 2^53 only shows up on a large
 * payment.
 */

import { createHash } from "node:crypto";
import type { Context, Hono } from "hono";
import { z } from "zod";
import {
    validateFareOption,
    type Advance,
    type AdvanceState,
    type Policy,
} from "@arkade-taxi/core";
import { ADVANCE_STATES, type AdvanceRepository, type PolicyRepository } from "@arkade-taxi/db";
import { assetIdFromWire, bytesToHex, fareToWire, satsToWire } from "@arkade-taxi/protocol";
import { assetRuleToWire } from "../rulesWire.js";
import { sanitizeOperationalError } from "../errors.js";
import type { OperationalSnapshot } from "../routes.js";
import type { RecoveryDeadline } from "../sweeper.js";

/** What the admin surface needs to know about the sweeper. Only the first three
 * fields are required, so a sweeper that tracks less can still report. */
export interface SweeperStatus {
    running: boolean;
    /** Epoch ms of the last completed tick; null before the first one. */
    lastTickAt: number | null;
    /** Configured tick period. The staleness bar is derived from it. */
    intervalMs: number;
    lastHeight?: bigint | null;
    recoverySubmittedTotal?: number;
    /** Set when the last tick failed — the one failure that costs money. */
    lastError?: string | null;
    deadlines?: readonly RecoveryDeadline[];
}

export interface AdminDeps {
    advances: AdvanceRepository;
    policy: PolicyRepository;
    recoveryExecutionBudget: { height: bigint; time: bigint };
    sweeperStatus: () => SweeperStatus;
    rescan(): Promise<void>;
    operationalSnapshot(options?: { ignoreManualPause?: boolean }): OperationalSnapshot;
    now(): number;
}

const MAX_LIMIT = 1_000;
const MAX_OFFSET = 1_000_000;
const DEFAULT_ADVANCE_LIMIT = 200;
const DEFAULT_HISTORY_LIMIT = 50;
const INT64_MAX = 9_223_372_036_854_775_807n;
const ACTIVE_EXPOSURE_STATES = new Set<AdvanceState>(["locking", "locked", "recovering"]);

/** A sweeper that has not ticked in three periods is not merely late: recovery
 * is the only thing bounding exposure, so the floor keeps a small interval from
 * making a dead loop look alive. */
const STALE_FLOOR_MS = 30_000;

export const PROXY_ACTOR_HEADER = "x-taxi-operator";
const MAX_ACTOR_LENGTH = 128;
const message = (e: unknown): string => sanitizeOperationalError(e, "operation failed");

const isSats = (s: string): boolean => /^[0-9]+$/.test(s) && BigInt(s) <= INT64_MAX;

// zod runs a transform even when an earlier refinement failed, so this one has
// to be total. The fallback is discarded along with the 400.
const sats = z
    .string()
    .refine(isSats, "expected a decimal sats amount inside the ledger's 64-bit range")
    .transform((s) => (isSats(s) ? BigInt(s) : 0n));

const units = z
    .string()
    .regex(/^(0|[1-9][0-9]*)$/)
    .pipe(z.string().transform(BigInt));
const assetId = z
    .object({
        txid: z.string().regex(/^[0-9a-f]{64}$/),
        groupIndex: z.number().int().min(0).max(65535),
    })
    .strict()
    .transform((id) => assetIdFromWire(id));
const fareOption = z
    .object({
        id: z.string().refine((id) => id.trim().length > 0, "fare option needs a non-empty id"),
        currency: z.discriminatedUnion("kind", [
            z.object({ kind: z.literal("sats") }).strict(),
            z.object({ kind: z.literal("sameAsset") }).strict(),
            z.object({ kind: z.literal("token"), assetId }).strict(),
        ]),
        pricing: z.discriminatedUnion("kind", [
            z.object({ kind: z.literal("flat"), units }).strict(),
            z
                .object({
                    kind: z.literal("proportional"),
                    bps: z.number().int().min(0).max(10000),
                    minUnits: units,
                    maxUnits: units.nullable(),
                })
                .strict(),
        ]),
    })
    .strict()
    .superRefine((fare, ctx) => {
        try {
            validateFareOption(fare);
        } catch (error) {
            ctx.addIssue({ code: z.ZodIssueCode.custom, message: message(error) });
        }
    });
const assetRule = z
    .object({
        assetId: assetId.nullable(),
        enabled: z.boolean(),
        fares: z.array(fareOption),
        claim: z.enum(["recycle", "purchase", "either"]),
        maxTopupSats: units.pipe(z.bigint().max(INT64_MAX)).nullable(),
    })
    .strict();

const policyPatch = z
    .object({
        paused: z.boolean().optional(),
        maxOutstandingSats: sats.optional(),
        maxPerPaymentTopupSats: sats.optional(),
        maxConcurrentAdvances: z.number().int().min(0).optional(),
        locktimeMarginBlocks: z.number().int().min(0).optional(),
        locktimeMarginSeconds: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).optional(),
        // Rules are replaced wholesale rather than patched member-by-member: a
        // partial edit of a nested list has no unambiguous meaning, and the
        // console reads the whole table before it writes.
        assetRules: z.array(assetRule).optional(),
        quoteTtlSeconds: z.number().int().min(1).optional(),
    })
    .strict();

// This schema is hand-maintained, so nothing makes it fail when Policy gains a
// field — it just becomes unsettable, and .strict() turns an attempt into a 400.
// The check is in policy.test.ts rather than here so it runs, not just compiles.
export const PATCHABLE_POLICY_KEYS = Object.keys(policyPatch.shape).filter(
    () => true,
) as (keyof Policy)[];

const emptyMutation = z.object({}).strict();

const issuesToMessage = (err: z.ZodError): string =>
    err.issues
        .map((i) => (i.path.length > 0 ? `${i.path.join(".")}: ${i.message}` : i.message))
        .join("; ");

interface AssetIdWire {
    txid: string;
    groupIndex: number;
}

interface AdvanceWire {
    id: string;
    state: AdvanceState;
    receiverKey: string;
    senderKey: string;
    operatorKey: string;
    dust: string;
    topup: string;
    locktime: string;
    covenantAddress: string;
    fare: unknown;
    createdAt: number;
    updatedAt: number;
    expiresAt: number;
    assetId?: AssetIdWire;
    outpoint?: { txid: string; vout: number };
    spentTxid?: string;
    arkTxid?: string;
    recoveryTxid?: string;
    batchExpiry: { kind: "height" | "time"; value: string };
    recoveryLocktime?: { kind: "height" | "time"; value: string };
    ageSeconds: number;
    submissionPhase?: Advance["submissionPhase"];
    recoveryPhase?: Advance["recoveryPhase"];
    submissionAttempts?: number;
    recoveryAttempts?: number;
    submissionNextAttemptAt?: number;
    recoveryNextAttemptAt?: number;
    failureCode?: string;
}

function toAdvanceWire(a: Advance, now: number): AdvanceWire {
    const out: AdvanceWire = {
        id: a.id,
        state: a.state,
        receiverKey: bytesToHex(a.receiverKey),
        senderKey: bytesToHex(a.senderKey),
        operatorKey: bytesToHex(a.operatorKey),
        dust: satsToWire(a.dust),
        topup: satsToWire(a.topup),
        locktime: satsToWire(a.locktime),
        covenantAddress: a.covenantAddress,
        fare: fareToWire(a.fare),
        createdAt: a.createdAt,
        updatedAt: a.updatedAt,
        expiresAt: a.expiresAt,
        batchExpiry: { kind: a.batchExpiry.kind, value: a.batchExpiry.value.toString() },
        ageSeconds: Math.max(0, now - a.updatedAt),
    };
    if (a.assetId !== undefined) {
        out.assetId = { txid: bytesToHex(a.assetId.txid), groupIndex: a.assetId.groupIndex };
    }
    if (a.outpoint !== undefined) out.outpoint = { ...a.outpoint };
    if (a.spentTxid !== undefined) out.spentTxid = a.spentTxid;
    if (a.arkTxid !== undefined) out.arkTxid = a.arkTxid;
    if (a.recoveryTxid !== undefined) out.recoveryTxid = a.recoveryTxid;
    if (a.recoveryLocktime)
        out.recoveryLocktime = {
            kind: a.recoveryLocktime.kind,
            value: a.recoveryLocktime.value.toString(),
        };
    if (a.submissionPhase) out.submissionPhase = a.submissionPhase;
    if (a.recoveryPhase) out.recoveryPhase = a.recoveryPhase;
    if (a.submissionAttempts !== undefined) out.submissionAttempts = a.submissionAttempts;
    if (a.recoveryAttempts !== undefined) out.recoveryAttempts = a.recoveryAttempts;
    if (a.submissionNextAttemptAt !== undefined)
        out.submissionNextAttemptAt = a.submissionNextAttemptAt;
    if (a.recoveryNextAttemptAt !== undefined) out.recoveryNextAttemptAt = a.recoveryNextAttemptAt;
    if (a.failureCode && /^[a-z0-9_.:-]{1,128}$/i.test(a.failureCode))
        out.failureCode = a.failureCode;
    return out;
}

const toPolicyWire = (p: Policy) => ({
    paused: p.paused,
    maxOutstandingSats: satsToWire(p.maxOutstandingSats),
    maxPerPaymentTopupSats: satsToWire(p.maxPerPaymentTopupSats),
    maxConcurrentAdvances: p.maxConcurrentAdvances,
    locktimeMarginBlocks: p.locktimeMarginBlocks,
    locktimeMarginSeconds: p.locktimeMarginSeconds,
    assetRules: p.assetRules.map(assetRuleToWire),
    quoteTtlSeconds: p.quoteTtlSeconds,
});

function sweeperView(read: () => SweeperStatus, now: number) {
    let s: SweeperStatus;
    try {
        s = read();
    } catch (e) {
        return {
            running: false,
            healthy: false,
            lastTickAt: null,
            sinceLastTickMs: null,
            staleAfterMs: STALE_FLOOR_MS,
            intervalMs: 0,
            lastHeight: null,
            recoverySubmittedTotal: 0,
            lastError: `sweeper status unavailable: ${message(e)}`,
        };
    }

    const staleAfterMs = Math.max(s.intervalMs * 3, STALE_FLOOR_MS);
    const sinceLastTickMs = s.lastTickAt === null ? null : Math.max(0, now - s.lastTickAt);
    const lastError = s.lastError
        ? sanitizeOperationalError(new Error(s.lastError), "sweeper failed")
        : null;

    return {
        running: s.running,
        healthy:
            s.running &&
            sinceLastTickMs !== null &&
            sinceLastTickMs <= staleAfterMs &&
            lastError === null,
        lastTickAt: s.lastTickAt,
        sinceLastTickMs,
        staleAfterMs,
        intervalMs: s.intervalMs,
        lastHeight:
            s.lastHeight === undefined || s.lastHeight === null ? null : satsToWire(s.lastHeight),
        recoverySubmittedTotal: s.recoverySubmittedTotal ?? 0,
        lastError,
    };
}

const ok = (c: Context, body: unknown) => c.json(body, 200, { "cache-control": "no-store" });
const bad = (c: Context, error: string) => c.json({ error }, 400, { "cache-control": "no-store" });
const accepted = (c: Context, body: unknown) => c.json(body, 202, { "cache-control": "no-store" });
const conflict = (c: Context, code: string, error: string, extra: object = {}) =>
    c.json({ code, error, ...extra }, 409, { "cache-control": "no-store" });

function parseLimit(raw: string | undefined, fallback: number): number {
    if (raw === undefined || raw === "") return fallback;
    if (!/^[0-9]+$/.test(raw)) throw new Error(`limit: expected a positive integer, got "${raw}"`);
    const n = Number(raw);
    if (n < 1 || n > MAX_LIMIT) throw new Error(`limit: must be between 1 and ${MAX_LIMIT}`);
    return n;
}

function parseOffset(raw: string | undefined): number {
    if (raw === undefined || raw === "") return 0;
    if (!/^[0-9]+$/.test(raw))
        throw new Error(`offset: expected a nonnegative integer, got "${raw}"`);
    const n = Number(raw);
    if (!Number.isSafeInteger(n) || n > MAX_OFFSET)
        throw new Error(`offset: must be between 0 and ${MAX_OFFSET}`);
    return n;
}

function parseSnapshotToken(raw: string | undefined, offset: number): string | undefined {
    if (raw === undefined || raw === "") {
        if (offset > 0) throw new Error("snapshot: required when offset is greater than 0");
        return undefined;
    }
    if (!/^[a-f0-9]{64}$/.test(raw)) throw new Error("snapshot: expected a 64-character token");
    return raw;
}

function parseState(raw: string | undefined): AdvanceState | undefined {
    if (raw === undefined || raw === "") return undefined;
    if (!(ADVANCE_STATES as readonly string[]).includes(raw)) {
        throw new Error(`state: unknown advance state "${raw}"`);
    }
    return raw as AdvanceState;
}

const compareBigint = (a: bigint, b: bigint): number => (a < b ? -1 : a > b ? 1 : 0);

function safetyUrgency(
    a: Advance,
    b: Advance,
    deadlines: ReadonlyMap<string, RecoveryDeadline>,
): number {
    const aActive = ACTIVE_EXPOSURE_STATES.has(a.state);
    const bActive = ACTIVE_EXPOSURE_STATES.has(b.state);
    if (aActive !== bActive) return aActive ? -1 : 1;
    if (!aActive) return b.createdAt - a.createdAt || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0);
    const severityRank = { expired: 0, critical: 1, warning: 2, eligible: 3 } as const;
    const severity =
        (deadlines.has(a.id) ? severityRank[deadlines.get(a.id)!.severity] : 3) -
        (deadlines.has(b.id) ? severityRank[deadlines.get(b.id)!.severity] : 3);
    if (severity) return severity;
    const aDomain = a.batchExpiry.kind === "height" ? 0 : 1;
    const bDomain = b.batchExpiry.kind === "height" ? 0 : 1;
    return (
        aDomain - bDomain ||
        compareBigint(a.batchExpiry.value, b.batchExpiry.value) ||
        compareBigint(
            a.recoveryLocktime?.value ?? a.locktime,
            b.recoveryLocktime?.value ?? b.locktime,
        ) ||
        (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
    );
}

function advanceSnapshotToken(
    state: AdvanceState | undefined,
    rows: readonly Advance[],
    deadlines: ReadonlyMap<string, RecoveryDeadline>,
): string {
    const hash = createHash("sha256");
    hash.update(JSON.stringify(["admin-advances-v1", state ?? "all", rows.length]));
    for (const row of rows) {
        const deadline = deadlines.get(row.id);
        hash.update(
            JSON.stringify([
                row.id,
                row.state,
                row.updatedAt,
                row.createdAt,
                row.batchExpiry.kind,
                row.batchExpiry.value.toString(),
                row.recoveryLocktime?.kind ?? null,
                row.recoveryLocktime?.value.toString() ?? null,
                row.locktime.toString(),
                deadline?.severity ?? null,
                deadline?.kind ?? null,
                deadline?.batchExpiry.toString() ?? null,
                deadline?.locktime.toString() ?? null,
            ]),
        );
    }
    return hash.digest("hex");
}

async function readJson(c: Context): Promise<unknown> {
    const contentType = c.req.header("content-type")?.toLowerCase() ?? "";
    if (!/^application\/json(?:\s*;|$)/.test(contentType))
        throw new Error("content-type: expected application/json");
    try {
        return await c.req.json();
    } catch {
        throw new Error("body: expected a JSON object");
    }
}

function proxyActor(c: Context): string {
    const actor = c.req.header(PROXY_ACTOR_HEADER)?.trim() ?? "";
    if (!actor) throw new Error(`header ${PROXY_ACTOR_HEADER}: operator identity is required`);
    if (actor.length > MAX_ACTOR_LENGTH)
        throw new Error(`header ${PROXY_ACTOR_HEADER}: operator identity is too long`);
    if (/[\u0000-\u001f\u007f]/.test(actor))
        throw new Error(`header ${PROXY_ACTOR_HEADER}: operator identity is invalid`);
    return actor;
}

/** Registers every JSON route under `prefix`. Called twice — bare and under
 * `/admin` — so the router answers whether `server.ts` mounts it at `/` or at
 * `/admin`. */
export function registerApiRoutes(app: Hono, prefix: string, deps: AdminDeps): void {
    const at = (p: string) => `${prefix}${p}`;
    let rescanPending: Promise<void> | undefined;
    const rescan = () => {
        if (!rescanPending)
            rescanPending = deps.rescan().finally(() => {
                rescanPending = undefined;
            });
        return rescanPending;
    };
    const mutation = async (c: Context): Promise<string> => {
        const who = proxyActor(c);
        const parsed = emptyMutation.safeParse(await readJson(c));
        if (!parsed.success) throw new Error(issuesToMessage(parsed.error));
        return who;
    };

    app.get(at("/api/status"), (c) => {
        const byState = ADVANCE_STATES.map((s) => [s, deps.advances.byState(s)] as const);
        const counts = Object.fromEntries(byState.map(([s, rows]) => [s, rows.length]));
        const active = byState.flatMap(([, rows]) =>
            rows.filter((row) => ACTIVE_EXPOSURE_STATES.has(row.state)),
        );
        const oldest = { height: null as bigint | null, time: null as bigint | null };
        let outstandingSats = 0n;
        for (const row of active) {
            outstandingSats += row.topup;
            const deadline = row.recoveryLocktime ?? {
                kind: row.batchExpiry.kind,
                value: row.locktime,
            };
            if (oldest[deadline.kind] === null || deadline.value < oldest[deadline.kind]!)
                oldest[deadline.kind] = deadline.value;
        }

        return ok(c, {
            now: Date.now(),
            paused: deps.policy.get().paused,
            exposure: {
                outstandingSats: satsToWire(outstandingSats),
                activeCount: active.length,
                oldestUnsweptLocktime: {
                    height: oldest.height === null ? null : satsToWire(oldest.height),
                    time: oldest.time === null ? null : satsToWire(oldest.time),
                },
            },
            counts,
            total: byState.reduce((n, [, rows]) => n + rows.length, 0),
            sweeper: sweeperView(deps.sweeperStatus, Date.now()),
            readiness: deps.operationalSnapshot().body,
        });
    });

    app.get(at("/api/policy"), (c) => ok(c, toPolicyWire(deps.policy.get())));

    app.patch(at("/api/policy"), async (c) => {
        let body: unknown;
        let who: string;
        try {
            who = proxyActor(c);
            body = await readJson(c);
        } catch (e) {
            return bad(c, message(e));
        }

        const parsed = policyPatch.safeParse(body);
        if (!parsed.success) return bad(c, issuesToMessage(parsed.error));

        const patch = parsed.data;
        const current = deps.policy.get();
        const nextBlocks = patch.locktimeMarginBlocks ?? current.locktimeMarginBlocks;
        const nextSeconds = patch.locktimeMarginSeconds ?? current.locktimeMarginSeconds;
        if (
            BigInt(nextBlocks) <= deps.recoveryExecutionBudget.height ||
            BigInt(nextSeconds) <= deps.recoveryExecutionBudget.time
        )
            return bad(c, "policy margin must exceed the configured recovery execution budget");
        try {
            return ok(c, toPolicyWire(deps.policy.update(patch, who)));
        } catch (e) {
            return bad(c, message(e));
        }
    });

    app.get(at("/api/policy/history"), (c) => {
        let limit: number;
        try {
            limit = parseLimit(c.req.query("limit"), DEFAULT_HISTORY_LIMIT);
        } catch (e) {
            return bad(c, message(e));
        }
        return ok(c, { history: deps.policy.history(limit) });
    });

    app.get(at("/api/advances"), (c) => {
        let state: AdvanceState | undefined;
        let limit: number;
        let offset: number;
        let requestedSnapshot: string | undefined;
        try {
            state = parseState(c.req.query("state"));
            limit = parseLimit(c.req.query("limit"), DEFAULT_ADVANCE_LIMIT);
            offset = parseOffset(c.req.query("offset"));
            requestedSnapshot = parseSnapshotToken(c.req.query("snapshot"), offset);
        } catch (e) {
            return bad(c, message(e));
        }

        const rows =
            state === undefined
                ? ADVANCE_STATES.flatMap((s) => deps.advances.byState(s))
                : deps.advances.byState(state);

        let deadlines: readonly RecoveryDeadline[] = [];
        try {
            deadlines = deps.sweeperStatus().deadlines ?? [];
        } catch {
            deadlines = [];
        }
        const byAdvance = new Map(deadlines.map((deadline) => [deadline.advanceId, deadline]));
        rows.sort((a, b) => safetyUrgency(a, b, byAdvance));
        const snapshotToken = advanceSnapshotToken(state, rows, byAdvance);
        if (offset > 0 && requestedSnapshot !== snapshotToken)
            return conflict(
                c,
                "snapshot_changed",
                "advance snapshot changed; restart from offset 0",
                {
                    resetOffset: 0,
                },
            );
        const end = Math.min(rows.length, offset + limit);
        const hiddenUrgentCount = rows.slice(end).filter((row) => {
            const severity = byAdvance.get(row.id)?.severity;
            return severity === "expired" || severity === "critical";
        }).length;

        return ok(c, {
            advances: rows.slice(offset, end).map((row) => toAdvanceWire(row, deps.now())),
            total: rows.length,
            offset,
            limit,
            nextOffset: end < rows.length ? end : null,
            hasMore: end < rows.length,
            hiddenUrgentCount,
            paginationMode: "current_snapshot",
            snapshotToken,
        });
    });

    for (const path of [at("/api/policy/pause"), at("/api/pause")])
        app.post(path, async (c) => {
            try {
                return ok(c, toPolicyWire(deps.policy.update({ paused: true }, await mutation(c))));
            } catch (e) {
                return bad(c, message(e));
            }
        });

    for (const path of [at("/api/policy/resume"), at("/api/resume")])
        app.post(path, async (c) => {
            let who: string;
            try {
                who = await mutation(c);
                await rescan();
            } catch (e) {
                return bad(c, message(e));
            }
            const state = deps.operationalSnapshot({ ignoreManualPause: true });
            if (!state.ready)
                return conflict(
                    c,
                    "resume_blocked",
                    state.body.reason ?? state.body.blockers[0] ?? "resume blocked",
                    { blockers: state.body.blockers },
                );
            try {
                return ok(c, toPolicyWire(deps.policy.update({ paused: false }, who)));
            } catch (e) {
                return bad(c, message(e));
            }
        });

    app.post(at("/api/rescan"), async (c) => {
        try {
            const who = await mutation(c);
            await rescan();
            deps.policy.recordOperation("rescan", who);
            return accepted(c, { accepted: true, action: "rescan" });
        } catch (e) {
            return bad(c, message(e));
        }
    });

    for (const [suffix, action, expedite] of [
        [
            "retry-submission",
            "retry-submission",
            (id: string) => deps.advances.expediteSubmission(id, deps.now()),
        ],
        [
            "retry-recovery",
            "retry-recovery",
            (id: string) => deps.advances.expediteRecovery(id, deps.now()),
        ],
    ] as const) {
        app.post(at(`/api/advances/:id/${suffix}`), async (c) => {
            let who: string;
            try {
                who = await mutation(c);
            } catch (e) {
                return bad(c, message(e));
            }
            const advanceId = c.req.param("id") ?? "";
            const result = expedite(advanceId);
            if (result === "not_found")
                return c.json({ code: "not_found", error: "advance not found" }, 404, {
                    "cache-control": "no-store",
                });
            if (result !== "expedited")
                return conflict(
                    c,
                    result === "live_lease" ? "retry_live_lease" : "retry_incompatible",
                    result === "live_lease"
                        ? "advance has a live worker lease"
                        : "advance is not in a retryable durable phase",
                );
            deps.policy.recordOperation(action, who);
            try {
                await rescan();
            } catch (e) {
                return c.json({ code: "rescan_failed", error: message(e) }, 503, {
                    "cache-control": "no-store",
                });
            }
            return accepted(c, { accepted: true, action, advanceId });
        });
    }
}
