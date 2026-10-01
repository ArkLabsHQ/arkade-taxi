import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";
import { describe, expect, it, vi } from "vitest";
import { ArkAddress } from "@arkade-os/sdk";
import { APP_JS, INDEX_HTML, STYLES_CSS } from "../../src/admin/static.js";
import { taxiAssetIdToSwapId } from "../../src/arkade/swapFillBuilder.js";
import type { OperationalSnapshot } from "../../src/routes.js";
import { config, fundingCoin, operatorKey, policy, serverKey } from "../fixtures.js";
import { harness, type Harness } from "./fixtures.js";

const asset = (name: string): string =>
    readFileSync(fileURLToPath(new URL(`../../src/admin/static/${name}`, import.meta.url)), "utf8")
        .split("\r\n")
        .join("\n");

class DashboardElement {
    children: DashboardElement[] = [];
    listeners = new Map<string, ((event: any) => unknown)[]>();
    classList = { toggle() {}, remove() {} };
    firstChild = { nodeValue: "" };
    style = { width: "" };
    hidden = false;
    disabled = false;
    value: any = "";
    checked = false;
    open = false;
    name = "";
    title = "";
    scope = "";
    type = "";
    className = "";
    private text = "";

    showModal() {
        this.open = true;
    }
    close() {
        this.open = false;
    }
    focus() {}

    set textContent(value: string) {
        this.text = String(value);
        this.children = [];
        this.firstChild = { nodeValue: this.text };
    }
    get textContent() {
        return this.text;
    }
    append(...items: DashboardElement[]) {
        this.children.push(...items.filter((item) => item instanceof DashboardElement));
    }
    addEventListener(type: string, listener: (event: any) => unknown) {
        this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
    }
    fire(type: string) {
        for (const listener of this.listeners.get(type) ?? [])
            listener({ target: this, preventDefault() {} });
    }
}

const source = (path: string) =>
    readFileSync(fileURLToPath(new URL(`../../../${path}`, import.meta.url)), "utf8");
const union = (path: string, pattern: RegExp) =>
    [...pattern.exec(source(path))![1]!.matchAll(/"([a-z]+)"/g)].map((m) => m[1]!);

// Every module whose codes reach readiness.blockers, and the snake_case literals
// in them that never do.
const BLOCKER_SOURCES = [
    "app/src/routes.ts",
    "app/src/lifecycle.ts",
    "app/src/arkade/operatorWallet.ts",
    "app/src/arkade/providers.ts",
    "app/src/sweeper.ts",
    "app/src/arkade/recovery.ts",
    "app/src/arkade/submit.ts",
    "app/src/reconciler.ts",
    "app/src/watcher.ts",
    "app/src/swapFillReconciler.ts",
    "app/src/proceeds.ts",
    "db/src/proceeds.ts",
    "db/src/reservations.ts",
];
const NOT_BLOCKERS = new Set([
    ...["not_ready", "recovery_failed", "runtime_unsafe", "shutdown_failed", "shutdown_timeout"],
    ...["swap_fill_offer_cancelled", "swap_fill_submit_never_invoked", "envelope_conflict"],
    ...["exceeds_max_outstanding", "funding_reservation_invalid", "invalid_state", "not_found"],
    ...["max_concurrent_advances", "policy_changed", "quote_expired", "recovery_budget_invalid"],
]);

