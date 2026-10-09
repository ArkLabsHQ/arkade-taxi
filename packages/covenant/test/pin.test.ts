import { describe, expect, it } from "vitest";
import { payoutPkScript } from "../src/pin.js";

const key = new Uint8Array(32).fill(0xab);

describe("payoutPkScript", () => {
    it("is P2TR at or above dust", () => {
        expect(payoutPkScript(key, 330n, 330n)).toEqual(new Uint8Array([0x51, 0x20, ...key]));
    });

    // The artifact pins a sub-dust payout by sha256 of its OP_RETURN form, so
    // the script a spender builds must take that form, not a witness program.
    it("is OP_RETURN plus a 32-byte push below dust", () => {
        expect(payoutPkScript(key, 100n, 330n)).toEqual(new Uint8Array([0x6a, 0x20, ...key]));
    });
});
