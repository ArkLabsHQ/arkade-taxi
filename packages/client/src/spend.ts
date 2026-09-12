import {
    Leaf,
    DustCovenantScript,
    copyByteView,
    covenantSpendInput,
    payoutPkScript,
    refundTopup,
    signerTransaction,
    type CovenantSpendInput,
    type DustCovenantParams,
} from "@arkade-taxi/covenant";
import {
    quoteParamsFromWire,
    type AssetIdValue,
    type LockupResponse,
    type ReceiverClaimWire,
    type TransferStatusResponse,
} from "@arkade-taxi/protocol";
import {
    ArkAddress,
    Extension,
    EmulatorPacket,
    MultisigTapscript,
    CSVMultisigTapscript,
    P2A,
    RestArkProvider,
    RestEmulatorProvider,
    RestIndexerProvider,
    Transaction,
    VtxoScript,
    asset,
    assertAllowedSighashTypes,
    attachPrevArkTxs,
    buildOffchainTx,
    canSpendOffchain,
    scriptFromTapLeafScript,
    verifyTapscriptSignatures,
    type ArkInfo,
    type EmulatorProvider,
    type Identity,
    type VirtualCoin,
} from "@arkade-os/sdk";
import { base64, hex } from "@scure/base";
import { SigHash } from "@scure/btc-signer";
import { tapLeafHash } from "@scure/btc-signer/payment.js";
import { decodeClaimsSnapshot, decodeInfo, decodeLockup, decodeStatus } from "./decode.js";
import { WeakValueRegistry } from "./lifecycle.js";
import { activeQuoteStateFor, immutablePlainCopy } from "./lockup.js";
import type { VerifiedQuote } from "./verify.js";

const { AssetGroup, AssetId, AssetInput, AssetOutput, Packet } = asset;

declare const transferBrand: unique symbol;

export type CovenantTransfer = {
    readonly transferId: string;
    readonly outpoint: Readonly<{ txid: string; vout: number }>;
    readonly value: bigint;
    readonly expiry: Readonly<{ kind: "time" | "height"; value: bigint }>;
} & { readonly [transferBrand]: true };

export interface CovenantSpendConfig {
    arkdUrl: string;
    emulatorUrl: string;
    network: string;
    serverUnrollScript: string;
    chainHeight?: number;
}

export interface VerifyCovenantTransferArgs {
    verified: VerifiedQuote;
    lockup: LockupResponse;
    status: TransferStatusResponse;
    config: CovenantSpendConfig;
}

export interface IncomingClaimExpectation {
    receiverAddress: string;
    assetId?: AssetIdValue;
    assetUnits?: bigint;
}

export interface IncomingClaimTrust {
    serverKey: Uint8Array;
    emulatorKey: Uint8Array;
    operatorKey: Uint8Array;
    vtxoMinAmount: bigint;
    hrp: string;
}

export interface VerifyIncomingClaimArgs {
    claim: ReceiverClaimWire;
    expect: IncomingClaimExpectation;
    trusted: IncomingClaimTrust;
    config: CovenantSpendConfig;
    status: TransferStatusResponse;
}

export interface ReceiverWalletInput {
    input: CovenantSpendInput;
    expiry: { kind: "time" | "height"; value: bigint };
    identity: Identity;
}

export class CovenantSpendAmbiguousError extends Error {
    readonly name = "CovenantSpendAmbiguousError";

    constructor(
        public readonly expectedTxid: string,
        cause: unknown,
    ) {
        super(
            `taxi: covenant spend submission outcome is ambiguous; observe transaction ${expectedTxid} before retrying: ${cause instanceof Error ? cause.message : String(cause)}`,
            { cause },
        );
    }
}

interface Holding {
    id: string;
    amount: bigint;
}

interface CapabilityState {
    transferId: string;
    outpoint: { txid: string; vout: number };
    expiry: { kind: "time" | "height"; value: bigint };
    params: DustCovenantParams;
    serverKey: Uint8Array;
    emulatorKey: Uint8Array;
    vtxoMinAmount: bigint;
    hrp: string;
    holdings: Holding[];
    dependencies: SpendDependencies;
    arkdUrl: string;
    emulatorUrl: string;
    lifecycle: SpendLifecycle;
}

const capabilities = new WeakMap<CovenantTransfer, CapabilityState>();
interface SpendLifecycle {
    state: "available" | "consumed";
    expectedTxid?: string;
}
let spendLifecycles: WeakValueRegistry<string, SpendLifecycle> | undefined;
const lifecycleRegistry = (): WeakValueRegistry<string, SpendLifecycle> =>
    (spendLifecycles ??= new WeakValueRegistry());
type AssetPacket = ReturnType<typeof Packet.create>;

interface SpendDependencies {
    arkProvider: Pick<RestArkProvider, "getInfo">;
    emulator: Pick<RestEmulatorProvider, "getInfo" | "submitTx">;
    indexer: Pick<RestIndexerProvider, "getVtxos" | "getVirtualTxs">;
    network: string;
    serverUnrollScript: CSVMultisigTapscript.Type;
    chainHeight?: number;
}

const reject = (detail: string): never => {
    throw new Error(`taxi: covenant spend: ${detail}`);
};

const sameBytes = (a: Uint8Array, b: Uint8Array): boolean =>
    a.length === b.length && a.every((value, index) => value === b[index]);

const exactBytes = (actual: Uint8Array, expected: Uint8Array, label: string): void => {
    if (!sameBytes(actual, expected)) reject(`${label} mismatch`);
};

const exactTapLeaf = (
    actual: CovenantSpendInput["tapLeafScript"],
    expected: CovenantSpendInput["tapLeafScript"],
    label: string,
): void => {
    if (
        actual[0].version !== expected[0].version ||
        actual[0].merklePath.length !== expected[0].merklePath.length
    )
        reject(`${label} control block mismatch`);
    exactBytes(actual[0].internalKey, expected[0].internalKey, `${label} internal key`);
    actual[0].merklePath.forEach((node, index) =>
        exactBytes(node, expected[0].merklePath[index], `${label} Merkle path ${index}`),
    );
    exactBytes(actual[1], expected[1], `${label} encoded leaf`);
};

const exactOutpoint = (
    actual: { txid: string; vout: number },
    expected: { txid: string; vout: number },
    label: string,
): void => {
    if (actual.txid !== expected.txid || actual.vout !== expected.vout) reject(`${label} mismatch`);
};

const normalizeUrl = (value: string, label: string): string => {
    let url: URL;
    try {
        url = new URL(value);
    } catch {
        return reject(`${label} is not an absolute URL`);
    }
    if (url.username || url.password || url.hash || url.search)
        reject(`${label} contains credentials, query, or fragment`);
    url.pathname = url.pathname.replace(/\/+$/, "");
    return url.toString().replace(/\/+$/, "");
};

const providerUrl = (provider: object, label: string): string => {
    const descriptor = Object.getOwnPropertyDescriptor(provider, "serverUrl");
    if (!descriptor || !("value" in descriptor) || !descriptor.enumerable)
        return reject(`${label} provider URL must be an enumerable data property`);
    return normalizeUrl(descriptor.value as string, `${label} provider URL`);
};

const privatePrototype = <T extends object>(prototype: T): T =>
    Object.freeze(
        Object.create(
            Object.getPrototypeOf(prototype),
            Object.getOwnPropertyDescriptors(prototype),
        ),
    ) as T;

