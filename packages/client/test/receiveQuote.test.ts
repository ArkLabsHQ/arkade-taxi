import { ArkAddress, VtxoScript } from "@arkade-os/sdk";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DustCovenantScript } from "@arkade-taxi/covenant";
import {
    PROTOCOL_VERSION,
    assetIdToWire,
    bytesToHex,
    fundingInputToWire,
    quoteParamsToWire,
    type InfoResponse,
    type ReceiveQuoteResponse,
} from "@arkade-taxi/protocol";
import { hex } from "@scure/base";
import { TaxiClient } from "../src/client.js";
import { verifyReceiveQuote } from "../src/receiveQuote.js";
import {
    emulatorKey,
    fundingInputs,
    HRP,
    senderTree,
    jsonResponse,
    operatorKey,
    operatorSignerKey,
    receiverKey,
    recordingFetch,
    senderKey,
    serverKey,
} from "./fixtures.js";

const ASSET = { txid: new Uint8Array(32).fill(0x12), groupIndex: 7 };
const CREATED_AT = 1_000_000_000;
const DEADLINE = BigInt(CREATED_AT) + 8_640_000n;
const receiverAddress = new ArkAddress(serverKey, receiverKey, HRP).encode();
const params = {
    receiverKey,
    senderKey,
    operatorKey,
    operatorSignerKey,
    dust: 330n,
    topup: 330n,
    assetId: ASSET,
    locktime: DEADLINE,
    exitDelay: { value: 86_016n, type: "seconds" as const },
    claimMode: "recycle" as const,
    recoveryRecipient: "receiver" as const,
};
const address = new DustCovenantScript({
    serverKey,
    emulatorKey,
    params,
    vtxoMinAmount: 1n,
})
    .address(HRP, serverKey)
    .encode();
const operatorScript = bytesToHex(new ArkAddress(serverKey, operatorKey, HRP).pkScript);
const quote = (over: Partial<ReceiveQuoteResponse> = {}): ReceiveQuoteResponse => ({
    quoteId: "receive-1",
    state: "quoted",
    receiverAddress,
    makerPublicKey: bytesToHex(senderKey),
    params: quoteParamsToWire(params),
    covenantAddress: address,
    fare: { currency: "sats", units: "3" },
    batchExpiry: { kind: "height", value: "900000" },
    inputExpiryFloor: { kind: "height", value: "850000" },
    recoveryLocktime: { kind: "time", value: DEADLINE.toString() },
    createdAt: CREATED_AT,
    expiresAt: CREATED_AT + 60,
    operatorInputs: fundingInputs().map(fundingInputToWire),
    operatorScript,
    ...over,
});
const info = (): InfoResponse => ({
    protocolVersion: PROTOCOL_VERSION,
    operatorKey: bytesToHex(operatorKey),
    serverKey: bytesToHex(serverKey),
    emulatorKey: bytesToHex(emulatorKey),
    arkdUrl: "https://arkd.example",
    emulatorUrl: "https://emulator.example",
    dust: "330",
    vtxoMinAmount: "1",
    assetRules: [
        {
            assetId: assetIdToWire(ASSET),
            enabled: true,
            claim: "either",
            maxTopupSats: "330",
            unclaimedMode: "reclaim",
            fares: [{ id: "receive", currency: "sats", pricing: { kind: "flat", units: "3" } }],
        },
    ],
    maxPerPaymentTopupSats: "330",
    paused: false,
});
const args = () => ({
    quote: quote(),
    info: info(),
    expect: {
        receiverAddress,
        makerPublicKey: senderKey,
        assetId: ASSET,
        fareId: "receive",
        fundingExpiry: { kind: "height" as const, value: 850_000n },
        maxServiceFareSats: 3n,
        minRecoveryLocktime: { kind: "time" as const, value: BigInt(CREATED_AT) },
        minInputExpiryFloor: { kind: "height" as const, value: 850_000n },
    },
    trustedServerKey: serverKey,
    trustedEmulatorKey: emulatorKey,
    dust: 330n,
    vtxoMinAmount: 1n,
    hrp: HRP,
    now: 1_000_000_001,
});

const receiverParams = { ...params };

