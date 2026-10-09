import {
    assetIdToWire,
    bytesToHex,
    satsToWire,
    type AssetIdValue,
    type ClaimsChangedEvent,
    type ClaimsSnapshotResponse,
    type ErrorResponse,
    type InfoResponse,
    type LockupRequestBody,
    type LockupResponse,
    type QuoteRequestBody,
    type QuoteResponse,
    type ReceiveQuoteRequestBody,
    type ReceiveQuoteResponse,
    type ReceiverClaimWire,
    type SponsoredQuoteRequestBody,
    type SponsoredQuoteResponse,
    type TransferStatusResponse,
    type FundingInputValue,
    fundingInputToWire,
} from "@arkade-taxi/protocol";
import {
    decodeClaimsChanged,
    decodeClaimsSnapshot,
    decodeInfo,
    decodeLockup,
    decodeQuote,
    decodeReceiveQuote,
    decodeSponsoredQuote,
    decodeStatus,
    decodeSwapFillQuote,
    decodeSwapFillStatus,
} from "./decode.js";
import { ClientErrorCode, QuoteVerificationError, TaxiError } from "./errors.js";
import { assertSignedLockup, signLockup } from "./lockup.js";
import { activeQuoteStateFor, immutablePlainCopy } from "./lockup.js";
import { fundingInputsFromVtxos } from "./funding.js";
import {
    purchase,
    recycle,
    refund,
    verifyCovenantTransfer,
    verifyIncomingClaimWithFreshStatus,
    type CovenantSpendConfig,
    type CovenantTransfer,
    type IncomingClaimExpectation,
    type IncomingClaimTrust,
    type ReceiverWalletInput,
} from "./spend.js";
import { ArkAddress, type ExtendedVirtualCoin, type Identity } from "@arkade-os/sdk";
import { PubT, validatePubkey } from "@scure/btc-signer/utils.js";
import {
    assertProtocolVersion,
    verifyQuote,
    type QuoteExpectation,
    type VerifiedQuote,
    type VerifyQuoteArgs,
} from "./verify.js";
import {
    assertSignedSponsoredPayment,
    signSponsoredPayment,
    verifySponsoredQuote,
    type SponsoredQuoteExpectation,
    type VerifiedSponsoredQuote,
    type VerifySponsoredQuoteArgs,
} from "./sponsored.js";
import {
    assertSubmittableSwapFill,
    encodeSwapFillQuoteBody,
    SWAP_FILL_AMBIGUOUS_CODE,
    SwapFillSubmitAmbiguousError,
    verifySwapFillQuote,
    type RequestSwapFillQuoteArgs,
    type RequestVerifiedSwapFillQuoteArgs,
    type VerifiedSwapFillQuote,
} from "./swapFill.js";
import type {
    SwapFillGraphWire,
    SwapFillQuoteResponse,
    SwapFillStatusResponse,
} from "@arkade-taxi/protocol";
import {
    verifyReceiveQuote,
    type ReceiveQuoteExpectation,
    type VerifiedReceiveQuote,
    type VerifyReceiveQuoteArgs,
} from "./receiveQuote.js";

export interface TaxiClientOptions {
    baseUrl: string;
    fetch?: typeof fetch;
    eventSourceFactory?: (url: string) => EventSourceLike;
}

type ClaimEventName = "claims-snapshot" | "claims-changed";
const MAX_RECEIVER_BATCH = 64;
const INFO_TTL_MS = 30_000;
const copyInfo = (info: InfoResponse): InfoResponse => JSON.parse(JSON.stringify(info));

export interface EventSourceLike {
    addEventListener(type: ClaimEventName, listener: (event: { data: string }) => void): void;
    addEventListener(type: "error", listener: (event: unknown) => void): void;
    removeEventListener(type: ClaimEventName, listener: (event: { data: string }) => void): void;
    removeEventListener(type: "error", listener: (event: unknown) => void): void;
    close(): void;
}

export type ClaimSubscription = () => void;

export interface SubscribeClaimsArgs {
    receiverAddresses: readonly string[];
    onSnapshot: (snapshot: ClaimsSnapshotResponse) => void;
    onChanged: (event: ClaimsChangedEvent) => void;
    onError: (error: TaxiError) => void;
}

