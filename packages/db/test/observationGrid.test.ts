import { describe, expect, it } from "vitest";
import type { Advance } from "@arkade-taxi/core";
import { ADVANCE_STATES, AdvanceRepository, PolicyRepository, openDatabase } from "../src/index.js";

const DEADLINE = 1_757_000_000n + 8_640_000n;
const SPENT = "11".repeat(32);
const OTHER = "22".repeat(32);
const PREVIOUS = { hash: "33".repeat(32), height: 700_000 };
const NEXT = "44".repeat(32);
const AT = 500;
const TIME = 1_757_000_000;
const TERMINALS = ["recycled", "purchased", "refunded", "recovered"] as const;
const DISAGREEMENT = "covenant_observation_disagreement";
const TIPS = {
    malformed: { hash: "not-hex", height: PREVIOUS.height + 1 },
    below: { hash: NEXT, height: PREVIOUS.height - 1 },
    same: PREVIOUS,
    crossed: { hash: NEXT, height: PREVIOUS.height },
    stuck: { hash: PREVIOUS.hash, height: PREVIOUS.height + 1 },
    above: { hash: NEXT, height: PREVIOUS.height + 1 },
};

const advance = (over: Partial<Advance> = {}): Advance => ({
    id: "adv",
    state: "locked",
    receiverKey: new Uint8Array(32).fill(1),
    senderKey: new Uint8Array(32).fill(2),
    operatorKey: new Uint8Array(32).fill(3),
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
    updatedAt: 100,
    expiresAt: 60,
    ...over,
});
const terminal = (over: Partial<Advance> = {}) =>
    advance({
        state: "purchased",
        spentTxid: SPENT,
        observationTipHash: PREVIOUS.hash,
        observationTipHeight: PREVIOUS.height,
        ...over,
    });
const disagreeing = (over: Partial<Advance> = {}) =>
    terminal({ failureCode: DISAGREEMENT, failureDetail: "earlier", ...over });

const OBSERVED = [
    "state",
    "spentTxid",
    "lastObservedAt",
    "observationTipHash",
    "observationTipHeight",
    "observationStableTipHash",
    "observationStableTipHeight",
    "observationStableCount",
    "failureCode",
    "failureDetail",
    "updatedAt",
] as const;
const pick = (a: Advance) =>
    Object.fromEntries(OBSERVED.flatMap((k) => (a[k] === undefined ? [] : [[k, a[k]]]))) as Partial<
        Pick<Advance, (typeof OBSERVED)[number]>
    >;
type Act = (advances: AdvanceRepository) => string | void;

/** Each run inserts `start` in a savepoint of one database and reports what `act` changed. */
function observer() {
    const db = openDatabase(":memory:");
    const policy = new PolicyRepository(db);
    const advances = new AdvanceRepository(db, { custodyWindowSeconds: 1_000 });
    const count = (table: string) =>
        Number((db.prepare(`SELECT count(*) AS n FROM ${table}`).get() as { n: bigint }).n);
    const run = (start: Advance, act: Act, { paused = false, hold = false } = {}) => {
        db.exec("SAVEPOINT cell");
        try {
            policy.update({ paused }, "grid");
            advances.insert(start);
            db.prepare(
                `INSERT INTO operator_input_reservations
                 (outpoint_txid, outpoint_vout, advance_id, created_at) VALUES (?, 0, 'adv', 1)`,
            ).run("aa".repeat(32));
            // Makes every advance UPDATE change zero rows, as a lost compare-and-set would.
            if (hold)
                db.exec(
                    "CREATE TEMP TRIGGER hold BEFORE UPDATE ON main.advances BEGIN SELECT RAISE(IGNORE); END",
                );
            const revision = policy.getSnapshot().revision;
            const before = pick(advances.get("adv")!);
            let result: string;
            try {
                result = String(act(advances));
            } catch (error) {
                result = `throw ${(error as Error).message}`;
            }
            const row = pick(advances.get("adv")!);
            return {
                result,
                row,
                changed: JSON.stringify(row) !== JSON.stringify(before),
                paused: policy.get().paused,
                revisions: Number(policy.getSnapshot().revision - revision),
                reserved: count("operator_input_reservations"),
                custody: count("custody"),
            };
        } finally {
            db.exec("ROLLBACK TO cell");
            db.exec("RELEASE cell");
        }
    };
    return { db, run };
}
type Outcome = ReturnType<ReturnType<typeof observer>["run"]>;

