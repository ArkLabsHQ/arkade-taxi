/**
 * The arkade-taxi wire protocol. Shared verbatim by client and service so a
 * shape can only change in one place.
 *
 * Byte fields are lowercase hex and amounts are decimal strings, because JSON
 * has no bigint and a sats value silently losing precision at 2^53 is the kind
 * of bug that only shows up on a large payment.
 */

export const PROTOCOL_VERSION = 1;

export {
    assetIdFromWire,
    assetIdToWire,
    bytesToHex,
    hexToBytes,
    quoteParamsFromWire,
    quoteParamsToWire,
    satsFromWire,
    satsToWire,
    fareToWire,
    fareFromWire,
    type AssetIdValue,
    type CovenantParamsValue,
    fundingInputFromWire,
    fundingInputToWire,
    type FundingInputValue,
    covenantSpendInputFromWire,
    covenantSpendInputToWire,
    type CovenantSpendInputValue,
} from "./codec.js";

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
    /** What this operator serves and on what terms, per asset. */
    assetRules: AssetRuleWire[];
    maxPerPaymentTopupSats: string;
    paused: boolean;
}

/** A fare on the wire. `assetId` is present exactly when currency is "asset". */
export interface FareWire {
    currency: "sats" | "asset";
    units: string;
    assetId?: AssetIdWire;
}

/** One fare an operator offers for an asset. `id` is what a client names to accept it. */
export interface FareOfferWire {
    id: string;
    currency: "sats" | "sameAsset" | "token";
    /** Present only for a token fare. */
    assetId?: AssetIdWire;
    pricing:
        | { kind: "flat"; units: string }
        | { kind: "proportional"; bps: number; minUnits: string; maxUnits: string | null };
}

/** What the operator serves for one asset. `assetId` null is sub-dust bitcoin. */
export interface AssetRuleWire {
    assetId: AssetIdWire | null;
    enabled: boolean;
    fares: FareOfferWire[];
    claim: "recycle" | "purchase" | "either";
    maxTopupSats: string | null;
}

export interface QuoteRequestBody {
    senderInputs: FundingInputWire[];
    receiverKey: string;
    senderKey: string;
    assetId?: AssetIdWire;
    senderSats: string;
    /** Units of the asset being moved; a proportional fare prices against it. */
    assetUnits?: string;
    /** Which offered fare the client accepts. Omitted takes the operator's first. */
    fareId?: string;
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
    lockup: LockupCommitment;
    transferId: string;
    params: QuoteParams;
    covenantAddress: string;
    fare: FareWire;
    /**
     * Quote expiry, **unix SECONDS** — not milliseconds.
     *
     * The unit is part of the contract because getting it wrong fails OPEN: a
     * millisecond timestamp compared as seconds is always far-future, so every
     * expired quote would read as valid. A client must reject at or after this
     * instant, never merely past it.
     */
    expiresAt: number;
    /** Base64 JSON envelope containing the joint PSBT and all checkpoint PSBTs. */
    unsignedLockupTx: string;
}

export interface FundingInputWire {
    txid: string;
    vout: number;
    value: string;
    tapTree: string;
    spendLeaf: string;
    /** Canonical SDK asset.Packet holdings: existing groups, no inputs/metadata,
     * one output per group at this input's vout, sorted by asset ID. */
    assetPacket?: string;
    expiry: { kind: "time" | "height"; value: string };
}

export interface CovenantSpendInputWire {
    txid: string;
    vout: number;
    value: string;
    tapTree: string;
    selectedLeaf: string;
    controlBlock: {
        version: number;
        internalKey: string;
        merklePath: string[];
    };
    assetPacket?: string;
}

export interface LockupCommitment {
    covenantOutputIndex: number;
    senderInputIndexes: number[];
    operatorInputIndexes: number[];
    unsignedTxId: string;
}

export interface LockupRequestBody {
    /** Base64 envelope with sender Ark inputs and owned checkpoints signed. */
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
    submissionPhase?: string;
    failureCode?: string;
    failureDetail?: string;
    updatedAt: number;
}

export interface ErrorResponse {
    error: string;
    /** Stable machine-readable code; `error` is prose and may change. */
    code: string;
}