export interface QuoteRequest {
    senderInputs: FundingInputValue[];
    receiverKey: Uint8Array;
    senderKey: Uint8Array;
    assetId?: AssetIdValue;
    /** Which claim leaf to authorise. Omitted lets the operator resolve it. */
    claimMode?: "recycle" | "purchase";
    assetUnits?: bigint;
    fareId?: string;
    /** Exact sum of the selected sender input values. */
    senderSats: bigint;
    /** Exact sats the receiver must end up with, bitcoin only. Omitted leaves
     * the operator deriving the advance from `senderSats`. */
    paymentSats?: bigint;
}

export interface RequestVerifiedQuoteArgs extends Omit<
    VerifyQuoteArgs,
    "quote" | "info" | "senderInputs" | "senderSats" | "expect"
> {
    receiverAddress: string;
    senderKey: Uint8Array;
    selectedVtxos: readonly ExtendedVirtualCoin[];
    assetId?: AssetIdValue;
    fareId?: string;
    /** The leaf to authorise. Sent as the request and bound as the expectation
     * from this one field, so a substituted quote cannot pass the check. */
    claimMode?: "recycle" | "purchase";
    /** The exact amount to send. Sent as the request and bound as the
     * expectation from this one field, for the same reason. */
    paymentSats?: bigint;
    expect: Omit<QuoteExpectation, "receiverKey" | "senderKey" | "assetId" | "paymentSats">;
}

export interface SponsoredQuoteRequest {
    senderInputs: FundingInputValue[];
    receiverAddress: string;
    senderKey: Uint8Array;
    assetId?: AssetIdValue;
    assetUnits?: bigint;
    fareId?: string;
    /** Exact sum of the selected sender input values. */
    senderSats: bigint;
    /** Exact sats the sender contributes to the carrier, bitcoin only. */
    paymentSats?: bigint;
    /** An extra extension packet the payment must carry — an offer's, when
     * funding one. Checked against the quote's echo during verification. */
    extraPacket?: { type: number; payload: Uint8Array };
}

export interface ReceiveQuoteRequest {
    receiverAddress: string;
    makerPublicKey: Uint8Array;
    assetId: AssetIdValue;
    fareId?: string;
    fundingExpiry?: { kind: "height" | "time"; value: bigint };
    /** Opt-in: the receiver pays their own claim fare instead of the sender's. */
    payer?: "receiver";
}

export interface RequestVerifiedReceiveQuoteArgs extends Omit<
    VerifyReceiveQuoteArgs,
    "quote" | "info" | "expect" | "now"
> {
    receiverAddress: string;
    makerPublicKey: Uint8Array;
    assetId: AssetIdValue;
    fareId?: string;
    fundingExpiry?: { kind: "height" | "time"; value: bigint };
    /** Opt-in: the receiver pays their own claim fare instead of the sender's. */
    payer?: "receiver";
    expect: Omit<
        ReceiveQuoteExpectation,
        "receiverAddress" | "makerPublicKey" | "assetId" | "fareId" | "fundingExpiry" | "payer"
    >;
}

export interface RequestVerifiedSponsoredQuoteArgs extends Omit<
    VerifySponsoredQuoteArgs,
    "quote" | "info" | "senderInputs" | "senderSats" | "expect"
> {
    receiverAddress: string;
    senderKey: Uint8Array;
    selectedVtxos: readonly ExtendedVirtualCoin[];
    assetId?: AssetIdValue;
    fareId?: string;
    /** An offer's `extension` funds that offer. Declared once: the expectation
     * below is derived from it, so the request and the check cannot diverge. */
    extraPacket?: { type: number; payload: Uint8Array };
    /** The exact amount to contribute, declared once for the same reason. */
    paymentSats?: bigint;
    expect: Omit<
        SponsoredQuoteExpectation,
        "receiverAddress" | "senderKey" | "assetId" | "extraPacket" | "paymentSats"
    >;
}

// Cheap to repeat: a not_ready refusal is the Taxi's admission check, made before any quote
// work, and a status read is one row.
export const retryDelay = (since: number): number => (Date.now() - since < 2_000 ? 500 : 1_000);

