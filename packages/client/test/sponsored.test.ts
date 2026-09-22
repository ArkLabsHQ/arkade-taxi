import { describe, expect, it } from "vitest";
import { ArkAddress, Transaction, asset, type ExtendedVirtualCoin } from "@arkade-os/sdk";
import { base64 } from "@scure/base";
import { bytesToHex } from "@arkade-taxi/protocol";
import { decodeLockupEnvelope, encodeLockupEnvelope } from "../../app/src/arkade/psbt.js";
import { sponsoredGraphId } from "../../app/src/arkade/sponsoredBuilder.js";
import { TaxiClient } from "../src/client.js";
import { VerificationErrorCode } from "../src/errors.js";
import {
    assertSignedSponsoredPayment,
    signSponsoredPayment,
    verifySponsoredQuote,
} from "../src/sponsored.js";
import {
    HRP,
    jsonResponse,
    otherKey,
    recordingFetch,
    receiverKey,
    satsFareSponsoredArgs,
    senderIdentity,
    senderKey,
    senderTree,
    serverKey,
    sponsoredAddress,
    sponsoredArgs,
    sponsoredAssetArgs,
    sponsoredParams,
    sponsoredQuote,
    withExtraPacket,
} from "./fixtures.js";

const coin = (): ExtendedVirtualCoin => ({
    txid: "aa".repeat(32),
    vout: 2,
    value: 10,
    status: { confirmed: true },
    createdAt: new Date(0),
    script: bytesToHex(senderTree.pkScript),
    isUnrolled: false,
    isSpent: false,
    isSwept: false,
    isPreconfirmed: false,
    virtualStatus: { state: "settled" },
    expiresAtHeight: 900_000,
    tapTree: senderTree.encode(),
    forfeitTapLeafScript: senderTree.leaves[0],
    intentTapLeafScript: senderTree.leaves[0],
});

const BASE = "https://taxi.example";

const client = (reply: (url: string, init: RequestInit) => Response | Promise<Response>) => {
    const fetch = recordingFetch(reply);
    return { taxi: new TaxiClient({ baseUrl: BASE, fetch }), fetch };
};

const ok = (body: unknown) => () => jsonResponse(200, body);

describe("verifySponsoredQuote", () => {
    it("accepts a 200 USDT payment with a 1 USDT fare", () => {
        const verified = verifySponsoredQuote(sponsoredAssetArgs());
        expect(verified.params.contribution).toBe(330n);
        expect(verified.receiverAddress).toBe(sponsoredAddress());
        expect(verified.senderInputIndexes).toEqual([0]);
    });

    // Funding an offer means the payment must carry the offer's packet beside the
    // asset groups. The sender declares it; the rebuild is what enforces it.
    it("accepts a payment carrying the packet the sender declared", () => {
        // Asset-sender only, and that is a protocol limit rather than a choice:
        // both OP_RETURN slots the SDK allows are already spent, so the offer
        // packet can only ride inside the asset extension that already exists.
        const offerPacket = { type: 0x03, payload: new Uint8Array([1, 2, 3]) };
        const args = withExtraPacket(offerPacket);
        const verified = verifySponsoredQuote({
            ...args,
            expect: { ...args.expect, extraPacket: offerPacket },
        });
        expect(verified.params.extraPacket).toEqual(offerPacket);
    });

    // The dangerous case: operator echoes AND builds the same wrong packet, so
    // the rebuild is self-consistent. Only the sender's own expectation catches
    // it — otherwise it funds someone else's offer.
    it("rejects a consistently-swapped packet the sender never asked for", () => {
        const mine = { type: 0x03, payload: new Uint8Array([1, 2, 3]) };
        const theirs = { type: 0x03, payload: new Uint8Array([9, 9, 9]) };
        const built = withExtraPacket(theirs);
        expect(() =>
            verifySponsoredQuote({ ...built, expect: { ...built.expect, extraPacket: mine } }),
        ).toThrow(expect.objectContaining({ code: VerificationErrorCode.Malformed }));
    });

    it("rejects a payment carrying a packet when the sender declared none", () => {
        const built = withExtraPacket({ type: 0x03, payload: new Uint8Array([1, 2, 3]) });
        expect(() => verifySponsoredQuote(built)).toThrow(
            expect.objectContaining({ code: VerificationErrorCode.Malformed }),
        );
    });

    it("rejects a transaction carrying a packet the sender did not declare", () => {
        const declared = { type: 0x03, payload: new Uint8Array([1, 2, 3]) };
        const substituted = { type: 0x03, payload: new Uint8Array([9, 9, 9]) };
        // Operator builds with `substituted` but echoes the sender's `declared`.
        const built = withExtraPacket(substituted);
        const lying = {
            ...built.quote,
            params: {
                ...built.quote.params,
                extraPacket: { type: declared.type, payload: bytesToHex(declared.payload) },
            },
        };
        expect(() => verifySponsoredQuote({ ...built, quote: lying })).toThrow();
    });

    it("rejects a payment address the caller did not authorize", () => {
        const args = sponsoredArgs();
        const attacker = new ArkAddress(serverKey, otherKey, HRP).encode();
        expect(() =>
            verifySponsoredQuote({
                ...args,
                quote: { ...args.quote, receiverAddress: attacker },
            }),
        ).toThrow(expect.objectContaining({ code: VerificationErrorCode.ReceiverKey }));
    });

    it("rejects a contribution above the authorized maximum", () => {
        const args = sponsoredArgs();
        expect(() =>
            verifySponsoredQuote({
                ...args,
                expect: { ...args.expect, maxContributionSats: 9n },
            }),
        ).toThrow(expect.objectContaining({ code: VerificationErrorCode.Topup }));
    });

    it("rejects a fare above the authorized maximum", () => {
        const args = sponsoredAssetArgs();
        expect(() =>
            verifySponsoredQuote({
                ...args,
                expect: {
                    ...args.expect,
                    maxFare: { currency: "asset", assetId: args.expect.assetId, units: 1n },
                },
            }),
        ).toThrow(expect.objectContaining({ code: VerificationErrorCode.Fee }));
    });

    it("rejects an operator key the client does not trust", () => {
        const args = sponsoredArgs();
        expect(() => verifySponsoredQuote({ ...args, trustedServerKey: otherKey })).toThrow(
            expect.objectContaining({ code: VerificationErrorCode.ServerKey }),
        );
    });

    it("rejects a tampered payment commitment", () => {
        const args = sponsoredArgs();
        expect(() =>
            verifySponsoredQuote({
                ...args,
                quote: {
                    ...args.quote,
                    commitment: { ...args.quote.commitment, paymentOutputIndex: 1 },
                },
            }),
        ).toThrow();
    });
});

