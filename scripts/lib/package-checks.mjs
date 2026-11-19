import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

const modulesUnder = (root, extension) => {
    const found = [];
    const walk = (dir, base) => {
        for (const entry of readdirSync(dir, { withFileTypes: true }))
            if (entry.isDirectory()) walk(join(dir, entry.name), `${base}${entry.name}/`);
            else if (entry.name.endsWith(extension) && !entry.name.endsWith(".d.ts"))
                found.push(`${base}${entry.name.slice(0, -extension.length)}`);
    };
    if (existsSync(root)) walk(root, "");
    return found.sort();
};

/** Why this package's `dist/` does not correspond to its `src/`, or `undefined`. */
export function distMismatch(packageRoot) {
    const sources = modulesUnder(join(packageRoot, "src"), ".ts");
    const emitted = modulesUnder(join(packageRoot, "dist"), ".js");
    const orphan = emitted.find((name) => !sources.includes(name));
    if (orphan !== undefined)
        return `dist/${orphan}.js has no src/${orphan}.ts, so it is output from another tree`;
    const missing = sources.find((name) => !emitted.includes(name));
    if (missing !== undefined) return `src/${missing}.ts emitted no dist/${missing}.js`;
    return sources.length ? undefined : `${packageRoot} has no src/ to trace dist/ back to`;
}