export const requestQuoteWhenReady = async <T>(request: () => Promise<T>): Promise<T> => {
    const start = Date.now();
    const deadline = start + 30_000;
    for (;;) {
        try {
            return await request();
        } catch (cause) {
            if (!(cause instanceof TaxiError && cause.code === "not_ready")) throw cause;
            if (Date.now() >= deadline) throw cause;
            await new Promise<void>((resolve) =>
                setTimeout(
                    resolve,
                    Math.min(retryDelay(start), Math.max(0, deadline - Date.now())),
                ),
            );
            if (Date.now() >= deadline) throw cause;
        }
    }
};
const errorFrom = (status: number, text: string, where: string): TaxiError => {
    try {
        const body = JSON.parse(text) as ErrorResponse;
        if (body !== null && typeof body.code === "string" && typeof body.error === "string") {
            return new TaxiError(body.code, body.error);
        }
    } catch {
        // Not an ErrorResponse; fall through to the transport-level code.
    }
    return new TaxiError(ClientErrorCode.Http, `taxi: ${where} failed with HTTP ${status}`);
};

export class TaxiClient {
    private readonly baseUrl: string;
    private readonly fetchImpl: typeof fetch;
    private readonly eventSourceFactory: ((url: string) => EventSourceLike) | undefined;
    private lastInfo: { at: number; read: Promise<InfoResponse> } | undefined;

    constructor(opts: TaxiClientOptions) {
        this.baseUrl = opts.baseUrl.replace(/\/+$/, "");
        this.fetchImpl = opts.fetch ?? globalThis.fetch;
        this.eventSourceFactory = opts.eventSourceFactory;
    }

    /** A fresh read unless `maxAgeMs` accepts this client's latest one; a failed read is never kept. */
    async info({ maxAgeMs = 0 }: { maxAgeMs?: number } = {}): Promise<InfoResponse> {
        return copyInfo(await this.readInfo(maxAgeMs).read);
    }

    private readInfo(maxAgeMs: number): { read: Promise<InfoResponse>; reused: boolean } {
        const last = this.lastInfo;
        if (last !== undefined && Math.abs(Date.now() - last.at) < maxAgeMs)
            return { read: last.read, reused: true };
        const read = this.request("GET", "/v1/info").then((body) => {
            decodeInfo(body as InfoResponse);
            return body as InfoResponse;
        });
        const entry = { at: Date.now(), read };
        this.lastInfo = entry;
        read.catch(() => {
            if (this.lastInfo === entry) this.lastInfo = undefined;
        });
        return { read, reused: false };
    }

    /** Quotes against a read up to 30 s old. The operator may have changed its policy since, so a
     * refusal of a read made before this call is checked once more against a fresh one. */
    private async quoteAgainstInfo<Q, T>(
        request: () => Promise<Q>,
        verify: (quote: Q, info: InfoResponse) => T,
    ): Promise<T> {
        const { read, reused } = this.readInfo(INFO_TTL_MS);
        let info = copyInfo(await read);
        let earlier = reused;
        const check = async <R>(run: (info: InfoResponse) => R): Promise<R> => {
            try {
                return run(info);
            } catch (error) {
                if (!earlier || !(error instanceof QuoteVerificationError)) throw error;
                earlier = false;
                const fresh = await this.info().catch(() => undefined);
                if (fresh === undefined || JSON.stringify(fresh) === JSON.stringify(info))
                    throw error;
                info = fresh;
                return run(info);
            }
        };
        await check((current) => assertProtocolVersion(current.protocolVersion));
        const quote = await request();
        return check((current) => verify(quote, current));
    }

    async requestQuote(req: QuoteRequest): Promise<QuoteResponse> {
        const wire: QuoteRequestBody = {
            receiverKey: bytesToHex(req.receiverKey),
            senderKey: bytesToHex(req.senderKey),
            senderSats: satsToWire(req.senderSats),
            senderInputs: req.senderInputs.map(fundingInputToWire),
        };
        if (req.assetId !== undefined) wire.assetId = assetIdToWire(req.assetId);
        if (req.claimMode !== undefined) wire.claimMode = req.claimMode;
        if (req.paymentSats !== undefined) wire.paymentSats = satsToWire(req.paymentSats);
        if (req.assetUnits !== undefined) wire.assetUnits = satsToWire(req.assetUnits);
        if (req.fareId !== undefined) wire.fareId = req.fareId;
        const body = (await this.request("POST", "/v1/transfers", wire)) as QuoteResponse;
        decodeQuote(body);
        return body;
    }

