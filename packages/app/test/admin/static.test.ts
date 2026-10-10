import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ArkAddress } from "@arkade-os/sdk";
import { APP_JS, INDEX_HTML, STYLES_CSS } from "../../src/admin/static.js";
import { assetIdToWire } from "@arkade-taxi/protocol";
import { taxiAssetId, sdkAssetId } from "@arkade-taxi/client";
import { PATCHABLE_POLICY_KEYS, POLICY_VOCABULARY } from "../../src/admin/routes.js";
import { SHOWN_CONFIG } from "../../src/config.js";
import { openApiDocument } from "../../src/openapi.js";
import type { OperationalSnapshot } from "../../src/routes.js";
import { DUST, config, fundingCoin, operatorKey, policy, serverKey } from "../fixtures.js";
import { boardingView, harness, type Harness } from "./fixtures.js";

afterEach(() => vi.useRealTimers());

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
    "app/src/fillReconciler.ts",
    "app/src/proceeds.ts",
    "db/src/proceeds.ts",
    "db/src/reservations.ts",
];
const NOT_BLOCKERS = new Set([
    ...["not_ready", "recovery_failed", "runtime_unsafe", "shutdown_failed", "shutdown_timeout"],
    ...["fill_submit_never_invoked", "fill_input_conflict", "envelope_conflict"],
    ...["exceeds_max_outstanding", "funding_reservation_invalid", "invalid_state", "not_found"],
    ...["max_concurrent_advances", "policy_changed", "quote_expired", "recovery_budget_invalid"],
    // Refusals of one quote, which the fence raises alongside those above; the
    // operator's readiness is not what they report.
    ...["asset_not_served", "topup_exceeds_max_per_payment", "no_locktime_headroom"],
    // Refusals inside the SDK's own background settlement, which only the SDK sees and logs,
    // and the SDK's intent states.
    ...["background_settlement_not_authorized", "background_settlement_spends_held_coin"],
    ...["waiting_to_submit", "waiting_for_batch", "batch_in_progress"],
    // An SDK contract-event type the watcher reads, not a readiness code.
    ...["connection_reset"],
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
        warnings: [],
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
                warnings: [],
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
        const fix = "run node scripts/mirror-admin-static.mjs";
        expect(INDEX_HTML, fix).toBe(asset("index.html"));
        expect(APP_JS, fix).toBe(asset("app.js"));
        expect(STYLES_CSS, fix).toBe(asset("styles.css"));
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
        // The fixture's bitcoin rule is "either" with a free fare.
        dashboard.element("rules-giveaway-ok").checked = true;
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

        dashboard.element("rules-giveaway-ok").checked = true;
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

    it("takes and shows asset ids exactly as the wallet writes them", async () => {
        const admin = harness();
        const dashboard = runDashboard(() => dashboardPage([], "1".repeat(64), null), admin);
        await vi.waitFor(() =>
            expect(dashboard.element("policy-loaded").textContent).toMatch(/^loaded/),
        );
        // Distinct txid bytes and a group above 255, so byte order shows on both halves.
        const wallet = sdkAssetId({
            txid: Uint8Array.from({ length: 32 }, (_, i) => i + 1),
            groupIndex: 300,
        });
        expect(wallet).toMatch(/^[0-9a-f]{68}$/);

        dashboard.element("rule-asset").value = wallet;
        dashboard.element("rule-add-asset").fire("click");
        expect(JSON.parse(dashboard.element("assetRules").value)[0].assetId).toEqual(
            assetIdToWire(taxiAssetId(wallet)),
        );
        expect(dashboard.element("rules-body").children[0]!.children[0]!.title).toBe(wallet);

        dashboard.element("policy-form").fire("submit");
        await vi.waitFor(() =>
            expect(dashboard.element("policy-note").textContent).toBe("request accepted"),
        );
        expect(admin.policy.get().assetRules[0]!.assetId).toEqual(taxiAssetId(wallet));
        expect(dashboard.element("rules-body").children[0]!.children[0]!.title).toBe(wallet);
    });

    it("loads the funding card from the real router on load and REFRESH, not on the poll", async () => {
        const token = { txid: Uint8Array.from({ length: 32 }, (_, i) => 32 - i), groupIndex: 258 };
        let boarding = boardingView({
            deposits: { confirmedSats: 60_000n, unconfirmedSats: 5_000n, expiredSats: 7_000n },
        });
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
                        assets: [{ assetId: sdkAssetId(token), amount: 1_234_567n }],
                    }),
                ],
                boarding,
            }),
        });
        const opened = new Date(2026, 0, 1, 9, 0, 0);
        const later = new Date(2026, 0, 1, 9, 0, 7);
        vi.setSystemTime(opened);
        const dashboard = runDashboard(() => dashboardPage([], "8".repeat(64), null), admin);
        const text = (id: string) => dashboard.element(id).textContent;
        const address = new ArkAddress(serverKey, operatorKey, "ark").encode();

        await vi.waitFor(() => expect(text("funding-address")).toBe(address));
        expect(text("funding-loaded")).toBe("loaded " + opened.toLocaleTimeString());
        expect(text("funding-usable")).toBe("2 500 sats");
        expect(text("funding-reserved")).toBe("0 sats");
        expect(text("funding-threshold")).toBe("10 000 sats");
        expect(text("funding-state")).toBe("below reserve");
        expect(text("funding-boarding-address")).toBe("bcrt1pboarding");
        expect(text("funding-boarding-confirmed")).toBe("60 000 sats");
        expect(text("funding-boarding-unconfirmed")).toBe("5 000 sats");
        expect(text("funding-boarding-expired")).toBe("7 000 sats");
        expect(INDEX_HTML).not.toContain("Board<");
        expect(
            dashboard
                .element("funding-assets")
                .children.map((row) => row.children.map((c) => c.title || c.textContent)),
        ).toEqual([[sdkAssetId(token), "258", "1 234 567"]]);

        dashboard.element("funding-copy").fire("click");
        dashboard.element("funding-boarding-copy").fire("click");
        await vi.waitFor(() => expect(dashboard.copied).toEqual([address, "bcrt1pboarding"]));

        const fundingLoads = () =>
            dashboard.requests.filter((path) => path === "/admin/api/funding").length;
        expect(fundingLoads()).toBe(1);
        vi.setSystemTime(later);
        await dashboard.poll();
        expect(fundingLoads(), "a poll tick must not re-read the operator wallet").toBe(1);
        expect(text("funding-loaded")).toBe("loaded " + opened.toLocaleTimeString());
        boarding = { address: null, deposits: null };
        dashboard.element("refresh").fire("click");
        await vi.waitFor(() => expect(fundingLoads()).toBe(2));
        await vi.waitFor(() =>
            expect(text("funding-loaded")).toBe("loaded " + later.toLocaleTimeString()),
        );
        expect(text("funding-boarding-address")).toBe("unavailable");
        expect(dashboard.element("funding-boarding-copy").disabled).toBe(true);
        expect(text("funding-boarding-confirmed")).toBe("unknown");
    });
});

