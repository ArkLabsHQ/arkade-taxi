import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { DustCovenantScript } from "@arkade-taxi/covenant";
import { covenantParamsOf } from "@arkade-taxi/core";
import { bytesToHex } from "@arkade-taxi/protocol";
import {
    DelegateeClient,
    DelegateeError,
    delegationRenewal,
    registerRenewal,
    renewalTemplate,
    renewalTemplateId,
    renewalVariables,
    TemplateMismatchError,
    TemplateRefusedError,
} from "../src/delegatee.js";
import {
    advance,
    config,
    emulatorKey,
    NOW,
    operatorKey,
    receiverKey,
    senderKey,
    serverKey,
    V2_DEADLINE,
    VTXO_MIN,
} from "./fixtures.js";

const covenant = new DustCovenantScript({
    params: {
        receiverKey,
        senderKey,
        operatorKey,
        operatorSignerKey: config().operatorSignerKey,
        exitDelay: config().exitDelay,
        dust: 330n,
        topup: 330n,
        locktime: 1_800_000_000n,
        claimMode: "recycle",
    },
    serverKey,
    emulatorKey,
    vtxoMinAmount: 330n,
});
const covenantAddress = covenant.address("ark", serverKey).encode();

const json = (body: unknown) =>
    ({ ok: true, status: 200, json: async () => body }) as unknown as Response;
const grpcError = (status: number, code: number, message: string) =>
    ({
        ok: false,
        status,
        text: async () => JSON.stringify({ code, message, details: [] }),
    }) as unknown as Response;
const notFound = () => grpcError(404, 5, "template not found");

const fixture = (name: string): Buffer =>
    readFileSync(new URL(`./fixtures/executor-v0.0.5/${name}`, import.meta.url));
// Computed by executor v0.0.5 `template.Decode`, which also wrote the canonical fixture.
const RENEW_TEMPLATE_ID = "6eb1a0333929e447ad37b927df3c8ea5073ec82da1186e6b45ef9dcf6e070673";

type Schema = { properties: Record<string, { $ref?: string }> };
type Operation = {
    parameters?: { name: string; in: string }[];
    requestBody?: { content: { "application/json": { schema: { $ref: string } } } };
};
const spec = JSON.parse(fixture("service.openapi.json").toString()) as {
    paths: Record<string, Record<string, Operation>>;
    components: { schemas: Record<string, Schema> };
};
const schema = (name: string): Schema =>
    spec.components.schemas[name.replace("#/components/schemas/", "")]!;
const route = (pathname: string): string =>
    Object.keys(spec.paths).find((path) =>
        new RegExp(`^${path.replace(/\{\w+\}/g, "[^/]+")}$`).test(pathname),
    ) ?? pathname;

