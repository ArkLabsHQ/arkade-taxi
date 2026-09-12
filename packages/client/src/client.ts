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
    decodeStatus,
} from "./decode.js";
import { ClientErrorCode, TaxiError } from "./errors.js";
import { assertSignedLockup, signLockup } from "./lockup.js";
import { activeQuoteStateFor } from "./lockup.js";
import {
    purchase,
    recycle,
    refund,
    verifyCovenantTransfer,
    type CovenantSpendConfig,
    type CovenantTransfer,
    type ReceiverWalletInput,
} from "./spend.js";
import type { Identity } from "@arkade-os/sdk";
import type { VerifiedQuote } from "./verify.js";

export interface TaxiClientOptions {
    baseUrl: string;
    fetch?: typeof fetch;
    eventSourceFactory?: (url: string) => EventSourceLike;
}

type ClaimEventName = "claims-snapshot" | "claims-changed";

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
    assetUnits?: bigint;
    fareId?: string;
    /** Sats the sender contributes toward the dust unit; 0 for a pure-asset
     * payment, where the operator funds the whole thing. */
    senderSats: bigint;
}

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

    constructor(opts: TaxiClientOptions) {
        this.baseUrl = opts.baseUrl.replace(/\/+$/, "");
        this.fetchImpl = opts.fetch ?? globalThis.fetch;
        this.eventSourceFactory =
            opts.eventSourceFactory ??
            (typeof globalThis.EventSource === "undefined"
                ? undefined
                : (url) => new globalThis.EventSource(url) as unknown as EventSourceLike);
    }

    async info(): Promise<InfoResponse> {
        const body = (await this.request("GET", "/v1/info")) as InfoResponse;
        decodeInfo(body);
        return body;
    }

    async requestQuote(req: QuoteRequest): Promise<QuoteResponse> {
        const wire: QuoteRequestBody = {
            receiverKey: bytesToHex(req.receiverKey),
            senderKey: bytesToHex(req.senderKey),
            senderSats: satsToWire(req.senderSats),
            senderInputs: req.senderInputs.map(fundingInputToWire),
        };
        if (req.assetId !== undefined) wire.assetId = assetIdToWire(req.assetId);
        if (req.assetUnits !== undefined) wire.assetUnits = satsToWire(req.assetUnits);
        if (req.fareId !== undefined) wire.fareId = req.fareId;
        const body = (await this.request("POST", "/v1/transfers", wire)) as QuoteResponse;
        decodeQuote(body);
        return body;
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

    async status(transferId: string): Promise<TransferStatusResponse> {
        const path = `/v1/transfers/${encodeURIComponent(transferId)}`;
        return decodeStatus((await this.request("GET", path)) as TransferStatusResponse);
    }

    async listClaims(args: {
        receiverAddresses: readonly string[];
    }): Promise<ClaimsSnapshotResponse> {
        return decodeClaimsSnapshot(
            await this.request("GET", this.claimsPath("/v1/claims", args.receiverAddresses)),
        );
    }

    subscribeClaims(args: SubscribeClaimsArgs): ClaimSubscription {
        if (this.eventSourceFactory === undefined) {
            throw new TaxiError(
                ClientErrorCode.EventSourceUnavailable,
                "taxi: EventSource is not available in this environment",
            );
        }

        let source: EventSourceLike;
        try {
            source = this.eventSourceFactory(
                `${this.baseUrl}${this.claimsPath("/v1/claims/events", args.receiverAddresses)}`,
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

    async refund(transfer: CovenantTransfer, senderIdentity: Identity): Promise<string> {
        return refund(transfer, senderIdentity);
    }

    private claimsPath(path: string, addresses: readonly string[]): string {
        const query = new URLSearchParams();
        for (const address of addresses) query.append("receiver", address);
        return `${path}?${query.toString()}`;
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
