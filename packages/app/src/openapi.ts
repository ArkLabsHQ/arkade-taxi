import { readFileSync } from "node:fs";
import { PROTOCOL_VERSION } from "@arkade-taxi/protocol";

type JsonType = "object" | "array" | "string" | "integer" | "number" | "boolean" | "null";

export interface Schema {
    $ref?: string;
    type?: JsonType | JsonType[];
    title?: string;
    description?: string;
    properties?: Record<string, Schema>;
    required?: string[];
    additionalProperties?: false;
    items?: Schema;
    minItems?: number;
    maxItems?: number;
    enum?: (string | number)[];
    const?: string | number;
    oneOf?: Schema[];
    pattern?: string;
    minLength?: number;
    maxLength?: number;
    minimum?: number;
    maximum?: number;
    contentEncoding?: string;
}

interface MediaType {
    schema: Schema;
    example?: unknown;
}

interface ResponseSpec {
    description: string;
    content?: Record<string, MediaType>;
}

interface Parameter {
    name: string;
    in: "path" | "query";
    required: true;
    description: string;
    schema: Schema;
}

interface Operation {
    tags: string[];
    summary: string;
    description?: string;
    parameters?: Parameter[];
    requestBody?: { required: true; content: Record<string, MediaType> };
    responses: Record<number, ResponseSpec>;
}

// Read at load: importing ../package.json would put it outside tsc's rootDir.
const { version } = JSON.parse(
    readFileSync(new URL("../package.json", import.meta.url), "utf8"),
) as { version: string };

const ref = (name: string): Schema => ({ $ref: `#/components/schemas/${name}` });

const object = (required: Record<string, Schema>, optional: Record<string, Schema> = {}) => ({
    type: "object" as const,
    properties: { ...required, ...optional },
    required: Object.keys(required),
    additionalProperties: false as const,
});

const nullable = (schema: Schema): Schema =>
    schema.$ref
        ? { oneOf: [schema, { type: "null" }] }
        : { ...schema, type: [schema.type as JsonType, "null"] };

const str: Schema = { type: "string" };
const text: Schema = { type: "string", minLength: 1 };
const bool: Schema = { type: "boolean" };
const count: Schema = { type: "integer", minimum: 0 };
const strings: Schema = { type: "array", items: str };
const indexes: Schema = { type: "array", items: count };
const vout: Schema = { type: "integer", minimum: 0, maximum: 4294967295 };
const unixSeconds: Schema = { type: "integer", minimum: 0, description: "Unix seconds." };
const decimal: Schema = {
    type: "string",
    pattern: "^[0-9]+$",
    description: "Non-negative decimal string: JSON has no bigint.",
};
const positiveDecimal: Schema = {
    ...decimal,
    pattern: "^[1-9][0-9]*$",
    description: "Positive decimal string: JSON has no bigint.",
};
const hex: Schema = { type: "string", pattern: "^([0-9a-f]{2})+$", description: "Lowercase hex." };
const key32: Schema = {
    type: "string",
    pattern: "^[0-9a-f]{64}$",
    description: "32-byte x-only public key, lowercase hex.",
};
const txid: Schema = {
    type: "string",
    pattern: "^[0-9a-f]{64}$",
    description: "Transaction id, lowercase hex.",
};
const base64: Schema = { type: "string", contentEncoding: "base64" };
const oneOfStrings = (...values: string[]): Schema => ({ type: "string", enum: values });
const constant = (value: string): Schema => ({ type: "string", const: value });
const expiresAt: Schema = {
    ...unixSeconds,
    description: "Quote expiry in unix seconds, not milliseconds. Reject at or after it.",
};
const senderInputs: Schema = {
    type: "array",
    items: ref("FundingInput"),
    minItems: 1,
    maxItems: 256,
    description: "Distinct outpoints whose values sum to `senderSats`.",
};
const fareId: Schema = {
    ...text,
    description: "Offered fare to accept. Omitted takes the operator's first.",
};
const assetUnits: Schema = {
    ...decimal,
    description: "Units of the asset moved; a proportional fare prices against it.",
};
const paymentSats: Schema = {
    ...decimal,
    description:
        "Exact sats the receiver must end up with, bitcoin only, locked beside a " +
        "whole-dust advance. Must be within [vtxoMinAmount, dust) and covered by " +
        "senderSats. Omitted sends all of senderSats, which must then be below dust. " +
        "Verify topup == dust and params.paymentSats == paymentSats.",
};

