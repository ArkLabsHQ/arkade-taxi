import { arkade } from "@arkade-os/sdk";
import { bytesToHex } from "@arkade-taxi/protocol";
import { V2_ARTIFACT, v2Args, type DustCovenantParams } from "@arkade-taxi/covenant";

export interface DelegateeRegistration {
    artifactId: string;
    templateId: string;
}

export interface DelegateeOptions {
    baseUrl: string;
    fetch?: typeof globalThis.fetch;
}

/** The renewal history an operator reads when the sweeper's alarm fires. */
export interface DelegationView {
    /** `active`, `cancelled`, `expired` or `done` upstream. */
    status: string;
    attempts: number;
    succeeded: number;
    lastAttemptAt?: number;
    lastError?: string;
}

export class DelegateeError extends Error {}

const TEMPLATE_FORMAT = "delegateed-template/v1";

const snake = (name: string): string => name.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);

/** Derived from the artifact, so a new constructor field cannot be forgotten
 * here. `renewal_window` drives the schedule alone and names no field. */
export function renewalTemplate(artifactId: string): string {
    const variables: Record<string, string> = { renewal_window: "int" };
    const args: Record<string, string> = {};
    for (const { name, type } of V2_ARTIFACT.constructorInputs) {
        variables[snake(name)] = type;
        args[name] = `<${snake(name)}>`;
    }
    return JSON.stringify({
        format: TEMPLATE_FORMAT,
        type: "intent",
        variables,
        inputs: [
            {
                name: "covenant",
                schedule: { before_expiry_seconds: "<renewal_window>" },
                contract: { definition: { artifact: artifactId }, arguments: args },
                spend: { function: "renew", leaf: "renew" },
            },
        ],
        // Flags 7 preserves value, script and assets: every route is a remainder.
        outputs: [
            {
                name: "renewed",
                index: 0,
                value: { from: "covenant" },
                locking: { from: "covenant" },
                assets: [{ from: "covenant" }],
            },
        ],
        packets: { output_index: 1 },
    });
}

/** Lower-case hex of raw bytes (`service.go:702-709`): an int as a minimal
 * sign-magnitude number, a pubkey as 33 compressed bytes, which the delegatee
 * x-onlys again before it reaches a leaf (`contract.go:101-107`). */
export function delegationVariables(
    params: DustCovenantParams,
    serverKey: Uint8Array,
    renewalBeforeExpirySeconds: bigint,
): Record<string, string> {
    const args = v2Args(params, serverKey);
    const out: Record<string, string> = {
        renewal_window: bytesToHex(arkade.BigNum.encode(renewalBeforeExpirySeconds)),
    };
    for (const { name, type } of V2_ARTIFACT.constructorInputs) {
        const value = (args as Record<string, unknown>)[name];
        if (type === "int") {
            if (typeof value !== "bigint") throw new DelegateeError(`${name} is not an integer`);
            out[snake(name)] = bytesToHex(arkade.BigNum.encode(value));
            continue;
        }
        if (!(value instanceof Uint8Array)) throw new DelegateeError(`${name} is not bytes`);
        out[snake(name)] =
            type === "pubkey" ? bytesToHex(Uint8Array.of(2, ...value)) : bytesToHex(value);
    }
    return out;
}

export class DelegateeClient {
    private readonly fetch: typeof globalThis.fetch;
    private readonly baseUrl: string;

    constructor(options: DelegateeOptions) {
        this.baseUrl = options.baseUrl.replace(/\/+$/, "");
        this.fetch = options.fetch ?? globalThis.fetch;
    }

    /** Idempotent on their derived id, so startup may repeat them. */
    async register(): Promise<DelegateeRegistration> {
        const artifact = await this.post<{ artifact?: { id?: string } }>("/v1/artifact", {
            document: JSON.stringify(V2_ARTIFACT),
        });
        const artifactId = artifact.artifact?.id;
        if (!artifactId) throw new DelegateeError("delegatee returned no artifact id");
        const template = await this.post<{ template?: { id?: string } }>("/v1/template", {
            document: renewalTemplate(artifactId),
        });
        const templateId = template.template?.id;
        if (!templateId) throw new DelegateeError("delegatee returned no template id");
        return { artifactId, templateId };
    }

    async delegate(
        templateId: string,
        variables: Record<string, string>,
        expiresAt: number,
    ): Promise<string> {
        const body = await this.post<{ delegation?: { address?: string } }>("/v1/delegate", {
            template_id: templateId,
            variables,
            expires_at: expiresAt,
        });
        const address = body.delegation?.address;
        if (!address) throw new DelegateeError("delegatee returned no delegation address");
        return address;
    }

    /** Read-only, and keyed by the address the covenant already stores: why a
     * renewal was missed, never a renewal of our own (D6). */
    async getDelegation(address: string): Promise<DelegationView> {
        const body = await this.get<{
            delegation?: { status?: string; expires_at?: number };
            renewals?: { success?: boolean; error?: string; attempted_at?: number }[];
        }>(`/v1/delegate/${encodeURIComponent(address)}`);
        const renewals = body.renewals ?? [];
        const failed = renewals.filter((r) => r.success !== true);
        return {
            status: body.delegation?.status ?? "unknown",
            attempts: renewals.length,
            succeeded: renewals.length - failed.length,
            ...(renewals.length
                ? { lastAttemptAt: renewals[renewals.length - 1]!.attempted_at }
                : {}),
            ...(failed.length ? { lastError: failed[failed.length - 1]!.error } : {}),
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
        if (!response.ok) throw new DelegateeError(`delegatee ${path} answered ${response.status}`);
        return (await response.json()) as T;
    }
}

/** A differing address means the two sides disagree about the leaves, and under
 * D2 that covenant would never be renewed, so this throws rather than warns. */
export async function registerRenewal(
    client: Pick<DelegateeClient, "delegate">,
    registration: DelegateeRegistration,
    args: {
        params: DustCovenantParams;
        serverKey: Uint8Array;
        covenantAddress: string;
        renewalBeforeExpirySeconds: bigint;
        expiresAt: number;
    },
): Promise<void> {
    const address = await client.delegate(
        registration.templateId,
        delegationVariables(args.params, args.serverKey, args.renewalBeforeExpirySeconds),
        args.expiresAt,
    );
    if (address !== args.covenantAddress)
        throw new DelegateeError(
            `delegatee derives ${address} for template ${registration.templateId}, the covenant is ${args.covenantAddress}`,
        );
}
