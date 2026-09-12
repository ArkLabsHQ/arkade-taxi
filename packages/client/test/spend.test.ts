import { describe, expect, it, vi } from "vitest";
import { runInNewContext } from "node:vm";
import {
    ArkAddress,
    CSVMultisigTapscript,
    DefaultVtxo,
    Extension,
    MultisigTapscript,
    P2A,
    RestEmulatorProvider,
    RestIndexerProvider,
    SingleKey,
    Transaction,
    VtxoScript,
    asset,
    arkade,
    buildOffchainTx,
    type ArkInfo,
    type Identity,
    type VirtualCoin,
} from "@arkade-os/sdk";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { base64, hex } from "@scure/base";
import { verifyQuote } from "../src/verify.js";
import { activeQuoteStateFor } from "../src/lockup.js";
import { payoutPkScript, refundTopup } from "@arkade-taxi/covenant";
import { fareFromWire, quoteParamsFromWire, type ReceiverClaimWire } from "@arkade-taxi/protocol";
import { TaxiClient } from "../src/client.js";
import {
    purchase,
    recycle,
    refund,
    verifyCovenantTransfer,
    verifyIncomingClaim,
    CovenantSpendAmbiguousError,
    type CovenantSpendConfig,
    type CovenantTransfer,
    type ReceiverWalletInput,
    type VerifyIncomingClaimArgs,
} from "../src/spend.js";
import {
    NOW,
    args,
    assetArgs,
    emulatorKey,
    info,
    operatorKey,
    otherKey,
    params,
    quote,
    receiverKey,
    senderIdentity,
    serverKey,
    unroll,
    VTXO_MIN,
} from "./fixtures.js";

const bytesToNumber = (bytes: Uint8Array): bigint => BigInt(`0x${hex.encode(bytes)}`);
const numberToBytes = (value: bigint): Uint8Array =>
    hex.decode(value.toString(16).padStart(64, "0"));

const serverIdentity = SingleKey.fromPrivateKey(new Uint8Array(32).fill(4));
let setupSequence = 0n;
const emulatorIdentity = (script: Uint8Array): SingleKey => {
    const curve = secp256k1.Point.CURVE();
    const original = bytesToNumber(new Uint8Array(32).fill(5));
    const point = secp256k1.Point.BASE.multiply(original);
    const normalized = (point.y & 1n) === 0n ? original : curve.n - original;
    return SingleKey.fromPrivateKey(
        numberToBytes((normalized + bytesToNumber(arkade.arkadeScriptHash(script))) % curve.n),
    );
};

const source = (fill = 0x11): Transaction => {
    const tx = new Transaction({ version: 3, lockTime: 0 });
    tx.addInput({ txid: fill.toString(16).padStart(2, "0").repeat(32), index: 0 });
    tx.addOutput({ amount: 330n, script: new Uint8Array([0x51]) });
    return tx;
};

const finalGraph = async (arkTx: string, checkpoints: string[], covenantScript: Uint8Array) => {
    let ark = Transaction.fromPSBT(base64.decode(arkTx));
    ark = await serverIdentity.sign(
        ark,
        Array.from({ length: ark.inputsLength }, (_, index) => index),
    );
    ark = await emulatorIdentity(covenantScript).sign(ark, [0]);
    const cps = await Promise.all(
        checkpoints.map(async (encoded, index) => {
            let checkpoint = Transaction.fromPSBT(base64.decode(encoded));
            checkpoint = await serverIdentity.sign(checkpoint, [0]);
            return index === 0
                ? emulatorIdentity(covenantScript).sign(checkpoint, [0])
                : checkpoint;
        }),
    );
    return {
        signedArkTx: base64.encode(ark.toPSBT()),
        signedCheckpointTxs: cps.map((checkpoint) => base64.encode(checkpoint.toPSBT())),
    };
};

const json = (value: unknown): Response =>
    new Response(JSON.stringify(value), {
        status: 200,
        headers: { "content-type": "application/json" },
    });

const arkInfoWire = (value: ArkInfo): Record<string, unknown> => ({
    network: value.network,
    signerPubkey: value.signerPubkey,
    forfeitPubkey: value.forfeitPubkey,
    checkpointTapscript: value.checkpointTapscript,
    dust: value.dust.toString(),
    vtxoMinAmount: value.vtxoMinAmount.toString(),
    ...(value.maxOpReturnOutputs === undefined
        ? {}
        : { maxOpReturnOutputs: String(value.maxOpReturnOutputs) }),
});

const vtxoWire = (coin: VirtualCoin): Record<string, unknown> => ({
    outpoint: { txid: coin.txid, vout: coin.vout },
    createdAt: String(Math.floor(coin.createdAt.getTime() / 1000)),
    expiresAt:
        coin.expiresAtHeight === undefined
            ? coin.expiresAt === undefined
                ? null
                : String(Math.floor(coin.expiresAt.getTime() / 1000))
            : String(coin.expiresAtHeight),
    amount: String(coin.value),
    script: coin.script,
    isPreconfirmed: coin.isPreconfirmed,
    isSwept: coin.isSwept,
    isUnrolled: coin.isUnrolled,
    isSpent: coin.isSpent,
    spentBy: coin.spentBy,
    commitmentTxids: coin.commitmentTxIds,
    assets: coin.assets?.map(({ assetId, amount }) => ({ assetId, amount: String(amount) })),
});

