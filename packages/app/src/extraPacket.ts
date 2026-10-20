import { hexToBytes } from "@arkade-taxi/protocol";
import { ErrorCode, ServiceError } from "./errors.js";

export type ExtraPacket = { type: number; payload: Uint8Array };

const badRequest = (message: string) => new ServiceError(ErrorCode.InvalidRequest, 400, message);

/** Types the SDK assigns: assets (0x00) and the emulator (0x01) share the extension with the sender's packet. */
const RESERVED_TYPES = new Set([0x00, 0x01]);

/** The sender's own packet, opaque: preserved byte for byte and never parsed. */
export function decodeExtraPacket(raw: unknown): ExtraPacket | undefined {
    if (raw === undefined) return undefined;
    if (raw === null || typeof raw !== "object" || Array.isArray(raw))
        throw badRequest("extraPacket must be an object");
    const e = raw as { type?: unknown; payload?: unknown };
    if (typeof e.type !== "number" || !Number.isInteger(e.type) || e.type < 0 || e.type > 255)
        throw badRequest("extraPacket.type must be a one-byte tag");
    if (RESERVED_TYPES.has(e.type))
        throw badRequest(`extraPacket.type ${e.type} is reserved for a packet Taxi builds itself`);
    if (typeof e.payload !== "string" || !/^([0-9a-fA-F]{2})+$/.test(e.payload))
        throw badRequest("extraPacket.payload must be non-empty hex");
    return { type: e.type, payload: hexToBytes(e.payload, "extraPacket.payload") };
}
