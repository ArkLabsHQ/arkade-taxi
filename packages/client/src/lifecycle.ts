interface WeakReference<T extends object> {
    deref(): T | undefined;
}

interface LifecycleFinalizer<T extends object, K> {
    register(target: T, held: { key: K; generation: number }): void;
}

type ReferenceFactory<T extends object> = (value: T) => WeakReference<T>;
type FinalizerFactory<T extends object, K> = (
    callback: (held: { key: K; generation: number }) => void,
) => LifecycleFinalizer<T, K> | undefined;

const weakReference = <T extends object>(value: T): WeakReference<T> => {
    if (typeof WeakRef === "undefined")
        throw new Error("covenant spend requires WeakRef lifecycle support");
    return new WeakRef(value);
};

const lifecycleFinalizer = <T extends object, K>(
    callback: (held: { key: K; generation: number }) => void,
): LifecycleFinalizer<T, K> | undefined =>
    typeof FinalizationRegistry === "function" ? new FinalizationRegistry(callback) : undefined;

export class WeakValueRegistry<K, T extends object> {
    readonly #entries = new Map<K, { generation: number; reference: WeakReference<T> }>();
    readonly #finalizer?: LifecycleFinalizer<T, K>;
    #generation = 0;

    constructor(
        readonly referenceFactory: ReferenceFactory<T> = weakReference,
        finalizerFactory: FinalizerFactory<T, K> = lifecycleFinalizer,
    ) {
        this.#finalizer = finalizerFactory((held) => this.#finalize(held));
    }

    get size(): number {
        return this.#entries.size;
    }

    getOrCreate(key: K, create: () => T): T {
        this.sweep();
        const retained = this.#entries.get(key)?.reference.deref();
        if (retained) return retained;
        const value = create();
        const generation = ++this.#generation;
        this.#entries.set(key, { generation, reference: this.referenceFactory(value) });
        this.#finalizer?.register(value, { key, generation });
        return value;
    }

    claim<R>(value: T, claim: (value: T) => R): R {
        this.sweep();
        return claim(value);
    }

    sweep(): void {
        for (const [key, entry] of this.#entries)
            if (entry.reference.deref() === undefined && this.#entries.get(key) === entry)
                this.#entries.delete(key);
    }

    #finalize(held: { key: K; generation: number }): void {
        const current = this.#entries.get(held.key);
        if (current?.generation === held.generation && current.reference.deref() === undefined)
            this.#entries.delete(held.key);
    }
}
