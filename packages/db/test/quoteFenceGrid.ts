import type { Advance, AssetRule, ExpiryDeadline } from "@arkade-taxi/core";
import {
    AdvanceRepository,
    PolicyRepository,
    openDatabase,
    type Database,
    type ReserveQuoteRequest,
} from "../src/index.js";

const DEADLINE = 1_757_000_000n + 8_640_000n;

export const AXES = {
    kind: ["covenant", "sponsored"],
    headroom: ["none", "ok", "short"],
    budget: ["valid", "negative", "margin", "height"],
    paused: ["unpaused", "paused"],
    rule: ["absent", "disabled", "enabled"],
    exposure: ["none", "outstanding", "count", "both"],
    topup: ["zero", "dust", "dust+1", "cap+1"],
} as const;

type Axes = typeof AXES;
export type Cell = { [K in keyof Axes]: Axes[K][number] };

export const CELLS: readonly Cell[] = Object.entries(AXES).reduce<Cell[]>(
    (cells, [axis, values]) =>
        cells.flatMap((cell) => values.map((value) => ({ ...cell, [axis]: value }))),
    [{} as Cell],
);

const RULE: AssetRule = {
    assetId: null,
    enabled: true,
    claim: "either",
    maxTopupSats: null,
    fares: [],
};
const MARGIN_SECONDS = 86_400n;
const TOPUP = {
    zero: { topup: 0n, dust: 330n },
    dust: { topup: 330n, dust: 330n },
    "dust+1": { topup: 331n, dust: 330n },
    "cap+1": { topup: 401n, dust: 500n },
} as const;
const BUDGET: Record<Cell["budget"], ExpiryDeadline> = {
    valid: { kind: "time", value: 1n },
    negative: { kind: "time", value: -1n },
    margin: { kind: "time", value: MARGIN_SECONDS },
    height: { kind: "height", value: 1n },
};
const HELD: Record<Cell["exposure"], bigint[]> = {
    none: [],
    outstanding: [1_000n],
    count: [1n, 1n],
    both: [999n, 1n],
};

export const advance = (over: Partial<Advance> = {}): Advance => ({
    id: "quote-1",
    state: "quoted",
    receiverKey: new Uint8Array(32),
    senderKey: new Uint8Array(32),
    operatorKey: new Uint8Array(32),
    operatorSignerKey: new Uint8Array(32).fill(4),
    exitDelay: { value: 5n, type: "blocks" },
    dust: 330n,
    topup: 330n,
    locktime: DEADLINE,
    recoveryLocktime: { kind: "time", value: DEADLINE },
    operatorInputs: [{ txid: "aa".repeat(32), vout: 0 }],
    unsignedLockupTx: "unsigned",
    unsignedLockupId: "bb".repeat(32),
    covenantAddress: "tark1qexample",
    fare: { currency: "sats", units: 10n },
    createdAt: 1,
    updatedAt: 1,
    expiresAt: 60,
    ...over,
});

function cellAdvance(cell: Cell): Advance {
    const result = advance(TOPUP[cell.topup]);
    const ok = cell.headroom === "ok";
    if (cell.kind === "sponsored") {
        result.kind = "sponsored";
        result.locktime = 0n;
        delete result.recoveryLocktime;
        if (cell.headroom !== "none")
            result.batchExpiry = { kind: "height", value: ok ? 900_000n : 100n };
    } else if (cell.headroom !== "none")
        result.batchExpiry = { kind: "time", value: DEADLINE + (ok ? MARGIN_SECONDS : 1n) };
    return result;
}

/** Applies the cell's policy and held exposure; the caller owns the transaction. */
export function setUp(
    policy: PolicyRepository,
    advances: AdvanceRepository,
    cell: Cell,
): ReserveQuoteRequest {
    policy.update(
        {
            paused: cell.paused === "paused",
            maxOutstandingSats: 1_000n,
            maxPerPaymentTopupSats: 400n,
            maxConcurrentAdvances: 2,
            locktimeMarginBlocks: 144,
            locktimeMarginSeconds: Number(MARGIN_SECONDS),
            assetRules:
                cell.rule === "absent" ? [] : [{ ...RULE, enabled: cell.rule === "enabled" }],
        },
        "grid",
    );
    HELD[cell.exposure].forEach((topup, vout) =>
        advances.insert(
            advance({
                id: `held-${vout}`,
                state: "locked",
                topup,
                operatorInputs: [{ txid: "cc".repeat(32), vout }],
            }),
        ),
    );
    return {
        advance: cellAdvance(cell),
        expectedPolicyRevision: policy.getSnapshot().revision,
        recoveryExecutionBudget: BUDGET[cell.budget],
    };
}

export function outcome(run: () => unknown): string {
    try {
        run();
        return "ok";
    } catch (error) {
        const { code, message } = error as Error & { code?: string };
        return `${(error as Error).constructor.name}:${code ?? message}`;
    }
}

/** Every cell against a fresh savepoint of one database, in CELLS order. */
export function runGrid(fenceFor: (db: Database) => (request: ReserveQuoteRequest) => unknown) {
    const db = openDatabase(":memory:");
    try {
        const policy = new PolicyRepository(db);
        const advances = new AdvanceRepository(db);
        const fence = fenceFor(db);
        return CELLS.map((cell) => {
            db.exec("SAVEPOINT cell");
            try {
                return outcome(() => fence(setUp(policy, advances, cell)));
            } finally {
                db.exec("ROLLBACK TO cell");
                db.exec("RELEASE cell");
            }
        });
    } finally {
        db.close();
    }
}

const LETTER: Record<string, string> = {
    ok: "o",
    "Error:reservation: advance must be quoted": "q",
    "Error:advance quote-1: batch expiry must be a tagged deadline": "s",
    "RecoveryBudgetConflictError:recovery_budget_invalid": "b",
    "QuoteAdmissionError:paused": "p",
    "QuoteAdmissionError:asset_not_served": "a",
    "QuoteAdmissionError:topup_exceeds_max_per_payment": "t",
    "QuoteAdmissionError:no_locktime_headroom": "h",
    "QuoteAdmissionError:exceeds_max_outstanding": "m",
    "QuoteAdmissionError:max_concurrent_advances": "c",
};

/** One line per kind/headroom/budget/paused; a block per rule, of exposure x topup letters. */
export function render(outcomes: readonly string[]): string {
    const unknown = new Set(outcomes.filter((o) => !(o in LETTER)));
    const letters = outcomes.map((o) => LETTER[o] ?? "?");
    const topups = AXES.topup.length;
    const block = AXES.exposure.length * topups;
    const row = AXES.rule.length * block;
    const lines: string[] = [];
    for (let start = 0; start < letters.length; start += row) {
        const { kind, headroom, budget, paused } = CELLS[start]!;
        const blocks = AXES.rule.map((_, r) =>
            AXES.exposure
                .map((_, e) => {
                    const from = start + r * block + e * topups;
                    return letters.slice(from, from + topups).join("");
                })
                .join(" "),
        );
        lines.push(
            `${[kind, headroom, budget, paused].join(" ").padEnd(34)}| ${blocks.join(" | ")}`,
        );
    }
    return [...lines, ...[...unknown].map((o) => `? ${o}`)].join("\n");
}
