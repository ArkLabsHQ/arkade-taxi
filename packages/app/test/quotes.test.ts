import { beforeEach, describe, expect, it } from "vitest";
import { DustCovenantScript } from "@arkade-taxi/covenant";
import { assetIdToWire, bytesToHex } from "@arkade-taxi/protocol";
import type { ServiceError } from "../src/errors.js";
import {
    createQuote,
    FakeLockupBuilder,
    getTransfer,
    submitLockup,
    type QuoteDeps,
} from "../src/quotes.js";
import {
    advance,
    config,
    DUST,
    emulatorKey,
    EXPIRY_HEIGHT,
    MemoryAdvances,
    NOW,
    operatorKey,
    policy as basePolicy,
    quoteBody,
    receiverKey,
    senderKey,
    serverKey,
    VTXO_MIN,
} from "./fixtures.js";
import type { Policy } from "@arkade-taxi/core";

const MARGIN = 144;
const LOCKTIME = EXPIRY_HEIGHT - BigInt(MARGIN);
const ASSET = { txid: new Uint8Array(32).fill(0xde), groupIndex: 2 };

let advances: MemoryAdvances;
let lockupBuilder: FakeLockupBuilder;
let ids: number;

const deps = (over: { policy?: Partial<Policy>; expiry?: bigint } = {}): QuoteDeps => ({
    advances,
    policy: { get: () => basePolicy({ locktimeMarginBlocks: MARGIN, ...over.policy }) },
    config: config(),
    now: () => NOW,
    randomId: () => `adv-${++ids}`,
    covenantExpiry: async () => over.expiry ?? EXPIRY_HEIGHT,
    lockupBuilder,
});

const caught = async (fn: () => Promise<unknown>): Promise<ServiceError> => {
    try {
        await fn();
    } catch (e) {
        return e as ServiceError;
    }
    throw new Error("expected a rejection");
};

beforeEach(() => {
    advances = new MemoryAdvances();
    lockupBuilder = new FakeLockupBuilder();
    ids = 0;
});

describe("createQuote", () => {
    it("returns the QuoteResponse shape with amounts as decimal strings", async () => {
        const res = await createQuote(deps(), quoteBody());

        expect(res.transferId).toBe("adv-1");
        expect(res.params).toEqual({
            receiverKey: bytesToHex(receiverKey),
            senderKey: bytesToHex(senderKey),
            operatorKey: bytesToHex(operatorKey),
            dust: "330",
            topup: "330",
            locktime: LOCKTIME.toString(),
        });
        expect(res.feeSats).toBe("8");
        expect(res.unsignedLockupTx).toBe(lockupBuilder.unsignedTx);
    });

    it("dates expiry in unix seconds from the policy TTL", async () => {
        const res = await createQuote(deps({ policy: { quoteTtlSeconds: 90 } }), quoteBody());
        expect(res.expiresAt).toBe(NOW + 90);
    });

    it("derives a covenant address the client can reproduce independently", async () => {
        const res = await createQuote(deps(), quoteBody());
        const expected = new DustCovenantScript({
            serverKey,
            emulatorKey,
            vtxoMinAmount: VTXO_MIN,
            params: {
                receiverKey,
                senderKey,
                operatorKey,
                dust: DUST,
                topup: DUST,
                locktime: LOCKTIME,
            },
        })
            .address("ark", serverKey)
            .encode();

        expect(res.covenantAddress).toBe(expected);
    });

    it("persists the advance in state quoted", async () => {
        const res = await createQuote(deps(), quoteBody());
        const stored = advances.get(res.transferId)!;

        expect(stored.state).toBe("quoted");
        expect(stored.topup).toBe(330n);
        expect(stored.feeSats).toBe(8n);
        expect(stored.locktime).toBe(LOCKTIME);
        expect(stored.createdAt).toBe(NOW);
        expect(stored.covenantAddress).toBe(res.covenantAddress);
    });

    it("charges the sender only the shortfall when it brings sats", async () => {
        const res = await createQuote(deps(), quoteBody({ senderSats: "100" }));
        expect(res.params.topup).toBe("230");
    });

    it("round-trips an asset id", async () => {
        const res = await createQuote(deps(), quoteBody({ assetId: assetIdToWire(ASSET) }));
        expect(res.params.assetId).toEqual(assetIdToWire(ASSET));
        expect(advances.get(res.transferId)!.assetId).toEqual(ASSET);
    });

    it("hands the builder the derived covenant, not a rebuilt one", async () => {
        const res = await createQuote(deps(), quoteBody());
        expect(lockupBuilder.built).toHaveLength(1);
        expect(lockupBuilder.built[0]!.covenantAddress).toBe(res.covenantAddress);
        expect(lockupBuilder.built[0]!.feeSats).toBe(8n);
    });

    it("subtracts the policy margin from the covenant VTXO expiry", async () => {
        const res = await createQuote(
            deps({ policy: { locktimeMarginBlocks: 1_000 }, expiry: 800_000n }),
            quoteBody(),
        );
        expect(res.params.locktime).toBe("799000");
    });

    it("refuses to quote when the margin leaves no locktime", async () => {
        const e = await caught(() =>
            createQuote(deps({ policy: { locktimeMarginBlocks: 900 }, expiry: 800n }), quoteBody()),
        );
        expect(e.code).toBe("no_locktime_headroom");
        expect(e.status).toBe(503);
        expect(advances.rows.size).toBe(0);
    });
});

