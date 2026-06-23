export type SnapshotScope = 'server' | 'provider' | 'client';
export interface SnapshotWriteInput {
    scope: SnapshotScope;
    stage: string;
    requestId: string;
    groupRequestId?: string;
    providerKey?: string;
    entryEndpoint?: string;
    entryPort?: number;
    data: unknown;
    verbosity?: 'default' | 'verbose';
    flush?: 'immediate' | 'queue';
    headers?: Record<string, unknown>;
    url?: string;
    extraMeta?: Record<string, unknown>;
    rawPayload?: unknown;
    runtimeMetadata?: Record<string, unknown>;
    forceLocalDiskWriteWhenDisabled?: boolean;
}
declare function isSnapshotsEnabled(): boolean;
export declare function writeUnifiedSnapshot(input: SnapshotWriteInput): Promise<void>;
export declare function createSnapshotWriter(): {
    write: typeof writeUnifiedSnapshot;
    isEnabled: typeof isSnapshotsEnabled;
};
export { isSnapshotsEnabled };
