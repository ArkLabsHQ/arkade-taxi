import { signLockup, TaxiError, type TaxiClient, type VerifiedQuote } from "@arkade-taxi/client";
import type { Identity } from "@arkade-os/sdk";

const transientReadiness = [
    "runtime_checking",
    "runtime_stale",
    "proceeds_collecting",
    "proceeds_output_pending",
];

export interface AdmissionWindow {
    readyUrl: string;
    expiresAt: number;
    maxAttempts?: number;
    now?: () => number;
}

export async function preEffectRequest<T>(
    attempt: () => Promise<T>,
    window: AdmissionWindow,
    unchanged: () => Promise<void> = async () => {},
): Promise<T> {
    const now = window.now ?? Date.now;
    const limit = window.maxAttempts ?? 3;
    if (!Number.isInteger(limit) || limit < 1 || limit > 3)
        throw new Error("invalid pre-effect attempt limit");
    const remaining = () => {
        const value = window.expiresAt * 1000 - now();
        if (!Number.isFinite(value) || value <= 0)
            throw new Error("pre-effect request reached its original expiry");
        return value;
    };
    for (let index = 0; index < limit; index++) {
        remaining();
        try {
            return await attempt();
        } catch (error) {
            if (
                !(error instanceof TaxiError) ||
                !(
                    (error.code === "not_ready" && transientReadiness.includes(error.message)) ||
                    (error.code === "runtime_unsafe" &&
                        ["runtime_checking", "runtime_stale"].includes(error.message))
                )
            )
                throw error;
            if (index + 1 === limit)
                throw new Error("pre-effect request exhausted its attempt limit", { cause: error });
        }
        while (true) {
            const response = await fetch(window.readyUrl, {
                signal: AbortSignal.timeout(Math.max(1, Math.min(5000, Math.ceil(remaining())))),
            });
            const body = await response.json();
            remaining();
            if (
                response.status === 200 &&
                body.status === "ok" &&
                body.paused === false &&
                Array.isArray(body.blockers) &&
                body.blockers.length === 0
            )
                break;
            const allowed = [
                ...transientReadiness,
                "chain_height_unavailable",
                "chain_time_unavailable",
            ];
            if (
                response.status !== 503 ||
                body.status !== "degraded" ||
                !transientReadiness.includes(body.reason) ||
                !Array.isArray(body.blockers) ||
                !body.blockers.includes(body.reason) ||
                body.blockers.some((code: unknown) => !allowed.includes(code as string))
            )
                throw new Error("readiness did not confirm the exact transient pre-effect state");
            await new Promise((resolve) => setTimeout(resolve, Math.min(50, remaining())));
        }
        await unchanged();
    }
    throw new Error("pre-effect attempt limit exhausted");
}

export async function submitWithReadiness(
    client: TaxiClient,
    verified: VerifiedQuote,
    identity: Identity,
    window: Omit<AdmissionWindow, "expiresAt">,
) {
    const signed = await signLockup({ verified, identity });
    return preEffectRequest(
        () => client.submitLockup(verified, signed),
        { ...window, expiresAt: verified.quote.expiresAt },
        async () => {
            const state = await client.status(verified.quote.transferId);
            if (
                state.transferId !== verified.quote.transferId ||
                state.state !== "quoted" ||
                state.submissionPhase !== undefined ||
                state.outpoint !== undefined ||
                state.spentTxid !== undefined ||
                state.failureCode !== undefined ||
                state.failureDetail !== undefined
            )
                throw new Error(
                    "transfer is not an unchanged quoted advance without submission effects",
                );
        },
    );
}
