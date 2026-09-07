import type { ErrorResponse } from "@arkade-taxi/protocol";
import type { ContentfulStatusCode } from "hono/utils/http-status";

/** Stable machine-readable codes the client matches on. `ErrorResponse.error`
 * is prose and may change; these may not. */
export const ErrorCode = {
    InvalidRequest: "invalid_request",
    NotFound: "not_found",
    InvalidState: "invalid_state",
    QuoteExpired: "quote_expired",
    LockupFailed: "lockup_failed",
    /** The advance could not be moved out of `locking`, which has no edge to any
     * terminal state. Operator-visible on purpose: it needs reconciling. */
    LockupStranded: "lockup_stranded",
    NoLocktimeHeadroom: "no_locktime_headroom",
    /** A seam that is still waiting on a live arkd and emulator. */
    NotImplemented: "not_implemented",
    Internal: "internal_error",
} as const;

export type ErrorCodeValue = (typeof ErrorCode)[keyof typeof ErrorCode];

export class ServiceError extends Error {
    constructor(
        readonly code: string,
        readonly status: ContentfulStatusCode,
        message: string,
        options?: { cause?: unknown },
    ) {
        super(message, options);
        this.name = "ServiceError";
    }

    static from(e: unknown): ServiceError {
        if (e instanceof ServiceError) return e;
        if (e instanceof Error && e.message.startsWith("protocol: ")) {
            return new ServiceError(ErrorCode.InvalidRequest, 400, e.message, { cause: e });
        }
        return new ServiceError(ErrorCode.Internal, 500, "internal error", { cause: e });
    }
}

export const toErrorResponse = (e: ServiceError): ErrorResponse => ({
    error: e.message,
    code: e.code,
});

/** Every reason `admit` returns. The wire code is the reason verbatim. */
export const ADMISSION_REASONS = [
    "paused",
    "asset_not_allowed",
    "bitcoin_not_allowed",
    "topup_exceeds_max_per_payment",
    "exceeds_max_outstanding",
    "max_concurrent_advances",
    "topup_outside_covenant_range",
] as const;

export type AdmissionReason = (typeof ADMISSION_REASONS)[number];

const ADMISSION_MESSAGE: Record<AdmissionReason, string> = {
    paused: "the operator is not quoting right now",
    asset_not_allowed: "this asset is not on the operator's allowlist",
    bitcoin_not_allowed: "the operator is not quoting sub-dust bitcoin transfers",
    topup_exceeds_max_per_payment: "the required topup exceeds the per-payment limit",
    exceeds_max_outstanding: "the required topup would exceed the operator's outstanding limit",
    max_concurrent_advances: "the operator is at its concurrent advance limit",
    topup_outside_covenant_range: "the required topup is outside the covenant's valid range",
};

const isKnown = (r: string): r is AdmissionReason =>
    (ADMISSION_REASONS as readonly string[]).includes(r);

/**
 * `paused` is the operator choosing not to serve, which is transient — 503, so a
 * client retries. Every other reason is a limit the request itself hit; 409
 * says the same request will keep losing until the operator's state changes.
 * An unrecognised reason is still a policy refusal, so it takes 409 too.
 */
export function admissionError(reason: string): ServiceError {
    const status: ContentfulStatusCode = reason === "paused" ? 503 : 409;
    const message = isKnown(reason) ? ADMISSION_MESSAGE[reason] : `quote refused: ${reason}`;
    return new ServiceError(reason, status, message);
}