const setup = async (
    verifyArgs = args(),
    coinAssets: VirtualCoin["assets"] = [],
    extras: { coin: VirtualCoin; source: Transaction }[] = [],
    providerLimits: { maxOpReturnOutputs?: unknown } = { maxOpReturnOutputs: 3n },
) => {
    const trustedUnroll = CSVMultisigTapscript.decode(verifyArgs.trustedServerUnrollScript);
    const uniqueParams = quoteParamsFromWire(verifyArgs.quote.params);
    uniqueParams.locktime += ++setupSequence;
    verifyArgs = {
        ...verifyArgs,
        quote: quote(uniqueParams, {
            senderInputs: verifyArgs.senderInputs,
            senderSats: verifyArgs.senderSats,
            ...(verifyArgs.assetUnits === undefined ? {} : { assetUnits: verifyArgs.assetUnits }),
            fare: fareFromWire(verifyArgs.quote.fare),
            serverUnrollScript: trustedUnroll,
        }),
    };
    const verified = verifyQuote(verifyArgs);
    const verifiedState = activeQuoteStateFor(verified);
    const previous = Transaction.fromPSBT(verifiedState.validated.tx.toPSBT());
    const outpoint = {
        txid: previous.id,
        vout: verifiedState.validated.envelope.covenantOutputIndex,
    };
    const coin = {
        ...outpoint,
        value: 330,
        script: "", // Set after quote verification derives the covenant.
        status: { confirmed: false },
        createdAt: new Date(NOW * 1000),
        isUnrolled: false,
        isSpent: false,
        isSwept: false,
        isPreconfirmed: true,
        spentBy: "",
        commitmentTxIds: [],
        expiresAtHeight: 900_000,
        virtualStatus: { state: "preconfirmed" },
        assets: coinAssets,
    } as VirtualCoin;
    let submitted: Transaction | undefined;
    const submissionUrls: string[] = [];
    const emulator = {
        getInfo: vi.fn(async () => ({
            signerPubkey: hex.encode(
                await SingleKey.fromPrivateKey(new Uint8Array(32).fill(5)).compressedPublicKey(),
            ),
        })),
        submitTx: vi.fn(async (arkTx: string, checkpoints: string[]) => {
            submitted = Transaction.fromPSBT(base64.decode(arkTx));
            const packet = Extension.fromTx(submitted).getEmulatorPacket()!;
            return finalGraph(arkTx, checkpoints, packet.entries[0].script);
        }),
    };
    const coins = [coin, ...extras.map(({ coin: extra }) => extra)];
    const sources = [previous, ...extras.map(({ source: extra }) => extra)];
    const indexer = {
        getVtxos: vi.fn(async ({ outpoints }: { outpoints: { txid: string; vout: number }[] }) => ({
            vtxos: outpoints
                .map(({ txid, vout }) =>
                    coins.find((candidate) => candidate.txid === txid && candidate.vout === vout),
                )
                .filter((candidate): candidate is VirtualCoin => candidate !== undefined),
        })),
        getVirtualTxs: vi.fn(async (txids: string[]) => ({
            txs: txids
                .map((txid) => sources.find((candidate) => candidate.id === txid))
                .filter((candidate): candidate is Transaction => candidate !== undefined)
                .map((candidate) => base64.encode(candidate.toPSBT())),
        })),
    };
    const arkSigner = hex.encode(await serverIdentity.compressedPublicKey());
    const arkInfo = {
        network: "regtest",
        signerPubkey: arkSigner,
        forfeitPubkey: hex.encode(trustedUnroll.params.pubkeys[0]),
        checkpointTapscript: hex.encode(trustedUnroll.script),
        dust: 330n,
        vtxoMinAmount: 10n,
        ...providerLimits,
    } as ArkInfo;
    const arkProvider = {
        getInfo: vi.fn(async () => ({ ...arkInfo })),
    };
    const config: CovenantSpendConfig = {
        arkdUrl: "https://arkd.example",
        emulatorUrl: "https://emulator.example",
        network: "regtest",
        serverUnrollScript: hex.encode(trustedUnroll.script),
        chainHeight: 800_000,
    };
    const fetcher = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const url = new URL(
            typeof input === "string" || input instanceof URL ? input.toString() : input.url,
        );
        if (url.origin === "https://arkd.example" && url.pathname === "/v1/info")
            return json(arkInfoWire(await arkProvider.getInfo()));
        if (url.origin === "https://emulator.example" && url.pathname === "/v1/info")
            return json(await emulator.getInfo());
        if (url.origin === "https://arkd.example" && url.pathname === "/v1/indexer/vtxos") {
            const outpoints = url.searchParams.getAll("outpoints").map((value) => {
                const [txid, vout] = value.split(":");
                return { txid, vout: Number(vout) };
            });
            const response = await indexer.getVtxos({ outpoints });
            return json({ ...response, vtxos: response.vtxos.map(vtxoWire) });
        }
        if (
            url.origin === "https://arkd.example" &&
            url.pathname.startsWith("/v1/indexer/virtualTx/")
        ) {
            const txids = url.pathname.slice("/v1/indexer/virtualTx/".length).split(",");
            return json(await indexer.getVirtualTxs(txids));
        }
        if (
            url.origin === "https://emulator.example" &&
            url.pathname === "/v1/tx" &&
            init?.method === "POST"
        ) {
            submissionUrls.push(url.origin);
            const body = JSON.parse(String(init.body)) as {
                arkTx: string;
                checkpointTxs: string[];
            };
            return json(await emulator.submitTx(body.arkTx, body.checkpointTxs));
        }
        throw new Error(`unexpected provider request ${url}`);
    });
    vi.stubGlobal("fetch", fetcher);
    coin.script = hex.encode(verified.script.pkScript);
    const lockup = { txid: previous.id, outpoint };
    const status = {
        transferId: verifyArgs.quote.transferId,
        state: "locked" as const,
        outpoint,
        updatedAt: NOW,
    };
    const transfer = await verifyCovenantTransfer({
        verified,
        lockup,
        status,
        config,
    });
    return {
        transfer,
        verified,
        lockup,
        status,
        coin,
        config,
        arkProvider,
        arkInfo,
        emulator,
        indexer,
        fetcher,
        submissionUrls,
        submitted: () => submitted,
    };
};

const incomingFixture = async (withAsset = true) => {
    const authorization = withAsset ? assetArgs() : args();
    const base = await setup(
        authorization,
        withAsset
            ? [
                  {
                      assetId: asset.AssetId.create("12".repeat(32), 7).toString(),
                      amount: authorization.assetUnits!,
                  },
              ]
            : [],
    );
    const state = activeQuoteStateFor(base.verified);
    const receiverAddress = new ArkAddress(serverKey, receiverKey, "ark").encode();
    const claim: ReceiverClaimWire = {
        transferId: base.status.transferId,
        receiverAddress,
        state: "locked",
        claimable: true,
        updatedAt: NOW,
        claim: {
            params: structuredClone(state.authorization.quote.params),
            covenantAddress: state.authorization.quote.covenantAddress,
            outpoint: { ...base.status.outpoint },
            fare: structuredClone(state.authorization.quote.fare),
            batchExpiry: { kind: "height", value: "900000" },
            recoveryLocktime: { kind: "height", value: state.context.params.locktime.toString() },
            ...(withAsset ? { assetUnits: authorization.assetUnits!.toString() } : {}),
        },
    };
    const incoming: VerifyIncomingClaimArgs = {
        claim,
        expect: {
            receiverAddress,
            ...(withAsset
                ? {
                      assetId: structuredClone(authorization.expect.assetId!),
                      assetUnits: authorization.assetUnits!,
                  }
                : {}),
        },
        trusted: {
            serverKey: Uint8Array.from(serverKey),
            emulatorKey: Uint8Array.from(emulatorKey),
            operatorKey: Uint8Array.from(operatorKey),
            vtxoMinAmount: VTXO_MIN,
            hrp: "ark",
        },
        config: { ...base.config },
        status: { ...base.status, outpoint: { ...base.status.outpoint } },
    };
    return { base, incoming };
};

