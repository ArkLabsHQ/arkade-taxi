import { SingleKey } from "@arkade-os/sdk";
import type { Advance, Policy } from "@arkade-taxi/core";
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

export const NOW = 1_757_000_000;
export const DUST = 330n;
export const VTXO_MIN = 10n;
export const EXPIRY_HEIGHT = 900_000n;

export const config = (over: Partial<RuntimeConfig> = {}): RuntimeConfig => ({
    dbPath: ":memory:",
    httpPort: 8080,
    arkdUrl: "https://arkd.example",
    emulatorUrl: "https://emulator.example",
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
    feeFlatSats: 5n,
    feeBps: 100,
    maxOutstandingSats: 100_000n,
    maxPerPaymentTopupSats: 1_000n,
    maxConcurrentAdvances: 10,
    locktimeMarginBlocks: 144,
    assetAllowlist: null,
    allowBitcoin: true,
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
    covenantAddress: "tark1qcovenantexample",
    feeSats: 8n,
    createdAt: NOW,
    updatedAt: NOW,
    expiresAt: NOW + 60,
    ...over,
});

export const quoteBody = (over: Record<string, unknown> = {}) => ({
    receiverKey: bytesToHex(receiverKey),
    senderKey: bytesToHex(senderKey),
    senderSats: "0",
    ...over,
});

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
}
