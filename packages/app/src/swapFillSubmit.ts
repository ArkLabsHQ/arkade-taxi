import {
    Transaction,
    verifyTapscriptSignatures,
    type EmulatorProvider,
    type Identity,
} from "@arkade-os/sdk";
import { base64, hex } from "@scure/base";
import {
    SwapFillClaimError,
    type SwapFill,
    type SwapFillGraph,
    type SwapFillRepository,
} from "@arkade-taxi/db";
import {
    bytesToHex,
    swapFillGraphToWire,
    swapFillSubmitRequestFromWire,
    type SwapFillGraph as ProtocolSwapFillGraph,
    type SwapFillStatusResponse,
} from "@arkade-taxi/protocol";
import {
    jointGraphFromWire,
    protocolGraphToStored,
    storedGraphToJoint,
} from "./arkade/swapFillBuilder.js";
import { deriveJointInputs, JointGraphDerivationError } from "./arkade/jointGraphDerivation.js";
import type { RuntimeConfig } from "./config.js";
import { ErrorCode, ServiceError } from "./errors.js";
import {
    JointSigningError,
    JointSubmissionAmbiguousError,
    prepareJointSubmission,
    providerCosignerKey,
    signJointGraphForOwner,
    submitJointFill,
    verifyOfferFillPlan,
    type JointGraph,
    type JointOwnerKeys,
    type JointPins,
    type JointSignerBinding,
    type PreparedJointSubmission,
    type SubmittedJointFill,
    unsignedPsbtBytes,
} from "@arkade-taxi/client";

export const SWAP_FILL_SUBMIT_LEASE_OWNER = "swap-fill-submit";

export interface SwapFillSubmitStore extends Pick<
    SwapFillRepository,
    | "get"
    | "expireQuotes"
    | "claimSubmit"
    | "recordPrepared"
    | "recordSubmitInvoked"
    | "recordSigningFailure"
    | "recordAmbiguous"
> {}

export interface SwapFillJointOps {
    verifyPlan(plan: JointGraph): boolean;
    signForTaxi(args: {
        expected: JointGraph;
        partial: JointGraph;
        bindings: JointSignerBinding[];
    }): Promise<JointGraph>;
    prepare(args: {
        expected: JointGraph;
        partial: JointGraph;
        ownerKeys: JointOwnerKeys;
    }): PreparedJointSubmission;
    covenantKey(args: { expected: JointGraph; emulatorXOnly: string }): string;
    submit(args: {
        expected: JointGraph;
        prepared: PreparedJointSubmission;
        provider: Pick<EmulatorProvider, "submitTx">;
        pins: JointPins;
        ownerKeys: JointOwnerKeys;
    }): Promise<SubmittedJointFill>;
}

export const productionSwapFillJointOps: SwapFillJointOps = {
    verifyPlan: (plan) => verifyOfferFillPlan(plan),
    signForTaxi: (args) => signJointGraphForOwner({ ...args, owner: "sponsor" }),
    prepare: (args) => prepareJointSubmission(args),
    covenantKey: (args) => providerCosignerKey(args),
    submit: (args) => submitJointFill({ ...args, provider: args.provider as EmulatorProvider }),
};

export interface SolverAuthArgs {
    solver: JointGraph;
    trusted: JointGraph;
    solverKeys: string[];
}

export type SolverAuthFn = (args: SolverAuthArgs) => void;

export interface SwapFillSubmitDeps {
    swapFills: SwapFillSubmitStore;
    taxiIdentity: () => Identity;
    emulator: Pick<EmulatorProvider, "submitTx">;
    config: Pick<RuntimeConfig, "serverPubkey" | "emulatorPubkey">;
    now(): number;
    randomId(): string;
    leaseSeconds: number;
    policy?: { getSnapshot(): { revision: bigint } };
    joint?: SwapFillJointOps;
    assertSolverAuthorised?: SolverAuthFn;
}

const sameBytes = (a: Uint8Array, b: Uint8Array): boolean =>
    a.length === b.length && a.every((value, index) => value === b[index]);

const xOnlyHex = (key: string, label: string): string => {
    const lower = key.toLowerCase();
    if (/^[0-9a-f]{64}$/.test(lower)) return lower;
    if (/^0[23][0-9a-f]{64}$/.test(lower)) return lower.slice(2);
    throw new JointSigningError(`${label} is not a public key`);
};

const xOnlyHexOf = (key: Uint8Array, label: string): string => {
    if (key.length === 32) return hex.encode(key).toLowerCase();
    if (key.length === 33 && (key[0] === 2 || key[0] === 3))
        return hex.encode(key.slice(1)).toLowerCase();
    throw new JointSigningError(`${label} is not a public key`);
};

