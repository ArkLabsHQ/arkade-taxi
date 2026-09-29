import { isDeepStrictEqual } from "node:util";
import { ArkAddress, type CSVMultisigTapscript, type Transaction } from "@arkade-os/sdk";
import type { FareSpec } from "@arkade-taxi/core";
import type { AssetIdRef } from "@arkade-taxi/covenant";
import type { FundingInputValue } from "@arkade-taxi/protocol";
import type { RuntimeConfig } from "../config.js";
import type { FundingSelection } from "./inventory.js";
import { LockupShapeError } from "../lockup.js";
import { domainGraphId, parseJointEnvelope } from "./psbt.js";
import { buildJointEnvelope, jointPlan, operatorFundingInput } from "./lockupBuilder.js";

/** Joint-send terms without a covenant. `contribution` plays the role of the
 * covenant `topup`: sats the operator fronts toward the receiver's dust
 * carrier. There is no locktime because there is no recovery leaf. */
export interface SponsoredParams {
    receiverKey: Uint8Array;
    senderKey: Uint8Array;
    operatorKey: Uint8Array;
    dust: bigint;
    contribution: bigint;
    assetId?: AssetIdRef;
    /** Sender-declared extra extension packet; see SponsoredQuoteParams. */
    extraPacket?: { type: number; payload: Uint8Array };
}

export interface SponsoredBuildRequest {
    senderInputs: FundingInputValue[];
    assetUnits?: bigint;
    funding: FundingSelection;
    advanceId: string;
    params: SponsoredParams;
    /** Bob's full canonical address. The payment output pays it directly. */
    receiverAddress: string;
    /** A separate output at submission, as with the covenant flow: an asset fare
     * is sender-funded and the operator supplies its hosting sats. */
    fare: FareSpec;
    /** Set on every new positive-sats-fare payment: the fare leaves sender change
     * instead of operator change. Absent reconstructs a funded legacy graph. */
    satsFarePayer?: "sender";
    senderSats: bigint;
}

function receiverAddress(req: SponsoredBuildRequest, config: RuntimeConfig): ArkAddress {
    let address: ArkAddress;
    try {
        address = ArkAddress.decode(req.receiverAddress);
    } catch {
        throw new LockupShapeError("receiver address is invalid");
    }
    if (address.encode() !== req.receiverAddress)
        throw new LockupShapeError("receiver address is not canonical");
    if (address.hrp !== config.addressHrp)
        throw new LockupShapeError("receiver address uses the wrong network");
    if (!isDeepStrictEqual(address.serverPubKey, config.serverPubkey))
        throw new LockupShapeError("receiver address names the wrong Arkade server key");
    if (!isDeepStrictEqual(address.vtxoTaprootKey, req.params.receiverKey))
        throw new LockupShapeError("receiver key differs from receiver address");
    return address;
}

export function sponsoredPlan(req: SponsoredBuildRequest, config: RuntimeConfig) {
    if (!isDeepStrictEqual(req.params.operatorKey, config.operatorKey))
        throw new LockupShapeError("operator payout differs from runtime configuration");
    if (req.params.dust !== config.dust)
        throw new LockupShapeError("payment dust differs from runtime configuration");
    if (req.params.contribution < config.vtxoMinAmount || req.params.contribution > req.params.dust)
        throw new LockupShapeError("operator contribution is outside the dust window");
    if (req.fare.units < 0n) throw new LockupShapeError("negative fare");
    const operatorInputs = req.funding.inputs.map(operatorFundingInput);
    const inputs = [...req.senderInputs, ...operatorInputs];
    if (!req.senderInputs.length || !operatorInputs.length)
        throw new LockupShapeError("both funding owners required");
    if (
        new Set(inputs.map((input) => input.expiry.kind)).size !== 1 ||
        inputs.some((input) => input.expiry.value <= 0n)
    )
        throw new LockupShapeError("inconsistent funding expiry evidence");
    if (new Set(inputs.map((i) => `${i.txid}:${i.vout}`)).size !== inputs.length)
        throw new LockupShapeError("duplicate funding outpoint");
    if (req.senderInputs.reduce((sum, i) => sum + i.value, 0n) !== req.senderSats)
        throw new LockupShapeError("senderSats differs from funding inputs");
    if (operatorInputs.reduce((sum, i) => sum + i.value, 0n) !== req.funding.totalValue)
        throw new LockupShapeError("operator funding total differs");
    const receiver = receiverAddress(req, config);
    return {
        ...jointPlan(req, config, {
            inputs,
            operatorInputs,
            first: {
                role: "payment",
                script: Uint8Array.from(receiver.pkScript),
                amount: req.params.dust,
            },
            contribution: req.params.contribution,
            carrier: "payment",
            kind: "payment",
            extraPacket: req.params.extraPacket,
        }),
        receiver,
    };
}

export function sponsoredGraphId(tx: Transaction, checkpoints: Transaction[]): string {
    return domainGraphId("arkade-taxi-sponsored-v1\0", tx, checkpoints);
}

export function buildSponsoredEnvelope(
    req: SponsoredBuildRequest,
    config: RuntimeConfig,
    unroll: CSVMultisigTapscript.Type,
): string {
    return buildJointEnvelope(
        req.senderInputs,
        sponsoredPlan(req, config),
        unroll,
        sponsoredGraphId,
    );
}

export function parseSponsoredEnvelope(
    encoded: string,
    req: SponsoredBuildRequest,
    config: RuntimeConfig,
    unroll: CSVMultisigTapscript.Type,
) {
    const plan = sponsoredPlan(req, config);
    return parseJointEnvelope(
        encoded,
        {
            senderInputs: req.senderInputs,
            operatorKey: req.params.operatorKey,
            plan,
            paymentOutputIndex: 0,
            paymentIndexLabel: "payment index",
            unsignedId: sponsoredGraphId,
            skipScriptCheck: (role) => role === "payment",
            verifyPaymentOutput: (tx) => {
                const script = tx.getOutput(0).script;
                if (!script || !isDeepStrictEqual(script, plan.receiver.pkScript))
                    throw new LockupShapeError("lockup payment output mismatch");
            },
        },
        config,
        unroll,
    );
}
