import {
    Batch,
    EmulatorPacket,
    Estimator,
    Extension,
    Proof,
    TreeSignerSession,
    arkade,
    createAssetPacket,
    isVtxoSpent,
    withPrevTxs,
    type EmulatorProvider,
    type IndexerProvider,
    type Network,
    type OperatorProvider,
    type SignerSession,
    type VirtualCoin,
} from "@arkade-os/sdk";
import { base64, hex } from "@scure/base";
import { DustCovenantScript, Leaf } from "@arkade-taxi/covenant";
import { covenantParamsOf, renewalDue, type Advance } from "@arkade-taxi/core";
import type { RuntimeConfig } from "../config.js";
import type { ObservedCovenant } from "../watcher.js";

export interface RenewalProviders {
    arkProvider: OperatorProvider;
    emulator: EmulatorProvider;
    indexer: IndexerProvider;
    network: Network;
}

const ABORTED = "covenant renewal aborted before the batch completed";
// ponytail: fixed bound per attempt; a slower batch cadence only costs re-registration.
const ATTEMPT_MS = 10 * 60_000;

/**
 * The SDK's `renewProgramContractOutputs`, over the covenant's own tree: the SDK derives
 * the tree from the artifact and so refuses a claim-mode covenant, whose disabled claim
 * leaf the artifact does not hold. The emulator signs the proof once `renew` passes.
 */
export async function renewCovenant(
    { arkProvider, emulator, indexer, network }: RenewalProviders,
    covenant: DustCovenantScript,
    coin: VirtualCoin,
    address: string,
    opts: { signal?: AbortSignal; session?: SignerSession } = {},
): Promise<{ commitmentTxid: string; intentId: string }> {
    const script = hex.encode(covenant.pkScript);
    const outpoint = `${coin.txid}:${coin.vout}`;
    if (coin.script !== script) throw new Error(`coin ${outpoint} is not locked by its covenant`);
    const { fees } = await arkProvider.getInfo();
    const fee = new Estimator(fees?.intentFee ?? {}).evaluate(
        [
            {
                amount: BigInt(coin.value),
                type: coin.isSwept ? "recoverable" : "vtxo",
                weight: 0,
                birth: coin.createdAt,
                expiry: coin.expiresAt,
            },
        ],
        [],
        [{ amount: BigInt(coin.value), script }],
        [],
    );
    if (fee.satoshis > 0)
        throw new Error(`the server charges ${fee.satoshis} sats, which a renewal cannot pay`);
    const leaf = covenant.findLeaf(hex.encode(covenant.scripts[Leaf.Renew]!));
    const renew = covenant.covenant.renew;
    const [input] = await withPrevTxs(
        [
            {
                ...coin,
                tapTree: covenant.encode(),
                forfeitTapLeafScript: leaf,
                proofTapLeafScript: leaf,
                // The SDK reads this deprecated field first, and a wallet's coin carries its own.
                intentTapLeafScript: leaf,
            },
        ],
        indexer,
    );
    const recipients = [
        { address, amount: coin.value, ...(coin.assets?.length ? { assets: coin.assets } : {}) },
    ];
    const packets = [
        ...(coin.assets?.length
            ? [createAssetPacket(new Map([[1, coin.assets]]), recipients)]
            : []),
        EmulatorPacket.create([{ vin: 1, script: renew, witness: new Uint8Array() }]),
    ];
    const session = opts.session ?? TreeSignerSession.random();
    const sessionKey = hex.encode(await session.getPublicKey());
    const message: Proof.RegisterMessage = {
        type: "register",
        onchain_output_indexes: [],
        valid_at: 0,
        expire_at: 0,
        cosigners_public_keys: [sessionKey],
    };
    // `renew` tunnels proof input 1 into output 0, which keeps script, value and assets.
    const outputs = [
        { script: covenant.pkScript, amount: BigInt(coin.value) },
        Extension.create(packets).txOut(),
    ];
    // No delete proof, unlike the SDK's: the emulator runs `renew` on every proof it signs,
    // and `renew` admits only a register message, so a failed intent waits for arkd to drop it.
    const signedProof = await emulator.submitIntent({
        proof: base64.encode(Proof.create(message, [input!], outputs).toPSBT()),
        message,
    });
    if (opts.signal?.aborted) throw new Error(ABORTED);
    const abort = new AbortController();
    let onAbort = () => {};
    let forfeiting = false;
    try {
        // Primed first: a batch that starts before the registration returns is still seen.
        const events = Batch.prime(
            arkProvider.getEventStream(abort.signal, [sessionKey, outpoint]),
        );
        const intentId = await arkProvider.registerIntent({ proof: signedProof, message });
        const handler = arkade.createArkadeBatchHandler(
            intentId,
            [{ ...input!, arkadeScriptBytes: renew }],
            undefined,
            signedProof,
            message,
            session,
            arkProvider,
            emulator,
            network,
            recipients,
        );
        const aborted = new Promise<never>((_, reject) => {
            onAbort = () => {
                if (forfeiting) return;
                abort.abort();
                reject(new Error(ABORTED));
            };
        });
        if (opts.signal?.aborted) onAbort();
        opts.signal?.addEventListener("abort", onAbort, { once: true });
        const commitmentTxid = await Promise.race([
            Batch.join(
                events,
                {
                    ...handler,
                    onBatchFinalization: (...args) => {
                        forfeiting = true;
                        return handler.onBatchFinalization(...args);
                    },
                },
                { abortController: abort },
            ),
            aborted,
        ]);
        return { commitmentTxid, intentId };
    } finally {
        opts.signal?.removeEventListener("abort", onAbort);
        abort.abort();
    }
}

