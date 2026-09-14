export {
    TaxiClient,
    type ClaimSubscription,
    type EventSourceLike,
    type QuoteRequest,
    type RequestVerifiedQuoteArgs,
    type RequestVerifiedSponsoredQuoteArgs,
    type SponsoredQuoteRequest,
    type SubscribeClaimsArgs,
    type TaxiClientOptions,
} from "./client.js";
export { fundingInputsFromVtxos } from "./funding.js";
export {
    ClientErrorCode,
    QuoteVerificationError,
    TaxiError,
    VerificationErrorCode,
    type ClientErrorCodeValue,
    type VerificationCode,
} from "./errors.js";
export {
    verifyQuote,
    type QuoteExpectation,
    type VerifiedQuote,
    type VerifyQuoteArgs,
} from "./verify.js";
export { signLockup, type LockupEnvelope, type SignLockupArgs } from "./lockup.js";
export {
    assertSignedSponsoredPayment,
    signSponsoredPayment,
    validateSponsoredPayment,
    verifySponsoredQuote,
    type ActiveSponsoredCapabilityState,
    type SignSponsoredPaymentArgs,
    type SponsoredQuoteExpectation,
    type SponsoredValidationContext,
    type ValidatedSponsoredPayment,
    type VerifiedSponsoredQuote,
    type VerifySponsoredQuoteArgs,
} from "./sponsored.js";
export {
    purchase,
    recycle,
    refund,
    verifyCovenantTransfer,
    verifyIncomingClaim,
    CovenantSpendAmbiguousError,
    type CovenantSpendConfig,
    type CovenantTransfer,
    type IncomingClaimExpectation,
    type IncomingClaimTrust,
    type ReceiverWalletInput,
    type VerifyCovenantTransferArgs,
    type VerifyIncomingClaimArgs,
} from "./spend.js";
export {
    decodeInfo,
    decodeClaimsChanged,
    decodeClaimsSnapshot,
    decodeLockup,
    decodeQuote,
    decodeSponsoredQuote,
    decodeStatus,
    type DecodedInfo,
    type DecodedQuote,
    type DecodedSponsoredQuote,
} from "./decode.js";
