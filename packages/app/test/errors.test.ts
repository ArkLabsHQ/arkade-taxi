import { describe, expect, it } from "vitest";
import { admit, type Policy } from "@arkade-taxi/core";
import { DatabaseBusyError, PolicyRevisionConflictError } from "@arkade-taxi/db";
import {
    ADMISSION_REASONS,
    admissionError,
    ErrorCode,
    ServiceError,
    sanitizeOperationalError,
    toErrorResponse,
} from "../src/errors.js";
import { policy as basePolicy, receiverKey, senderKey } from "./fixtures.js";
import { LockupShapeError } from "../src/lockup.js";

const EXPOSURE = { outstandingSats: 0n, lockedCount: 0, oldestUnsweptLocktime: null };

const someAsset = { txid: new Uint8Array(32).fill(7), groupIndex: 0 };

const reasonFrom = (over: Partial<Policy>, senderSats = 0n, withAsset = false): string => {
    const d = admit(
        { receiverKey, senderKey, senderSats, ...(withAsset ? { assetId: someAsset } : {}) },
        basePolicy(over),
        EXPOSURE,
        330n,
        10n,
    );
    if (d.ok) throw new Error("expected admit to reject");
    return d.reason;
};

describe("ServiceError", () => {
    it("reports unsupported lockup output shapes explicitly", () => {
        const result = ServiceError.from(
            new LockupShapeError("operator-fare output is below the Arkade Service minimum 10"),
        );
        expect(result).toMatchObject({ code: "lockup_shape", status: 503 });
        expect(toErrorResponse(result).error).toContain("minimum 10");
    });
    it("reports shared-connection contention as a transient service refusal", () => {
        expect(ServiceError.from(new DatabaseBusyError())).toMatchObject({
            code: "database_busy",
            status: 503,
        });
    });
    it("reports a policy revision race as an actionable conflict", () => {
        expect(ServiceError.from(new PolicyRevisionConflictError())).toMatchObject({
            code: "policy_changed",
            status: 409,
        });
    });
    it("carries a stable code and an HTTP status", () => {
        const e = new ServiceError(ErrorCode.NotFound, 404, "no such transfer");
        expect(e.code).toBe("not_found");
        expect(e.status).toBe(404);
        expect(e).toBeInstanceOf(Error);
    });

    it("serialises to an ErrorResponse body", () => {
        const e = new ServiceError(ErrorCode.InvalidRequest, 400, "bad hex");
        expect(toErrorResponse(e)).toEqual({ code: "invalid_request", error: "bad hex" });
    });

    it("maps an unknown throwable to a 500 without leaking its message", () => {
        const e = ServiceError.from(new Error("sqlite: disk I/O error"));
        expect(e.status).toBe(500);
        expect(e.code).toBe("internal_error");
        expect(e.message).not.toMatch(/sqlite/);
    });

    it("passes a ServiceError through unchanged", () => {
        const original = new ServiceError(ErrorCode.NotFound, 404, "gone");
        expect(ServiceError.from(original)).toBe(original);
    });

    // The codecs throw plain Errors prefixed "protocol:"; a malformed body is a
    // client mistake, not a server fault.
    it("maps a protocol codec error to 400", () => {
        const e = ServiceError.from(new Error("protocol: params.receiverKey: not lowercase hex"));
        expect(e.status).toBe(400);
        expect(e.code).toBe("invalid_request");
        expect(e.message).toMatch(/receiverKey/);
    });
});

describe("sanitizeOperationalError", () => {
    it.each([
        "private key=11" + "22".repeat(31),
        "seed phrase: abandon ability able about above absent absorb abstract absurd abuse access accident",
        "signed PSBT: " + "A".repeat(180),
        "signed transaction=" + "deadbeef".repeat(40),
    ])("removes secret material from an operational error", (secret) => {
        const result = sanitizeOperationalError(new Error(`provider failed: ${secret}`));
        expect(result).toContain("provider failed");
        expect(result).not.toContain(secret.split(/[:=]/).at(-1)!.trim());
        expect(result.length).toBeLessThanOrEqual(256);
    });

    it("does not serialize unknown objects or stacks", () => {
        const value = { message: "seed phrase: never expose me", stack: "private stack" };
        expect(sanitizeOperationalError(value)).toBe("operation failed");
    });

    it.each([
        "secret=hush",
        "credential: tiny-value",
        "token short-token",
        "password=p@ssw0rd",
        "api_key=abc123",
        "Authorization: Bearer abc.def.ghi",
        "cookie=session-short",
        "provider returned Bearer bearer-only-value",
        "wallet 5HueCGU8rMjxEXxiPuD5BDuRaKSWpMPdKxJ2FQ3w6z4v7y8a9bC",
        "github ghp_1234567890abcdefghijklmnopqrstuv",
    ])("redacts bounded credential labels and known token shapes: %s", (value) => {
        const result = sanitizeOperationalError(new Error(`operation failed: ${value}`));
        expect(result).toContain("[redacted]");
        expect(result).not.toContain(value.split(/[ :=]/).at(-1));
    });

    it.each([
        "client_secret=tiny-client-value",
        "ACCESS-TOKEN=short-access-value",
        "refresh_token: short-refresh-value",
        "db_password=p@ssword",
        "SESSION_COOKIE=session-cookie-value",
    ])("redacts qualified credential labels: %s", (value) => {
        const result = sanitizeOperationalError(new Error(`provider failed: ${value}`));
        expect(result).toContain("[redacted]");
        expect(result).not.toContain(value.split(/[ :=]/).at(-1));
    });

    it("does not claim an arbitrary short unlabeled value is secret", () => {
        expect(sanitizeOperationalError(new Error("provider returned ordinary-value"))).toBe(
            "provider returned ordinary-value",
        );
    });
});

describe("admissionError", () => {
    it("sets code to the rejection reason verbatim", () => {
        for (const reason of ADMISSION_REASONS) {
            expect(admissionError(reason).code).toBe(reason);
        }
    });

    it("maps paused to 503 and every other reason to 409", () => {
        expect(admissionError("paused").status).toBe(503);
        for (const reason of ADMISSION_REASONS.filter((r) => r !== "paused")) {
            expect(admissionError(reason).status).toBe(409);
        }
    });

    it("covers every reason admit actually produces", () => {
        const produced = [
            reasonFrom({ paused: true }),
            reasonFrom({ assetRules: [] }, 0n, true),
            reasonFrom({
                assetRules: [
                    {
                        assetId: null,
                        enabled: false,
                        fares: [],
                        claim: "either",
                        maxTopupSats: null,
                    },
                ],
            }),
            reasonFrom({ maxPerPaymentTopupSats: 1n }),
            reasonFrom({ maxOutstandingSats: 1n }),
            reasonFrom({ maxConcurrentAdvances: 0 }),
        ];
        expect(produced).toEqual([
            "paused",
            "asset_not_served",
            "asset_disabled",
            "topup_exceeds_max_per_payment",
            "exceeds_max_outstanding",
            "max_concurrent_advances",
        ]);
        for (const r of produced) {
            expect(ADMISSION_REASONS).toContain(r);
        }
    });

    it("falls back to 409 for a reason it does not recognise", () => {
        const e = admissionError("something_new");
        expect(e.code).toBe("something_new");
        expect(e.status).toBe(409);
    });
});
