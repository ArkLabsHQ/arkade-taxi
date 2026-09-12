import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";
import { describe, expect, it, vi } from "vitest";
import { APP_JS, INDEX_HTML, STYLES_CSS } from "../../src/admin/static.js";
import { harness } from "./fixtures.js";

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

function runDashboard(fetchAdvances: (path: string) => unknown | Promise<unknown>) {
    const elements = new Map<string, DashboardElement>();
    const element = (id: string) => {
        if (!elements.has(id)) elements.set(id, new DashboardElement());
        return elements.get(id)!;
    };
    const requests: string[] = [];
    const response = (body: unknown) => ({
        ok: true,
        status: 200,
        statusText: "OK",
        text: async () => JSON.stringify(body),
    });
    const fetch = async (path: string) => {
        requests.push(path);
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
        body: new DashboardElement(),
        title: "",
        hidden: false,
        getElementById: element,
        createElement: () => new DashboardElement(),
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
        Map,
        Array,
        String,
    });
    const renderedIds = () =>
        element("advances-body").children.map((row) => row.children[0]?.title);
    return { element, renderedIds, requests };
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
});