const restArkPrototype = privatePrototype(RestArkProvider.prototype);
const restIndexerPrototype = privatePrototype(RestIndexerProvider.prototype);
const restEmulatorPrototype = privatePrototype(RestEmulatorProvider.prototype);

const pinProvider = <T extends { serverUrl: string }>(
    provider: T,
    prototype: object,
    pinnedUrl: string,
): T => {
    Object.setPrototypeOf(provider, prototype);
    Object.defineProperty(provider, "serverUrl", {
        value: pinnedUrl,
        enumerable: true,
        configurable: false,
        writable: false,
    });
    return provider;
};

const capturedCall = <T extends { serverUrl: string }, F extends Function>(
    provider: T,
    method: F,
    pinnedUrl: string,
    label: string,
) => {
    return (...args: unknown[]): unknown => {
        if (providerUrl(provider, label) !== pinnedUrl)
            reject(`${label} provider identity changed before a call`);
        return Reflect.apply(method, provider, args);
    };
};

const restArkGetInfo = RestArkProvider.prototype.getInfo;
const restIndexerGetVtxos = RestIndexerProvider.prototype.getVtxos;
const restIndexerGetVirtualTxs = RestIndexerProvider.prototype.getVirtualTxs;
const restEmulatorGetInfo = RestEmulatorProvider.prototype.getInfo;
const restEmulatorSubmitTx = RestEmulatorProvider.prototype.submitTx;

const exactObjectKeys = (
    value: Record<string, unknown>,
    required: readonly string[],
    optional: readonly string[],
    label: string,
): void => {
    const keys = Object.keys(value);
    const allowed = new Set([...required, ...optional]);
    if (required.some((key) => !keys.includes(key)) || keys.some((key) => !allowed.has(key)))
        reject(`${label} fields mismatch`);
};

const receiverInputSnapshot = (value: ReceiverWalletInput): ReceiverWalletInput => {
    if (!value || typeof value !== "object" || Array.isArray(value))
        return reject("receiver wallet input must be an object");
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null)
        reject("receiver wallet input must be a plain object");
    const descriptors = Object.getOwnPropertyDescriptors(value);
    exactObjectKeys(
        descriptors as unknown as Record<string, unknown>,
        ["input", "expiry", "identity"],
        [],
        "receiver wallet input",
    );
    for (const [key, descriptor] of Object.entries(descriptors))
        if (!("value" in descriptor) || !descriptor.enumerable)
            reject(`receiver wallet input ${key} must be an enumerable data property`);
    const identity = descriptors.identity!.value as Identity;
    if (
        !identity ||
        typeof identity !== "object" ||
        typeof identity.xOnlyPublicKey !== "function" ||
        typeof identity.sign !== "function"
    )
        reject("receiver wallet input identity is not a signing identity");
    const snapshot = immutablePlainCopy(
        {
            input: descriptors.input!.value,
            expiry: descriptors.expiry!.value,
        },
        "receiver wallet input facts",
    ) as Pick<ReceiverWalletInput, "input" | "expiry">;
    exactObjectKeys(
        snapshot.input as unknown as Record<string, unknown>,
        ["txid", "vout", "value", "tapTree", "tapLeafScript"],
        ["assetPacket"],
        "receiver covenant-spend input",
    );
    const selectedLeaf = snapshot.input.tapLeafScript;
    if (
        !Array.isArray(selectedLeaf) ||
        Object.getPrototypeOf(selectedLeaf) !== Array.prototype ||
        selectedLeaf.length !== 2
    )
        reject("receiver selected leaf must be an exact pair");
    exactObjectKeys(
        selectedLeaf[0] as unknown as Record<string, unknown>,
        ["version", "internalKey", "merklePath"],
        [],
        "receiver control block",
    );
    if (!Array.isArray(selectedLeaf[0].merklePath))
        reject("receiver control block Merkle path must be an array");
    exactObjectKeys(
        snapshot.expiry as unknown as Record<string, unknown>,
        ["kind", "value"],
        [],
        "receiver input expiry",
    );
    return { ...snapshot, identity };
};

const compressedToXOnly = (encoded: string, label: string): Uint8Array => {
    let key: Uint8Array;
    try {
        key = hex.decode(encoded);
    } catch {
        return reject(`${label} is not lowercase hex`);
    }
    if (hex.encode(key) !== encoded || (key.length !== 32 && key.length !== 33))
        reject(`${label} is not a canonical public key`);
    if (key.length === 33 && key[0] !== 2 && key[0] !== 3)
        reject(`${label} is not a compressed public key`);
    return key.length === 32 ? key : key.slice(1);
};

interface ProviderTrust {
    network: string;
    serverKey: Uint8Array;
    emulatorKey: Uint8Array;
    dust: bigint;
    vtxoMinAmount: bigint;
    serverUnrollScript: Uint8Array;
}

const validateProviderFacts = (
    trust: ProviderTrust,
    info: ArkInfo,
    emulatorInfo: { signerPubkey: string },
): bigint | undefined => {
    if (info.network !== trust.network) reject("Ark network identity mismatch");
    if (
        info.maxOpReturnOutputs !== undefined &&
        (typeof info.maxOpReturnOutputs !== "bigint" || info.maxOpReturnOutputs <= 0n)
    )
        reject("Ark provider advertised an invalid OP_RETURN capacity");
    if (!sameBytes(compressedToXOnly(info.signerPubkey, "Ark signer"), trust.serverKey))
        reject("Ark signer key mismatch");
    const { pubkeys } = CSVMultisigTapscript.decode(trust.serverUnrollScript).params;
    if (
        pubkeys.length !== 1 ||
        !sameBytes(compressedToXOnly(info.forfeitPubkey, "Ark forfeit signer"), pubkeys[0])
    )
        reject("Ark forfeit signer key mismatch");
    if (
        !sameBytes(
            compressedToXOnly(emulatorInfo.signerPubkey, "emulator signer"),
            trust.emulatorKey,
        )
    )
        reject("emulator signer key mismatch");
    if (
        info.dust !== trust.dust ||
        info.vtxoMinAmount !== trust.vtxoMinAmount ||
        info.checkpointTapscript !== hex.encode(trust.serverUnrollScript)
    )
        reject("Ark construction parameters do not match the verified quote");
    return info.maxOpReturnOutputs;
};

const freshProviderFacts = async (state: CapabilityState): Promise<bigint | undefined> => {
    const [info, emulatorInfo] = await Promise.all([
        state.dependencies.arkProvider.getInfo(),
        state.dependencies.emulator.getInfo(),
    ]);
    return validateProviderFacts(
        {
            network: state.dependencies.network,
            serverKey: state.serverKey,
            emulatorKey: state.emulatorKey,
            dust: state.params.dust,
            vtxoMinAmount: state.vtxoMinAmount,
            serverUnrollScript: state.dependencies.serverUnrollScript.script,
        },
        info,
        emulatorInfo,
    );
};

const assetId = (params: DustCovenantParams): string | undefined =>
    params.assetId
        ? AssetId.create(
              hex.encode(Uint8Array.from(params.assetId.txid).reverse()),
              params.assetId.groupIndex,
          ).toString()
        : undefined;

const holdingsPacket = (holdings: readonly Holding[], vout: number): Uint8Array | undefined =>
    holdings.length
        ? Packet.create(
              [...holdings]
                  .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
                  .map(({ id, amount }) =>
                      AssetGroup.create(
                          AssetId.fromString(id),
                          null,
                          [],
                          [AssetOutput.create(vout, amount)],
                          [],
                      ),
                  ),
          ).serialize()
        : undefined;