const schemas: Record<string, Schema> = {
    Error: {
        description:
            "Body of every non-2xx JSON response. `code` is stable and machine-readable; `error` is prose and may change.",
        ...object({ error: str, code: str }),
    },
    AssetId: object({
        txid: {
            ...txid,
            description: "Genesis txid in internal byte order, not reversed display hex.",
        },
        groupIndex: count,
    }),
    Fare: {
        description: "A resolved fare. `assetId` is present exactly when `currency` is `asset`.",
        oneOf: [
            { title: "sats", ...object({ currency: constant("sats"), units: decimal }) },
            {
                title: "asset",
                ...object({ currency: constant("asset"), units: decimal, assetId: ref("AssetId") }),
            },
        ],
    },
    FareOffer: object(
        {
            id: { ...str, description: "What a client names in `fareId` to accept this fare." },
            currency: oneOfStrings("sats", "sameAsset", "token"),
            pricing: {
                oneOf: [
                    { title: "flat", ...object({ kind: constant("flat"), units: decimal }) },
                    {
                        title: "proportional",
                        ...object({
                            kind: constant("proportional"),
                            bps: count,
                            minUnits: decimal,
                            maxUnits: nullable(decimal),
                        }),
                    },
                ],
            },
        },
        { assetId: { ...ref("AssetId"), description: "Present only for a token fare." } },
    ),
    AssetRule: {
        description: "What the operator serves for one asset, and on what terms.",
        ...object({
            assetId: {
                oneOf: [ref("AssetId"), { type: "null" }, constant("*")],
                description:
                    'null is sub-dust bitcoin. "*" is any asset without a rule of its own, never bitcoin; an asset\'s own rule always wins over it.',
            },
            enabled: bool,
            fares: { type: "array", items: ref("FareOffer") },
            claim: oneOfStrings("recycle", "purchase", "either"),
            maxTopupSats: nullable(decimal),
            unclaimedMode: constant("reclaim"),
        }),
    },
    InfoResponse: object({
        protocolVersion: { type: "integer", const: PROTOCOL_VERSION },
        operatorKey: {
            ...key32,
            description: "Payout destination for every covenant repayment; never a signer.",
        },
        serverKey: {
            ...key32,
            description:
                "Arkade Service key present in every leaf but the emergency exit. Check it against the arkd you already trust.",
        },
        emulatorKey: {
            ...key32,
            description:
                "Emulator key the covenant leaves are tweaked from. Check it the same way.",
        },
        arkdUrl: str,
        emulatorUrl: str,
        dust: decimal,
        vtxoMinAmount: decimal,
        assetRules: { type: "array", items: ref("AssetRule") },
        maxPerPaymentTopupSats: decimal,
        paused: bool,
    }),
    FundingInput: {
        description: "A sender VTXO funding the transfer.",
        ...object(
            {
                txid,
                vout,
                value: decimal,
                tapTree: hex,
                spendLeaf: hex,
                expiry: {
                    description: "The VTXO's batch expiry.",
                    ...object({ kind: oneOfStrings("time", "height"), value: decimal }),
                },
            },
            {
                assetPacket: {
                    ...hex,
                    description: "Canonical asset packet of the holdings at this input.",
                },
            },
        ),
    },
    QuoteRequest: object(
        { senderInputs, receiverKey: key32, senderKey: key32, senderSats: decimal },
        {
            assetId: ref("AssetId"),
            claimMode: {
                ...oneOfStrings("recycle", "purchase"),
                description:
                    "Claim leaf the sender authorises. Omitted resolves against the operator's rule for the asset.",
            },
            assetUnits,
            fareId,
            paymentSats,
        },
    ),
    QuoteParams: {
        description:
            "Everything needed to re-derive the covenant address. Re-derive it rather than trust `covenantAddress`.",
        ...object(
            {
                receiverKey: key32,
                senderKey: key32,
                operatorKey: key32,
                operatorSignerKey: {
                    ...key32,
                    description:
                        "The Taxi's bare signing key, the second signer on the exit leaf. Not `operatorKey`, which only receives payouts.",
                },
                dust: decimal,
                topup: decimal,
                locktime: {
                    ...decimal,
                    description:
                        "The reclaim leaf's CLTV: a wall-clock Unix-seconds deadline measured from the quote. It deliberately outlives the funding coins' batch expiry, so a renewal cannot push the Taxi's own claim out.",
                },
                exitDelay: {
                    description:
                        "CSV on the exit leaf; a value below 512 is blocks, otherwise seconds.",
                    ...object({ value: positiveDecimal, type: oneOfStrings("blocks", "seconds") }),
                },
            },
            {
                assetId: ref("AssetId"),
                paymentSats: {
                    ...decimal,
                    description:
                        "Sats locked beside a whole-dust bitcoin advance; absent on a dust-unit covenant.",
                },
                recoveryRecipient: oneOfStrings("sender", "receiver"),
                claimMode: {
                    ...oneOfStrings("recycle", "purchase"),
                    description: "Absent enables both claim leaves.",
                },
                receiverFare: {
                    description:
                        "Present only on a receiver-paid recycle leaf; the fared asset is `assetId`.",
                    ...object({ currency: oneOfStrings("sats", "asset"), units: decimal }),
                },
            },
        ),
    },
    LockupCommitment: object({
        covenantOutputIndex: count,
        senderInputIndexes: indexes,
        operatorInputIndexes: indexes,
        unsignedTxId: txid,
    }),
    QuoteResponse: object({
        transferId: text,
        params: ref("QuoteParams"),
        covenantAddress: str,
        fare: ref("Fare"),
        expiresAt,
        unsignedLockupTx: {
            ...base64,
            description: "Base64 JSON envelope holding the joint PSBT and every checkpoint PSBT.",
        },
        lockup: ref("LockupCommitment"),
    }),
    LockupRequest: object({
        signedLockupTx: {
            ...text,
            description:
                "The quote's base64 envelope with the sender's inputs and checkpoints signed.",
        },
    }),
    Outpoint: object({ txid, vout }),
    LockupResponse: object({
        txid: { ...txid, description: "Lockup transaction id; equals `outpoint.txid`." },
        outpoint: ref("Outpoint"),
    }),
    TransferStatus: object(
        {
            transferId: text,
            state: {
                ...text,
                description:
                    "quoted, locking, locked, recovering, recycled, purchased, refunded, recovered or expired.",
            },
            updatedAt: unixSeconds,
        },
        {
            outpoint: ref("Outpoint"),
            spentTxid: txid,
            submissionPhase: text,
            failureCode: text,
            failureDetail: { ...text, description: "Redacted prose; may change." },
        },
    ),
    TaggedLocktime: object({ kind: oneOfStrings("height", "time"), value: decimal }),
    ReceiveQuoteRequest: object(
        {
            receiverAddress: {
                type: "string",
                maxLength: 512,
                description: "Canonical Arkade address on this server's network and server key.",
            },
            senderKey: key32,
            assetId: ref("AssetId"),
        },
        {
            fareId: { ...fareId, maxLength: 128 },
            fundingExpiry: {
                ...ref("TaggedLocktime"),
                description:
                    "Expiry floor of the funding; must share the operator's expiry domain.",
            },
            payer: {
                ...oneOfStrings("sender", "receiver"),
                description: "`receiver` opts in to paying the claim fare. Default `sender`.",
            },
        },
    ),
    ReceiveQuote: {
        description:
            "`payer`, `receiverFare` and `unclaimedMode` appear together, only when the request set `payer: receiver`.",
        ...object(
            {
                quoteId: { ...text, maxLength: 128 },
                state: oneOfStrings("quoted", "bound", "expired"),
                receiverAddress: str,
                senderKey: key32,
                params: ref("QuoteParams"),
                covenantAddress: str,
                fare: ref("Fare"),
                batchExpiry: ref("TaggedLocktime"),
                inputExpiryFloor: ref("TaggedLocktime"),
                recoveryLocktime: ref("TaggedLocktime"),
                createdAt: unixSeconds,
                expiresAt,
                operatorInputs: {
                    type: "array",
                    items: ref("FundingInput"),
                    minItems: 1,
                    maxItems: 256,
                    description:
                        "The Taxi coins this quote reserved. A builder spends exactly these and no other Taxi coin.",
                },
                operatorScript: {
                    ...hex,
                    description:
                        "The one scriptPubKey every Taxi output must pay: its change and any sats fare.",
                },
            },
            {
                boundFillId: {
                    ...text,
                    maxLength: 128,
                    description: "The fill this quote is bound to; present only while `bound`.",
                },
                payer: constant("receiver"),
                receiverFare: ref("Fare"),
                unclaimedMode: constant("reclaim"),
            },
        ),
    },
    FillRequest: {
        description:
            "A complete graph the caller built. Every input outpoint is read off the checkpoints, so none is declared.",
        ...object(
            {
                operationId: { ...text, maxLength: 128 },
                quoteId: { ...text, maxLength: 128 },
                arkTx: {
                    ...text,
                    maxLength: 4000000,
                    description: "base64 PSBT. Every non-Taxi input signed; the Taxi's unsigned.",
                },
                checkpoints: {
                    type: "array",
                    items: { ...text, maxLength: 4000000 },
                    minItems: 1,
                    maxItems: 256,
                    description: "base64 PSBTs, one per arkTx input, index-aligned.",
                },
                taxiInputIndexes: {
                    type: "array",
                    items: { type: "integer", minimum: 0 },
                    minItems: 1,
                    maxItems: 256,
                    description: "Which arkTx inputs are the Taxi's reserved coins.",
                },
                covenantOutputIndex: {
                    type: "integer",
                    minimum: 0,
                    description: "Where the quoted covenant output sits. Any index.",
                },
                assetUnits: {
                    ...decimal,
                    description: "Units the covenant output must carry.",
                },
            },
            { validUntil: unixSeconds },
        ),
    },
    FillStatus: {
        description: "Carries no PSBT bytes: the caller never holds a Taxi-signed graph.",
        ...object(
            {
                fillId: { ...text, maxLength: 128 },
                operationId: { ...text, maxLength: 128 },
                state: oneOfStrings("submitting", "settled", "expired", "cancelled"),
                updatedAt: unixSeconds,
                expiresAt,
            },
            {
                txid,
                outpoint: ref("Outpoint"),
                spentTxid: txid,
                failureCode: text,
            },
        ),
    },
    ExtraPacket: {
        description:
            "Extension packet the payment must carry, e.g. an offer's packet when funding it. Echoed in `params`.",
        ...object({ type: { type: "integer", minimum: 0, maximum: 255 }, payload: hex }),
    },
    SponsoredQuoteRequest: object(
        {
            senderInputs,
            receiverAddress: {
                ...str,
                description:
                    "The receiver's canonical Arkade address; the payment pays it directly.",
            },
            senderKey: key32,
            senderSats: decimal,
        },
        {
            assetId: ref("AssetId"),
            assetUnits,
            fareId,
            extraPacket: ref("ExtraPacket"),
            paymentSats: {
                ...paymentSats,
                description:
                    "Exact sats the receiver gets beside the carrier, bitcoin only. Same " +
                    "range and verification as on QuoteRequest, against contribution == dust.",
            },
        },
    ),
    SponsoredParams: object(
        {
            receiverKey: key32,
            senderKey: key32,
            operatorKey: key32,
            dust: decimal,
            contribution: {
                ...decimal,
                description: "The whole dust unit the operator gives the receiver.",
            },
        },
        {
            paymentSats: { ...decimal, description: "Sats the sender pays beside the carrier." },
            assetId: ref("AssetId"),
            extraPacket: ref("ExtraPacket"),
        },
    ),
    SponsoredCommitment: object({
        paymentOutputIndex: count,
        senderInputIndexes: indexes,
        operatorInputIndexes: indexes,
        unsignedTxId: txid,
    }),
    SponsoredQuoteResponse: object({
        transferId: text,
        params: ref("SponsoredParams"),
        receiverAddress: str,
        fare: ref("Fare"),
        expiresAt,
        unsignedSponsoredTx: {
            ...base64,
            description: "Base64 envelope shaped like a lockup envelope.",
        },
        commitment: ref("SponsoredCommitment"),
    }),
    ClaimDescriptor: {
        description: "Everything a receiver needs to verify and claim a locked covenant.",
        ...object(
            {
                params: ref("QuoteParams"),
                covenantAddress: str,
                outpoint: ref("Outpoint"),
                fare: ref("Fare"),
                batchExpiry: ref("TaggedLocktime"),
                recoveryLocktime: ref("TaggedLocktime"),
            },
            { assetUnits: decimal, unclaimedMode: constant("reclaim") },
        ),
    },
    ReceiverClaim: {
        description:
            "`claim` is present, and `claimable` true, exactly when `state` is `locked`. `spentTxid` and `failureCode` appear only on terminal states.",
        ...object(
            {
                transferId: text,
                receiverAddress: str,
                state: oneOfStrings(
                    "locking",
                    "locked",
                    "recovering",
                    "recycled",
                    "purchased",
                    "refunded",
                    "recovered",
                    "expired",
                ),
                claimable: bool,
                updatedAt: unixSeconds,
            },
            { claim: ref("ClaimDescriptor"), spentTxid: txid, failureCode: text },
        ),
    },
    ClaimsSnapshot: object({ claims: { type: "array", items: ref("ReceiverClaim") } }),
    RecoveryDeadline: object({
        advanceId: str,
        kind: oneOfStrings("height", "time"),
        locktime: decimal,
        // Null on a covenant advance, which stores no funding expiry: its clock
        // is the deadline itself.
        batchExpiry: nullable(decimal),
        remaining: nullable(decimal),
        severity: oneOfStrings("eligible", "warning", "critical", "expired"),
        code: str,
    }),
    HealthResponse: object(
        {
            status: oneOfStrings("ok", "degraded"),
            paused: bool,
            now: unixSeconds,
            blockers: strings,
            sweeper: object({
                lastTickAt: nullable(unixSeconds),
                lastTickHeight: nullable(decimal),
                lastTickMedianTime: nullable(decimal),
                recoverySubmittedTotal: count,
                failedTotal: count,
                lastError: nullable(str),
                lastRecoveryError: nullable(
                    object({ advanceId: str, code: str, at: unixSeconds, message: str }),
                ),
                lockedCount: count,
                recoveringCount: count,
                lastSuccessfulObservationAt: nullable(unixSeconds),
                lastSuccessfulRecoveryAt: nullable(unixSeconds),
                nearestDeadline: object({
                    height: nullable(ref("RecoveryDeadline")),
                    time: nullable(ref("RecoveryDeadline")),
                }),
                oldestUnsweptLocktime: object({
                    height: nullable(decimal),
                    time: nullable(decimal),
                }),
                blockers: { type: "array", items: ref("RecoveryDeadline") },
            }),
            reconciler: object(
                {
                    lastTickAt: nullable(unixSeconds),
                    locking: count,
                    blockers: strings,
                    lastWatcherScanAt: nullable(unixSeconds),
                    watching: count,
                    /** The live subset of `watching` the per-tick scan classifies. */
                    activelyScanned: count,
                },
                {
                    fills: object({
                        lastTickAt: nullable(unixSeconds),
                        submitting: count,
                        blockers: strings,
                    }),
                },
            ),
        },
        {
            proceeds: object({
                running: bool,
                jobId: nullable(str),
                state: str,
                blocker: nullable(str),
                maxFeeSats: decimal,
                authorizedFeeSats: nullable(decimal),
                commitmentTxid: nullable(str),
            }),
            startup: object({ phase: str, complete: bool, blocker: nullable(str) }),
            runtime: object(
                {
                    checkedAt: { ...count, description: "Unix milliseconds of the last check." },
                    chainHeight: nullable(decimal),
                    chainTime: nullable(decimal),
                    walletSynced: bool,
                    providerIdentityOk: bool,
                    blockers: strings,
                },
                {
                    provider: object({
                        network: nullable(str),
                        identityOk: bool,
                        serverPubkey: str,
                        emulatorPubkey: str,
                    }),
                    inventory: object({
                        usableSats: decimal,
                        reservedSats: decimal,
                        usableVtxos: count,
                        reservedVtxos: count,
                    }),
                },
            ),
            reason: { ...str, description: "Why the service is not ready; only when degraded." },
        },
    ),
};