const tipOf = (tip: { hash: string; height: number }) => ({ ...tip, time: TIME });
const spend =
    (
        expected: "locking" | "locked" | "recovering",
        state: (typeof TERMINALS)[number] = "purchased",
        txid = SPENT,
    ): Act =>
    (a) =>
        a.recordSpendObservation("adv", expected, state, txid, AT, {
            hash: NEXT,
            height: PREVIOUS.height,
        });
const stable =
    (tip: { hash: string; height: number; time?: number }, at = AT): Act =>
    (a) =>
        a.recordStableSpendObservation("adv", "purchased", SPENT, at, { time: TIME, ...tip });

// Columns: expected state locking | locked | recovering, each over the four terminal states.
const SPEND_RECORDED = [
    "quoted none      | xxxx xxxx xxxx",
    "quoted same      | xxxx xxxx xxxx",
    "quoted other     | xxxx xxxx xxxx",
    "locking none     | oooo xxxx xxxx",
    "locking same     | llll xxxx xxxx",
    "locking other    | llll xxxx xxxx",
    "locked none      | rrrr oooo xxxx",
    "locked same      | rrrr llll xxxx",
    "locked other     | rrrr llll xxxx",
    "recovering none  | rrrr rrrr oooo",
    "recovering same  | rrrr rrrr llll",
    "recovering other | rrrr rrrr llll",
    "recycled none    | xxxx xxxx xxxx",
    "recycled same    | dxxx dxxx dxxx",
    "recycled other   | xxxx xxxx xxxx",
    "purchased none   | xxxx xxxx xxxx",
    "purchased same   | xdxx xdxx xdxx",
    "purchased other  | xxxx xxxx xxxx",
    "refunded none    | xxxx xxxx xxxx",
    "refunded same    | xxdx xxdx xxdx",
    "refunded other   | xxxx xxxx xxxx",
    "recovered none   | xxxx xxxx xxxx",
    "recovered same   | xxxd xxxd xxxd",
    "recovered other  | xxxx xxxx xxxx",
    "expired none     | xxxx xxxx xxxx",
    "expired same     | xxxx xxxx xxxx",
    "expired other    | xxxx xxxx xxxx",
];
const SPEND_LETTER: Record<string, string> = {
    duplicate: "d",
    retry: "r",
    disagreement: "x",
    recorded: "o",
    "throw advance adv: observation compare-and-set lost": "l",
};

// Columns: the TIPS in order, each without and with a stable candidate equal to the tip.
// Disagreements are lettered by reason: t tip, m persisted tip, s stale, b below candidate.
const STABLE_RECORDED = [
    "match valid none            | tt ss ii ss ss aa",
    "match valid disagreement    | tt bb pc pc bb pc",
    "match missing none          | tt mm mm mm mm mm",
    "match missing disagreement  | tt mm mm mm mm mm",
    "match malformed none        | tt mm mm mm mm mm",
    "match malformed disagreement| tt mm mm mm mm mm",
    "state valid none            | ii ii ii ii ii ii",
    "state valid disagreement    | ii ii ii ii ii ii",
    "state missing none          | ii ii ii ii ii ii",
    "state missing disagreement  | ii ii ii ii ii ii",
    "state malformed none        | ii ii ii ii ii ii",
    "state malformed disagreement| ii ii ii ii ii ii",
    "spent valid none            | ii ii ii ii ii ii",
    "spent valid disagreement    | ii ii ii ii ii ii",
    "spent missing none          | ii ii ii ii ii ii",
    "spent missing disagreement  | ii ii ii ii ii ii",
    "spent malformed none        | ii ii ii ii ii ii",
    "spent malformed disagreement| ii ii ii ii ii ii",
];
const STABLE_LETTER: Record<string, string> = {
    ignored: "i",
    advanced: "a",
    pending: "p",
    cleared: "c",
};
const REASON: [string, string][] = [
    ["stable canonical tip identity is malformed", "t"],
    ["persisted terminal tip identity is malformed", "m"],
    ["stale or contradictory", "s"],
    ["stable candidate", "b"],
];

