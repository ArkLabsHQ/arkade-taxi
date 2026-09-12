import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";
import { copyByteView } from "../src/signer.js";

describe("copyByteView", () => {
    it("copies local, cross-realm, and Buffer Uint8Array values", () => {
        const local = new Uint8Array([1, 2, 3]);
        const crossRealm = runInNewContext("new Uint8Array([1, 2, 3])") as Uint8Array;
        const buffer = Buffer.from([1, 2, 3]);

        for (const value of [local, crossRealm, buffer]) {
            const copy = copyByteView(value, "test bytes");
            expect(copy).toEqual(new Uint8Array([1, 2, 3]));
            expect(Object.getPrototypeOf(copy)).toBe(Uint8Array.prototype);
            expect(copy).not.toBe(value);
        }
    });

    it("rejects other views, spoofs, and proxies", () => {
        const spoof = { [Symbol.toStringTag]: "Uint8Array", length: 3, 0: 1, 1: 2, 2: 3 };
        const proxy = new Proxy(new Uint8Array([1, 2, 3]), {});
        for (const value of [new Uint16Array([1, 2]), spoof, proxy]) {
            expect(() => copyByteView(value, "test bytes")).toThrow(/test bytes/i);
        }
    });
});