    async requestReceiveQuote(req: ReceiveQuoteRequest): Promise<ReceiveQuoteResponse> {
        const wire: ReceiveQuoteRequestBody = {
            receiverAddress: req.receiverAddress,
            makerPublicKey: bytesToHex(req.makerPublicKey),
            assetId: assetIdToWire(req.assetId),
        };
        if (req.fareId !== undefined) wire.fareId = req.fareId;
        if (req.fundingExpiry !== undefined)
            wire.fundingExpiry = {
                kind: req.fundingExpiry.kind,
                value: satsToWire(req.fundingExpiry.value),
            };
        if (req.payer !== undefined) wire.payer = req.payer;
        const body = await this.request("POST", "/v1/receive-quotes", wire);
        decodeReceiveQuote(body);
        return body as ReceiveQuoteResponse;
    }

    async getReceiveQuote(quoteId: string): Promise<ReceiveQuoteResponse> {
        if (!quoteId.length || quoteId.length > 128)
            throw new TaxiError(ClientErrorCode.InvalidResponse, "taxi: invalid receive quote id");
        const body = await this.request("GET", `/v1/receive-quotes/${encodeURIComponent(quoteId)}`);
        decodeReceiveQuote(body);
        return body as ReceiveQuoteResponse;
    }

    async requestVerifiedReceiveQuote(
        raw: RequestVerifiedReceiveQuoteArgs,
    ): Promise<{ verified: VerifiedReceiveQuote }> {
        const request = immutablePlainCopy(raw, "verified receive quote request");
        await preflightReceiveRequest(request);
        return {
            verified: await this.quoteAgainstInfo(
                () => this.requestReceiveQuote(request),
                (quote, info) =>
                    verifyReceiveQuote({
                        quote,
                        info,
                        trustedServerKey: request.trustedServerKey,
                        trustedEmulatorKey: request.trustedEmulatorKey,
                        dust: request.dust,
                        vtxoMinAmount: request.vtxoMinAmount,
                        hrp: request.hrp,
                        now: Math.floor(Date.now() / 1000),
                        expect: {
                            ...request.expect,
                            receiverAddress: request.receiverAddress,
                            makerPublicKey: request.makerPublicKey,
                            assetId: request.assetId,
                            ...(request.fareId === undefined ? {} : { fareId: request.fareId }),
                            ...(request.fundingExpiry === undefined
                                ? {}
                                : { fundingExpiry: request.fundingExpiry }),
                            ...(request.payer === undefined ? {} : { payer: request.payer }),
                        },
                    }),
            ),
        };
    }

    async requestVerifiedQuote(
        args: RequestVerifiedQuoteArgs,
    ): Promise<{ verified: VerifiedQuote; senderInputs: FundingInputValue[] }> {
        const { selectedVtxos, ...options } = args;
        const request = immutablePlainCopy(options, "verified quote request");
        const requestedClaimMode = request.claimMode ?? request.expect.claimMode;
        if (
            request.claimMode !== undefined &&
            request.expect.claimMode !== undefined &&
            request.claimMode !== request.expect.claimMode
        )
            throw new TaxiError(
                ClientErrorCode.InvalidResponse,
                `taxi: claimMode ${request.claimMode} contradicts the expected ${request.expect.claimMode}`,
            );
        const receiver = ArkAddress.decode(request.receiverAddress);
        if (
            receiver.encode() !== request.receiverAddress ||
            receiver.hrp !== request.hrp ||
            bytesToHex(receiver.serverPubKey) !== bytesToHex(request.trustedServerKey)
        )
            throw new Error(
                "taxi: receiver address must be canonical and match the trusted network and server",
            );
        const senderInputs = fundingInputsFromVtxos(selectedVtxos);
        const senderSats = senderInputs.reduce((sum, input) => sum + input.value, 0n);
        const receiverKey = receiver.vtxoTaprootKey;
        const verified = await this.quoteAgainstInfo(
            () =>
                this.requestQuote({
                    ...request,
                    receiverKey,
                    claimMode: requestedClaimMode,
                    senderInputs,
                    senderSats,
                }),
            (quote, info) =>
                verifyQuote({
                    ...request,
                    quote,
                    info,
                    senderInputs,
                    senderSats,
                    expect: {
                        ...request.expect,
                        receiverKey,
                        senderKey: request.senderKey,
                        assetId: request.assetId,
                        claimMode: requestedClaimMode,
                        paymentSats: request.paymentSats,
                    },
                }),
        );
        return { verified, senderInputs };
    }

