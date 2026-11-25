import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";
import { expect } from "vitest";
import { isVtxoSpent, type ExtendedVirtualCoin, type VirtualCoin } from "@arkade-os/sdk";
import { lockupSats } from "@arkade-taxi/covenant";
import { hex } from "@scure/base";
import { captureOwnedTaxiLogs, taxiLogArgs } from "../scripts/lib/harness.mjs";
import { settleSelectedFunding } from "../scripts/e2e-settle.mjs";
import { createActorWallets, disposeActorWallets } from "../scripts/e2e-wallets.mjs";
import { liveScenario } from "./scenarios.js";
import {
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
    let short: Record<string, any> | undefined;
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
        const input = await poll(
            "the short-tree wallet sees the sender coin",
            async () =>
                (await wallet.getSpendableVtxos()).find(
                    (c: ExtendedVirtualCoin) => c.txid === coin.txid && c.vout === coin.vout,
                ),
            (found) => found !== undefined,
        );
        evidence.shortBatch = await settleSelectedFunding(wallet, {
            input,
            outputAmount: BigInt(coin.value),
            label: "short-tree sender",
        });
    } finally {
        await treeExpiry(original);
        if (short) await disposeActorWallets(short);
    }
    evidence.tree = { original, short: SHORT_TREE, restored: await treeExpiry() };
    expect(evidence.tree.restored).toBe(original);
    const minted = await poll(
        "the sender's coin from the short-tree batch",
        async () =>
            (await live.actors.sender.wallet.getSpendableVtxos({ withRecoverable: false })).filter(
                (c) =>
                    c.value === coin.value &&
                    !c.assets?.length &&
                    c.isPreconfirmed === false &&
                    c.expiresAt !== undefined &&
                    lifeOf(c).expiresAt - lifeOf(c).createdAt < SDK_REGTEST_FLOOR,
            ),
        (coins) => coins.length === 1,
    ).then((coins) => coins[0]!);
    evidence.senderCoin = { txid: minted.txid, vout: minted.vout, ...lifeOf(minted) };
    return minted;
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
        await sleep(Math.max(0, Number(covenant.dueAt) * 1000 - Date.now() - 15_000));
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
            (Number(covenant.dueAt) - 2) * 1000,
        );

        const successorCoin = await coinAt(live, successorOutpoint);
        const successor = lifeOf(successorCoin);
        evidence.successorLife = successor;
        expect(successorCoin.script).toBe(covenantCoin.script);
        expect(BigInt(successorCoin.value)).toBe(lockupSats(locked.verified.params));
        expect(isVtxoSpent(successorCoin)).toBe(false);
        expect(successor.expiresAt - successor.createdAt).toBeGreaterThanOrEqual(SDK_REGTEST_FLOOR);
        expect(Number(successor.dueAt) * 1000).toBeGreaterThan(Date.now() + FRESH_WAIT_MS);
        // The default three-day window outlasts the restored tree: without the half-life cap the
        // successor is due at once and renews again within a session.
        await sleep(FRESH_WAIT_MS);
        const fresh = await keeperLog(id);
        evidence.renewalsAfterFreshWait = fresh;
        expect(fresh.renewed, "renewed again while the successor is fresh").toHaveLength(1);
        expect((await live.client.status(id)).outpoint).toEqual(successorOutpoint);
        // Asserted after the claim, so a feed the renewal broke still leaves the claim evidence.
        const feed = await live.client.listClaims({ receiverAddresses: [bobAddress] }).then(
            ({ claims }) => claims.find((c) => c.transferId === id),
            (error: unknown) => ({ error: String(error) }),
        );
        evidence.feedAfterRenewal = feed;

        const txid = await recycleWith(live, transfer, bobCoin, locked.destination);
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
    } finally {
        writeFileSync(
            artifactPath("keeper-renewal.json"),
            `${JSON.stringify(evidence, (_, v) => (typeof v === "bigint" ? `${v}` : v), 2)}\n`,
        );
        await live.close();
    }
});
