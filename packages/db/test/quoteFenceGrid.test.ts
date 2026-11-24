import { describe, expect, it } from "vitest";
import {
    AdvanceRepository,
    PolicyRepository,
    ReservationRepository,
    openDatabase,
    type ReserveQuoteRequest,
} from "../src/index.js";
import { advance, outcome, render, runGrid, setUp, type Cell } from "./quoteFenceGrid.js";

// Letters are LETTER in quoteFenceGrid.ts. Each rule block (absent | disabled | enabled) holds
// exposure none, outstanding, count, both; each of those the topups zero, dust, dust+1, cap+1.
const RECORDED = [
    "covenant none valid unpaused      | aaaa aaaa aaaa aaaa | aaaa aaaa aaaa aaaa | tott tmtt tctt tmtt",
    "covenant none valid paused        | pppp pppp pppp pppp | pppp pppp pppp pppp | pppp pppp pppp pppp",
    "covenant none negative unpaused   | bbbb bbbb bbbb bbbb | bbbb bbbb bbbb bbbb | bbbb bbbb bbbb bbbb",
    "covenant none negative paused     | bbbb bbbb bbbb bbbb | bbbb bbbb bbbb bbbb | bbbb bbbb bbbb bbbb",
    "covenant none margin unpaused     | bbbb bbbb bbbb bbbb | bbbb bbbb bbbb bbbb | bbbb bbbb bbbb bbbb",
    "covenant none margin paused       | bbbb bbbb bbbb bbbb | bbbb bbbb bbbb bbbb | bbbb bbbb bbbb bbbb",
    "covenant none height unpaused     | bbbb bbbb bbbb bbbb | bbbb bbbb bbbb bbbb | bbbb bbbb bbbb bbbb",
    "covenant none height paused       | bbbb bbbb bbbb bbbb | bbbb bbbb bbbb bbbb | bbbb bbbb bbbb bbbb",
    "covenant ok valid unpaused        | ssss ssss ssss ssss | ssss ssss ssss ssss | ssss ssss ssss ssss",
    "covenant ok valid paused          | ssss ssss ssss ssss | ssss ssss ssss ssss | ssss ssss ssss ssss",
    "covenant ok negative unpaused     | ssss ssss ssss ssss | ssss ssss ssss ssss | ssss ssss ssss ssss",
    "covenant ok negative paused       | ssss ssss ssss ssss | ssss ssss ssss ssss | ssss ssss ssss ssss",
    "covenant ok margin unpaused       | ssss ssss ssss ssss | ssss ssss ssss ssss | ssss ssss ssss ssss",
    "covenant ok margin paused         | ssss ssss ssss ssss | ssss ssss ssss ssss | ssss ssss ssss ssss",
    "covenant ok height unpaused       | ssss ssss ssss ssss | ssss ssss ssss ssss | ssss ssss ssss ssss",
    "covenant ok height paused         | ssss ssss ssss ssss | ssss ssss ssss ssss | ssss ssss ssss ssss",
    "covenant short valid unpaused     | ssss ssss ssss ssss | ssss ssss ssss ssss | ssss ssss ssss ssss",
    "covenant short valid paused       | ssss ssss ssss ssss | ssss ssss ssss ssss | ssss ssss ssss ssss",
    "covenant short negative unpaused  | ssss ssss ssss ssss | ssss ssss ssss ssss | ssss ssss ssss ssss",
    "covenant short negative paused    | ssss ssss ssss ssss | ssss ssss ssss ssss | ssss ssss ssss ssss",
    "covenant short margin unpaused    | ssss ssss ssss ssss | ssss ssss ssss ssss | ssss ssss ssss ssss",
    "covenant short margin paused      | ssss ssss ssss ssss | ssss ssss ssss ssss | ssss ssss ssss ssss",
    "covenant short height unpaused    | ssss ssss ssss ssss | ssss ssss ssss ssss | ssss ssss ssss ssss",
    "covenant short height paused      | ssss ssss ssss ssss | ssss ssss ssss ssss | ssss ssss ssss ssss",
    "sponsored none valid unpaused     | ssss ssss ssss ssss | ssss ssss ssss ssss | ssss ssss ssss ssss",
    "sponsored none valid paused       | ssss ssss ssss ssss | ssss ssss ssss ssss | ssss ssss ssss ssss",
    "sponsored none negative unpaused  | ssss ssss ssss ssss | ssss ssss ssss ssss | ssss ssss ssss ssss",
    "sponsored none negative paused    | ssss ssss ssss ssss | ssss ssss ssss ssss | ssss ssss ssss ssss",
    "sponsored none margin unpaused    | ssss ssss ssss ssss | ssss ssss ssss ssss | ssss ssss ssss ssss",
    "sponsored none margin paused      | ssss ssss ssss ssss | ssss ssss ssss ssss | ssss ssss ssss ssss",
    "sponsored none height unpaused    | ssss ssss ssss ssss | ssss ssss ssss ssss | ssss ssss ssss ssss",
    "sponsored none height paused      | ssss ssss ssss ssss | ssss ssss ssss ssss | ssss ssss ssss ssss",
    "sponsored ok valid unpaused       | aaaa aaaa aaaa aaaa | aaaa aaaa aaaa aaaa | tott tmtt tctt tmtt",
    "sponsored ok valid paused         | pppp pppp pppp pppp | pppp pppp pppp pppp | pppp pppp pppp pppp",
    "sponsored ok negative unpaused    | aaaa aaaa aaaa aaaa | aaaa aaaa aaaa aaaa | tott tmtt tctt tmtt",
    "sponsored ok negative paused      | pppp pppp pppp pppp | pppp pppp pppp pppp | pppp pppp pppp pppp",
    "sponsored ok margin unpaused      | aaaa aaaa aaaa aaaa | aaaa aaaa aaaa aaaa | tott tmtt tctt tmtt",
    "sponsored ok margin paused        | pppp pppp pppp pppp | pppp pppp pppp pppp | pppp pppp pppp pppp",
    "sponsored ok height unpaused      | aaaa aaaa aaaa aaaa | aaaa aaaa aaaa aaaa | tott tmtt tctt tmtt",
    "sponsored ok height paused        | pppp pppp pppp pppp | pppp pppp pppp pppp | pppp pppp pppp pppp",
    "sponsored short valid unpaused    | aaaa aaaa aaaa aaaa | aaaa aaaa aaaa aaaa | tott tmtt tctt tmtt",
    "sponsored short valid paused      | pppp pppp pppp pppp | pppp pppp pppp pppp | pppp pppp pppp pppp",
    "sponsored short negative unpaused | aaaa aaaa aaaa aaaa | aaaa aaaa aaaa aaaa | tott tmtt tctt tmtt",
    "sponsored short negative paused   | pppp pppp pppp pppp | pppp pppp pppp pppp | pppp pppp pppp pppp",
    "sponsored short margin unpaused   | aaaa aaaa aaaa aaaa | aaaa aaaa aaaa aaaa | tott tmtt tctt tmtt",
    "sponsored short margin paused     | pppp pppp pppp pppp | pppp pppp pppp pppp | pppp pppp pppp pppp",
    "sponsored short height unpaused   | aaaa aaaa aaaa aaaa | aaaa aaaa aaaa aaaa | tott tmtt tctt tmtt",
    "sponsored short height paused     | pppp pppp pppp pppp | pppp pppp pppp pppp | pppp pppp pppp pppp",
];

