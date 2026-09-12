import { execFileSync } from "node:child_process";
import {
    existsSync,
    mkdirSync,
    mkdtempSync,
    readFileSync,
    realpathSync,
    rmSync,
    symlinkSync,
    writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReceiverWalletInput } from "../src/index.js";
import * as sdk from "@arkade-os/sdk";
import * as client from "../src/index.js";
import { bytesToHex } from "@arkade-taxi/protocol";
import { fundingInputs, senderIdentity, senderTree, serverKey } from "./fixtures.js";
const { packageManagerInvocation } = (await import(
    new URL("../../../scripts/lib/harness.mjs", import.meta.url).href
)) as { packageManagerInvocation(args: string[]): { command: string; args: string[] } };

const integrationGuide = readFileSync(
    new URL("../../../docs/integration-js.md", import.meta.url),
    "utf8",
);
const examples = [
    ...integrationGuide.matchAll(/^```(?:ts|typescript)\s*\r?\n([\s\S]*?)^```\s*$/gm),
].map((match) => match[1]);

describe("JavaScript integration guide", () => {
    it("typechecks every TypeScript example against packed public exports", () => {
        expect(examples.length).toBeGreaterThanOrEqual(2);
        const root = mkdtempSync(join(tmpdir(), "taxi-integration-docs-"));
        const repo = fileURLToPath(new URL("../../../", import.meta.url));
        try {
            const packages = join(root, "node_modules", "@arkade-taxi");
            mkdirSync(packages, { recursive: true });
            for (const name of ["protocol", "covenant", "client"]) {
                const cwd = join(repo, "packages", name);
                const build = packageManagerInvocation(["build"]);
                execFileSync(build.command, build.args, { cwd, timeout: 30_000, stdio: "pipe" });
                const pack = packageManagerInvocation([
                    "pack",
                    "--pack-destination",
                    root,
                    "--json",
                ]);
                const archive = JSON.parse(
                    execFileSync(pack.command, pack.args, {
                        cwd,
                        timeout: 20_000,
                        encoding: "utf8",
                    }),
                ).filename;
                expect(resolve(archive).startsWith(resolve(root) + sep)).toBe(true);
                const target = join(packages, name);
                mkdirSync(target);
                execFileSync("tar", ["-xzf", archive, "-C", target, "--strip-components=1"], {
                    timeout: 10_000,
                });
                if (existsSync(join(cwd, "node_modules")))
                    symlinkSync(
                        realpathSync(join(cwd, "node_modules")),
                        join(target, "node_modules"),
                        "junction",
                    );
            }
            mkdirSync(join(root, "node_modules", "@arkade-os"));
            symlinkSync(
                realpathSync(join(repo, "node_modules", "@arkade-os", "sdk")),
                join(root, "node_modules", "@arkade-os", "sdk"),
                "junction",
            );
            writeFileSync(join(root, "package.json"), JSON.stringify({ type: "module" }));
            const files = examples.map((code, index) => {
                const name = /^\/\/ ([a-z-]+\.ts)\r?\n/.exec(code)?.[1] ?? `example-${index}.ts`;
                const file = join(root, name);
                writeFileSync(file, code);
                return file;
            });
            const program = ts.createProgram(files, {
                target: ts.ScriptTarget.ES2022,
                module: ts.ModuleKind.NodeNext,
                moduleResolution: ts.ModuleResolutionKind.NodeNext,
                strict: true,
                noEmit: true,
                skipLibCheck: true,
                types: [],
            });
            const diagnostics = ts.getPreEmitDiagnostics(program);
            expect(
                ts.formatDiagnosticsWithColorAndContext(diagnostics, {
                    getCanonicalFileName: (file) => file,
                    getCurrentDirectory: () => root,
                    getNewLine: () => "\n",
                }),
            ).toBe("");
        } finally {
            if (!resolve(root).startsWith(resolve(tmpdir()) + sep))
                throw new Error("unsafe temp path");
            rmSync(root, { recursive: true, force: true });
        }
    }, 60_000);

    it("uses sender composition and receiver events without polling examples", () => {
        expect(integrationGuide).toContain("requestVerifiedQuote");
        expect(integrationGuide).toContain("subscribeClaims");
        expect(integrationGuide).not.toMatch(
            /setInterval|setTimeout|\bwhile\s*\(|\/v1\/transfers\/:id/,
        );
    });

    it("derives sender funding and coordinates receiver reservations across ambiguous submissions", () => {
        expect(integrationGuide).not.toMatch(/senderSats\s*:/);
        expect(integrationGuide).toContain("reserveFunding");
        expect(integrationGuide).toContain("retainAmbiguous");
        expect(integrationGuide).toContain("observedSpend");
        expect(integrationGuide).toContain("failedBeforeSubmission");
        expect(integrationGuide).toContain("navigator.locks.request");
        expect(integrationGuide).toContain("localStorage.setItem");
        expect(integrationGuide).not.toMatch(/Promise\.all|claims\.map\(\s*async/);
    });

    it("states the ambient fetch trust boundary for covenant providers", () => {
        expect(integrationGuide).toMatch(/SDK REST providers use the realm's `globalThis\.fetch`/);
        expect(integrationGuide).toMatch(/`TaxiClient\(\{ fetch \}\)` does not configure/);
        expect(integrationGuide).toMatch(/same-realm code.*replace or\s+intercept.*global fetch/is);
        expect(integrationGuide).toMatch(/TLS.*reverse\s+proxy/is);
    });
});

interface Pending {
    transferId: string;
    expectedTxid?: string;
    fundingOutpoint?: { txid: string; vout: number };
}
interface ReceiverStore {
    claimOnce(id: string, operation: () => Promise<void>): Promise<void>;
    reserveFunding(
        id: string,
        candidates: readonly ReceiverWalletInput[],
    ): Promise<ReceiverWalletInput>;
    submitting(id: string): Promise<void>;
    submitted(id: string, txid: string): Promise<void>;
    retainAmbiguous(id: string, txid: string): Promise<void>;
    failedBeforeSubmission(id: string): Promise<void>;
    observedSpend(id: string, txid: string): Promise<void>;
    pending(): Promise<Pending[]>;
}

const loadReceiverStore = () => {
    const source = examples.find((code) => code.startsWith("// receiver-store.ts"));
    if (!source) throw new Error("Missing runnable durable receiver example");
    const output = ts.transpileModule(source, {
        compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    }).outputText;
    const exports: Record<string, unknown> = {};
    new Function("exports", output)(exports);
    return exports as {
        createReceiverStore(key: string): ReceiverStore;
        resumeReceiver(
            store: ReceiverStore,
            observe: (txid: string, funding?: Pending["fundingOutpoint"]) => Promise<void>,
        ): Promise<void>;
    };
};

describe("durable receiver documentation implementation", () => {
    let values: Map<string, string>;
    const candidate = (): ReceiverWalletInput => {
        const [{ expiry, spendLeaf, ...input }] = fundingInputs();
        return {
            input: { ...input, tapLeafScript: senderTree.leaves[0] },
            expiry,
            identity: senderIdentity,
        };
    };
    beforeEach(() => {
        values = new Map();
        const locks = new Map<string, Promise<unknown>>();
        vi.stubGlobal("localStorage", {
            getItem: (key: string) => values.get(key) ?? null,
            setItem: (key: string, value: string) => values.set(key, value),
        });
        vi.stubGlobal("navigator", {
            locks: {
                request: (name: string, update: () => unknown) => {
                    const result = (locks.get(name) ?? Promise.resolve()).then(update);
                    locks.set(
                        name,
                        result.catch(() => {}),
                    );
                    return result;
                },
            },
        });
    });
    afterEach(() => vi.unstubAllGlobals());

    it("deduplicates simultaneous tabs and reserves a coin for only one transfer", async () => {
        const { createReceiverStore } = loadReceiverStore();
        const one = createReceiverStore("wallet");
        const two = createReceiverStore("wallet");
        let attempts = 0;
        await Promise.all([
            one.claimOnce("same", async () => {
                attempts++;
            }),
            two.claimOnce("same", async () => {
                attempts++;
            }),
        ]);
        expect(attempts).toBe(1);
        const selected: ReceiverWalletInput[] = [];
        const results = await Promise.allSettled([
            one.claimOnce("a", async () => {
                selected.push(await one.reserveFunding("a", [candidate()]));
            }),
            two.claimOnce("b", async () => {
                selected.push(await two.reserveFunding("b", [candidate()]));
            }),
        ]);
        expect(results.map((result) => result.status).sort()).toEqual(["fulfilled", "rejected"]);
        expect(selected).toHaveLength(1);
        expect(
            (await createReceiverStore("wallet").pending()).filter((row) => row.fundingOutpoint),
        ).toHaveLength(1);
    });

    it("retains ambiguous reservations across reload and releases only after exact observation", async () => {
        const { createReceiverStore, resumeReceiver } = loadReceiverStore();
        const store = createReceiverStore("wallet");
        const funding = candidate();
        await store.claimOnce("a", async () => {
            await store.reserveFunding("a", [funding]);
            await store.submitting("a");
            await store.retainAmbiguous("a", "expected-tx");
        });
        const reloaded = createReceiverStore("wallet");
        await expect(reloaded.failedBeforeSubmission("a")).rejects.toThrow(/possibly submitted/);
        await expect(reloaded.observedSpend("a", "wrong-tx")).rejects.toThrow(/does not match/);
        await reloaded.claimOnce("b", async () => {
            await expect(reloaded.reserveFunding("b", [funding])).rejects.toThrow(/No unreserved/);
        });
        await expect(
            resumeReceiver(reloaded, async () => {
                throw new Error("not observed");
            }),
        ).rejects.toThrow("not observed");
        expect(
            (await reloaded.pending()).find((row) => row.transferId === "a")?.fundingOutpoint,
        ).toEqual({ txid: funding.input.txid, vout: funding.input.vout });
        const observations: string[] = [];
        await resumeReceiver(reloaded, async (txid) => {
            observations.push(txid);
        });
        expect(observations).toEqual(["expected-tx"]);
        expect((await reloaded.pending()).some((row) => row.transferId === "a")).toBe(false);
        await expect(reloaded.reserveFunding("b", [funding])).rejects.toThrow(/No unreserved/);
    });

    it("releases definite pre-submission failures but holds crash records without a txid", async () => {
        const { createReceiverStore, resumeReceiver } = loadReceiverStore();
        const store = createReceiverStore("wallet");
        await store.claimOnce("failed", async () => {
            await store.reserveFunding("failed", [candidate()]);
            await store.submitting("failed");
            await store.failedBeforeSubmission("failed");
        });
        await store.claimOnce("crashed", async () => {
            await store.reserveFunding("crashed", [candidate()]);
            await store.submitting("crashed");
        });
        const observe = vi.fn();
        const reloaded = createReceiverStore("wallet");
        await resumeReceiver(reloaded, observe);
        expect(observe).not.toHaveBeenCalled();
        expect(await reloaded.pending()).toEqual([
            {
                transferId: "crashed",
                expectedTxid: undefined,
                fundingOutpoint: { txid: "aa".repeat(32), vout: 2 },
            },
        ]);
    });

    it("runs Bob's exact example without reusing ambiguously submitted funding", async () => {
        const source = examples.find((code) => code.startsWith("// receiver.ts"))!;
        const output = ts.transpileModule(source, {
            compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
        }).outputText;
        let onSnapshot: (batch: { claims: unknown[] }) => void = () => {};
        let submissions = 0;
        class Taxi {
            async verifyIncomingClaim() {
                return { value: 330n };
            }
            async recycle() {
                submissions++;
                throw new client.CovenantSpendAmbiguousError(
                    "expected-tx",
                    new Error("dropped reply"),
                );
            }
            subscribeClaims(options: { onSnapshot: typeof onSnapshot }) {
                onSnapshot = options.onSnapshot;
                return () => {};
            }
        }
        const exports: Record<string, unknown> = {};
        new Function("exports", "require", output)(exports, (name: string) =>
            name === "@arkade-taxi/client" ? { ...client, TaxiClient: Taxi } : sdk,
        );
        const receiver = exports.receiveUsdt as (options: Record<string, unknown>) => () => void;
        const { createReceiverStore } = loadReceiverStore();
        const store = createReceiverStore("wallet");
        const address = new sdk.ArkAddress(serverKey, senderTree.tweakedPublicKey, "ark").encode();
        const errors: unknown[] = [];
        let finish: () => void = () => {};
        const completed = new Promise<void>((resolve) => {
            finish = resolve;
        });
        receiver({
            wallet: {
                identity: senderIdentity,
                getSpendableVtxos: async () => [
                    {
                        txid: "aa".repeat(32),
                        vout: 2,
                        value: 600,
                        status: { confirmed: true },
                        createdAt: new Date(0),
                        script: bytesToHex(senderTree.pkScript),
                        isUnrolled: false,
                        isSpent: false,
                        isSwept: false,
                        virtualStatus: { state: "settled" },
                        expiresAtHeight: 900_000,
                        tapTree: senderTree.encode(),
                        forfeitTapLeafScript: senderTree.leaves[0],
                        intentTapLeafScript: senderTree.leaves[0],
                    },
                ],
            },
            taxiUrl: "https://taxi.example",
            receiverAddresses: [address],
            usdtId: sdk.asset.AssetId.create("12".repeat(32), 0).toString(),
            mode: "recycle",
            trusted: {},
            config: {},
            store,
            observeSpend: async () => {
                throw new Error("not canonically observed");
            },
            onError: (error: unknown) => {
                errors.push(error);
                if (errors.length === 2) finish();
            },
        });
        onSnapshot({
            claims: ["a", "b"].map((transferId) => ({
                transferId,
                receiverAddress: address,
                claimable: true,
                state: "locked",
            })),
        });
        await completed;
        expect(submissions).toBe(1);
        expect(errors.map((error) => (error as Error).message)).toEqual([
            "not canonically observed",
            "No unreserved sats input",
        ]);
        expect(await store.pending()).toEqual([
            {
                transferId: "https://taxi.example:a",
                expectedTxid: "expected-tx",
                fundingOutpoint: { txid: "aa".repeat(32), vout: 2 },
            },
        ]);
    });
});
