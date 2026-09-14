import {
    RestArkProvider,
    RestIndexerProvider,
    RestEmulatorProvider,
    assertValidServerUnrollScript,
    defaultCheckpointExitDelayPolicy,
    defaultEmulatorPubkey,
    networks,
    type ArkProvider,
    type EmulatorProvider,
    type ArkInfo,
    type CSVMultisigTapscript,
    type Network,
    type NetworkName,
} from "@arkade-os/sdk";
import { bytesToHex, hexToBytes } from "@arkade-taxi/protocol";
import type { RuntimeConfig, TaxiConfig } from "../config.js";
import type { ExpiryDeadline } from "@arkade-taxi/core";

export function normalizeExpiry(coin: {
    expiresAt?: Date;
    expiresAtHeight?: number;
}): ExpiryDeadline {
    if ((coin.expiresAt !== undefined) === (coin.expiresAtHeight !== undefined))
        throw new Error("unknown or ambiguous VTXO expiry");
    const kind = coin.expiresAt !== undefined ? "time" : "height";
    const value = kind === "time" ? coin.expiresAt!.getTime() / 1000 : coin.expiresAtHeight!;
    if (!Number.isSafeInteger(value) || value <= 0) throw new Error("invalid VTXO expiry");
    return { kind, value: BigInt(value) };
}

export function normalizeSigner(key: string): string {
    if (/^[0-9a-f]{64}$/i.test(key)) return key.toLowerCase();
    if (/^0[23][0-9a-f]{64}$/i.test(key)) return key.slice(2).toLowerCase();
    throw new Error("invalid provider signer encoding");
}

export function createProviders(config: TaxiConfig) {
    return {
        arkProvider: new RestArkProvider(config.arkdUrl),
        indexerProvider: new RestIndexerProvider(config.indexerUrl),
        emulatorProvider: new RestEmulatorProvider(config.emulatorUrl),
    };
}

export interface VerifiedProviders {
    info?: ArkInfo;
    network?: Network;
    serverPubkey?: Uint8Array;
    emulatorPubkey?: Uint8Array;
    serverUnrollScript?: CSVMultisigTapscript.Type;
    providerIdentityOk: boolean;
    blockers: string[];
}

export async function verifyProviders(
    config: TaxiConfig &
        Partial<
            Pick<
                RuntimeConfig,
                "networkName" | "serverPubkey" | "dust" | "vtxoMinAmount" | "addressHrp"
            >
        >,
    providers: {
        arkProvider: Pick<ArkProvider, "getInfo">;
        emulatorProvider: Pick<EmulatorProvider, "getInfo">;
    },
): Promise<VerifiedProviders> {
    const [ark, emulator] = await Promise.allSettled([
        providers.arkProvider.getInfo(),
        providers.emulatorProvider.getInfo(),
    ]);
    const result: VerifiedProviders = { providerIdentityOk: true, blockers: [] };
    try {
        if (ark.status === "rejected") throw new Error();
        result.serverPubkey = hexToBytes(normalizeSigner(ark.value.signerPubkey), "server key");
        if (
            config.serverPubkey &&
            normalizeSigner(ark.value.signerPubkey) !== bytesToHex(config.serverPubkey)
        ) {
            result.blockers.push("server_identity_mismatch");
            result.providerIdentityOk = false;
        }
    } catch {
        result.blockers.push("server_unavailable");
        result.providerIdentityOk = false;
    }
    if (ark.status === "rejected") return result;
    result.info = ark.value;
    const network = Object.hasOwn(networks, ark.value.network)
        ? networks[ark.value.network as NetworkName]
        : undefined;
    result.network = network;
    if (!network) result.blockers.push("network_unknown");
    else {
        if (
            (config.networkName && network.name !== config.networkName) ||
            (config.addressHrp && network.hrp !== config.addressHrp)
        )
            result.blockers.push("network_mismatch");
        try {
            result.emulatorPubkey = hexToBytes(
                normalizeSigner(defaultEmulatorPubkey(network)),
                "emulator key",
            );
        } catch {
            result.blockers.push("emulator_key_unavailable");
            result.providerIdentityOk = false;
        }
        if (result.emulatorPubkey) {
            try {
                if (emulator.status === "rejected") throw new Error();
                if (
                    normalizeSigner(emulator.value.signerPubkey) !==
                    bytesToHex(result.emulatorPubkey)
                ) {
                    result.blockers.push("emulator_identity_mismatch");
                    result.providerIdentityOk = false;
                }
            } catch {
                result.blockers.push("emulator_unavailable");
                result.providerIdentityOk = false;
            }
        }
    }
    if (config.dust !== undefined && ark.value.dust !== config.dust)
        result.blockers.push("dust_mismatch");
    if (config.vtxoMinAmount !== undefined && ark.value.vtxoMinAmount !== config.vtxoMinAmount)
        result.blockers.push("vtxo_min_amount_mismatch");
    if (
        ark.value.dust <= 0n ||
        ark.value.vtxoMinAmount <= 0n ||
        ark.value.vtxoMinAmount > ark.value.dust
    )
        result.blockers.push("provider_limits_invalid");
    try {
        if (!network) throw new Error();
        result.serverUnrollScript = assertValidServerUnrollScript(ark.value.checkpointTapscript, {
            ...defaultCheckpointExitDelayPolicy(network),
            advertisedForfeitPubkey: hexToBytes(
                normalizeSigner(ark.value.forfeitPubkey),
                "forfeit key",
            ),
        });
    } catch {
        result.blockers.push("server_unroll_invalid");
    }
    return result;
}
