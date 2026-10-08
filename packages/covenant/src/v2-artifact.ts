import { arkade, timelockToSequence } from "@arkade-os/sdk";
import { V2_ARTIFACT } from "./dust-covenant-artifact.js";
import { loanSats, recycleFare, type DustCovenantParams } from "./params.js";

export { V2_ARTIFACT };

/** Same namespace value-space quirk artifact.ts documents: these do not resolve as types. */
type Compiled = InstanceType<typeof arkade.ArkadeProgramScript>;
type Args = ConstructorParameters<typeof arkade.ArkadeProgramScript>[1];

let program: ReturnType<typeof arkade.programFromArtifact> | undefined;
const NO_ASSET = new Uint8Array(32);

/**
 * `hasAsset` and `assetFare` pick which branch of each covenant runs. Both are
 * pushed as literals, so a spender cannot choose: the branch is in the address.
 */
export function v2Args(p: DustCovenantParams, serverKey: Uint8Array): Args {
    const { operatorSats, assetFare } = recycleFare(p);
    return {
        receiverKey: p.receiverKey,
        senderKey: p.senderKey,
        operatorKey: p.operatorKey,
        operatorSignerKey: p.operatorSignerKey,
        operatorSats,
        loan: loanSats(p),
        locktime: p.locktime,
        exitDelay: BigInt(timelockToSequence(p.exitDelay)),
        hasAsset: p.assetId ? 1n : 0n,
        assetTxid: p.assetId?.txid ?? NO_ASSET,
        assetGidx: BigInt(p.assetId?.groupIndex ?? 0),
        assetFare,
        server: serverKey,
    };
}

export const compileV2 = (
    p: DustCovenantParams,
    serverKey: Uint8Array,
    emulatorKey: Uint8Array,
): Compiled =>
    new arkade.ArkadeProgramScript(
        (program ??= arkade.programFromArtifact(V2_ARTIFACT)),
        v2Args(p, serverKey),
        { serverKey, emulatorKey },
    );
