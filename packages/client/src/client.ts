import {
    assetIdToWire,
    bytesToHex,
    satsToWire,
    type AssetIdValue,
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
import { decodeInfo, decodeLockup, decodeQuote, decodeStatus } from "./decode.js";
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

    constructor(opts: TaxiClientOptions) {
        this.baseUrl = opts.baseUrl.replace(/\/+$/, "");
        this.fetchImpl = opts.fetch ?? globalThis.fetch;
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
