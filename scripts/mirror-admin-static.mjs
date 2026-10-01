// Regenerates packages/app/src/admin/static.ts from static/{index.html,styles.css,app.js}.
// Usage: node scripts/mirror-admin-static.mjs
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const dir = join(dirname(fileURLToPath(import.meta.url)), "../packages/app/src/admin");
const target = join(dir, "static.ts");
const read = (name) =>
    readFileSync(join(dir, "static", name), "utf8")
        .split("\r\n")
        .join("\n");
const literal = (s) => s.replace(/\\/g, "\\\\").replace(/`/g, "\\`").replace(/\$\{/g, "\\${");

const current = readFileSync(target, "utf8");
const head = current.slice(0, current.indexOf("export const INDEX_HTML = `"));
const tail = current.slice(current.indexOf("\nconst serve = "));

const out =
    head +
    "export const INDEX_HTML = `" +
    literal(read("index.html")) +
    "`;\n\n" +
    "export const STYLES_CSS = `" +
    literal(read("styles.css")) +
    "`;\n\n" +
    "export const APP_JS = `" +
    literal(read("app.js")) +
    "`;\n" +
    tail;
writeFileSync(target, out);
console.log(out === current ? "unchanged" : "rewritten");
