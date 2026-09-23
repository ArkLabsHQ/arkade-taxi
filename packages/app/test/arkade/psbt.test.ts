import { describe, expect, it } from "vitest";
import { Transaction } from "@arkade-os/sdk";
import { base64 } from "@scure/base";
import { buildLockupEnvelope } from "../../src/arkade/lockupBuilder.js";
import {
    decodeLockupEnvelope,
    parseLockupEnvelope,
    unsignedGraphId,
} from "../../src/arkade/psbt.js";
import { config } from "../fixtures.js";
import { buildRequest, unroll } from "./lockupFixtures.js";

describe("independent envelope validation", () => {
    it("rejects a recomputed hash with a below-minimum fare independently", () => {
        const req = buildRequest();
        const wire = JSON.parse(
            Buffer.from(base64.decode(buildLockupEnvelope(req, config(), unroll))).toString(),
        );
        const tx = Transaction.fromPSBT(base64.decode(wire.arkTx));
        tx.updateOutput(1, { amount: 9n });
        tx.updateOutput(2, { amount: 761n });
        wire.arkTx = base64.encode(tx.toPSBT());
        wire.unsignedTxId = unsignedGraphId(
            tx,
            wire.checkpoints.map((s: string) => Transaction.fromPSBT(base64.decode(s))),
        );
        expect(() =>
            parseLockupEnvelope(
                base64.encode(Buffer.from(JSON.stringify(wire))),
                req,
                config(),
                unroll,
            ),
        ).toThrow(/minimum/);
    });
    it("rejects an output substitution even if the attacker recomputes the hash", () => {
        const req = buildRequest();
        const wire = JSON.parse(
            Buffer.from(base64.decode(buildLockupEnvelope(req, config(), unroll))).toString(),
        );
        const tx = Transaction.fromPSBT(base64.decode(wire.arkTx));
        tx.updateOutput(2, { script: tx.getOutput(0).script });
        wire.arkTx = base64.encode(tx.toPSBT());
        wire.unsignedTxId = unsignedGraphId(
            tx,
            wire.checkpoints.map((s: string) => Transaction.fromPSBT(base64.decode(s))),
        );
        expect(() =>
            parseLockupEnvelope(
                base64.encode(Buffer.from(JSON.stringify(wire))),
                req,
                config(),
                unroll,
            ),
        ).toThrow(/script mismatch/);
    });
    it("accepts the canonical graph regardless of JSON formatting", () => {
        const req = buildRequest();
        const encoded = buildLockupEnvelope(req, config(), unroll);
        const wire = JSON.parse(Buffer.from(base64.decode(encoded)).toString());
        const formatted = base64.encode(Buffer.from(JSON.stringify(wire, null, 4)));
        expect(parseLockupEnvelope(formatted, req, config(), unroll).unsignedTxId).toBe(
            wire.unsignedTxId,
        );
    });
    it.each([
        "ownership",
        "outpoint",
        "amount",
        "leaf",
        "tree",
        "output",
        "checkpoint",
        "expiry",
        "hash",
        "index",
    ])("rejects mutated %s", (field) => {
        const req = buildRequest();
        const wire = JSON.parse(
            Buffer.from(base64.decode(buildLockupEnvelope(req, config(), unroll))).toString(),
        );
        if (field === "ownership") wire.operatorInputIndexes = [0];
        if (field === "checkpoint") wire.checkpoints.pop();
        if (field === "hash") wire.unsignedTxId = "00".repeat(32);
        if (field === "index") wire.covenantOutputIndex = 1;
        if (field === "expiry") wire.senderInputs[0].expiry.kind = "time";
        if (["outpoint", "amount", "leaf", "tree"].includes(field)) {
            const cp = Transaction.fromPSBT(base64.decode(wire.checkpoints[0]));
            if (field === "outpoint") cp.updateInput(0, { index: 1 });
            if (field === "amount")
                cp.updateInput(0, {
                    witnessUtxo: { ...cp.getInput(0).witnessUtxo!, amount: 101n },
                });
            if (field === "leaf") cp.updateInput(0, { tapLeafScript: undefined });
            if (field === "tree") cp.updateInput(0, { unknown: undefined });
            wire.checkpoints[0] = base64.encode(cp.toPSBT());
        }
        if (field === "output") {
            const tx = Transaction.fromPSBT(base64.decode(wire.arkTx));
            tx.updateOutput(1, { amount: 9n });
            wire.arkTx = base64.encode(tx.toPSBT());
        }
        expect(() =>
            parseLockupEnvelope(
                base64.encode(Buffer.from(JSON.stringify(wire))),
                req,
                config(),
                unroll,
            ),
        ).toThrow();
    });
});

