import type { MetadataCenterCloseoutStatus, MetadataCenterContinuationContext, MetadataCenterDebugSnapshot, MetadataCenterFamily, MetadataCenterProviderObservation, MetadataCenterResponseObservation, MetadataCenterRequestTruth, MetadataCenterRuntimeControl, MetadataCenterWriter } from './metadata-center-types.js';
export type MetadataCenterDualWriteInput = {
    target: Record<string, unknown>;
    family: MetadataCenterFamily;
    key: string;
    value: unknown;
    writer: MetadataCenterWriter;
    reason?: string;
    expectedScope?: MetadataCenterScope;
};
export type MetadataCenterScope = {
    requestId?: string;
    sessionId?: string;
};
export type MetadataCenterRustSnapshot = {
    requestTruth?: MetadataCenterRequestTruth;
    continuationContext?: MetadataCenterContinuationContext;
    runtimeControl?: MetadataCenterRuntimeControl;
    providerObservation?: MetadataCenterProviderObservation;
    responseObservation?: MetadataCenterResponseObservation;
    closeoutStatus?: MetadataCenterCloseoutStatus;
    debugSnapshot?: MetadataCenterDebugSnapshot;
};
export declare function writeMetadataCenterSlot(input: MetadataCenterDualWriteInput): void;
export declare function readMetadataCenterSlot(_input: {
    source: Record<string, unknown>;
    family: MetadataCenterFamily;
    key: string;
    expectedScope?: MetadataCenterScope;
}): unknown;
export declare function buildMetadataCenterRustSnapshot(source: Record<string, unknown>): MetadataCenterRustSnapshot;
export declare function applyMetadataCenterRustWriteResult(args: {
    target: Record<string, unknown>;
    snapshot: MetadataCenterRustSnapshot;
}): void;