// Real responses captured from the route test harness.
const examples = {
    info: {
        protocolVersion: 1,
        operatorKey: "531fe6068134503d2723133227c867ac8fa6c83c537e9a44c3c5bdbdcb1fe337",
        serverKey: "462779ad4aad39514614751a71085f2f10e1c7a593e4e030efb5b8721ce55b0b",
        emulatorKey: "62c0a046dacce86ddd0343c6d3c7c79c2208ba0d9c9cf24a6d046d21d21f90f7",
        arkdUrl: "https://arkd.example",
        emulatorUrl: "https://emulator.example",
        dust: "330",
        vtxoMinAmount: "10",
        assetRules: [
            {
                assetId: null,
                enabled: true,
                fares: [
                    {
                        id: "sats",
                        currency: "sats",
                        pricing: {
                            kind: "flat",
                            units: "0",
                        },
                    },
                ],
                claim: "either",
                maxTopupSats: null,
                unclaimedMode: "reclaim",
            },
            {
                assetId: "*",
                enabled: true,
                fares: [
                    {
                        id: "asset",
                        currency: "sameAsset",
                        pricing: { kind: "proportional", bps: 50, minUnits: "1", maxUnits: null },
                    },
                ],
                claim: "recycle",
                maxTopupSats: null,
                unclaimedMode: "reclaim",
            },
        ],
        maxPerPaymentTopupSats: "1000",
        paused: false,
    },
    quote: {
        transferId: "adv-1",
        params: {
            receiverKey: "1b84c5567b126440995d3ed5aaba0565d71e1834604819ff9c17f5e9d5dd078f",
            senderKey: "4d4b6cd1361032ca9bd2aeb9d900aa4d45d9ead80ac9423374c451a7254d0766",
            operatorKey: "531fe6068134503d2723133227c867ac8fa6c83c537e9a44c3c5bdbdcb1fe337",
            operatorSignerKey: "989c0b76cb563971fdc9bef31ec06c3560f3249d6ee9e5d83c57625596e05f6f",
            dust: "330",
            topup: "330",
            locktime: "1765640000",
            exitDelay: { value: "86016", type: "seconds" },
            claimMode: "recycle",
        },
        covenantAddress:
            "ark1qprzw7ddf2knj52xz3635uggtuh3pcw85kf7fcpsa76msusuu4dsk6p54ak3xqlrjxe7l2nxjmzffdhdqhr269jx6yl63gj3p2q6ja9fufwg30",
        fare: {
            currency: "sats",
            units: "0",
        },
        expiresAt: 1757000060,
        unsignedLockupTx:
            "eyJhcmtUeCI6ImNITmlkUDhCQUw4REFBQUFBaTZHUTBiTmVTNjdnZlpEcmxZV2E5M1lkeG1PSGdZdDh1ZXNBRkFqd1hPYUFBQUFBQUQvLy8vL1hqdkdCcEVoazlBUytsM0hnYlFkRGlCVmpOTUdFcG9LV0ErTDBERGFtSG9BQUFBQUFQLy8vLzhEU2dFQUFBQUFBQUFpVVNCb05LOXRFd1Bqa2JQdnFtYVd4SlMyN1FYR3JSWkcwVCtvb2xFS2dhbDBxZFpNQUFBQUFBQUFJbEVnbUpXRWpDT0ZYOHdBaVJsZlcrcGtTdlpIZnMzTmxSdEZMa1NLcGFUcGg3Y0FBQUFBQUFBQUFBUlJBazV6QUFBQUFBQUJBU3NBQUFBQUFBQUFBQ0pSSUptUnl0ZnJra2lURHl2QkRDamhob2VDbzNnMENDV2owRExsZTNiVXd6dUZRaFhBVUpLYmRNR2dTVlMzaTB0Z05lbDZYZ2VLV2c4bzdKYlZSNy91bXM2QU9zRC9BRjd4eERmb00rQ0NyQ1RjbXBvc3hkc3BacG1DLzN4eXFhaTNZRmI2dVVVZ1JpZDVyVXF0T1ZGR0ZIVWFjUWhmTHhEaHg2V1Q1T0F3NzdXNGNoemxXd3V0SUUxTGJORTJFRExLbTlLdXVka0FxazFGMmVyWUNzbENNM1RFVWFjbFRRZG1yTUFJM25SaGNIUnlaV1Z4QWNBbkFwQUFzblVnUmlkNXJVcXRPVkZHRkhVYWNRaGZMeERoeDZXVDVPQXc3N1c0Y2h6bFd3dXNBY0JFSUVZbmVhMUtyVGxSUmhSMUduRUlYeThRNGNlbGsrVGdNTysxdUhJYzVWc0xyU0JOUzJ6Uk5oQXl5cHZTcnJuWkFLcE5SZG5xMkFySlFqTjB4RkduSlUwSFpxd0FBUUVySUU0QUFBQUFBQUFpVVNEalBOZHBUTDlsSzdHNlNybUtDN3NaZC83UVNBSnZqSDgwcjROTmwrNU9xVUlWd1ZDU20zVEJvRWxVdDR0TFlEWHBlbDRIaWxvUEtPeVcxVWUvN3ByT2dEckEvd0JlOGNRMzZEUGdncXdrM0pxYUxNWGJLV2FaZ3Y5OGNxbW90MkJXK3JsRklFWW5lYTFLclRsUlJoUjFHbkVJWHk4UTRjZWxrK1RnTU8rMXVISWM1VnNMclNCVEgrWUdnVFJRUFNjakV6SW55R2VzajZiSVBGTitta1REeGIyOXl4L2pONnpBQ041MFlYQjBjbVZsY1FIQUp3S1FBTEoxSUVZbmVhMUtyVGxSUmhSMUduRUlYeThRNGNlbGsrVGdNTysxdUhJYzVWc0xyQUhBUkNCR0ozbXRTcTA1VVVZVWRScHhDRjh2RU9ISHBaUGs0RER2dGJoeUhPVmJDNjBnVXgvbUJvRTBVRDBuSXhNeUo4aG5ySStteUR4VGZwcEV3OFc5dmNzZjR6ZXNBQUFBQUE9PSIsImNoZWNrcG9pbnRzIjpbImNITmlkUDhCQUdzREFBQUFBYXVycTZ1cnE2dXJxNnVycTZ1cnE2dXJxNnVycTZ1cnE2dXJxNnVycTZ1ckFBQUFBQUQvLy8vL0FnQUFBQUFBQUFBQUlsRWdtWkhLMSt1U1NKTVBLOEVNS09HR2g0S2plRFFJSmFQUU11VjdkdFRETzRVQUFBQUFBQUFBQUFSUkFrNXpBQUFBQUFBQkFTc0FBQUFBQUFBQUFDSlJJUEh3RXhRNkk3QzJ3M0p4TVJ4WVNRUVU2LzI5eTVsUTBLVnUvRzhqRGJISEloWEFVSktiZE1HZ1NWUzNpMHRnTmVsNlhnZUtXZzhvN0piVlI3L3VtczZBT3NCRklFWW5lYTFLclRsUlJoUjFHbkVJWHk4UTRjZWxrK1RnTU8rMXVISWM1VnNMclNCTlMyelJOaEF5eXB2U3JyblpBS3BOUmRucTJBckpRak4weEZHbkpVMEhacXpBQ041MFlYQjBjbVZsUndIQVJDQkdKM210U3EwNVVVWVVkUnB4Q0Y4dkVPSEhwWlBrNEREdnRiaHlIT1ZiQzYwZ1RVdHMwVFlRTXNxYjBxNjUyUUNxVFVYWjZ0Z0t5VUl6ZE1SUnB5Vk5CMmFzQUFBQSIsImNITmlkUDhCQUdzREFBQUFBYnU3dTd1N3U3dTd1N3U3dTd1N3U3dTd1N3U3dTd1N3U3dTd1N3U3dTd1N0FBQUFBQUQvLy8vL0FpQk9BQUFBQUFBQUlsRWc0enpYYVV5L1pTdXh1a3E1aWd1N0dYZiswRWdDYjR4L05LK0RUWmZ1VHFrQUFBQUFBQUFBQUFSUkFrNXpBQUFBQUFBQkFTc2dUZ0FBQUFBQUFDSlJJSmlWaEl3amhWL01BSWtaWDF2cVpFcjJSMzdOelpVYlJTNUVpcVdrNlllM0loWEJVSktiZE1HZ1NWUzNpMHRnTmVsNlhnZUtXZzhvN0piVlI3L3VtczZBT3NCRklFWW5lYTFLclRsUlJoUjFHbkVJWHk4UTRjZWxrK1RnTU8rMXVISWM1VnNMclNCVEgrWUdnVFJRUFNjakV6SW55R2VzajZiSVBGTitta1REeGIyOXl4L2pONnpBQ041MFlYQjBjbVZsUndIQVJDQkdKM210U3EwNVVVWVVkUnB4Q0Y4dkVPSEhwWlBrNEREdnRiaHlIT1ZiQzYwZ1V4L21Cb0UwVUQwbkl4TXlKOGhuckkrbXlEeFRmcHBFdzhXOXZjc2Y0emVzQUFBQSJdLCJjb3ZlbmFudE91dHB1dEluZGV4IjowLCJvcGVyYXRvcklucHV0SW5kZXhlcyI6WzFdLCJvcGVyYXRvcklucHV0cyI6W3siZXhwaXJ5Ijp7ImtpbmQiOiJoZWlnaHQiLCJ2YWx1ZSI6IjkwMDAwMCJ9LCJzcGVuZExlYWYiOiIyMDQ2Mjc3OWFkNGFhZDM5NTE0NjE0NzUxYTcxMDg1ZjJmMTBlMWM3YTU5M2U0ZTAzMGVmYjViODcyMWNlNTViMGJhZDIwNTMxZmU2MDY4MTM0NTAzZDI3MjMxMzMyMjdjODY3YWM4ZmE2YzgzYzUzN2U5YTQ0YzNjNWJkYmRjYjFmZTMzN2FjIiwidGFwVHJlZSI6IjAxYzA0NDIwNDYyNzc5YWQ0YWFkMzk1MTQ2MTQ3NTFhNzEwODVmMmYxMGUxYzdhNTkzZTRlMDMwZWZiNWI4NzIxY2U1NWIwYmFkMjA1MzFmZTYwNjgxMzQ1MDNkMjcyMzEzMzIyN2M4NjdhYzhmYTZjODNjNTM3ZTlhNDRjM2M1YmRiZGNiMWZlMzM3YWMiLCJ0eGlkIjoiYmJiYmJiYmJiYmJiYmJiYmJiYmJiYmJiYmJiYmJiYmJiYmJiYmJiYmJiYmJiYmJiYmJiYmJiYmJiYmJiYmJiYiIsInZhbHVlIjoiMjAwMDAiLCJ2b3V0IjowfV0sInNlbmRlcklucHV0SW5kZXhlcyI6WzBdLCJzZW5kZXJJbnB1dHMiOlt7ImV4cGlyeSI6eyJraW5kIjoiaGVpZ2h0IiwidmFsdWUiOiI5MTAwMDAifSwic3BlbmRMZWFmIjoiMjA0NjI3NzlhZDRhYWQzOTUxNDYxNDc1MWE3MTA4NWYyZjEwZTFjN2E1OTNlNGUwMzBlZmI1Yjg3MjFjZTU1YjBiYWQyMDRkNGI2Y2QxMzYxMDMyY2E5YmQyYWViOWQ5MDBhYTRkNDVkOWVhZDgwYWM5NDIzMzc0YzQ1MWE3MjU0ZDA3NjZhYyIsInRhcFRyZWUiOiIwMWMwNDQyMDQ2Mjc3OWFkNGFhZDM5NTE0NjE0NzUxYTcxMDg1ZjJmMTBlMWM3YTU5M2U0ZTAzMGVmYjViODcyMWNlNTViMGJhZDIwNGQ0YjZjZDEzNjEwMzJjYTliZDJhZWI5ZDkwMGFhNGQ0NWQ5ZWFkODBhYzk0MjMzNzRjNDUxYTcyNTRkMDc2NmFjIiwidHhpZCI6ImFiYWJhYmFiYWJhYmFiYWJhYmFiYWJhYmFiYWJhYmFiYWJhYmFiYWJhYmFiYWJhYmFiYWJhYmFiYWJhYmFiYWIiLCJ2YWx1ZSI6IjAiLCJ2b3V0IjowfV0sInNlcnZlclVucm9sbFNjcmlwdCI6IjAyOTAwMGIyNzUyMDQ2Mjc3OWFkNGFhZDM5NTE0NjE0NzUxYTcxMDg1ZjJmMTBlMWM3YTU5M2U0ZTAzMGVmYjViODcyMWNlNTViMGJhYyIsInVuc2lnbmVkVHhJZCI6ImU5NDc1Mjg4NjUyNmZkMmI2MzUzY2VjNmMzNzkwMjU5N2Q5NjYzMmIyNzVjZGM0ODk4Y2JmNTg1ZTI0Yzk5NDMifQ==",
        lockup: {
            covenantOutputIndex: 0,
            senderInputIndexes: [0],
            operatorInputIndexes: [1],
            unsignedTxId: "e94752886526fd2b6353cec6c37902597d96632b275cdc4898cbf585e24c9943",
        },
    },
    lockupAccepted: {
        txid: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        outpoint: {
            txid: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            vout: 1,
        },
    },
    lockupLocked: {
        txid: "cdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcd",
        outpoint: {
            txid: "cdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcd",
            vout: 0,
        },
    },
    transferStatus: {
        transferId: "adv-1",
        state: "locking",
        updatedAt: 1757000000,
        outpoint: {
            txid: "cdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcd",
            vout: 0,
        },
        submissionPhase: "claimed",
    },
    receiveQuote: {
        quoteId: "adv-1",
        state: "quoted",
        receiverAddress:
            "ark1qprzw7ddf2knj52xz3635uggtuh3pcw85kf7fcpsa76msusuu4dskxuyc4t8kynygzv460k442aq2ewhrcvrgczgr8lec9l4a82a6pu0ezudfg",
        senderKey: "4d4b6cd1361032ca9bd2aeb9d900aa4d45d9ead80ac9423374c451a7254d0766",
        params: {
            receiverKey: "1b84c5567b126440995d3ed5aaba0565d71e1834604819ff9c17f5e9d5dd078f",
            senderKey: "4d4b6cd1361032ca9bd2aeb9d900aa4d45d9ead80ac9423374c451a7254d0766",
            operatorKey: "531fe6068134503d2723133227c867ac8fa6c83c537e9a44c3c5bdbdcb1fe337",
            operatorSignerKey: "989c0b76cb563971fdc9bef31ec06c3560f3249d6ee9e5d83c57625596e05f6f",
            dust: "330",
            topup: "320",
            locktime: "1765640000",
            exitDelay: { value: "86016", type: "seconds" },
            assetId: {
                txid: "bebebebebebebebebebebebebebebebebebebebebebebebebebebebebebebebe",
                groupIndex: 1,
            },
            recoveryRecipient: "receiver",
            claimMode: "recycle",
        },
        covenantAddress:
            "ark1qprzw7ddf2knj52xz3635uggtuh3pcw85kf7fcpsa76msusuu4dskx9zh85pe5cscwmsd63mdycf33cjya7mc5gdef3rdjpp8llkxx3cmruwzd",
        fare: {
            currency: "sats",
            units: "3",
        },
        batchExpiry: {
            kind: "height",
            value: "900000",
        },
        inputExpiryFloor: {
            kind: "height",
            value: "850000",
        },
        recoveryLocktime: {
            kind: "time",
            value: "1765640000",
        },
        createdAt: 1757000000,
        expiresAt: 1757000060,
        operatorInputs: [
            {
                txid: "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
                vout: 0,
                value: "20000",
                tapTree:
                    "0100455120531fe6068134503d2723133227c867ac8fa6c83c537e9a44c3c5bdbdcb1fe337",
                spendLeaf: "20531fe6068134503d2723133227c867ac8fa6c83c537e9a44c3c5bdbdcb1fe337ac",
                expiry: { kind: "height", value: "900000" },
            },
        ],
        operatorScript: "5120531fe6068134503d2723133227c867ac8fa6c83c537e9a44c3c5bdbdcb1fe337",
    },
    fillSubmitted: {
        fillId: "fill-1",
        operationId: "op-1",
        state: "submitting",
        txid: "9f3c1f2e7a5b4d6c8e0a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60",
        updatedAt: 1757000001,
        expiresAt: 1757000060,
    },
    receiverPaidQuote: {
        quoteId: "adv-1",
        state: "quoted",
        receiverAddress:
            "ark1qprzw7ddf2knj52xz3635uggtuh3pcw85kf7fcpsa76msusuu4dskxuyc4t8kynygzv460k442aq2ewhrcvrgczgr8lec9l4a82a6pu0ezudfg",
        senderKey: "4d4b6cd1361032ca9bd2aeb9d900aa4d45d9ead80ac9423374c451a7254d0766",
        params: {
            receiverKey: "1b84c5567b126440995d3ed5aaba0565d71e1834604819ff9c17f5e9d5dd078f",
            senderKey: "4d4b6cd1361032ca9bd2aeb9d900aa4d45d9ead80ac9423374c451a7254d0766",
            operatorKey: "531fe6068134503d2723133227c867ac8fa6c83c537e9a44c3c5bdbdcb1fe337",
            operatorSignerKey: "989c0b76cb563971fdc9bef31ec06c3560f3249d6ee9e5d83c57625596e05f6f",
            dust: "330",
            topup: "330",
            locktime: "1765640000",
            exitDelay: { value: "86016", type: "seconds" },
            assetId: {
                txid: "bebebebebebebebebebebebebebebebebebebebebebebebebebebebebebebebe",
                groupIndex: 1,
            },
            recoveryRecipient: "receiver",
            claimMode: "recycle",
            receiverFare: {
                currency: "sats",
                units: "3",
            },
        },
        covenantAddress:
            "ark1qprzw7ddf2knj52xz3635uggtuh3pcw85kf7fcpsa76msusuu4dskke0ypfcsar2mkqejqxw09nhxmvvwqq36jawe3x8l00td4uuvppudr3sdq",
        fare: {
            currency: "sats",
            units: "0",
        },
        batchExpiry: {
            kind: "height",
            value: "900000",
        },
        inputExpiryFloor: {
            kind: "height",
            value: "900000",
        },
        recoveryLocktime: {
            kind: "time",
            value: "1765640000",
        },
        createdAt: 1757000000,
        expiresAt: 1757000060,
        operatorInputs: [
            {
                txid: "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
                vout: 0,
                value: "20000",
                tapTree:
                    "0100455120531fe6068134503d2723133227c867ac8fa6c83c537e9a44c3c5bdbdcb1fe337",
                spendLeaf: "20531fe6068134503d2723133227c867ac8fa6c83c537e9a44c3c5bdbdcb1fe337ac",
                expiry: { kind: "height", value: "900000" },
            },
        ],
        operatorScript: "5120531fe6068134503d2723133227c867ac8fa6c83c537e9a44c3c5bdbdcb1fe337",
        payer: "receiver",
        receiverFare: {
            currency: "sats",
            units: "3",
        },
        unclaimedMode: "reclaim",
    },
    sponsoredQuote: {
        transferId: "adv-1",
        params: {
            receiverKey: "1b84c5567b126440995d3ed5aaba0565d71e1834604819ff9c17f5e9d5dd078f",
            senderKey: "4d4b6cd1361032ca9bd2aeb9d900aa4d45d9ead80ac9423374c451a7254d0766",
            operatorKey: "531fe6068134503d2723133227c867ac8fa6c83c537e9a44c3c5bdbdcb1fe337",
            dust: "330",
            contribution: "330",
        },
        receiverAddress:
            "ark1qprzw7ddf2knj52xz3635uggtuh3pcw85kf7fcpsa76msusuu4dskxuyc4t8kynygzv460k442aq2ewhrcvrgczgr8lec9l4a82a6pu0ezudfg",
        fare: {
            currency: "sats",
            units: "0",
        },
        expiresAt: 1757000060,
        unsignedSponsoredTx:
            "eyJhcmtUeCI6ImNITmlkUDhCQUw4REFBQUFBa2lRbWhaWERoclhUVHB1QzBQTTM3VUJ3S2VrNWxlVXpqOWJJeEtMMkgwMkFBQUFBQUQvLy8vL1hqdkdCcEVoazlBUytsM0hnYlFkRGlCVmpOTUdFcG9LV0ErTDBERGFtSG9BQUFBQUFQLy8vLzhEU2dFQUFBQUFBQUFpVVNBYmhNVldleEprUUpsZFB0V3F1Z1ZsMXg0WU5HQklHZitjRi9YcDFkMEhqOVpNQUFBQUFBQUFJbEVnbUpXRWpDT0ZYOHdBaVJsZlcrcGtTdlpIZnMzTmxSdEZMa1NLcGFUcGg3Y0FBQUFBQUFBQUFBUlJBazV6QUFBQUFBQUJBU3NBQUFBQUFBQUFBQ0pSSUptUnl0ZnJra2lURHl2QkRDamhob2VDbzNnMENDV2owRExsZTNiVXd6dUZRaFhBVUpLYmRNR2dTVlMzaTB0Z05lbDZYZ2VLV2c4bzdKYlZSNy91bXM2QU9zRC9BRjd4eERmb00rQ0NyQ1RjbXBvc3hkc3BacG1DLzN4eXFhaTNZRmI2dVVVZ1JpZDVyVXF0T1ZGR0ZIVWFjUWhmTHhEaHg2V1Q1T0F3NzdXNGNoemxXd3V0SUUxTGJORTJFRExLbTlLdXVka0FxazFGMmVyWUNzbENNM1RFVWFjbFRRZG1yTUFJM25SaGNIUnlaV1Z4QWNBbkFwQUFzblVnUmlkNXJVcXRPVkZHRkhVYWNRaGZMeERoeDZXVDVPQXc3N1c0Y2h6bFd3dXNBY0JFSUVZbmVhMUtyVGxSUmhSMUduRUlYeThRNGNlbGsrVGdNTysxdUhJYzVWc0xyU0JOUzJ6Uk5oQXl5cHZTcnJuWkFLcE5SZG5xMkFySlFqTjB4RkduSlUwSFpxd0FBUUVySUU0QUFBQUFBQUFpVVNEalBOZHBUTDlsSzdHNlNybUtDN3NaZC83UVNBSnZqSDgwcjROTmwrNU9xVUlWd1ZDU20zVEJvRWxVdDR0TFlEWHBlbDRIaWxvUEtPeVcxVWUvN3ByT2dEckEvd0JlOGNRMzZEUGdncXdrM0pxYUxNWGJLV2FaZ3Y5OGNxbW90MkJXK3JsRklFWW5lYTFLclRsUlJoUjFHbkVJWHk4UTRjZWxrK1RnTU8rMXVISWM1VnNMclNCVEgrWUdnVFJRUFNjakV6SW55R2VzajZiSVBGTitta1REeGIyOXl4L2pONnpBQ041MFlYQjBjbVZsY1FIQUp3S1FBTEoxSUVZbmVhMUtyVGxSUmhSMUduRUlYeThRNGNlbGsrVGdNTysxdUhJYzVWc0xyQUhBUkNCR0ozbXRTcTA1VVVZVWRScHhDRjh2RU9ISHBaUGs0RER2dGJoeUhPVmJDNjBnVXgvbUJvRTBVRDBuSXhNeUo4aG5ySStteUR4VGZwcEV3OFc5dmNzZjR6ZXNBQUFBQUE9PSIsImNoZWNrcG9pbnRzIjpbImNITmlkUDhCQUdzREFBQUFBYXVycTZ1cnE2dXJxNnVycTZ1cnE2dXJxNnVycTZ1cnE2dXJxNnVycTZ1ckFnQUFBQUQvLy8vL0FnQUFBQUFBQUFBQUlsRWdtWkhLMSt1U1NKTVBLOEVNS09HR2g0S2plRFFJSmFQUU11VjdkdFRETzRVQUFBQUFBQUFBQUFSUkFrNXpBQUFBQUFBQkFTc0FBQUFBQUFBQUFDSlJJUEh3RXhRNkk3QzJ3M0p4TVJ4WVNRUVU2LzI5eTVsUTBLVnUvRzhqRGJISEloWEFVSktiZE1HZ1NWUzNpMHRnTmVsNlhnZUtXZzhvN0piVlI3L3VtczZBT3NCRklFWW5lYTFLclRsUlJoUjFHbkVJWHk4UTRjZWxrK1RnTU8rMXVISWM1VnNMclNCTlMyelJOaEF5eXB2U3JyblpBS3BOUmRucTJBckpRak4weEZHbkpVMEhacXpBQ041MFlYQjBjbVZsUndIQVJDQkdKM210U3EwNVVVWVVkUnB4Q0Y4dkVPSEhwWlBrNEREdnRiaHlIT1ZiQzYwZ1RVdHMwVFlRTXNxYjBxNjUyUUNxVFVYWjZ0Z0t5VUl6ZE1SUnB5Vk5CMmFzQUFBQSIsImNITmlkUDhCQUdzREFBQUFBYnU3dTd1N3U3dTd1N3U3dTd1N3U3dTd1N3U3dTd1N3U3dTd1N3U3dTd1N0FBQUFBQUQvLy8vL0FpQk9BQUFBQUFBQUlsRWc0enpYYVV5L1pTdXh1a3E1aWd1N0dYZiswRWdDYjR4L05LK0RUWmZ1VHFrQUFBQUFBQUFBQUFSUkFrNXpBQUFBQUFBQkFTc2dUZ0FBQUFBQUFDSlJJSmlWaEl3amhWL01BSWtaWDF2cVpFcjJSMzdOelpVYlJTNUVpcVdrNlllM0loWEJVSktiZE1HZ1NWUzNpMHRnTmVsNlhnZUtXZzhvN0piVlI3L3VtczZBT3NCRklFWW5lYTFLclRsUlJoUjFHbkVJWHk4UTRjZWxrK1RnTU8rMXVISWM1VnNMclNCVEgrWUdnVFJRUFNjakV6SW55R2VzajZiSVBGTitta1REeGIyOXl4L2pONnpBQ041MFlYQjBjbVZsUndIQVJDQkdKM210U3EwNVVVWVVkUnB4Q0Y4dkVPSEhwWlBrNEREdnRiaHlIT1ZiQzYwZ1V4L21Cb0UwVUQwbkl4TXlKOGhuckkrbXlEeFRmcHBFdzhXOXZjc2Y0emVzQUFBQSJdLCJjb3ZlbmFudE91dHB1dEluZGV4IjowLCJvcGVyYXRvcklucHV0SW5kZXhlcyI6WzFdLCJvcGVyYXRvcklucHV0cyI6W3siZXhwaXJ5Ijp7ImtpbmQiOiJoZWlnaHQiLCJ2YWx1ZSI6IjkwMDAwMCJ9LCJzcGVuZExlYWYiOiIyMDQ2Mjc3OWFkNGFhZDM5NTE0NjE0NzUxYTcxMDg1ZjJmMTBlMWM3YTU5M2U0ZTAzMGVmYjViODcyMWNlNTViMGJhZDIwNTMxZmU2MDY4MTM0NTAzZDI3MjMxMzMyMjdjODY3YWM4ZmE2YzgzYzUzN2U5YTQ0YzNjNWJkYmRjYjFmZTMzN2FjIiwidGFwVHJlZSI6IjAxYzA0NDIwNDYyNzc5YWQ0YWFkMzk1MTQ2MTQ3NTFhNzEwODVmMmYxMGUxYzdhNTkzZTRlMDMwZWZiNWI4NzIxY2U1NWIwYmFkMjA1MzFmZTYwNjgxMzQ1MDNkMjcyMzEzMzIyN2M4NjdhYzhmYTZjODNjNTM3ZTlhNDRjM2M1YmRiZGNiMWZlMzM3YWMiLCJ0eGlkIjoiYmJiYmJiYmJiYmJiYmJiYmJiYmJiYmJiYmJiYmJiYmJiYmJiYmJiYmJiYmJiYmJiYmJiYmJiYmJiYmJiYmJiYiIsInZhbHVlIjoiMjAwMDAiLCJ2b3V0IjowfV0sInNlbmRlcklucHV0SW5kZXhlcyI6WzBdLCJzZW5kZXJJbnB1dHMiOlt7ImV4cGlyeSI6eyJraW5kIjoiaGVpZ2h0IiwidmFsdWUiOiI5MTAwMDAifSwic3BlbmRMZWFmIjoiMjA0NjI3NzlhZDRhYWQzOTUxNDYxNDc1MWE3MTA4NWYyZjEwZTFjN2E1OTNlNGUwMzBlZmI1Yjg3MjFjZTU1YjBiYWQyMDRkNGI2Y2QxMzYxMDMyY2E5YmQyYWViOWQ5MDBhYTRkNDVkOWVhZDgwYWM5NDIzMzc0YzQ1MWE3MjU0ZDA3NjZhYyIsInRhcFRyZWUiOiIwMWMwNDQyMDQ2Mjc3OWFkNGFhZDM5NTE0NjE0NzUxYTcxMDg1ZjJmMTBlMWM3YTU5M2U0ZTAzMGVmYjViODcyMWNlNTViMGJhZDIwNGQ0YjZjZDEzNjEwMzJjYTliZDJhZWI5ZDkwMGFhNGQ0NWQ5ZWFkODBhYzk0MjMzNzRjNDUxYTcyNTRkMDc2NmFjIiwidHhpZCI6ImFiYWJhYmFiYWJhYmFiYWJhYmFiYWJhYmFiYWJhYmFiYWJhYmFiYWJhYmFiYWJhYmFiYWJhYmFiYWJhYmFiYWIiLCJ2YWx1ZSI6IjAiLCJ2b3V0IjoyfV0sInNlcnZlclVucm9sbFNjcmlwdCI6IjAyOTAwMGIyNzUyMDQ2Mjc3OWFkNGFhZDM5NTE0NjE0NzUxYTcxMDg1ZjJmMTBlMWM3YTU5M2U0ZTAzMGVmYjViODcyMWNlNTViMGJhYyIsInVuc2lnbmVkVHhJZCI6IjQ3MzQyNjFhNDNjMTFhOWQ1ZWZkODNhMmY3YmRiYTM0NmI3ZTA3NDI2ZWNlMDViMDQzYWExY2YwOGM0ZGExNDcifQ==",
        commitment: {
            paymentOutputIndex: 0,
            senderInputIndexes: [0],
            operatorInputIndexes: [1],
            unsignedTxId: "4734261a43c11a9d5efd83a2f7bdba346b7e07426ece05b043aa1cf08c4da147",
        },
    },
    claims: {
        claims: [
            {
                transferId: "adv-1",
                receiverAddress:
                    "ark1qprzw7ddf2knj52xz3635uggtuh3pcw85kf7fcpsa76msusuu4dskxuyc4t8kynygzv460k442aq2ewhrcvrgczgr8lec9l4a82a6pu0ezudfg",
                state: "locked",
                claimable: true,
                updatedAt: 1757000000,
                claim: {
                    params: {
                        receiverKey:
                            "1b84c5567b126440995d3ed5aaba0565d71e1834604819ff9c17f5e9d5dd078f",
                        senderKey:
                            "4d4b6cd1361032ca9bd2aeb9d900aa4d45d9ead80ac9423374c451a7254d0766",
                        operatorKey:
                            "531fe6068134503d2723133227c867ac8fa6c83c537e9a44c3c5bdbdcb1fe337",
                        operatorSignerKey:
                            "989c0b76cb563971fdc9bef31ec06c3560f3249d6ee9e5d83c57625596e05f6f",
                        dust: "330",
                        topup: "330",
                        locktime: "1765640000",
                        exitDelay: { value: "86016", type: "seconds" },
                        claimMode: "recycle",
                    },
                    covenantAddress:
                        "ark1qprzw7ddf2knj52xz3635uggtuh3pcw85kf7fcpsa76msusuu4dsk6p54ak3xqlrjxe7l2nxjmzffdhdqhr269jx6yl63gj3p2q6ja9fufwg30",
                    outpoint: {
                        txid: "cdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcd",
                        vout: 0,
                    },
                    fare: {
                        currency: "sats",
                        units: "0",
                    },
                    batchExpiry: {
                        kind: "time",
                        value: "1765640000",
                    },
                    recoveryLocktime: {
                        kind: "time",
                        value: "1765640000",
                    },
                },
            },
        ],
    },
    claimsChanged: {
        claims: [
            {
                transferId: "adv-1",
                receiverAddress:
                    "ark1qprzw7ddf2knj52xz3635uggtuh3pcw85kf7fcpsa76msusuu4dskxuyc4t8kynygzv460k442aq2ewhrcvrgczgr8lec9l4a82a6pu0ezudfg",
                state: "purchased",
                claimable: false,
                updatedAt: 1757000000,
                spentTxid: "efefefefefefefefefefefefefefefefefefefefefefefefefefefefefefefef",
            },
        ],
    },
    health: {
        proceeds: {
            running: false,
            jobId: null,
            state: "idle",
            blocker: null,
            maxFeeSats: "500",
            authorizedFeeSats: null,
            commitmentTxid: null,
        },
        status: "ok",
        paused: false,
        now: 1757000000,
        startup: {
            phase: "ready",
            complete: true,
            blocker: null,
        },
        blockers: [],
        runtime: {
            checkedAt: 1757000000000,
            chainHeight: "700000",
            chainTime: "1757000000",
            walletSynced: true,
            providerIdentityOk: true,
            provider: {
                network: "regtest",
                identityOk: true,
                serverPubkey: "462779ad4aad39514614751a71085f2f10e1c7a593e4e030efb5b8721ce55b0b",
                emulatorPubkey: "62c0a046dacce86ddd0343c6d3c7c79c2208ba0d9c9cf24a6d046d21d21f90f7",
            },
            blockers: [],
            inventory: {
                usableSats: "250000",
                reservedSats: "330",
                usableVtxos: 4,
                reservedVtxos: 1,
            },
        },
        sweeper: {
            lastTickAt: 1757000000,
            lastTickHeight: "900000",
            lastTickMedianTime: "1757000000",
            recoverySubmittedTotal: 3,
            failedTotal: 0,
            lastError: null,
            lastRecoveryError: null,
            lockedCount: 2,
            recoveringCount: 1,
            lastSuccessfulObservationAt: 1756999998,
            lastSuccessfulRecoveryAt: 1756999999,
            nearestDeadline: {
                height: null,
                time: {
                    advanceId: "adv-1",
                    kind: "time",
                    locktime: "1765640000",
                    batchExpiry: null,
                    remaining: "8640000",
                    severity: "eligible",
                    code: "recovery_eligible",
                },
            },
            oldestUnsweptLocktime: {
                height: "850000",
                time: null,
            },
            blockers: [],
        },
        reconciler: {
            lastTickAt: 1757000000,
            locking: 0,
            blockers: [],
            lastWatcherScanAt: null,
            watching: 0,
            activelyScanned: 0,
        },
    },
};

