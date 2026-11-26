import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ExtendedVirtualCoin, Identity } from "@arkade-os/sdk";
import { TaxiClaimQueue, type ClaimQueueOptions } from "../src/wallet/claimQueue";
import { ClaimSpent, claimVerified, offerKey, type VerifiedClaim } from "../src/wallet/claims";
import { CovenantSpendAmbiguousError } from "../src/spend";

vi.mock("../src/wallet/claims", async (original) => ({
    ...(await original<typeof import("../src/wallet/claims")>()),
    claimVerified: vi.fn(),
}));

const receiverKey = "11".repeat(32);
const coin = {
    txid: "22".repeat(32),
    vout: 0,
    value: 1000,
    script: `5120${receiverKey}`,
} as ExtendedVirtualCoin;
const offer = {
    taxi: { url: "https://taxi.test" },
    claim: {
        transferId: "transfer",
        claim: {
            params: {
                receiverKey,
                dust: "330",
                topup: "330",
                paymentSats: "100",
                claimMode: "recycle",
            },
        },
    },
} as unknown as VerifiedClaim;

const setup = (changes: Partial<ClaimQueueOptions> = {}) => {
    let allowed = false;
    const release = vi.fn();
    const reserve = vi.fn().mockResolvedValue({ release });
    const options: ClaimQueueOptions = {
        identity: {} as Identity,
        getCoins: async () => [coin],
        coordinate: (run) => run(),
        reserve,
        allowed: () => allowed,
        automatic: false,
        reload: vi.fn(),
        recordClaim: vi.fn(),
        ...changes,
    };
    const queue = new TaxiClaimQueue(options);
    queue.offer(offer);
    allowed = true;
    return { queue, release, reserve, options };
};

describe("Taxi claim input reservations", () => {
    beforeEach(() => {
        vi.mocked(claimVerified).mockReset();
    });

    it("holds the selected input before signing and releases after confirmed submission", async () => {
        const { queue, release, reserve, options } = setup();
        vi.mocked(claimVerified).mockImplementation(async () => {
            expect(reserve).toHaveBeenCalledWith(offer, expect.objectContaining({ coin }));
            expect(release).not.toHaveBeenCalled();
            return "33".repeat(32);
        });
        await queue.claim(offerKey(offer));
        expect(release).toHaveBeenCalledOnce();
        expect(options.recordClaim).toHaveBeenCalledOnce();
        queue.dispose();
    });

    it("does not sign when the ordinary wallet already reserved the input", async () => {
        const { queue, release } = setup({
            reserve: vi.fn().mockRejectedValue(new Error("input busy")),
        });
        await queue.claim(offerKey(offer));
        expect(claimVerified).not.toHaveBeenCalled();
        expect(release).not.toHaveBeenCalled();
        expect(queue.snapshot().errors.get(offerKey(offer))).toMatchObject({
            message: "input busy",
        });
        queue.dispose();
    });

    it("retains the reservation when submission is ambiguous", async () => {
        const { queue, release } = setup();
        vi.mocked(claimVerified).mockRejectedValue(
            new ClaimSpent(
                new CovenantSpendAmbiguousError("33".repeat(32), new Error("connection lost")),
            ),
        );
        await queue.claim(offerKey(offer));
        expect(release).not.toHaveBeenCalled();
        expect(queue.snapshot().spent.has(offerKey(offer))).toBe(true);
        queue.dispose();
        expect(release).not.toHaveBeenCalled();
    });

    it("releases an attempt proven to have failed before submission", async () => {
        const { queue, release } = setup();
        vi.mocked(claimVerified).mockRejectedValue(new Error("invalid local input"));
        await queue.claim(offerKey(offer));
        expect(release).toHaveBeenCalledOnce();
        expect(queue.snapshot().spent.has(offerKey(offer))).toBe(false);
        queue.dispose();
    });

    it("releases a consumed claim capability when validation failed before submission", async () => {
        const { queue, release } = setup();
        vi.mocked(claimVerified).mockRejectedValue(
            new ClaimSpent(new Error("invalid funding coin")),
        );
        await queue.claim(offerKey(offer));
        expect(release).toHaveBeenCalledOnce();
        expect(queue.snapshot().spent.has(offerKey(offer))).toBe(true);
        queue.dispose();
    });

    it("releases without signing when the wallet is revoked during reservation", async () => {
        const { queue, release, reserve } = setup();
        reserve.mockImplementation(async () => {
            queue.setActive(false);
            return { release };
        });
        await queue.claim(offerKey(offer));
        expect(release).toHaveBeenCalledOnce();
        expect(claimVerified).not.toHaveBeenCalled();
        queue.dispose();
    });

    it("refuses recycle signing without a wallet reservation adapter", async () => {
        const { queue } = setup({ reserve: undefined });
        await queue.claim(offerKey(offer));
        expect(claimVerified).not.toHaveBeenCalled();
        expect(queue.snapshot().errors.get(offerKey(offer))).toMatchObject({
            message: "Wallet input reservation is required for Taxi recycle claims",
        });
        queue.dispose();
    });

    it("never repeats a successful claim when releasing its reservation fails", async () => {
        const release = vi.fn().mockRejectedValue(new Error("indexer not caught up"));
        const { queue } = setup({ reserve: async () => ({ release }) });
        vi.mocked(claimVerified).mockResolvedValue("33".repeat(32));
        await queue.claim(offerKey(offer));
        queue.offer(offer);
        await queue.claim(offerKey(offer));
        expect(claimVerified).toHaveBeenCalledOnce();
        expect(queue.snapshot().offers).toHaveLength(0);
        queue.dispose();
    });

    it("never repeats a submitted claim when its history record fails", async () => {
        const failure = new Error("history storage unavailable");
        const onError = vi.fn();
        const recordClaim = vi.fn().mockRejectedValue(failure);
        const { queue, release, options } = setup({ recordClaim, onError });
        const txid = "33".repeat(32);
        vi.mocked(claimVerified).mockResolvedValue(txid);
        await queue.claim(offerKey(offer));
        queue.offer(offer);
        await queue.claim(offerKey(offer));
        expect(claimVerified).toHaveBeenCalledOnce();
        expect(recordClaim).toHaveBeenCalledExactlyOnceWith(
            offer,
            expect.objectContaining({ kind: "recycle", coin }),
            txid,
        );
        expect(onError).toHaveBeenCalledExactlyOnceWith(failure, offerKey(offer));
        expect(release).toHaveBeenCalledExactlyOnceWith(txid);
        expect(options.reload).toHaveBeenCalledOnce();
        expect(queue.snapshot().offers).toHaveLength(0);
        queue.dispose();
    });
});
