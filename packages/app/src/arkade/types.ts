export interface RuntimeSafety {
    checkedAt: number;
    chainHeight: bigint | null;
    chainTime: bigint | null;
    walletSynced: boolean;
    providerIdentityOk: boolean;
    blockers: string[];
    provider?: {
        network: string | null;
        identityOk: boolean;
        serverPubkey: string;
        emulatorPubkey: string;
    };
    inventory?: {
        usableSats: bigint;
        reservedSats: bigint;
        usableVtxos: number;
        reservedVtxos: number;
    };
}

export interface RuntimeGate {
    safety(): RuntimeSafety;
    assertAdmission(): Promise<void>;
    withAdmission<T>(work: (assertCurrent: () => void) => Promise<T>): Promise<T>;
}