const claimsStream = [
    `event: claims-snapshot\ndata: ${JSON.stringify(examples.claims)}\n\n`,
    `event: claims-changed\ndata: ${JSON.stringify(examples.claimsChanged)}\n\n`,
    ": heartbeat\n\n",
].join("");

const json = (schema: Schema, example?: unknown): Record<string, MediaType> => ({
    "application/json": example === undefined ? { schema } : { schema, example },
});
const ok = (name: string, example: unknown, description = "OK."): ResponseSpec => ({
    description,
    content: json(ref(name), example),
});
const error = (description: string): ResponseSpec => ({ description, content: json(ref("Error")) });
const body = (name: string) => ({ required: true as const, content: json(ref(name)) });
const byId = (description: string): Parameter[] => [
    { name: "id", in: "path", required: true, description, schema: str },
];
const receivers: Parameter[] = [
    {
        name: "receiver",
        in: "query",
        required: true,
        description:
            "Canonical Arkade address on this server's network and server key. Repeat for 1 to 64 unique addresses.",
        schema: { type: "array", items: str, minItems: 1 },
    },
];

const internal = error("`internal_error`.");
const unavailable = error("`database_busy`, or `shutting_down` while the service drains.");
const quoteRefused = (codes: string) =>
    error(`Refused in the operator's current state. Codes include ${codes}.`);
