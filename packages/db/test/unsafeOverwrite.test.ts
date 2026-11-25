import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

const packages = fileURLToPath(new URL("../../", import.meta.url));

it("names the unguarded full-row overwrite nowhere in source but its declaration", () => {
    const uses = readdirSync(packages).flatMap((name) => {
        const src = join(packages, name, "src");
        return readdirSync(src, { recursive: true, encoding: "utf8" })
            .filter((file) => file.endsWith(".ts"))
            .flatMap((file) =>
                [...readFileSync(join(src, file), "utf8").matchAll(/\bunsafeOverwrite\b/g)].map(
                    () => `${name}/src/${file.replaceAll("\\", "/")}`,
                ),
            );
    });
    expect(uses).toEqual(["db/src/advances.ts"]);
});