const holdingsFromPacket = (input: CovenantSpendInput): Holding[] => {
    if (!input.assetPacket) return [];
    const packet = Packet.fromBytes(input.assetPacket);
    if (!sameBytes(packet.serialize(), input.assetPacket)) reject("non-canonical asset packet");
    const holdings = packet.groups.map((group) => {
        if (
            !group.assetId ||
            group.controlAsset ||
            group.inputs.length ||
            group.outputs.length !== 1
        )
            return reject("funding asset packet is not holdings-only");
        const output = group.outputs[0];
        if (output.vout !== input.vout || output.amount <= 0n)
            return reject("funding asset holding does not match its outpoint");
        return { id: group.assetId.toString(), amount: output.amount };
    });
    if (new Set(holdings.map(({ id }) => id)).size !== holdings.length)
        reject("funding asset packet contains duplicate groups");
    const canonical = holdingsPacket(holdings, input.vout);
    if (!canonical || !sameBytes(canonical, input.assetPacket))
        reject("funding asset packet contains metadata or is not canonically sorted");
    return holdings;
};

const expiryFor = (coin: VirtualCoin): { kind: "time" | "height"; value: bigint } => {
    const hasTime = coin.expiresAt instanceof Date && Number.isFinite(coin.expiresAt.getTime());
    const hasHeight = Number.isSafeInteger(coin.expiresAtHeight) && (coin.expiresAtHeight ?? 0) > 0;
    if (hasTime === hasHeight) reject("locked outpoint has ambiguous or missing expiry");
    return hasTime
        ? { kind: "time", value: BigInt(Math.floor(coin.expiresAt!.getTime() / 1000)) }
        : { kind: "height", value: BigInt(coin.expiresAtHeight!) };
};

const clock = (dependencies: SpendDependencies) => {
    const timestamp = new Date();
    const height = dependencies.chainHeight;
    if (height !== undefined && (!Number.isSafeInteger(height) || height < 0))
        reject("chain-height clock returned an invalid height");
    return { timestamp, ...(height === undefined ? {} : { height }) };
};

type CoinExpectation = Omit<CapabilityState, "holdings" | "expiry" | "lifecycle"> & {
    contextAssetUnits?: bigint;
};

const strictCoin = (
    coin: VirtualCoin,
    state: CoinExpectation,
): { expiry: CapabilityState["expiry"]; holdings: Holding[] } => {
    exactOutpoint(coin, state.outpoint, "observed locked outpoint");
    if (!Number.isSafeInteger(coin.value) || BigInt(coin.value) !== state.params.dust)
        reject("locked outpoint value is not exact covenant dust");
    const script = new DustCovenantScript({
        serverKey: state.serverKey,
        emulatorKey: state.emulatorKey,
        params: state.params,
        vtxoMinAmount: state.vtxoMinAmount,
    });
    if (coin.script !== hex.encode(script.pkScript)) reject("locked outpoint script mismatch");
    if (
        coin.isSpent !== false ||
        coin.isSwept !== false ||
        coin.isUnrolled !== false ||
        coin.spentBy !== ""
    )
        reject("locked outpoint is not spendable");
    const now = clock(state.dependencies);
    if (coin.expiresAtHeight !== undefined && now.height === undefined)
        reject("height expiry cannot be evaluated without a chain height");
    if (!canSpendOffchain(coin, now)) reject("locked outpoint is expired or not spendable");
    const expiry = expiryFor(coin);
    if (coin.assets !== undefined && !Array.isArray(coin.assets))
        reject("locked outpoint assets are not an array");
    const holdings = (coin.assets ?? []).map(({ assetId: id, amount }) => {
        if (typeof id !== "string" || AssetId.fromString(id).toString() !== id || amount <= 0n)
            return reject("locked outpoint carries an invalid asset holding");
        return { id, amount };
    });
    if (new Set(holdings.map(({ id }) => id)).size !== holdings.length)
        reject("locked outpoint carries duplicate asset groups");
    const expectedId = assetId(state.params);
    const expectedUnits = state.contextAssetUnits;
    if (expectedId === undefined) {
        if (holdings.length) reject("bitcoin covenant unexpectedly carries assets");
    } else if (
        holdings.length !== 1 ||
        holdings[0].id !== expectedId ||
        expectedUnits === undefined ||
        holdings[0].amount !== expectedUnits
    ) {
        reject("locked outpoint asset identity or quantity mismatch");
    }
    return { expiry, holdings };
};

const observe = async (
    state: CoinExpectation,
): Promise<{ expiry: CapabilityState["expiry"]; holdings: Holding[] }> => {
    const response = await state.dependencies.indexer.getVtxos({
        outpoints: [state.outpoint],
    });
    if (!response || !Array.isArray(response.vtxos) || response.vtxos.length !== 1)
        reject("indexer did not return exactly the locked outpoint");
    return strictCoin(response.vtxos[0], state);
};

const activeState = (
    transfer: CovenantTransfer,
): CapabilityState & { script: DustCovenantScript } => {
    if (!transfer || typeof transfer !== "object")
        reject("unrecognized covenant-transfer capability");
    const retained = capabilities.get(transfer);
    if (retained === undefined) return reject("unrecognized covenant-transfer capability");
    lifecycleRegistry().claim(retained.lifecycle, (lifecycle) => {
        if (lifecycle.state !== "available")
            reject(
                lifecycle.expectedTxid
                    ? `capability already consumed; observe transaction ${lifecycle.expectedTxid}`
                    : "capability already consumed or in flight",
            );
        lifecycle.state = "consumed";
    });
    const params = immutablePlainCopy(retained.params, "retained covenant parameters");
    return {
        ...retained,
        params,
        serverKey: Uint8Array.from(retained.serverKey),
        emulatorKey: Uint8Array.from(retained.emulatorKey),
        holdings: retained.holdings.map((holding) => ({ ...holding })),
        script: new DustCovenantScript({
            serverKey: retained.serverKey,
            emulatorKey: retained.emulatorKey,
            params,
            vtxoMinAmount: retained.vtxoMinAmount,
        }),
    };
};

export async function verifyCovenantTransfer({
    verified,
    lockup: rawLockup,
    status: rawStatus,
    config: rawConfig,
}: VerifyCovenantTransferArgs): Promise<CovenantTransfer> {
    const quoteState = activeQuoteStateFor(verified);
    const expectedOutpoint = {
        txid: quoteState.validated.tx.id,
        vout: quoteState.validated.envelope.covenantOutputIndex,
    };
    const lockupView = immutablePlainCopy(rawLockup, "lockup response");
    const statusView = immutablePlainCopy(rawStatus, "transfer status");
    exactObjectKeys(
        lockupView as unknown as Record<string, unknown>,
        ["txid", "outpoint"],
        [],
        "lockup response",
    );
    exactObjectKeys(
        statusView as unknown as Record<string, unknown>,
        ["transferId", "state", "outpoint", "updatedAt"],
        ["spentTxid", "submissionPhase", "failureCode", "failureDetail"],
        "transfer status",
    );
    const lockup = decodeLockup(lockupView);
    const status = decodeStatus(statusView);
    const statusOutpoint = status.outpoint;
    if (status.transferId !== quoteState.transferId || status.state !== "locked" || !statusOutpoint)
        return reject("Taxi status is not the verified locked transfer");
    if (lockup.txid !== lockup.outpoint.txid) reject("lockup txid and outpoint disagree");
    exactOutpoint(lockup.outpoint, expectedOutpoint, "validated lockup outpoint");
    exactOutpoint(statusOutpoint, lockup.outpoint, "Taxi locked outpoint");
    if (status.spentTxid || status.failureCode || status.failureDetail)
        reject("Taxi status reports a spent or failed transfer");

    const decodedInfo = decodeInfo(quoteState.authorization.info);
    return verifyObservedClaim(
        {
            transferId: quoteState.transferId,
            outpoint: { ...lockup.outpoint },
            params: immutablePlainCopy(quoteState.context.params, "transfer covenant parameters"),
            serverKey: Uint8Array.from(quoteState.context.serverKey),
            emulatorKey: Uint8Array.from(quoteState.authorization.trustedEmulatorKey),
            vtxoMinAmount: quoteState.context.vtxoMinAmount,
            hrp: quoteState.context.hrp,
            trustedServerUnrollScript: quoteState.context.trustedServerUnrollScript,
            ...(quoteState.validated.envelope.assetUnits === undefined
                ? {}
                : { contextAssetUnits: BigInt(quoteState.validated.envelope.assetUnits) }),
        },
        decodedInfo,
        rawConfig,
    );
}