describe("incoming claim verification", () => {
    it.each([true, false])(
        "mints a spend capability for an observed incoming claim (asset=%s)",
        async (withAsset) => {
            const { base, incoming } = await incomingFixture(withAsset);
            const transfer = await verifyIncomingClaim(incoming);
            expect(transfer).toMatchObject({
                transferId: "tr_01",
                outpoint: base.lockup.outpoint,
                value: 330n,
            });
            await purchase(transfer, new Uint8Array([0x51, 0x20, ...receiverKey]));
            expect(base.submitted()).toBeDefined();
        },
    );

    const mutations: [string, (value: VerifyIncomingClaimArgs) => void][] = [
        [
            "receiver address",
            (a) => {
                a.claim.receiverAddress = new ArkAddress(serverKey, otherKey, "ark").encode();
            },
        ],
        [
            "receiver key",
            (a) => {
                a.claim.claim!.params.receiverKey = hex.encode(otherKey);
            },
        ],
        [
            "noncanonical address",
            (a) => {
                a.expect.receiverAddress = a.claim.receiverAddress =
                    a.claim.receiverAddress.toUpperCase();
            },
        ],
        [
            "address HRP",
            (a) => {
                a.expect.receiverAddress = a.claim.receiverAddress = new ArkAddress(
                    serverKey,
                    receiverKey,
                    "tark",
                ).encode();
            },
        ],
        [
            "address server",
            (a) => {
                a.expect.receiverAddress = a.claim.receiverAddress = new ArkAddress(
                    otherKey,
                    receiverKey,
                    "ark",
                ).encode();
            },
        ],
        [
            "trusted server",
            (a) => {
                a.trusted.serverKey = otherKey;
            },
        ],
        [
            "trusted emulator",
            (a) => {
                a.trusted.emulatorKey = otherKey;
            },
        ],
        [
            "trusted operator",
            (a) => {
                a.trusted.operatorKey = otherKey;
            },
        ],
        [
            "operator params",
            (a) => {
                a.claim.claim!.params.operatorKey = hex.encode(otherKey);
            },
        ],
        [
            "sender params",
            (a) => {
                a.claim.claim!.params.senderKey = hex.encode(otherKey);
            },
        ],
        [
            "topup params",
            (a) => {
                a.claim.claim!.params.topup = "331";
            },
        ],
        [
            "dust params",
            (a) => {
                a.claim.claim!.params.dust = "331";
            },
        ],
        [
            "asset ID",
            (a) => {
                a.expect.assetId!.groupIndex++;
            },
        ],
        [
            "asset quantity",
            (a) => {
                a.expect.assetUnits = a.expect.assetUnits! - 1n;
            },
        ],
        [
            "missing expected asset",
            (a) => {
                delete a.expect.assetId;
            },
        ],
        [
            "missing expected units",
            (a) => {
                delete a.expect.assetUnits;
            },
        ],
        [
            "missing descriptor units",
            (a) => {
                delete a.claim.claim!.assetUnits;
            },
        ],
        [
            "zero units",
            (a) => {
                a.claim.claim!.assetUnits = "0";
                a.expect.assetUnits = 0n;
            },
        ],
        [
            "unsafe number units",
            (a) => {
                a.expect.assetUnits = Number(a.expect.assetUnits) as unknown as bigint;
            },
        ],
        [
            "covenant address",
            (a) => {
                a.claim.claim!.covenantAddress = a.claim.receiverAddress;
            },
        ],
        [
            "outpoint",
            (a) => {
                a.claim.claim!.outpoint.vout++;
            },
        ],
        [
            "tap tree injection",
            (a) => {
                Object.assign(a.claim.claim!, { tapTree: "00" });
            },
        ],
        [
            "batch expiry value",
            (a) => {
                a.claim.claim!.batchExpiry.value = "899999";
            },
        ],
        [
            "batch expiry kind",
            (a) => {
                a.claim.claim!.batchExpiry.kind = "time";
            },
        ],
        [
            "recovery value",
            (a) => {
                a.claim.claim!.recoveryLocktime.value = "799999";
            },
        ],
        [
            "recovery kind",
            (a) => {
                a.claim.claim!.recoveryLocktime.kind = "time";
            },
        ],
        [
            "listing state",
            (a) => {
                a.claim.state = "recovering";
            },
        ],
        [
            "claimable",
            (a) => {
                a.claim.claimable = false;
            },
        ],
        [
            "listing spent marker",
            (a) => {
                a.claim.spentTxid = "aa".repeat(32);
            },
        ],
        [
            "Taxi state",
            (a) => {
                a.status.state = "recovering";
            },
        ],
        [
            "Taxi transfer ID",
            (a) => {
                a.status.transferId = "another-transfer";
            },
        ],
        [
            "Taxi spent marker",
            (a) => {
                a.status.spentTxid = "aa".repeat(32);
            },
        ],
        [
            "Taxi failure",
            (a) => {
                a.status.failureCode = "failed";
            },
        ],
        [
            "Taxi failure detail",
            (a) => {
                a.status.failureDetail = "failed";
            },
        ],
        [
            "Taxi outpoint extra",
            (a) => {
                Object.assign(a.status.outpoint!, { script: "00" });
            },
        ],
        [
            "minimum amount",
            (a) => {
                a.trusted.vtxoMinAmount = 11n;
            },
        ],
        [
            "arkd URL",
            (a) => {
                a.config.arkdUrl = "https://attacker.example";
            },
        ],
        [
            "emulator URL",
            (a) => {
                a.config.emulatorUrl = "https://attacker.example";
            },
        ],
        [
            "URL credentials",
            (a) => {
                a.config.arkdUrl = "https://attacker@arkd.example";
            },
        ],
        [
            "network",
            (a) => {
                a.config.network = "bitcoin";
            },
        ],
        [
            "server unroll script",
            (a) => {
                a.config.serverUnrollScript = "00";
            },
        ],
    ];

    it.each(mutations)("rejects a changed %s", async (_label, mutate) => {
        const { base, incoming } = await incomingFixture();
        mutate(incoming);
        await expect(verifyIncomingClaim(incoming)).rejects.toThrow();
        expect(base.emulator.submitTx).not.toHaveBeenCalled();
    });

    it.each([
        ["value", { value: 331 }],
        ["script", { script: "5120" + "00".repeat(32) }],
        ["outpoint", { txid: "ab".repeat(32) }],
        ["expiry", { expiresAtHeight: 899999 }],
        ["spent", { isSpent: true }],
        [
            "asset units",
            {
                assets: [
                    { assetId: asset.AssetId.create("12".repeat(32), 7).toString(), amount: 1n },
                ],
            },
        ],
        [
            "asset ID",
            {
                assets: [
                    {
                        assetId: asset.AssetId.create("13".repeat(32), 7).toString(),
                        amount: 9_007_199_254_740_993n,
                    },
                ],
            },
        ],
    ])("rejects changed indexed %s", async (_label, patch) => {
        const { base, incoming } = await incomingFixture();
        base.indexer.getVtxos.mockResolvedValueOnce({ vtxos: [{ ...base.coin, ...patch }] });
        await expect(verifyIncomingClaim(incoming)).rejects.toThrow();
    });

    it("does not grant spend authority to a listing or copied capability", async () => {
        const { incoming } = await incomingFixture();
        const transfer = await verifyIncomingClaim(incoming);
        for (const raw of [incoming.claim, { ...transfer }]) {
            await expect(purchase(raw as CovenantTransfer, new Uint8Array())).rejects.toThrow(
                /capability/i,
            );
            await expect(
                recycle(raw as CovenantTransfer, {} as ReceiverWalletInput, new Uint8Array()),
            ).rejects.toThrow(/capability/i);
        }
    });

    it("shares consumption with sender-originated verification of the same coin", async () => {
        const { base, incoming } = await incomingFixture();
        const transfer = await verifyIncomingClaim(incoming);
        await purchase(base.transfer, new Uint8Array([0x51, 0x20, ...receiverKey]));
        await expect(
            purchase(transfer, new Uint8Array([0x51, 0x20, ...receiverKey])),
        ).rejects.toThrow(/already consumed/i);
    });

    it("rejects accessors without reading them and accepts cross-realm byte snapshots", async () => {
        const { incoming } = await incomingFixture();
        const read = vi.fn(() => incoming.claim);
        const accessor = Object.defineProperty({ ...incoming }, "claim", {
            enumerable: true,
            get: read,
        });
        await expect(verifyIncomingClaim(accessor)).rejects.toThrow(/data property/i);
        expect(read).not.toHaveBeenCalled();
        incoming.trusted.serverKey = runInNewContext("new Uint8Array(bytes)", {
            bytes: [...serverKey],
        }) as Uint8Array;
        await expect(verifyIncomingClaim(incoming)).resolves.toMatchObject({ transferId: "tr_01" });
    });

    it("uses descriptor snapshots without reading proxy properties", async () => {
        const { incoming } = await incomingFixture();
        incoming.claim = new Proxy(incoming.claim, {
            get() {
                throw new Error("untrusted property read");
            },
        });
        await expect(verifyIncomingClaim(incoming)).resolves.toMatchObject({ transferId: "tr_01" });
    });

    it("pins all incoming facts before asynchronous provider observation", async () => {
        const { base, incoming } = await incomingFixture();
        const pending = verifyIncomingClaim(incoming);
        incoming.claim.claim!.params.receiverKey = hex.encode(otherKey);
        incoming.trusted.serverKey.fill(0);
        incoming.expect.assetUnits = 1n;
        incoming.config.emulatorUrl = "https://attacker.example";
        incoming.status.outpoint!.vout++;
        const transfer = await pending;
        await purchase(transfer, new Uint8Array([0x51, 0x20, ...receiverKey]));
        expect(base.submissionUrls).toEqual(["https://emulator.example"]);
    });

    it("fetches fresh Taxi status and snapshots inputs before waiting for it", async () => {
        const { base, incoming } = await incomingFixture();
        let release!: (value: Response) => void;
        const taxiFetch = vi.fn(
            () =>
                new Promise<Response>((resolve) => {
                    release = resolve;
                }),
        );
        const taxi = new TaxiClient({ baseUrl: "https://taxi.example", fetch: taxiFetch });
        const pending = taxi.verifyIncomingClaim(
            incoming.claim,
            incoming.expect,
            incoming.trusted,
            incoming.config,
        );
        incoming.claim.transferId = "attacker";
        incoming.trusted.serverKey.fill(0);
        incoming.config.emulatorUrl = "https://attacker.example";
        release(json(base.status));
        const transfer = await pending;
        expect(transfer.transferId).toBe("tr_01");
        expect(taxiFetch).toHaveBeenCalledWith(
            "https://taxi.example/v1/transfers/tr_01",
            expect.anything(),
        );
        await purchase(transfer, new Uint8Array([0x51, 0x20, ...receiverKey]));
        expect(base.submissionUrls).toEqual(["https://emulator.example"]);
    });

    it("rejects a listed locked coin when fresh Taxi status reports it spent", async () => {
        const { base, incoming } = await incomingFixture();
        const taxi = new TaxiClient({
            baseUrl: "https://taxi.example",
            fetch: async () =>
                json({ ...base.status, state: "purchased", spentTxid: "ab".repeat(32) }),
        });
        await expect(
            taxi.verifyIncomingClaim(
                incoming.claim,
                incoming.expect,
                incoming.trusted,
                incoming.config,
            ),
        ).rejects.toThrow(/Taxi status/i);
    });
});

