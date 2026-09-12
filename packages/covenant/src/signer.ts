import { Transaction } from "@arkade-os/sdk";

const typedArrayPrototype = Object.getPrototypeOf(Uint8Array.prototype) as object;
const typedArrayTag = Object.getOwnPropertyDescriptor(
    typedArrayPrototype,
    Symbol.toStringTag,
)!.get!;
const typedArrayByteOffset = Object.getOwnPropertyDescriptor(
    typedArrayPrototype,
    "byteOffset",
)!.get!;
const typedArrayByteLength = Object.getOwnPropertyDescriptor(
    typedArrayPrototype,
    "byteLength",
)!.get!;
const typedArrayLength = Object.getOwnPropertyDescriptor(typedArrayPrototype, "length")!.get!;
const typedArrayAt = Reflect.get(typedArrayPrototype, "at") as (
    this: Uint8Array,
    index: number,
) => number | undefined;

class SignerTransactionError extends Error {}

const fail = (label: string, detail: string, cause?: unknown): never => {
    const message = `${label} signer ${detail}`;
    throw cause === undefined
        ? new SignerTransactionError(message)
        : new SignerTransactionError(message, { cause });
};

const validatedByteView = (
    value: unknown,
    invalid: (detail: string, cause?: unknown) => never,
): Uint8Array => {
    if (!ArrayBuffer.isView(value)) return invalid("is not a byte view");
    try {
        if (Reflect.apply(typedArrayTag, value, []) !== "Uint8Array")
            return invalid("is not Uint8Array bytes");
        const byteOffset = Reflect.apply(typedArrayByteOffset, value, []) as number;
        const byteLength = Reflect.apply(typedArrayByteLength, value, []) as number;
        const length = Reflect.apply(typedArrayLength, value, []) as number;
        if (
            !Number.isSafeInteger(byteOffset) ||
            byteOffset < 0 ||
            !Number.isSafeInteger(byteLength) ||
            byteLength < 0 ||
            !Number.isSafeInteger(byteOffset + byteLength) ||
            length !== byteLength
        )
            return invalid("is an invalid byte view");
        const copy = new Uint8Array(byteLength);
        for (let index = 0; index < byteLength; index++) {
            const byte = Reflect.apply(typedArrayAt, value, [index]) as number | undefined;
            if (!Number.isInteger(byte) || byte === undefined || byte < 0 || byte > 0xff)
                return invalid("contains invalid byte data");
            copy[index] = byte;
        }
        return copy;
    } catch (cause) {
        if (cause instanceof SignerTransactionError) throw cause;
        return invalid(
            `is an unreadable byte view: ${cause instanceof Error ? cause.message : "byte validation failed"}`,
            cause,
        );
    }
};

export const copyByteView = (value: unknown, label: string): Uint8Array =>
    validatedByteView(value, (detail, cause) => {
        const message = `${label} ${detail}`;
        throw cause === undefined ? new TypeError(message) : new TypeError(message, { cause });
    });

const localUint8Array = (value: unknown, label: string): Uint8Array =>
    validatedByteView(value, (detail, cause) => fail(label, detail, cause));

export function signerTransaction(value: unknown, label: string): Transaction {
    if (
        !value ||
        typeof value !== "object" ||
        !("toPSBT" in value) ||
        typeof value.toPSBT !== "function"
    )
        return fail(label, "did not return a Transaction");
    let encoded: unknown;
    try {
        encoded = value.toPSBT();
    } catch (cause) {
        return fail(
            label,
            `returned an unserializable Transaction: ${cause instanceof Error ? cause.message : "serialization failed"}`,
            cause,
        );
    }
    const bytes = localUint8Array(encoded, label);
    try {
        return Transaction.fromPSBT(bytes);
    } catch (cause) {
        return fail(
            label,
            `returned malformed PSBT bytes: ${cause instanceof Error ? cause.message : "PSBT parsing failed"}`,
            cause,
        );
    }
}
