/**
 * The single register of what this suite claims to cover.
 *
 * A scenario is either `logic` — it runs today, against the packages alone — or
 * `stack`, meaning it needs arkd, the emulator and a transaction-building layer
 * that does not exist yet. A `stack` scenario is registered as a skip whose
 * reason is in its own name, and whose body throws: un-skipping it without
 * implementing it produces a failure, never a pass.
 */

import { it } from "vitest";

export type ScenarioScope = "logic" | "stack";

export interface Scenario {
    id: string;
    title: string;
    scope: ScenarioScope;
    /** Why a `stack` scenario cannot run. Empty for a `logic` one. */
    blocked: string;
}

const NO_TX_LAYER =
    "the service's transaction-building layer is unimplemented — it exists only as " +
    "injectable interfaces, so no lockup PSBT can be assembled and no covenant output exists to spend";

export const SCENARIOS: readonly Scenario[] = [
    {
        id: "asset-recycle-receiver-holds-asset",
        title: "asset transfer, receiver already holds a balance of the same asset, claims via recycle",
        scope: "stack",
        blocked: `${NO_TX_LAYER}; also needs a regtest asset minted to the receiver so in[1] carries a non-zero balance of it`,
    },
    {
        id: "asset-recycle-receiver-holds-no-asset",
        title: "asset transfer, receiver holds a VTXO but zero of the asset, claims via recycle",
        scope: "stack",
        blocked: `${NO_TX_LAYER}; also needs a receiver funded with a bare sats VTXO — recycle pins numInputs == 2, so in[1] must exist while its asset lookup stays the only absent one`,
    },
    {
        id: "purchase-receiver-holds-no-vtxo",
        title: "purchase claim by a receiver holding no VTXO at all",
        scope: "stack",
        blocked: `${NO_TX_LAYER}; purchase reads only in[0], so what must be observed is a single-input spend accepted by a real emulator, which no stub can stand in for`,
    },
    {
        id: "subdust-bitcoin-recycle",
        title: "sub-dust bitcoin transfer, receiver claims via recycle",
        scope: "stack",
        blocked: `${NO_TX_LAYER}; also needs arkd started with vtxoMinAmount < dust, since a default-configured service closes the sub-dust window entirely`,
    },
    {
        id: "sender-refund-before-locktime",
        title: "sender refunds before locktime",
        scope: "stack",
        blocked: `${NO_TX_LAYER}; refundSender is the one leaf needing the sender's own signature alongside the Arkade Service and emulator, and no sender signing path exists`,
    },
    {
        id: "sweeper-recovery-after-locktime",
        title: "sweeper recovers the advance through the timelocked leaf after locktime",
        scope: "stack",
        blocked: `${NO_TX_LAYER}, and the sweeper itself is unimplemented; crossing locktime deterministically also needs AUTOMINE_INTERVAL=0 and explicit mining`,
    },
    {
        id: "premature-recovery-rejected",
        title: "recovery attempted before locktime is rejected by the CLTV closure, not by the covenant",
        scope: "stack",
        blocked: `${NO_TX_LAYER}; and this must assert the script error code rather than merely that the spend failed — a rejection firing for the wrong reason is exactly what it exists to catch`,
    },
    {
        id: "exposure-cap-rejects-quote",
        title: "exposure cap rejects a quote (admission logic only, not the HTTP surface)",
        scope: "logic",
        blocked: "",
    },
    {
        id: "verify-quote-rejects-tampered-params",
        title: "verifyQuote rejects a tampered parameter set (client logic only, not a live operator)",
        scope: "logic",
        blocked: "",
    },
];

/**
 * Asserted by `suite-integrity.e2e.test.ts` against what the test files actually
 * register. Moving a scenario off `stack` has to be a deliberate edit here.
 */
export const EXPECTED_STACK_SCENARIOS = 7;
export const EXPECTED_LIVE_SCENARIOS = 2;

const byId = (id: string): Scenario => {
    const found = SCENARIOS.find((s) => s.id === id);
    if (!found) throw new Error(`e2e: "${id}" is not in SCENARIOS`);
    return found;
};

export function stackScenario(id: string): void {
    const s = byId(id);
    if (s.scope !== "stack") {
        throw new Error(`e2e: ${id} is scope "${s.scope}"; use liveScenario`);
    }
    if (s.blocked.trim() === "") {
        throw new Error(`e2e: ${id} is skipped and must say why`);
    }
    it.skip(`${s.title} — SKIPPED: ${s.blocked}`, () => {
        throw new Error(`e2e: ${s.id} has no implementation — ${s.blocked}`);
    });
}

export function liveScenario(id: string, fn: () => void | Promise<void>): void {
    const s = byId(id);
    if (s.scope !== "logic") {
        throw new Error(`e2e: ${id} is scope "${s.scope}"; use stackScenario`);
    }
    if (s.blocked !== "") {
        throw new Error(`e2e: ${id} runs, so it must not carry a blocked reason`);
    }
    it(s.title, fn);
}
