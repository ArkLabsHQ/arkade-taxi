import type { Identity } from "@arkade-os/sdk";
import type { JointGraph } from "./jointGraph.js";
import { signJointGraphForOwner } from "./offerFillSigning.js";
import type { JointSignerBinding } from "./jointSigning.js";

/** Per-input identity when a solver's coins are not all under one key. */
export type SolverIdentitySource = Identity | ((inputIndex: number) => Identity);

const identityFor = (source: SolverIdentitySource, inputIndex: number): Identity =>
    typeof source === "function" ? source(inputIndex) : source;

/**
 * Which inputs of `expected` the solver owns, in input order.
 *
 * Exported because a caller that holds one key per coin needs the indices
 * before it can look them up.
 */
export function solverInputIndices(expected: JointGraph): number[] {
    if (!expected || !Array.isArray(expected.inputOwners))
        throw new Error("expected graph has no inputOwners");
    return expected.inputOwners.flatMap((owner, index) => (owner === "solver" ? [index] : []));
}

/**
 * Sign the solver's own inputs in a sponsored fill.
 *
 * `expected` must be the graph the solver built itself — see
 * `buildOfferFillPlan`. Bindings are derived from it and never from `partial`,
 * so a counterparty that relabels an owner cannot steer which inputs get
 * signed; `signJointGraphForOwner` then re-checks `partial` against `expected`
 * and refuses anything that drifted.
 */
export async function signSwapFillAsSolver(args: {
    expected: JointGraph;
    /** Taxi's partial, when co-signing one. Omit to sign first. */
    partial?: JointGraph;
    identity: SolverIdentitySource;
}): Promise<JointGraph> {
    const owned = solverInputIndices(args.expected);
    if (owned.length === 0) throw new Error("fill assigns no inputs to the solver");
    const bindings: JointSignerBinding[] = owned.map((inputIndex) => ({
        inputIndex,
        identity: identityFor(args.identity, inputIndex),
    }));
    return signJointGraphForOwner({
        expected: args.expected,
        ...(args.partial !== undefined ? { partial: args.partial } : {}),
        owner: "solver",
        bindings,
    });
}
