import { describe, expect, it, vi } from "vitest";
import { DustCovenantScript, type DustCovenantParams } from "@arkade-taxi/covenant";
import { bytesToHex } from "@arkade-taxi/protocol";
import {
    DelegateeClient,
    delegationVariables,
    registerRenewal,
    renewalTemplate,
} from "../src/delegatee.js";
import { config, emulatorKey, operatorKey, receiverKey, senderKey, serverKey } from "./fixtures.js";

const DEADLINE = 1_800_000_000n;

const v2Params = (): DustCovenantParams => ({
    receiverKey,
    senderKey,
    operatorKey,
    operatorSignerKey: config().operatorSignerKey,
    exitDelay: config().exitDelay,
    dust: 330n,
    topup: 330n,
    locktime: DEADLINE,
    claimMode: "recycle",
    covenantVersion: 2,
});

const covenantAddress = (params: DustCovenantParams): string =>
    new DustCovenantScript({
        params,
        serverKey,
        emulatorKey,
        vtxoMinAmount: 330n,
    })
        .address("ark", serverKey)
        .encode();

const json = (body: unknown) =>
    ({ ok: true, status: 200, json: async () => body }) as unknown as Response;

describe("delegatee registration", () => {
    it("fails the lockup when the returned address differs from the Taxi's derivation", async () => {
        const params = v2Params();
        const delegate = vi.fn(async () => "ark1qstranger");
        await expect(
            registerRenewal(
                { delegate },
                { artifactId: "a".repeat(64), templateId: "b".repeat(64) },
                {
                    params,
                    serverKey,
                    covenantAddress: covenantAddress(params),
                    renewalBeforeExpirySeconds: 259_200n,
                    expiresAt: 1_900_000_000,
                },
            ),
        ).rejects.toThrow(/delegatee derives ark1qstranger/);
        expect(delegate).toHaveBeenCalledOnce();
    });

    it("accepts the registration when the two derivations agree", async () => {
        const params = v2Params();
        const address = covenantAddress(params);
        await expect(
            registerRenewal(
                { delegate: async () => address },
                { artifactId: "a".repeat(64), templateId: "b".repeat(64) },
                {
                    params,
                    serverKey,
                    covenantAddress: address,
                    renewalBeforeExpirySeconds: 259_200n,
                    expiresAt: 1_900_000_000,
                },
            ),
        ).resolves.toBeUndefined();
    });

    it("binds every constructor field to a variable the template declares", () => {
        const template = JSON.parse(renewalTemplate("c".repeat(64)));
        const args = template.inputs[0].contract.arguments as Record<string, string>;
        const variables = template.variables as Record<string, string>;
        const sent = delegationVariables(v2Params(), serverKey, 259_200n);
        expect(Object.keys(variables).sort()).toEqual(Object.keys(sent).sort());
        for (const [field, placeholder] of Object.entries(args))
            expect(variables[placeholder.slice(1, -1)]).toBeDefined();
        expect(args.receiverKey).toBe("<receiver_key>");
        expect(template.inputs[0].spend).toEqual({ function: "renew", leaf: "renew" });
        expect(template.inputs[0].schedule).toEqual({
            before_expiry_seconds: "<renewal_window>",
        });
    });

    it("sends a pubkey as 33 compressed bytes and an int as a minimal number", () => {
        const sent = delegationVariables(v2Params(), serverKey, 259_200n);
        expect(sent.receiver_key).toBe(`02${bytesToHex(receiverKey)}`);
        // 1800000000 = 0x6b49d200 little-endian; 0x6b's high bit is clear, so
        // the sign-magnitude form needs no trailing pad byte.
        expect(sent.locktime).toBe("00d2496b");
        // No asset: zero is the empty number, which the delegatee reads back as 0.
        expect(sent.has_asset).toBe("");
        expect(sent.asset_txid).toBe("00".repeat(32));
    });

    it("registers the artifact before the template that references it", async () => {
        const seen: string[] = [];
        const fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
            const path = String(url);
            seen.push(path);
            const body = JSON.parse(String(init?.body)) as { document: string };
            if (path.endsWith("/v1/artifact")) {
                expect(JSON.parse(body.document).contractName).toBe("DustCovenant");
                return json({ artifact: { id: "a".repeat(64) } });
            }
            expect(JSON.parse(body.document).inputs[0].contract.definition.artifact).toBe(
                "a".repeat(64),
            );
            return json({ template: { id: "b".repeat(64) } });
        });
        const client = new DelegateeClient({
            baseUrl: "https://delegatee.example/",
            fetch: fetch as unknown as typeof globalThis.fetch,
        });
        await expect(client.register()).resolves.toEqual({
            artifactId: "a".repeat(64),
            templateId: "b".repeat(64),
        });
        expect(seen).toEqual([
            "https://delegatee.example/v1/artifact",
            "https://delegatee.example/v1/template",
        ]);
    });

    it("refuses a registration the delegatee answers without an id", async () => {
        const client = new DelegateeClient({
            baseUrl: "https://delegatee.example",
            fetch: (async () => json({ artifact: {} })) as unknown as typeof globalThis.fetch,
        });
        await expect(client.register()).rejects.toThrow(/no artifact id/);
    });
});

describe("delegation monitoring", () => {
    it("reads the renewal history by address without spending anything", async () => {
        const fetch = vi.fn(async () =>
            json({
                delegation: { status: "active" },
                renewals: [
                    { success: true, attempted_at: 100 },
                    { success: false, error: "no connector available", attempted_at: 200 },
                ],
            }),
        );
        const client = new DelegateeClient({
            baseUrl: "https://delegatee.example",
            fetch: fetch as unknown as typeof globalThis.fetch,
        });

        await expect(client.getDelegation("ark1qcovenant")).resolves.toEqual({
            status: "active",
            attempts: 2,
            succeeded: 1,
            lastAttemptAt: 200,
            lastError: "no connector available",
        });
        expect(fetch.mock.calls[0]).toEqual([
            "https://delegatee.example/v1/delegate/ark1qcovenant",
            { method: "GET" },
        ]);
    });

    it("reports a delegation the delegatee has never renewed", async () => {
        const client = new DelegateeClient({
            baseUrl: "https://delegatee.example",
            fetch: (async () =>
                json({
                    delegation: { status: "cancelled" },
                })) as unknown as typeof globalThis.fetch,
        });
        await expect(client.getDelegation("ark1qcovenant")).resolves.toEqual({
            status: "cancelled",
            attempts: 0,
            succeeded: 0,
        });
    });
});