const senderPaidArgs = (
    over: { topup?: bigint; advertisedCurrency?: "sameAsset"; requestedReceiver?: boolean } = {},
) => {
    const baseArgs = args();
    return {
        ...baseArgs,
        expect: over.requestedReceiver
            ? { ...baseArgs.expect, payer: "receiver" as const }
            : baseArgs.expect,
        quote:
            over.topup === undefined
                ? baseArgs.quote
                : quote({ params: quoteParamsToWire({ ...params, topup: over.topup }) }),
        info:
            over.advertisedCurrency === undefined
                ? baseArgs.info
                : {
                      ...baseArgs.info,
                      assetRules: [
                          {
                              ...baseArgs.info.assetRules[0]!,
                              fares: [
                                  {
                                      ...baseArgs.info.assetRules[0]!.fares[0]!,
                                      currency: over.advertisedCurrency,
                                  },
                              ],
                          },
                      ],
                  },
    };
};

const receiverPaidArgs = (
    over: {
        fare?: { currency: "sats"; units: string };
        paramsUnits?: bigint;
        advertisedFlatUnits?: bigint;
        advertisedCurrency?: "sameAsset";
        receiverFareCurrency?: "sats" | "asset";
        unrequested?: boolean;
    } = {},
) => {
    const baseArgs = args();
    const currency: "sats" | "asset" = over.receiverFareCurrency ?? "sats";
    const quoteParams = {
        ...receiverParams,
        receiverFare: { currency, units: over.paramsUnits ?? 7n },
    };
    const covenantAddress = new DustCovenantScript({
        serverKey,
        emulatorKey,
        params: quoteParams,
        vtxoMinAmount: 1n,
    })
        .address(HRP, serverKey)
        .encode();
    return {
        ...baseArgs,
        expect: over.unrequested
            ? baseArgs.expect
            : { ...baseArgs.expect, payer: "receiver" as const },
        quote: quote({
            params: quoteParamsToWire(quoteParams),
            covenantAddress,
            fare: over.fare ?? { currency: "sats", units: "0" },
            receiverFare:
                currency === "asset"
                    ? { currency, units: "7", assetId: assetIdToWire(ASSET) }
                    : { currency, units: "7" },
            payer: "receiver",
            unclaimedMode: "reclaim",
        }),
        info: {
            ...baseArgs.info,
            assetRules: [
                {
                    ...baseArgs.info.assetRules[0]!,
                    maxTopupSats: "330",
                    fares: [
                        {
                            ...baseArgs.info.assetRules[0]!.fares[0]!,
                            currency: over.advertisedCurrency ?? ("sats" as const),
                            pricing: {
                                kind: "flat" as const,
                                units: String(over.advertisedFlatUnits ?? 7n),
                            },
                        },
                    ],
                },
            ],
        },
    };
};

