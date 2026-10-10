import type { EmulatorProvider } from "@arkade-os/sdk";
import { digestJointGraph, type JointGraph } from "./jointGraph.js";
import {
    prepareJointSubmission as prepareCore,
    providerCosignerKeys as providerCore,
    signJointGraphForOwner as signCore,
    submitJointFill as submitCore,
    type JointOwnerKeys as CoreOwnerKeys,
    type JointPins,
    type JointSignerBinding,
    type PreparedJointSubmission,
    type SubmittedJointFill,
} from "./jointSigning.js";

/**
 * `/v1/fills`' own domain string. Separate from `offer-fill/1` on purpose: a
 * graph signed for one rail must not verify as the other, and the graph id
 * commits to the template.
 */
export const FILL_TEMPLATE = "fill/1";

/** The only owner the Taxi labels on a generic fill. Everything else is the
 * caller's and carries no owner at all. */
export type FillOwner = "taxi";

export type FillOwnerKeys = Partial<Record<FillOwner, readonly string[]>>;

const asCoreKeys = (ownerKeys: FillOwnerKeys): CoreOwnerKeys => ownerKeys as CoreOwnerKeys;

/** `null` for every input the Taxi does not own, which is what marks the
 * provider-gated ones for the emulator route. */
export function sealFillGraph(plan: {
    arkTx: string;
    checkpoints: readonly string[];
    taxiInputIndexes: readonly number[];
}): JointGraph {
    const taxi = new Set(plan.taxiInputIndexes);
    const graph = {
        arkTx: plan.arkTx,
        checkpoints: [...plan.checkpoints],
        inputOwners: plan.checkpoints.map((_, index) => (taxi.has(index) ? "taxi" : null)),
    };
    return { ...graph, graphId: digestJointGraph(graph, FILL_TEMPLATE) };
}

export function signFillForTaxi(args: {
    expected: JointGraph;
    partial?: JointGraph;
    bindings: JointSignerBinding[];
}): Promise<JointGraph> {
    return signCore({ ...args, owner: "taxi", template: FILL_TEMPLATE });
}

export function prepareFillSubmission(args: {
    expected: JointGraph;
    partial: JointGraph;
    ownerKeys: FillOwnerKeys;
}): PreparedJointSubmission {
    return prepareCore({
        ...args,
        ownerKeys: asCoreKeys(args.ownerKeys),
        template: FILL_TEMPLATE,
    });
}

/** Empty when no input is provider-gated, which selects the arkd route. */
export function fillCosignerKeys(args: {
    expected: JointGraph;
    emulatorXOnly: string;
}): Map<number, string> {
    return providerCore({ ...args, template: FILL_TEMPLATE });
}

export function submitFillGraph(args: {
    expected: JointGraph;
    prepared: PreparedJointSubmission;
    provider: Pick<EmulatorProvider, "submitTx">;
    pins: JointPins;
    ownerKeys: FillOwnerKeys;
}): Promise<SubmittedJointFill> {
    return submitCore({
        ...args,
        ownerKeys: asCoreKeys(args.ownerKeys),
        template: FILL_TEMPLATE,
    });
}