    /** Takes a `VerifiedQuote` rather than a transfer id: the only way to obtain
     * one is `verifyQuote`, so a lockup cannot be submitted unverified. */
    async submitLockup(verified: VerifiedQuote, signedLockupTx: string): Promise<LockupResponse> {
        const transferId = assertSignedLockup(verified, signedLockupTx);
        const path = `/v1/transfers/${encodeURIComponent(transferId)}/lockup`;
        const wire: LockupRequestBody = { signedLockupTx };
        return decodeLockup((await this.request("POST", path, wire)) as LockupResponse);
    }

    async prepareAndSubmitLockup(
        verified: VerifiedQuote,
        identity: Identity,
    ): Promise<LockupResponse> {
        return this.submitLockup(verified, await signLockup({ verified, identity }));
    }

    async requestSponsoredQuote(req: SponsoredQuoteRequest): Promise<SponsoredQuoteResponse> {
        const wire: SponsoredQuoteRequestBody = {
            receiverAddress: req.receiverAddress,
            senderKey: bytesToHex(req.senderKey),
            senderSats: satsToWire(req.senderSats),
            senderInputs: req.senderInputs.map(fundingInputToWire),
        };
        if (req.assetId !== undefined) wire.assetId = assetIdToWire(req.assetId);
        if (req.paymentSats !== undefined) wire.paymentSats = satsToWire(req.paymentSats);
        if (req.assetUnits !== undefined) wire.assetUnits = satsToWire(req.assetUnits);
        if (req.fareId !== undefined) wire.fareId = req.fareId;
        if (req.extraPacket !== undefined)
            wire.extraPacket = {
                type: req.extraPacket.type,
                payload: bytesToHex(req.extraPacket.payload),
            };
        const body = (await this.request(
            "POST",
            "/v1/sponsored-transfers",
            wire,
        )) as SponsoredQuoteResponse;
        decodeSponsoredQuote(body);
        return body;
    }

    async requestVerifiedSponsoredQuote(
        args: RequestVerifiedSponsoredQuoteArgs,
    ): Promise<{ verified: VerifiedSponsoredQuote; senderInputs: FundingInputValue[] }> {
        const { selectedVtxos, ...options } = args;
        const request = immutablePlainCopy(options, "verified sponsored quote request");
        const receiver = ArkAddress.decode(request.receiverAddress);
        if (
            receiver.encode() !== request.receiverAddress ||
            receiver.hrp !== request.hrp ||
            bytesToHex(receiver.serverPubKey) !== bytesToHex(request.trustedServerKey)
        )
            throw new Error(
                "taxi: receiver address must be canonical and match the trusted network and server",
            );
        const senderInputs = fundingInputsFromVtxos(selectedVtxos);
        const senderSats = senderInputs.reduce((sum, input) => sum + input.value, 0n);
        const verified = await this.quoteAgainstInfo(
            () => this.requestSponsoredQuote({ ...request, senderInputs, senderSats }),
            (quote, info) =>
                verifySponsoredQuote({
                    ...request,
                    quote,
                    info,
                    senderInputs,
                    senderSats,
                    expect: {
                        ...request.expect,
                        receiverAddress: request.receiverAddress,
                        senderKey: request.senderKey,
                        assetId: request.assetId,
                        extraPacket: request.extraPacket,
                        paymentSats: request.paymentSats,
                    },
                }),
        );
        return { verified, senderInputs };
    }

    /** Takes a `VerifiedSponsoredQuote`: only `verifySponsoredQuote` produces
     * one, so an unverified payment cannot be submitted. */
    async submitSponsoredLockup(
        verified: VerifiedSponsoredQuote,
        signedSponsoredTx: string,
    ): Promise<LockupResponse> {
        const transferId = assertSignedSponsoredPayment(verified, signedSponsoredTx);
        const path = `/v1/sponsored-transfers/${encodeURIComponent(transferId)}/lockup`;
        const wire: LockupRequestBody = { signedLockupTx: signedSponsoredTx };
        return decodeLockup((await this.request("POST", path, wire)) as LockupResponse);
    }