describe("verifyReceiveQuote", () => {
    it("verifies a wall-clock deadline past a height-domain funding floor", () => {
        const deadline = BigInt(args().quote.createdAt) + 8_640_000n;
        const deadlineArgs = {
            ...args(),
            quote: quote({
                params: quoteParamsToWire({ ...params, topup: 330n, locktime: deadline }),
                recoveryLocktime: { kind: "time", value: deadline.toString() },
                covenantAddress: new DustCovenantScript({
                    serverKey,
                    emulatorKey,
                    params: { ...params, topup: 330n, locktime: deadline },
                    vtxoMinAmount: 1n,
                })
                    .address(HRP, serverKey)
                    .encode(),
            }),
            expect: {
                ...args().expect,
                minRecoveryLocktime: {
                    kind: "time" as const,
                    value: BigInt(args().quote.createdAt),
                },
            },
        };
        expect(() => verifyReceiveQuote(deadlineArgs)).not.toThrow();
    });

    it("rebuilds the covenant and returns immutable SDK carrier terms", () => {
        const verified = verifyReceiveQuote(args());
        expect(verified.descriptor).toEqual({
            quoteId: "receive-1",
            receiveAddress: address,
            makerPublicKey: bytesToHex(senderKey),
            assetId: "12121212121212121212121212121212121212121212121212121212121212120700",
            physicalSats: 330n,
            loanSats: 330n,
            receiptSats: 0n,
            serviceFareSats: 3n,
            expiresAt: CREATED_AT + 60,
        });
        expect(Object.isFrozen(verified)).toBe(true);
        expect(Object.isFrozen(verified.descriptor)).toBe(true);
    });

    it("rejects a substituted floor even with a self-consistent replacement locktime", () => {
        const changed = { ...params, locktime: DEADLINE + 10_000n };
        const covenantAddress = new DustCovenantScript({
            serverKey,
            emulatorKey,
            params: changed,
            vtxoMinAmount: 1n,
        })
            .address(HRP, serverKey)
            .encode();
        expect(() =>
            verifyReceiveQuote({
                ...args(),
                quote: quote({
                    params: quoteParamsToWire(changed),
                    covenantAddress,
                    inputExpiryFloor: { kind: "height", value: "860000" },
                    recoveryLocktime: { kind: "time", value: (DEADLINE + 10_000n).toString() },
                }),
            }),
        ).toThrow(/floor/);
    });

    it("verifies against the any-asset rule when the asset has no rule of its own", () => {
        const advertised = info();
        advertised.assetRules[0]!.assetId = "*";
        expect(verifyReceiveQuote({ ...args(), info: advertised }).descriptor.loanSats).toBe(330n);
    });

    it("holds the quote to the asset's own rule, not the any-asset one", () => {
        const advertised = info();
        const own = advertised.assetRules[0]!;
        advertised.assetRules = [
            { ...own, assetId: "*" },
            { ...own, enabled: false },
        ];
        expect(() => verifyReceiveQuote({ ...args(), info: advertised })).toThrow(/recycle/);
    });

    it("rejects an unknown pricing kind with plausible proportional fields", () => {
        const changed = info();
        changed.assetRules[0]!.fares[0]!.pricing = {
            kind: "tiered",
            bps: 100,
            minUnits: "3",
            maxUnits: "3",
        } as never;
        expect(() => verifyReceiveQuote({ ...args(), info: changed })).toThrow(/pricing/);
    });

    it.each([
        ["receiverAddress", { receiverAddress: `${receiverAddress}x` }],
        ["maker", { makerPublicKey: "00".repeat(32) }],
        [
            "asset",
            { params: { ...quote().params, assetId: { txid: "13".repeat(32), groupIndex: 7 } } },
        ],
        ["mode", { params: { ...quote().params, claimMode: "purchase" as const } }],
        ["recipient", { params: { ...quote().params, recoveryRecipient: "sender" as const } }],
        ["fare", { fare: { currency: "sats" as const, units: "4" } }],
        ["expiry", { expiresAt: 1_000_000_001 }],
        ["state", { state: "expired" as const }],
    ])("rejects immutable %s substitution", (_name, change) => {
        expect(() => verifyReceiveQuote({ ...args(), quote: quote(change) })).toThrow();
    });

    it("verifies a receiver-paid quote whose topup is the whole dust", () => {
        const verified = verifyReceiveQuote(receiverPaidArgs());
        expect(verified.descriptor.loanSats).toBe(330n);
        expect(verified.descriptor.receiptSats).toBe(0n);
        expect(verified.receiverFare?.units).toBe(7n);
        expect(verified.unclaimedMode).toBe("reclaim");
    });
    it("refuses a sender-paid quote whose loan is not the whole dust", () => {
        expect(() => verifyReceiveQuote(senderPaidArgs({ topup: 329n }))).toThrow(
            /one dust unit|whole-dust loan/,
        );
    });
    it("refuses a receiver-paid quote whose fill fare is not zero", () => {
        expect(() =>
            verifyReceiveQuote(receiverPaidArgs({ fare: { currency: "sats", units: "1" } })),
        ).toThrow(/receiver-paid quote charges the fill/);
    });
    it("refuses a quote whose params.receiverFare differs from its receiverFare field", () => {
        expect(() => verifyReceiveQuote(receiverPaidArgs({ paramsUnits: 8n }))).toThrow(
            /substituted the receiver fare/,
        );
    });
    // The policy comparison: the advertised fare is the RECEIVER's, not the fill's zero.
    it("compares the advertised fare against the receiver fare, not the fill fare", () => {
        expect(() =>
            verifyReceiveQuote(receiverPaidArgs({ advertisedFlatUnits: 7n })),
        ).not.toThrow();
        expect(() => verifyReceiveQuote(receiverPaidArgs({ advertisedFlatUnits: 8n }))).toThrow(
            /differs from advertised policy/,
        );
    });
    it("accepts a same-asset advertised fare on a receiver-paid quote", () => {
        expect(() =>
            verifyReceiveQuote(
                receiverPaidArgs({
                    advertisedCurrency: "sameAsset",
                    receiverFareCurrency: "asset",
                }),
            ),
        ).not.toThrow();
    });
    it("still refuses a same-asset advertised fare on a sender-paid quote", () => {
        expect(() =>
            verifyReceiveQuote(senderPaidArgs({ advertisedCurrency: "sameAsset" })),
        ).toThrow(/not in sats/);
    });
    it("refuses a receiver fare whose currency differs from the advertised policy", () => {
        expect(() =>
            verifyReceiveQuote(receiverPaidArgs({ receiverFareCurrency: "asset" })),
        ).toThrow(/receiver fare currency differs/);
    });
    it("refuses a sender-paid answer to a receiver-paid request", () => {
        expect(() => verifyReceiveQuote(senderPaidArgs({ requestedReceiver: true }))).toThrow(
            /payer is sender, but the request named receiver/,
        );
    });
    it("refuses a receiver-paid answer to an unrequested (sender-paid) request", () => {
        expect(() => verifyReceiveQuote(receiverPaidArgs({ unrequested: true }))).toThrow(
            /payer is receiver, but the request named sender/,
        );
    });
});