const receiverFunding = async (
    leaf?: Uint8Array,
    identity = SingleKey.fromPrivateKey(new Uint8Array(32).fill(6)),
) => {
    const owner = await identity.xOnlyPublicKey();
    const tree = new VtxoScript([
        leaf ?? MultisigTapscript.encode({ pubkeys: [serverKey, owner] }).script,
    ]);
    const previous = source();
    const input = {
        txid: previous.id,
        vout: 0,
        value: 500n,
        tapTree: tree.encode(),
        tapLeafScript: tree.findLeaf(hex.encode(tree.scripts[0])),
    };
    const coin = {
        txid: previous.id,
        vout: 0,
        value: 500,
        script: hex.encode(tree.pkScript),
        status: { confirmed: false },
        createdAt: new Date(NOW * 1000),
        isUnrolled: false,
        isSpent: false,
        isSwept: false,
        isPreconfirmed: true,
        spentBy: "",
        commitmentTxIds: [],
        expiresAtHeight: 900_000,
        virtualStatus: { state: "preconfirmed" },
        assets: [],
    } as VirtualCoin;
    return {
        receiverKey: tree.tweakedPublicKey,
        walletInput: {
            input,
            expiry: { kind: "height" as const, value: 900_000n },
            identity,
        },
        coin,
        source: previous,
    };
};

const crossRealmBytes = (value: Uint8Array): Uint8Array =>
    runInNewContext(`new Uint8Array([${[...value].join(",")}])`) as Uint8Array;

describe("Hermes covenant lifecycle", () => {
    it("verifies, shares and consumes an outpoint without FinalizationRegistry", async () => {
        vi.stubGlobal("FinalizationRegistry", undefined);
        try {
            const base = await setup();
            const duplicate = await verifyCovenantTransfer({
                verified: base.verified,
                lockup: base.lockup,
                status: base.status,
                config: base.config,
            });

            await purchase(base.transfer, new Uint8Array([0x51, 0x20, ...receiverKey]));
            await expect(
                purchase(duplicate, new Uint8Array([0x51, 0x20, ...receiverKey])),
            ).rejects.toThrow(/already consumed/i);
            expect(base.emulator.submitTx).toHaveBeenCalledTimes(1);
        } finally {
            vi.unstubAllGlobals();
        }
    });
});

describe("covenant provider fetch boundary", () => {
    it("uses TaxiClient fetch only for Taxi status and ambient fetch for SDK providers", async () => {
        const base = await setup();
        const taxiFetch = vi.fn(async (_input: string | URL | Request) => json(base.status));
        const taxi = new TaxiClient({ baseUrl: "https://taxi.example", fetch: taxiFetch });
        const providerCallsBefore = base.fetcher.mock.calls.length;

        const transfer = await taxi.verifyTransfer(base.verified, base.lockup, base.config);
        await taxi.purchase(transfer, new Uint8Array([0x51, 0x20, ...receiverKey]));

        expect(taxiFetch).toHaveBeenCalledTimes(1);
        expect(String(taxiFetch.mock.calls[0][0])).toContain("https://taxi.example/v1/transfers/");
        expect(base.fetcher.mock.calls.length).toBeGreaterThan(providerCallsBefore);
        expect(base.fetcher.mock.calls.map(([input]) => String(input))).toEqual(
            expect.arrayContaining([
                expect.stringContaining("https://arkd.example/"),
                expect.stringContaining("https://emulator.example/"),
            ]),
        );
    });
});