    async prepareAndSubmitSponsoredLockup(
        verified: VerifiedSponsoredQuote,
        identity: Identity,
    ): Promise<LockupResponse> {
        return this.submitSponsoredLockup(
            verified,
            await signSponsoredPayment({ verified, identity }),
        );
    }

    async sponsoredStatus(transferId: string): Promise<TransferStatusResponse> {
        const path = `/v1/sponsored-transfers/${encodeURIComponent(transferId)}`;
        return decodeStatus((await this.request("GET", path)) as TransferStatusResponse);
    }

    async requestSwapFillQuote(req: RequestSwapFillQuoteArgs): Promise<SwapFillQuoteResponse> {
        const body = (await this.request(
            "POST",
            "/v1/swap-fills",
            encodeSwapFillQuoteBody(req),
        )) as SwapFillQuoteResponse;
        decodeSwapFillQuote(body);
        return body;
    }

    async requestVerifiedSwapFillQuote(
        args: RequestVerifiedSwapFillQuoteArgs,
    ): Promise<{ verified: VerifiedSwapFillQuote }> {
        const request = immutablePlainCopy(args, "verified swap-fill quote request");
        const { now, ...body } = request;
        const quote = await this.requestSwapFillQuote(body);
        const verified = verifySwapFillQuote({
            quote,
            expect: {
                operationId: body.operationId,
                solverProceedsScript: body.solverProceedsScript,
                solverInputs: body.solverInputs.map(({ txid, vout }) => ({ txid, vout })),
                contributionSats: body.contributionSats,
                maxFare: body.maxFare,
                ...(body.fundingTxid !== undefined ? { fundingTxid: body.fundingTxid } : {}),
                ...(body.fundingVout !== undefined ? { fundingVout: body.fundingVout } : {}),
                ...(body.validUntil !== undefined ? { validUntil: body.validUntil } : {}),
            },
            ...(now !== undefined ? { now } : {}),
        });
        return { verified };
    }

    /** Takes a `VerifiedSwapFillQuote`: only `verifySwapFillQuote` produces
     * one, so an unverified fill cannot be submitted. Makes exactly one
     * attempt and never retries: an ambiguous outcome throws
     * `SwapFillSubmitAmbiguousError`, every earlier failure a plain
     * `TaxiError` carrying the server's code. */
    async submitSwapFill(
        verified: VerifiedSwapFillQuote,
        solverGraph: SwapFillGraphWire,
    ): Promise<SwapFillStatusResponse> {
        const fillId = assertSubmittableSwapFill(verified, solverGraph);
        const path = `/v1/swap-fills/${encodeURIComponent(fillId)}/submit`;
        let body: unknown;
        try {
            body = await this.request("POST", path, { solverGraph });
        } catch (error) {
            if (error instanceof TaxiError && error.code === SWAP_FILL_AMBIGUOUS_CODE)
                throw new SwapFillSubmitAmbiguousError(fillId, error);
            throw error;
        }
        return decodeSwapFillStatus(body);
    }

    async swapFillStatus(fillId: string): Promise<SwapFillStatusResponse> {
        const path = `/v1/swap-fills/${encodeURIComponent(fillId)}`;
        return decodeSwapFillStatus((await this.request("GET", path)) as SwapFillStatusResponse);
    }

    async status(transferId: string): Promise<TransferStatusResponse> {
        const path = `/v1/transfers/${encodeURIComponent(transferId)}`;
        return decodeStatus((await this.request("GET", path)) as TransferStatusResponse);
    }

    async listClaims(args: {
        receiverAddresses: readonly string[];
    }): Promise<ClaimsSnapshotResponse> {
        const receiverAddresses = this.claimReceiverAddresses(args.receiverAddresses);
        return decodeClaimsSnapshot(
            await this.request("GET", this.claimsPath("/v1/claims", receiverAddresses)),
        );
    }

