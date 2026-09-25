import type { EmulatorProvider } from "@arkade-os/sdk";
import type { FillInputOwner } from "@arkade-os/swap";
import {
    prepareJointSubmission as prepareCore,
    providerCosignerKey as providerCore,
    signJointGraphForOwner as signCore,
    submitJointFill as submitCore,
    type JointOwnerKeys as CoreOwnerKeys,
    type JointPins,
    type JointSignerBinding,
    type PreparedJointSubmission,
    type SubmittedJointFill,
} from "./jointSigning.js";
import type { JointGraph } from "./jointGraph.js";
import { OFFER_FILL_TEMPLATE } from "./offerFillPlan.js";

export {
    JointSigningError,
    JointSubmissionAmbiguousError,
    type JointPins,
    type JointSignerBinding,
    type PreparedJointSubmission,
    type SubmittedJointFill,
} from "./jointSigning.js";

export type JointFundingOwner = FillInputOwner;

export type JointOwnerKeys = Partial<Record<JointFundingOwner, readonly string[]>>;

const asCoreKeys = (ownerKeys: JointOwnerKeys): CoreOwnerKeys => ownerKeys as CoreOwnerKeys;

export function signJointGraphForOwner(args: {
    expected: JointGraph;
    partial?: JointGraph;
    owner: JointFundingOwner;
    bindings: JointSignerBinding[];
}): Promise<JointGraph> {
    return signCore({ ...args, template: OFFER_FILL_TEMPLATE });
}

export function prepareJointSubmission(args: {
    expected: JointGraph;
    partial: JointGraph;
    ownerKeys: JointOwnerKeys;
}): PreparedJointSubmission {
    return prepareCore({
        ...args,
        ownerKeys: asCoreKeys(args.ownerKeys),
        template: OFFER_FILL_TEMPLATE,
    });
}

export function providerCosignerKey(args: { expected: JointGraph; emulatorXOnly: string }): string {
    return providerCore({ ...args, template: OFFER_FILL_TEMPLATE });
}

export function submitJointFill(args: {
    expected: JointGraph;
    prepared: PreparedJointSubmission;
    provider: Pick<EmulatorProvider, "submitTx">;
    pins: JointPins;
    ownerKeys: JointOwnerKeys;
}): Promise<SubmittedJointFill> {
    return submitCore({
        ...args,
        ownerKeys: asCoreKeys(args.ownerKeys),
        template: OFFER_FILL_TEMPLATE,
    });
}