describe("executor v0.0.5 fixtures", () => {
    it("holds the service spec exactly as tagged", () => {
        const bytes = fixture("service.openapi.json");
        const blob = createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes);
        expect(blob.digest("hex")).toBe("d7e447bd929a951ffc9c2787f1d71c5fcad5f32d");
    });

    it("records the template id as the hash of the document's canonical form", () => {
        const canonical = fixture("renew.template.canonical.json");
        expect(createHash("sha256").update(canonical).digest("hex")).toBe(RENEW_TEMPLATE_ID);
        expect(JSON.parse(canonical.toString())).toEqual(
            JSON.parse(fixture("renew.template.json").toString()),
        );
    });

    it("builds the template document the fixture pins, byte for byte", () => {
        expect(renewalTemplate()).toBe(fixture("renew.template.json").toString());
    });

    it("derives the id v0.0.5 stores that document under", () => {
        expect(renewalTemplateId()).toBe(RENEW_TEMPLATE_ID);
    });

    it("calls only routes, parameters and request keys the spec declares", async () => {
        const calls: { method: string; url: URL; body?: Record<string, unknown> }[] = [];
        const fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
            calls.push({
                method: init?.method ?? "GET",
                url: new URL(String(url)),
                ...(init?.body ? { body: JSON.parse(String(init.body)) } : {}),
            });
            if (calls.length === 1) return notFound();
            return json({
                template: { id: RENEW_TEMPLATE_ID },
                delegation: { inputs: [{ address: covenantAddress }] },
            });
        });
        const client = new DelegateeClient({
            baseUrl: "https://executor.example",
            fetch: fetch as unknown as typeof globalThis.fetch,
        });
        await client.register();
        await client.delegate(RENEW_TEMPLATE_ID, renewalVariables(covenant, 1n), 1_900_000_000);
        await client.getDelegation(covenantAddress);

        expect(calls.map(({ method, url }) => `${method} ${route(url.pathname)}`)).toEqual([
            "GET /v1/template/{id}",
            "POST /v1/template",
            "POST /v1/delegation",
            "GET /v1/delegation",
        ]);
        for (const { method, url, body } of calls) {
            const operation = spec.paths[route(url.pathname)]![method.toLowerCase()]!;
            const query = (operation.parameters ?? []).filter((p) => p.in === "query");
            expect([...url.searchParams.keys()]).toEqual(query.map((p) => p.name));
            if (!body) continue;
            const request = schema(operation.requestBody!.content["application/json"].schema.$ref);
            expect(Object.keys(body).filter((key) => !(key in request.properties))).toEqual([]);
        }
        expect(calls[2]!.body).toEqual({
            templateId: RENEW_TEMPLATE_ID,
            variables: renewalVariables(covenant, 1n),
            expiresAt: 1_900_000_000,
        });
    });

    it("reads only response fields the spec declares", () => {
        const fields = (name: string) => Object.keys(schema(name).properties);
        expect(fields("RegisterTemplateResponse")).toContain("template");
        expect(fields("GetTemplateResponse")).toContain("template");
        expect(fields("Template")).toEqual(expect.arrayContaining(["id", "status"]));
        expect(fields("RegisterDelegationResponse")).toContain("delegation");
        expect(fields("Delegation")).toEqual(
            expect.arrayContaining(["status", "expiresAt", "inputs"]),
        );
        expect(fields("Input")).toContain("address");
        expect(fields("GetDelegationResponse")).toEqual(["coins", "delegation"]);
        expect(fields("Coin")).toEqual(
            expect.arrayContaining(["outpoint", "amount", "status", "expiresAt", "due", "spentBy"]),
        );
    });
});

