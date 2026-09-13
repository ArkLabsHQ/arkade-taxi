import type { Database } from "better-sqlite3";
import {
    isTerminal,
    ruleFor,
    validateFundingSnapshot,
    type Advance,
    type ExpiryDeadline,
    type Outpoint,
} from "@arkade-taxi/core";
import { AdvanceRepository } from "./advances.js";
import { PolicyRepository } from "./policy.js";
import { assertNativeAccess } from "./coordination.js";

export interface ReserveQuoteRequest {
    advance: Advance;
    expectedPolicyRevision: bigint;
    recoveryExecutionBudget: ExpiryDeadline;
    expectedReservedOutpoints?: readonly Outpoint[];
}

export class ReservationConflictError extends Error {
    constructor() {
        super("reservation: operator input already reserved");
        this.name = "ReservationConflictError";
    }
}

export class PolicyRevisionConflictError extends Error {
    readonly code = "policy_changed";

    constructor() {
        super("reservation: policy snapshot changed");
        this.name = "PolicyRevisionConflictError";
    }
}

export class RecoveryBudgetConflictError extends Error {
    readonly code = "recovery_budget_invalid";

    constructor(id: string) {
        super(`reservation: recovery execution budget is unsafe for ${id}`);
        this.name = "RecoveryBudgetConflictError";
    }
}

export class LockupClaimError extends Error {
    constructor(
        readonly code:
            | "not_found"
            | "quote_expired"
            | "invalid_state"
            | "funding_reservation_invalid"
            | "exceeds_max_outstanding"
            | "max_concurrent_advances"
            | "envelope_conflict",
        id: string,
    ) {
        super(`lockup claim for ${id}: ${code}`);
        this.name = "LockupClaimError";
    }
}

export interface LockupClaimResult {
    advance: Advance;
    claimed: boolean;
}

export class ReservationRepository {
    readonly #db: Database;
    readonly #advances: AdvanceRepository;
    readonly #policy: PolicyRepository;

    constructor(db: Database) {
        assertNativeAccess(db);
        this.#db = db;
        this.#advances = new AdvanceRepository(db);
        this.#policy = new PolicyRepository(db);
    }

    reserveQuote({
        advance,
        expectedPolicyRevision,
        recoveryExecutionBudget,
        expectedReservedOutpoints,
    }: ReserveQuoteRequest): void {
        assertNativeAccess(this.#db);
        this.#db
            .transaction(() => {
                const { policy, revision } = this.#policy.getSnapshot();
                if (revision !== expectedPolicyRevision) throw new PolicyRevisionConflictError();
                if (expectedReservedOutpoints) {
                    const expected = new Set(
                        expectedReservedOutpoints.map(({ txid, vout }) => `${txid}:${vout}`),
                    );
                    const current = this.#list();
                    if (
                        current.length !== expected.size ||
                        current.some(({ txid, vout }) => !expected.has(`${txid}:${vout}`))
                    )
                        throw new ReservationConflictError();
                }
                if (advance.state !== "quoted")
                    throw new Error("reservation: advance must be quoted");
                validateFundingSnapshot(advance);
                const recovery = advance.recoveryLocktime;
                const policyMargin = BigInt(
                    advance.batchExpiry.kind === "height"
                        ? policy.locktimeMarginBlocks
                        : policy.locktimeMarginSeconds,
                );
                if (
                    !recovery ||
                    recovery.kind !== advance.batchExpiry.kind ||
                    recoveryExecutionBudget?.kind !== recovery.kind ||
                    recoveryExecutionBudget.value < 0n ||
                    policyMargin <= recoveryExecutionBudget.value ||
                    recovery.value + recoveryExecutionBudget.value >= advance.batchExpiry.value
                )
                    throw new RecoveryBudgetConflictError(advance.id);
                if (policy.paused) throw new Error("reservation: paused");
                const rule = ruleFor(policy.assetRules, advance.assetId);
                if (!rule?.enabled) throw new Error("reservation: asset not served");
                if (
                    advance.topup <= 0n ||
                    advance.topup > advance.dust ||
                    advance.topup > (rule.maxTopupSats ?? policy.maxPerPaymentTopupSats)
                ) {
                    throw new Error("reservation: topup exceeds per-payment limit");
                }
                if (
                    advance.batchExpiry.value - advance.locktime <
                    BigInt(
                        advance.batchExpiry.kind === "height"
                            ? policy.locktimeMarginBlocks
                            : policy.locktimeMarginSeconds,
                    )
                ) {
                    throw new Error("reservation: insufficient batch expiry margin");
                }
                const exposure = this.#db
                    .prepare<[], { total: bigint; count: bigint }>(
                        `SELECT coalesce(sum(topup), 0) AS total, count(*) AS count FROM advances
                 WHERE state IN ('locking', 'locked', 'recovering')`,
                    )
                    .safeIntegers(true)
                    .get()!;
                if (exposure.total + advance.topup > policy.maxOutstandingSats)
                    throw new Error("reservation: exceeds max outstanding");
                if (exposure.count >= BigInt(policy.maxConcurrentAdvances))
                    throw new Error("reservation: max concurrent advances");
                const conflict = this.#db
                    .prepare<[string, number], { advance_id: string }>(
                        "SELECT advance_id FROM operator_input_reservations WHERE outpoint_txid = ? AND outpoint_vout = ?",
                    )
                    .safeIntegers(true);
                for (const input of advance.operatorInputs) {
                    if (conflict.get(input.txid, input.vout)) throw new ReservationConflictError();
                    if (
                        this.#db
                            .prepare(
                                "SELECT 1 FROM proceeds_inputs WHERE outpoint_txid = ? AND outpoint_vout = ?",
                            )
                            .get(input.txid, input.vout)
                    )
                        throw new ReservationConflictError();
                }
                this.#advances.insert(advance);
                const insert = this.#db.prepare(
                    "INSERT INTO operator_input_reservations (outpoint_txid, outpoint_vout, advance_id, batch_expiry_kind, batch_expiry_value, created_at) VALUES (?, ?, ?, ?, ?, ?)",
                );
                for (const input of advance.operatorInputs) {
                    insert.run(
                        input.txid,
                        input.vout,
                        advance.id,
                        advance.batchExpiry.kind,
                        advance.batchExpiry.value,
                        advance.createdAt,
                    );
                }
            })
            .immediate();
    }