const refusal = (verify: () => unknown): unknown => {
    try {
        verify();
    } catch (error) {
        return error;
    }
    throw new Error("expected a refusal");
};

describe("verifyReceiveQuote — exit delay floor", () => {
    it.each([
        ["below the floor", { value: 86_017n, type: "seconds" }],
        ["in the other domain", { value: 144n, type: "blocks" }],
    ] as const)("refuses an exit delay %s", (_name, minExitDelay) => {
        const a = args();
        expect(
            refusal(() => verifyReceiveQuote({ ...a, expect: { ...a.expect, minExitDelay } })),
        ).toMatchObject({ code: "EXIT_DELAY_BELOW_MIN" });
    });

    it.each([
        ["no floor", undefined],
        ["a lower floor", { value: 512n, type: "seconds" }],
        ["an equal floor", { value: 86_016n, type: "seconds" }],
    ] as const)("accepts the quoted exit delay against %s", (_name, minExitDelay) => {
        const a = args();
        const floored = minExitDelay ? { ...a, expect: { ...a.expect, minExitDelay } } : a;
        expect(verifyReceiveQuote(floored).params.exitDelay).toEqual({
            value: 86_016n,
            type: "seconds",
        });
    });
});

describe("TaxiClient receive quotes", () => {
    it("POSTs the exact request and GETs an untrusted quote", async () => {
        const fetch = recordingFetch((_url, init) =>
            jsonResponse(200, init.method === "POST" ? quote() : quote({ state: "expired" })),
        );
        const taxi = new TaxiClient({ baseUrl: "https://taxi.example", fetch });
        await taxi.requestReceiveQuote({
            receiverAddress,
            makerPublicKey: senderKey,
            assetId: ASSET,
            fareId: "receive",
            fundingExpiry: { kind: "height", value: 850_000n },
        });
        expect(JSON.parse(fetch.calls[0]!.init.body as string)).toEqual({
            receiverAddress,
            makerPublicKey: bytesToHex(senderKey),
            assetId: assetIdToWire(ASSET),
            fareId: "receive",
            fundingExpiry: { kind: "height", value: "850000" },
        });
        expect((await taxi.getReceiveQuote("receive-1")).state).toBe("expired");
    });

    it("reads a bound quote's fill id back without treating it as authority", async () => {
        const bound = quote({ state: "bound", boundFillId: "fill-1" });
        const fetch = recordingFetch(() => jsonResponse(200, bound));
        const taxi = new TaxiClient({ baseUrl: "https://taxi.example", fetch });
        expect(await taxi.getReceiveQuote("receive-1")).toEqual(bound);
        expect(() => verifyReceiveQuote({ ...args(), quote: bound })).toThrow(/bound, not usable/);
    });

    it("sends the payer opt-in, and refuses a downgraded sender-paid answer", async () => {
        const fetch = recordingFetch((_url, init) =>
            jsonResponse(200, init.method === "GET" ? info() : quote()),
        );
        const taxi = new TaxiClient({ baseUrl: "https://taxi.example", fetch });
        await expect(
            taxi.requestVerifiedReceiveQuote({
                receiverAddress,
                makerPublicKey: senderKey,
                assetId: ASSET,
                fareId: "receive",
                fundingExpiry: { kind: "height", value: 850_000n },
                payer: "receiver",
                trustedServerKey: serverKey,
                trustedEmulatorKey: emulatorKey,
                dust: 330n,
                vtxoMinAmount: 1n,
                hrp: HRP,
                expect: {
                    maxServiceFareSats: 3n,
                    minRecoveryLocktime: { kind: "time", value: BigInt(CREATED_AT) },
                    minInputExpiryFloor: { kind: "height", value: 850_000n },
                },
            }),
        ).rejects.toThrow(/payer is sender, but the request named receiver/);
        expect(JSON.parse(fetch.calls[1]!.init.body as string)).toMatchObject({
            payer: "receiver",
        });
    });

    describe("against an earlier /v1/info read", () => {
        beforeEach(() => vi.useFakeTimers({ now: 1_000_000_001_000, toFake: ["Date"] }));
        afterEach(() => vi.useRealTimers());

        const ask = () => {
            const { expect: expected, quote: _, info: __, now: ___, ...trust } = args();
            return {
                ...trust,
                receiverAddress,
                makerPublicKey: senderKey,
                assetId: ASSET,
                fareId: "receive",
                fundingExpiry: expected.fundingExpiry,
                expect: {
                    maxServiceFareSats: expected.maxServiceFareSats,
                    minRecoveryLocktime: expected.minRecoveryLocktime,
                    minInputExpiryFloor: expected.minInputExpiryFloor,
                },
            };
        };
        const taxiAdvertising = (advertised: () => InfoResponse) => {
            const fetch = recordingFetch((_url, init) =>
                jsonResponse(200, init.method === "GET" ? advertised() : quote()),
            );
            const methods = () => fetch.calls.map((call) => call.init.method);
            return { taxi: new TaxiClient({ baseUrl: "https://taxi.example", fetch }), methods };
        };
        const withoutAsset = (): InfoResponse => ({ ...info(), assetRules: [] });

        it("reads it once for consecutive receive quotes", async () => {
            const { taxi, methods } = taxiAdvertising(info);
            await taxi.requestVerifiedReceiveQuote(ask());
            await taxi.requestVerifiedReceiveQuote(ask());
            expect(methods()).toEqual(["GET", "POST", "POST"]);
        });

        it("re-reads it once and accepts a quote the operator's new policy allows", async () => {
            let advertised = withoutAsset;
            const { taxi, methods } = taxiAdvertising(() => advertised());
            await taxi.info();
            advertised = info;
            await expect(taxi.requestVerifiedReceiveQuote(ask())).resolves.toBeDefined();
            expect(methods()).toEqual(["GET", "POST", "GET"]);
        });

        it("refuses after that one re-read when the current policy refuses too", async () => {
            const { taxi, methods } = taxiAdvertising(withoutAsset);
            await taxi.info();
            await expect(taxi.requestVerifiedReceiveQuote(ask())).rejects.toThrow(
                /absent from advertised policy/,
            );
            expect(methods()).toEqual(["GET", "POST", "GET"]);
        });
    });

    it("refuses an invalid maker before any HTTP request", async () => {
        const fetch = vi.fn();
        const taxi = new TaxiClient({ baseUrl: "https://taxi.example", fetch });
        await expect(
            taxi.requestVerifiedReceiveQuote({
                receiverAddress,
                makerPublicKey: new Uint8Array(32).fill(0xff),
                assetId: ASSET,
                fareId: "receive",
                fundingExpiry: { kind: "height", value: 850_000n },
                trustedServerKey: serverKey,
                trustedEmulatorKey: emulatorKey,
                dust: 330n,
                vtxoMinAmount: 1n,
                hrp: HRP,
                expect: {
                    maxServiceFareSats: 3n,
                    minRecoveryLocktime: { kind: "time", value: BigInt(CREATED_AT) },
                    minInputExpiryFloor: { kind: "height", value: 850_000n },
                },
            }),
        ).rejects.toThrow();
        expect(fetch).not.toHaveBeenCalled();
    });
});