describe("delegatee registration", () => {
    it("refuses a delegation whose address differs from the Taxi's derivation", async () => {
        const delegate = vi.fn(async () => "ark1qstranger");
        await expect(
            registerRenewal(
                { delegate },
                { templateId: RENEW_TEMPLATE_ID },
                {
                    covenant,
                    covenantAddress,
                    renewalBeforeExpirySeconds: 259_200n,
                    expiresAt: 1_900_000_000,
                },
            ),
        ).rejects.toThrow(/delegatee derives ark1qstranger/);
        expect(delegate).toHaveBeenCalledOnce();
    });

    it("accepts the delegation when the two derivations agree", async () => {
        await expect(
            registerRenewal(
                { delegate: async () => covenantAddress },
                { templateId: RENEW_TEMPLATE_ID },
                {
                    covenant,
                    covenantAddress,
                    renewalBeforeExpirySeconds: 259_200n,
                    expiresAt: 1_900_000_000,
                },
            ),
        ).resolves.toBeUndefined();
    });

    it("sends the window as a minimal number and the covenant's whole tree", () => {
        // 259200 = 0x03f480 little-endian; the top byte's high bit is clear, so no pad.
        expect(renewalVariables(covenant, 259_200n)).toEqual({
            renewal_window: "80f403",
            tree: bytesToHex(covenant.encode()),
        });
    });

    const executor = (answer: (method: string) => Response) => {
        const calls: string[] = [];
        const client = new DelegateeClient({
            baseUrl: "https://executor.example/",
            fetch: (async (url: string | URL | Request, init?: RequestInit) => {
                const method = init?.method ?? "GET";
                calls.push(`${method} ${new URL(String(url)).pathname}`);
                return answer(method);
            }) as typeof globalThis.fetch,
        });
        return { client, calls };
    };

    it("uses a template the Executor already holds without uploading it", async () => {
        const { client, calls } = executor(() =>
            json({ template: { id: RENEW_TEMPLATE_ID, status: "active" } }),
        );
        await expect(client.register()).resolves.toEqual({ templateId: RENEW_TEMPLATE_ID });
        expect(calls).toEqual([`GET /v1/template/${RENEW_TEMPLATE_ID}`]);
    });

    it("uploads the template the Executor lacks", async () => {
        const { client, calls } = executor((method) =>
            method === "GET" ? notFound() : json({ template: { id: RENEW_TEMPLATE_ID } }),
        );
        await expect(client.register()).resolves.toEqual({ templateId: RENEW_TEMPLATE_ID });
        expect(calls).toEqual([`GET /v1/template/${RENEW_TEMPLATE_ID}`, "POST /v1/template"]);
    });

    it("names the template and both remedies when the public port refuses the upload", async () => {
        const { client } = executor((method) =>
            method === "GET" ? notFound() : grpcError(403, 7, "served on the admin port only"),
        );
        const refused = await client.register().catch((error: unknown) => error);
        expect(refused).toBeInstanceOf(TemplateRefusedError);
        expect(refused).toMatchObject({
            templateId: RENEW_TEMPLATE_ID,
            status: 403,
            message: expect.stringMatching(
                `${RENEW_TEMPLATE_ID}: install it through the Executor's admin API, or run the Executor with EXECUTOR_PUBLIC_REGISTRY=true`,
            ),
        });
    });

    it.each([
        ["holds", () => json({ template: { id: "ff".repeat(32), status: "active" } })],
        [
            "uploads",
            (method: string) =>
                method === "GET" ? notFound() : json({ template: { id: "ff".repeat(32) } }),
        ],
    ])("refuses a template the Executor %s under another id", async (_, answer) => {
        const { client } = executor(answer);
        const refused = await client.register().catch((error: unknown) => error);
        expect(refused).toBeInstanceOf(TemplateMismatchError);
        expect(refused).toMatchObject({
            templateId: RENEW_TEMPLATE_ID,
            returnedId: "ff".repeat(32),
        });
    });

    it("refuses a template the Executor disabled", async () => {
        const { client } = executor(() =>
            json({ template: { id: RENEW_TEMPLATE_ID, status: "disabled" } }),
        );
        await expect(client.register()).rejects.toThrow(`${RENEW_TEMPLATE_ID} is disabled`);
    });

    it("refuses a registration the delegatee answers without an id", async () => {
        const client = new DelegateeClient({
            baseUrl: "https://executor.example",
            fetch: (async () => json({ template: {} })) as unknown as typeof globalThis.fetch,
        });
        await expect(client.register()).rejects.toThrow(/no template id/);
    });

    it("carries the Executor's refusal into the error", async () => {
        const client = new DelegateeClient({
            baseUrl: "https://executor.example",
            fetch: (async () => ({
                ok: false,
                status: 400,
                text: async () =>
                    '{"code":3,"message":"expires_at must be at least 24h0m0s ahead"}',
            })) as unknown as typeof globalThis.fetch,
        });
        await expect(client.delegate(RENEW_TEMPLATE_ID, {}, 1)).rejects.toThrow(
            /answered 400: .*24h0m0s ahead/,
        );
    });
});

