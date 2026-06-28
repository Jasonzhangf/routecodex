export interface ProviderErrorRuntimeMetadata {
    requestId: string;
    providerKey?: string;
    providerId?: string;
    providerType?: string;
    providerProtocol?: string;
    routeName?: string;
    pipelineId?: string;
    target?: Record<string, unknown> | null;
    runtimeKey?: string;
    sessionDir?: string;
    rccUserDir?: string;
}
export interface ProviderErrorEvent {
    code: string;
    message: string;
    stage: string;
    status?: number;
    recoverable?: boolean;
    affectsHealth?: boolean;
    fatal?: boolean;
    errorClassification?: 'recoverable' | 'unrecoverable' | 'special_400' | string;
    runtime: ProviderErrorRuntimeMetadata;
    timestamp: number;
    routePool?: string[];
    excludedProviderKeys?: string[];
    details?: Record<string, unknown>;
}
export interface ProviderSuccessRuntimeMetadata {
    requestId: string;
    routeName?: string;
    providerKey?: string;
    providerId?: string;
    providerType?: string;
    providerProtocol?: string;
    pipelineId?: string;
    target?: Record<string, unknown> | null;
    runtimeKey?: string;
    sessionDir?: string;
    rccUserDir?: string;
}
export interface ProviderSuccessEvent {
    runtime: ProviderSuccessRuntimeMetadata;
    timestamp: number;
    metadata?: Record<string, unknown>;
    details?: Record<string, unknown>;
}
export interface ProviderUsageEvent {
    requestId: string;
    timestamp: number;
    providerKey: string;
    runtimeKey?: string;
    providerType: string;
    modelId?: string;
    routeName?: string;
    entryEndpoint?: string;
    success: boolean;
    latencyMs: number;
    promptTokens?: number;
    completionTokens?: number;
    totalTokens?: number;
}