describe("signSponsoredPayment", () => {
    it("signs only sender inputs and round-trips assertion", async () => {
        const verified = verifySponsoredQuote(sponsoredAssetArgs());
        const encoded = await signSponsoredPayment({ verified, identity: senderIdentity });
        expect(assertSignedSponsoredPayment(verified, encoded)).toBe("tr_01");
    });

    it("refuses to submit an unsigned envelope", async () => {
        const verified = verifySponsoredQuote(sponsoredArgs());
        const { taxi, fetch } = client(ok({}));
        await expect(
            taxi.submitSponsoredLockup(verified, verified.quote.unsignedSponsoredTx),
        ).rejects.toThrow();
        expect(fetch.calls).toHaveLength(0);
    });
});

describe("TaxiClient sponsored transfers", () => {
    // Funding an offer means sending the offer's own extension as the packet.
    it("sends the declared packet on the sponsored quote request", async () => {
        const offerExtension = { type: 0x03, payload: new Uint8Array([0xab, 0xcd]) };
        const { taxi, fetch } = client(() => jsonResponse(200, sponsoredQuote()));
        await taxi.requestSponsoredQuote({
            receiverAddress: sponsoredAddress(),
            senderKey,
            senderSats: 1_000n,
            senderInputs: sponsoredArgs().senderInputs,
            extraPacket: offerExtension,
        });
        const sent = JSON.parse(String(fetch.calls.at(-1)?.init.body));
        expect(sent.extraPacket).toEqual({ type: 0x03, payload: "abcd" });
    });

    it("requests, signs and submits through the sponsored endpoints", async () => {
        const quote = sponsoredQuote();
        const { taxi, fetch } = client((url) => {
            if (url === `${BASE}/v1/info`) return jsonResponse(200, sponsoredArgs().info);
            if (url === `${BASE}/v1/sponsored-transfers`) return jsonResponse(200, quote);
            return jsonResponse(200, {
                txid: "aa".repeat(32),
                outpoint: { txid: "aa".repeat(32), vout: 0 },
            });
        });
        const { verified } = await taxi.requestVerifiedSponsoredQuote({
            receiverAddress: sponsoredAddress(),
            senderKey,
            selectedVtxos: [coin()],
            trustedServerKey: serverKey,
            vtxoMinAmount: 10n,
            hrp: HRP,
            trustedServerUnrollScript: sponsoredArgs().trustedServerUnrollScript,
            now: 1_000_000_000,
            expect: { maxContributionSats: 330n, maxFare: { currency: "sats", units: 10n } },
        });
        expect(verified.receiverAddress).toBe(sponsoredAddress());
        expect(fetch.calls.map((call) => call.url)).toEqual([
            `${BASE}/v1/info`,
            `${BASE}/v1/sponsored-transfers`,
        ]);
        const res = await taxi.prepareAndSubmitSponsoredLockup(verified, senderIdentity);
        expect(res.outpoint.vout).toBe(0);
        expect(fetch.calls.at(-1)?.url).toBe(`${BASE}/v1/sponsored-transfers/tr_01/lockup`);
    });

    it("reports sponsored transfer status", async () => {
        const { taxi, fetch } = client(ok({ transferId: "tr_01", state: "locked", updatedAt: 1 }));
        const status = await taxi.sponsoredStatus("tr_01");
        expect(status.state).toBe("locked");
        expect(fetch.calls[0]?.url).toBe(`${BASE}/v1/sponsored-transfers/tr_01`);
    });

    it("accepts the receiver key the address commits to", () => {
        expect(ArkAddress.decode(sponsoredAddress()).vtxoTaprootKey).toEqual(receiverKey);
    });
});