describe("per-covenant delegation", () => {
    const registrar = (delegate: (...args: unknown[]) => Promise<string>) =>
        delegationRenewal({
            client: { delegate },
            registration: { templateId: RENEW_TEMPLATE_ID },
            config: config(),
            now: () => NOW,
        });

    it("registers a covenant once per process, expiring a guard before its reclaim", async () => {
        const delegate = vi.fn(async () => advance().covenantAddress);
        const renew = registrar(delegate);
        await renew(advance());
        expect(renew(advance())).toBeUndefined();
        const tree = new DustCovenantScript({
            serverKey,
            emulatorKey,
            vtxoMinAmount: VTXO_MIN,
            params: covenantParamsOf(advance()),
        });
        expect(delegate).toHaveBeenCalledExactlyOnceWith(
            RENEW_TEMPLATE_ID,
            renewalVariables(tree, config().renewalBeforeExpirySeconds),
            Number(V2_DEADLINE - config().recoveryBroadcastSeconds),
        );

        // A restart registers again; the Executor answers with the delegation unchanged.
        await expect(registrar(delegate)(advance())).resolves.toBeUndefined();
        expect(delegate).toHaveBeenCalledTimes(2);
    });

    it("rejects a failed registration and tries again on the next offer", async () => {
        const down = new DelegateeError("delegatee /v1/delegation is unreachable");
        const delegate = vi
            .fn<(...args: unknown[]) => Promise<string>>()
            .mockRejectedValueOnce(down)
            .mockResolvedValueOnce("ark1qstranger")
            .mockResolvedValueOnce(advance().covenantAddress);
        const renew = registrar(delegate);

        await expect(renew(advance())).rejects.toBe(down);
        await expect(renew(advance())).rejects.toThrow(/delegatee derives ark1qstranger/);
        await expect(renew(advance())).resolves.toBeUndefined();
        expect(renew(advance())).toBeUndefined();
        expect(delegate).toHaveBeenCalledTimes(3);
    });

    it("leaves a covenant inside the recovery guard, or not locked, unregistered", () => {
        const delegate = vi.fn(async () => "unused");
        const renew = registrar(delegate);
        const guard = BigInt(NOW) + config().recoveryBroadcastSeconds;
        expect(
            renew(advance({ recoveryLocktime: { kind: "time", value: guard } })),
        ).toBeUndefined();
        expect(renew(advance({ state: "recovering" }))).toBeUndefined();
        expect(delegate).not.toHaveBeenCalled();
    });
});

describe("delegation monitoring", () => {
    it("reads the delegation and its coins by address without spending anything", async () => {
        const fetch = vi.fn(async () =>
            json({
                delegation: { id: "7", status: "active", expiresAt: "1900000000", inputs: [] },
                coins: [
                    {
                        outpoint: `${"ab".repeat(32)}:0`,
                        input: 0,
                        amount: "330",
                        status: "spent",
                        spentBy: "cd".repeat(32),
                        expiresAt: 1_800_000_000,
                        due: "0",
                        confirmations: 0,
                    },
                ],
            }),
        );
        const client = new DelegateeClient({
            baseUrl: "https://executor.example",
            fetch: fetch as unknown as typeof globalThis.fetch,
        });

        await expect(client.getDelegation("ark1qcovenant")).resolves.toEqual({
            status: "active",
            expiresAt: 1_900_000_000,
            coins: [
                {
                    outpoint: `${"ab".repeat(32)}:0`,
                    amount: 330,
                    status: "spent",
                    spentBy: "cd".repeat(32),
                    expiresAt: 1_800_000_000,
                },
            ],
        });
        expect(fetch.mock.calls[0]).toEqual([
            "https://executor.example/v1/delegation?address=ark1qcovenant",
            { method: "GET" },
        ]);
    });

    it("reports a delegation that never expires and holds no coin", async () => {
        const client = new DelegateeClient({
            baseUrl: "https://executor.example",
            fetch: (async () =>
                json({
                    delegation: { status: "cancelled", expiresAt: "0" },
                })) as unknown as typeof globalThis.fetch,
        });
        await expect(client.getDelegation("ark1qcovenant")).resolves.toEqual({
            status: "cancelled",
            coins: [],
        });
    });
});
