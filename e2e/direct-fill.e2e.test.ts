import { expect } from "vitest";
import { Extension } from "@arkade-os/sdk";
import { hex } from "@scure/base";
import { ownCleanup } from "../scripts/lib/scenario-cleanup.mjs";
import { liveScenario } from "./scenarios";
import {
    cleanupDirectFill,
    directCounters,
    directEvidence,
    postDirectFill,
    prepareDirectFill,
    recycleDirectFill,
    settledDirectFill,
} from "./directFillSupport";

liveScenario("receiver-paid-direct-fill-claim", async () => {
    const prepared = await prepareDirectFill();
    const cleanup = ownCleanup(() => cleanupDirectFill(prepared));
    try {
        const { graph, live } = prepared;
        expect(Extension.fromTx(graph.arkTx).getPackets()).toHaveLength(1);
        expect(Extension.fromTx(graph.arkTx).getEmulatorPacket()).toBeNull();
        for (const index of graph.taxiInputIndexes)
            expect(graph.arkTx.getInput(index).tapScriptSig ?? []).toEqual([]);
        for (const index of graph.callerInputIndexes)
            expect(graph.arkTx.getInput(index).tapScriptSig).toHaveLength(1);
        const before = await directCounters();
        const submitted = await postDirectFill(prepared);
        expect(submitted).toMatchObject({ state: "submitting", txid: graph.arkTx.id });
        const settled = await settledDirectFill(prepared);
        const after = await directCounters();
        expect(after.submit - before.submit).toBe(1);
        expect(after.finalize - before.finalize).toBe(1);
        expect(after.emulator - before.emulator).toBe(0);
        const callerKey = hex.encode(await prepared.caller.identity.xOnlyPublicKey());
        const taxiKey = hex.encode(await live.actors.operator.identity.xOnlyPublicKey());
        for (const input of settled.signatures)
            expect(input.keys).toEqual(
                [input.owner === "taxi" ? taxiKey : callerKey, live.info.serverKey].sort(),
            );
        const money = await recycleDirectFill(prepared);
        directEvidence("receiver-paid-direct-fill-claim", {
            quoteId: prepared.quote.quoteId,
            fillId: submitted.fillId,
            txid: graph.arkTx.id,
            taxiInputIndexes: graph.taxiInputIndexes,
            signatures: settled.signatures,
            fillCounters: { before, after },
            ...money,
        });
    } finally {
        await cleanup();
    }
});
