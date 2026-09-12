import { it } from "vitest";
import { runWithCleanup } from "../scripts/lib/scenario-cleanup.mjs";

export const SCENARIOS = [
    {
        id: "provider-contract",
        title: "live provider identities and persistent operator wallet contract",
    },
    {
        id: "asset-recycle-receiver-holds-asset",
        title: "asset recycle into an existing asset balance",
    },
    {
        id: "asset-recycle-receiver-holds-no-asset",
        title: "asset recycle into a sats-only receiver",
    },
    { id: "purchase-receiver-holds-no-vtxo", title: "purchase into an empty receiver wallet" },
    { id: "subdust-bitcoin-recycle", title: "sub-dust bitcoin recycle" },
    {
        id: "receiver-sse-recycle",
        title: "receiver SSE discovery verifies and recycles 200 USDT",
    },
    {
        id: "receiver-sse-asset-fare-purchase",
        title: "receiver SSE discovery purchases 200 USDT after a 1 USDT fare",
    },
    { id: "sender-refund-before-locktime", title: "sender-signed refund before locktime" },
    {
        id: "premature-recovery-rejected",
        title: "recovery rejected specifically by CLTV before locktime",
    },
    {
        id: "sweeper-recovery-after-locktime",
        title: "production sweeper recovers after locktime and before expiry",
    },
    {
        id: "exposure-cap-rejects-quote",
        title: "production HTTP exposure cap rejects another quote",
    },
    {
        id: "verify-quote-rejects-tampered-params",
        title: "packed client rejects tampered production quotes",
    },
    {
        id: "restart-quoted-reservation",
        title: "restart after quote preserves the exact reservation",
    },
    {
        id: "restart-submitted-reconciliation",
        title: "restart after submit catches up to the observed covenant",
    },
    {
        id: "dropped-submit-response",
        title: "lost submit response cannot double-spend operator funding",
    },
    {
        id: "restart-locked-recovery",
        title: "restart with a locked covenant recovers before expiry",
    },
    {
        id: "stale-provider-identity",
        title: "stale provider identity closes readiness and admission",
    },
    {
        id: "near-expiry-auto-pause",
        title: "warning and critical deadlines pause quotes and still recover",
    },
    {
        id: "duplicate-lockup-idempotent",
        title: "duplicate lockup POST preserves one spend and one advance",
    },
] as const;

export const EXPECTED_TOTAL = 19;

export function liveScenario(id: string, fn: () => void | Promise<void>): void {
    const scenario = SCENARIOS.find((item) => item.id === id);
    if (!scenario) throw new Error(`e2e: unknown scenario ${id}`);
    it(`[${id}] ${scenario.title}`, async () => {
        if (process.env.ARKADE_E2E !== "1" || !process.env.TAXI_E2E_CLIENT_ENTRY)
            throw new Error(
                "e2e: run pnpm e2e:stack to provide the isolated production image and packed client",
            );
        await runWithCleanup(fn);
    });
}