describe("recordSpendObservation", () => {
    it("decides every state, persisted spend, expected state and terminal as recorded", () => {
        const o = observer();
        const cells: (Outcome & { terminal: string })[] = [];
        const lines = ADVANCE_STATES.flatMap((state) =>
            (["none", "same", "other"] as const).map((persisted) => {
                const start = advance({
                    state,
                    ...(persisted === "none"
                        ? {}
                        : { spentTxid: persisted === "same" ? SPENT : OTHER }),
                });
                const groups = (["locking", "locked", "recovering"] as const).map((expected) =>
                    TERMINALS.map((terminal) => {
                        const cell = { ...o.run(start, spend(expected, terminal)), terminal };
                        cells.push(cell);
                        return SPEND_LETTER[cell.result] ?? `?${cell.result}`;
                    }).join(""),
                );
                return `${`${state} ${persisted}`.padEnd(17)}| ${groups.join(" ")}`;
            }),
        );
        o.db.close();
        expect(lines).toEqual(SPEND_RECORDED);
        expect(
            cells.filter(
                (c) =>
                    c.revisions > 0 !== (c.result === "disagreement") ||
                    (c.reserved === 0) !== (c.result === "recorded") ||
                    c.changed !== ["recorded", "disagreement"].includes(c.result) ||
                    c.custody !== (c.result === "recorded" && c.terminal === "recovered" ? 1 : 0),
            ),
        ).toEqual([]);
    }, 30_000);

    it.each([
        ["locked", "purchased", 0],
        ["recovering", "recovered", 1],
    ] as const)("records a %s advance's %s spend", (state, terminalState, custody) => {
        const o = observer();
        expect(o.run(advance({ state }), spend(state, terminalState))).toEqual({
            result: "recorded",
            row: {
                state: terminalState,
                spentTxid: SPENT,
                lastObservedAt: AT,
                observationTipHash: NEXT,
                observationTipHeight: PREVIOUS.height,
                updatedAt: AT,
            },
            changed: true,
            paused: false,
            revisions: 0,
            reserved: 0,
            custody,
        });
        o.db.close();
    });

    it.each([
        ["an unspent quote", false, advance({ state: "quoted" }), "none/quoted", 1],
        [
            "another terminal spend",
            false,
            terminal({ state: "recycled", spentTxid: OTHER }),
            `${OTHER}/recycled`,
            1,
        ],
        [
            "another terminal spend",
            true,
            terminal({ state: "recycled", spentTxid: OTHER }),
            `${OTHER}/recycled`,
            0,
        ],
    ] as const)(
        "marks a disagreement against %s, already paused: %s",
        (_, paused, start, persisted, revisions) => {
            const o = observer();
            const { row, ...rest } = o.run(
                { ...start, observationStableTipHash: NEXT, observationStableCount: 1 },
                spend("locked"),
                { paused },
            );
            expect(rest).toEqual({
                result: "disagreement",
                changed: true,
                paused: true,
                revisions,
                reserved: 1,
                custody: 0,
            });
            expect(row).toEqual({
                ...pick(start),
                failureCode: DISAGREEMENT,
                failureDetail: `canonical spend ${SPENT} classified purchased at ${NEXT}:${PREVIOUS.height} conflicts with persisted ${persisted}`,
                updatedAt: AT,
            });
            o.db.close();
        },
    );

    it.each([
        ["a non-hex spend", "not-hex", PREVIOUS.height, "invalid transaction or tip hash"],
        ["a negative tip height", SPENT, -1, "invalid clock"],
    ])("refuses %s before reading the row", (_, txid, height, message) => {
        const o = observer();
        const outcome = o.run(advance(), (a) =>
            a.recordSpendObservation("adv", "locked", "purchased", txid, AT, {
                hash: NEXT,
                height,
            }),
        );
        expect(outcome).toMatchObject({
            result: `throw advance observation: ${message}`,
            changed: false,
            revisions: 0,
        });
        o.db.close();
    });
});