    claimLockup(
        id: string,
        unsignedTxId: string,
        signedEnvelopeDigest: string,
        signedLockupEnvelope: string,
        now: () => number,
    ): LockupClaimResult {
        assertNativeAccess(this.#db);
        const result = this.#db
            .transaction(() => {
                const at = now();
                this.#db
                    .prepare(
                        "UPDATE advances SET state = 'expired', updated_at = max(updated_at, ?) WHERE state = 'quoted' AND expires_at <= ?",
                    )
                    .run(at, at);
                this.#db
                    .prepare(
                        "DELETE FROM operator_input_reservations WHERE advance_id IN (SELECT id FROM advances WHERE state = 'expired' AND expires_at <= ?)",
                    )
                    .run(at);
                const advance = this.#advances.get(id);
                if (!advance) return new LockupClaimError("not_found", id);
                if (advance.state === "expired") return new LockupClaimError("quote_expired", id);
                if (advance.unsignedLockupId !== unsignedTxId)
                    return new LockupClaimError("envelope_conflict", id);
                if (advance.state === "locking" || advance.state === "locked") {
                    if (
                        advance.signedEnvelopeDigest !== signedEnvelopeDigest ||
                        advance.signedLockupEnvelope !== signedLockupEnvelope
                    )
                        return new LockupClaimError("envelope_conflict", id);
                    return { advance, claimed: false };
                }
                if (advance.state !== "quoted") return new LockupClaimError("invalid_state", id);
                const policy = this.#policy.get();
                const exposure = this.#db
                    .prepare<[], { total: bigint; count: bigint }>(
                        "SELECT coalesce(sum(topup), 0) AS total, count(*) AS count FROM advances WHERE state IN ('locking', 'locked', 'recovering')",
                    )
                    .safeIntegers(true)
                    .get()!;
                if (exposure.total + advance.topup > policy.maxOutstandingSats)
                    throw new LockupClaimError("exceeds_max_outstanding", id);
                if (exposure.count >= BigInt(policy.maxConcurrentAdvances))
                    throw new LockupClaimError("max_concurrent_advances", id);
                validateFundingSnapshot(advance);
                const expected = new Set(
                    advance.operatorInputs.map(({ txid, vout }) => `${txid}:${vout}`),
                );
                const reserved = this.#list(id);
                if (
                    expected.size !== advance.operatorInputs.length ||
                    reserved.length !== expected.size ||
                    reserved.some(({ txid, vout }) => !expected.has(`${txid}:${vout}`))
                )
                    return new LockupClaimError("funding_reservation_invalid", id);
                const submissionKey = `lockup:${id}:${advance.unsignedLockupId}`;
                const update = this.#db
                    .prepare(
                        "UPDATE advances SET state = 'locking', submission_key = ?, signed_envelope_digest = ?, submission_phase = 'claimed', signed_lockup_envelope = ?, submitted_at = ?, updated_at = max(updated_at, ?) WHERE id = ? AND state = 'quoted' AND expires_at > ?",
                    )
                    .run(submissionKey, signedEnvelopeDigest, signedLockupEnvelope, at, at, id, at);
                if (Number(update.changes) !== 1) return new LockupClaimError("invalid_state", id);
                return {
                    claimed: true,
                    advance: {
                        ...advance,
                        state: "locking" as const,
                        submissionKey,
                        signedEnvelopeDigest,
                        submissionPhase: "claimed" as const,
                        signedLockupEnvelope,
                        submittedAt: at,
                        updatedAt: Math.max(at, advance.updatedAt),
                    },
                };
            })
            .immediate();
        if (result instanceof LockupClaimError) throw result;
        return result;
    }

    expireQuotes(at: number): number {
        assertNativeAccess(this.#db);
        if (!Number.isSafeInteger(at) || at < 0)
            throw new Error("reservation: invalid expiry clock");
        return this.#db
            .transaction(() => {
                const expired = this.#db
                    .prepare(
                        "UPDATE advances SET state = 'expired', updated_at = max(updated_at, ?) WHERE state = 'quoted' AND expires_at <= ?",
                    )
                    .run(at, at).changes;
                this.#db
                    .prepare(
                        "DELETE FROM operator_input_reservations WHERE advance_id IN (SELECT id FROM advances WHERE state = 'expired' AND expires_at <= ?)",
                    )
                    .run(at);
                return Number(expired);
            })
            .immediate();
    }

    releaseForAdvance(advanceId: string): void {
        assertNativeAccess(this.#db);
        this.#db
            .transaction(() => {
                const advance = this.#advances.get(advanceId);
                if (!advance) throw new Error(`reservation: advance ${advanceId} not found`);
                if (!isTerminal(advance.state))
                    throw new Error(`reservation: cannot release ${advance.state}`);
                if (advance.state === "expired") {
                    if (advance.updatedAt < advance.expiresAt)
                        throw new Error("reservation: cannot release unexpired quote");
                } else if (!advance.spentTxid || advance.lastObservedAt === undefined) {
                    throw new Error("reservation: release requires observed terminal spend");
                }
                this.#db
                    .prepare("DELETE FROM operator_input_reservations WHERE advance_id = ?")
                    .run(advanceId);
            })
            .immediate();
    }

    recordLockupConflict(id: string, detail: string, at: number): void {
        assertNativeAccess(this.#db);
        this.#db
            .transaction(() => {
                this.#advances.recordLockupFailure(id, "reserved_input_conflict", detail, at);
                this.#policy.update({ paused: true }, "lockup-reconciler");
            })
            .immediate();
    }

    listReservedOutpoints(): Outpoint[] {
        assertNativeAccess(this.#db);
        return this.#list();
    }

    listForAdvance(advanceId: string): Outpoint[] {
        assertNativeAccess(this.#db);
        return this.#list(advanceId);
    }

    #list(advanceId?: string): Outpoint[] {
        return this.#db
            .prepare<unknown[], { txid: string; vout: bigint }>(
                `SELECT outpoint_txid AS txid, outpoint_vout AS vout FROM operator_input_reservations
             ${advanceId === undefined ? "UNION ALL SELECT outpoint_txid AS txid, outpoint_vout AS vout FROM proceeds_inputs" : "WHERE advance_id = ?"} ORDER BY txid, vout`,
            )
            .safeIntegers(true)
            .all(...(advanceId === undefined ? [] : [advanceId]))
            .map(({ txid, vout }) => ({ txid, vout: Number(vout) }));
    }
}
