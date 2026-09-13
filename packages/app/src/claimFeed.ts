import { TERMINAL_STATES, type Advance } from "@arkade-taxi/core";
import { bytesToHex, type ClaimsChangedEvent, type ReceiverClaimWire } from "@arkade-taxi/protocol";
import { ACTIVE_CLAIM_STATES, listReceiverClaims } from "./claims.js";
import { ServiceError } from "./errors.js";

export interface ClaimFeedLogger {
    error(
        diagnostic: { stage: "sampling" | "projection"; errorCode: string },
        message: string,
    ): void;
}

export interface ClaimFeedListener {
    onChanged(event: ClaimsChangedEvent): void | Promise<void>;
    onError(error: Error): void;
}

interface Subscription {
    keys: Map<string, Uint8Array>;
    listener: ClaimFeedListener;
    previous: Map<string, string>;
    pending: Map<string, ReceiverClaimWire>;
    writing: boolean;
}

function canonicalJson(value: unknown): string {
    if (value === null || typeof value !== "object") return JSON.stringify(value);
    if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
        .filter((key) => record[key] !== undefined)
        .sort()
        .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
        .join(",")}}`;
}

const ordered = (claims: ReceiverClaimWire[]) =>
    claims.sort((a, b) => a.updatedAt - b.updatedAt || a.transferId.localeCompare(b.transferId));

export class ReceiverClaimFeed {
    private readonly subscriptions = new Set<Subscription>();
    private timer?: ReturnType<typeof setInterval>;
    private closed = false;

    constructor(
        private readonly deps: Parameters<typeof listReceiverClaims>[0] & {
            claimFeedLogger?: ClaimFeedLogger;
        },
    ) {}

    private diagnose(stage: "sampling" | "projection", error: unknown): void {
        const code = error instanceof Error && "code" in error ? error.code : undefined;
        const errorCode =
            typeof code === "string" && /^SQLITE_[A-Z_]{1,40}$/.test(code)
                ? code
                : error instanceof ServiceError && error.code === "internal_error"
                  ? "internal_error"
                  : "unexpected_error";
        try {
            this.deps.claimFeedLogger?.error({ stage, errorCode }, "receiver claim feed failed");
        } catch {}
    }

    subscribe(
        receiverKeys: readonly Uint8Array[],
        listener: ClaimFeedListener,
        snapshot: readonly ReceiverClaimWire[] = [],
    ): () => void {
        if (this.closed) throw new Error("claim feed is closed");
        const subscription: Subscription = {
            keys: new Map(receiverKeys.map((key) => [bytesToHex(key), key.slice()])),
            listener,
            previous: new Map(snapshot.map((claim) => [claim.transferId, canonicalJson(claim)])),
            pending: new Map(),
            writing: false,
        };
        this.subscriptions.add(subscription);
        this.timer ??= setInterval(() => this.sample(), 250);
        return () => this.remove(subscription);
    }

    close(): void {
        this.closed = true;
        for (const subscription of this.subscriptions) this.fail(subscription);
    }

    private remove(subscription: Subscription): void {
        this.subscriptions.delete(subscription);
        subscription.pending.clear();
        if (this.subscriptions.size === 0 && this.timer !== undefined) {
            clearInterval(this.timer);
            this.timer = undefined;
        }
    }

    private fail(subscription: Subscription): void {
        if (!this.subscriptions.has(subscription)) return;
        this.remove(subscription);
        try {
            void Promise.resolve(subscription.listener.onError(new Error("internal error"))).catch(
                () => {},
            );
        } catch {}
    }

    private sample(): void {
        const subscriptions = [...this.subscriptions];
        const keys = new Map(subscriptions.flatMap((subscription) => [...subscription.keys]));
        let rows: Advance[];
        try {
            rows = this.deps.advances.byReceiverKeys([...keys.values()]);
        } catch (error) {
            this.diagnose("sampling", error);
            subscriptions.forEach((subscription) => this.fail(subscription));
            return;
        }
        const grouped = new Map<string, Advance[]>();
        for (const row of rows) {
            const key = bytesToHex(row.receiverKey);
            const group = grouped.get(key) ?? [];
            group.push(row);
            grouped.set(key, group);
        }
        const projected = new Map<string, ReceiverClaimWire[] | null>();
        for (const [key, receiverKey] of keys) {
            try {
                projected.set(
                    key,
                    listReceiverClaims(
                        {
                            config: this.deps.config,
                            advances: { byReceiverKeys: () => grouped.get(key) ?? [] },
                        },
                        { addresses: [], receiverKeys: [receiverKey] },
                        [...ACTIVE_CLAIM_STATES, ...TERMINAL_STATES],
                    ),
                );
            } catch (error) {
                this.diagnose("projection", error);
                projected.set(key, null);
            }
        }
        for (const subscription of subscriptions) {
            if (!this.subscriptions.has(subscription)) continue;
            const groups = [...subscription.keys.keys()].map((key) => projected.get(key)!);
            if (groups.some((group) => group === null)) {
                this.fail(subscription);
                continue;
            }
            const previous = new Map<string, string>();
            for (const claim of ordered((groups as ReceiverClaimWire[][]).flat())) {
                const fingerprint = canonicalJson(claim);
                previous.set(claim.transferId, fingerprint);
                if (subscription.previous.get(claim.transferId) !== fingerprint)
                    subscription.pending.set(claim.transferId, claim);
            }
            subscription.previous = previous;
            void this.flush(subscription);
        }
    }

    private async flush(subscription: Subscription): Promise<void> {
        if (subscription.writing) return;
        subscription.writing = true;
        try {
            while (this.subscriptions.has(subscription) && subscription.pending.size > 0) {
                const claims = ordered([...subscription.pending.values()]);
                subscription.pending.clear();
                await subscription.listener.onChanged({ claims });
            }
        } catch {
            this.fail(subscription);
        } finally {
            subscription.writing = false;
        }
    }
}
