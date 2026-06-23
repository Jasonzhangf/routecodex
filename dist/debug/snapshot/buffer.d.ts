export type ProviderSnapshotPersistInput = {
    endpoint: string;
    folder: string;
    stage: string;
    requestId: string;
    groupRequestId: string;
    providerToken: string;
    payload: unknown;
    entryPort?: number;
    runtimeMetadata?: Record<string, unknown>;
};
export declare const SNAPSHOT_PROVIDER_ERROR_BUFFER_FEATURE_ID = "feature_id: snapshot.provider_error_buffer";
export declare function shouldFlushSnapshotBuffer(stage: string): boolean;
export declare function bufferProviderSnapshotForErrorFlush(input: ProviderSnapshotPersistInput): void;
export declare function takeBufferedProviderSnapshots(groupRequestId: string): ProviderSnapshotPersistInput[];
export declare function resetProviderSnapshotErrorBufferForTests(): void;
