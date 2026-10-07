import { Transaction, verifyTapscriptSignatures, type VirtualCoin } from "@arkade-os/sdk";
import { assessSolvency, type CustodySolvency, type Outpoint } from "@arkade-taxi/core";
import type { JointGraph } from "@arkade-taxi/client";
import { CustodyError, CustodySweptError, type CustodyRecord } from "@arkade-taxi/db";
import type { CustodyLiabilities, CustodyRepository } from "@arkade-taxi/db";
import { base64, hex } from "@scure/base";
import { randomUUID } from "node:crypto";
import { deriveJointInputs, JointGraphDerivationError } from "./arkade/jointGraphDerivation.js";
import { holdings, swapAssetId } from "./proceeds.js";

export type CustodyReleaseCode =
    | "custody_change_below_dust"
    | "custody_fare_exceeds_owed"
    | "custody_graph_mismatch"
    | "custody_owner_unsigned"
    | "custody_release_unconfirmed";

export class CustodyReleaseError extends Error {
    constructor(
        readonly code: CustodyReleaseCode,
        detail: string,
    ) {
        super(`${code}: ${detail}`);
        this.name = "CustodyReleaseError";
    }
}

/**
 * Too few spendable coins to fund the release right now. Retryable, and
 * deliberately raised before the row is claimed: a liquidity dip must not
 * consume a liability the Taxi still owes.
 */
export class CustodyAwaitingLiquidityError extends Error {
    readonly code = "custody_release_awaiting_liquidity";

    constructor(
        readonly advanceId: string,
        readonly requiredSats: bigint,
    ) {
        super(`custody_release_awaiting_liquidity: ${advanceId} needs ${requiredSats} sats`);
        this.name = "CustodyAwaitingLiquidityError";
    }
}

export interface CustodyReleasePlan {
    /** What the Taxi's own inputs must cover: the net owed plus a dust change
     * floor, so a change output always exists to host any asset remainder. */
    fundingSats: bigint;
    /** Net sats the owner receives beside their own input. */
    netSats: bigint;
    /** Units the owner receives. */
    netUnits: bigint;
    /** Units the Taxi keeps as the covenant's committed fare. */
    assetFare: bigint;
    ownerScript: Uint8Array;
    /** The owner's output, given what their own coin brings. */
    ownerAmount: bigint;
    /** Sats the owner's coin must bring for `ownerAmount` to clear the floor. */
    neededSats: bigint;
}

const SIGHASH_DEFAULT = 0;
const accountScript = (key: Uint8Array): Uint8Array => new Uint8Array([0x51, 0x20, ...key]);

/**
 * The solvency view for one pass. `lendableSats` and `coins` must come from the
 * same runtime snapshot: two readers disagreeing about "now" is the bug this
 * single call exists to prevent.
 */
export function custodySolvencyView(args: {
    liabilities: CustodyLiabilities;
    coins: readonly VirtualCoin[];
    lendableSats: bigint;
    receivableSats: bigint;
}): CustodySolvency {
    const held = new Map(holdings(args.coins).map((h) => [h.assetId, BigInt(h.amount)]));
    return assessSolvency({
        owed: { owedSats: args.liabilities.owedSats, assets: args.liabilities.assets },
        lendableSats: args.lendableSats,
        heldUnits: args.liabilities.assets.map(({ assetId }) => ({
            assetId,
            units: held.get(swapAssetId(assetId)) ?? 0n,
        })),
        receivableSats: args.receivableSats,
    });
}

/**
 * Spec 5.3 under commingled custody: the Taxi funds from its own inventory, so
 * what the row fixes is the amount, not a coin. The loan was already repaid by
 * the reclaim, and the fare is the one the covenant committed to — read off the
 * row, never re-quoted.
 */
export function planCustodyRelease(args: {
    row: CustodyRecord;
    ownerCoinSats: bigint;
    dust: bigint;
    vtxoMinAmount: bigint;
}): CustodyReleasePlan {
    const { row, ownerCoinSats, dust, vtxoMinAmount } = args;
    const satsFare = row.fare?.currency === "sats" ? row.fare.units : 0n;
    const assetFare = row.fare?.currency === "asset" ? row.fare.units : 0n;
    const netSats = row.owedSats - satsFare;
    const netUnits = (row.assetUnits ?? 0n) - assetFare;
    if (netSats < 0n || netUnits < 0n)
        throw new CustodyReleaseError(
            "custody_fare_exceeds_owed",
            `fare leaves ${netSats} sats and ${netUnits} units owed`,
        );
    const floor = vtxoMinAmount > dust ? vtxoMinAmount : dust;
    const ownerAmount = ownerCoinSats + netSats;
    const needed = floor - netSats;
    if (ownerAmount < floor)
        throw new CustodyReleaseError(
            "custody_change_below_dust",
            `owner output ${ownerAmount} is below ${floor}; bring ${needed} sats`,
        );
    return {
        // Funding the net plus dust guarantees a change output, which hosts the
        // asset remainder and keeps the selection's own change floor satisfiable.
        fundingSats: netSats + dust,
        netSats,
        netUnits,
        assetFare,
        ownerScript: accountScript(row.ownerKey),
        ownerAmount,
        neededSats: needed > 0n ? needed : 0n,
    };
}

