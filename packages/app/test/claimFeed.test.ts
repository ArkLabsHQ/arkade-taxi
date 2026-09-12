import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Advance } from "@arkade-taxi/core";
import { bytesToHex, type ClaimsChangedEvent } from "@arkade-taxi/protocol";
import { ReceiverClaimFeed } from "../src/claimFeed.js";
import { buildLockupEnvelope } from "../src/arkade/lockupBuilder.js";
import { decodeLockupEnvelope } from "../src/arkade/psbt.js";
import { buildRequest, unroll } from "./arkade/lockupFixtures.js";
import { advance, config, MemoryAdvances, receiverKey, senderKey } from "./fixtures.js";

function locked(): Advance {
    const request = buildRequest();
    const unsignedLockupTx = buildLockupEnvelope(request, config(), unroll);
    return advance({
        ...request.params,
        covenantAddress: request.covenantAddress,
        fare: request.fare,
        batchExpiry: request.funding.batchExpiry,
        recoveryLocktime: { kind: "height", value: request.params.locktime },
        operatorInputs: request.funding.inputs.map(({ txid, vout }) => ({ txid, vout })),
        unsignedLockupTx,
        unsignedLockupId: decodeLockupEnvelope(unsignedLockupTx).unsignedTxId,
        outpoint: { txid: "cd".repeat(32), vout: 0 },
    });
}

function setup() {
    const advances = new MemoryAdvances();
    const reads = vi.spyOn(advances, "byReceiverKeys");
    const feed = new ReceiverClaimFeed({ advances, config: config() });
    return { advances, reads, feed };
}

const listener = () => ({ onChanged: vi.fn(), onError: vi.fn() });

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
    const timers = vi.getTimerCount();
    vi.useRealTimers();
    expect(timers).toBe(0);
});