describe("envelope duplicate-key check against seeded random JSON", () => {
    type Json = { obj: [string, Json][] } | { arr: Json[] } | { str: string } | { lit: string };
    type Obj = { obj: [string, Json][] };
    // Decoded text: JSON syntax, escape-shaped text, a lone surrogate and an astral pair.
    const FRAGMENTS = [
        ...["a", "b", "u0061", "\\u0061", '":"', '"', "\\", "/", ":", ",", "{", "}", "[", "]"],
        ...[" ", "\n", "\t", "\b", "\u0000", "\u001f", "é", " ", "\ud800", "😀"],
    ];
    const SHORT: Record<string, string> = {
        '"': '\\"',
        "\\": "\\\\",
        "/": "\\/",
        "\b": "\\b",
        "\f": "\\f",
        "\n": "\\n",
        "\r": "\\r",
        "\t": "\\t",
    };
    const REQUIRED: [string, Json][] = [
        ["senderInputs", { arr: [] }],
        ["operatorInputs", { arr: [] }],
        ["checkpoints", { arr: [] }],
        ["unsignedTxId", { str: "00".repeat(32) }],
    ];

    const generator = (seed: number) => {
        let state = seed >>> 0;
        const rng = () => {
            state = (state + 0x6d2b79f5) >>> 0;
            let t = Math.imul(state ^ (state >>> 15), 1 | state);
            t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
            return ((t ^ (t >>> 14)) >>> 0) / 2 ** 32;
        };
        const int = (n: number) => Math.floor(rng() * n);
        const pick = <T>(xs: readonly T[]): T => xs[int(xs.length)]!;
        const ws = () => pick(["", "", " ", "\n", "\t", "\r\n  "]);
        const text = () => Array.from({ length: int(5) }, () => pick(FRAGMENTS)).join("");
        const unit = (code: number) => {
            const digits = code.toString(16).padStart(4, "0");
            return `\\u${rng() < 0.5 ? digits : digits.toUpperCase()}`;
        };
        const encode = (value: string) =>
            `"${Array.from(value, (ch) => {
                const code = ch.codePointAt(0)!;
                if (code > 0xffff)
                    return rng() < 0.5 ? ch : unit(ch.charCodeAt(0)) + unit(ch.charCodeAt(1));
                const must = code < 0x20 || ch === '"' || ch === "\\" || (code & 0xf800) === 0xd800;
                if (!must && rng() < 0.6) return ch;
                return SHORT[ch] !== undefined && rng() < 0.5 ? SHORT[ch] : unit(code);
            }).join("")}"`;
        const object = (depth: number, taken: Set<string>): Obj => {
            const members: [string, Json][] = [];
            for (let i = int(5); i > 0; i--) {
                const key = text();
                if (taken.has(key)) continue;
                taken.add(key);
                members.push([key, value(depth)]);
            }
            return { obj: members };
        };
        const value = (depth: number): Json => {
            const r = rng();
            if (depth > 0 && r < 0.3) return object(depth - 1, new Set());
            if (depth > 0 && r < 0.5)
                return { arr: Array.from({ length: int(4) }, () => value(depth - 1)) };
            return r < 0.8 ? { str: text() } : { lit: pick(["0", "-1", "1.5e3", "true", "null"]) };
        };
        const serialize = (node: Json): string => {
            if ("obj" in node)
                return `{${ws()}${node.obj
                    .map(([k, v]) => `${ws()}${encode(k)}${ws()}:${ws()}${serialize(v)}${ws()}`)
                    .join(",")}}`;
            if ("arr" in node) return `[${ws()}${node.arr.map(serialize).join(`${ws()},`)}]`;
            return "str" in node ? encode(node.str) : node.lit;
        };
        const envelope = (): Obj => {
            const extra = object(5, new Set(REQUIRED.map(([k]) => k))).obj;
            const members = [...REQUIRED, ...extra];
            for (let i = members.length - 1; i > 0; i--) {
                const j = int(i + 1);
                [members[i], members[j]] = [members[j]!, members[i]!];
            }
            return { obj: members };
        };
        return { int, pick, value, serialize, envelope };
    };

    const objectsIn = (node: Json, out: Obj[] = []): Obj[] => {
        if ("obj" in node) out.push(node);
        const children = "obj" in node ? node.obj.map(([, v]) => v) : "arr" in node ? node.arr : [];
        for (const child of children) objectsIn(child, out);
        return out;
    };
    const b64 = (json: string) => Buffer.from(json, "utf8").toString("base64");
    const SEEDS = Array.from({ length: 400 }, (_, i) => 0x5eed + i);

    it("fires on a duplicate key at any depth, however either copy is escaped", () => {
        let nested = 0;
        for (const seed of SEEDS) {
            const g = generator(seed);
            const doc = g.envelope();
            const holders = objectsIn(doc).filter((o) => o.obj.length > 0);
            const target = g.pick(holders);
            if (target !== doc) nested++;
            const [key] = g.pick(target.obj);
            target.obj.splice(g.int(target.obj.length + 1), 0, [key, g.value(2)]);
            const json = g.serialize(doc);
            expect(() => JSON.parse(json), `seed ${seed}`).not.toThrow();
            expect(() => decodeLockupEnvelope(b64(json)), `seed ${seed}: ${json}`).toThrow(
                /duplicate envelope key/,
            );
        }
        expect(nested).toBeGreaterThan(SEEDS.length / 4);
    });

    it("accepts every duplicate-free document exactly as JSON.parse reads it", () => {
        for (const seed of SEEDS) {
            const g = generator(seed);
            const json = g.serialize(g.envelope());
            expect(decodeLockupEnvelope(b64(json)), `seed ${seed}: ${json}`).toEqual(
                JSON.parse(json),
            );
        }
    });
});
