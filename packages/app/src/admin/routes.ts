/**
 * The operator's JSON API. Every bigint leaves as a decimal string and every
 * byte field as lowercase hex, matching `@arkade-taxi/protocol`: JSON has no
 * bigint, and a sats value losing precision above 2^53 only shows up on a large
 * payment.
 */

import type { Context, Hono } from "hono";
import { z } from "zod";
import {
    computeExposure,
    type Advance,
    type AdvanceState,
    type AssetRule,
    type Policy,
} from "@arkade-taxi/core";
import { ADVANCE_STATES, type AdvanceRepository, type PolicyRepository } from "@arkade-taxi/db";
import { bytesToHex, fareToWire, satsToWire } from "@arkade-taxi/protocol";
import { assetRuleToWire } from "../rulesWire.js";

/** What the admin surface needs to know about the sweeper. Only the first three
 * fields are required, so a sweeper that tracks less can still report. */
export interface SweeperStatus {
    running: boolean;
    /** Epoch ms of the last completed tick; null before the first one. */
    lastTickAt: number | null;
    /** Configured tick period. The staleness bar is derived from it. */
    intervalMs: number;
    lastHeight?: bigint | null;
    sweptCount?: number;
    /** Set when the last tick failed — the one failure that costs money. */
    lastError?: string | null;
}

export interface AdminDeps {
    advances: AdvanceRepository;
    policy: PolicyRepository;
    sweeperStatus: () => SweeperStatus;
}

const MAX_LIMIT = 1_000;
const DEFAULT_ADVANCE_LIMIT = 200;
const DEFAULT_HISTORY_LIMIT = 50;
const INT64_MAX = 9_223_372_036_854_775_807n;

/** A sweeper that has not ticked in three periods is not merely late: recovery
 * is the only thing bounding exposure, so the floor keeps a small interval from
 * making a dead loop look alive. */
const STALE_FLOOR_MS = 30_000;

const message = (e: unknown): string => (e instanceof Error ? e.message : String(e));

const isSats = (s: string): boolean => /^[0-9]+$/.test(s) && BigInt(s) <= INT64_MAX;

// zod runs a transform even when an earlier refinement failed, so this one has
// to be total. The fallback is discarded along with the 400.
const sats = z
    .string()
    .refine(isSats, "expected a decimal sats amount inside the ledger's 64-bit range")
    .transform((s) => (isSats(s) ? BigInt(s) : 0n));

const actor = z
    .string()
    .transform((s) => s.trim())
    .refine((s) => s !== "", "an edit must name its actor");

const policyPatch = z
    .object({
        actor,
        paused: z.boolean().optional(),
        maxOutstandingSats: sats.optional(),
        maxPerPaymentTopupSats: sats.optional(),
        maxConcurrentAdvances: z.number().int().min(0).optional(),
        locktimeMarginBlocks: z.number().int().min(0).optional(),
        // Rules are replaced wholesale rather than patched member-by-member: a
        // partial edit of a nested list has no unambiguous meaning, and the
        // console reads the whole table before it writes.
        assetRules: z.array(z.custom<AssetRule>()).optional(),
        quoteTtlSeconds: z.number().int().min(1).optional(),
    })
    .strict();

// This schema is hand-maintained, so nothing makes it fail when Policy gains a
// field — it just becomes unsettable, and .strict() turns an attempt into a 400.
// The check is in policy.test.ts rather than here so it runs, not just compiles.
export const PATCHABLE_POLICY_KEYS = Object.keys(policyPatch.shape).filter(
    (k) => k !== "actor",
) as (keyof Policy)[];

const actorOnly = z.object({ actor }).strict();

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
}

function toAdvanceWire(a: Advance): AdvanceWire {
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
    };
    if (a.assetId !== undefined) {
        out.assetId = { txid: bytesToHex(a.assetId.txid), groupIndex: a.assetId.groupIndex };
    }
    if (a.outpoint !== undefined) out.outpoint = { ...a.outpoint };
    if (a.spentTxid !== undefined) out.spentTxid = a.spentTxid;
    return out;
}