const decode = (psbt: string, label: string): Transaction => {
    try {
        return Transaction.fromPSBT(base64.decode(psbt));
    } catch {
        throw new CustodyReleaseError("custody_graph_mismatch", `${label} is not a parsable PSBT`);
    }
};

const unsignedBytes = (tx: Transaction): Uint8Array => {
    const stripped = tx.clone();
    for (let i = 0; i < stripped.inputsLength; i++)
        stripped.updateInput(i, { tapScriptSig: undefined });
    return stripped.toPSBT();
};

const sameBytes = (a: Uint8Array, b: Uint8Array): boolean =>
    a.length === b.length && a.every((byte, i) => byte === b[i]);

const sigKeys = (tx: Transaction, index: number): string[] =>
    (tx.getInput(index).tapScriptSig ?? []).map(([meta]) => hex.encode(meta.pubKey).toLowerCase());

/**
 * Spec 5.2: the owner has to sign their own input regardless, so that signature
 * is the proof of key possession and there is no challenge protocol to build.
 * The owner's input is the last one; every input before it is the Taxi's and
 * must carry no client signature.
 */
export function assertCustodyReleaseAuthorised(args: {
    signed: JointGraph;
    trusted: JointGraph;
    ownerKey: Uint8Array;
}): void {
    const { signed, trusted } = args;
    const owner = hex.encode(args.ownerKey).toLowerCase();
    const mismatch = (detail: string): never => {
        throw new CustodyReleaseError("custody_graph_mismatch", detail);
    };
    const ownerIndex = trusted.inputOwners.length - 1;
    if (ownerIndex < 1) mismatch("the release graph must have a Taxi input and an owner input");
    if (
        signed.inputOwners.length !== trusted.inputOwners.length ||
        signed.checkpoints.length !== trusted.checkpoints.length ||
        signed.inputOwners.some((o, i) => o !== trusted.inputOwners[i])
    )
        mismatch("signed graph shape differs from the graph the Taxi built");
    try {
        const inputs = deriveJointInputs(trusted);
        const claimed = deriveJointInputs(signed);
        if (claimed.some((o, i) => o.txid !== inputs[i]!.txid || o.vout !== inputs[i]!.vout))
            mismatch("signed graph spends different coins");
    } catch (cause) {
        if (cause instanceof JointGraphDerivationError) mismatch(cause.message);
        throw cause;
    }
    const signedArk = decode(signed.arkTx, "signed arkTx");
    if (!sameBytes(unsignedBytes(signedArk), unsignedBytes(decode(trusted.arkTx, "trusted arkTx"))))
        mismatch("signed arkTx differs from the graph the Taxi built");
    signed.checkpoints.forEach((checkpoint, index) => {
        if (
            !sameBytes(
                unsignedBytes(decode(checkpoint, `signed checkpoint ${index}`)),
                unsignedBytes(decode(trusted.checkpoints[index]!, `trusted checkpoint ${index}`)),
            )
        )
            mismatch(`signed checkpoint ${index} differs from the graph the Taxi built`);
    });

    for (let i = 0; i < ownerIndex; i++)
        if (sigKeys(signedArk, i).length)
            mismatch(`signed graph carries a signature on the Taxi's input ${i}`);
    const signedCheckpoint = decode(signed.checkpoints[ownerIndex]!, "signed owner checkpoint");
    for (const [tx, index, what] of [
        [signedArk, ownerIndex, `arkTx input ${ownerIndex}`],
        [signedCheckpoint, 0, `checkpoint ${ownerIndex}`],
    ] as const) {
        const keys = sigKeys(tx, index);
        if (!keys.length || keys.some((key) => key !== owner))
            throw new CustodyReleaseError(
                "custody_owner_unsigned",
                `${what} carries no signature from the entitled owner`,
            );
        try {
            verifyTapscriptSignatures(tx, index, [owner], [], [SIGHASH_DEFAULT]);
        } catch {
            throw new CustodyReleaseError(
                "custody_owner_unsigned",
                `${what} carries an invalid owner signature`,
            );
        }
    }
}

export interface CustodyPrepared {
    plan: CustodyReleasePlan;
    trusted: JointGraph;
    inputs: readonly Outpoint[];
}

export interface CustodyReleaserDeps {
    custody: CustodyRepository;
    dust: bigint;
    vtxoMinAmount: bigint;
    /**
     * Selects Taxi coins covering `requiredSats`, throwing when it cannot. The
     * caller closes it over ONE chain tip for the whole pass, so the probe and
     * the authoritative selection never disagree about "now".
     */
    selectFunding(requiredSats: bigint): readonly Outpoint[];
    /** Builds the Taxi's own trusted graph from the coins just selected. */
    build(args: {
        row: CustodyRecord;
        plan: CustodyReleasePlan;
        inputs: readonly Outpoint[];
    }): Promise<JointGraph>;
    /** Returns the txid the release landed under. */
    submit(graph: JointGraph): Promise<string>;
    now(): number;
    workerId: string;
    leaseSeconds: number;
}