describe("sponsored sender-paid sats fare", () => {
    const rewrite = (
        encoded: string,
        mutate: (wire: ReturnType<typeof decodeLockupEnvelope>) => void,
        recomputeHash = false,
    ): string => {
        const wire = decodeLockupEnvelope(encoded);
        mutate(wire);
        if (recomputeHash)
            wire.unsignedTxId = sponsoredGraphId(
                Transaction.fromPSBT(base64.decode(wire.arkTx)),
                wire.checkpoints.map((c) => Transaction.fromPSBT(base64.decode(c))),
            );
        return encodeLockupEnvelope(wire);
    };

    const amounts = (encoded: string): bigint[] => {
        const tx = Transaction.fromPSBT(base64.decode(decodeLockupEnvelope(encoded).arkTx));
        return [0, 1, 2, 3].map((index) => tx.getOutput(index).amount!);
    };

    it("accepts the layout that bills the fare to the sender", () => {
        const a = satsFareSponsoredArgs();
        const verified = verifySponsoredQuote(a);
        expect(verified.envelope.satsFarePayer).toBe("sender");
        expect(amounts(a.quote.unsignedSponsoredTx)).toEqual([330n, 10n, 690n, 19_670n]);
        expect(amounts(satsFareSponsoredArgs({ legacy: true }).quote.unsignedSponsoredTx)).toEqual([
            330n,
            10n,
            700n,
            19_660n,
        ]);
    });

    it("accepts a funded legacy sponsored graph unchanged", () => {
        const a = satsFareSponsoredArgs({ legacy: true });
        expect(verifySponsoredQuote(a).envelope.satsFarePayer).toBeUndefined();
    });

    it("keeps the discriminator across signing", async () => {
        const verified = verifySponsoredQuote(satsFareSponsoredArgs());
        const encoded = await signSponsoredPayment({ verified, identity: senderIdentity });
        expect(decodeLockupEnvelope(encoded).satsFarePayer).toBe("sender");
    });

    it("refuses a sender-paid claim stapled onto a legacy layout", () => {
        const a = satsFareSponsoredArgs({ legacy: true });
        a.quote.unsignedSponsoredTx = rewrite(
            a.quote.unsignedSponsoredTx,
            (wire) => {
                wire.satsFarePayer = "sender";
            },
            true,
        );
        a.quote.commitment.unsignedTxId = decodeLockupEnvelope(
            a.quote.unsignedSponsoredTx,
        ).unsignedTxId;
        expect(() => verifySponsoredQuote(a)).toThrow(/Arkade transaction/);
    });

    it("refuses an unrecognised fare payer", () => {
        const a = satsFareSponsoredArgs();
        a.quote.unsignedSponsoredTx = rewrite(a.quote.unsignedSponsoredTx, (wire) => {
            (wire as { satsFarePayer?: string }).satsFarePayer = "operator";
        });
        expect(() => verifySponsoredQuote(a)).toThrow(/satsFarePayer/);
    });

    it("refuses a fare payer named against an asset fare", () => {
        const a = sponsoredAssetArgs();
        a.quote.unsignedSponsoredTx = rewrite(a.quote.unsignedSponsoredTx, (wire) => {
            wire.satsFarePayer = "sender";
        });
        expect(() => verifySponsoredQuote(a)).toThrow(/positive sats fare/);
    });
});
