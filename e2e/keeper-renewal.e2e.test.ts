import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";
import { expect } from "vitest";
import {
    isVtxoSpent,
    Transaction,
    type ExtendedVirtualCoin,
    type VirtualCoin,
} from "@arkade-os/sdk";
import { lockupSats } from "@arkade-taxi/covenant";
import { hex } from "@scure/base";
import { renewedCovenantSource, txidOf } from "../packages/app/src/arkade/recovery.js";
import { captureOwnedTaxiLogs, taxiLogArgs } from "../scripts/lib/harness.mjs";
import { settleWithin } from "../scripts/e2e-settle.mjs";
import { createActorWallets, disposeActorWallets } from "../scripts/e2e-wallets.mjs";
import { liveScenario } from "./scenarios.js";
import {
    admin,
    artifactPath,
    expectReceipt,
    lock,
    openLive,
    poll,
    quoteFor,
    recycleWith,
    required,
    sizedSender,
    transaction,
    walletBalance,
    type Live,
} from "./fixtures.js";

/**
 * The keeper only renews into a batch the SDK accepts, at least 6000 s on regtest, and the
 * Taxi lends only on coins that outlive its renewal threshold by 12 h, so the stack keeps its
 * two-day tree. One batch minted on a short tree hands the sender a coin whose expiry the
 * covenant inherits, and the keeper renews that covenant into an ordinary batch.
 */
const SHORT_TREE = "1024";
const SDK_REGTEST_FLOOR = 6000n;
const FRESH_WAIT_MS = 90_000;
const PAYMENT_SATS = 329n;

const docker = (args: string[]) => {
    const result = spawnSync("docker", args, { encoding: "utf8", maxBuffer: 64 << 20 });
    if (result.status !== 0) throw new Error(`docker ${args[0]} failed: ${result.stderr}`);
    return { stdout: result.stdout, stderr: result.stderr };
};

/** What the run's own Taxi container logged about one advance's renewals. */
const keeperLog = async (advanceId: string) => {
    const project = required("TAXI_E2E_PROJECT");
    const logs: string = await captureOwnedTaxiLogs({
        container: `${project}-taxi`,
        project,
        inspect: async (name: string) =>
            docker([
                "inspect",
                "--format",
                '{{index .Config.Labels "dev.arkade-taxi.e2e-project"}}',
                name,
            ]).stdout,
        readLogs: async (name: string) => docker(taxiLogArgs(name)),
    });
    const entries = logs.split("\n").flatMap((line) => {
        try {
            return [JSON.parse(line.slice(line.indexOf("{")))];
        } catch {
            return [];
        }
    });
    const of = (msg: string) => entries.filter((e) => e.msg === msg && e.advanceId === advanceId);
    return { renewed: of("covenant renewed"), failed: of("covenant renewal failed") };
};

const treeExpiry = async (update?: string): Promise<string> => {
    const response = await fetch(
        `${required("TAXI_E2E_ARKD_ADMIN_URL")}/v1/admin/settings`,
        update === undefined
            ? undefined
            : {
                  method: "POST",
                  headers: { "content-type": "application/json" },
                  body: JSON.stringify({ settings: { vtxoTreeExpiry: update } }),
              },
    );
    const body = await response.json().catch(() => null);
    if (!response.ok)
        throw new Error(`arkd settings: HTTP ${response.status} ${JSON.stringify(body)}`);
    return update ?? String(body?.settings?.vtxoTreeExpiry ?? body?.settings?.vtxo_tree_expiry);
};

const lifeOf = (coin: VirtualCoin) => {
    const createdAt = BigInt(Math.floor(coin.createdAt.getTime() / 1000));
    const expiresAt = BigInt(coin.expiresAt!.getTime() / 1000);
    // renewalDue's own arithmetic: due once the expiry is half the coin's life away.
    return { createdAt, expiresAt, dueAt: expiresAt - (expiresAt - createdAt) / 2n };
};