const decodeTx = (psbt: string, label: string): Transaction => {
    try {
        return Transaction.fromPSBT(base64.decode(psbt));
    } catch (cause) {
        throw new JointSigningError(`${label} is not a parsable PSBT`, { cause });
    }
};

const sigKeysOf = (tx: Transaction, index: number, label: string): string[] => {
    const sigs = tx.getInput(index)?.tapScriptSig ?? [];
    return sigs.map(([metadata]) => {
        const pubKey = (metadata as { pubKey?: Uint8Array }).pubKey;
        if (!(pubKey instanceof Uint8Array) || pubKey.length !== 32)
            throw new JointSigningError(`${label} carries a non-x-only signature key`);
        return hex.encode(pubKey).toLowerCase();
    });
};

// SigHash.DEFAULT, matching the joint-signing module; submit.ts pins the same value.
const TAPSCRIPT_SIGHASH = 0;

export function assertSolverAuthorised({ solver, trusted, solverKeys }: SolverAuthArgs): void {
    const pins = new Set(solverKeys.map((key) => xOnlyHex(key, "solver key")));
    const owners = trusted.inputOwners;
    let trustedOutpoints;
    let solverOutpoints;
    try {
        trustedOutpoints = deriveJointInputs(trusted);
        solverOutpoints = deriveJointInputs(solver);
    } catch (cause) {
        if (cause instanceof JointGraphDerivationError)
            throw new JointSigningError("solver graph shape differs from the trusted graph", {
                cause,
            });
        throw cause;
    }
    if (
        solver.inputOwners.length !== owners.length ||
        solver.checkpoints.length !== owners.length ||
        trusted.checkpoints.length !== owners.length ||
        solver.inputOwners.some((owner, index) => owner !== owners[index]) ||
        solverOutpoints.some(
            (outpoint, index) =>
                outpoint.txid.toLowerCase() !== trustedOutpoints[index]!.txid.toLowerCase() ||
                outpoint.vout !== trustedOutpoints[index]!.vout,
        )
    )
        throw new JointSigningError("solver graph shape differs from the trusted graph");
    const ark = decodeTx(solver.arkTx, "solver graph arkTx");
    const checkpoints = solver.checkpoints.map((checkpoint, index) =>
        decodeTx(checkpoint, `solver graph checkpoint ${index}`),
    );
    owners.forEach((owner, index) => {
        const arkKeys = sigKeysOf(ark, index, `solver graph arkTx input ${index}`);
        const checkpointKeys = sigKeysOf(
            checkpoints[index]!,
            0,
            `solver graph checkpoint ${index}`,
        );
        if (owner === null) {
            if (arkKeys.length || checkpointKeys.length)
                throw new JointSigningError("solver graph signs the covenant input");
            return;
        }
        if (owner === "sponsor") {
            if (arkKeys.length || checkpointKeys.length)
                throw new JointSigningError(`solver graph signs sponsor input ${index}`);
            return;
        }
        if (owner !== "solver")
            throw new JointSigningError(`solver graph names unknown owner ${owner}`);
        for (const keys of [arkKeys, checkpointKeys]) {
            const onCheckpoint = keys === checkpointKeys;
            const what = onCheckpoint
                ? `solver graph checkpoint ${index}`
                : `solver graph arkTx input ${index}`;
            for (const key of keys)
                if (!pins.has(key))
                    throw new JointSigningError(`${what} carries a signature from unpinned key`);
            if (!keys.some((key) => pins.has(key)))
                throw new JointSigningError(`${what} carries no pinned solver signature`);
            try {
                verifyTapscriptSignatures(
                    onCheckpoint ? checkpoints[index]! : ark,
                    onCheckpoint ? 0 : index,
                    keys.filter((key) => pins.has(key)),
                    [],
                    [TAPSCRIPT_SIGHASH],
                );
            } catch (cause) {
                throw new JointSigningError(`${what} carries an invalid solver signature`, {
                    cause,
                });
            }
        }
    });
}

