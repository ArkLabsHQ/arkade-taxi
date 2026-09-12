import { describe, expect, it } from "vitest";
import { bytesToHex } from "@arkade-taxi/protocol";
import type { QuoteRequestBody } from "@arkade-taxi/protocol";
import { TaxiClient } from "../src/client.js";
import { TaxiError } from "../src/errors.js";
import { signLockup } from "../src/lockup.js";
import { verifyQuote } from "../src/verify.js";
import {
    args,
    info,
    jsonResponse,
    quote,
    receiverKey,
    recordingFetch,
    senderIdentity,
    senderKey,
} from "./fixtures.js";

const BASE = "https://taxi.example";

const client = (reply: (url: string, init: RequestInit) => Response | Promise<Response>) => {
    const fetch = recordingFetch(reply);
    return { taxi: new TaxiClient({ baseUrl: BASE, fetch }), fetch };
};

const ok = (body: unknown) => () => jsonResponse(200, body);

describe("info", () => {
    it("GETs /v1/info and returns the wire body", async () => {
        const { taxi, fetch } = client(ok(info()));
        expect(await taxi.info()).toEqual(info());
        expect(fetch.calls[0]?.url).toBe(`${BASE}/v1/info`);
        expect(fetch.calls[0]?.init.method).toBe("GET");
    });

    it("does not double the slash when baseUrl has a trailing one", async () => {
        const fetch = recordingFetch(ok(info()));
        await new TaxiClient({ baseUrl: `${BASE}/`, fetch }).info();
        expect(fetch.calls[0]?.url).toBe(`${BASE}/v1/info`);
    });

    it("throws a TaxiError carrying the server's code on a non-2xx ErrorResponse", async () => {
        const { taxi } = client(() =>
            jsonResponse(503, { error: "operator paused", code: "OPERATOR_PAUSED" }),
        );
        await expect(taxi.info()).rejects.toMatchObject({
            code: "OPERATOR_PAUSED",
            message: "operator paused",
        });
        await expect(taxi.info()).rejects.toBeInstanceOf(TaxiError);
    });

    it("falls back to HTTP_ERROR when a non-2xx body is not an ErrorResponse", async () => {
        const { taxi } = client(() => new Response("<html>502</html>", { status: 502 }));
        await expect(taxi.info()).rejects.toMatchObject({ code: "HTTP_ERROR" });
    });

    it("throws INVALID_RESPONSE when a 2xx body fails the codecs", async () => {
        const { taxi } = client(ok({ ...info(), dust: "-1" }));
        await expect(taxi.info()).rejects.toMatchObject({ code: "INVALID_RESPONSE" });
    });

    it("throws INVALID_RESPONSE when a key decodes to the wrong length", async () => {
        const { taxi } = client(ok({ ...info(), operatorKey: "aabb" }));
        await expect(taxi.info()).rejects.toMatchObject({ code: "INVALID_RESPONSE" });
    });

    it("throws INVALID_RESPONSE on an unparseable 2xx body", async () => {
        const { taxi } = client(() => new Response("not json", { status: 200 }));
        await expect(taxi.info()).rejects.toMatchObject({ code: "INVALID_RESPONSE" });
    });

    it("throws NETWORK_ERROR when fetch itself rejects", async () => {
        const boom = new Error("socket hang up");
        const taxi = new TaxiClient({
            baseUrl: BASE,
            fetch: (() => Promise.reject(boom)) as unknown as typeof fetch,
        });
        await expect(taxi.info()).rejects.toMatchObject({ code: "NETWORK_ERROR", cause: boom });
    });
});

describe("requestQuote", () => {
    it("POSTs the request encoded as wire hex and decimal strings", async () => {
        const { taxi, fetch } = client(ok(quote()));
        expect(
            await taxi.requestQuote({ receiverKey, senderKey, senderSats: 0n, senderInputs: [] }),
        ).toEqual(quote());
        const call = fetch.calls[0]!;
        expect(call.url).toBe(`${BASE}/v1/transfers`);
        expect(call.init.method).toBe("POST");
        expect(JSON.parse(String(call.init.body)) as QuoteRequestBody).toEqual({
            receiverKey: bytesToHex(receiverKey),
            senderKey: bytesToHex(senderKey),
            senderSats: "0",
            senderInputs: [],
        });
    });

    it("encodes an asset id when one is given", async () => {
        const { taxi, fetch } = client(ok(quote()));
        await taxi.requestQuote({
            receiverKey,
            senderKey,
            senderSats: 1n,
            senderInputs: [],
            assetId: { txid: new Uint8Array(32).fill(0x11), groupIndex: 3 },
        });
        expect(JSON.parse(String(fetch.calls[0]!.init.body)).assetId).toEqual({
            txid: "11".repeat(32),
            groupIndex: 3,
        });
    });

    it("encodes an exact large asset quantity and selected fare", async () => {
        const { taxi, fetch } = client(ok(quote()));
        await taxi.requestQuote({
            receiverKey,
            senderKey,
            senderSats: 1n,
            senderInputs: [],
            assetUnits: 9_007_199_254_740_993n,
            fareId: "same-asset",
        });
        expect(JSON.parse(String(fetch.calls[0]!.init.body))).toMatchObject({
            assetUnits: "9007199254740993",
            fareId: "same-asset",
        });
    });

    it("throws INVALID_RESPONSE when the quote fails the codecs", async () => {
        const { taxi } = client(ok({ ...quote(), fare: { currency: "sats", units: "1e3" } }));
        await expect(
            taxi.requestQuote({ receiverKey, senderKey, senderSats: 0n, senderInputs: [] }),
        ).rejects.toMatchObject({ code: "INVALID_RESPONSE" });
    });
});

