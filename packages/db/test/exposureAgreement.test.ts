import { expect, it } from "vitest";
import { computeExposure, type Advance } from "@arkade-taxi/core";
import {
    ADVANCE_STATES,
    AdvanceRepository,
    ReceiveQuoteRepository,
    openDatabase,
    totalExposure,
} from "../src/index";

const DEADLINE = 1_757_000_000n + 8_640_000n;

const advance = (
    state: Advance["state"],
    kind: "covenant" | "sponsored",
    topup: bigint,
): Advance => ({
    id: `${kind}-${state}`,
    state,
    ...(kind === "sponsored"
        ? { kind, locktime: 0n, batchExpiry: { kind: "height" as const, value: 900_000n } }
        : { locktime: DEADLINE, recoveryLocktime: { kind: "time" as const, value: DEADLINE } }),
    receiverKey: new Uint8Array(32),
    senderKey: new Uint8Array(32),
    operatorKey: new Uint8Array(32),
    operatorSignerKey: new Uint8Array(32).fill(4),
    exitDelay: { value: 5n, type: "blocks" },
    dust: 330n,
    topup,
    operatorInputs: [{ txid: "aa".repeat(32), vout: 0 }],
    unsignedLockupTx: "unsigned",
    unsignedLockupId: "bb".repeat(32),
    covenantAddress: "tark1qexample",
    fare: { currency: "sats", units: 10n },
    createdAt: 1,
    updatedAt: 1,
    expiresAt: 60,
});

it("counts the same rows in the SQL, core and combined exposure readings", () => {
    const db = openDatabase(":memory:");
    try {
        const advances = new AdvanceRepository(db);
        const amounts = new Map<string, bigint>();
        let next = 0n;
        for (const kind of ["covenant", "sponsored"] as const)
            for (const state of ADVANCE_STATES) {
                amounts.set(`${kind}/${state}`, 1n << next);
                advances.insert(advance(state, kind, 1n << next++));
            }
        const quote = db.prepare(
            `INSERT INTO receive_quotes (id, state, receiver_address, sender_key, params_json,
                covenant_address, fare_json, batch_expiry_kind, batch_expiry_value,
                input_expiry_floor_kind, input_expiry_floor_value, recovery_locktime_kind,
                recovery_locktime_value, loan_sats, created_at, expires_at, policy_revision,
                operator_inputs_json, bound_fill_id)
             VALUES (?, ?, 'receiver', ?, '{}', 'covenant', '{}', 'height', 900000, 'height',
                900000, 'time', ?, ?, 1, 60, 0, '[]', ?)`,
        );
        for (const state of ["quoted", "bound", "expired"] as const) {
            amounts.set(`receive/${state}`, 1n << next);
            quote.run(
                `receive-${state}`,
                state,
                "00".repeat(32),
                DEADLINE,
                1n << next++,
                state === "bound" ? "fill" : null,
            );
        }
        const counted = (total: bigint) =>
            [...amounts].filter(([, amount]) => (total & amount) !== 0n).map(([row]) => row);

        const sql = advances.exposureTotals();
        const core = computeExposure(ADVANCE_STATES.flatMap((state) => advances.byState(state)));
        const quotes = new ReceiveQuoteRepository(db).exposureTotals();
        const combined = totalExposure(db);

        expect(counted(sql.outstandingSats)).toEqual(counted(core.outstandingSats));
        expect(sql.lockedCount).toBe(core.lockedCount);
        expect(combined.total).toBe(sql.outstandingSats + quotes.outstandingSats);
        expect(combined.count).toBe(BigInt(sql.lockedCount + quotes.activeCount));
        expect(counted(combined.total)).toEqual([
            "covenant/locking",
            "covenant/locked",
            "covenant/recovering",
            "sponsored/locking",
            "receive/quoted",
        ]);
        expect(combined.count).toBe(5n);
    } finally {
        db.close();
    }
});