const coinAt = async (live: Live, outpoint: { txid: string; vout: number }) =>
    (await live.indexer.getVtxos({ outpoints: [outpoint] })).vtxos[0]!;

async function settleOnShortTree(
    live: Live,
    coin: ExtendedVirtualCoin,
    evidence: Record<string, any>,
) {
    const original = await treeExpiry();
    expect(original).toMatch(/^\d+$/);
    const seed = JSON.parse(readFileSync(required("TAXI_E2E_SECRET_FILE"), "utf8")).sender;
    const attempts: Record<string, unknown>[] = [];
    evidence.shortBatches = attempts;
    let short: Record<string, any> | undefined;
    let minted: ExtendedVirtualCoin | undefined;
    try {
        await treeExpiry(SHORT_TREE);
        expect(await treeExpiry()).toBe(SHORT_TREE);
        // Created on the short tree: a wallet pins any tree arkd advertises when it is made.
        short = await createActorWallets(
            { sender: seed },
            {
                arkdUrl: required("TAXI_E2E_ARKD_URL"),
                esploraUrl: required("ARKADE_ESPLORA_URL"),
                minBatchExpirySeconds: 512n,
            },
        );
        const { wallet } = short!.sender;
        const address = await wallet.getAddress();
        let input: ExtendedVirtualCoin = (await poll(
            "the short-tree wallet sees the sender coin",
            async () =>
                (await wallet.getSpendableVtxos()).find(
                    (c: ExtendedVirtualCoin) => c.txid === coin.txid && c.vout === coin.vout,
                ),
            (found) => found !== undefined,
        ))!;
        // arkd fixes a round's tree when its registration opens, so a settlement can land in a
        // round opened before the switch; the round after that settlement cannot have been.
        for (let attempt = 1; attempt <= 3 && !minted; attempt++) {
            const commitment: string = await settleWithin(
                wallet,
                { inputs: [input], outputs: [{ address, amount: BigInt(coin.value) }] },
                120_000,
                `short-tree attempt ${attempt}`,
            );
            const next: ExtendedVirtualCoin = (await poll(
                `the coin settlement ${commitment} minted`,
                async () =>
                    (await wallet.getSpendableVtxos()).find((c: ExtendedVirtualCoin) =>
                        c.commitmentTxIds?.includes(commitment),
                    ),
                (found) => found?.expiresAt !== undefined,
            ))!;
            const life = lifeOf(next);
            attempts.push({ commitment, txid: next.txid, vout: next.vout, ...life });
            if (life.expiresAt - life.createdAt < SDK_REGTEST_FLOOR) minted = next;
            else input = next;
        }
    } finally {
        await treeExpiry(original);
        if (short) await disposeActorWallets(short);
    }
    evidence.tree = { original, short: SHORT_TREE, restored: await treeExpiry() };
    expect(evidence.tree.restored).toBe(original);
    expect(minted, "no settlement minted on the short tree; see shortBatches").toBeDefined();
    const own = (await poll(
        "the sender's own wallet sees the short-tree coin",
        async () =>
            (await live.actors.sender.wallet.getSpendableVtxos({ withRecoverable: false })).find(
                (c) => c.txid === minted!.txid && c.vout === minted!.vout,
            ),
        (found) => found !== undefined,
    ))!;
    evidence.senderCoin = { txid: own.txid, vout: own.vout, ...lifeOf(own) };
    return own;
}