export async function verifyIncomingClaim(
    rawArgs: VerifyIncomingClaimArgs,
): Promise<CovenantTransfer> {
    const args = immutablePlainCopy(rawArgs, "incoming claim verification");
    exactObjectKeys(
        args as unknown as Record<string, unknown>,
        ["claim", "expect", "trusted", "config", "status"],
        [],
        "incoming claim verification",
    );
    const facts = incomingClaimFacts(args);
    assertIncomingStatus(args.status, facts);
    return verifyObservedClaim(facts, args.config, args.config);
}

type IncomingStatusReader = (transferId: string) => Promise<TransferStatusResponse>;

export async function verifyIncomingClaimWithFreshStatus(
    rawArgs: Omit<VerifyIncomingClaimArgs, "status">,
    readStatus: IncomingStatusReader,
): Promise<CovenantTransfer> {
    const args = immutablePlainCopy(rawArgs, "incoming claim verification");
    exactObjectKeys(
        args as unknown as Record<string, unknown>,
        ["claim", "expect", "trusted", "config"],
        [],
        "incoming claim verification",
    );
    return verifyObservedClaim(incomingClaimFacts(args), args.config, args.config, readStatus);
}

const incomingClaimFacts = (args: Omit<VerifyIncomingClaimArgs, "status">): ObservedClaimBase => {
    const { expect, trusted } = args;
    exactObjectKeys(
        expect as unknown as Record<string, unknown>,
        ["receiverAddress"],
        ["assetId", "assetUnits"],
        "incoming claim expectation",
    );
    exactObjectKeys(
        trusted as unknown as Record<string, unknown>,
        ["serverKey", "emulatorKey", "operatorKey", "vtxoMinAmount", "hrp"],
        [],
        "incoming claim trust",
    );
    for (const key of [trusted.serverKey, trusted.emulatorKey, trusted.operatorKey])
        if (!(key instanceof Uint8Array) || key.length !== 32)
            reject("trusted identity must be a 32-byte public key");
    if (typeof trusted.vtxoMinAmount !== "bigint" || trusted.vtxoMinAmount <= 0n)
        reject("trusted minimum VTXO amount is invalid");
    if (typeof trusted.hrp !== "string" || !trusted.hrp) reject("trusted address HRP is invalid");
    const claim = decodeClaimsSnapshot({ claims: [args.claim] }).claims[0]!;
    if (claim.state !== "locked" || claim.claimable !== true || claim.claim === undefined)
        return reject("incoming claim is not a claimable locked transfer");
    const descriptor = claim.claim;
    if (
        typeof expect.receiverAddress !== "string" ||
        claim.receiverAddress !== expect.receiverAddress
    )
        reject("incoming receiver address mismatch");
    const receiver = ArkAddress.decode(expect.receiverAddress);
    if (receiver.encode() !== expect.receiverAddress)
        reject("incoming receiver address is not canonical");
    if (receiver.hrp !== trusted.hrp) reject("incoming receiver address HRP mismatch");
    exactBytes(receiver.serverPubKey, trusted.serverKey, "incoming receiver server key");
    const params = quoteParamsFromWire(descriptor.params);
    exactBytes(receiver.vtxoTaprootKey, params.receiverKey, "incoming receiver key");
    exactBytes(params.operatorKey, trusted.operatorKey, "incoming operator key");
    if (expect.assetId !== undefined) {
        exactObjectKeys(
            expect.assetId as unknown as Record<string, unknown>,
            ["txid", "groupIndex"],
            [],
            "expected asset identity",
        );
        if (!(expect.assetId.txid instanceof Uint8Array) || expect.assetId.txid.length !== 32)
            reject("expected asset txid must be 32 bytes");
    }
    if (params.assetId === undefined) {
        if (
            expect.assetId !== undefined ||
            expect.assetUnits !== undefined ||
            descriptor.assetUnits !== undefined
        )
            reject("bitcoin claim unexpectedly declares assets");
    } else {
        if (
            expect.assetId === undefined ||
            !sameBytes(params.assetId.txid, expect.assetId.txid) ||
            params.assetId.groupIndex !== expect.assetId.groupIndex
        )
            reject("incoming asset identity mismatch");
        if (
            typeof expect.assetUnits !== "bigint" ||
            expect.assetUnits <= 0n ||
            descriptor.assetUnits === undefined ||
            BigInt(descriptor.assetUnits) !== expect.assetUnits
        )
            reject("incoming asset quantity mismatch");
    }
    const batchExpiry = {
        kind: descriptor.batchExpiry.kind,
        value: BigInt(descriptor.batchExpiry.value),
    };
    if (
        params.locktime <= 0n ||
        params.locktime > 0xffff_ffffn ||
        descriptor.recoveryLocktime.kind !== (params.locktime < 500_000_000n ? "height" : "time") ||
        descriptor.recoveryLocktime.kind !== batchExpiry.kind ||
        BigInt(descriptor.recoveryLocktime.value) !== params.locktime ||
        batchExpiry.value <= params.locktime
    )
        reject("incoming tagged recovery locktime or batch expiry mismatch");
    const script = new DustCovenantScript({
        serverKey: trusted.serverKey,
        emulatorKey: trusted.emulatorKey,
        params,
        vtxoMinAmount: trusted.vtxoMinAmount,
    });
    if (script.address(trusted.hrp, trusted.serverKey).encode() !== descriptor.covenantAddress)
        reject("incoming covenant address mismatch");
    return {
        transferId: claim.transferId,
        outpoint: { ...descriptor.outpoint },
        params,
        serverKey: trusted.serverKey,
        emulatorKey: trusted.emulatorKey,
        vtxoMinAmount: trusted.vtxoMinAmount,
        hrp: trusted.hrp,
        batchExpiry,
        ...(expect.assetUnits === undefined ? {} : { contextAssetUnits: expect.assetUnits }),
    };
};

