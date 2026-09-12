import {
    SingleKey,
    VtxoScript,
    MultisigTapscript,
    CSVMultisigTapscript,
    asset,
    type ExtendedVirtualCoin,
    type VirtualCoin,
} from "@arkade-os/sdk";
import type { RuntimeSafety } from "../src/arkade/types.js";
import type { QuoteDeps } from "../src/quotes.js";
import { LockupClaimError } from "@arkade-taxi/db";
import type { Advance, Outpoint, Policy } from "@arkade-taxi/core";
import { bytesToHex } from "@arkade-taxi/protocol";
import type { RuntimeConfig } from "../src/config.js";

// Real curve points: computeArkadeScriptPublicKey lifts the emulator key to do
// point addition, so 32 arbitrary bytes fail with "cannot find square root".
const xonly = (fill: number) =>
    SingleKey.fromPrivateKey(new Uint8Array(32).fill(fill)).xOnlyPublicKey();

export const receiverKey = await xonly(1);
export const senderKey = await xonly(2);
export const operatorPrivkey = new Uint8Array(32).fill(3);
export const operatorKey = await xonly(3);
export const serverKey = await xonly(4);
export const emulatorKey = await xonly(5);
export const senderTree = new VtxoScript([
    MultisigTapscript.encode({ pubkeys: [serverKey, senderKey] }).script,
]);
export const operatorTree = new VtxoScript([
    MultisigTapscript.encode({ pubkeys: [serverKey, operatorKey] }).script,
]);
export const serverUnroll = CSVMultisigTapscript.encode({
    pubkeys: [serverKey],
    timelock: { type: "blocks", value: 144n },
});
const senderCoins = new Map<string, VirtualCoin>();

export const NOW = 1_757_000_000;
export const DUST = 330n;
export const VTXO_MIN = 10n;
export const EXPIRY_HEIGHT = 900_000n;

export const runtimeSafety = (over: Partial<RuntimeSafety> = {}): RuntimeSafety => ({
    checkedAt: NOW * 1000,
    chainHeight: 700000n,
    chainTime: BigInt(NOW),
    walletSynced: true,
    providerIdentityOk: true,
    blockers: [],
    ...over,
});

export const fundingCoin = (over: Partial<ExtendedVirtualCoin> = {}): ExtendedVirtualCoin => ({
    txid: "bb".repeat(32),
    vout: 0,
    value: 20000,
    expiresAtHeight: Number(EXPIRY_HEIGHT),
    status: { confirmed: false },
    createdAt: new Date(NOW * 1000),
    script: bytesToHex(operatorTree.pkScript),
    isUnrolled: false,
    isSwept: false,
    isSpent: false,
    isPreconfirmed: true,
    virtualStatus: { state: "preconfirmed" },
    tapTree: operatorTree.encode(),
    forfeitTapLeafScript: operatorTree.leaves[0],
    intentTapLeafScript: operatorTree.leaves[0],
    ...over,
});

export function quoteInfrastructure(
    advances: MemoryAdvances,
    getPolicy: () => Policy,
): Pick<
    QuoteDeps,
    | "runtime"
    | "inventory"
    | "reservations"
    | "policy"
    | "nowMs"
    | "senderInventory"
    | "getServerUnroll"