const loaded = async (admin: Harness, realStatus = false) => {
    const dashboard = runDashboard(() => dashboardPage([], "9".repeat(64), null), admin, {
        realStatus,
    });
    await vi.waitFor(() => {
        expect(dashboard.element("policy-loaded").textContent).toMatch(/^loaded/);
        expect(dashboard.element("updated").textContent).toMatch(/^updated/);
    });
    return dashboard;
};

describe("the any-asset rule", () => {
    it("is added from the settings table once, and saved as *", async () => {
        const admin = harness();
        const dashboard = await loaded(admin);
        const note = () => dashboard.element("policy-note").textContent;

        dashboard.element("rule-add-any").fire("click");
        expect(JSON.parse(dashboard.element("assetRules").value)).toMatchObject([{ assetId: "*" }]);
        expect(dashboard.element("rules-body").children[0]!.children[0]!.textContent).toBe(
            "Any asset",
        );
        dashboard.element("rule-add-any").fire("click");
        expect(note()).toBe("Any asset already has a rule.");

        dashboard.element("policy-form").fire("submit");
        await vi.waitFor(() => expect(note()).toBe("request accepted"));
        expect(admin.policy.get().assetRules.map((rule) => rule.assetId)).toEqual(["*"]);
    });

    it("is offered by the setup wizard", async () => {
        const admin = harness({ operationalSnapshot: () => readiness([]) });
        const dashboard = await loaded(admin, true);
        await vi.waitFor(() => expect(dashboard.element("wizard").open).toBe(true));
        dashboard.element("wiz-btc").checked = false;
        dashboard.element("wiz-any").checked = true;
        for (let n = 0; n < 3; n++) dashboard.element("wiz-next").fire("click");
        expect(dashboard.element("wiz-summary").textContent).toMatch(
            /^Your Taxi will carry any asset\./,
        );

        dashboard.element("wiz-save").fire("click");
        await vi.waitFor(() =>
            expect(admin.policy.get().assetRules.map((rule) => rule.assetId)).toEqual(["*"]),
        );
    });
});