describe("ReceiverClaimFeed", () => {
    it("samples overlapping subscriptions once per tick and emits terminal changes", async () => {
        const { advances, reads, feed } = setup();
        const row = locked();
        advances.insert(row);
        advances.insert(advance({ id: "alice", state: "locking", receiverKey: senderKey }));
        const a = listener();
        const b = listener();
        expect(vi.getTimerCount()).toBe(0);
        const closeA = feed.subscribe([receiverKey, senderKey, receiverKey.slice()], a);
        const closeB = feed.subscribe([receiverKey], b);
        try {
            expect(vi.getTimerCount()).toBe(1);
            expect(reads).not.toHaveBeenCalled();
            await vi.advanceTimersByTimeAsync(250);
            expect(reads).toHaveBeenCalledTimes(1);
            expect(reads.mock.calls[0]![0].map(bytesToHex).sort()).toEqual(
                [bytesToHex(receiverKey), bytesToHex(senderKey)].sort(),
            );
            expect(a.onChanged.mock.calls[0]![0].claims).toHaveLength(2);
            expect(b.onChanged.mock.calls[0]![0].claims).toHaveLength(1);
            await vi.advanceTimersByTimeAsync(250);
            expect(a.onChanged).toHaveBeenCalledTimes(1);
            advances.update({ ...row, state: "purchased", spentTxid: "ef".repeat(32) });
            await vi.advanceTimersByTimeAsync(250);
            expect(a.onChanged).toHaveBeenLastCalledWith({
                claims: [
                    expect.objectContaining({
                        transferId: "adv-1",
                        state: "purchased",
                        claimable: false,
                        spentTxid: "ef".repeat(32),
                    }),
                ],
            });
            expect(b.onChanged).toHaveBeenCalledTimes(2);
            closeA();
            reads.mockClear();
            await vi.advanceTimersByTimeAsync(250);
            expect(reads.mock.calls[0]![0]).toEqual([receiverKey]);
        } finally {
            closeA();
            closeB();
        }
        await vi.advanceTimersByTimeAsync(1_000);
        expect(reads).toHaveBeenCalledTimes(1);
    });

    it("coalesces slow-listener changes without delaying other listeners", async () => {
        const { advances, reads, feed } = setup();
        advances.insert(advance({ state: "locking" }));
        let release!: () => void;
        const blocked = new Promise<void>((resolve) => (release = resolve));
        const slow = { onChanged: vi.fn(() => blocked), onError: vi.fn() };
        const fast = listener();
        const closeSlow = feed.subscribe([receiverKey], slow);
        const closeFast = feed.subscribe([receiverKey], fast);
        try {
            await vi.advanceTimersByTimeAsync(250);
            advances.update(advance({ state: "recovering" }));
            await vi.advanceTimersByTimeAsync(250);
            advances.update(advance({ state: "recovered" }));
            await vi.advanceTimersByTimeAsync(250);
            expect(reads).toHaveBeenCalledTimes(3);
            expect(slow.onChanged).toHaveBeenCalledTimes(1);
            expect(fast.onChanged).toHaveBeenCalledTimes(3);
            release();
            await vi.advanceTimersByTimeAsync(0);
            expect(slow.onChanged).toHaveBeenCalledTimes(2);
            expect(slow.onChanged).toHaveBeenLastCalledWith({
                claims: [expect.objectContaining({ state: "recovered" })],
            });
        } finally {
            release();
            closeSlow();
            closeFast();
        }
    });

    it("does not deliver queued batches after unsubscribe and can restart lazily", async () => {
        const { advances, feed } = setup();
        advances.insert(advance({ state: "locking" }));
        let release!: () => void;
        const blocked = new Promise<void>((resolve) => (release = resolve));
        const slow = { onChanged: vi.fn(() => blocked), onError: vi.fn() };
        const close = feed.subscribe([receiverKey], slow);
        await vi.advanceTimersByTimeAsync(250);
        advances.update(advance({ state: "purchased" }));
        await vi.advanceTimersByTimeAsync(250);
        close();
        release();
        await vi.advanceTimersByTimeAsync(0);
        expect(slow.onChanged).toHaveBeenCalledTimes(1);
        const next = listener();
        const closeNext = feed.subscribe([receiverKey], next);
        try {
            await vi.advanceTimersByTimeAsync(250);
            expect(next.onChanged).toHaveBeenCalledWith({
                claims: [expect.objectContaining({ state: "purchased" })],
            });
        } finally {
            closeNext();
        }
    });

    it("terminates an invalid receiver batch without publishing partial claims", async () => {
        const { advances, feed } = setup();
        advances.insert(advance({ state: "locked", unsignedLockupTx: "private invariant" }));
        advances.insert(advance({ id: "alice", state: "locking", receiverKey: senderKey }));
        const mixed = listener();
        const healthy = listener();
        const closeMixed = feed.subscribe([receiverKey, senderKey], mixed);
        const closeHealthy = feed.subscribe([senderKey], healthy);
        try {
            await vi.advanceTimersByTimeAsync(250);
            expect(mixed.onChanged).not.toHaveBeenCalled();
            expect(mixed.onError).toHaveBeenCalledTimes(1);
            expect(mixed.onError.mock.calls[0]![0].message).toBe("internal error");
            expect(healthy.onChanged).toHaveBeenCalledTimes(1);
            await vi.advanceTimersByTimeAsync(250);
            expect(mixed.onError).toHaveBeenCalledTimes(1);
        } finally {
            closeMixed();
            closeHealthy();
        }
    });

    it.each(["throw", "reject"])("cleans up a listener that %ss while writing", async (mode) => {
        const { advances, feed } = setup();
        advances.insert(advance({ state: "locking" }));
        const error = vi.fn();
        feed.subscribe([receiverKey], {
            onChanged: (_event: ClaimsChangedEvent) => {
                if (mode === "throw") throw new Error("private transport detail");
                return Promise.reject(new Error("private transport detail"));
            },
            onError: error,
        });
        await vi.advanceTimersByTimeAsync(250);
        expect(error).toHaveBeenCalledTimes(1);
        expect(error.mock.calls[0]![0].message).toBe("internal error");
    });

    it("cleans up every subscription on repository failure even if onError throws", async () => {
        const { reads, feed } = setup();
        reads.mockImplementation(() => {
            throw new Error("private database detail");
        });
        const failed = vi.fn(() => {
            throw new Error("listener failure");
        });
        const other = listener();
        feed.subscribe([receiverKey], { onChanged: vi.fn(), onError: failed });
        feed.subscribe([senderKey], other);
        await vi.advanceTimersByTimeAsync(250);
        expect(failed).toHaveBeenCalledTimes(1);
        expect(other.onError).toHaveBeenCalledTimes(1);
        expect(other.onChanged).not.toHaveBeenCalled();
    });
});
