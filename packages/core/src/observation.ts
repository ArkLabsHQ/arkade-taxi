import type { Advance } from "./types";

type Tip = { hash: string; height: number };

export function spendObservationVerdict(
    current: Pick<Advance, "state" | "spentTxid">,
    expectedState: "locking" | "locked" | "recovering",
    terminalState: "recycled" | "purchased" | "refunded" | "recovered",
    spentTxid: string,
): "duplicate" | "retry" | "disagreement" | "record" {
    if (current.state === terminalState && current.spentTxid === spentTxid) return "duplicate";
    const compatibleForwardDrift =
        (expectedState === "locking" && current.state === "locked") ||
        ((expectedState === "locking" || expectedState === "locked") &&
            current.state === "recovering");
    if (current.state !== expectedState && compatibleForwardDrift) return "retry";
    if (
        ["recycled", "purchased", "refunded", "recovered"].includes(current.state) ||
        current.state !== expectedState
    )
        return "disagreement";
    return "record";
}

export type StableObservationVerdict =
    | { kind: "disagree"; reason: string }
    | { kind: "ignore" }
    | { kind: "advance"; previous: Tip }
    | { kind: "stable"; previous: Tip; count: number; cleared: boolean };

/** For a row whose terminal state and spend already match the observation. */
export function stableObservationVerdict(
    current: Pick<
        Advance,
        | "failureCode"
        | "observationTipHash"
        | "observationTipHeight"
        | "observationStableTipHash"
        | "observationStableTipHeight"
        | "observationStableCount"
    >,
    at: number,
    tip: Tip & { time: number },
): StableObservationVerdict {
    if (
        !Number.isSafeInteger(at) ||
        at < 0 ||
        !/^[0-9a-f]{64}$/.test(tip.hash) ||
        !Number.isSafeInteger(tip.height) ||
        tip.height < 0 ||
        !Number.isSafeInteger(tip.time) ||
        tip.time < 0
    )
        return { kind: "disagree", reason: "stable canonical tip identity is malformed" };
    const previousHash = current.observationTipHash;
    const previousHeight = current.observationTipHeight;
    if (
        previousHash === undefined ||
        !/^[0-9a-f]{64}$/.test(previousHash) ||
        previousHeight === undefined ||
        !Number.isSafeInteger(previousHeight) ||
        previousHeight < 0
    )
        return { kind: "disagree", reason: "persisted terminal tip identity is malformed" };
    const previous = { hash: previousHash, height: previousHeight };
    if (current.failureCode !== "covenant_observation_disagreement") {
        if (
            tip.height < previousHeight ||
            (tip.height === previousHeight && tip.hash !== previousHash) ||
            (tip.height > previousHeight && tip.hash === previousHash)
        )
            return {
                kind: "disagree",
                reason: `stale or contradictory canonical tip ${tip.hash}:${tip.height} conflicts with persisted observation`,
            };
        if (previousHash === tip.hash && previousHeight === tip.height) return { kind: "ignore" };
        return { kind: "advance", previous };
    }
    if (tip.height < previousHeight || (tip.height > previousHeight && tip.hash === previousHash))
        return {
            kind: "disagree",
            reason: `stable candidate ${tip.hash}:${tip.height} is below or contradicts persisted observation ${previousHash}:${previousHeight}`,
        };
    const count =
        current.observationStableTipHash === tip.hash &&
        current.observationStableTipHeight === tip.height
            ? (current.observationStableCount ?? 0) + 1
            : 1;
    return { kind: "stable", previous, count, cleared: count >= 2 };
}
