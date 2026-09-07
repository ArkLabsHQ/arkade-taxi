/**
 * The arkade-taxi wire protocol. Shared verbatim by client and service so a
 * shape can only change in one place.
 *
 * Byte fields are lowercase hex and amounts are decimal strings, because JSON
 * has no bigint and a sats value silently losing precision at 2^53 is the kind
 * of bug that only shows up on a large payment.
 */

export const PROTOCOL_VERSION = 1;

export interface AssetIdWire {
    /** Genesis txid, internal byte order — NOT reversed display hex. */
    txid: string;
    groupIndex: number;
}

export interface InfoResponse {
    protocolVersion: number;
    /** Payout destination for every covenant repayment. Never a signer. */
    operatorKey: string;
    /** Arkade Service key, present in every leaf. The client MUST check this
     * against the arkd it already trusts; otherwise an operator could name a
     * service it controls and the address check would be self-consistent and
     * worthless. */
    serverKey: string;
    /** Emulator key the covenant leaves are tweaked from. Same warning. */
    emulatorKey: string;
    arkdUrl: string;
    emulatorUrl: string;
    dust: string;
    vtxoMinAmount: string;
    /** null means every asset is accepted. */
    assetAllowlist: AssetIdWire[] | null;
    feeFlatSats: string;
    feeBps: number;
    maxPerPaymentTopupSats: string;
    paused: boolean;
}

export interface QuoteRequestBody {
    receiverKey: string;
    senderKey: string;
    assetId?: AssetIdWire;
    senderSats: string;
}

/** Everything needed to re-derive the covenant address independently. The
 * client MUST do that rather than trust `covenantAddress`. */
export interface QuoteParams {
    receiverKey: string;
    senderKey: string;
    operatorKey: string;
    dust: string;
    topup: string;
    assetId?: AssetIdWire;
    locktime: string;
}

export interface QuoteResponse {
    transferId: string;
    params: QuoteParams;
    covenantAddress: string;
    feeSats: string;
    expiresAt: number;
    /** Base64 PSBT with the operator's topup input already contributed. */
    unsignedLockupTx: string;
}

export interface LockupRequestBody {
    /** Base64 PSBT with the sender's inputs signed. */
    signedLockupTx: string;
}

export interface LockupResponse {
    txid: string;
    outpoint: { txid: string; vout: number };
}

export interface TransferStatusResponse {
    transferId: string;
    state: string;
    outpoint?: { txid: string; vout: number };
    spentTxid?: string;
    updatedAt: number;
}

export interface ErrorResponse {
    error: string;
    /** Stable machine-readable code; `error` is prose and may change. */
    code: string;
}