describe("createQuote admission", () => {
    it("surfaces paused as 503 with the reason verbatim", async () => {
        const e = await caught(() => createQuote(deps({ policy: { paused: true } }), quoteBody()));
        expect(e.code).toBe("paused");
        expect(e.status).toBe(503);
        expect(advances.rows.size).toBe(0);
    });

    it("counts locked advances toward the outstanding cap", async () => {
        advances.insert(advance({ id: "locked-1", state: "locked", topup: 330n }));
        const e = await caught(() =>
            createQuote(deps({ policy: { maxOutstandingSats: 400n } }), quoteBody()),
        );
        expect(e.code).toBe("exceeds_max_outstanding");
        expect(e.status).toBe(409);
    });

    it("ignores non-locked advances when computing exposure", async () => {
        advances.insert(advance({ id: "quoted-1", state: "quoted", topup: 330n }));
        await expect(
            createQuote(deps({ policy: { maxOutstandingSats: 400n } }), quoteBody()),
        ).resolves.toBeDefined();
    });

    it("rejects an asset that is not on the allowlist", async () => {
        const e = await caught(() =>
            createQuote(
                deps({ policy: { assetAllowlist: [] } }),
                quoteBody({ assetId: { txid: "11".repeat(32), groupIndex: 0 } }),
            ),
        );
        expect(e.code).toBe("asset_not_allowed");
    });

    // The asset allowlist governs assets only; bitcoin has its own gate.
    it("quotes bitcoin against an empty asset allowlist, and refuses it only when allowBitcoin is off", async () => {
        await expect(
            createQuote(deps({ policy: { assetAllowlist: [] } }), quoteBody()),
        ).resolves.toBeDefined();

        const e = await caught(() =>
            createQuote(deps({ policy: { allowBitcoin: false } }), quoteBody()),
        );
        expect(e.code).toBe("bitcoin_not_allowed");
    });

    it("never calls the builder for a refused quote", async () => {
        await caught(() => createQuote(deps({ policy: { paused: true } }), quoteBody()));
        expect(lockupBuilder.built).toHaveLength(0);
    });
});

describe("createQuote request validation", () => {
    it.each([
        ["non-hex key", quoteBody({ receiverKey: "zz".repeat(32) })],
        ["missing key", quoteBody({ senderKey: undefined })],
        ["negative sats", quoteBody({ senderSats: "-5" })],
        ["sats as a number", quoteBody({ senderSats: 100 })],
    ])("rejects a %s with 400", async (_label, body) => {
        const e = await caught(() => createQuote(deps(), body));
        expect(e.status).toBe(400);
        expect(e.code).toBe("invalid_request");
    });

    it("rejects a body that is not an object", async () => {
        const e = await caught(() => createQuote(deps(), null as never));
        expect(e.status).toBe(400);
    });

    it("rejects a key that is not 32 bytes with 400, not 500", async () => {
        const e = await caught(() =>
            createQuote(deps(), quoteBody({ receiverKey: "11".repeat(31) })),
        );
        expect(e.status).toBe(400);
        expect(e.message).toMatch(/32 bytes/);
    });

    it("rejects receiver and sender being the same key with 400", async () => {
        const e = await caught(() =>
            createQuote(deps(), quoteBody({ senderKey: bytesToHex(receiverKey) })),
        );
        expect(e.status).toBe(400);
        expect(e.code).toBe("invalid_request");
    });
});