describe("giving carriers away", () => {
    const GIVEAWAY =
        "Payers could take the carrier sats for free; you would pay every carrier yourself.";

    it("is refused in the wizard until the operator ticks the override", async () => {
        const admin = harness({ operationalSnapshot: () => readiness([]) });
        const dashboard = await loaded(admin, true);
        const click = (id: string) => dashboard.element(id).fire("click");
        await vi.waitFor(() => expect(dashboard.element("wizard").open).toBe(true));
        click("wiz-next");
        click("wiz-next");
        dashboard.element("wiz-claim-either").fire("change");
        expect(dashboard.element("wiz-giveaway").hidden).toBe(false);
        click("wiz-next");
        expect(dashboard.element("wiz-note").textContent).toMatch(
            /^To go on, tick "Give carriers away for free"/,
        );
        expect(dashboard.element("wizard-progress").textContent).toBe("Step 3 of 4");

        dashboard.element("wiz-claim-recycle").fire("change");
        expect(dashboard.element("wiz-giveaway").hidden).toBe(true);
        dashboard.element("wiz-claim-purchase").fire("change");
        dashboard.element("wiz-giveaway-ok").checked = true;
        click("wiz-next");
        click("wiz-save");
        await vi.waitFor(() =>
            expect(admin.policy.get().assetRules).toMatchObject([
                { assetId: null, claim: "purchase" },
            ]),
        );
    });

    it("is refused in the settings table until the operator ticks the override", async () => {
        const admin = harness();
        const dashboard = await loaded(admin);
        const note = () => dashboard.element("policy-note").textContent;
        dashboard.element("rule-add-bitcoin").fire("click");
        const claim = named(dashboard.element("rules-body").children[0]!, "claim")[0]!;
        claim.value = "purchase";
        claim.fire("change");
        expect(dashboard.element("rules-giveaway").hidden).toBe(false);

        dashboard.element("policy-form").fire("submit");
        expect(note()).toBe(GIVEAWAY);
        expect(dashboard.sent).toEqual([]);

        dashboard.element("rules-giveaway-ok").checked = true;
        dashboard.element("policy-form").fire("submit");
        await vi.waitFor(() => expect(note()).toBe("request accepted"));
        expect(admin.policy.get().assetRules[0]!.claim).toBe("purchase");
    });

    const paid = { id: "paid", currency: { kind: "sats" }, pricing: { kind: "flat", units: "1" } };
    const free = { ...paid, id: "free", pricing: { kind: "flat", units: "0" } };
    const percent = (kind: string, bps: number, minUnits: string) => ({
        id: "percent",
        currency: { kind },
        pricing: { kind: "proportional", bps, minUnits, maxUnits: null },
    });
    const rule = (over: object) => ({
        assetId: null,
        enabled: true,
        claim: "purchase",
        maxTopupSats: null,
        fares: [free],
        ...over,
    });

    // The fake status says dust 330 and vtxoMinAmount 10: an asset payment
    // borrows the whole dust, a bitcoin one as little as 10 sats.
    it.each([
        ["purchase with a flat 0 fare", rule({}), true],
        [
            "either with a flat 0 fare among others",
            rule({ claim: "either", fares: [paid, free] }),
            true,
        ],
        ["recycle with a flat 0 fare", rule({ claim: "recycle" }), false],
        ["a switched-off rule", rule({ enabled: false }), false],
        ["a flat 1 fare", rule({ fares: [paid] }), false],
        [
            "a share of the asset sent, no minimum",
            rule({ fares: [percent("sameAsset", 500, "0")] }),
            true,
        ],
        [
            "a share of the asset sent, minimum 1",
            rule({ fares: [percent("sameAsset", 500, "1")] }),
            false,
        ],
        [
            "0.3% of the dust an asset borrows",
            rule({ assetId: "*", fares: [percent("sats", 30, "0")] }),
            true,
        ],
        [
            "1% of the dust an asset borrows",
            rule({ assetId: "*", fares: [percent("sats", 100, "0")] }),
            false,
        ],
        ["1% of the least bitcoin borrows", rule({ fares: [percent("sats", 100, "0")] }), true],
    ])("decides whether %s is free to take", async (_label, value, flagged) => {
        const dashboard = await loaded(harness());
        expect(dashboard.context.giveaways([value]).length > 0).toBe(flagged);
    });
});

