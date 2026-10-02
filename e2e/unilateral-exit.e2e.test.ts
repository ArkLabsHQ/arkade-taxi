import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { expect } from "vitest";
import {
    OnchainWallet,
    Transaction,
    UnilateralExit,
    contractHandlers,
    timelockToSequence,
} from "@arkade-os/sdk";
import { hex } from "@scure/base";
import { DustCovenantScript, Leaf, covenantSpendInput } from "../packages/covenant/src/index.js";
import { mineBlocks } from "../scripts/e2e-mine.mjs";
import { setOwnedServices } from "../scripts/lib/cltv-evidence.mjs";
import { liveScenario } from "./scenarios.js";
import {
    admin,
    artifactPath,
    health,
    lock,
    openLive,
    poll,
    quoteFor,
    required,
    sizedSender,
} from "./fixtures.js";

const COVENANT = "taxi-dust-covenant";
const SERVICES = ["arkd", "emulator"];

const post = async (path: string) => {
    const response = await fetch(`${required("TAXI_E2E_ADMIN_URL")}/admin/api/${path}`, {
        method: "POST",
        body: "{}",
        headers: { "content-type": "application/json", "x-taxi-operator": "task13-e2e" },
    });
    return { status: response.status, body: await response.json() };
};

liveScenario("covenant-unilateral-exit-with-arkd-down", async () => {
    const live = await openLive();
    const project = required("TAXI_E2E_PROJECT");
    const cli = required("ARKADE_REGTEST_CLI");
    const rpc = (...args: string[]) =>
        execFileSync(process.execPath, [cli, "rpc", ...args], {
            encoding: "utf8",
            timeout: 60_000,
        }).trim();
    const evidence: Record<string, unknown> = {};
    const paused = new Set<string>();
    try {
        // The recovery leaf must still be locked once the exit delay matures.
        await admin("policy", { locktimeMarginSeconds: 64_800 });
        const locked = await lock(
            live,
            await quoteFor(live, "receiverSats", await sizedSender(live)),
        );
        const outpoint = locked.lockup.outpoint;
        const { params } = locked.verified;
        expect(params.exitDelay.type).toBe("seconds");
        const dust = BigInt(live.info.dust);
        const serverKey = hex.decode(live.info.serverKey);
        const covenant = new DustCovenantScript({
            serverKey,
            emulatorKey: hex.decode(live.info.emulatorKey),
            vtxoMinAmount: BigInt(live.info.vtxoMinAmount),
            params,
        });
        const exitLeaf = covenantSpendInput(covenant, Leaf.Exit, outpoint, dust).tapLeafScript;
        const sequence = timelockToSequence(params.exitDelay);
        Object.assign(evidence, { outpoint, exitDelay: params.exitDelay.value });

        const operator = live.actors.operator;
        contractHandlers.register({
            type: COVENANT,
            createScript: () => covenant,
            serializeParams: () => ({}),
            deserializeParams: () => ({}),
            selectPath: () => null,
            getAllSpendingPaths: () => [{ leaf: exitLeaf, sequence }],
            getSpendablePaths: () => [],
        });
        await operator.wallet.getContractManager();
        await operator.wallet.contractRepository.saveContract({
            type: COVENANT,
            params: {},
            script: hex.encode(covenant.pkScript),
            address: covenant.address("tark", serverKey).encode(),
            state: "active",
            createdAt: Date.now(),
        });
        // The package will not sweep a VTXO under 546 sats, so the lockup's operator change
        // carries the branch the covenant shares with it.
        const { vtxos } = await live.indexer.getVtxos({
            scripts: [`5120${live.info.operatorKey}`],
        });
        const change = vtxos.find((coin) => coin.txid === outpoint.txid);
        expect(change).toBeDefined();
        const onchain = await OnchainWallet.create(
            operator.identity,
            "regtest",
            operator.wallet.onchainProvider,
        );
        execFileSync(process.execPath, [cli, "faucet", onchain.address, "0.01", "--confirm"], {
            stdio: "pipe",
            timeout: 60_000,
        });
        await poll(
            "confirmed exit funding indexed",
            () => onchain.getCoins(),
            (coins) => coins.some((coin) => coin.status.confirmed),
        );
        const pkg = await UnilateralExit.prepare({
            wallet: operator.wallet,
            onchainWallet: onchain,
            sweepAddress: onchain.address,
            vtxos: [outpoint, change!],
            feeRate: 2,
        });
        evidence.package = {
            vtxos: pkg.vtxos,
            totals: pkg.totals,
            steps: pkg.steps.map((s) => `${s.kind} ${"parentTxid" in s ? s.parentTxid : s.txid}`),
        };
        expect(pkg.vtxos).toContainEqual(
            expect.objectContaining({
                outpoint: `${outpoint.txid}:${outpoint.vout}`,
                skipped: expect.stringMatching(/uneconomic/),
            }),
        );
        expect(pkg.steps).toContainEqual(
            expect.objectContaining({ kind: "package", parentTxid: outpoint.txid }),
        );

        for (const service of SERVICES) {
            paused.add(service);
            setOwnedServices(project, [service], "pause");
        }
        // A paused service never answers, so a bounded read stands in for a refused one.
        for (const url of [required("TAXI_E2E_ARKD_URL"), required("TAXI_E2E_EMULATOR_URL")])
            await expect(
                fetch(`${url}/v1/info`, { signal: AbortSignal.timeout(5_000) }),
            ).rejects.toThrow();

        // prepare() broadcast the splitter; an executor that cannot see it yet re-sends it.
        const splitter = pkg.steps.find((step) => step.kind === "broadcast")!;
        await mineBlocks(1);
        await poll(
            "exit splitter confirmed",
            () => onchain.provider.getTxStatus(splitter.txid).catch(() => ({ confirmed: false })),
            (status) => status.confirmed,
        );
        const events: string[] = [];
        evidence.executor = events;
        let branch = pkg.steps.filter((step) => step.kind === "package").length;
        for await (const event of new UnilateralExit.Executor(pkg, onchain.provider, {
            pollIntervalMs: 1_000,
        })) {
            events.push(`${event.kind} ${event.status} ${event.txid ?? ""}`);
            expect(event.status, event.reason).not.toBe("failed");
            if (event.status === "broadcast") await mineBlocks(1);
            else if (event.kind === "package" && --branch === 0) break;
        }
        const utxo = rpc("gettxout", outpoint.txid, String(outpoint.vout));
        expect(JSON.parse(utxo || "null")?.scriptPubKey.hex).toBe(hex.encode(covenant.pkScript));
        // Unrolled, the covenant has no off-chain refund or recovery left to unwind.
        live.owned.delete(locked.quote.transferId);

        const fee = (await onchain.getCoins()).find(
            (coin) => coin.status.confirmed && coin.value > 100_000,
        );
        expect(fee).toBeDefined();
        const exit = new Transaction({ version: 2 });
        exit.addInput({
            txid: outpoint.txid,
            index: outpoint.vout,
            sequence,
            witnessUtxo: { script: covenant.pkScript, amount: dust },
            tapLeafScript: [exitLeaf],
        });
        exit.addInput({
            txid: fee!.txid,
            index: fee!.vout,
            witnessUtxo: { script: onchain.onchainP2TR.script, amount: BigInt(fee!.value) },
            tapInternalKey: onchain.onchainP2TR.tapInternalKey,
        });
        exit.addOutput({
            script: onchain.onchainP2TR.script,
            amount: dust + BigInt(fee!.value) - 1_000n,
        });
        const signed = await operator.identity.sign(await live.actors.sender.identity.sign(exit));
        signed.finalize();
        expect(signed.getInput(0).finalScriptWitness).toHaveLength(4);
        const raw = hex.encode(signed.extract());
        expect(JSON.parse(rpc("testmempoolaccept", JSON.stringify([raw])))[0]).toMatchObject({
            allowed: false,
            "reject-reason": "non-BIP68-final",
        });

        const confirmedAt = BigInt(JSON.parse(rpc("getblockchaininfo")).mediantime);
        rpc("setmocktime", String(confirmedAt + params.exitDelay.value + 1200n));
        await mineBlocks(12);
        const exitTxid = rpc("sendrawtransaction", raw);
        await mineBlocks(1);
        const { confirmations } = JSON.parse(rpc("getrawtransaction", exitTxid, "true"));
        Object.assign(evidence, { confirmedAt, exitTxid, confirmations });
        expect(confirmations).toBeGreaterThan(0);

        for (const service of SERVICES) {
            setOwnedServices(project, [service], "unpause");
            paused.delete(service);
        }
        const resumedAt = Math.floor(Date.now() / 1000);
        const flagged = await poll(
            "unrolled covenant alerted by a scan after the resume",
            async () => ({
                scannedAt: (await health()).reconciler.lastWatcherScanAt,
                advance: (await admin("advances")).advances.find(
                    (a: any) => a.id === locked.quote.transferId,
                ),
            }),
            ({ scannedAt, advance }) =>
                scannedAt > resumedAt && advance?.failureCode === "covenant_unrolled",
            180_000,
        );
        Object.assign(evidence, { resumedAt, scannedAt: flagged.scannedAt });
        expect(flagged.advance.failureCode).toBe("covenant_unrolled");
        // A day-ahead chain clock leaves the operator's coins short of expiry headroom.
        const lasting = ["manual_pause", "vtxo_expiry_headroom", "operator_reserve_low"];
        const recovered = await poll(
            "outage blockers cleared",
            health,
            (body) => body.blockers.every((code: string) => lasting.includes(code)),
            120_000,
        );
        const resumed = await post("resume");
        Object.assign(evidence, { lastingBlockers: recovered.blockers, resume: resumed });
        expect([200, 409]).toContain(resumed.status);
        expect(resumed.body.blockers ?? []).not.toContain("covenant_unrolled");
        // An arkd outage past the 30 s provider read may pause the Taxi on its own.
        await admin("policy", { paused: false });
        expect((await post("rescan")).status).toBe(202);
        const status = await admin("status");
        const blockers = (await health()).blockers;
        evidence.policyHistory = (await admin("policy/history")).history;
        expect(status.paused).toBe(false);
        expect(status.warnings).toContainEqual(
            expect.objectContaining({
                advanceId: locked.quote.transferId,
                code: "covenant_unrolled",
            }),
        );
        expect(blockers).not.toContain("covenant_unrolled");
    } finally {
        // Best effort: a failure here must not mask the scenario's own error.
        for (const service of paused)
            try {
                setOwnedServices(project, [service], "unpause");
            } catch (error) {
                evidence[`unpause ${service}`] = String(error);
            }
        contractHandlers.unregister(COVENANT);
        writeFileSync(
            artifactPath("unilateral-exit.json"),
            `${JSON.stringify(evidence, (_, v) => (typeof v === "bigint" ? `${v}` : v), 2)}\n`,
        );
        await live.close();
    }
});