const VALID: Cell = {
    kind: "covenant",
    headroom: "none",
    budget: "valid",
    paused: "unpaused",
    rule: "enabled",
    exposure: "none",
    topup: "dust",
};
const PAUSED: Cell = { ...VALID, paused: "paused" };
const WORST: Cell = {
    kind: "covenant",
    headroom: "short",
    budget: "negative",
    paused: "paused",
    rule: "absent",
    exposure: "both",
    topup: "zero",
};

const repositories = () => {
    const db = openDatabase(":memory:");
    return {
        db,
        policy: new PolicyRepository(db),
        advances: new AdvanceRepository(db),
        reservations: new ReservationRepository(db),
    };
};
type Repositories = ReturnType<typeof repositories>;

it("pins the reservation fence over every grid cell", () => {
    const outcomes = runGrid((db) => {
        const reservations = new ReservationRepository(db);
        return (request) => reservations.reserveQuote(request);
    });
    expect(render(outcomes).split("\n")).toEqual(RECORDED);
}, 30_000);

const RECOVERY_LOCKTIME =
    "Error:advance quote-1: tagged recovery locktime must be a future wall-clock deadline";
const reserveOther = ({ reservations }: Repositories, request: ReserveQuoteRequest) =>
    reservations.reserveQuote({ ...request, advance: { ...request.advance, id: "other" } });

it.each<
    [string, Cell, (r: Repositories, request: ReserveQuoteRequest) => ReserveQuoteRequest, string]