describe("covenant transfer capability", () => {
    it.each([
        ["wrong txid", (txid: string, vout: number) => ({ txid: "21".repeat(32), vout })],
        ["wrong vout", (txid: string, vout: number) => ({ txid, vout: vout + 1 })],
        [
            "byte-reversed txid",
            (txid: string, vout: number) => ({
                txid: hex.encode(Uint8Array.from(hex.decode(txid)).reverse()),
                vout,
            }),
        ],
    ])(
        "refuses a %s even when the indexer reports matching covenant facts",
        async (_name, alter) => {
            const base = await setup();
            const outpoint = alter(base.lockup.outpoint.txid, base.lockup.outpoint.vout);
            vi.mocked(base.indexer.getVtxos).mockResolvedValueOnce({
                vtxos: [{ ...base.coin, ...outpoint }],
            });
            await expect(
                verifyCovenantTransfer({
                    verified: base.verified,
                    lockup: { txid: outpoint.txid, outpoint },
                    status: { ...base.status, outpoint },
                    config: base.config,
                }),
            ).rejects.toThrow(/validated lockup outpoint/i);
        },
    );

    it("rejects uppercase and duplicate indexer outpoints without minting another capability", async () => {
        const base = await setup();
        const uppercase = base.lockup.outpoint.txid.toUpperCase();
        await expect(
            verifyCovenantTransfer({
                verified: base.verified,
                lockup: {
                    txid: uppercase,
                    outpoint: { txid: uppercase, vout: base.lockup.outpoint.vout },
                },
                status: {
                    ...base.status,
                    outpoint: { txid: uppercase, vout: base.lockup.outpoint.vout },
                },
                config: base.config,
            }),
        ).rejects.toThrow(/lowercase|hex|lockup/i);

        vi.mocked(base.indexer.getVtxos).mockResolvedValueOnce({
            vtxos: [base.coin, { ...base.coin }],
        });
        await expect(
            verifyCovenantTransfer({
                verified: base.verified,
                lockup: base.lockup,
                status: base.status,
                config: base.config,
            }),
        ).rejects.toThrow(/exactly the locked outpoint/i);
    });

    it("rejects a raw transfer id and copied public view before provider submission", async () => {
        const { transfer, emulator } = await setup();
        await expect(
            purchase("tr_01" as unknown as CovenantTransfer, new Uint8Array()),
        ).rejects.toThrow(/capability/i);
        await expect(
            purchase({ ...transfer } as CovenantTransfer, new Uint8Array()),
        ).rejects.toThrow(/capability/i);
        expect(emulator.submitTx).not.toHaveBeenCalled();
    });

    it("retains pinned primitive URLs instead of the caller's mutable config", async () => {
        const { transfer, config, emulator, submissionUrls } = await setup();
        config.emulatorUrl = "https://attacker.example";

        await purchase(transfer, new Uint8Array([0x51, 0x20, ...receiverKey]));
        expect(emulator.submitTx).toHaveBeenCalledTimes(1);
        expect(submissionUrls).toEqual(["https://emulator.example"]);
    });

    it("captures SDK methods so later prototype replacement cannot redirect submission", async () => {
        const { transfer, emulator } = await setup();
        const replacementSubmit = vi.fn(async () => {
            throw new Error("replacement provider must not be used");
        });
        const original = RestEmulatorProvider.prototype.submitTx;
        RestEmulatorProvider.prototype.submitTx = replacementSubmit;
        try {
            await purchase(transfer, new Uint8Array([0x51, 0x20, ...receiverKey]));
            expect(emulator.submitTx).toHaveBeenCalledTimes(1);
            expect(replacementSubmit).not.toHaveBeenCalled();
        } finally {
            RestEmulatorProvider.prototype.submitTx = original;
        }
    });

    it("does not retain transitive SDK prototype lookups", async () => {
        const { transfer } = await setup();
        const prototype = RestIndexerProvider.prototype as unknown as Record<string, unknown>;
        const original = prototype.fetchVtxosPage;
        const attacker = vi.fn(async () => {
            throw new Error("redirected through shared prototype");
        });
        prototype.fetchVtxosPage = attacker;
        try {
            await purchase(transfer, new Uint8Array([0x51, 0x20, ...receiverKey]));
            expect(attacker).not.toHaveBeenCalled();
        } finally {
            prototype.fetchVtxosPage = original;
        }
    });

    it("uses the pinned provider endpoint when public config changes during signing", async () => {
        const { transfer, config, submissionUrls } = await setup();
        let release!: () => void;
        let signingStarted!: () => void;
        const gate = new Promise<void>((resolve) => (release = resolve));
        const started = new Promise<void>((resolve) => (signingStarted = resolve));
        const delayedIdentity = {
            xOnlyPublicKey: () => senderIdentity.xOnlyPublicKey(),
            async sign(tx: Transaction, indexes?: number[]) {
                signingStarted();
                await gate;
                return senderIdentity.sign(tx, indexes);
            },
        };
        const pending = refund(transfer, delayedIdentity as unknown as Identity);
        await started;
        config.emulatorUrl = "https://attacker.example";
        release();

        await pending;
        expect(submissionUrls).toEqual(["https://emulator.example"]);
    });

    it("rejects a legacy provider accessor without invoking it", async () => {
        const base = await setup();
        let reads = 0;
        const legacy = { ...base.config } as Record<string, unknown>;
        Object.defineProperty(legacy, "emulator", {
            enumerable: true,
            configurable: true,
            get() {
                reads++;
                return base.emulator;
            },
        });
        await expect(
            verifyCovenantTransfer({
                verified: base.verified,
                lockup: base.lockup,
                status: base.status,
                config: legacy as unknown as CovenantSpendConfig,
            }),
        ).rejects.toThrow(/custom provider|provider objects|URLs/i);
        expect(reads).toBe(0);
    });

    it("rejects executable values in primitive provider config", async () => {
        const base = await setup();
        await expect(
            verifyCovenantTransfer({
                verified: base.verified,
                lockup: base.lockup,
                status: base.status,
                config: {
                    ...base.config,
                    chainHeight: (() => 800_000) as unknown as number,
                },
            }),
        ).rejects.toThrow(/plain data|chain height/i);
    });

    it("rejects legacy custom provider objects before cloning attacker callables", async () => {
        const base = await setup();
        const attacker = vi.fn();
        const callable = new Proxy(base.emulator.submitTx, {
            apply() {
                attacker();
                throw new Error("redirected");
            },
        });
        const emulator = Object.assign(
            Object.create({ inheritedTransport: () => "attacker" }),
            base.emulator,
            { serverUrl: "https://attacker.example", submitTx: callable },
        );
        const requestsBefore = base.fetcher.mock.calls.length;

        await expect(
            verifyCovenantTransfer({
                verified: base.verified,
                lockup: base.lockup,
                status: base.status,
                config: {
                    ...(base.config as unknown as Record<string, unknown>),
                    emulator,
                } as unknown as CovenantSpendConfig,
            }),
        ).rejects.toThrow(/custom provider|provider objects|URLs/i);

        expect(attacker).not.toHaveBeenCalled();
        expect(base.fetcher).toHaveBeenCalledTimes(requestsBefore);
    });
});

describe("purchase", () => {
    it("spends all remaining assets when the caller omitted assetUnits", async () => {
        const authorization = assetArgs();
        delete authorization.assetUnits;
        const id = asset.AssetId.create("12".repeat(32), 7).toString();
        const live = await setup(authorization, [{ assetId: id, amount: 9_007_199_254_741_015n }]);
        await purchase(live.transfer, new Uint8Array([0x51, 0x20, ...receiverKey]));
        expect(
            Extension.fromTx(live.submitted()!)
                .getAssetPacket()!
                .groups[0]!.outputs.map((output) => [output.vout, output.amount]),
        ).toEqual([[0, 9_007_199_254_741_015n]]);
    });
    it("accepts a cross-realm receiver destination and rejects other byte views", async () => {
        const crossRealm = runInNewContext(
            `new Uint8Array([${[0x51, 0x20, ...receiverKey].join(",")}])`,
        ) as Uint8Array;
        const valid = await setup();
        await purchase(valid.transfer, crossRealm);
        expect(valid.emulator.submitTx).toHaveBeenCalledTimes(1);

        const invalid = await setup();
        await expect(
            purchase(invalid.transfer, new Uint16Array([0x2051]) as unknown as Uint8Array),
        ).rejects.toThrow(/destination|Uint8Array|byte/i);
        expect(invalid.emulator.submitTx).not.toHaveBeenCalled();
    });

    it("builds the exact one-input covenant graph and returns its verified txid", async () => {
        const { transfer, emulator, submitted } = await setup();
        const destination = new Uint8Array([0x51, 0x20, ...receiverKey]);
        const txid = await purchase(transfer, destination);
        const tx = submitted()!;

        expect(emulator.submitTx).toHaveBeenCalledTimes(1);
        expect(tx.inputsLength).toBe(1);
        expect(tx.getInput(0).index).toBe(0);
        expect(tx.getOutput(0)).toMatchObject({ amount: 330n, script: destination });
        expect(tx.getOutput(tx.outputsLength - 1)).toMatchObject(P2A);
        expect(txid).toBe(tx.id);
    });

    it("rejects a destination other than the independently derived receiver script", async () => {
        const { transfer, emulator } = await setup();
        await expect(purchase(transfer, new Uint8Array([0x51]))).rejects.toThrow(/destination/i);
        expect(emulator.submitTx).not.toHaveBeenCalled();
    });

    it("conserves large asset quantities and emits no asset packet for bitcoin", async () => {
        const assetVerify = assetArgs();
        const id = asset.AssetId.create(
            hex.encode(Uint8Array.from(assetVerify.expect.assetId!.txid).reverse()),
            assetVerify.expect.assetId!.groupIndex,
        ).toString();
        const { transfer, submitted } = await setup(assetVerify, [
            { assetId: id, amount: assetVerify.assetUnits! },
        ]);
        await purchase(transfer, new Uint8Array([0x51, 0x20, ...receiverKey]));
        const packet = Extension.fromTx(submitted()!).getAssetPacket()!;
        expect(packet.groups[0].inputs[0]).toMatchObject({
            vin: 0,
            amount: assetVerify.assetUnits,
        });
        expect(packet.groups[0].outputs[0]).toMatchObject({
            vout: 0,
            amount: assetVerify.assetUnits,
        });

        const bitcoin = await setup();
        await purchase(bitcoin.transfer, new Uint8Array([0x51, 0x20, ...receiverKey]));
        expect(Extension.fromTx(bitcoin.submitted()!).getAssetPacket()).toBeNull();
    });

    it("rejects a malformed final emulator graph explicitly", async () => {
        const { transfer, emulator } = await setup();
        let expectedTxid = "";
        vi.mocked(emulator.submitTx).mockImplementationOnce(async (signedArkTx) => {
            expectedTxid = Transaction.fromPSBT(base64.decode(signedArkTx)).id;
            return { signedArkTx, signedCheckpointTxs: [] };
        });
        const error = await purchase(transfer, new Uint8Array([0x51, 0x20, ...receiverKey])).catch(
            (cause) => cause,
        );
        expect(error).toBeInstanceOf(CovenantSpendAmbiguousError);
        expect(error.expectedTxid).toBe(expectedTxid);
        expect(error.cause).toMatchObject({ message: expect.stringMatching(/checkpoint count/i) });
    });
});