// An operator on another protocol version may quote a shape this client cannot decode.
const otherVersion = () => {
    const params: Record<string, unknown> = { ...quote().params };
    delete params.operatorSignerKey;
    delete params.exitDelay;
    return {
        info: { ...info(), protocolVersion: PROTOCOL_VERSION + 1 },
        quote: { ...quote(), params } as unknown as ReceiveQuoteResponse,
    };
};

describe("receive quotes from an operator on another protocol version", () => {
    it("refuses with a version mismatch before decoding the quote", () => {
        expect(refusal(() => verifyReceiveQuote({ ...args(), ...otherVersion() }))).toMatchObject({
            code: "PROTOCOL_VERSION_MISMATCH",
        });
    });

    it("refuses with a version mismatch before requesting a quote", async () => {
        const other = otherVersion();
        const fetch = recordingFetch((_url, init) =>
            jsonResponse(200, init.method === "GET" ? other.info : other.quote),
        );
        const taxi = new TaxiClient({ baseUrl: "https://taxi.example", fetch });
        await expect(
            taxi.requestVerifiedReceiveQuote({
                receiverAddress,
                makerPublicKey: senderKey,
                assetId: ASSET,
                fareId: "receive",
                fundingExpiry: { kind: "height", value: 850_000n },
                trustedServerKey: serverKey,
                trustedEmulatorKey: emulatorKey,
                dust: 330n,
                vtxoMinAmount: 1n,
                hrp: HRP,
                expect: {
                    maxServiceFareSats: 3n,
                    minRecoveryLocktime: { kind: "time", value: BigInt(CREATED_AT) },
                    minInputExpiryFloor: { kind: "height", value: 850_000n },
                },
            }),
        ).rejects.toMatchObject({ code: "PROTOCOL_VERSION_MISMATCH" });
        expect(fetch.calls).toHaveLength(1);
    });
});

