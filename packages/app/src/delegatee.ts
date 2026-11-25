import { createHash } from "node:crypto";
import { arkade } from "@arkade-os/sdk";
import { bytesToHex } from "@arkade-taxi/protocol";
import { DUST_COVENANT_ARTIFACT, DustCovenantScript } from "@arkade-taxi/covenant";
import { covenantParamsOf, renewable, type Advance } from "@arkade-taxi/core";
import { canonicalJson } from "./arkade/psbt.js";
import type { RuntimeConfig } from "./config.js";

export interface DelegateeRegistration {
    templateId: string;
}

export interface DelegateeOptions {
    baseUrl: string;
    fetch?: typeof globalThis.fetch;
}

/** What an operator reads when the sweeper's alarm fires. Times are unix seconds. */
export interface DelegationView {
    /** `active`, `cancelled`, `expired` or `done` upstream. */
    status: string;
    expiresAt?: number;
    coins: {
        outpoint: string;
        amount: number;
        status: string;
        expiresAt?: number;
        due?: number;
        spentBy?: string;
    }[];
}

export class DelegateeError extends Error {
    readonly status?: number;
    constructor(message: string, options?: ErrorOptions & { status?: number }) {
        super(message, options);
        this.status = options?.status;
    }
}

export class TemplateRefusedError extends DelegateeError {
    constructor(
        readonly templateId: string,
        options?: ErrorOptions,
    ) {
        super(
            `the Executor refused to register renewal template ${templateId}: install it through the Executor's admin API, or run the Executor with EXECUTOR_PUBLIC_REGISTRY=true`,
            options,
        );
    }
}

/** One template for every covenant. The full artifact cannot be delegated: a claim mode
 * swaps one claim leaf out of the tree, and the Executor refuses a declared leaf the
 * given tree lacks. The renew leaf names no constructor field, so it alone is declared. */
export function renewalTemplate(): string {
    const { contractName, functions } = DUST_COVENANT_ARTIFACT;
    return JSON.stringify({
        format: "template/v1",
        type: "proof",
        variables: { renewal_window: "int", tree: "bytes" },
        inputs: [
            {
                name: "covenant",
                contract: {
                    definition: {
                        contractName,
                        constructorInputs: [],
                        structs: [],
                        functions: functions.filter((f) => f.name === "renew"),
                    },
                    taptree: "<tree>",
                },
                spend: { function: "renew", leaf: "renew" },
            },
        ],
        // No `fees`: the tunnel keeps the value whole, so only a zero intent fee builds.
        outputs: [
            {
                name: "renewed",
                value: { from: "covenant" },
                locking: { from: "covenant" },
                assets: [{ from: "covenant" }],
            },
        ],
        packets: { unmatched: "drop" },
        delegation: { schedule: { covenant: { before_expiry_seconds: "<renewal_window>" } } },
    });
}

/** The Executor's content id: sha256 of the document's RFC 8785 form. */
export const renewalTemplateId = (): string =>
    createHash("sha256")
        .update(canonicalJson(JSON.parse(renewalTemplate())))
        .digest("hex");

/** Lower-case hex, an int as a minimal script number. */
export const renewalVariables = (
    covenant: DustCovenantScript,
    renewalBeforeExpirySeconds: bigint,
): Record<string, string> => ({
    renewal_window: bytesToHex(arkade.BigNum.encode(renewalBeforeExpirySeconds)),
    tree: bytesToHex(covenant.encode()),
});

/** protojson writes an int64 as a decimal string; 0 means "never" in this API. */
const int64 = (value: unknown): number | undefined => {
    const n = typeof value === "string" && /^-?\d+$/.test(value) ? Number(value) : value;
    return typeof n === "number" && Number.isSafeInteger(n) && n !== 0 ? n : undefined;
};

export class DelegateeClient {
    private readonly fetch: typeof globalThis.fetch;
    private readonly baseUrl: string;

    constructor(options: DelegateeOptions) {
        this.baseUrl = options.baseUrl.replace(/\/+$/, "");
        this.fetch = options.fetch ?? globalThis.fetch;
    }

    /** Uploads the template only where the Executor lacks it, so startup may repeat it. */
    async register(): Promise<DelegateeRegistration> {
        type Body = { template?: { id?: string; status?: string } };
        const templateId = renewalTemplateId();
        const body = await this.get<Body>(`/v1/template/${templateId}`).catch((error: unknown) => {
            if (!(error instanceof DelegateeError) || error.status !== 404) throw error;
            return this.post<Body>("/v1/template", { document: renewalTemplate() }).catch(
                (refusal: unknown) => {
                    throw refusal instanceof DelegateeError && refusal.status === 403
                        ? new TemplateRefusedError(templateId, { cause: refusal })
                        : refusal;
                },
            );
        });
        const template = body.template;
        if (!template?.id) throw new DelegateeError("delegatee returned no template id");
        // RegisterDelegation refuses every covenant on a disabled template.
        if (template.status === "disabled")
            throw new DelegateeError(`delegatee template ${template.id} is disabled`);
        return { templateId: template.id };
    }