liveScenario("covenant-keeper-renewal-claim", async () => {
    const live = await openLive();
    const evidence: Record<string, any> = { project: required("TAXI_E2E_PROJECT") };
    try {
        const alice = live.actors.sender;
        const bob = live.actors.receiverSats;
        const assetId = live.fixture.asset.assetId;
        const bobAddress = await bob.wallet.getAddress();
        const bobFunding = await alice.wallet.send({ address: bobAddress, amount: 1000 });
        const bobCoin = await poll(
            "Bob's spendable coin",
            () => bob.wallet.getSpendableVtxos({ withRecoverable: false }),
            (coins) => coins.some((c) => c.txid === bobFunding && c.value === 1000),
        ).then((coins) => coins.find((c) => c.txid === bobFunding)!);
        const sized = await sizedSender(live);
        const [aliceBefore, bobBefore, taxiBefore] = await Promise.all([
            walletBalance(alice, assetId),
            walletBalance(bob, assetId),
            walletBalance(live.actors.operator, assetId),
        ]);
        const aliceCoin = await settleOnShortTree(live, sized, evidence);

        const locked = await lock(
            live,
            await quoteFor(live, "receiverSats", aliceCoin, false, false, "recycle"),
        );
        const id = locked.quote.transferId;
        const outpoint = locked.lockup.outpoint;
        Object.assign(evidence, { transferId: id, lockup: outpoint, lockedAt: Date.now() });
        expect(
            await poll(
                "Alice pays the 329 sats at lockup",
                () => walletBalance(alice, assetId),
                (balance) => balance.sats === aliceBefore.sats - PAYMENT_SATS,
            ),
        ).toEqual({ sats: aliceBefore.sats - PAYMENT_SATS, units: aliceBefore.units });

        // Bob verifies the claim now, so his claim later starts from the coin the renewal takes.
        const claim = await poll(
            "claim feed serves the locked covenant",
            async () =>
                (await live.client.listClaims({ receiverAddresses: [bobAddress] })).claims.find(
                    (c) => c.transferId === id && c.state === "locked",
                ),
            (found) => found !== undefined,
        );
        const transfer = await live.client.verifyIncomingClaim(
            claim!,
            { receiverAddress: bobAddress, claimMode: "recycle" },
            {
                serverKey: hex.decode(live.info.serverKey),
                emulatorKey: hex.decode(live.info.emulatorKey),
                operatorKey: hex.decode(live.info.operatorKey),
                vtxoMinAmount: BigInt(live.info.vtxoMinAmount),
                hrp: "tark",
            },
            live.config,
        );
        expect(transfer.outpoint).toEqual(outpoint);

        const covenantCoin = await coinAt(live, outpoint);
        const covenant = lifeOf(covenantCoin);
        evidence.covenant = covenant;
        expect(covenant.expiresAt).toBe(evidence.senderCoin.expiresAt);
        await sleep(Math.max(0, Number(covenant.dueAt * 1000n - 15_000n) - Date.now()));
        const moved = await poll(
            "the keeper renews the covenant and the watcher adopts its successor",
            () => live.client.status(id),
            (s) => s.state === "locked" && s.outpoint?.txid !== outpoint.txid,
            300_000,
        );
        const successorOutpoint = moved.outpoint!;
        const first = await poll(
            "the Taxi logs the renewal",
            async () => {
                await sleep(1_000);
                return keeperLog(id);
            },
            (log) => log.renewed.length > 0,
            60_000,
        );
        Object.assign(evidence, { successor: successorOutpoint, renewals: first });
        expect(first.renewed).toHaveLength(1);
        expect(first.renewed[0].time, "renewed before half its life").toBeGreaterThanOrEqual(
            Number((covenant.dueAt - 2n) * 1000n),
        );

        const successorCoin = await coinAt(live, successorOutpoint);
        const successor = lifeOf(successorCoin);
        evidence.successorLife = successor;
        expect(successorCoin.script).toBe(covenantCoin.script);
        expect(BigInt(successorCoin.value)).toBe(lockupSats(locked.verified.params));
        expect(isVtxoSpent(successorCoin)).toBe(false);
        expect(successor.expiresAt - successor.createdAt).toBeGreaterThanOrEqual(SDK_REGTEST_FLOOR);
        expect(successor.dueAt * 1000n).toBeGreaterThan(BigInt(Date.now() + FRESH_WAIT_MS));
        // The default three-day window outlasts the restored tree: without the half-life cap the
        // successor is due at once and renews again within a session.
        await sleep(FRESH_WAIT_MS);
        const fresh = await keeperLog(id);
        evidence.renewalsAfterFreshWait = fresh;
        expect(fresh.renewed, "must not renew again while the successor is fresh").toHaveLength(1);
        const settledStatus = await live.client.status(id);
        evidence.statusBeforeClaim = settledStatus;
        expect(settledStatus.outpoint).toEqual(successorOutpoint);
        expect(
            settledStatus.failureCode,
            "the watcher flagged the renewed covenant",
        ).toBeUndefined();
        expect((await admin("status")).paused, "the watcher paused the Taxi").toBe(false);
        // Asserted after the claim, so a feed the renewal broke still leaves the claim evidence.
        const feed = await live.client.listClaims({ receiverAddresses: [bobAddress] }).then(
            ({ claims }) => claims.find((c) => c.transferId === id),
            (error: unknown) => ({ error: String(error) }),
        );
        evidence.feedAfterRenewal = feed;
        // Recovery's own lookup of the coin it would reclaim, made once before the claim spends it.
        const source = await renewedCovenantSource(successorOutpoint, live.indexer)
            .then((raw) => {
                const output = Transaction.fromRaw(raw).getOutput(successorOutpoint.vout);
                return {
                    txid: txidOf(raw),
                    amount: output.amount,
                    script: output.script && hex.encode(output.script),
                    raw: hex.encode(raw),
                };
            })
            .catch((error: unknown) => ({ error: String(error) }));
        evidence.successorSource = source;

        const txid = await recycleWith(live, transfer, bobCoin, locked.destination).catch(
            (error: Error) => {
                evidence.claimError = { message: error.message, cause: String(error.cause) };
                throw error;
            },
        );
        evidence.recycleTxid = txid;
        const done = await poll(
            "Bob's recycle settles",
            () => live.client.status(id),
            (s) => s.state === "recycled",
        );
        expect(done.spentTxid).toBe(txid);
        const tx = await transaction(live, txid);
        const checkpoint = await transaction(live, hex.encode(tx.getInput(0).txid!));
        const spent = checkpoint.getInput(0);
        expect({ txid: hex.encode(spent.txid!), vout: spent.index }).toEqual(successorOutpoint);
        expect(tx.inputsLength).toBe(2);
        expectReceipt(tx, 0, 330n, live.info.operatorKey);

        const [bobAfter, taxiAfter] = await Promise.all([
            poll(
                "Bob receives the 329-sat payment",
                () => walletBalance(bob, assetId),
                (balance) => balance.sats === bobBefore.sats + PAYMENT_SATS,
            ),
            poll(
                "Taxi's whole-dust loan is repaid",
                () => walletBalance(live.actors.operator, assetId),
                (balance) => balance.sats === taxiBefore.sats && balance.units === taxiBefore.units,
            ),
        ]);
        evidence.balances = { aliceBefore, bobBefore, taxiBefore, bobAfter, taxiAfter };
        expect(bobAfter).toEqual({ sats: bobBefore.sats + PAYMENT_SATS, units: bobBefore.units });
        expect(taxiAfter).toEqual(taxiBefore);
        expect(feed, "claim feed after the renewal").toMatchObject({
            state: "locked",
            claim: { outpoint: successorOutpoint },
        });
        expect(source, "the indexer serves the successor's creating transaction").toEqual({
            txid: successorOutpoint.txid,
            amount: lockupSats(locked.verified.params),
            script: covenantCoin.script,
            raw: expect.any(String),
        });
    } finally {
        writeFileSync(
            artifactPath("keeper-renewal.json"),
            `${JSON.stringify(evidence, (_, v) => (typeof v === "bigint" ? `${v}` : v), 2)}\n`,
        );
        await live.close();
    }
});