> {
    return {
        getServerUnroll: () => serverUnroll,
        senderInventory: {
            getVtxos: async (opts) => ({
                vtxos:
                    opts?.outpoints
                        ?.map((o) => senderCoins.get(`${o.txid}:${o.vout}`)!)
                        .filter(Boolean) ?? [],
            }),
        },
        nowMs: () => NOW * 1000,
        runtime: {
            assertAdmission: async () => {},
            withAdmission: async (work) => work(() => {}),
            safety: () => runtimeSafety(),
        },
        inventory: {
            getSpendableVtxos: async () => [
                fundingCoin(),
                fundingCoin({ vout: 1, expiresAtHeight: 900001 }),
            ],
            getLockedVtxoOutpoints: async () => [],
        },
        policy: { get: getPolicy, getSnapshot: () => ({ policy: getPolicy(), revision: 1n }) },
        reservations: {
            claimLockup: (id, unsignedTxId, signedEnvelopeDigest, signedLockupEnvelope, now) => {
                const at = now();
                const existing = advances.get(id);
                if (!existing) throw new LockupClaimError("not_found", id);
                if (existing.state === "quoted" && existing.expiresAt <= at) {
                    advances.update({
                        ...existing,
                        state: "expired",
                        updatedAt: Math.max(at, existing.updatedAt),
                    });
                    throw new LockupClaimError("quote_expired", id);
                }
                if (existing.state === "expired") throw new LockupClaimError("quote_expired", id);
                if (existing.unsignedLockupId !== unsignedTxId)
                    throw new LockupClaimError("envelope_conflict", id);
                if (existing.state === "locking" || existing.state === "locked") {
                    if (
                        existing.signedEnvelopeDigest !== signedEnvelopeDigest ||
                        existing.signedLockupEnvelope !== signedLockupEnvelope
                    )
                        throw new LockupClaimError("envelope_conflict", id);
                    return { advance: existing, claimed: false };
                }
                if (existing.state !== "quoted") throw new LockupClaimError("invalid_state", id);
                const claimed = {
                    ...existing,
                    state: "locking" as const,
                    submissionKey: `lockup:${id}:${existing.unsignedLockupId}`,
                    signedEnvelopeDigest,
                    submissionPhase: "claimed" as const,
                    signedLockupEnvelope,
                    submittedAt: at,
                    updatedAt: Math.max(at, existing.updatedAt),
                };
                advances.update(claimed);
                return { advance: claimed, claimed: true };
            },
            listReservedOutpoints: () =>
                [...advances.rows.values()]
                    .filter((a) => a.state !== "expired")
                    .flatMap((a) => a.operatorInputs),
            reserveQuote: ({ advance }) => advances.insert(advance),
            expireQuotes: (at) => {
                const expired = advances.byState("quoted").filter((a) => a.expiresAt <= at);
                for (const a of expired)
                    advances.update({
                        ...a,
                        state: "expired",
                        updatedAt: Math.max(at, a.updatedAt),
                    });
                return expired.length;
            },
        },
    };
}

export const config = (over: Partial<RuntimeConfig> = {}): RuntimeConfig => ({
    dbPath: ":memory:",
    httpPort: 8080,
    arkdUrl: "https://arkd.example",
    indexerUrl: "https://indexer.example",
    esploraUrl: "https://esplora.example/api",
    emulatorUrl: "https://emulator.example",
    minExpiryHeadroomBlocks: 144n,
    recoveryBroadcastBlocks: 72n,
    recoveryCriticalBlocks: 12n,
    minExpiryHeadroomSeconds: 86400n,
    recoveryBroadcastSeconds: 43200n,
    recoveryCriticalSeconds: 7200n,
    reconcileIntervalMs: 30000,
    operatorMinReserveSats: 10000n,
    operatorPrivkey,
    operatorKey,
    serverPubkey: serverKey,
    emulatorPubkey: emulatorKey,
    dust: DUST,
    vtxoMinAmount: VTXO_MIN,
    logLevel: "info",
    addressHrp: "ark",
    ...over,
});

export const policy = (over: Partial<Policy> = {}): Policy => ({
    paused: false,
    maxOutstandingSats: 100_000n,
    maxPerPaymentTopupSats: 1_000n,
    maxConcurrentAdvances: 10,
    locktimeMarginBlocks: 144,
    locktimeMarginSeconds: 86400,
    assetRules: [
        {
            assetId: null,
            enabled: true,
            fares: [
                { id: "sats", currency: { kind: "sats" }, pricing: { kind: "flat", units: 10n } },
            ],
            claim: "either",
            maxTopupSats: null,
        },
    ],
    quoteTtlSeconds: 60,
    ...over,
});

export const advance = (over: Partial<Advance> = {}): Advance => ({
    id: "adv-1",
    state: "locked",
    receiverKey,
    senderKey,
    operatorKey,
    dust: DUST,
    topup: 330n,
    locktime: 850_000n,
    recoveryLocktime: { kind: "height", value: 850_000n },
    batchExpiry: { kind: "height", value: 1_000_000n },
    operatorInputs: [{ txid: "aa".repeat(32), vout: 0 }],
    unsignedLockupTx: "unsigned",
    unsignedLockupId: "bb".repeat(32),
    covenantAddress: "tark1qcovenantexample",
    fare: { currency: "sats", units: 8n },
    createdAt: NOW,
    updatedAt: NOW,
    expiresAt: NOW + 60,
    ...over,
});

