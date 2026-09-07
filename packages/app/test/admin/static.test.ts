import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { APP_JS, INDEX_HTML, STYLES_CSS } from "../../src/admin/static.js";
import { harness } from "./fixtures.js";

const asset = (name: string): string =>
    readFileSync(fileURLToPath(new URL(`../../src/admin/static/${name}`, import.meta.url)), "utf8")
        .split("\r\n")
        .join("\n");

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
});