// Every list below comes from the server's own schemas, so an option added
// there without a control or an explanation here fails.
describe("console coverage", () => {
    const TOKEN = { txid: Uint8Array.from({ length: 32 }, (_, i) => i + 7), groupIndex: 2 };
    const helpText = (id: string) =>
        new RegExp(`id="${id}"[^>]*>([\\s\\S]*?)</d[dt]>`).exec(INDEX_HTML)?.[1]?.trim() ?? "";

    it("has a control for every policy field the PATCH schema accepts", async () => {
        const dashboard = await loaded(harness());
        const paths = () => dashboard.sent.map((request) => request.path);
        const fields = PATCHABLE_POLICY_KEYS.filter(
            (key) => key !== "paused" && key !== "assetRules",
        );
        for (const key of fields) dashboard.element(key).value = "7";
        dashboard.element("rule-add-bitcoin").fire("click");
        dashboard.element("policy-form").fire("submit");
        await vi.waitFor(() => expect(paths()).toContain("/admin/api/policy"));
        expect(Object.keys(dashboard.sent[0]!.body).sort()).toEqual(
            [...fields, "assetRules"].sort(),
        );

        dashboard.element("pause").fire("click");
        dashboard.element("resume").fire("click");
        await vi.waitFor(() =>
            expect(paths()).toEqual(
                expect.arrayContaining(["/admin/api/policy/pause", "/admin/api/policy/resume"]),
            ),
        );
    });

    it("edits every rule field the PATCH schema accepts from the table", async () => {
        const dashboard = await loaded(harness());
        const rules = () => JSON.parse(dashboard.element("assetRules").value);
        const control = (row: number, name: string, n = 0) =>
            named(dashboard.element("rules-body").children[row]!, name)[n]!;
        const ids = () => rules()[2].fares.map((fare: { id: string }) => fare.id);
        const checks: Record<string, () => void> = {
            assetId: () => {
                dashboard.element("rule-add-bitcoin").fire("click");
                dashboard.element("rule-add-any").fire("click");
                dashboard.element("rule-asset").value = sdkAssetId(TOKEN);
                dashboard.element("rule-add-asset").fire("click");
                expect(rules().map((rule: { assetId: unknown }) => rule.assetId)).toEqual([
                    null,
                    "*",
                    assetIdToWire(TOKEN),
                ]);
            },
            enabled: () => {
                control(1, "enabled").checked = false;
                control(1, "enabled").fire("change");
                expect(rules()[1].enabled).toBe(false);
            },
            claim: () => {
                expect(control(2, "claim").children.map((option) => option.value)).toEqual(
                    POLICY_VOCABULARY.claims,
                );
                for (const mode of POLICY_VOCABULARY.claims) {
                    control(2, "claim").value = mode;
                    control(2, "claim").fire("change");
                    expect(rules()[2].claim).toBe(mode);
                }
            },
            maxTopupSats: () => {
                control(2, "maxTopupSats").value = "250";
                control(2, "maxTopupSats").fire("change");
                expect(rules()[2].maxTopupSats).toBe("250");
            },
            fares: () => {
                control(2, "add-fare").fire("click");
                control(2, "id", 1).value = "vip";
                control(2, "id", 1).fire("change");
                expect(ids()).toEqual(["sats", "vip"]);
                control(2, "fare-up", 1).fire("click");
                expect(ids()).toEqual(["vip", "sats"]);
                control(2, "fare-down", 0).fire("click");
                expect(ids()).toEqual(["sats", "vip"]);
                control(2, "remove-fare", 1).fire("click");
                expect(ids()).toEqual(["sats"]);
            },
        };
        expect(Object.keys(checks).sort()).toEqual([...POLICY_VOCABULARY.ruleFields].sort());
        for (const field of POLICY_VOCABULARY.ruleFields) checks[field]!();
    });

    it("offers, explains and saves every fare currency and pricing kind", async () => {
        const admin = harness();
        const dashboard = await loaded(admin);
        const control = (name: string) =>
            named(dashboard.element("rules-body").children[0]!, name)[0]!;
        const set = (name: string, value: string) => {
            control(name).value = value;
            control(name).fire("change");
        };
        const options = (name: string) => control(name).children.map((option) => option.value);
        const fare = () => JSON.parse(dashboard.element("assetRules").value)[0].fares[0];
        dashboard.element("rule-add-any").fire("click");
        expect(options("currency")).toEqual(POLICY_VOCABULARY.currencies);
        expect(options("pricing")).toEqual(POLICY_VOCABULARY.pricings);
        for (const kind of POLICY_VOCABULARY.currencies)
            expect(helpText(`help-currency-${kind}`), kind).not.toBe("");
        for (const kind of POLICY_VOCABULARY.pricings)
            expect(helpText(`help-pricing-${kind}`), kind).not.toBe("");

        set("currency", "sameAsset");
        set("pricing", "proportional");
        set("percent", "0.5");
        set("min", "1");
        set("max", "1000");
        expect(fare()).toEqual({
            id: "asset",
            currency: { kind: "sameAsset" },
            pricing: { kind: "proportional", bps: 50, minUnits: "1", maxUnits: "1000" },
        });

        set("currency", "token");
        expect(options("pricing")).toEqual(["flat"]);
        set("token", sdkAssetId(TOKEN));
        set("units", "2");
        dashboard.element("policy-form").fire("submit");
        await vi.waitFor(() =>
            expect(dashboard.element("policy-note").textContent).toBe("request accepted"),
        );
        expect(admin.policy.get().assetRules[0]!.fares).toEqual([
            {
                id: "token",
                currency: { kind: "token", assetId: TOKEN },
                pricing: { kind: "flat", units: 2n },
            },
        ]);
        expect(control("token").value).toBe(sdkAssetId(TOKEN));
    });

    it("explains every claim mode where it is chosen, and every kind of payment", () => {
        for (const mode of POLICY_VOCABULARY.claims) {
            expect(helpText(`help-claim-${mode}`), mode).not.toBe("");
            expect(INDEX_HTML).toContain(`id="wiz-claim-${mode}"`);
        }
        const kinds = Object.entries(openApiDocument.paths)
            .filter(([path, item]) => "post" in item && !path.includes("{"))
            .map(([path]) => path.replace("/v1/", ""));
        expect(kinds.length).toBeGreaterThan(3);
        for (const kind of kinds) expect(helpText(`help-route-${kind}`), kind).not.toBe("");
    });

    it("shows every allowlisted config value with its variable and meaning", async () => {
        const dashboard = await loaded(harness());
        const body = dashboard.element("service-config");
        await vi.waitFor(() =>
            expect(body.children).toHaveLength(Object.keys(SHOWN_CONFIG).length),
        );
        const rows = body.children.map((row) => row.children.map((c) => c.textContent));
        Object.entries(SHOWN_CONFIG).forEach(([key, env], i) => {
            expect(rows[i]![0]).toBe(env ?? key + " (derived)");
            expect(rows[i]![2], key).not.toBe("");
        });
        expect(rows).toContainEqual([
            "TAXI_OPERATOR_MIN_RESERVE_SATS",
            "10 000",
            expect.stringMatching(/reserve|keeps/i),
        ]);
    });
});