export function assertSolverGraphMatchesTrusted(solver: JointGraph, trusted: JointGraph): void {
    const mismatch = (detail: string): never => {
        throw new JointSigningError(`solver graph ${detail}; expected the quoted fill graph`);
    };
    if (solver.graphId.toLowerCase() !== trusted.graphId.toLowerCase())
        mismatch("graph id differs from the quote");
    if (
        solver.inputOwners.length !== trusted.inputOwners.length ||
        solver.inputOwners.some((owner, index) => owner !== trusted.inputOwners[index])
    )
        mismatch("inputs differ from the quote");
    // Unsigned bytes, not raw PSBTs: the solver graph carries solver
    // signatures the trusted graph does not, and the id is signature-invariant.
    const unsigned = (psbt: string, label: string): Uint8Array => {
        try {
            return unsignedPsbtBytes(decodeTx(psbt, label));
        } catch (cause) {
            if (cause instanceof JointSigningError) throw cause;
            throw new JointSigningError(`${label} is not a parsable PSBT`, { cause });
        }
    };
    if (
        !sameBytes(
            unsigned(solver.arkTx, "solver graph arkTx"),
            unsigned(trusted.arkTx, "trusted graph arkTx"),
        )
    )
        mismatch("arkTx differs from the quote");
    if (solver.checkpoints.length !== trusted.checkpoints.length)
        mismatch("checkpoints differ from the quote");
    solver.checkpoints.forEach((checkpoint, index) => {
        if (
            !sameBytes(
                unsigned(checkpoint, `solver graph checkpoint ${index}`),
                unsigned(trusted.checkpoints[index]!, `trusted graph checkpoint ${index}`),
            )
        )
            mismatch("checkpoints differ from the quote");
    });
}

const notSubmitted = (cause: unknown, fallback: string): string => {
    const message = cause instanceof Error ? cause.message : fallback;
    return message.includes("(not submitted)") ? message : `${message} (not submitted)`;
};

const ambiguousMessage = (cause: unknown): string => {
    const message = cause instanceof Error ? cause.message : "swap fill submission outcome unknown";
    return message.includes("(ambiguous:")
        ? message
        : `${message} (ambiguous: reconcile before retrying, never auto-retry)`;
};

const failSigning = (
    deps: SwapFillSubmitDeps,
    id: string,
    leaseToken: string,
    now: number,
    code: string,
    status: 400 | 404 | 409 | 500 | 503,
    cause: unknown,
): never => {
    const message = notSubmitted(cause, "swap fill signing failed");
    deps.swapFills.recordSigningFailure(id, leaseToken, code, message, now);
    throw new ServiceError(code, status, message, { cause });
};