    /** Registering an active delegation again returns it unchanged. */
    async delegate(
        templateId: string,
        variables: Record<string, string>,
        expiresAt: number,
    ): Promise<string> {
        const body = await this.post<{ delegation?: { inputs?: { address?: string }[] } }>(
            "/v1/delegation",
            { templateId, variables, expiresAt },
        );
        const address = body.delegation?.inputs?.[0]?.address;
        if (!address) throw new DelegateeError("delegatee returned no delegation address");
        return address;
    }

    /** Read-only, and keyed by the address the covenant already stores. */
    async getDelegation(address: string): Promise<DelegationView> {
        const body = await this.get<{
            delegation?: { status?: string; expiresAt?: unknown };
            coins?: Record<string, unknown>[];
        }>(`/v1/delegation?address=${encodeURIComponent(address)}`);
        return {
            status: body.delegation?.status ?? "unknown",
            expiresAt: int64(body.delegation?.expiresAt),
            coins: (body.coins ?? []).map((coin) => ({
                outpoint: String(coin.outpoint ?? ""),
                amount: int64(coin.amount) ?? 0,
                status: String(coin.status ?? "unknown"),
                expiresAt: int64(coin.expiresAt),
                due: int64(coin.due),
                spentBy: coin.spentBy ? String(coin.spentBy) : undefined,
            })),
        };
    }

    private async get<T>(path: string): Promise<T> {
        return this.send<T>(path, { method: "GET" });
    }

    private async post<T>(path: string, body: unknown): Promise<T> {
        return this.send<T>(path, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(body),
        });
    }

    private async send<T>(path: string, init: RequestInit): Promise<T> {
        let response: Response;
        try {
            response = await this.fetch(`${this.baseUrl}${path}`, init);
        } catch (cause) {
            throw new DelegateeError(`delegatee ${path} is unreachable`, { cause });
        }
        if (!response.ok) {
            const detail = await response.text().catch(() => "");
            throw new DelegateeError(
                `delegatee ${path} answered ${response.status}: ${detail.slice(0, 200)}`,
                { status: response.status },
            );
        }
        return (await response.json()) as T;
    }
}

/** A differing address means the two sides disagree about the leaves, and under
 * D2 that covenant would never be renewed, so this throws rather than warns. */
export async function registerRenewal(
    client: Pick<DelegateeClient, "delegate">,
    registration: DelegateeRegistration,
    args: {
        covenant: DustCovenantScript;
        covenantAddress: string;
        renewalBeforeExpirySeconds: bigint;
        expiresAt: number;
    },
): Promise<void> {
    const address = await client.delegate(
        registration.templateId,
        renewalVariables(args.covenant, args.renewalBeforeExpirySeconds),
        args.expiresAt,
    );
    if (address !== args.covenantAddress)
        throw new DelegateeError(
            `delegatee derives ${address} for template ${registration.templateId}, the covenant is ${args.covenantAddress}`,
        );
}

/** The sweeper's renewal hook with an Executor: one registration per covenant per process.
 * A restart registers again, which the Executor answers with the active delegation. */
export function delegationRenewal(deps: {
    client: Pick<DelegateeClient, "delegate">;
    registration: DelegateeRegistration;
    config: Pick<
        RuntimeConfig,
        | "serverPubkey"
        | "emulatorPubkey"
        | "vtxoMinAmount"
        | "renewalBeforeExpirySeconds"
        | "recoveryBroadcastSeconds"
    >;
    now(): number;
}): (advance: Advance) => Promise<void> | undefined {
    const guard = deps.config.recoveryBroadcastSeconds;
    const registered = new Set<string>();
    return (advance) => {
        if (registered.has(advance.id) || !renewable(advance, BigInt(deps.now()), guard))
            return undefined;
        return (async () => {
            const covenant = new DustCovenantScript({
                serverKey: deps.config.serverPubkey,
                emulatorKey: deps.config.emulatorPubkey,
                vtxoMinAmount: deps.config.vtxoMinAmount,
                params: covenantParamsOf(advance),
            });
            await registerRenewal(deps.client, deps.registration, {
                covenant,
                covenantAddress: advance.covenantAddress,
                renewalBeforeExpirySeconds: deps.config.renewalBeforeExpirySeconds,
                expiresAt: Number(advance.recoveryLocktime!.value - guard),
            });
            registered.add(advance.id);
        })();
    };
}