describe("the funding a receive quote publishes", () => {
    const published = () => fundingInputs().map(fundingInputToWire);

    it("re-derives every published input's own spend leaf from its own tap tree", () => {
        const verified = verifyReceiveQuote(args());
        expect(verified.quote.operatorInputs).toHaveLength(1);
        for (const input of verified.quote.operatorInputs) {
            const tree = VtxoScript.decode(hex.decode(input.tapTree));
            expect(tree.findLeaf(input.spendLeaf)).toBeDefined();
        }
        expect(verified.quote.operatorScript).toBe(operatorScript);
    });

    it("refuses an input whose spend leaf its tap tree does not carry", () => {
        const operatorInputs = published();
        operatorInputs[0]!.spendLeaf = bytesToHex(senderTree.scripts[0]!).replace(/^../, "51");
        expect(() => verifyReceiveQuote({ ...args(), quote: quote({ operatorInputs }) })).toThrow(
            /spend leaf/,
        );
    });

    it("refuses an input that expires before the floor it publishes", () => {
        const operatorInputs = published();
        operatorInputs[0]!.expiry = { kind: "height", value: "849999" };
        expect(() => verifyReceiveQuote({ ...args(), quote: quote({ operatorInputs }) })).toThrow(
            /expiry floor/,
        );
    });

    it("refuses an operator script that is not a taproot output", () => {
        expect(() =>
            verifyReceiveQuote({
                ...args(),
                quote: quote({ operatorScript: "0014" + "11".repeat(20) }),
            }),
        ).toThrow(/taproot/);
    });

    it("refuses a quote that reserves nothing", () => {
        expect(() =>
            verifyReceiveQuote({ ...args(), quote: quote({ operatorInputs: [] }) }),
        ).toThrow(/reserves no/);
    });
});