describe("fresh provider authorization", () => {
    it("spends with distinct regular and forfeit signer keys bound to the trusted unroll", async () => {
        const a = args();
        a.trustedServerUnrollScript = CSVMultisigTapscript.encode({
            pubkeys: [otherKey],
            timelock: { type: "blocks", value: 144n },
        }).script;
        const base = await setup(a);
        expect(base.arkInfo.forfeitPubkey).toBe(hex.encode(otherKey));
        expect(base.arkInfo.signerPubkey.slice(2)).toBe(hex.encode(serverKey));
        base.arkInfo.forfeitPubkey = hex.encode(
            await SingleKey.fromPrivateKey(new Uint8Array(32).fill(6)).compressedPublicKey(),
        );
        const result = await purchase(base.transfer, new Uint8Array([0x51, 0x20, ...receiverKey]));
        expect(result).toBe(base.submitted()!.id);
        expect(base.arkProvider.getInfo).toHaveBeenCalledTimes(3);
    });

    it("rejects a trusted unroll with more than one forfeit signer", async () => {
        const a = args();
        a.trustedServerUnrollScript = CSVMultisigTapscript.encode({
            pubkeys: [serverKey, otherKey],
            timelock: { type: "blocks", value: 144n },
        }).script;
        await expect(setup(a).then(() => undefined)).rejects.toThrow(/forfeit signer/);
    });

    const distinctKeyDrifts = [
        [
            "forfeit key replaced by regular signer",
            (base: ArkInfo) => ({ ...base, forfeitPubkey: base.signerPubkey }),
        ],
        [
            "rogue forfeit key",
            (base: ArkInfo) => ({ ...base, forfeitPubkey: hex.encode(receiverKey) }),
        ],
        ["malformed forfeit key", (base: ArkInfo) => ({ ...base, forfeitPubkey: "01" })],
        ["regular signer", (base: ArkInfo) => ({ ...base, signerPubkey: hex.encode(otherKey) })],
        ["network", (base: ArkInfo) => ({ ...base, network: "bitcoin" })],
        [
            "checkpoint delay",
            (base: ArkInfo) => ({
                ...base,
                checkpointTapscript: hex.encode(
                    CSVMultisigTapscript.encode({
                        pubkeys: [otherKey],
                        timelock: { type: "blocks", value: 145n },
                    }).script,
                ),
            }),
        ],
        [
            "forfeit key and matching rogue checkpoint",
            (base: ArkInfo) => ({
                ...base,
                forfeitPubkey: hex.encode(receiverKey),
                checkpointTapscript: hex.encode(
                    CSVMultisigTapscript.encode({
                        pubkeys: [receiverKey],
                        timelock: { type: "blocks", value: 144n },
                    }).script,
                ),
            }),
        ],
    ] as const;

    describe.each(["verification", "build", "submission"] as const)(
        "distinct forfeit identity at %s",
        (stage) => {
            it.each(distinctKeyDrifts)("rejects drift of %s", async (_label, drift) => {
                const a = args();
                a.trustedServerUnrollScript = CSVMultisigTapscript.encode({
                    pubkeys: [otherKey],
                    timelock: { type: "blocks", value: 144n },
                }).script;
                const base = await setup(a);
                if (stage === "submission")
                    base.arkProvider.getInfo.mockResolvedValueOnce({ ...base.arkInfo });
                base.arkProvider.getInfo.mockResolvedValueOnce(drift(base.arkInfo));
                const attempt =
                    stage === "verification"
                        ? verifyCovenantTransfer({
                              verified: base.verified,
                              lockup: base.lockup,
                              status: base.status,
                              config: base.config,
                          })
                        : purchase(base.transfer, new Uint8Array([0x51, 0x20, ...receiverKey]));
                await expect(attempt).rejects.toThrow(/network|signer|forfeit|construction/i);
                expect(base.emulator.submitTx).not.toHaveBeenCalled();
            });
        },
    );

    it.each([
        ["network", (base: ArkInfo) => ({ ...base, network: "bitcoin" })],
        [
            "server key",
            (base: ArkInfo) => ({
                ...base,
                signerPubkey: "02" + hex.encode(otherKey),
                forfeitPubkey: "02" + hex.encode(otherKey),
            }),
        ],
        ["checkpoint", (base: ArkInfo) => ({ ...base, checkpointTapscript: "51" })],
    ])("rejects %s drift before the emulator effect", async (_name, drift) => {
        const base = await setup();
        vi.mocked(base.arkProvider.getInfo).mockResolvedValueOnce(drift(base.arkInfo));
        await expect(
            purchase(base.transfer, new Uint8Array([0x51, 0x20, ...receiverKey])),
        ).rejects.toThrow(/network|signer|forfeit|construction/i);
        expect(base.emulator.submitTx).not.toHaveBeenCalled();
    });

    it("rejects emulator-key drift before submission", async () => {
        const base = await setup();
        vi.mocked(base.emulator.getInfo).mockResolvedValueOnce({
            signerPubkey: "02" + hex.encode(otherKey),
        });
        await expect(
            purchase(base.transfer, new Uint8Array([0x51, 0x20, ...receiverKey])),
        ).rejects.toThrow(/emulator signer/i);
        expect(base.emulator.submitTx).not.toHaveBeenCalled();
    });

    it("refreshes provider facts before build and again before submission", async () => {
        const base = await setup();
        await purchase(base.transfer, new Uint8Array([0x51, 0x20, ...receiverKey]));
        expect(base.arkProvider.getInfo).toHaveBeenCalledTimes(3);
        expect(base.emulator.getInfo).toHaveBeenCalledTimes(3);
        expect(base.emulator.submitTx).toHaveBeenCalledTimes(1);
    });

    it("rejects provider drift before requesting an owner signature", async () => {
        const base = await setup();
        const sign = vi.fn(senderIdentity.sign.bind(senderIdentity));
        const trackedIdentity = new Proxy(senderIdentity, {
            get(target, property) {
                if (property === "sign") return sign;
                const value = Reflect.get(target, property, target) as unknown;
                return typeof value === "function" ? value.bind(target) : value;
            },
        });
        vi.mocked(base.arkProvider.getInfo)
            .mockResolvedValueOnce({ ...base.arkInfo, maxOpReturnOutputs: 3n })
            .mockResolvedValueOnce({ ...base.arkInfo, network: "bitcoin" });

        await expect(refund(base.transfer, trackedIdentity)).rejects.toThrow(/network/i);

        expect(sign).not.toHaveBeenCalled();
        expect(base.emulator.submitTx).not.toHaveBeenCalled();
    });

    it("fails closed when refund capacity drops before build or before submission", async () => {
        const beforeBuild = await setup();
        vi.mocked(beforeBuild.arkProvider.getInfo).mockResolvedValueOnce({
            ...beforeBuild.arkInfo,
            maxOpReturnOutputs: 2n,
        });
        await expect(refund(beforeBuild.transfer, senderIdentity)).rejects.toThrow(/OP_RETURN/i);
        expect(beforeBuild.emulator.submitTx).not.toHaveBeenCalled();

        const beforeSubmit = await setup();
        vi.mocked(beforeSubmit.arkProvider.getInfo)
            .mockResolvedValueOnce({ ...beforeSubmit.arkInfo, maxOpReturnOutputs: 3n })
            .mockResolvedValueOnce({ ...beforeSubmit.arkInfo, maxOpReturnOutputs: 3n })
            .mockResolvedValueOnce({ ...beforeSubmit.arkInfo, maxOpReturnOutputs: 2n });
        await expect(refund(beforeSubmit.transfer, senderIdentity)).rejects.toThrow(/OP_RETURN/i);
        expect(beforeSubmit.emulator.submitTx).not.toHaveBeenCalled();
    });
});