const assertIncomingStatus = (
    rawStatus: TransferStatusResponse,
    facts: Pick<ObservedClaimBase, "transferId" | "outpoint">,
): void => {
    const status = immutablePlainCopy(rawStatus, "transfer status");
    exactObjectKeys(
        status as unknown as Record<string, unknown>,
        ["transferId", "state", "outpoint", "updatedAt"],
        ["spentTxid", "submissionPhase", "failureCode", "failureDetail"],
        "transfer status",
    );
    decodeStatus(status);
    if (status.transferId !== facts.transferId || status.state !== "locked" || !status.outpoint)
        return reject("Taxi status is not the incoming locked transfer");
    exactObjectKeys(status.outpoint, ["txid", "vout"], [], "Taxi locked outpoint");
    exactOutpoint(status.outpoint, facts.outpoint, "Taxi locked outpoint");
    if (status.spentTxid || status.failureCode || status.failureDetail)
        reject("Taxi status reports a spent or failed transfer");
};

type ObservedClaimBase = Omit<CoinExpectation, "dependencies" | "arkdUrl" | "emulatorUrl"> & {
    trustedServerUnrollScript?: Uint8Array;
    batchExpiry?: CapabilityState["expiry"];
};

async function verifyObservedClaim(
    facts: ObservedClaimBase,
    advertisedUrls: Pick<CovenantSpendConfig, "arkdUrl" | "emulatorUrl">,
    rawConfig: CovenantSpendConfig,
    readStatus?: IncomingStatusReader,
): Promise<CovenantTransfer> {
    const arkdUrl = normalizeUrl(advertisedUrls.arkdUrl, "advertised arkd URL");
    const emulatorUrl = normalizeUrl(advertisedUrls.emulatorUrl, "advertised emulator URL");
    if (
        rawConfig &&
        typeof rawConfig === "object" &&
        ["arkProvider", "indexer", "emulator"].some((key) => key in rawConfig)
    )
        reject("custom provider objects are not accepted; provide pinned provider URLs");
    const config = immutablePlainCopy(rawConfig, "covenant spend config");
    const configDescriptors = Object.getOwnPropertyDescriptors(config);
    exactObjectKeys(
        configDescriptors as unknown as Record<string, unknown>,
        ["arkdUrl", "emulatorUrl", "network", "serverUnrollScript"],
        ["chainHeight"],
        "covenant spend dependencies",
    );
    for (const [key, descriptor] of Object.entries(configDescriptors))
        if (!("value" in descriptor) || !descriptor.enumerable)
            reject(`covenant spend dependency ${key} must be an enumerable data property`);
    if (
        normalizeUrl(config.arkdUrl, "configured arkd URL") !== arkdUrl ||
        normalizeUrl(config.emulatorUrl, "configured emulator URL") !== emulatorUrl
    )
        reject("provider identity does not match the verified Taxi operator");
    if (typeof config.network !== "string" || !config.network)
        reject("configured network is invalid");
    if (
        config.chainHeight !== undefined &&
        (!Number.isSafeInteger(config.chainHeight) || config.chainHeight < 0)
    )
        reject("configured chain height is invalid");
    let serverUnrollScript: CSVMultisigTapscript.Type;
    try {
        const encoded = hex.decode(config.serverUnrollScript);
        if (hex.encode(encoded) !== config.serverUnrollScript)
            reject("server unroll script is not canonical lowercase hex");
        serverUnrollScript = CSVMultisigTapscript.decode(encoded);
    } catch (cause) {
        return reject(
            `server unroll script is invalid: ${cause instanceof Error ? cause.message : String(cause)}`,
        );
    }
    const registry = lifecycleRegistry();
    const isolatedArk = pinProvider(new RestArkProvider(arkdUrl), restArkPrototype, arkdUrl);
    const isolatedIndexer = pinProvider(
        new RestIndexerProvider(arkdUrl),
        restIndexerPrototype,
        arkdUrl,
    );
    const isolatedEmulator = pinProvider(
        new RestEmulatorProvider(emulatorUrl),
        restEmulatorPrototype,
        emulatorUrl,
    );
    const boundDependencies: SpendDependencies = Object.freeze({
        arkProvider: Object.freeze({
            getInfo: capturedCall(isolatedArk, restArkGetInfo, arkdUrl, "ark") as () => ReturnType<
                RestArkProvider["getInfo"]
            >,
        }),
        emulator: Object.freeze({
            getInfo: capturedCall(isolatedEmulator, restEmulatorGetInfo, emulatorUrl, "emulator"),
            submitTx: capturedCall(isolatedEmulator, restEmulatorSubmitTx, emulatorUrl, "emulator"),
        }) as unknown as SpendDependencies["emulator"],
        indexer: Object.freeze({
            getVtxos: capturedCall(isolatedIndexer, restIndexerGetVtxos, arkdUrl, "indexer"),
            getVirtualTxs: capturedCall(
                isolatedIndexer,
                restIndexerGetVirtualTxs,
                arkdUrl,
                "indexer",
            ),
        }) as unknown as SpendDependencies["indexer"],
        network: config.network,
        serverUnrollScript,
        ...(config.chainHeight === undefined ? {} : { chainHeight: config.chainHeight }),
    });
    const [arkInfo, emulatorInfo] = await Promise.all([
        boundDependencies.arkProvider.getInfo(),
        boundDependencies.emulator.getInfo(),
    ]);
    const info = arkInfo as ArkInfo;
    if (
        facts.trustedServerUnrollScript !== undefined &&
        !sameBytes(boundDependencies.serverUnrollScript.script, facts.trustedServerUnrollScript)
    )
        reject("trusted server unroll script changed");
    validateProviderFacts(
        {
            network: boundDependencies.network,
            serverKey: facts.serverKey,
            emulatorKey: facts.emulatorKey,
            dust: facts.params.dust,
            vtxoMinAmount: facts.vtxoMinAmount,
            serverUnrollScript: boundDependencies.serverUnrollScript.script,
        },
        info,
        emulatorInfo,
    );

    const base: CoinExpectation = {
        ...facts,
        dependencies: boundDependencies,
        arkdUrl,
        emulatorUrl,
    };
    const observed = await observe(base);
    if (
        facts.batchExpiry !== undefined &&
        (observed.expiry.kind !== facts.batchExpiry.kind ||
            observed.expiry.value !== facts.batchExpiry.value)
    )
        reject("observed batch expiry mismatch");
    if (readStatus !== undefined) assertIncomingStatus(await readStatus(facts.transferId), facts);
    const lifecycleKey = [
        boundDependencies.network,
        arkdUrl,
        emulatorUrl,
        hex.encode(facts.serverKey),
        hex.encode(facts.emulatorKey),
        facts.outpoint.txid,
        facts.outpoint.vout,
    ].join("|");
    const lifecycle = registry.getOrCreate(lifecycleKey, () => ({
        state: "available",
    }));
    const retained: CapabilityState = {
        ...base,
        expiry: { ...observed.expiry },
        holdings: observed.holdings.map((holding) => ({ ...holding })),
        lifecycle,
    };
    const result = immutablePlainCopy(
        {
            transferId: retained.transferId,
            outpoint: retained.outpoint,
            value: retained.params.dust,
            expiry: retained.expiry,
        },
        "covenant transfer view",
    ) as CovenantTransfer;
    capabilities.set(result, retained);
    return result;
}

const unsignedCopy = (tx: Transaction): Transaction => {
    const copy = Transaction.fromPSBT(tx.toPSBT());
    for (let index = 0; index < copy.inputsLength; index++)
        copy.updateInput(index, { tapScriptSig: undefined });
    return copy;
};