describe("submitLockup", () => {
    it("takes the transfer id from the verified quote, not from the caller", async () => {
        const verified = verifyQuote(args());
        const signedLockupTx = await signLockup({ verified, identity: senderIdentity });
        const { taxi, fetch } = client(
            ok({ txid: "aa".repeat(32), outpoint: { txid: "aa".repeat(32), vout: 0 } }),
        );
        const res = await taxi.submitLockup(verified, signedLockupTx);
        expect(res.outpoint.vout).toBe(0);
        expect(fetch.calls[0]?.url).toBe(`${BASE}/v1/transfers/tr_01/lockup`);
        expect(JSON.parse(String(fetch.calls[0]!.init.body))).toEqual({
            signedLockupTx,
        });
    });

    it("does not reread a transferId accessor that redirects after validation", async () => {
        const verified = verifyQuote(args());
        const signedLockupTx = await signLockup({ verified, identity: senderIdentity });
        let reads = 0;
        try {
            Object.defineProperty(verified.quote, "transferId", {
                configurable: true,
                enumerable: true,
                get: () => {
                    reads += 1;
                    return reads === 1 ? "tr_01" : "../../redirect";
                },
            });
        } catch {
            // A frozen public view is also an acceptable defense.
        }
        const { taxi, fetch } = client(
            ok({ txid: "aa".repeat(32), outpoint: { txid: "aa".repeat(32), vout: 0 } }),
        );
        await taxi.submitLockup(verified, signedLockupTx);
        expect(fetch.calls[0]?.url).toBe(`${BASE}/v1/transfers/tr_01/lockup`);
        expect(reads).toBe(0);
    });

    it("throws INVALID_RESPONSE when the lockup response is malformed", async () => {
        const verified = verifyQuote(args());
        const signedLockupTx = await signLockup({ verified, identity: senderIdentity });
        const { taxi } = client(ok({ txid: "zz", outpoint: { txid: "aa", vout: 0 } }));
        await expect(taxi.submitLockup(verified, signedLockupTx)).rejects.toMatchObject({
            code: "INVALID_RESPONSE",
        });
    });

    it("rejects an unsigned envelope before sending it", async () => {
        const verified = verifyQuote(args());
        const { taxi, fetch } = client(ok({}));
        await expect(
            taxi.submitLockup(verified, verified.quote.unsignedLockupTx),
        ).rejects.toThrow();
        expect(fetch.calls).toHaveLength(0);
    });

    it("prepares, verifies, and submits through one safe method", async () => {
        const verified = verifyQuote(args());
        const { taxi, fetch } = client(
            ok({ txid: "aa".repeat(32), outpoint: { txid: "aa".repeat(32), vout: 0 } }),
        );
        await expect(taxi.prepareAndSubmitLockup(verified, senderIdentity)).resolves.toMatchObject({
            txid: "aa".repeat(32),
        });
        expect(fetch.calls).toHaveLength(1);
    });

    it("surfaces the Task 5 submission-unavailable response", async () => {
        const verified = verifyQuote(args());
        const { taxi } = client(() =>
            jsonResponse(503, {
                error: "sender signing and validated submission are not configured",
                code: "lockup_submission_unavailable",
            }),
        );
        await expect(taxi.prepareAndSubmitLockup(verified, senderIdentity)).rejects.toMatchObject({
            code: "lockup_submission_unavailable",
        });
    });
});

describe("status", () => {
    it("GETs the transfer and returns its parsed state", async () => {
        const body = { transferId: "tr_01", state: "locked", updatedAt: 1 };
        const { taxi, fetch } = client(ok(body));
        expect(await taxi.status("tr_01")).toEqual(body);
        expect(fetch.calls[0]?.url).toBe(`${BASE}/v1/transfers/tr_01`);
    });

    it("percent-encodes an id that would otherwise change the path", async () => {
        const { taxi, fetch } = client(ok({ transferId: "a/b", state: "quoted", updatedAt: 1 }));
        await taxi.status("a/b");
        expect(fetch.calls[0]?.url).toBe(`${BASE}/v1/transfers/a%2Fb`);
    });

    it("throws INVALID_RESPONSE when state is missing", async () => {
        const { taxi } = client(ok({ transferId: "tr_01", updatedAt: 1 }));
        await expect(taxi.status("tr_01")).rejects.toMatchObject({ code: "INVALID_RESPONSE" });
    });
});