describe("one-shot covenant capability", () => {
    it("allows only one concurrent submission", async () => {
        const base = await setup();
        const originalSubmit = vi.mocked(base.emulator.submitTx).getMockImplementation()!;
        let release!: () => void;
        let submitStarted!: () => void;
        const gate = new Promise<void>((resolve) => (release = resolve));
        const started = new Promise<void>((resolve) => (submitStarted = resolve));
        vi.mocked(base.emulator.submitTx).mockImplementationOnce(async function (
            this: unknown,
            ...values
        ) {
            submitStarted();
            await gate;
            return Reflect.apply(originalSubmit, this, values);
        });

        const first = purchase(base.transfer, new Uint8Array([0x51, 0x20, ...receiverKey]));
        await started;
        await expect(
            purchase(base.transfer, new Uint8Array([0x51, 0x20, ...receiverKey])),
        ).rejects.toThrow(/already|consumed|in.flight/i);
        release();
        await first;
        expect(base.emulator.submitTx).toHaveBeenCalledTimes(1);
    });

    it("returns the expected txid after response loss and consumes the capability", async () => {
        const base = await setup();
        let expectedTxid = "";
        vi.mocked(base.emulator.submitTx).mockImplementationOnce(async (arkTx) => {
            expectedTxid = Transaction.fromPSBT(base64.decode(arkTx)).id;
            throw new Error("response lost");
        });

        const error = await purchase(
            base.transfer,
            new Uint8Array([0x51, 0x20, ...receiverKey]),
        ).catch((cause) => cause);
        expect(error).toBeInstanceOf(CovenantSpendAmbiguousError);
        expect(error.expectedTxid).toBe(expectedTxid);
        await expect(
            purchase(base.transfer, new Uint8Array([0x51, 0x20, ...receiverKey])),
        ).rejects.toThrow(/already|consumed/i);
        expect(base.emulator.submitTx).toHaveBeenCalledTimes(1);
    });

    it("shares lifecycle state across two capabilities for the same outpoint", async () => {
        const base = await setup();
        const second = await verifyCovenantTransfer({
            verified: base.verified,
            lockup: base.lockup,
            status: base.status,
            config: base.config,
        });
        await purchase(base.transfer, new Uint8Array([0x51, 0x20, ...receiverKey]));
        await expect(
            purchase(second, new Uint8Array([0x51, 0x20, ...receiverKey])),
        ).rejects.toThrow(/already|consumed/i);
        expect(base.emulator.submitTx).toHaveBeenCalledTimes(1);
    });

    it("rejects replay after a successful submission", async () => {
        const base = await setup();
        await purchase(base.transfer, new Uint8Array([0x51, 0x20, ...receiverKey]));
        await expect(
            purchase(base.transfer, new Uint8Array([0x51, 0x20, ...receiverKey])),
        ).rejects.toThrow(/already|consumed/i);
        expect(base.emulator.submitTx).toHaveBeenCalledTimes(1);
    });
});

