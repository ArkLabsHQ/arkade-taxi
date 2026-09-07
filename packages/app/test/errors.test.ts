import { describe, expect, it } from "vitest";
import { admit, type Policy } from "@arkade-taxi/core";
import {
    ADMISSION_REASONS,
    admissionError,
    ErrorCode,
    ServiceError,
    toErrorResponse,
} from "../src/errors.js";
import { policy as basePolicy, receiverKey, senderKey } from "./fixtures.js";

const EXPOSURE = { outstandingSats: 0n, lockedCount: 0, oldestUnsweptLocktime: null };

const someAsset = { txid: new Uint8Array(32).fill(7), groupIndex: 0 };

const reasonFrom = (over: Partial<Policy>, senderSats = 0n, withAsset = false): string => {
    const d = admit(
        { receiverKey, senderKey, senderSats, ...(withAsset ? { assetId: someAsset } : {}) },
        basePolicy(over),
        EXPOSURE,
        330n,
        10n,
        () => 0n,
    );
    if (d.ok) throw new Error("expected admit to reject");
    return d.reason;
};

describe("ServiceError", () => {
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
            reasonFrom({ assetAllowlist: [] }, 0n, true),
            reasonFrom({ allowBitcoin: false }),
            reasonFrom({ maxPerPaymentTopupSats: 1n }),
            reasonFrom({ maxOutstandingSats: 1n }),
            reasonFrom({ maxConcurrentAdvances: 0 }),
        ];
        expect(produced).toEqual([
            "paused",
            "asset_not_allowed",
            "bitcoin_not_allowed",
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