    subscribeClaims(args: SubscribeClaimsArgs): ClaimSubscription {
        const receiverAddresses = this.claimReceiverAddresses(args.receiverAddresses);
        // Looked up per subscription: a shared client can predate an EventSource polyfill.
        const eventSourceFactory =
            this.eventSourceFactory ??
            (typeof globalThis.EventSource === "undefined"
                ? undefined
                : (url: string) => new globalThis.EventSource(url) as unknown as EventSourceLike);
        if (eventSourceFactory === undefined) {
            throw new TaxiError(
                ClientErrorCode.EventSourceUnavailable,
                "taxi: EventSource is not available in this environment",
            );
        }

        let source: EventSourceLike;
        try {
            source = eventSourceFactory(
                `${this.baseUrl}${this.claimsPath("/v1/claims/events", receiverAddresses)}`,
            );
        } catch (cause) {
            throw new TaxiError(
                ClientErrorCode.Network,
                "taxi: claim subscription could not connect",
                {
                    cause,
                },
            );
        }

        const invalidEvent = (cause: unknown): TaxiError =>
            new TaxiError(ClientErrorCode.InvalidResponse, "taxi: claim event is invalid", {
                cause,
            });
        const dispatch = <T>(
            event: { data: string },
            decode: (value: unknown) => T,
            callback: (value: T) => void,
        ) => {
            let value: T;
            try {
                value = decode(JSON.parse(event.data));
            } catch (cause) {
                args.onError(invalidEvent(cause));
                return;
            }
            callback(value);
        };
        const onSnapshot = (event: { data: string }) =>
            dispatch(event, decodeClaimsSnapshot, args.onSnapshot);
        const onChanged = (event: { data: string }) =>
            dispatch(event, decodeClaimsChanged, args.onChanged);
        const onTransportError = (event: unknown) =>
            args.onError(
                new TaxiError(ClientErrorCode.Network, "taxi: claim subscription transport error", {
                    cause: event,
                }),
            );

        source.addEventListener("claims-snapshot", onSnapshot);
        source.addEventListener("claims-changed", onChanged);
        source.addEventListener("error", onTransportError);

        let closed = false;
        return () => {
            if (closed) return;
            closed = true;
            source.removeEventListener("claims-snapshot", onSnapshot);
            source.removeEventListener("claims-changed", onChanged);
            source.removeEventListener("error", onTransportError);
            source.close();
        };
    }

    async verifyTransfer(
        verified: VerifiedQuote,
        lockup: LockupResponse,
        config: CovenantSpendConfig,
    ): Promise<CovenantTransfer> {
        const transferId = activeQuoteStateFor(verified).transferId;
        return verifyCovenantTransfer({
            verified,
            lockup,
            status: await this.status(transferId),
            config,
        });
    }

    async verifyIncomingClaim(
        claim: ReceiverClaimWire,
        expect: IncomingClaimExpectation,
        trusted: IncomingClaimTrust,
        config: CovenantSpendConfig,
    ): Promise<CovenantTransfer> {
        return verifyIncomingClaimWithFreshStatus(
            { claim, expect, trusted, config },
            this.status.bind(this),
        );
    }

    async recycle(
        transfer: CovenantTransfer,
        receiverWalletInput: ReceiverWalletInput,
        destination: Uint8Array,
    ): Promise<string> {
        return recycle(transfer, receiverWalletInput, destination);
    }

    async purchase(transfer: CovenantTransfer, destination: Uint8Array): Promise<string> {
        return purchase(transfer, destination);
    }

    async refund(
        transfer: CovenantTransfer,
        senderIdentity: Identity,
        senderWalletInput: ReceiverWalletInput,
    ): Promise<string> {
        return refund(transfer, senderIdentity, senderWalletInput);
    }

    private claimsPath(path: string, addresses: readonly string[]): string {
        const query = new URLSearchParams();
        for (const address of addresses) query.append("receiver", address);
        return `${path}?${query.toString()}`;
    }

    private claimReceiverAddresses(addresses: readonly string[]): string[] {
        const unique = [...new Set(addresses)];
        if (unique.length === 0 || unique.length > MAX_RECEIVER_BATCH) {
            throw new TaxiError(
                ClientErrorCode.InvalidReceiverBatch,
                `taxi: receiver batch must contain between 1 and ${MAX_RECEIVER_BATCH} unique addresses`,
            );
        }
        return unique;
    }