const toPolicyWire = (p: Policy) => ({
    paused: p.paused,
    maxOutstandingSats: satsToWire(p.maxOutstandingSats),
    maxPerPaymentTopupSats: satsToWire(p.maxPerPaymentTopupSats),
    maxConcurrentAdvances: p.maxConcurrentAdvances,
    locktimeMarginBlocks: p.locktimeMarginBlocks,
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
            sweptCount: 0,
            lastError: `sweeper status unavailable: ${message(e)}`,
        };
    }

    const staleAfterMs = Math.max(s.intervalMs * 3, STALE_FLOOR_MS);
    const sinceLastTickMs = s.lastTickAt === null ? null : Math.max(0, now - s.lastTickAt);
    const lastError = s.lastError ?? null;

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
        sweptCount: s.sweptCount ?? 0,
        lastError,
    };
}

const ok = (c: Context, body: unknown) => c.json(body, 200, { "cache-control": "no-store" });
const bad = (c: Context, error: string) => c.json({ error }, 400, { "cache-control": "no-store" });

function parseLimit(raw: string | undefined, fallback: number): number {
    if (raw === undefined || raw === "") return fallback;
    if (!/^[0-9]+$/.test(raw)) throw new Error(`limit: expected a positive integer, got "${raw}"`);
    const n = Number(raw);
    if (n < 1 || n > MAX_LIMIT) throw new Error(`limit: must be between 1 and ${MAX_LIMIT}`);
    return n;
}

function parseState(raw: string | undefined): AdvanceState | undefined {
    if (raw === undefined || raw === "") return undefined;
    if (!(ADVANCE_STATES as readonly string[]).includes(raw)) {
        throw new Error(`state: unknown advance state "${raw}"`);
    }
    return raw as AdvanceState;
}

async function readJson(c: Context): Promise<unknown> {
    try {
        return await c.req.json();
    } catch {
        throw new Error("body: expected a JSON object");
    }
}

/** Registers every JSON route under `prefix`. Called twice — bare and under
 * `/admin` — so the router answers whether `server.ts` mounts it at `/` or at
 * `/admin`. */
export function registerApiRoutes(app: Hono, prefix: string, deps: AdminDeps): void {
    const at = (p: string) => `${prefix}${p}`;

    app.get(at("/api/status"), (c) => {
        const byState = ADVANCE_STATES.map((s) => [s, deps.advances.byState(s)] as const);
        const counts = Object.fromEntries(byState.map(([s, rows]) => [s, rows.length]));
        const locked = byState.find(([s]) => s === "locked")?.[1] ?? [];
        const exposure = computeExposure(locked);

        return ok(c, {
            now: Date.now(),
            paused: deps.policy.get().paused,
            exposure: {
                outstandingSats: satsToWire(exposure.outstandingSats),
                lockedCount: exposure.lockedCount,
                oldestUnsweptLocktime:
                    exposure.oldestUnsweptLocktime === null
                        ? null
                        : satsToWire(exposure.oldestUnsweptLocktime),
            },
            counts,
            total: byState.reduce((n, [, rows]) => n + rows.length, 0),
            sweeper: sweeperView(deps.sweeperStatus, Date.now()),
        });
    });

    app.get(at("/api/policy"), (c) => ok(c, toPolicyWire(deps.policy.get())));

    app.patch(at("/api/policy"), async (c) => {
        let body: unknown;
        try {
            body = await readJson(c);
        } catch (e) {
            return bad(c, message(e));
        }

        const parsed = policyPatch.safeParse(body);
        if (!parsed.success) return bad(c, issuesToMessage(parsed.error));

        const { actor: who, ...patch } = parsed.data;
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
        try {
            state = parseState(c.req.query("state"));
            limit = parseLimit(c.req.query("limit"), DEFAULT_ADVANCE_LIMIT);
        } catch (e) {
            return bad(c, message(e));
        }

        const rows =
            state === undefined
                ? ADVANCE_STATES.flatMap((s) => deps.advances.byState(s))
                : deps.advances.byState(state);

        rows.sort((a, b) => b.createdAt - a.createdAt || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0));

        return ok(c, {
            advances: rows.slice(0, limit).map(toAdvanceWire),
            total: rows.length,
        });
    });

    for (const [path, paused] of [
        [at("/api/pause"), true],
        [at("/api/resume"), false],
    ] as const) {
        app.post(path, async (c) => {
            let body: unknown;
            try {
                body = await readJson(c);
            } catch (e) {
                return bad(c, message(e));
            }

            const parsed = actorOnly.safeParse(body);
            if (!parsed.success) return bad(c, issuesToMessage(parsed.error));

            try {
                return ok(c, toPolicyWire(deps.policy.update({ paused }, parsed.data.actor)));
            } catch (e) {
                return bad(c, message(e));
            }
        });
    }
}
