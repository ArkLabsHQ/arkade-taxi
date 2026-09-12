/** Every failure this package raises. `code` is stable; `message` is prose. */
export class TaxiError extends Error {
    readonly code: string;

    constructor(code: string, message: string, options?: { cause?: unknown }) {
        super(message, options);
        this.name = "TaxiError";
        this.code = code;
    }
}

/** A quote that cannot be trusted. Never thrown for a transport problem, so a
 * caller can tell "the operator is lying" from "the network is down". */
export class QuoteVerificationError extends TaxiError {
    constructor(code: VerificationCode, message: string) {
        super(code, message);
        this.name = "QuoteVerificationError";
    }
}

/** Transport and shape failures, raised by `TaxiClient`. A non-2xx body that
 * parses as an `ErrorResponse` carries the server's own code instead. */
export const ClientErrorCode = {
    Network: "NETWORK_ERROR",
    Http: "HTTP_ERROR",
    InvalidResponse: "INVALID_RESPONSE",
    EventSourceUnavailable: "EVENT_SOURCE_UNAVAILABLE",
} as const;

export const VerificationErrorCode = {
    ProtocolVersion: "PROTOCOL_VERSION_MISMATCH",
    ServerKey: "UNTRUSTED_SERVER_KEY",
    EmulatorKey: "UNTRUSTED_EMULATOR_KEY",
    OperatorKey: "OPERATOR_KEY_MISMATCH",
    ReceiverKey: "RECEIVER_KEY_MISMATCH",
    SenderKey: "SENDER_KEY_MISMATCH",
    AssetId: "ASSET_ID_MISMATCH",
    Dust: "DUST_MISMATCH",
    Topup: "TOPUP_ABOVE_MAX",
    Fee: "FEE_ABOVE_MAX",
    Locktime: "LOCKTIME_BELOW_MIN",
    InvalidParams: "INVALID_COVENANT_PARAMS",
    Address: "COVENANT_ADDRESS_MISMATCH",
    Expired: "QUOTE_EXPIRED",
    Malformed: "MALFORMED_QUOTE",
    MalformedInfo: "MALFORMED_INFO",
} as const;

export type ClientErrorCodeValue = (typeof ClientErrorCode)[keyof typeof ClientErrorCode];
export type VerificationCode = (typeof VerificationErrorCode)[keyof typeof VerificationErrorCode];