const assertCanonical = (tx: Transaction, label: string): void => {
    try {
        assertAllowedSighashTypes(tx, [SigHash.DEFAULT]);
    } catch (cause) {
        reject(
            `${label} has a non-DEFAULT signature: ${cause instanceof Error ? cause.message : String(cause)}`,
        );
    }
    for (let index = 0; index < tx.inputsLength; index++)
        for (const [, signature] of tx.getInput(index).tapScriptSig ?? [])
            if (signature.length !== 64)
                reject(`${label} input ${index} signature is not canonical DEFAULT`);
};

const exactSigners = (tx: Transaction, index: number, label: string): void => {
    const input = tx.getInput(index);
    const leaf = input.tapLeafScript;
    if (!leaf || leaf.length !== 1) return reject(`${label} does not select exactly one leaf`);
    const selected = leaf[0];
    if (!selected) reject(`${label} has no selected leaf`);
    const body = scriptFromTapLeafScript(selected);
    const closure = MultisigTapscript.decode(body);
    const signatures = input.tapScriptSig ?? [];
    const expectedHash = tapLeafHash(body, selected[1][selected[1].length - 1]);
    if (signatures.length !== closure.params.pubkeys.length)
        reject(`${label} signer count mismatch`);
    const expected = new Map(closure.params.pubkeys.map((key) => [hex.encode(key), 0]));
    for (const [metadata] of signatures) {
        const key = hex.encode(metadata.pubKey);
        if (!expected.has(key) || !sameBytes(metadata.leafHash, expectedHash))
            reject(`${label} contains an unexpected signer or leaf hash`);
        expected.set(key, expected.get(key)! + 1);
    }
    if ([...expected.values()].some((count) => count !== 1)) reject(`${label} signer set mismatch`);
    try {
        verifyTapscriptSignatures(
            tx,
            index,
            closure.params.pubkeys.map((key) => hex.encode(key)),
            [],
            [SigHash.DEFAULT],
            expectedHash,
        );
    } catch (cause) {
        reject(
            `${label} signature verification failed: ${cause instanceof Error ? cause.message : String(cause)}`,
        );
    }
};

const exactHumanSignature = (
    before: Transaction,
    after: Transaction,
    index: number,
    humanKey: Uint8Array,
    label: string,
): void => {
    const find = (tx: Transaction) =>
        (tx.getInput(index).tapScriptSig ?? []).find(([metadata]) =>
            sameBytes(metadata.pubKey, humanKey),
        );
    const original = find(before);
    const final = find(after);
    if (
        !original ||
        !final ||
        !sameBytes(original[0].leafHash, final[0].leafHash) ||
        !sameBytes(original[1], final[1])
    )
        reject(`${label} did not preserve the human signature`);
};

const decodeCanonicalPsbt = (encoded: string, label: string): Transaction => {
    let bytes: Uint8Array;
    try {
        bytes = base64.decode(encoded);
    } catch {
        return reject(`${label} is not base64`);
    }
    if (base64.encode(bytes) !== encoded) reject(`${label} is not canonical base64`);
    try {
        return Transaction.fromPSBT(bytes);
    } catch (cause) {
        return reject(
            `${label} is not a PSBT: ${cause instanceof Error ? cause.message : String(cause)}`,
        );
    }
};

const validateOwnerSigned = (
    signed: Transaction,
    unsigned: Transaction,
    indexes: readonly number[],
    owner: Uint8Array,
    label: string,
): void => {
    assertCanonical(signed, label);
    exactBytes(unsignedCopy(signed).toPSBT(), unsigned.toPSBT(), `${label} unsigned transaction`);
    for (let index = 0; index < signed.inputsLength; index++) {
        const signatures = signed.getInput(index).tapScriptSig ?? [];
        if (!indexes.includes(index)) {
            if (signatures.length) reject(`${label} signed unowned input ${index}`);
            continue;
        }
        if (signatures.length !== 1 || !sameBytes(signatures[0][0].pubKey, owner))
            reject(`${label} was not signed only by its owner at input ${index}`);
        try {
            verifyTapscriptSignatures(signed, index, [hex.encode(owner)], [], [SigHash.DEFAULT]);
        } catch (cause) {
            reject(
                `${label} owner signature failed: ${cause instanceof Error ? cause.message : String(cause)}`,
            );
        }
    }
};

const identityKey = async (identity: Identity, expected: Uint8Array, label: string) => {
    const key = copyByteView(await identity.xOnlyPublicKey(), `${label} identity public key`);
    if (key.length !== 32) reject(`${label} identity returned an invalid public key`);
    if (!sameBytes(key, expected)) reject(`${label} identity does not own the required leaf`);
    return key;
};

const exactFundingInput = async (
    funding: ReceiverWalletInput,
    state: CapabilityState & { script: DustCovenantScript },
): Promise<{ tree: VtxoScript; key: Uint8Array; holdings: Holding[] }> => {
    const key = copyByteView(
        await funding.identity.xOnlyPublicKey(),
        "receiver identity public key",
    );
    if (key.length !== 32) reject("receiver identity returned an invalid public key");
    let tree: VtxoScript;
    try {
        tree = VtxoScript.decode(funding.input.tapTree);
    } catch (cause) {
        return reject(
            `receiver input tree is invalid: ${cause instanceof Error ? cause.message : String(cause)}`,
        );
    }
    exactBytes(tree.encode(), funding.input.tapTree, "receiver input tree encoding");
    exactBytes(
        tree.pkScript,
        new Uint8Array([0x51, 0x20, ...state.params.receiverKey]),
        "receiver input script",
    );
    const body = scriptFromTapLeafScript(funding.input.tapLeafScript);
    const exactLeaf = tree.findLeaf(hex.encode(body));
    exactTapLeaf(funding.input.tapLeafScript, exactLeaf, "receiver selected leaf");
    const closure = MultisigTapscript.decode(body);
    if (
        closure.params.pubkeys.length !== 2 ||
        sameBytes(key, state.serverKey) ||
        !closure.params.pubkeys.some((pubkey) => sameBytes(pubkey, state.serverKey)) ||
        !closure.params.pubkeys.some((pubkey) => sameBytes(pubkey, key))
    )
        reject("receiver input leaf signer requirements mismatch");
    if (
        typeof funding.input.value !== "bigint" ||
        funding.input.value <= 0n ||
        funding.input.value > BigInt(Number.MAX_SAFE_INTEGER)
    )
        reject("receiver input value exceeds the SDK safe integer range");
    if (
        (funding.expiry.kind !== "time" && funding.expiry.kind !== "height") ||
        funding.expiry.value <= 0n
    )
        reject("receiver input expiry is invalid");
    return { tree, key, holdings: holdingsFromPacket(funding.input) };
};

const packetForSpend = (
    sources: readonly Holding[][],
    destinationVout: number,
): AssetPacket | undefined => {
    const totals = new Map<string, bigint>();
    sources.forEach((holdings) =>
        holdings.forEach(({ id, amount }) => totals.set(id, (totals.get(id) ?? 0n) + amount)),
    );
    if (!totals.size) return undefined;
    return Packet.create(
        [...totals]
            .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
            .map(([id, amount]) =>
                AssetGroup.create(
                    AssetId.fromString(id),
                    null,
                    sources.flatMap((holdings, vin) =>
                        holdings.some((holding) => holding.id === id)
                            ? [
                                  AssetInput.create(
                                      vin,
                                      holdings.find((holding) => holding.id === id)!.amount,
                                  ),
                              ]
                            : [],
                    ),
                    [AssetOutput.create(destinationVout, amount)],
                    [],
                ),
            ),
    );
};

