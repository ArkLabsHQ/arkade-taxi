import { VtxoScript, canSpendOffchain, type IndexerProvider } from "@arkade-os/sdk";
import { hex } from "@scure/base";
import type { FundingInputValue } from "@arkade-taxi/protocol";
import type { RuntimeConfig } from "../config.js";
import type { RuntimeSafety } from "./types.js";
import { normalizeExpiry } from "./providers.js";
import { inputAssets, toArkInput } from "./lockupBuilder.js";
import { ServiceError } from "../errors.js";

export async function verifySenderFunding(
    inputs: FundingInputValue[],
    owner: Uint8Array,
    server: Uint8Array,
    indexer: Pick<IndexerProvider, "getVtxos">,
    safety: RuntimeSafety,
    config: RuntimeConfig,
): Promise<void> {
    let response;
    try {
        response = await indexer.getVtxos({
            outpoints: inputs.map(({ txid, vout }) => ({ txid, vout })),
        });
    } catch (cause) {
        throw new ServiceError("runtime_unsafe", 503, "sender funding verification unavailable", {
            cause,
        });
    }
    try {
        if (response.vtxos.length !== inputs.length)
            throw new Error("sender funding missing or duplicated");
        for (const input of inputs) {
            toArkInput(input, owner, server);
            const matches = response.vtxos.filter(
                (coin) => coin.txid === input.txid && coin.vout === input.vout,
            );
            if (matches.length !== 1) throw new Error("sender outpoint missing or duplicated");
            const coin = matches[0];
            const expiry = normalizeExpiry(coin);
            const clock = expiry.kind === "height" ? safety.chainHeight : safety.chainTime;
            const headroom =
                expiry.kind === "height"
                    ? config.minExpiryHeadroomBlocks
                    : config.minExpiryHeadroomSeconds;
            if (
                !Number.isSafeInteger(coin.value) ||
                BigInt(coin.value) !== input.value ||
                coin.script !== hex.encode(VtxoScript.decode(input.tapTree).pkScript) ||
                expiry.kind !== input.expiry.kind ||
                expiry.value !== input.expiry.value ||
                clock === null ||
                expiry.value - clock < headroom ||
                !canSpendOffchain(coin, {
                    height: Number(safety.chainHeight),
                    timestamp: new Date(Number(safety.chainTime) * 1000),
                })
            )
                throw new Error("sender funding evidence differs from spendable inventory");
            const actual = new Map((coin.assets ?? []).map((a) => [a.assetId, a.amount]));
            const claimed = inputAssets(input);
            if (
                actual.size !== (coin.assets ?? []).length ||
                actual.size !== claimed.size ||
                [...actual].some(([id, amount]) => amount !== claimed.get(id))
            )
                throw new Error("sender assets differ from inventory");
        }
    } catch (cause) {
        throw new ServiceError("invalid_request", 400, "sender funding could not be verified", {
            cause,
        });
    }
}
