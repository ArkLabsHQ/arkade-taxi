import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";

// A build can leave files from an unmerged branch in `dist/`; `tsup --clean`
// removes them, and the source maps are what let this prove it.
const sourcesUnder = (root) => {
    const found = [];
    const walk = (dir, base) => {
        for (const entry of readdirSync(dir, { withFileTypes: true }))
            if (entry.isDirectory()) walk(join(dir, entry.name), `${base}${entry.name}/`);
            else if (entry.name.endsWith(".ts")) found.push(`${base}${entry.name}`);
    };
    if (existsSync(root)) walk(root, "");
    return found.sort();
};

const mappedSources = (dist) => {
    const mapped = new Set();
    const unmapped = [];
    const walk = (dir) => {
        for (const entry of readdirSync(dir, { withFileTypes: true })) {
            if (entry.isDirectory()) walk(join(dir, entry.name));
            else if (entry.name.endsWith(".js") && !existsSync(join(dir, `${entry.name}.map`)))
                unmapped.push(join(dir, entry.name));
            else if (entry.name.endsWith(".js.map"))
                for (const source of JSON.parse(readFileSync(join(dir, entry.name), "utf8"))
                    .sources)
                    mapped.add(resolve(dir, source));
        }
    };
    if (existsSync(dist)) walk(dist);
    return { mapped, unmapped };
};

/** Why this package's `dist/` does not correspond to its `src/`, or `undefined`. */
export function distMismatch(packageRoot) {
    const src = join(packageRoot, "src");
    const sources = sourcesUnder(src);
    const { mapped, unmapped } = mappedSources(join(packageRoot, "dist"));
    if (unmapped.length)
        return `${unmapped[0].replaceAll("\\", "/")} has no source map to trace it to src/`;
    const known = new Set(sources.map((name) => join(src, name)));
    const orphan = [...mapped].find((file) => !known.has(file) && !file.includes("node_modules"));
    if (orphan !== undefined)
        return `dist/ maps ${orphan.replaceAll("\\", "/")}, which is not in src/, so it is output from another tree`;
    return sources.length ? undefined : `${packageRoot} has no src/ to trace dist/ back to`;
}
