import { expect, it } from "vitest";
import { AdvanceRepository, CustodyRepository, openDatabase } from "../src/index";

const DEADLINE = 1_757_000_000n + 8_640_000n;

it("seeds the policy row at the first pause, not when a repository is built", () => {
    const db = openDatabase(":memory:");
    try {
        const rows = () =>
            Number((db.prepare("SELECT count(*) AS n FROM policy").get() as { n: bigint }).n);
        const advances = new AdvanceRepository(db);
        new CustodyRepository(db);
        expect(rows()).toBe(0);
        advances.insert({
            id: "adv",
            state: "locked",
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
        });
        expect(rows()).toBe(0);
        advances.recordSpendUnknown("adv", undefined, "gone", 2, {
            hash: "cc".repeat(32),
            height: 1,
        });
        expect(rows()).toBe(1);
    } finally {
        db.close();
    }
});