>([
    [
        "a non-quoted state before every fence check",
        WORST,
        (_, request) => ({ ...request, advance: { ...request.advance, state: "locking" } }),
        "Error:reservation: advance must be quoted",
    ],
    [
        "a missing recovery locktime as a snapshot error, not a budget one",
        VALID,
        (_, request) => ({
            ...request,
            advance: { ...request.advance, recoveryLocktime: undefined },
        }),
        RECOVERY_LOCKTIME,
    ],
    [
        "a height recovery locktime as a snapshot error, not a budget one",
        VALID,
        (_, request) => ({
            ...request,
            advance: {
                ...request.advance,
                recoveryLocktime: { kind: "height", value: request.advance.locktime },
            },
        }),
        RECOVERY_LOCKTIME,
    ],
    [
        "a recovery locktime not after creation as a snapshot error, not a budget one",
        VALID,
        (_, request) => ({
            ...request,
            advance: { ...request.advance, createdAt: Number(request.advance.locktime) },
        }),
        RECOVERY_LOCKTIME,
    ],
    [
        "a stale policy revision before a non-quoted state",
        VALID,
        (_, request) => ({
            ...request,
            expectedPolicyRevision: request.expectedPolicyRevision - 1n,
            advance: { ...request.advance, state: "locking" },
        }),
        "PolicyRevisionConflictError:policy_changed",
    ],
    [
        "a stale policy revision before the pause",
        PAUSED,
        (_, request) => ({
            ...request,
            expectedPolicyRevision: request.expectedPolicyRevision - 1n,
        }),
        "PolicyRevisionConflictError:policy_changed",
    ],
    [
        "a changed reservation snapshot before the pause",
        PAUSED,
        (_, request) => ({
            ...request,
            expectedReservedOutpoints: [{ txid: "ee".repeat(32), vout: 0 }],
        }),
        "ReservationConflictError:reservation: operator input already reserved",
    ],
    [
        "the pause before an operator input another quote holds",
        VALID,
        (r, request) => {
            reserveOther(r, request);
            r.policy.update({ paused: true }, "grid");
            return { ...request, expectedPolicyRevision: r.policy.getSnapshot().revision };
        },
        "QuoteAdmissionError:paused",
    ],
    [
        "an operator input another quote holds, once the fence passes",
        VALID,
        (r, request) => {
            reserveOther(r, request);
            return request;
        },
        "ReservationConflictError:reservation: operator input already reserved",
    ],
])("refuses %s", (_, cell, edit, expected) => {
    const r = repositories();
    try {
        const request = edit(r, setUp(r.policy, r.advances, cell));
        expect(outcome(() => r.reservations.reserveQuote(request))).toBe(expected);
    } finally {
        r.db.close();
    }
});

describe("claimLockup", () => {
    const claimed = () => {
        const r = repositories();
        const request = setUp(r.policy, r.advances, VALID);
        r.reservations.reserveQuote(request);
        r.reservations.reserveQuote({
            ...request,
            advance: advance({
                id: "stale",
                expiresAt: 10,
                operatorInputs: [{ txid: "aa".repeat(32), vout: 1 }],
            }),
        });
        return r;
    };
    const dropReservations = ({ db }: Repositories) =>
        db.prepare("DELETE FROM operator_input_reservations WHERE advance_id = 'quote-1'").run();

    const nothing = () => {};
    it.each([
        {
            when: "over the outstanding cap",
            code: "exceeds_max_outstanding",
            stale: "quoted",
            prepare: (r: Repositories) => r.policy.update({ maxOutstandingSats: 0n }, "grid"),
        },
        {
            when: "at the concurrency cap",
            code: "max_concurrent_advances",
            stale: "quoted",
            prepare: (r: Repositories) => r.policy.update({ maxConcurrentAdvances: 0 }, "grid"),
        },
        {
            when: "over the cap and missing its reservations",
            code: "exceeds_max_outstanding",
            stale: "quoted",
            prepare: (r: Repositories) => {
                dropReservations(r);
                r.policy.update({ maxOutstandingSats: 0n }, "grid");
            },
        },
        { when: "unknown", id: "missing", code: "not_found", stale: "expired", prepare: nothing },
        {
            when: "expired at the claim clock",
            id: "stale",
            code: "quote_expired",
            stale: "expired",
            prepare: nothing,
        },
        {
            when: "signed over another graph",
            unsigned: "ff",
            code: "envelope_conflict",
            stale: "expired",
            prepare: nothing,
        },
        {
            when: "already terminal",
            id: "done",
            code: "invalid_state",
            stale: "expired",
            prepare: (r: Repositories) =>
                r.advances.insert(advance({ id: "done", state: "recycled" })),
        },
        {
            when: "missing its reservations",
            code: "funding_reservation_invalid",
            stale: "expired",
            prepare: dropReservations,
        },
    ])(
        "refuses a claim $when with $code, leaving the expired quote $stale",
        ({ id = "quote-1", unsigned = "bb", code, stale, prepare }) => {
            const r = claimed();
            try {
                prepare(r);
                expect(() =>
                    r.reservations.claimLockup(
                        id,
                        unsigned.repeat(32),
                        "dd".repeat(32),
                        "envelope",
                        () => 20,
                    ),
                ).toThrowError(expect.objectContaining({ name: "LockupClaimError", code }));
                expect(r.advances.get("stale")!.state).toBe(stale);
                expect(r.reservations.listForAdvance("stale")).toHaveLength(
                    stale === "quoted" ? 1 : 0,
                );
            } finally {
                r.db.close();
            }
        },
    );
});