export async function submitSwapFill(
    deps: SwapFillSubmitDeps,
    id: string,
    body: unknown,
    assertReady?: () => void,
): Promise<SwapFillStatusResponse> {
    assertReady?.();
    const now = deps.now();
    const joint = deps.joint ?? productionSwapFillJointOps;
    let solverDomain: ProtocolSwapFillGraph;
    try {
        solverDomain = swapFillSubmitRequestFromWire(body);
    } catch (e) {
        throw ServiceError.from(e);
    }
    deps.swapFills.expireQuotes(now);
    const quoted = deps.swapFills.get(id);
    if (!quoted) throw new ServiceError(ErrorCode.NotFound, 404, `swap fill ${id} not found`);
    if (quoted.state !== "quoted")
        throw new ServiceError(
            quoted.state === "expired" ? ErrorCode.QuoteExpired : ErrorCode.InvalidState,
            409,
            quoted.state === "expired"
                ? `swap fill ${id} quote expired`
                : `swap fill ${id} is ${quoted.state}, not quoted`,
        );
    if (quoted.expiresAt <= now)
        throw new ServiceError(ErrorCode.QuoteExpired, 409, `swap fill ${id} quote expired`);
    const leaseToken = deps.randomId();
    const leaseUntil = now + deps.leaseSeconds;
    let claimed: SwapFill;
    try {
        claimed = deps.swapFills.claimSubmit(
            id,
            {
                leaseOwner: SWAP_FILL_SUBMIT_LEASE_OWNER,
                leaseToken,
                leaseUntil,
                solverGraph: protocolGraphToStored(solverDomain),
                now,
            },
            deps.policy?.getSnapshot().revision,
        );
    } catch (e) {
        if (e instanceof SwapFillClaimError)
            throw new ServiceError(
                e.code === "not_found"
                    ? ErrorCode.NotFound
                    : e.code === "quote_expired"
                      ? ErrorCode.QuoteExpired
                      : ErrorCode.InvalidState,
                e.code === "not_found" ? 404 : 409,
                e.message,
                { cause: e },
            );
        throw e;
    }
    const trusted: JointGraph = storedGraphToJoint(claimed.graph);
    if (!joint.verifyPlan(trusted))
        failSigning(
            deps,
            id,
            leaseToken,
            now,
            "swap_fill_graph_integrity",
            500,
            new JointSigningError("trusted graph fails integrity"),
        );
    let solver: JointGraph;
    try {
        solver = jointGraphFromWire(swapFillGraphToWire(solverDomain));
    } catch (cause) {
        failSigning(deps, id, leaseToken, now, "swap_fill_graph_conflict", 409, cause);
    }
    try {
        assertSolverGraphMatchesTrusted(solver!, trusted!);
    } catch (cause) {
        failSigning(deps, id, leaseToken, now, "swap_fill_graph_conflict", 409, cause);
    }
    try {
        (deps.assertSolverAuthorised ?? assertSolverAuthorised)({
            solver: solver!,
            trusted: trusted!,
            solverKeys: claimed.solverKeys,
        });
    } catch (cause) {
        failSigning(deps, id, leaseToken, now, "swap_fill_solver_unauthorised", 409, cause);
    }
    let taxiIdentity: Identity;
    try {
        taxiIdentity = deps.taxiIdentity();
    } catch (cause) {
        failSigning(deps, id, leaseToken, now, "swap_fill_signing_failed", 503, cause);
    }
    const bindings: JointSignerBinding[] = trusted!.inputOwners
        .map((owner, inputIndex) => ({ owner, inputIndex }))
        .filter(({ owner }) => owner === "sponsor")
        .map(({ inputIndex }) => ({ inputIndex, identity: taxiIdentity! }));
    let taxiSigned: JointGraph;
    try {
        taxiSigned = await joint.signForTaxi({ expected: trusted!, partial: solver!, bindings });
    } catch (cause) {
        failSigning(deps, id, leaseToken, now, "swap_fill_signing_failed", 503, cause);
    }
    let taxiXOnly: string;
    try {
        taxiXOnly = xOnlyHexOf(await taxiIdentity!.xOnlyPublicKey(), "taxi key");
    } catch (cause) {
        failSigning(deps, id, leaseToken, now, "swap_fill_signing_failed", 503, cause);
    }
    const ownerKeys: JointOwnerKeys = {
        solver: [...claimed.solverKeys],
        sponsor: [taxiXOnly!],
    };
    let prepared: PreparedJointSubmission;
    try {
        prepared = joint.prepare({ expected: trusted!, partial: taxiSigned!, ownerKeys });
    } catch (cause) {
        failSigning(deps, id, leaseToken, now, "swap_fill_signing_failed", 503, cause);
    }
    if (
        !deps.swapFills.recordPrepared(
            id,
            leaseToken,
            prepared!.arkTx,
            [...prepared!.checkpointTxs],
            now,
        )
    )
        throw new ServiceError(
            ErrorCode.InvalidState,
            409,
            `swap fill ${id} lease lost before submission (not submitted)`,
        );
    const emulatorXOnly = bytesToHex(deps.config.emulatorPubkey).toLowerCase();
    const serverXOnly = bytesToHex(deps.config.serverPubkey).toLowerCase();
    let covenantPin: string;
    try {
        covenantPin = joint.covenantKey({ expected: trusted!, emulatorXOnly });
    } catch (cause) {
        failSigning(deps, id, leaseToken, now, "swap_fill_signing_failed", 503, cause);
    }
    if (covenantPin!.toLowerCase() === emulatorXOnly)
        failSigning(
            deps,
            id,
            leaseToken,
            now,
            "swap_fill_covenant_pin_invalid",
            500,
            new JointSigningError("covenant cosigner equals the raw emulator key"),
        );
    if (!deps.swapFills.recordSubmitInvoked(id, leaseToken, now))
        throw new ServiceError(
            ErrorCode.InvalidState,
            409,
            `swap fill ${id} lease lost before submission (not submitted)`,
        );
    const pins: JointPins = { emulatorXOnly, serverXOnly };
    let submitted: SubmittedJointFill;
    try {
        submitted = await joint.submit({
            expected: trusted!,
            prepared: prepared!,
            provider: deps.emulator,
            pins,
            ownerKeys,
        });
    } catch (cause) {
        if (cause instanceof JointSigningError)
            failSigning(deps, id, leaseToken, now, "swap_fill_signing_failed", 503, cause);
        if (!(cause instanceof JointSubmissionAmbiguousError)) {
            const message = ambiguousMessage(
                new JointSubmissionAmbiguousError("emulator submitTx threw", { cause }),
            );
            deps.swapFills.recordAmbiguous(
                id,
                leaseToken,
                "swap_fill_submission_ambiguous",
                message,
                now + deps.leaseSeconds,
                now,
            );
            throw new ServiceError("swap_fill_submission_ambiguous", 503, message, { cause });
        }
        const message = ambiguousMessage(cause);
        deps.swapFills.recordAmbiguous(
            id,
            leaseToken,
            "swap_fill_submission_ambiguous",
            message,
            now + deps.leaseSeconds,
            now,
        );
        throw new ServiceError("swap_fill_submission_ambiguous", 503, message, { cause });
    }
    return {
        fillId: id,
        operationId: claimed.operationId,
        state: "submitting",
        txid: submitted!.txid,
        updatedAt: now,
        expiresAt: claimed.expiresAt,
    };
}