describe("recordStableSpendObservation", () => {
    it("decides every row, persisted tip, failure, tip and candidate as recorded", () => {
        const o = observer();
        const cells: Outcome[] = [];
        const lines = (["match", "state", "spent"] as const).flatMap((match) =>
            (["valid", "missing", "malformed"] as const).flatMap((persisted) =>
                (["none", "disagreement"] as const).map((failure) => {
                    const groups = Object.values(TIPS).map((tip) =>
                        (["none", "tip"] as const)
                            .map((candidate) => {
                                const cell = o.run(
                                    advance({
                                        state: match === "state" ? "recycled" : "purchased",
                                        spentTxid: match === "spent" ? OTHER : SPENT,
                                        ...(persisted === "missing"
                                            ? {}
                                            : {
                                                  observationTipHash:
                                                      persisted === "valid"
                                                          ? PREVIOUS.hash
                                                          : "not-hex",
                                                  observationTipHeight: PREVIOUS.height,
                                              }),
                                        ...(failure === "none"
                                            ? {}
                                            : {
                                                  failureCode: DISAGREEMENT,
                                                  failureDetail: "earlier",
                                              }),
                                        ...(candidate === "none"
                                            ? {}
                                            : {
                                                  observationStableTipHash: tip.hash,
                                                  observationStableTipHeight: tip.height,
                                                  observationStableCount: 1,
                                              }),
                                    }),
                                    stable(tip),
                                );
                                cells.push(cell);
                                return cell.result === "disagreement"
                                    ? (REASON.find(([prefix]) =>
                                          cell.row.failureDetail?.startsWith(prefix),
                                      )?.[1] ?? `?${cell.row.failureDetail}`)
                                    : (STABLE_LETTER[cell.result] ?? `?${cell.result}`);
                            })
                            .join(""),
                    );
                    return `${`${match} ${persisted} ${failure}`.padEnd(28)}| ${groups.join(" ")}`;
                }),
            ),
        );
        o.db.close();
        expect(lines).toEqual(STABLE_RECORDED);
        expect(
            cells.filter(
                (c) =>
                    c.revisions > 0 !== (c.result === "disagreement") ||
                    (c.result === "ignored" && c.changed) ||
                    c.reserved !== 1 ||
                    c.custody !== 0,
            ),
        ).toEqual([]);
    }, 30_000);

    it.each([
        [
            "advances",
            terminal({ lastObservedAt: 50 }),
            TIPS.above,
            "advanced",
            {
                ...pick(terminal()),
                lastObservedAt: AT,
                observationTipHash: NEXT,
                observationTipHeight: PREVIOUS.height + 1,
                updatedAt: AT,
            },
        ],
        [
            "holds a first stable candidate",
            disagreeing(),
            TIPS.same,
            "pending",
            {
                ...pick(disagreeing()),
                lastObservedAt: AT,
                observationStableTipHash: PREVIOUS.hash,
                observationStableTipHeight: PREVIOUS.height,
                observationStableCount: 1,
                updatedAt: AT,
            },
        ],
        [
            "clears on a repeated candidate",
            disagreeing({
                observationStableTipHash: NEXT,
                observationStableTipHeight: PREVIOUS.height + 1,
                observationStableCount: 1,
            }),
            TIPS.above,
            "cleared",
            {
                ...pick(terminal()),
                lastObservedAt: AT,
                observationTipHash: NEXT,
                observationTipHeight: PREVIOUS.height + 1,
                updatedAt: AT,
            },
        ],
    ] as const)("%s without pausing", (_, start, tip, result, row) => {
        const o = observer();
        expect(o.run(start, stable(tip))).toEqual({
            result,
            row,
            changed: true,
            paused: false,
            revisions: 0,
            reserved: 1,
            custody: 0,
        });
        o.db.close();
    });

    it.each([
        [
            "a malformed tip",
            terminal(),
            TIPS.malformed,
            "stable canonical tip identity is malformed",
        ],
        [
            "a missing persisted tip",
            terminal({ observationTipHash: undefined }),
            TIPS.above,
            "persisted terminal tip identity is malformed",
        ],
        [
            "a tip below the persisted one",
            terminal(),
            TIPS.below,
            `stale or contradictory canonical tip ${NEXT}:${PREVIOUS.height - 1} conflicts with persisted observation`,
        ],
        [
            "a candidate below the persisted tip",
            disagreeing(),
            TIPS.below,
            `stable candidate ${NEXT}:${PREVIOUS.height - 1} is below or contradicts persisted observation ${PREVIOUS.hash}:${PREVIOUS.height}`,
        ],
    ])("pauses on %s, from either pause state", (_, start, tip, detail) => {
        for (const paused of [false, true]) {
            const o = observer();
            expect(
                o.run(
                    { ...start, observationStableTipHash: NEXT, observationStableCount: 1 },
                    stable(tip),
                    { paused },
                ),
            ).toEqual({
                result: "disagreement",
                row: {
                    ...pick(start),
                    failureCode: DISAGREEMENT,
                    failureDetail: detail,
                    updatedAt: AT,
                },
                changed: true,
                paused: true,
                revisions: paused ? 0 : 1,
                reserved: 1,
                custody: 0,
            });
            o.db.close();
        }
    });

    it.each([
        ["a negative clock", stable(TIPS.above, -1)],
        ["an unsafe clock", stable(TIPS.above, Number.MAX_SAFE_INTEGER + 1)],
        ["a non-hex hash", stable({ ...TIPS.above, hash: "not-hex" })],
        ["a negative height", stable({ ...TIPS.above, height: -1 })],
        ["a fractional height", stable({ ...TIPS.above, height: 1.5 })],
        ["a negative time", stable({ ...TIPS.above, time: -1 })],
        ["an unsafe time", stable({ ...TIPS.above, time: Number.MAX_SAFE_INTEGER + 1 })],
    ])("weighs a tip with %s only against a matching row", (_, act) => {
        const o = observer();
        expect(o.run(terminal({ spentTxid: OTHER }), act)).toMatchObject({
            result: "ignored",
            changed: false,
            paused: false,
            revisions: 0,
        });
        expect(o.run(terminal(), act)).toMatchObject({
            result: "disagreement",
            row: { failureDetail: "stable canonical tip identity is malformed" },
            paused: true,
            revisions: 1,
        });
        o.db.close();
    });
});