describe("recycle", () => {
    it("spends a literal owner-first leaf matching SDK 0.4.72 DefaultVtxo", async () => {
        const leaf = hex.decode(
            "20f006a18d5653c4edf5391ff23a61f03ff83d237e880ee61187fa9f379a028e0aad20462779ad4aad39514614751a71085f2f10e1c7a593e4e030efb5b8721ce55b0bac",
        );
        const funding = await receiverFunding(leaf);
        const sdk = new DefaultVtxo.Script({
            pubKey: await funding.walletInput.identity.xOnlyPublicKey(),
            serverPubKey: serverKey,
            csvTimelock: { type: "blocks", value: 144n },
        });
        expect(sdk.forfeitScript).toBe(hex.encode(leaf));
        const a = args();
        a.expect.receiverKey = funding.receiverKey;
        a.quote = quote({ ...params(), receiverKey: funding.receiverKey });
        const { transfer, submitted } = await setup(a, [], [funding]);
        const destination = new Uint8Array([0x51, 0x20, ...funding.receiverKey]);
        await recycle(transfer, funding.walletInput, destination);
        expect(submitted()!.getOutput(1)).toMatchObject({ amount: 500n, script: destination });
    });

    it.each([
        ["duplicate server", [serverKey, serverKey], serverIdentity],
        ["duplicate owner", [otherKey, otherKey], undefined],
        ["missing owner", [serverKey], undefined],
        ["missing server", [otherKey], undefined],
        ["rogue owner", [serverKey, senderIdentity.xOnlyPublicKey()], undefined],
        ["extra signer", [serverKey, otherKey, senderIdentity.xOnlyPublicKey()], undefined],
    ] as const)(
        "rejects %s before requesting a receiver signature",
        async (_label, keys, identity) => {
            const leaf = MultisigTapscript.encode({ pubkeys: await Promise.all(keys) }).script;
            const funding = await receiverFunding(leaf, identity);
            const sign = vi.spyOn(funding.walletInput.identity, "sign");
            const a = args();
            a.expect.receiverKey = funding.receiverKey;
            a.quote = quote({ ...params(), receiverKey: funding.receiverKey });
            const { transfer } = await setup(a, [], [funding]);
            try {
                await expect(
                    recycle(
                        transfer,
                        funding.walletInput,
                        new Uint8Array([0x51, 0x20, ...funding.receiverKey]),
                    ),
                ).rejects.toThrow();
                expect(sign).not.toHaveBeenCalled();
            } finally {
                sign.mockRestore();
            }
        },
    );

    it("accepts cross-realm funding bytes and receiver identity keys", async () => {
        const funding = await receiverFunding();
        const original = funding.walletInput.identity;
        const identity = {
            xOnlyPublicKey: async () => crossRealmBytes(await original.xOnlyPublicKey()),
            sign: original.sign.bind(original),
        } as Identity;
        const [control, leaf] = funding.walletInput.input.tapLeafScript;
        const walletInput: ReceiverWalletInput = {
            ...funding.walletInput,
            identity,
            input: {
                ...funding.walletInput.input,
                tapTree: crossRealmBytes(funding.walletInput.input.tapTree),
                tapLeafScript: [
                    {
                        ...control,
                        internalKey: crossRealmBytes(control.internalKey),
                        merklePath: control.merklePath.map(crossRealmBytes),
                    },
                    crossRealmBytes(leaf),
                ],
            },
        };
        const a = args();
        a.expect.receiverKey = funding.receiverKey;
        a.quote = quote({ ...params(), receiverKey: funding.receiverKey });
        const { transfer, emulator } = await setup(a, [], [funding]);

        await recycle(
            transfer,
            walletInput,
            crossRealmBytes(new Uint8Array([0x51, 0x20, ...funding.receiverKey])),
        );

        expect(emulator.submitTx).toHaveBeenCalledTimes(1);
    });

    it("uses covenant input 0, verified receiver input 1, and exact repayment/merge outputs", async () => {
        const funding = await receiverFunding();
        const a = args();
        a.expect.receiverKey = funding.receiverKey;
        a.quote = quote({
            ...params(),
            receiverKey: funding.receiverKey,
        });
        const { transfer, submitted } = await setup(a, [], [funding]);
        const destination = new Uint8Array([0x51, 0x20, ...funding.receiverKey]);
        await recycle(transfer, funding.walletInput, destination);
        const tx = submitted()!;

        expect(tx.inputsLength).toBe(2);
        expect(tx.getOutput(0)).toMatchObject({
            amount: 330n,
            script: payoutPkScript(operatorKey, 330n, 330n),
        });
        expect(tx.getOutput(1)).toMatchObject({ amount: 500n, script: destination });
    });

    it("rejects a receiver leaf owned by the wrong identity before emulator submission", async () => {
        const funding = await receiverFunding();
        const a = args();
        a.expect.receiverKey = funding.receiverKey;
        a.quote = quote({
            ...params(),
            receiverKey: funding.receiverKey,
        });
        const { transfer, emulator } = await setup(a, [], [funding]);
        const wrong = {
            ...funding.walletInput,
            identity: senderIdentity,
        };
        await expect(
            recycle(transfer, wrong, new Uint8Array([0x51, 0x20, ...funding.receiverKey])),
        ).rejects.toThrow(/signer|identity/i);
        expect(emulator.submitTx).not.toHaveBeenCalled();
    });

    it("rejects aliases in an otherwise valid receiver input", async () => {
        const funding = await receiverFunding();
        const a = args();
        a.expect.receiverKey = funding.receiverKey;
        a.quote = quote({ ...params(), receiverKey: funding.receiverKey });
        const { transfer, emulator } = await setup(a, [], [funding]);
        const forged = {
            ...funding.walletInput,
            input: { ...funding.walletInput.input, valueSats: "500" },
        } as unknown as ReceiverWalletInput;
        await expect(
            recycle(transfer, forged, new Uint8Array([0x51, 0x20, ...funding.receiverKey])),
        ).rejects.toThrow(/fields/i);
        expect(emulator.submitTx).not.toHaveBeenCalled();
    });

    it("rejects aliases in a receiver control block", async () => {
        const funding = await receiverFunding();
        const a = args();
        a.expect.receiverKey = funding.receiverKey;
        a.quote = quote({ ...params(), receiverKey: funding.receiverKey });
        const { transfer, emulator } = await setup(a, [], [funding]);
        const [control, leaf] = funding.walletInput.input.tapLeafScript;
        const forged = {
            ...funding.walletInput,
            input: {
                ...funding.walletInput.input,
                tapLeafScript: [{ ...control, controlPath: [] }, leaf],
            },
        } as unknown as ReceiverWalletInput;
        await expect(
            recycle(transfer, forged, new Uint8Array([0x51, 0x20, ...funding.receiverKey])),
        ).rejects.toThrow(/fields/i);
        expect(emulator.submitTx).not.toHaveBeenCalled();
    });
});

describe("refund", () => {
    it("works around the SDK two-OP_RETURN guard without changing asset vouts", async () => {
        const opReturn = { script: new Uint8Array([0x6a]), amount: 0n };
        expect(() => buildOffchainTx([], [opReturn, opReturn, opReturn], unroll)).toThrow(
            "too many OP_RETURN outputs: 3 > 2",
        );

        const assetVerify = assetArgs();
        const id = asset.AssetId.create(
            hex.encode(Uint8Array.from(assetVerify.expect.assetId!.txid).reverse()),
            assetVerify.expect.assetId!.groupIndex,
        ).toString();
        const { transfer, submitted } = await setup(assetVerify, [
            { assetId: id, amount: assetVerify.assetUnits! },
        ]);
        await refund(transfer, senderIdentity);
        const tx = submitted()!;
        const amount = refundTopup(params(), VTXO_MIN);
        expect(tx.getOutput(0)).toMatchObject({ amount });
        expect(tx.getOutput(1)).toMatchObject({ amount: 330n - amount });
        expect(tx.getOutput(0).script?.[0]).toBe(0x6a);
        expect(tx.getOutput(1).script?.[0]).toBe(0x6a);
        expect(Extension.isExtension(tx.getOutput(2).script!)).toBe(true);
        expect(tx.getOutput(3)).toMatchObject(P2A);
        expect(Extension.fromTx(tx).getAssetPacket()!.groups[0].outputs[0]).toMatchObject({
            vout: 1,
            amount: assetVerify.assetUnits,
        });
        expect(tx.getInput(0).tapScriptSig).toHaveLength(1);
    });

    it.each([
        ["missing", {}],
        ["insufficient", { maxOpReturnOutputs: 2n }],
    ])("fails closed when provider capacity is %s", async (_label, providerLimits) => {
        const { transfer, emulator } = await setup(args(), [], [], providerLimits);
        await expect(refund(transfer, senderIdentity)).rejects.toThrow(/OP_RETURN|capacity/i);
        expect(emulator.submitTx).not.toHaveBeenCalled();
    });

    it("rejects an emulator response that swaps the extension and P2A", async () => {
        const { transfer, emulator } = await setup();
        vi.mocked(emulator.submitTx).mockImplementationOnce(async (arkTx, checkpoints) => {
            const submitted = Transaction.fromPSBT(base64.decode(arkTx));
            const packet = Extension.fromTx(submitted).getEmulatorPacket()!;
            submitted.updateInput(0, { tapScriptSig: undefined });
            const extension = submitted.getOutput(2);
            submitted.updateOutput(2, P2A);
            submitted.updateOutput(3, extension);
            return finalGraph(
                base64.encode(submitted.toPSBT()),
                checkpoints,
                packet.entries[0].script,
            );
        });
        await expect(refund(transfer, senderIdentity)).rejects.toThrow(/unsigned transaction/i);
    });

    it("rejects a wrong sender before the emulator effect", async () => {
        const { transfer, emulator } = await setup();
        await expect(
            refund(transfer, SingleKey.fromPrivateKey(new Uint8Array(32).fill(6))),
        ).rejects.toThrow(/sender identity/i);
        expect(emulator.submitTx).not.toHaveBeenCalled();
    });
});