const notQuoting = (codes: string) => error(`Not quoting now. Codes include ${codes}.`);

const lockup = (tag: string): Operation => ({
    tags: [tag],
    summary: "Submit the signed lockup",
    parameters: byId("`transferId` from the quote."),
    requestBody: body("LockupRequest"),
    responses: {
        200: ok(
            "LockupResponse",
            examples.lockupLocked,
            "Already observed: the transfer is `locked`.",
        ),
        202: ok("LockupResponse", examples.lockupAccepted, "Accepted: the transfer is `locking`."),
        400: error(
            "`invalid_request` for a malformed body; `invalid_lockup_signature` when the signed lockup does not match the quote.",
        ),
        404: error("`not_found`."),
        409: error("Codes include `quote_expired`, `invalid_state` and `envelope_conflict`."),
        500: internal,
        503: error(
            "Codes include `not_ready`, `runtime_unsafe`, `database_busy` and `shutting_down`.",
        ),
    },
});

const transferStatus = (tag: string): Operation => ({
    tags: [tag],
    summary: "Transfer status",
    parameters: byId("`transferId` from the quote."),
    responses: {
        200: ok("TransferStatus", examples.transferStatus),
        404: error("`not_found`."),
        500: internal,
        503: unavailable,
    },
});

const admissionCodes =
    "`asset_not_served`, `asset_disabled`, `fare_unavailable`, `topup_exceeds_max_per_payment`, `exceeds_max_outstanding`, `max_concurrent_advances`";