export const quoteBody = (over: Record<string, unknown> = {}) => {
    const value =
        typeof over.senderSats === "string" && /^\d+$/.test(over.senderSats)
            ? over.senderSats
            : "0";
    const assetId = over.assetId as { txid: string; groupIndex: number } | undefined;
    const id = assetId ? asset.AssetId.create(assetId.txid, assetId.groupIndex) : undefined;
    const expiry = (over.senderExpiry as
        { kind: "height" | "time"; value: string } | undefined) ?? {
        kind: "height" as const,
        value: "910000",
    };
    const txid = (id ? "ac" : "ab").repeat(32);
    const vout = Number(value) + (expiry.kind === "time" ? 1000 : 0);
    const packet = id
        ? asset.Packet.create([
              asset.AssetGroup.create(id, null, [], [asset.AssetOutput.create(vout, 100n)], []),
          ])
        : undefined;
    senderCoins.set(
        `${txid}:${vout}`,
        fundingCoin({
            txid,
            vout,
            value: Number(value),
            script: bytesToHex(senderTree.pkScript),
            expiresAtHeight: expiry.kind === "height" ? Number(expiry.value) : undefined,
            ...(expiry.kind === "time" ? { expiresAt: new Date(Number(expiry.value) * 1000) } : {}),
            ...(id ? { assets: [{ assetId: id.toString(), amount: 100n }] } : {}),
        }),
    );
    return {
        receiverKey: bytesToHex(receiverKey),
        senderKey: bytesToHex(senderKey),
        senderSats: value,
        senderInputs: [
            {
                txid,
                vout,
                value,
                tapTree: bytesToHex(senderTree.encode()),
                spendLeaf: bytesToHex(senderTree.scripts[0]),
                expiry,
                ...(packet ? { assetPacket: packet.toString() } : {}),
            },
        ],
        ...over,
    };
};

/** Enough of AdvanceRepository for the services under test; the real repository
 * is exercised in @arkade-taxi/db. */
export class MemoryAdvances {
    readonly rows = new Map<string, Advance>();
    /** 1-based index of the `update` call that should throw. */
    failUpdateAt: number | null = null;
    updateCalls = 0;

    insert(a: Advance): void {
        this.rows.set(a.id, { ...a });
    }
    get(id: string): Advance | undefined {
        const row = this.rows.get(id);
        return row && { ...row };
    }
    byState(s: Advance["state"]): Advance[] {
        return [...this.rows.values()].filter((a) => a.state === s).map((a) => ({ ...a }));
    }
    update(a: Advance): void {
        this.updateCalls++;
        if (this.failUpdateAt === this.updateCalls) throw new Error("db write failed");
        if (!this.rows.has(a.id)) throw new Error(`advance ${a.id} not found`);
        this.rows.set(a.id, { ...a });
    }

    recordLockupSubmission(id: string, arkTxid: string, at: number): void {
        const current = this.get(id)!;
        this.update({
            ...current,
            arkTxid: current.arkTxid ?? arkTxid,
            updatedAt: Math.max(current.updatedAt, at),
        });
    }

    recordLockupFailure(id: string, code: string, detail: string, at: number): void {
        const current = this.get(id);
        if (current?.state !== "locking") return;
        this.update({
            ...current,
            failureCode: code,
            failureDetail: detail,
            updatedAt: Math.max(current.updatedAt, at),
        });
    }

    recordRecoverySubmission(id: string, txid: string, at: number): void {
        const current = this.get(id)!;
        this.update({
            ...current,
            recoveryTxid: current.recoveryTxid ?? txid,
            updatedAt: Math.max(current.updatedAt, at),
        });
    }

    claimRecovery(id: string, at: number): Advance | undefined {
        const current = this.get(id);
        if (current?.state !== "locked") return undefined;
        const claimed = {
            ...current,
            state: "recovering" as const,
            recoverySubmittedAt: at,
            updatedAt: Math.max(current.updatedAt, at),
        };
        this.update(claimed);
        return claimed;
    }
}
