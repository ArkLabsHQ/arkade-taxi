/**
 * Scenario 8. Runs for real, but only over `@arkade-taxi/core` — it is the
 * admission decision, not an HTTP 409 from a running operator. The controls
 * matter more than the rejection: a cap test that fires because the policy was
 * paused, or because the asset was not on the allowlist, proves nothing.
 */

import { expect } from "vitest";
import { admit, computeExposure } from "@arkade-taxi/core";
import { DUST, VTXO_MIN, advance, policy, quoteRequest } from "./fixtures.js";
import { liveScenario } from "./scenarios.js";

liveScenario("exposure-cap-rejects-quote", () => {
    const locked = [
        advance({ id: "a1", topup: 400n }),
        advance({ id: "a2", topup: 300n }),
        advance({ id: "a3", topup: 5_000n, state: "quoted" }),
        advance({ id: "a4", topup: 5_000n, state: "recovered" }),
    ];

    const exposure = computeExposure(locked);
    expect(exposure.outstandingSats).toBe(700n);
    expect(exposure.lockedCount).toBe(2);

    const req = quoteRequest();

    const refused = admit(req, policy({ maxOutstandingSats: 1_000n }), exposure, DUST, VTXO_MIN);
    expect(refused).toEqual({ ok: false, reason: "exceeds_max_outstanding" });

    const admitted = admit(req, policy({ maxOutstandingSats: 2_000n }), exposure, DUST, VTXO_MIN);
    expect(admitted).toEqual({
        ok: true,
        topup: DUST,
        fare: { currency: "sats", units: 1n },
        claim: "either",
    });

    const boundary = admit(req, policy({ maxOutstandingSats: 1_030n }), exposure, DUST, VTXO_MIN);
    expect(boundary).toEqual({
        ok: true,
        topup: DUST,
        fare: { currency: "sats", units: 1n },
        claim: "either",
    });
    const overBoundary = admit(
        req,
        policy({ maxOutstandingSats: 1_029n }),
        exposure,
        DUST,
        VTXO_MIN,
    );
    expect(overBoundary).toEqual({ ok: false, reason: "exceeds_max_outstanding" });

    const perPayment = admit(
        req,
        policy({ maxPerPaymentTopupSats: 100n }),
        exposure,
        DUST,
        VTXO_MIN,
    );
    expect(perPayment).toEqual({ ok: false, reason: "topup_exceeds_max_per_payment" });

    // Headroom on the sats cap, or that check fires first and this proves nothing.
    const concurrency = admit(
        req,
        policy({ maxConcurrentAdvances: 2, maxOutstandingSats: 10_000n }),
        exposure,
        DUST,
        VTXO_MIN,
    );
    expect(concurrency).toEqual({ ok: false, reason: "max_concurrent_advances" });

    const paused = admit(req, policy({ paused: true }), exposure, DUST, VTXO_MIN);
    expect(paused).toEqual({ ok: false, reason: "paused" });
});
