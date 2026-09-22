import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
    openDatabase,
    PolicyRepository,
    ReceiveQuoteRepository,
    ReceiveQuoteReservationConflictError,
    type Database,
    type ReceiveQuote,
} from "../src/index.js";

const NOW = 1_757_000_000;
const ASSET = { txid: new Uint8Array(32).fill(0x12), groupIndex: 7 };
const INPUT = { txid: "aa".repeat(32), vout: 1 };

const quote = (over: Partial<ReceiveQuote> = {}): ReceiveQuote => ({
    id: "receive-1",
    state: "quoted",
    receiverAddress: "ark1receiver",
    makerPublicKey: "22".repeat(32),
    params: {
        receiverKey: new Uint8Array(32).fill(0x11),
        senderKey: new Uint8Array(32).fill(0x22),
        operatorKey: new Uint8Array(32).fill(0x33),
        dust: 330n,
        topup: 329n,
        assetId: ASSET,
        locktime: 899_856n,
        claimMode: "recycle",
        recoveryRecipient: "receiver",
    },
    covenantAddress: "ark1covenant",
    fare: { currency: "sats", units: 3n },
    batchExpiry: { kind: "height", value: 900_000n },
    inputExpiryFloor: { kind: "height", value: 900_000n },
    recoveryLocktime: { kind: "height", value: 899_856n },
    loanSats: 329n,
    createdAt: NOW,
    expiresAt: NOW + 60,
    policyRevision: 1n,
    operatorInputs: [
        {
            ...INPUT,
            value: 20_000n,
            tapTree: new Uint8Array([1, 2]),
            spendLeaf: new Uint8Array([3, 4]),
            expiry: { kind: "height", value: 900_000n },
        },
    ],
    ...over,
});

const configure = (db: Database) => {
    const policy = new PolicyRepository(db);
    policy.update(
        {
            paused: false,
            maxOutstandingSats: 1_000n,
            maxPerPaymentTopupSats: 500n,
            maxConcurrentAdvances: 4,
            locktimeMarginBlocks: 144,
            assetRules: [
                {
                    assetId: ASSET,
                    enabled: true,
                    claim: "either",
                    maxTopupSats: null,
                    fares: [],
                },
            ],
        },
        "test",
    );
    return policy;
};

const insert = (repo: ReceiveQuoteRepository, policy: PolicyRepository, value = quote()) =>
    repo.insert({
        quote: { ...value, policyRevision: policy.getSnapshot().revision },
        expectedPolicyRevision: policy.getSnapshot().revision,
        recoveryExecutionBudget: { kind: "height", value: 72n },
    });

let cleanup: (() => void) | undefined;
afterEach(() => {
    cleanup?.();
    cleanup = undefined;
});

describe("receive quote repository", () => {
    it("round-trips immutable terms and full operator snapshots across restart", () => {
        const dir = mkdtempSync(join(tmpdir(), "taxi-receive-quote-"));
        cleanup = () => rmSync(dir, { recursive: true, force: true });
        const path = join(dir, "taxi.sqlite");
        const first = openDatabase(path);
        const policy = configure(first);
        const revision = policy.getSnapshot().revision;
        const lifetime = quote({
            params: { ...quote().params, locktime: 849_856n },
            inputExpiryFloor: { kind: "height", value: 850_000n },
            recoveryLocktime: { kind: "height", value: 849_856n },
        });
        insert(new ReceiveQuoteRepository(first), policy, lifetime);
        first.close();

        const second = openDatabase(path);
        const stored = new ReceiveQuoteRepository(second).get("receive-1");
        expect(stored).toEqual({
            ...lifetime,
            policyRevision: revision,
        });
        expect(stored?.operatorInputs[0]).toMatchObject({
            ...INPUT,
            value: 20_000n,
            expiry: { kind: "height", value: 900_000n },
        });
        second.close();
    });

    it("fails closed when persisted economics are corrupted", () => {
        const db = openDatabase(":memory:");
        const policy = configure(db);
        const repo = new ReceiveQuoteRepository(db);
        insert(repo, policy);
        db.prepare("UPDATE receive_quotes SET params_json = ? WHERE id = ?").run(
            JSON.stringify({ dust: "330" }),
            "receive-1",
        );
        expect(() => repo.get("receive-1")).toThrow(/params/);
        db.close();
    });

    it("expires and releases only unbound quotes", () => {
        const db = openDatabase(":memory:");
        const policy = configure(db);
        const repo = new ReceiveQuoteRepository(db);
        insert(repo, policy, quote({ id: "unbound" }));
        insert(
            repo,
            policy,
            quote({
                id: "bound",
                operatorInputs: [{ ...quote().operatorInputs[0]!, txid: "bb".repeat(32), vout: 2 }],
            }),
        );
        db.prepare(
            "UPDATE receive_quotes SET state = 'bound', bound_fill_id = 'fill-1' WHERE id = 'bound'",
        ).run();

        expect(repo.expireQuotes(NOW + 60)).toBe(1);
        expect(repo.get("unbound")?.state).toBe("expired");
        expect(repo.get("bound")?.state).toBe("bound");
        expect(repo.listReservedOutpoints()).toEqual([{ txid: "bb".repeat(32), vout: 2 }]);
        db.close();
    });

    it("rechecks revision, pause and aggregate receive exposure in the transaction", () => {
        const db = openDatabase(":memory:");
        const policy = configure(db);
        const repo = new ReceiveQuoteRepository(db);
        insert(repo, policy);

        const stale = policy.getSnapshot().revision;
        policy.update({ maxOutstandingSats: 657n }, "test");
        expect(() =>
            repo.insert({
                quote: quote({ id: "receive-2", policyRevision: stale }),
                expectedPolicyRevision: stale,
                recoveryExecutionBudget: { kind: "height", value: 72n },
            }),
        ).toThrow(/policy snapshot changed/);

        const current = policy.getSnapshot().revision;
        expect(() =>
            repo.insert({
                quote: quote({ id: "receive-2", policyRevision: current }),
                expectedPolicyRevision: current,
                recoveryExecutionBudget: { kind: "height", value: 72n },
            }),
        ).toThrow(/max outstanding/);
        db.close();
    });

    it("rejects a changed reservation snapshot atomically", () => {
        const db = openDatabase(":memory:");
        const policy = configure(db);
        const repo = new ReceiveQuoteRepository(db);
        insert(repo, policy);
        const current = policy.getSnapshot().revision;
        expect(() =>
            repo.insert({
                quote: quote({
                    id: "receive-2",
                    operatorInputs: [
                        { ...quote().operatorInputs[0]!, txid: "bb".repeat(32), vout: 2 },
                    ],
                }),
                expectedPolicyRevision: current,
                recoveryExecutionBudget: { kind: "height", value: 72n },
                expectedReservedOutpoints: [],
            }),
        ).toThrow(ReceiveQuoteReservationConflictError);
        db.close();
    });
});