interface SpendPlan {
    leaf: Leaf;
    inputs: CovenantSpendInput[];
    outputs: { script: Uint8Array; amount: bigint }[];
    assetPacket?: AssetPacket;
    human?: { identity: Identity; key: Uint8Array; indexes: number[] };
}

const refresh = async (
    state: CapabilityState & { script: DustCovenantScript },
    funding?: ReceiverWalletInput,
): Promise<void> => {
    const outpoints = [
        state.outpoint,
        ...(funding ? [{ txid: funding.input.txid, vout: funding.input.vout }] : []),
    ];
    const response = await state.dependencies.indexer.getVtxos({ outpoints });
    if (!response || !Array.isArray(response.vtxos) || response.vtxos.length !== outpoints.length)
        reject("indexer did not return every exact spend input");
    const covenantCoin = response.vtxos.find(
        (coin) => coin.txid === state.outpoint.txid && coin.vout === state.outpoint.vout,
    );
    if (covenantCoin === undefined) return reject("indexer omitted the locked covenant outpoint");
    const current = strictCoin(covenantCoin, {
        ...state,
        contextAssetUnits: state.holdings[0]?.amount,
    });
    if (
        current.expiry.kind !== state.expiry.kind ||
        current.expiry.value !== state.expiry.value ||
        holdingsPacket(current.holdings, state.outpoint.vout)?.toString() !==
            holdingsPacket(state.holdings, state.outpoint.vout)?.toString()
    )
        reject("locked covenant facts changed after verification");
    if (!funding) return;
    const coin = response.vtxos.find(
        (candidate) =>
            candidate.txid === funding.input.txid && candidate.vout === funding.input.vout,
    );
    if (coin === undefined) return reject("indexer omitted the receiver funding outpoint");
    if (
        coin.value !== Number(funding.input.value) ||
        coin.script !== hex.encode(VtxoScript.decode(funding.input.tapTree).pkScript) ||
        coin.isSpent !== false ||
        coin.isSwept !== false ||
        coin.isUnrolled !== false ||
        coin.spentBy !== "" ||
        !canSpendOffchain(coin, clock(state.dependencies))
    )
        reject("receiver funding input is not independently spendable");
    const expiry = expiryFor(coin);
    if (expiry.kind !== funding.expiry.kind || expiry.value !== funding.expiry.value)
        reject("receiver funding expiry mismatch");
    if (coin.assets !== undefined && !Array.isArray(coin.assets))
        reject("receiver funding assets are not an array");
    const observedHoldings = (coin.assets ?? [])
        .map(({ assetId: id, amount }) => ({ id, amount }))
        .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    const provided = holdingsFromPacket(funding.input).sort((a, b) =>
        a.id < b.id ? -1 : a.id > b.id ? 1 : 0,
    );
    if (
        JSON.stringify(observedHoldings, (_, value) =>
            typeof value === "bigint" ? value.toString() : value,
        ) !==
        JSON.stringify(provided, (_, value) =>
            typeof value === "bigint" ? value.toString() : value,
        )
    )
        reject("receiver funding asset holdings mismatch");
};

const execute = async (
    state: CapabilityState & { script: DustCovenantScript },
    plan: SpendPlan,
    funding?: ReceiverWalletInput,
): Promise<string> => {
    await refresh(state, funding);
    const maxOpReturnOutputs = await freshProviderFacts(state);
    const packets = [
        ...(plan.assetPacket ? [plan.assetPacket] : []),
        EmulatorPacket.create([
            {
                vin: 0,
                script: state.script.covenant[
                    plan.leaf === Leaf.Recycle
                        ? "recycle"
                        : plan.leaf === Leaf.Purchase
                          ? "purchase"
                          : "refund"
                ],
            },
        ]),
    ];
    const extension = Extension.create(packets).txOut();
    const opReturns = [...plan.outputs, extension].filter(
        ({ script }) => script[0] === 0x6a,
    ).length;
    if (maxOpReturnOutputs !== undefined && BigInt(opReturns) > maxOpReturnOutputs)
        reject("spend exceeds the Ark provider OP_RETURN limit");
    const needsRefundExtensionPlacement = opReturns > 2;
    if (needsRefundExtensionPlacement) {
        if (
            plan.leaf !== Leaf.RefundSender ||
            plan.outputs.length !== 2 ||
            plan.outputs.some(({ script }) => script[0] !== 0x6a)
        )
            reject("unsupported three-OP_RETURN spend shape");
        if (maxOpReturnOutputs === undefined)
            reject("Ark provider did not advertise three-OP_RETURN capacity");
    }
    const graph = buildOffchainTx(
        plan.inputs.map((input) => ({
            txid: input.txid,
            vout: input.vout,
            value: Number(input.value),
            tapTree: input.tapTree,
            tapLeafScript: input.tapLeafScript,
        })),
        needsRefundExtensionPlacement ? plan.outputs : [...plan.outputs, extension],
        state.dependencies.serverUnrollScript,
    );
    if (needsRefundExtensionPlacement) {
        const p2aIndex = graph.arkTx.outputsLength - 1;
        graph.arkTx.updateOutput(p2aIndex, extension);
        graph.arkTx.addOutput(P2A);
    }
    if (graph.arkTx.inputsLength !== plan.inputs.length) reject("builder changed input count");
    plan.inputs.forEach((input, index) => {
        const actual = graph.arkTx.getInput(index);
        const checkpointInput = graph.checkpoints[index].getInput(0);
        if (
            actual.index !== 0 ||
            hex.encode(actual.txid!) !== graph.checkpoints[index].id ||
            checkpointInput.index !== input.vout ||
            hex.encode(checkpointInput.txid!) !== input.txid
        )
            reject(`builder changed checkpoint/input order at ${index}`);
    });
    plan.outputs.forEach((output, index) => {
        const actual = graph.arkTx.getOutput(index);
        if (actual.amount !== output.amount) reject(`builder changed output value at ${index}`);
        exactBytes(actual.script!, output.script, `builder output script ${index}`);
    });
    const actualExtension = graph.arkTx.getOutput(plan.outputs.length);
    if (actualExtension.amount !== extension.amount)
        reject("builder changed the covenant extension value");
    exactBytes(actualExtension.script!, extension.script!, "builder covenant extension script");
    const p2a = graph.arkTx.getOutput(graph.arkTx.outputsLength - 1);
    if (p2a.amount !== P2A.amount || !sameBytes(p2a.script!, P2A.script))
        reject("builder changed the required P2A output");
    await attachPrevArkTxs(
        graph.arkTx,
        plan.inputs.map(({ txid }) => txid),
        state.dependencies.indexer,
    );

    let ownerArk = Transaction.fromPSBT(graph.arkTx.toPSBT());
    let ownerCheckpoints = graph.checkpoints.map((checkpoint) =>
        Transaction.fromPSBT(checkpoint.toPSBT()),
    );
    if (plan.human) {
        const signatureCapacity = await freshProviderFacts(state);
        if (signatureCapacity !== undefined && BigInt(opReturns) > signatureCapacity)
            reject("spend exceeds the refreshed Ark provider OP_RETURN limit");
        if (needsRefundExtensionPlacement && signatureCapacity === undefined)
            reject("Ark provider no longer advertises three-OP_RETURN capacity");
        ownerArk = signerTransaction(
            await plan.human.identity.sign(ownerArk, plan.human.indexes),
            "owner Ark transaction",
        );
        validateOwnerSigned(
            ownerArk,
            graph.arkTx,
            plan.human.indexes,
            plan.human.key,
            "owner Ark transaction",
        );
        ownerCheckpoints = await Promise.all(
            ownerCheckpoints.map((checkpoint, index) =>
                plan.human!.indexes.includes(index)
                    ? plan
                          .human!.identity.sign(checkpoint, [0])
                          .then((signed) => signerTransaction(signed, `owner checkpoint ${index}`))
                    : checkpoint,
            ),
        );
        ownerCheckpoints.forEach((checkpoint, index) =>
            validateOwnerSigned(
                checkpoint,
                graph.checkpoints[index],
                plan.human!.indexes.includes(index) ? [0] : [],
                plan.human!.key,
                `owner checkpoint ${index}`,
            ),
        );
    }

    state.lifecycle.expectedTxid = ownerArk.id;

    const submissionCapacity = await freshProviderFacts(state);
    if (submissionCapacity !== undefined && BigInt(opReturns) > submissionCapacity)
        reject("spend exceeds the refreshed Ark provider OP_RETURN limit");
    if (needsRefundExtensionPlacement && submissionCapacity === undefined)
        reject("Ark provider no longer advertises three-OP_RETURN capacity");

    let response: Awaited<ReturnType<EmulatorProvider["submitTx"]>>;
    try {
        response = await state.dependencies.emulator.submitTx(
            base64.encode(ownerArk.toPSBT()),
            ownerCheckpoints.map((checkpoint) => base64.encode(checkpoint.toPSBT())),
        );
    } catch (cause) {
        throw new CovenantSpendAmbiguousError(ownerArk.id, cause);
    }
    try {
        const safe = immutablePlainCopy(response, "emulator response") as typeof response;
        exactObjectKeys(
            safe as unknown as Record<string, unknown>,
            ["signedArkTx", "signedCheckpointTxs"],
            [],
            "emulator response",
        );
        if (typeof safe.signedArkTx !== "string" || !Array.isArray(safe.signedCheckpointTxs))
            reject("emulator returned a malformed final graph");
        if (safe.signedCheckpointTxs.length !== graph.checkpoints.length)
            reject("emulator final checkpoint count mismatch");
        const finalArk = decodeCanonicalPsbt(safe.signedArkTx, "emulator Ark transaction");
        assertCanonical(finalArk, "emulator Ark transaction");
        exactBytes(
            unsignedCopy(finalArk).toPSBT(),
            unsignedCopy(ownerArk).toPSBT(),
            "emulator Ark unsigned transaction and metadata",
        );
        if (finalArk.id !== ownerArk.id) reject("emulator changed the Ark transaction id");
        for (let index = 0; index < finalArk.inputsLength; index++) {
            exactSigners(finalArk, index, `emulator Ark input ${index}`);
            if (plan.human?.indexes.includes(index))
                exactHumanSignature(
                    ownerArk,
                    finalArk,
                    index,
                    plan.human.key,
                    `Ark input ${index}`,
                );
        }
        safe.signedCheckpointTxs.forEach((encoded, index) => {
            if (typeof encoded !== "string") reject(`emulator checkpoint ${index} is not a string`);
            const final = decodeCanonicalPsbt(encoded, `emulator checkpoint ${index}`);
            assertCanonical(final, `emulator checkpoint ${index}`);
            exactBytes(
                unsignedCopy(final).toPSBT(),
                graph.checkpoints[index].toPSBT(),
                `emulator checkpoint ${index} unsigned transaction and metadata`,
            );
            if (final.id !== graph.checkpoints[index].id)
                reject(`emulator checkpoint ${index} changed or reordered`);
            exactSigners(final, 0, `emulator checkpoint ${index}`);
            if (plan.human?.indexes.includes(index))
                exactHumanSignature(
                    ownerCheckpoints[index],
                    final,
                    0,
                    plan.human.key,
                    `checkpoint ${index}`,
                );
        });
        return finalArk.id;
    } catch (cause) {
        if (cause instanceof CovenantSpendAmbiguousError) throw cause;
        throw new CovenantSpendAmbiguousError(ownerArk.id, cause);
    }
};