export const openApiDocument: {
    openapi: string;
    info: { title: string; version: string; description: string };
    servers: { url: string }[];
    paths: Record<string, { get?: Operation; post?: Operation }>;
    components: { schemas: Record<string, Schema> };
} = {
    openapi: "3.1.0",
    info: {
        title: "Arkade Taxi API",
        version,
        description:
            "Public HTTP API of an Arkade Taxi operator. Amounts are decimal strings, byte fields lowercase hex and times unix seconds unless noted. Responses carry exactly the documented fields.",
    },
    servers: [{ url: "/" }],
    paths: {
        "/v1/info": {
            get: {
                tags: ["Service"],
                summary: "Operator keys, endpoints and terms",
                responses: {
                    200: ok("InfoResponse", examples.info),
                    500: internal,
                    503: unavailable,
                },
            },
        },
        "/v1/transfers": {
            post: {
                tags: ["Transfers"],
                summary: "Quote a covenant transfer",
                description:
                    "Reserves operator funding and returns the unsigned joint lockup. Verify the covenant from `params` before signing.",
                requestBody: body("QuoteRequest"),
                responses: {
                    200: ok("QuoteResponse", examples.quote),
                    400: error("`invalid_request`."),
                    409: quoteRefused(
                        `${admissionCodes}, \`policy_changed\` and \`reservation_conflict\``,
                    ),
                    500: internal,
                    503: notQuoting(
                        "`paused`, `not_ready`, `runtime_unsafe`, `operator_inventory_insufficient`, `no_locktime_headroom`, `database_busy` and `shutting_down`",
                    ),
                },
            },
        },
        "/v1/transfers/{id}/lockup": { post: lockup("Transfers") },
        "/v1/transfers/{id}": { get: transferStatus("Transfers") },
        "/v1/receive-quotes": {
            post: {
                tags: ["Receive quotes"],
                summary: "Quote a receive",
                description:
                    "Reserves operator funding for a recycle covenant paying `receiverAddress`, for a caller-built fill to bind. Unknown request fields are rejected.",
                requestBody: body("ReceiveQuoteRequest"),
                responses: {
                    200: ok("ReceiveQuote", examples.receiveQuote),
                    400: error("`invalid_request`."),
                    409: quoteRefused(
                        `${admissionCodes}, \`reservation_conflict\`, \`policy_changed\` and \`policy_revision_conflict\``,
                    ),
                    500: internal,
                    503: notQuoting(
                        "`not_ready`, `runtime_unsafe`, `operator_inventory_insufficient`, `no_locktime_headroom`, `database_busy` and `shutting_down`",
                    ),
                },
            },
        },
        "/v1/receive-quotes/{id}": {
            get: {
                tags: ["Receive quotes"],
                summary: "Receive quote",
                description: "Reads the saved quote without renewing it.",
                parameters: byId("`quoteId` from the quote."),
                responses: {
                    200: ok("ReceiveQuote", examples.receiverPaidQuote),
                    404: error("`not_found`."),
                    500: internal,
                    503: unavailable,
                },
            },
        },
        "/v1/sponsored-transfers": {
            post: {
                tags: ["Sponsored transfers"],
                summary: "Quote a sponsored direct send",
                description:
                    "The operator fronts the receiver's dust carrier and the payment pays `receiverAddress` directly: no covenant and no claim.",
                requestBody: body("SponsoredQuoteRequest"),
                responses: {
                    200: ok("SponsoredQuoteResponse", examples.sponsoredQuote),
                    400: error("`invalid_request`."),
                    409: quoteRefused(
                        `${admissionCodes}, \`policy_changed\` and \`reservation_conflict\``,
                    ),
                    500: internal,
                    503: notQuoting(
                        "`paused`, `not_ready`, `runtime_unsafe`, `operator_inventory_insufficient`, `database_busy` and `shutting_down`",
                    ),
                },
            },
        },
        "/v1/sponsored-transfers/{id}/lockup": { post: lockup("Sponsored transfers") },
        "/v1/sponsored-transfers/{id}": { get: transferStatus("Sponsored transfers") },
        "/v1/fills": {
            post: {
                tags: ["Fills"],
                summary: "Fill a receive quote with a graph you built",
                description:
                    "One call: validates the graph against the quote, binds the quote, signs the Taxi's inputs last and submits. The Taxi checks only that it gets its reserved coins back, its fare paid and the quoted covenant created.",
                requestBody: body("FillRequest"),
                responses: {
                    202: ok("FillStatus", examples.fillSubmitted, "Submitted: `submitting`."),
                    400: error(
                        "Codes include `invalid_request`, `fill_graph_invalid`, `fill_taxi_inputs_differ`, `fill_foreign_taxi_coin`, `fill_checkpoint_mismatch`, `fill_covenant_output_mismatch`, `fill_covenant_asset_mismatch`, `fill_asset_units_invalid`, `fill_fare_exceeds_delivery`, `fill_operator_payout_mismatch`, `fill_unpriced_fare`, `fill_two_fares`, `fill_output_below_floor`, `fill_asset_not_conserved`, `fill_taxi_input_assets`, `fill_input_unspendable` and `fill_taxi_input_signed`.",
                    ),
                    404: error("`not_found`: no such receive quote."),
                    409: error(
                        "Codes include `quote_expired`, `invalid_state`, `operation_conflict`, `policy_changed`, `fill_input_expiry_floor`, `fill_output_limit_exceeded` and `fill_bind_failed`.",
                    ),
                    500: internal,
                    503: error(
                        "Codes include `not_ready`, `runtime_unsafe`, `fill_signing_failed`, `database_busy` and `shutting_down`. `fill_submission_ambiguous` means the outcome is unknown: poll the fill status, never resubmit blindly.",
                    ),
                },
            },
        },
        "/v1/fills/{id}": {
            get: {
                tags: ["Fills"],
                summary: "Fill status",
                parameters: byId("`fillId` from the submission."),
                responses: {
                    200: ok("FillStatus", examples.fillSubmitted),
                    404: error("`not_found`."),
                    500: internal,
                    503: unavailable,
                },
            },
        },
        "/v1/claims": {
            get: {
                tags: ["Claims"],
                summary: "Active claims for receivers",
                description:
                    "Claims in `locking`, `locked` or `recovering` state. A `locked` claim carries its claim descriptor.",
                parameters: receivers,
                responses: {
                    200: ok("ClaimsSnapshot", examples.claims),
                    400: error("`invalid_receiver_batch`."),
                    500: internal,
                    503: unavailable,
                },
            },
        },
        "/v1/claims/events": {
            get: {
                tags: ["Claims"],
                summary: "Stream claim changes",
                description:
                    "Server-sent events. On connect one `claims-snapshot` event carries the active claims; each `claims-changed` event carries only the claims that changed since, including terminal transitions. Both `data` payloads are `ClaimsSnapshot` JSON. A `: heartbeat` comment follows every 15 seconds.",
                parameters: receivers,
                responses: {
                    200: {
                        description: "Event stream.",
                        content: {
                            "text/event-stream": { schema: str, example: claimsStream },
                        },
                    },
                    400: error("`invalid_receiver_batch`."),
                    500: internal,
                    503: unavailable,
                },
            },
        },
        "/health": {
            get: {
                tags: ["Health"],
                summary: "Liveness",
                description:
                    "200 whenever the process can serve; problems are reported in the body and gate `/ready`.",
                responses: {
                    200: ok("HealthResponse", examples.health),
                    500: { description: "Unhandled failure, plain-text body." },
                    503: error("`shutting_down`."),
                },
            },
        },
        "/ready": {
            get: {
                tags: ["Health"],
                summary: "Readiness",
                responses: {
                    200: ok("HealthResponse", examples.health),
                    500: { description: "Unhandled failure, plain-text body." },
                    503: {
                        description:
                            "Not ready: the health body with `status: degraded` and a `reason`, or the error body with `shutting_down`.",
                        content: json({ oneOf: [ref("HealthResponse"), ref("Error")] }),
                    },
                },
            },
        },
    },
    components: { schemas },
};

// Bump the version and the hash together: a stale hash makes the browser refuse the script.
export const DOCS_HTML = `<!doctype html>
<html lang="en">
    <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>Arkade Taxi API</title>
        <style>
            body {
                margin: 0;
            }
        </style>
    </head>
    <body>
        <redoc spec-url="/openapi.json"></redoc>
        <script
            src="https://cdn.jsdelivr.net/npm/redoc@2.5.4/bundles/redoc.standalone.js"
            integrity="sha384-w447zOpYfw/1Tv/5AK9NfHTlQIqE3RVR6KY62jCyy9zNDgO64cMwGGP1Fj0zJVf5"
            crossorigin="anonymous"
        ></script>
    </body>
</html>
`;