describe("the wizard's asset fare", () => {
    const toStep3 = async () => {
        const admin = harness({ operationalSnapshot: () => readiness([]) });
        const dashboard = await loaded(admin, true);
        await vi.waitFor(() => expect(dashboard.element("wizard").open).toBe(true));
        dashboard.element("wiz-btc").checked = false;
        dashboard.element("wiz-any").checked = true;
        dashboard.element("wiz-next").fire("click");
        dashboard.element("wiz-next").fire("click");
        return {
            admin,
            dashboard,
            set: (id: string, value: string) => void (dashboard.element(id).value = value),
        };
    };
    const askAssetFare = (dashboard: Awaited<ReturnType<typeof toStep3>>["dashboard"]) => {
        dashboard.element("wiz-fare-asset").checked = true;
        dashboard.element("wiz-fare-asset").fire("change");
    };
    const save = async ({ admin, dashboard }: Awaited<ReturnType<typeof toStep3>>) => {
        dashboard.element("wiz-next").fire("click");
        const summary = dashboard.element("wiz-summary").textContent;
        dashboard.element("wiz-save").fire("click");
        await vi.waitFor(() => expect(admin.policy.get().assetRules).toHaveLength(1));
        return { summary, fares: admin.policy.get().assetRules[0]!.fares.map((f) => f.pricing) };
    };

    it("takes a percentage of its own and words it from the amount sent", async () => {
        const step = await toStep3();
        step.dashboard.element("wiz-fare-percent").fire("change");
        step.set("wiz-fare-pct", "1");
        step.set("wiz-fare-min", "2");
        askAssetFare(step.dashboard);
        expect(step.dashboard.element("wiz-asset-percent-fields").hidden).toBe(false);
        step.set("wiz-asset-pct", "0.5");
        step.set("wiz-asset-min", "100");
        step.set("wiz-asset-max", "5000");
        const { summary, fares } = await save(step);
        expect(summary).toContain(
            "Each payment pays 1% of the sats lent, at least 2 sats. Asset payments may instead pay 0.5% of the amount they send, at least 100 units and at most 5 000 units.",
        );
        expect(fares).toEqual([
            { kind: "proportional", bps: 100, minUnits: 2n, maxUnits: null },
            { kind: "proportional", bps: 50, minUnits: 100n, maxUnits: 5000n },
        ]);
    });

    it("takes a flat amount of its own, in units", async () => {
        const step = await toStep3();
        step.dashboard.element("wiz-fare-flat").fire("change");
        step.set("wiz-fare-flat-sats", "10");
        askAssetFare(step.dashboard);
        step.set("wiz-asset-flat-units", "3");
        const { summary, fares } = await save(step);
        expect(summary).toContain(
            "Each payment pays a fare of 10 sats. Asset payments may instead pay 3 units of the asset they send.",
        );
        expect(fares).toEqual([
            { kind: "flat", units: 10n },
            { kind: "flat", units: 3n },
        ]);
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

    it("lists warnings apart from the blockers, each with its advance", async () => {
        let warnings = [{ advanceId: "adv-unrolled", code: "covenant_unrolled", detail: "d" }];
        const dashboard = runDashboard(
            () => dashboardPage([], "b".repeat(64), null),
            harness({ operationalSnapshot: () => ({ ...readiness([]), warnings }) }),
            { realStatus: true },
        );
        const list = dashboard.element("readiness-warnings");
        const rendered = () =>
            list.children.map((item) => [
                item.textContent,
                ...item.children.map((c) => c.textContent),
            ]);

        await vi.waitFor(() => expect(list.children).toHaveLength(1));
        expect(list.hidden).toBe(false);
        expect(rendered()).toEqual([
            [
                dashboard.context.blockerText("covenant_unrolled"),
                "covenant_unrolled",
                "adv-unrolled",
            ],
        ]);
        expect(dashboard.element("step-connected-detail").children).toEqual([]);

        warnings = [];
        await dashboard.poll();
        expect(list.hidden).toBe(true);
        expect(rendered()).toEqual([]);
    });

    it("walks a fresh Taxi through the checklist and the setup wizard in one PATCH", async () => {
        const admin: Harness = harness({
            operationalSnapshot: (options) =>
                readiness([
                    ...(admin.policy.get().paused && !options?.ignoreManualPause
                        ? ["manual_pause"]
                        : []),
                    "operator_reserve_low",
                ]),
        });
        const before = admin.policy.get();
        const dashboard = runDashboard(() => dashboardPage([], "d".repeat(64), null), admin, {
            realStatus: true,
        });
        const text = (id: string) => dashboard.element(id).textContent;
        const click = (id: string) => dashboard.element(id).fire("click");
        const steps = ["connected", "fund", "limits", "carry", "live"];

        await vi.waitFor(() => expect(dashboard.element("wizard").open).toBe(true));
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
            "2 500 sats usable, below the 10 000 sats it must keep in reserve. Send it at least 7 500 sats more: offchain to its Arkade address, or on-chain to its boarding address.",
            "It lends nothing while any of the three limits is 0.",
            "It carries nothing until at least one rule is switched on.",
            "The Taxi is paused, so it refuses every new payment.",
        ]);
        expect(INDEX_HTML).toContain(
            "On-chain deposits move in automatically shortly after they confirm.",
        );
        expect(INDEX_HTML).toContain('href="#funding">Show addresses</a>');

        click("wiz-cancel");
        expect(dashboard.element("wizard").open).toBe(false);
        click("step-live-fix");
        expect(dashboard.element("go-live-confirm").hidden).toBe(false);
        expect(text("go-live-warning")).toBe(
            "Not done yet: fund your Taxi, set your limits, choose what to carry. It will refuse payments until they are.",
        );
        expect(dashboard.sent).toEqual([]);
        click("go-live-anyway");
        await vi.waitFor(() =>
            expect(text("setup-note")).toBe(
                "The Taxi cannot go live yet. The Taxi's spendable balance is below the reserve it must keep.",
            ),
        );
        expect(dashboard.sent.map((r) => r.path)).toEqual(["/admin/api/policy/resume"]);

        click("wizard-open");
        expect(dashboard.element("wizard").open).toBe(true);
        dashboard.element("wiz-btc").checked = true;
        dashboard.element("wiz-assets").value = sdkAssetId({
            txid: new Uint8Array(32).fill(0xab),
            groupIndex: 0,
        });
        click("wiz-next");
        dashboard.element("wiz-size-small").fire("change");
        expect(text("wiz-size-small-text")).toBe(
            "330 sats per payment · 33 000 sats in total · 100 payments at once",
        );
        click("wiz-next");
        dashboard.element("wiz-fare-free").fire("change");
        dashboard.element("wiz-claim-recycle").fire("change");
        click("wiz-next");
        expect(text("wiz-summary")).toBe(
            "Your Taxi will carry small bitcoin payments and 1 asset. It lends up to 330 sats per payment and 33 000 sats in total, to at most 100 payments at once. Payers pay no fare. When a receiver claims, they repay the lent sats, so your Taxi gets them back.",
        );
        click("wiz-save-live");
        await vi.waitFor(() => expect(text("step-live-state")).toBe("Done"));

        expect(dashboard.element("wizard").open).toBe(false);
        expect(dashboard.sent.filter((r) => r.method === "PATCH")).toHaveLength(1);
        const rule = {
            enabled: true,
            fares: [
                { id: "sats", currency: { kind: "sats" }, pricing: { kind: "flat", units: 0n } },
            ],
            claim: "recycle",
            maxTopupSats: null,
        };
        expect(admin.policy.get()).toEqual({
            ...before,
            paused: false,
            maxPerPaymentTopupSats: DUST,
            maxOutstandingSats: 100n * DUST,
            maxConcurrentAdvances: 100,
            assetRules: [
                { assetId: null, ...rule },
                { assetId: { txid: new Uint8Array(32).fill(0xab), groupIndex: 0 }, ...rule },
            ],
        });
        expect(["limits", "carry"].map((step) => text(`step-${step}-state`))).toEqual([
            "Done",
            "Done",
        ]);

        click("wizard-open");
        for (let n = 0; n < 3; n++) click("wiz-next");
        expect(dashboard.element("wiz-save-live").hidden).toBe(true);
        expect(text("wiz-save-hint")).toBe("Save keeps your Taxi live.");
        click("wiz-save");
        await vi.waitFor(() => expect(text("setup-note")).toBe("Saved. Your Taxi is still live."));
        expect(admin.policy.get().paused).toBe(false);
    });

    it("explains refused changes in plain words and keeps the raw error for support", async () => {
        const dashboard = runDashboard(() => dashboardPage([], "e".repeat(64), null));
        const note = dashboard.element("policy-note");
        const raw = () => note.children[0]?.children[1]?.textContent;
        await vi.waitFor(() =>
            expect(dashboard.element("policy-loaded").textContent).toMatch(/^loaded/),
        );

        dashboard.element("locktimeMarginBlocks").value = "10";
        dashboard.element("policy-form").fire("submit");
        await vi.waitFor(() =>
            expect(note.textContent).toBe(
                "Each locktime margin must be larger than the Taxi's recovery budget, set by TAXI_RECOVERY_BROADCAST_BLOCKS and TAXI_RECOVERY_BROADCAST_SECONDS.",
            ),
        );
        expect(raw()).toBe("policy margin must exceed the configured recovery execution budget");

        dashboard.element("locktimeMarginBlocks").value = "144";
        dashboard.element("maxOutstandingSats").value = "lots";
        dashboard.element("policy-form").fire("submit");
        await vi.waitFor(() =>
            expect(note.textContent).toBe("Max outstanding must be a whole number of sats."),
        );
        expect(raw()).toMatch(/^maxOutstandingSats: expected a decimal sats amount/);

        const broken = runDashboard(
            () => dashboardPage([], "f".repeat(64), null),
            harness({
                funding: async () => {
                    throw new Error("indexer timeout");
                },
            }),
        );
        await vi.waitFor(() =>
            expect(broken.element("funding-state").textContent).toBe(
                "The Taxi cannot read its wallet right now.",
            ),
        );
        expect(broken.element("funding-state").title).toBe("funding_unavailable: indexer timeout");
    });

    it("offers TAXI_ADMIN_OPERATOR when no operator identity arrived", () => {
        const { context } = runDashboard(() => dashboardPage([], "d".repeat(64), null));
        const error = {
            status: 400,
            message: "header x-taxi-operator: operator identity is required",
        };

        expect(context.explain(error).text).toBe(
            "The console could not tell who you are: the proxy in front of it must send the operator header; or set TAXI_ADMIN_OPERATOR on the Taxi itself.",
        );
    });

    it("does not offer it when an identity arrived and was refused", () => {
        const { context } = runDashboard(() => dashboardPage([], "d".repeat(64), null));

        for (const reason of ["too long", "invalid"])
            expect(
                context.explain({
                    status: 400,
                    message: `header x-taxi-operator: operator identity is ${reason}`,
                }).text,
                reason,
            ).toBe(
                "The console could not tell who you are: the proxy in front of it must send the operator header.",
            );
    });
});
