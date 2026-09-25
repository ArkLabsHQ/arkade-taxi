import { ArkAddress } from "@arkade-os/sdk";
import { advanceKind, type Advance } from "@arkade-taxi/core";
import type { AdvanceRepository } from "@arkade-taxi/db";
import {
    fareToWire,
    quoteParamsToWire,
    type ReceiverClaimState,
    type ReceiverClaimWire,
} from "@arkade-taxi/protocol";
import type { RuntimeConfig } from "./config.js";
import { ServiceError } from "./errors.js";
import type { RouteDeps } from "./routes.js";
import { validatePersistedLockupGraph } from "./arkade/submit.js";
import { readFundingSource } from "./arkade/fundingSource.js";

export const ACTIVE_CLAIM_STATES = ["locking", "locked", "recovering"] as const;

export interface ParsedReceivers {
    addresses: string[];
    receiverKeys: Uint8Array[];
}

const invalidBatch = (message: string): never => {
    throw new ServiceError("invalid_receiver_batch", 400, message);
};

export function parseReceiverAddresses(
    values: readonly string[],
    config: Pick<RuntimeConfig, "addressHrp" | "serverPubkey">,
): ParsedReceivers {
    const addresses = [...new Set(values)];
    if (addresses.length === 0 || addresses.length > 64)
        invalidBatch("receiver batch must contain between 1 and 64 unique addresses");
    const receiverKeys = addresses.map((value) => {
        let decoded: ArkAddress;
        try {
            decoded = ArkAddress.decode(value);
        } catch {
            return invalidBatch("receiver address is invalid");
        }
        if (decoded.encode() !== value) invalidBatch("receiver address is not canonical");
        if (decoded.hrp !== config.addressHrp)
            invalidBatch("receiver address uses the wrong network");
        if (
            decoded.serverPubKey.length !== config.serverPubkey.length ||
            !decoded.serverPubKey.every((byte, index) => byte === config.serverPubkey[index])
        )
            invalidBatch("receiver address names the wrong Arkade server key");
        return decoded.vtxoTaprootKey;
    });
    return { addresses, receiverKeys };
}

export function listReceiverClaims(
    deps: {
        config: RouteDeps["config"];
        advances: Pick<AdvanceRepository, "byReceiverKeys">;
    },
    receivers: ParsedReceivers,
    states: readonly ReceiverClaimState[] = ACTIVE_CLAIM_STATES,
): ReceiverClaimWire[] {
    const selected = new Set<string>(states);
    // Sponsored direct sends pay the receiver's own address: there is no
    // claim to discover, so they never enter the claim feed.
    const visible = (advance: Advance): boolean =>
        advanceKind(advance) === "covenant" &&
        advance.state !== "quoted" &&
        selected.has(advance.state);
    return deps.advances
        .byReceiverKeys(receivers.receiverKeys)
        .filter(visible)
        .sort((a, b) => a.updatedAt - b.updatedAt || a.id.localeCompare(b.id))
        .map((advance): ReceiverClaimWire => {
            const result: ReceiverClaimWire = {
                transferId: advance.id,
                receiverAddress: new ArkAddress(
                    deps.config.serverPubkey,
                    advance.receiverKey,
                    deps.config.addressHrp,
                ).encode(),
                state: advance.state as ReceiverClaimState,
                claimable: advance.state === "locked",
                updatedAt: advance.updatedAt,
            };
            if (advance.state === "locked") {
                try {
                    const source = readFundingSource(advance.unsignedLockupTx);
                    const covenantOutputIndex =
                        source.kind === "joint-fill"
                            ? source.covenantOutpoint.vout
                            : validatePersistedLockupGraph(advance, deps.config)
                                  .covenantOutputIndex;
                    const { outpoint, recoveryLocktime } = advance;
                    const jointScriptMatches =
                        source.kind === "legacy" ||
                        (() => {
                            const expected = ArkAddress.decode(advance.covenantAddress).pkScript;
                            return (
                                source.covenantOutpoint.txid === outpoint?.txid &&
                                source.covenantScript.length === expected.length &&
                                source.covenantScript.every(
                                    (byte, index) => byte === expected[index],
                                )
                            );
                        })();
                    if (
                        !outpoint ||
                        !jointScriptMatches ||
                        outpoint.vout !== covenantOutputIndex ||
                        !recoveryLocktime ||
                        recoveryLocktime.kind !== advance.batchExpiry.kind ||
                        recoveryLocktime.value !== advance.locktime ||
                        (source.kind === "joint-fill"
                            ? source.assetUnits
                            : (() => {
                                  const envelope = validatePersistedLockupGraph(
                                      advance,
                                      deps.config,
                                  );
                                  return envelope.assetUnits === undefined
                                      ? undefined
                                      : BigInt(envelope.assetUnits);
                              })()) !== advance.assetUnits
                    )
                        throw new Error("persisted claim facts disagree with the lockup graph");
                    result.claim = {
                        params: quoteParamsToWire(advance),
                        covenantAddress: advance.covenantAddress,
                        outpoint: { ...outpoint },
                        ...(advance.assetUnits === undefined
                            ? {}
                            : { assetUnits: advance.assetUnits.toString() }),
                        fare: fareToWire(advance.fare),
                        batchExpiry: {
                            kind: advance.batchExpiry.kind,
                            value: advance.batchExpiry.value.toString(),
                        },
                        recoveryLocktime: {
                            kind: recoveryLocktime.kind,
                            value: recoveryLocktime.value.toString(),
                        },
                        ...(advance.receiverFare ? { unclaimedMode: "reclaim" as const } : {}),
                    };
                } catch (cause) {
                    throw new ServiceError("internal_error", 500, "internal error", { cause });
                }
            } else if (advance.state !== "locking" && advance.state !== "recovering") {
                if (advance.spentTxid !== undefined) result.spentTxid = advance.spentTxid;
                if (advance.failureCode !== undefined) result.failureCode = advance.failureCode;
            }
            return result;
        });
}