function backendBlockerCodes(): string[] {
    const expansions: Record<string, string[]> = {
        startup_: union("app/src/lifecycle.ts", /type LifecyclePhase =([^;]+);/),
        chain_: union("core/src/types.ts", /type ExpiryDeadline =(.+)/),
        lockup_submission_: union("core/src/types.ts", /submissionPhase\?:([^;]+);/),
    };
    const codes = new Set<string>();
    for (const path of BLOCKER_SOURCES) {
        const text = source(path);
        for (const [, code] of text.matchAll(/["'`]([a-z][a-z0-9]*(?:_[a-z0-9]+)+)["'`]/g))
            if (!NOT_BLOCKERS.has(code!)) codes.add(code!);
        for (const [template, prefix, suffix] of text.matchAll(
            /`([a-z]+_[a-z_]*)\$\{[^}]+\}([a-z_]*)`/g,
        )) {
            if (!expansions[prefix!]) throw new Error(`${path}: cannot expand ${template}`);
            for (const value of expansions[prefix!]!) codes.add(prefix + value + suffix);
        }
    }
    return [...codes];
}

const readiness = (blockers: string[], usableSats = "2500") =>
    ({
        ready: blockers.length === 0,
        body: {
            status: blockers.length ? "degraded" : "ok",
            blockers,
            startup: { phase: "ready", complete: true, blocker: null },
            runtime: {
                provider: { network: "regtest", identityOk: true },
                inventory: { usableSats, reservedSats: "0", usableVtxos: 1, reservedVtxos: 0 },
            },
            sweeper: { nearestDeadline: { height: null, time: null } },
        },
    }) as unknown as OperationalSnapshot;

const named = (root: DashboardElement, name: string): DashboardElement[] => [
    ...(root.name === name ? [root] : []),
    ...root.children.flatMap((child) => named(child, name)),
];

const dashboardRow = (id: string, state = "locked") => ({
    id,
    state,
    topup: "1",
    fare: { units: "0" },
    locktime: "1",
    ageSeconds: 1,
    covenantAddress: `address-${id}`,
});

const dashboardPage = (
    advances: ReturnType<typeof dashboardRow>[],
    snapshotToken: string,
    nextOffset: number | null,
) => ({
    advances,
    total: advances.length + (nextOffset === null ? 0 : 1),
    offset: 0,
    limit: 200,
    nextOffset,
    hasMore: nextOffset !== null,
    hiddenUrgentCount: 0,
    paginationMode: "current_snapshot",
    snapshotToken,
});

function deferred<T>() {
    let resolve!: (value: T) => void;
    let reject!: (error: unknown) => void;
    const promise = new Promise<T>((yes, no) => {
        resolve = yes;
        reject = no;
    });
    return { promise, resolve, reject };
}

function runDashboard(
    fetchAdvances: (path: string) => unknown | Promise<unknown>,
    admin = harness(),
    { realStatus = false } = {},
) {
    const elements = new Map<string, DashboardElement>();
    const element = (id: string) => {
        if (!INDEX_HTML.includes(`id="${id}"`)) throw new Error(`index.html has no #${id}`);
        if (!elements.has(id)) elements.set(id, new DashboardElement());
        return elements.get(id)!;
    };
    const requests: string[] = [];
    const sent: { method: string; path: string; body: any }[] = [];
    const copied: string[] = [];
    let poll = async () => {};
    const response = (body: unknown) => ({
        ok: true,
        status: 200,
        statusText: "OK",
        text: async () => JSON.stringify(body),
    });
    const fetch = async (
        path: string,
        init?: { method?: string; headers?: Record<string, string>; body?: string },
    ) => {
        requests.push(path);
        if (init?.method) sent.push({ method: init.method, path, body: JSON.parse(init.body!) });
        if (path.startsWith("/admin/api/advances")) {
            const result: any = await fetchAdvances(path);
            if (result?.httpStatus)
                return {
                    ok: false,
                    status: result.httpStatus,
                    statusText: "Conflict",
                    text: async () => JSON.stringify(result.body),
                };
            return response(result);
        }
        if (path === "/admin/api/status" && !realStatus)
            return response({
                exposure: {
                    outstandingSats: "1",
                    activeCount: 1,
                    oldestUnsweptLocktime: { height: "1", time: null },
                },
                counts: {},
                paused: true,
                dust: "330",
                vtxoMinAmount: "10",
                sweeper: {
                    healthy: true,
                    running: true,
                    lastTickAt: null,
                    sinceLastTickMs: null,
                    staleAfterMs: 30_000,
                    intervalMs: 10_000,
                    lastHeight: "1",
                    recoverySubmittedTotal: 0,
                    lastError: null,
                },
                readiness: {
                    status: "degraded",
                    blockers: [],
                    startup: { phase: "provider" },
                    runtime: {
                        inventory: {
                            usableSats: "0",
                            usableVtxos: 0,
                            reservedSats: "1",
                            reservedVtxos: 1,
                        },
                        provider: { network: null, identityOk: false },
                    },
                    sweeper: { nearestDeadline: { height: null, time: null } },
                },
            });
        // The authenticating proxy, not the page, supplies the operator header.
        return admin.app.request(path, {
            ...init,
            headers: { ...init?.headers, "x-taxi-operator": "console-operator" },
        });
    };
    const document = {
        body: new DashboardElement(),
        title: "",
        hidden: false,
        getElementById: element,
        createElement: () => new DashboardElement(),
        addEventListener() {},
    };
    const context: Record<string, any> = {
        document,
        fetch,
        navigator: { clipboard: { writeText: async (text: string) => void copied.push(text) } },
        window: { setInterval: (tick: () => Promise<void>) => void (poll = tick) },
        URL,
        URLSearchParams,
        Date,
        BigInt,
        Math,
        JSON,
        Error,
        Map,
        Array,
        String,
    };
    runInNewContext(APP_JS, context);
    const renderedIds = () =>
        element("advances-body").children.map((row) => row.children[0]?.title);
    return { element, renderedIds, requests, sent, copied, context, poll: () => poll() };
}

describe("static routes", () => {
    it("serves the dashboard at /admin under both mount styles", async () => {
        for (const mount of ["prefix", "root"] as const) {
            const res = await harness({ mount }).app.request("/admin");

            expect(res.status, mount).toBe(200);
            expect(res.headers.get("content-type")).toMatch(/^text\/html; ?charset=utf-8$/i);
            expect(await res.text()).toBe(INDEX_HTML);
        }
    });

    it("also answers the trailing slash when mounted at the root", async () => {
        const res = await harness({ mount: "root" }).app.request("/admin/");

        expect(res.status).toBe(200);
    });

    it("serves the script and the stylesheet with their own content types", async () => {
        const h = harness();

        const js = await h.app.request("/admin/app.js");
        expect(js.status).toBe(200);
        expect(js.headers.get("content-type")).toMatch(/^(text|application)\/javascript/i);
        expect(await js.text()).toBe(APP_JS);

        const css = await h.app.request("/admin/styles.css");
        expect(css.status).toBe(200);
        expect(css.headers.get("content-type")).toMatch(/^text\/css/i);
        expect(await css.text()).toBe(STYLES_CSS);
    });

    it("links its assets by absolute path so the page works under either mount", () => {
        expect(INDEX_HTML).toContain("/admin/styles.css");
        expect(INDEX_HTML).toContain("/admin/app.js");
    });

    it("serves visible advance paging controls and a current-snapshot warning", () => {
        expect(INDEX_HTML).toContain('id="advances-more"');
        expect(INDEX_HTML).toContain('id="advances-note"');
        expect(INDEX_HTML).toContain("Advances ordered by safety urgency in the current snapshot");
    });
});

describe("served constants match the authored assets", () => {
    it("has no drift between src/admin/static/* and the embedded strings", () => {
        expect(INDEX_HTML).toBe(asset("index.html"));
        expect(APP_JS).toBe(asset("app.js"));
        expect(STYLES_CSS).toBe(asset("styles.css"));
    });
});

describe("the dashboard is dependency-free", () => {
    it("loads nothing over the network and runs no build step", () => {
        for (const [name, src] of [
            ["index.html", INDEX_HTML],
            ["app.js", APP_JS],
            ["styles.css", STYLES_CSS],
        ] as const) {
            expect(src, name).not.toMatch(/https?:\/\/(?!www\.w3\.org)/);
            expect(src, name).not.toMatch(/cdn|unpkg|jsdelivr|googleapis/i);
            expect(src, name).not.toMatch(/@import/);
        }
    });

    it("loads the next page, deduplicates changing snapshots, and resets on filter", async () => {
        class Element {
            children: unknown[] = [];
            listeners = new Map<string, ((event: any) => unknown)[]>();
            classList = { toggle() {}, remove() {} };
            firstChild = { nodeValue: "" };
            hidden = false;
            disabled = false;
            value: any = "";
            checked = false;
            title = "";
            scope = "";
            type = "";
            className = "";
            private text = "";

            set textContent(value: string) {
                this.text = String(value);
                this.children = [];
                this.firstChild = { nodeValue: this.text };
            }
            get textContent() {
                return this.text;
            }
            append(...items: unknown[]) {
                this.children.push(...items);
            }
            addEventListener(type: string, listener: (event: any) => unknown) {
                this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
            }
            fire(type: string) {
                for (const listener of this.listeners.get(type) ?? [])
                    listener({ target: this, preventDefault() {} });
            }
        }

        const elements = new Map<string, Element>();
        const element = (id: string) => {
            if (!elements.has(id)) elements.set(id, new Element());
            return elements.get(id)!;
        };
        const requests: string[] = [];
        const row = (id: string) => ({
            id,
            state: "locked",
            topup: "1",
            fare: { units: "0" },
            locktime: "1",
            ageSeconds: 1,
            covenantAddress: `address-${id}`,
        });
        const response = (body: unknown) => ({
            ok: true,
            status: 200,
            statusText: "OK",
            text: async () => JSON.stringify(body),
        });
        const fetch = async (path: string) => {
            requests.push(path);
            if (path.startsWith("/admin/api/advances")) {
                const offset = Number(new URL(path, "http://taxi.test").searchParams.get("offset"));
                return response(
                    offset === 1
                        ? {
                              advances: [row("first"), row("second")],
                              total: 2,
                              offset: 1,
                              limit: 1,
                              nextOffset: null,
                              hasMore: false,
                              hiddenUrgentCount: 0,
                              paginationMode: "current_snapshot",
                              snapshotToken: "a".repeat(64),
                          }
                        : {
                              advances: [row("first")],
                              total: 2,
                              offset: 0,
                              limit: 1,
                              nextOffset: 1,
                              hasMore: true,
                              hiddenUrgentCount: 1,
                              paginationMode: "current_snapshot",
                              snapshotToken: "a".repeat(64),
                          },
                );
            }
            if (path === "/admin/api/status")
                return response({
                    exposure: {
                        outstandingSats: "1",
                        activeCount: 1,
                        oldestUnsweptLocktime: { height: "1", time: null },
                    },
                    counts: {},
                    paused: true,
                    sweeper: {
                        healthy: true,
                        running: true,
                        lastTickAt: null,
                        sinceLastTickMs: null,
                        staleAfterMs: 30_000,
                        intervalMs: 10_000,
                        lastHeight: "1",
                        recoverySubmittedTotal: 0,
                        lastError: null,
                    },
                    readiness: {
                        status: "degraded",
                        blockers: [],
                        startup: { phase: "provider" },
                        runtime: {
                            inventory: {
                                usableSats: "0",
                                usableVtxos: 0,
                                reservedSats: "1",
                                reservedVtxos: 1,
                            },
                            provider: { network: null, identityOk: false },
                        },
                        sweeper: { nearestDeadline: { height: null, time: null } },
                    },
                });
            if (path === "/admin/api/policy/history?limit=50") return response({ history: [] });
            return response({
                feeFlatSats: "0",
                feeBps: 0,
                maxOutstandingSats: "0",
                maxPerPaymentTopupSats: "0",
                maxConcurrentAdvances: 0,
                locktimeMarginBlocks: 73,
                locktimeMarginSeconds: 43_201,
                quoteTtlSeconds: 60,
                assetAllowlist: null,
            });
        };
        const document = {
            body: new Element(),
            title: "",
            hidden: false,
            getElementById: element,
            createElement: () => new Element(),
            addEventListener() {},
        };

        runInNewContext(APP_JS, {
            document,
            fetch,
            window: { setInterval() {} },
            URL,
            URLSearchParams,
            Date,
            BigInt,
            Math,
            JSON,
            Error,
        });
        await vi.waitFor(() =>
            expect(element("advances-note").textContent).toMatch(/urgent.*current snapshot/i),
        );
        expect(element("advances-more").hidden).toBe(false);

        element("advances-more").fire("click");
        await vi.waitFor(() => expect(element("advances-body").children).toHaveLength(2));
        expect(requests.filter((path) => path.includes("offset=1"))).toHaveLength(1);
        expect(requests.find((path) => path.includes("offset=1"))).toContain(
            "snapshot=" + "a".repeat(64),
        );

        element("state-filter").value = "recovering";
        element("state-filter").fire("change");
        await vi.waitFor(() =>
            expect(requests.filter((path) => path.includes("state=recovering"))).toHaveLength(1),
        );
        expect(requests.at(-1)).not.toContain("offset=");
    });

    it("ignores stale success and error responses after filter and refresh resets", async () => {
        const oldFilter = deferred<unknown>();
        const oldAppend = deferred<unknown>();
        let recoveringRoots = 0;
        const initialToken = "1".repeat(64);
        const currentToken = "2".repeat(64);
        const refreshedToken = "3".repeat(64);
        const dashboard = runDashboard((path) => {
            const query = new URL(path, "http://taxi.test").searchParams;
            const state = query.get("state") ?? "";
            if (state === "locked") return oldFilter.promise;
            if (state === "recovering" && query.get("offset") === "1") return oldAppend.promise;
            if (state === "recovering") {
                recoveringRoots++;
                return recoveringRoots === 1
                    ? dashboardPage(
                          [dashboardRow("current-recovering", "recovering")],
                          currentToken,
                          1,
                      )
                    : dashboardPage(
                          [dashboardRow("refreshed-recovering", "recovering")],
                          refreshedToken,
                          null,
                      );
            }
            return dashboardPage([dashboardRow("initial")], initialToken, null);
        });

        await vi.waitFor(() => expect(dashboard.renderedIds()).toEqual(["initial"]));
        dashboard.element("state-filter").value = "locked";
        dashboard.element("state-filter").fire("change");
        dashboard.element("state-filter").value = "recovering";
        dashboard.element("state-filter").fire("change");
        await vi.waitFor(() => expect(dashboard.renderedIds()).toEqual(["current-recovering"]));
        const countAfterFilter = dashboard.element("advances-count").textContent;
        const noteAfterFilter = dashboard.element("advances-note").textContent;
        oldFilter.resolve(dashboardPage([dashboardRow("stale-locked")], "4".repeat(64), null));
        await new Promise((resolve) => setTimeout(resolve, 0));
        expect(dashboard.renderedIds()).toEqual(["current-recovering"]);
        expect(dashboard.element("advances-count").textContent).toBe(countAfterFilter);
        expect(dashboard.element("advances-note").textContent).toBe(noteAfterFilter);
        expect(dashboard.element("advances-more").hidden).toBe(false);

        dashboard.element("advances-more").fire("click");
        await vi.waitFor(() =>
            expect(dashboard.requests.some((path) => path.includes("offset=1"))).toBe(true),
        );
        expect(dashboard.requests.find((path) => path.includes("offset=1"))).toContain(
            "snapshot=" + currentToken,
        );
        dashboard.element("refresh").fire("click");
        await vi.waitFor(() => expect(dashboard.renderedIds()).toEqual(["refreshed-recovering"]));
        const noteAfterRefresh = dashboard.element("advances-note").textContent;
        const countAfterRefresh = dashboard.element("advances-count").textContent;
        oldAppend.reject(new Error("OLD_PRIVATE_ERROR"));
        await new Promise((resolve) => setTimeout(resolve, 0));

        expect(dashboard.renderedIds()).toEqual(["refreshed-recovering"]);
        expect(dashboard.element("advances-note").textContent).toBe(noteAfterRefresh);
        expect(dashboard.element("advances-note").textContent).not.toContain("OLD_PRIVATE_ERROR");
        expect(dashboard.element("advances-count").textContent).toBe(countAfterRefresh);
        expect(dashboard.element("advances-more").disabled).toBe(false);
        expect(dashboard.element("advances-more").hidden).toBe(true);
    });

    it("discards a changed snapshot and reloads page one before showing completeness", async () => {
        const firstToken = "5".repeat(64);
        let roots = 0;
        const dashboard = runDashboard((path) => {
            const query = new URL(path, "http://taxi.test").searchParams;
            if (query.get("offset") === "1")
                return {
                    httpStatus: 409,
                    body: { code: "snapshot_changed", error: "advance snapshot changed" },
                };
            roots++;
            return roots === 1
                ? dashboardPage([dashboardRow("old-first")], firstToken, 1)
                : dashboardPage([dashboardRow("fresh-first")], "6".repeat(64), null);
        });

        await vi.waitFor(() => expect(dashboard.renderedIds()).toEqual(["old-first"]));
        dashboard.element("advances-more").fire("click");
        await vi.waitFor(() => expect(dashboard.renderedIds()).toEqual(["fresh-first"]));

        const advanceRequests = dashboard.requests.filter((path) =>
            path.startsWith("/admin/api/advances"),
        );
        expect(advanceRequests).toHaveLength(3);
        expect(advanceRequests[1]).toContain("offset=1");
        expect(advanceRequests[1]).toContain("snapshot=" + firstToken);
        expect(dashboard.element("advances-count").textContent).toContain("1 loaded · 1");
        expect(dashboard.element("advances-more").hidden).toBe(true);
    });

    it("edits the real policy wire's asset rules into a PATCH the router accepts", async () => {
        const admin = harness();
        const token = { txid: new Uint8Array(32).fill(0xcd), groupIndex: 1 };
        const seeded = admin.policy.update(
            policy({
                assetRules: [
                    ...policy().assetRules,
                    {
                        assetId: token,
                        enabled: true,
                        fares: [
                            {
                                id: "token",
                                currency: { kind: "token", assetId: token },
                                pricing: { kind: "flat", units: 1n },
                            },
                        ],
                        claim: "recycle",
                        maxTopupSats: 500n,
                    },
                ],
            }),
            "seed",
        );
        const dashboard = runDashboard(() => dashboardPage([], "7".repeat(64), null), admin);
        const note = () => dashboard.element("policy-note").textContent;
        await vi.waitFor(() =>
            expect(dashboard.element("policy-loaded").textContent, note()).toMatch(/^loaded/),
        );
        expect(note()).toBe("");
        expect(dashboard.element("maxConcurrentAdvances").value).toBe(seeded.maxConcurrentAdvances);

        const rules = JSON.parse(dashboard.element("assetRules").value);
        rules[1].enabled = false;
        const edited = JSON.stringify(rules);
        dashboard.element("assetRules").value = edited;
        dashboard.element("policy-form").fire("submit");
        await vi.waitFor(() =>
            expect(dashboard.element("assetRules").value, note()).not.toBe(edited),
        );
        expect(note()).toBe("request accepted");
        expect(JSON.parse(dashboard.element("assetRules").value)).toEqual(rules);
        expect(admin.policy.get().assetRules).toEqual([
            seeded.assetRules[0],
            { ...seeded.assetRules[1], enabled: false },
        ]);

        dashboard.element("policy-form").fire("submit");
        expect(note()).toBe("nothing changed");
        const sent = dashboard.requests.length;
        dashboard.element("assetRules").value = "[";
        dashboard.element("policy-form").fire("submit");
        expect(note()).toMatch(/^Asset rules: /);
        expect(dashboard.requests).toHaveLength(sent);
    });

    it("edits rules from the settings table and keeps the JSON view on the same rules", async () => {
        const admin = harness();
        const [seeded] = admin.policy.update(policy(), "seed").assetRules;
        const dashboard = runDashboard(() => dashboardPage([], "b".repeat(64), null), admin);
        const row = () => dashboard.element("rules-body").children[0]!;
        const json = () => JSON.parse(dashboard.element("assetRules").value);
        await vi.waitFor(() => expect(named(row(), "claim")).toHaveLength(1));

        const claim = named(row(), "claim")[0]!;
        claim.value = "purchase";
        claim.fire("change");
        named(row(), "add-fare")[0]!.fire("click");
        const units = named(row(), "units")[1]!;
        units.value = "5";
        units.fire("change");
        const added = { id: "sats-2", currency: { kind: "sats" }, pricing: { kind: "flat" } };
        expect(json()).toEqual([
            {
                assetId: null,
                enabled: true,
                fares: [
                    {
                        id: "sats",
                        currency: { kind: "sats" },
                        pricing: { kind: "flat", units: "0" },
                    },
                    { ...added, pricing: { kind: "flat", units: "5" } },
                ],
                claim: "purchase",
                maxTopupSats: null,
            },
        ]);

        dashboard.element("policy-form").fire("submit");
        await vi.waitFor(() =>
            expect(dashboard.element("policy-note").textContent).toBe("request accepted"),
        );
        expect(admin.policy.get().assetRules).toEqual([
            {
                ...seeded,
                claim: "purchase",
                fares: [...seeded!.fares, { ...added, pricing: { kind: "flat", units: 5n } }],
            },
        ]);

        const edited = json();
        edited[0].enabled = false;
        dashboard.element("assetRules").value = JSON.stringify(edited);
        dashboard.element("assetRules").fire("input");
        expect(named(row(), "enabled")[0]!.checked).toBe(false);
    });

    it("loads the funding card from the real router on load and REFRESH, not on the poll", async () => {
        const token = { txid: new Uint8Array(32).fill(0xcd), groupIndex: 1 };
        const admin = harness({
            funding: async () => ({
                config: config(),
                inventory: {
                    usableSats: 2_500n,
                    reservedSats: 0n,
                    usableVtxos: 1,
                    reservedVtxos: 0,
                },
                coins: [
                    fundingCoin({
                        assets: [{ assetId: taxiAssetIdToSwapId(token), amount: 1_234_567n }],
                    }),
                ],
            }),
        });
        const dashboard = runDashboard(() => dashboardPage([], "8".repeat(64), null), admin);
        const text = (id: string) => dashboard.element(id).textContent;
        const address = new ArkAddress(serverKey, operatorKey, "ark").encode();

        await vi.waitFor(() => expect(text("funding-address")).toBe(address));
        expect(text("funding-usable")).toBe("2 500 sats");
        expect(text("funding-reserved")).toBe("0 sats");
        expect(text("funding-threshold")).toBe("10 000 sats");
        expect(text("funding-state")).toBe("below reserve");
        expect(
            dashboard
                .element("funding-assets")
                .children.map((row) => row.children.map((c) => c.title || c.textContent)),
        ).toEqual([["cd".repeat(32), "1", "1 234 567"]]);

        dashboard.element("funding-copy").fire("click");
        await vi.waitFor(() => expect(dashboard.copied).toEqual([address]));

        const fundingLoads = () =>
            dashboard.requests.filter((path) => path === "/admin/api/funding").length;
        expect(fundingLoads()).toBe(1);
        await dashboard.poll();
        expect(fundingLoads(), "a poll tick must not re-read the operator wallet").toBe(1);
        dashboard.element("refresh").fire("click");
        await vi.waitFor(() => expect(fundingLoads()).toBe(2));
    });
});

describe("setup guidance", () => {
    it("says every readiness blocker the backend can raise in a sentence", () => {
        const codes = backendBlockerCodes();
        const { context } = runDashboard(() => dashboardPage([], "c".repeat(64), null));

        expect(codes.length).toBeGreaterThan(100);
        expect(codes.filter((code) => context.blockerText(code) === code)).toEqual([]);
        expect(context.blockerText("no_such_blocker")).toBe("no_such_blocker");
    });

    it("walks a fresh Taxi through the checklist in plain words", async () => {
        const admin: Harness = harness({
            operationalSnapshot: (options) =>
                readiness([
                    ...(admin.policy.get().paused && !options?.ignoreManualPause
                        ? ["manual_pause"]
                        : []),
                    "operator_reserve_low",
                ]),
        });
        const dashboard = runDashboard(() => dashboardPage([], "d".repeat(64), null), admin, {
            realStatus: true,
        });
        const text = (id: string) => dashboard.element(id).textContent;
        const steps = ["connected", "fund", "limits", "carry", "live"];

        await vi.waitFor(() => expect(text("step-fund-detail")).toContain("10 000"));
        expect(steps.map((step) => text(`step-${step}-state`))).toEqual([
            "Done",
            "To do",
            "To do",
            "To do",
            "To do",
        ]);
        expect(text("step-connected-title")).toBe("Taxi is running and connected (regtest)");
        expect(steps.slice(1).map((step) => text(`step-${step}-detail`))).toEqual([
            "2 500 sats usable, below the 10 000 sats it must keep in reserve. Send it at least 7 500 sats more.",
            "It lends nothing while any of the three limits is 0.",
            "It carries nothing until at least one rule is switched on.",
            "The Taxi is paused, so it refuses every new payment.",
        ]);

        dashboard.element("step-live-fix").fire("click");
        expect(dashboard.element("go-live-confirm").hidden).toBe(false);
        expect(text("go-live-warning")).toBe(
            "Not done yet: fund your Taxi, set your limits, choose what to carry. It will refuse payments until they are.",
        );
        expect(dashboard.sent).toEqual([]);
        dashboard.element("go-live-anyway").fire("click");
        await vi.waitFor(() =>
            expect(dashboard.sent.map((r) => r.path)).toEqual(["/admin/api/policy/resume"]),
        );
    });
});