const receiverDestination = (state: CapabilityState): Uint8Array =>
    new Uint8Array([0x51, 0x20, ...state.params.receiverKey]);

const exactDestination = (actual: Uint8Array, state: CapabilityState): Uint8Array => {
    const destination = copyByteView(actual, "destination");
    if (!sameBytes(destination, receiverDestination(state)))
        reject("destination is not the verified receiver account script");
    return destination;
};

export async function purchase(
    transfer: CovenantTransfer,
    destination: Uint8Array,
): Promise<string> {
    const state = activeState(transfer);
    const output = exactDestination(destination, state);
    if (state.params.dust < state.vtxoMinAmount)
        reject("purchase output is below the Ark operator minimum");
    const input = covenantSpendInput(
        state.script,
        Leaf.Purchase,
        state.outpoint,
        state.params.dust,
        holdingsPacket(state.holdings, state.outpoint.vout),
    );
    return execute(state, {
        leaf: Leaf.Purchase,
        inputs: [input],
        outputs: [{ script: output, amount: state.params.dust }],
        assetPacket: packetForSpend([state.holdings], 0),
    });
}

export async function recycle(
    transfer: CovenantTransfer,
    receiverWalletInput: ReceiverWalletInput,
    destination: Uint8Array,
): Promise<string> {
    const state = activeState(transfer);
    receiverWalletInput = receiverInputSnapshot(receiverWalletInput);
    const output = exactDestination(destination, state);
    const funding = await exactFundingInput(receiverWalletInput, state);
    const merged = state.params.dust + receiverWalletInput.input.value - state.params.topup;
    if (merged < state.params.dust || merged < state.vtxoMinAmount)
        reject("recycle receiver output is below dust or the Ark operator minimum");
    const covenant = covenantSpendInput(
        state.script,
        Leaf.Recycle,
        state.outpoint,
        state.params.dust,
        holdingsPacket(state.holdings, state.outpoint.vout),
    );
    return execute(
        state,
        {
            leaf: Leaf.Recycle,
            inputs: [covenant, receiverWalletInput.input],
            outputs: [
                {
                    script: payoutPkScript(
                        state.params.operatorKey,
                        state.params.topup,
                        state.params.dust,
                    ),
                    amount: state.params.topup,
                },
                { script: output, amount: merged },
            ],
            assetPacket: packetForSpend([state.holdings, funding.holdings], 1),
            human: { identity: receiverWalletInput.identity, key: funding.key, indexes: [1] },
        },
        receiverWalletInput,
    );
}

export async function refund(
    transfer: CovenantTransfer,
    senderIdentity: Identity,
): Promise<string> {
    const state = activeState(transfer);
    const sender = await identityKey(senderIdentity, state.params.senderKey, "sender");
    const topup = refundTopup(state.params, state.vtxoMinAmount);
    const returned = state.params.dust - topup;
    const input = covenantSpendInput(
        state.script,
        Leaf.RefundSender,
        state.outpoint,
        state.params.dust,
        holdingsPacket(state.holdings, state.outpoint.vout),
    );
    return execute(state, {
        leaf: Leaf.RefundSender,
        inputs: [input],
        outputs: [
            {
                script: payoutPkScript(state.params.operatorKey, topup, state.params.dust),
                amount: topup,
            },
            {
                script: payoutPkScript(state.params.senderKey, returned, state.params.dust),
                amount: returned,
            },
        ],
        assetPacket: packetForSpend([state.holdings], 1),
        human: { identity: senderIdentity, key: sender, indexes: [0] },
    });
}
