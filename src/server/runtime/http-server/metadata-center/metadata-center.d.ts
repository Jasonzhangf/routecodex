import type { MetadataCenterClientAttachmentScope, MetadataCenterContinuationContext, MetadataCenterDebugSnapshot, MetadataCenterProviderObservation, MetadataCenterRequestTruth, MetadataCenterRuntimeControl, MetadataCenterState, MetadataCenterWriter } from './metadata-center-types.js';
export declare class MetadataCenter {
    private readonly state;
    constructor();
    static attach(target: Record<string, unknown>): MetadataCenter;
    static bind(target: Record<string, unknown>, center: MetadataCenter): void;
    static read(target: Record<string, unknown> | undefined): MetadataCenter | undefined;
    writeRequestTruth<K extends keyof MetadataCenterRequestTruth>(key: K, value: MetadataCenterRequestTruth[K], writtenBy: MetadataCenterWriter, reason?: string): void;
    writeContinuationContext<K extends keyof MetadataCenterContinuationContext>(key: K, value: MetadataCenterContinuationContext[K], writtenBy: MetadataCenterWriter, reason?: string): void;
    readRequestTruth(): MetadataCenterRequestTruth;
    readContinuationContext(): MetadataCenterContinuationContext;
    writeRuntimeControl<K extends keyof MetadataCenterRuntimeControl>(key: K, value: MetadataCenterRuntimeControl[K], writtenBy: MetadataCenterWriter, reason?: string): void;
    releaseRuntimeControl<K extends keyof MetadataCenterRuntimeControl>(key: K, changedBy: MetadataCenterWriter, reason?: string): void;
    readRuntimeControl(): MetadataCenterRuntimeControl;
    writeProviderObservation<K extends keyof MetadataCenterProviderObservation>(key: K, value: MetadataCenterProviderObservation[K], writtenBy: MetadataCenterWriter, reason?: string): void;
    readProviderObservation(): MetadataCenterProviderObservation;
    writeClientAttachmentScope<K extends keyof MetadataCenterClientAttachmentScope>(key: K, value: MetadataCenterClientAttachmentScope[K], writtenBy: MetadataCenterWriter, reason?: string): void;
    readClientAttachmentScope(): MetadataCenterClientAttachmentScope;
    writeDebugSnapshot<K extends keyof MetadataCenterDebugSnapshot>(key: K, value: MetadataCenterDebugSnapshot[K], writtenBy: MetadataCenterWriter, reason?: string): void;
    readDebugSnapshot(): MetadataCenterDebugSnapshot;
    markReleased(writtenBy: MetadataCenterWriter, reason?: string): void;
    snapshot(): MetadataCenterState;
}
export declare const METADATA_CENTER_RUNTIME_SYMBOL: symbol;
export type MetadataCenterReleasedSnapshot = {
    requestId?: string;
    sessionId?: string;
    releasedAt: number;
    reason?: string;
    state: MetadataCenterState;
};
export declare function readReleasedMetadataCenterSessionBuffer(sessionId: string): MetadataCenterReleasedSnapshot[];
export declare function releaseMetadataCenterForHttpResponse(metadata: unknown, reason?: string): void;