describe("with every advance write changing nothing", () => {
    it.each([
        [
            "recordSpendDisagreement",
            advance({ state: "expired" }),
            (a: AdvanceRepository) => a.recordSpendDisagreement("adv", "gone", AT, PREVIOUS),
            "undefined",
        ],
        [
            "recordSpendObservation",
            terminal({ state: "recycled", spentTxid: OTHER }),
            spend("locked"),
            "disagreement",
        ],
    ] as const)("%s still pauses through the unguarded writer", (_, start, act, result) => {
        const o = observer();
        expect(o.run(start, act, { hold: true })).toMatchObject({
            result,
            changed: false,
            paused: true,
            revisions: 1,
        });
        o.db.close();
    });

    it.each([
        ["disagree", terminal(), TIPS.malformed],
        ["advance", terminal(), TIPS.above],
        ["hold a candidate", disagreeing(), TIPS.same],
        [
            "clear",
            disagreeing({
                observationStableTipHash: NEXT,
                observationStableTipHeight: PREVIOUS.height + 1,
                observationStableCount: 1,
            }),
            TIPS.above,
        ],
    ] as const)(
        "a stable observation that would %s is ignored without pausing",
        (_, start, tip) => {
            const o = observer();
            expect(o.run(start, stable(tip), { hold: true })).toMatchObject({
                result: "ignored",
                changed: false,
                paused: false,
                revisions: 0,
            });
            o.db.close();
        },
    );
});