export interface CustodyReleaser {
    prepare(request: { advanceId: string; ownerCoinSats: bigint }): Promise<CustodyPrepared>;
    complete(request: {
        advanceId: string;
        trusted: JointGraph;
        signed: JointGraph;
    }): Promise<{ txid: string }>;
    /** Rows whose release is waiting on liquidity, and since when. */
    waiting(): { advanceId: string; since: number }[];
}

/**
 * The payout path, in the shape of the recovery lease. `prepare` probes
 * liquidity before the compare-and-set, claims the row, and only then chooses
 * coins — the discipline the other joint builds use. `complete` verifies the
 * owner's signature against the txid the row committed to, and records the
 * payout only against the chain's own answer.
 *
 * A failure after `submit` deliberately leaves the row `releasing`: the coins
 * may be gone, so returning it to `held` would invite a second attempt against
 * evidence nobody has read yet.
 */
export function createCustodyReleaser(deps: CustodyReleaserDeps): CustodyReleaser {
    const waitingSince = new Map<string, number>();
    const fund = (advanceId: string, requiredSats: bigint): readonly Outpoint[] => {
        try {
            const inputs = deps.selectFunding(requiredSats);
            if (!inputs.length) throw new Error("no coins selected");
            waitingSince.delete(advanceId);
            return inputs;
        } catch {
            if (!waitingSince.has(advanceId)) waitingSince.set(advanceId, deps.now());
            throw new CustodyAwaitingLiquidityError(advanceId, requiredSats);
        }
    };
    const active = (advanceId: string): CustodyRecord => {
        const row = deps.custody.get(advanceId);
        if (!row) throw new CustodyError("custody_not_found", advanceId);
        if (row.sweptAt !== undefined)
            throw new CustodySweptError(advanceId, row.sweptActor!, row.sweptAt);
        if (row.state === "released") throw new CustodyError("custody_released", advanceId);
        return row;
    };

    return {
        async prepare({ advanceId, ownerCoinSats }) {
            const row = active(advanceId);
            const plan = planCustodyRelease({
                row,
                ownerCoinSats,
                dust: deps.dust,
                vtxoMinAmount: deps.vtxoMinAmount,
            });
            // Probe before the compare-and-set: a dip must leave the row `held`.
            fund(advanceId, plan.fundingSats);
            const token = randomUUID();
            const started = deps.now();
            deps.custody.claimRelease(
                advanceId,
                deps.workerId,
                token,
                started,
                started + deps.leaseSeconds,
            );
            try {
                const inputs = fund(advanceId, plan.fundingSats);
                const trusted = await deps.build({ row, plan, inputs });
                const expectedTxid = decode(trusted.arkTx, "trusted arkTx").id;
                if (
                    !deps.custody.bindReleaseInputs(
                        advanceId,
                        deps.workerId,
                        token,
                        inputs,
                        expectedTxid,
                        deps.now(),
                    )
                )
                    throw new CustodyError("custody_release_in_progress", advanceId);
                return { plan, trusted, inputs };
            } catch (cause) {
                if (!(cause instanceof CustodyError))
                    deps.custody.abandonRelease(advanceId, deps.workerId, token, deps.now());
                throw cause;
            }
        },

        async complete({ advanceId, trusted, signed }) {
            const row = active(advanceId);
            const lease = row.releaseLease;
            if (row.state !== "releasing" || !lease)
                throw new CustodyError("custody_release_in_progress", advanceId);
            assertCustodyReleaseAuthorised({ signed, trusted, ownerKey: row.ownerKey });
            const expectedTxid = decode(trusted.arkTx, "trusted arkTx").id;
            // The persisted txid commits to the whole transaction, so a caller
            // cannot substitute a different graph and still match it.
            if (expectedTxid !== row.releaseExpectedTxid)
                throw new CustodyReleaseError(
                    "custody_release_unconfirmed",
                    `graph ${expectedTxid} is not the one this row committed to`,
                );
            const txid = await deps.submit(signed);
            if (txid !== expectedTxid)
                throw new CustodyReleaseError(
                    "custody_release_unconfirmed",
                    `submission reported ${txid}, expected ${expectedTxid}`,
                );
            if (!deps.custody.recordReleased(advanceId, lease.owner, lease.token, txid, deps.now()))
                throw new CustodyReleaseError(
                    "custody_release_unconfirmed",
                    `release ${txid} submitted but the lease was lost before it was recorded`,
                );
            return { txid };
        },

        waiting: () =>
            [...waitingSince]
                .map(([advanceId, since]) => ({ advanceId, since }))
                .sort((a, b) => a.since - b.since || (a.advanceId < b.advanceId ? -1 : 1)),
    };
}