describe("submitLockup", () => {
    const quoted = async () => (await createQuote(deps(), quoteBody())).transferId;

    it("moves quoted → locked and records the outpoint", async () => {
        const id = await quoted();
        const res = await submitLockup(deps(), id, "signed-psbt");

        expect(res).toEqual({
            txid: lockupBuilder.outpoint.txid,
            outpoint: lockupBuilder.outpoint,
        });
        const stored = advances.get(id)!;
        expect(stored.state).toBe("locked");
        expect(stored.outpoint).toEqual(lockupBuilder.outpoint);
        expect(lockupBuilder.submitted).toEqual(["signed-psbt"]);
    });

    // Stranding it in `locking` would freeze the capital: `locking` has no edge
    // to any terminal state, so nothing could ever release it.
    it("returns the advance to quoted when the submission fails", async () => {
        const id = await quoted();
        lockupBuilder.failSubmit = new Error("arkd refused the transaction");

        const e = await caught(() => submitLockup(deps(), id, "signed-psbt"));
        expect(e.code).toBe("lockup_failed");
        expect(e.status).toBe(502);
        expect(advances.get(id)!.state).toBe("quoted");
    });

    it("reports a stranded advance when the release write also fails", async () => {
        const id = await quoted();
        lockupBuilder.failSubmit = new Error("arkd refused the transaction");
        advances.failUpdateAt = 2;

        const e = await caught(() => submitLockup(deps(), id, "psbt"));
        expect(e.code).toBe("lockup_stranded");
        expect(e.status).toBe(500);
        expect(e.message).toMatch(/manual reconciliation/);
    });

    it("leaves the quote re-submittable after a failure", async () => {
        const id = await quoted();
        lockupBuilder.failSubmit = new Error("transient");
        await caught(() => submitLockup(deps(), id, "psbt-1"));

        lockupBuilder.failSubmit = null;
        await expect(submitLockup(deps(), id, "psbt-2")).resolves.toBeDefined();
        expect(advances.get(id)!.state).toBe("locked");
    });

    it("404s an unknown transfer", async () => {
        const e = await caught(() => submitLockup(deps(), "nope", "psbt"));
        expect(e.status).toBe(404);
        expect(e.code).toBe("not_found");
    });

    it("409s a transfer that is not quoted", async () => {
        const id = await quoted();
        await submitLockup(deps(), id, "psbt");

        const e = await caught(() => submitLockup(deps(), id, "psbt"));
        expect(e.status).toBe(409);
        expect(e.code).toBe("invalid_state");
        expect(advances.get(id)!.state).toBe("locked");
    });

    it("expires a stale quote rather than locking it", async () => {
        const id = await quoted();
        const late = { ...deps(), now: () => NOW + 61 };

        const e = await caught(() => submitLockup(late, id, "psbt"));
        expect(e.code).toBe("quote_expired");
        expect(e.status).toBe(409);
        expect(advances.get(id)!.state).toBe("expired");
        expect(lockupBuilder.submitted).toHaveLength(0);
    });
});

describe("getTransfer", () => {
    it("reports the current ledger state", async () => {
        const id = (await createQuote(deps(), quoteBody())).transferId;
        expect(getTransfer(deps(), id)).toEqual({
            transferId: id,
            state: "quoted",
            updatedAt: NOW,
        });
    });

    it("includes the outpoint once locked", async () => {
        const id = (await createQuote(deps(), quoteBody())).transferId;
        await submitLockup(deps(), id, "psbt");
        expect(getTransfer(deps(), id).outpoint).toEqual(lockupBuilder.outpoint);
    });

    it("404s an unknown transfer", async () => {
        await expect(async () => getTransfer(deps(), "nope")).rejects.toThrow(/not found/i);
    });
});