/** The sweeper's renewal hook when no Executor is configured. */
export function covenantKeeper(deps: {
    providers: RenewalProviders;
    config: Pick<
        RuntimeConfig,
        | "serverPubkey"
        | "emulatorPubkey"
        | "vtxoMinAmount"
        | "renewalBeforeExpirySeconds"
        | "recoveryBroadcastSeconds"
    >;
    now(): number;
    signal: AbortSignal;
    onRenewed(advanceId: string, commitmentTxid: string): void;
}): (advance: Advance, seen: ObservedCovenant | undefined) => Promise<void> | undefined {
    const window = {
        beforeExpirySeconds: deps.config.renewalBeforeExpirySeconds,
        guardSeconds: deps.config.recoveryBroadcastSeconds,
    };
    return (advance, seen) => {
        const outpoint = advance.outpoint;
        const now = BigInt(deps.now());
        if (!outpoint || !renewalDue(advance, seen?.expiry, now, window)) return undefined;
        return (async () => {
            const { vtxos } = await deps.providers.indexer.getVtxos({ outpoints: [outpoint] });
            const coin = vtxos.find((v) => v.txid === outpoint.txid && v.vout === outpoint.vout);
            // A spent coin is the watcher's to classify, a renewal it has yet to adopt included.
            if (!coin || isVtxoSpent(coin)) return;
            // At most half the lifetime: a window as long as it makes each successor due at once.
            const lifetime = (await deps.providers.arkProvider.getInfo()).vtxoTreeExpiry ?? 0n;
            const half = { ...window, beforeExpirySeconds: lifetime / 2n };
            if (lifetime >= 512n && !renewalDue(advance, seen!.expiry, now, half)) return;
            const covenant = new DustCovenantScript({
                serverKey: deps.config.serverPubkey,
                emulatorKey: deps.config.emulatorPubkey,
                vtxoMinAmount: deps.config.vtxoMinAmount,
                params: covenantParamsOf(advance),
            });
            const { commitmentTxid } = await renewCovenant(
                deps.providers,
                covenant,
                coin,
                advance.covenantAddress,
                { signal: AbortSignal.any([deps.signal, AbortSignal.timeout(ATTEMPT_MS)]) },
            );
            deps.onRenewed(advance.id, commitmentTxid);
        })();
    };
}
