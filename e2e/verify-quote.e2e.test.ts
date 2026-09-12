import { expect } from "vitest";
import { verifyQuote, VerificationErrorCode as Code } from "@arkade-taxi/client";
import type { QuoteResponse } from "@arkade-taxi/protocol";
import { liveScenario } from "./scenarios.js";
import { lock, openLive, quoteFor, sizedSender, terminal } from "./fixtures.js";

liveScenario("verify-quote-rejects-tampered-params", async () => {
    const live = await openLive();
    try {
        const offered = await quoteFor(live, "receiverSats", await sizedSender(live, true), true);
        const mutations: [string, (quote: QuoteResponse) => void, string][] = [
            [
                "receiver",
                (q) => {
                    q.params.receiverKey = live.info.operatorKey;
                },
                Code.ReceiverKey,
            ],
            [
                "sender",
                (q) => {
                    q.params.senderKey = live.info.operatorKey;
                },
                Code.SenderKey,
            ],
            [
                "operator",
                (q) => {
                    q.params.operatorKey = q.params.senderKey;
                },
                Code.OperatorKey,
            ],
            [
                "asset txid",
                (q) => {
                    q.params.assetId!.txid = "ff".repeat(32);
                },
                Code.AssetId,
            ],
            [
                "asset group",
                (q) => {
                    q.params.assetId!.groupIndex += 1;
                },
                Code.AssetId,
            ],
            [
                "dust",
                (q) => {
                    q.params.dust = "331";
                },
                Code.Dust,
            ],
            [
                "topup",
                (q) => {
                    q.params.topup = "2";
                },
                Code.Topup,
            ],
            [
                "locktime",
                (q) => {
                    q.params.locktime = "0";
                },
                Code.Locktime,
            ],
            [
                "address",
                (q) => {
                    q.covenantAddress = live.fixture.sender.address;
                },
                Code.Address,
            ],
            [
                "fare units",
                (q) => {
                    q.fare.units = "2";
                },
                Code.Fee,
            ],
            [
                "fare currency",
                (q) => {
                    q.fare = { currency: "asset", units: "1", assetId: q.params.assetId };
                },
                Code.Fee,
            ],
            [
                "expiry",
                (q) => {
                    q.expiresAt = 1;
                },
                Code.Expired,
            ],
        ];
        for (const [name, mutate, code] of mutations) {
            const quote = structuredClone(offered.quote);
            mutate(quote);
            expect(() => verifyQuote({ ...offered.args, quote }), name).toThrowError(
                expect.objectContaining({ code }),
            );
        }
        for (const field of ["serverKey", "emulatorKey"] as const) {
            expect(() =>
                verifyQuote({
                    ...offered.args,
                    info: { ...live.info, [field]: offered.quote.params.senderKey },
                }),
            ).toThrowError(
                expect.objectContaining({
                    code: field === "serverKey" ? Code.ServerKey : Code.EmulatorKey,
                }),
            );
        }
        for (const mutate of [
            (q: QuoteResponse) => {
                q.unsignedLockupTx = "cHNidP8BAA==";
            },
            (q: QuoteResponse) => {
                q.lockup.covenantOutputIndex += 1;
            },
            (q: QuoteResponse) => {
                q.lockup.unsignedTxId = "aa".repeat(32);
            },
            (q: QuoteResponse) => {
                q.lockup.senderInputIndexes = [];
            },
            (q: QuoteResponse) => {
                q.lockup.operatorInputIndexes = [];
            },
        ]) {
            const quote = structuredClone(offered.quote);
            mutate(quote);
            expect(() => verifyQuote({ ...offered.args, quote })).toThrow();
        }
        expect(verifyQuote(offered.args).quote.transferId).toBe(offered.quote.transferId);
        const locked = await lock(live, offered);
        await terminal(
            live,
            locked,
            "purchased",
            await live.client.purchase(locked.transfer, locked.destination),
        );
    } finally {
        await live.close();
    }
});
