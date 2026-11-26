import { expect, it } from "vitest";
import { openDatabase } from "../src/index";
import { COLUMNS } from "../src/advances";

it("binds every column of the advances table, and nothing else", () => {
    const db = openDatabase(":memory:");
    try {
        const names = db
            .prepare<[], { name: string }>("SELECT name FROM pragma_table_info('advances')")
            .all()
            .map(({ name }) => name);
        expect([...COLUMNS].sort()).toEqual(names.sort());
    } finally {
        db.close();
    }
});
