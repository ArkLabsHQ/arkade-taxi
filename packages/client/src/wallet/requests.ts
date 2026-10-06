import { isHttpUrl } from "./wire.js";

export interface Bip21Taxi {
    url: string;
    operatorKey?: string;
    fareId?: string;
    payer?: "receiver" | "sender";
}

export const decodeTaxiParams = (params: URLSearchParams): Bip21Taxi | undefined => {
    const getParam = (name: string): string | null => {
        for (const [key, value] of params) if (key.toLowerCase() === name) return value;
        return null;
    };
    const payerParams = [...params].filter(([key]) => key.toLowerCase() === "taxipayer");
    const payer = payerParams[0]?.[1];
    if (
        payerParams.length > 1 ||
        (payer !== undefined && payer !== "receiver" && payer !== "sender")
    )
        throw new Error("Invalid Taxi repayment preference");
    const taxiUrl = getParam("taxi");
    const taxiKey = getParam("taxikey");
    let taxi: Bip21Taxi | undefined;
    // Legacy malformed optional hints are ignored; a repayment preference is never weakened.
    if (
        taxiUrl != null &&
        (taxiKey === null || /^[0-9a-f]{64}$/.test(taxiKey)) &&
        isHttpUrl(taxiUrl)
    ) {
        const fareId = getParam("taxifare");
        taxi = {
            url: taxiUrl,
            ...(taxiKey ? { operatorKey: taxiKey } : {}),
            ...(fareId ? { fareId } : {}),
            ...(payer ? { payer } : {}),
        };
    }
    if (payer !== undefined && !taxi) throw new Error("Invalid Taxi repayment preference");
    return taxi;
};

export const encodeTaxiParams = (taxi?: Bip21Taxi): string => {
    if (!taxi) return "";
    const fare = taxi.fareId ? `&taxifare=${encodeURIComponent(taxi.fareId)}` : "";
    const payer = taxi.payer ? `&taxipayer=${encodeURIComponent(taxi.payer)}` : "";
    const key = taxi.operatorKey ? `&taxikey=${encodeURIComponent(taxi.operatorKey)}` : "";
    return `&taxi=${encodeURIComponent(taxi.url)}${key}${fare}${payer}`;
};
