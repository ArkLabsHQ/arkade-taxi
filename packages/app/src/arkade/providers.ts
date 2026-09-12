import {
    RestArkProvider,
    RestIndexerProvider,
    RestEmulatorProvider,
    assertValidServerUnrollScript,
    defaultCheckpointExitDelayPolicy,
    networks,
    type ArkProvider,
    type EmulatorProvider,
    type ArkInfo,
    type CSVMultisigTapscript,
    type NetworkName,
} from "@arkade-os/sdk";
import { bytesToHex, hexToBytes } from "@arkade-taxi/protocol";
import type { TaxiConfig } from "../config.js";
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
    serverUnrollScript?: CSVMultisigTapscript.Type;
    providerIdentityOk: boolean;
    blockers: string[];
}

export async function verifyProviders(
    config: TaxiConfig,
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
    for (const [response, expected, name] of [
        [ark, config.serverPubkey, "server"],
        [emulator, config.emulatorPubkey, "emulator"],
    ] as const) {
        try {
            if (response.status === "rejected") throw new Error();
            if (normalizeSigner(response.value.signerPubkey) !== bytesToHex(expected)) {
                result.blockers.push(`${name}_identity_mismatch`);
                result.providerIdentityOk = false;
            }
        } catch {
            result.blockers.push(`${name}_unavailable`);
            result.providerIdentityOk = false;
        }
    }
    if (ark.status === "rejected") return result;
    result.info = ark.value;
    const network = Object.hasOwn(networks, ark.value.network)
        ? networks[ark.value.network as NetworkName]
        : undefined;
    if (!network) result.blockers.push("network_unknown");
    else if (network.hrp !== config.addressHrp) result.blockers.push("network_mismatch");
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