    private async request(method: string, path: string, body?: unknown): Promise<unknown> {
        const headers: Record<string, string> = { accept: "application/json" };
        if (body !== undefined) headers["content-type"] = "application/json";
        const init: RequestInit = { method, headers };
        if (body !== undefined) init.body = JSON.stringify(body);

        const where = `${method} ${path}`;
        let res: Response;
        let text: string;
        try {
            res = await this.fetchImpl(`${this.baseUrl}${path}`, init);
            text = await res.text();
        } catch (cause) {
            throw new TaxiError(ClientErrorCode.Network, `taxi: ${where} could not be sent`, {
                cause,
            });
        }

        if (!res.ok) throw errorFrom(res.status, text, where);

        try {
            return JSON.parse(text);
        } catch (cause) {
            throw new TaxiError(
                ClientErrorCode.InvalidResponse,
                `taxi: ${where} returned a body that is not JSON`,
                { cause },
            );
        }
    }
}

async function preflightReceiveRequest(request: RequestVerifiedReceiveQuoteArgs): Promise<void> {
    let receiver: ArkAddress;
    try {
        receiver = ArkAddress.decode(request.receiverAddress);
    } catch (cause) {
        throw new TaxiError(ClientErrorCode.InvalidResponse, "taxi: receiver address is invalid", {
            cause,
        });
    }
    if (
        receiver.encode() !== request.receiverAddress ||
        receiver.hrp !== request.hrp ||
        bytesToHex(receiver.serverPubKey) !== bytesToHex(request.trustedServerKey)
    )
        throw new TaxiError(
            ClientErrorCode.InvalidResponse,
            "taxi: receiver address must be canonical and match the trusted network and server",
        );
    if (!(request.makerPublicKey instanceof Uint8Array) || request.makerPublicKey.length !== 32)
        throw new TaxiError(ClientErrorCode.InvalidResponse, "taxi: maker key must be 32 bytes");
    try {
        validatePubkey(request.makerPublicKey, PubT.schnorr);
    } catch (cause) {
        throw new TaxiError(
            ClientErrorCode.InvalidResponse,
            "taxi: maker key is not a curve point",
            {
                cause,
            },
        );
    }
    const deadline = (value: unknown): value is { kind: "height" | "time"; value: bigint } =>
        !!value &&
        typeof value === "object" &&
        ((value as { kind?: unknown }).kind === "height" ||
            (value as { kind?: unknown }).kind === "time") &&
        typeof (value as { value?: unknown }).value === "bigint" &&
        (value as { value: bigint }).value > 0n;
    if (
        !(request.assetId.txid instanceof Uint8Array) ||
        request.assetId.txid.length !== 32 ||
        !Number.isSafeInteger(request.assetId.groupIndex) ||
        request.assetId.groupIndex < 0 ||
        (request.fareId !== undefined &&
            (typeof request.fareId !== "string" ||
                !request.fareId.length ||
                request.fareId.length > 128)) ||
        !(request.trustedServerKey instanceof Uint8Array) ||
        request.trustedServerKey.length !== 32 ||
        !(request.trustedEmulatorKey instanceof Uint8Array) ||
        request.trustedEmulatorKey.length !== 32 ||
        typeof request.hrp !== "string" ||
        !request.hrp.length ||
        typeof request.dust !== "bigint" ||
        typeof request.vtxoMinAmount !== "bigint" ||
        request.dust <= 0n ||
        request.vtxoMinAmount <= 0n ||
        typeof request.expect.maxServiceFareSats !== "bigint" ||
        request.expect.maxServiceFareSats < 0n ||
        !deadline(request.expect.minRecoveryLocktime) ||
        !deadline(request.expect.minInputExpiryFloor) ||
        // Unrelated clocks: the floor follows the funding coins' domain.
        request.expect.minRecoveryLocktime.kind !== "time" ||
        (request.fundingExpiry !== undefined && !deadline(request.fundingExpiry))
    )
        throw new TaxiError(
            ClientErrorCode.InvalidResponse,
            "taxi: receive quote expectations are invalid",
        );
    try {
        validatePubkey(request.trustedServerKey, PubT.schnorr);
        validatePubkey(request.trustedEmulatorKey, PubT.schnorr);
    } catch (cause) {
        throw new TaxiError(
            ClientErrorCode.InvalidResponse,
            "taxi: trusted server or emulator key is not a curve point",
            { cause },
        );
    }
}
