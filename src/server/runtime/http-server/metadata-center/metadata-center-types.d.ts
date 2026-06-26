export type MetadataCenterFamily = 'request_truth' | 'continuation_context' | 'runtime_control' | 'provider_observation' | 'client_attachment_scope' | 'debug_snapshot';
export type MetadataCenterStatus = 'active' | 'consumed' | 'finalized' | 'released';
export type MetadataCenterWritePolicy = 'write_once' | 'replaceable' | 'append_only';
export type MetadataCenterWriter = {
    module: string;
    symbol: string;
    stage: string;
};
export type MetadataCenterHistoryEntry = {
    value: unknown;
    module: string;
    symbol: string;
    stage: string;
    at: number;
    reason?: string;
};
export type MetadataCenterSlot<T = unknown> = {
    value: T;
    family: MetadataCenterFamily;
    writtenBy: MetadataCenterWriter;
    status: MetadataCenterStatus;
    writePolicy: MetadataCenterWritePolicy;
    version: number;
    history: MetadataCenterHistoryEntry[];
};
export type MetadataCenterRequestTruth = {
    requestId?: string;
    pipelineId?: string;
    entryEndpoint?: string;
    sessionId?: string;
    conversationId?: string;
    clientRequestId?: string;
    portScope?: string;
};
export type MetadataCenterContinuationContext = {
    responsesRequestContext?: Record<string, unknown>;
    responsesResume?: Record<string, unknown>;
    previousResponseId?: string;
    responseId?: string;
    toolOutputs?: unknown[];
    continuationOwner?: string;
    resumeFrom?: Record<string, unknown>;
    chainId?: string;
    stickyScope?: string;
};
export type MetadataCenterStoplessRuntimeControl = {
    flowId?: string;
    repeatCount?: number;
    maxRepeats?: number;
    triggerHint?: string;
    continuationPrompt?: string;
    schemaFeedback?: Record<string, unknown>;
    active?: boolean;
    updatedAt?: number;
};
export type MetadataCenterStopMessageCompareContext = {
    armed?: boolean;
    mode?: 'off' | 'on' | 'auto' | string;
    allowModeOnly?: boolean;
    textLength?: number;
    maxRepeats?: number;
    used?: number;
    remaining?: number;
    active?: boolean;
    stopEligible?: boolean;
    hasCapturedRequest?: boolean;
    compactionRequest?: boolean;
    hasSeed?: boolean;
    decision?: 'trigger' | 'skip' | string;
    reason?: string;
    stage?: string;
    bdWorkState?: string;
    observationHash?: string;
    observationStableCount?: number;
    toolSignatureHash?: string;
};
export type MetadataCenterStopMessageClientInject = {
    ready?: boolean;
    reason?: string;
    sessionScope?: string;
    tmuxSessionId?: string;
};
export type MetadataCenterRuntimeControl = {
    routeHint?: string;
    routeName?: string;
    routeId?: string;
    providerProtocol?: string;
    retryProviderKey?: string;
    preselectedRoute?: Record<string, unknown>;
    responsesContinuationSavedAtChatProcessExit?: boolean;
    stopless?: MetadataCenterStoplessRuntimeControl;
    stopMessageCompareContext?: MetadataCenterStopMessageCompareContext;
    stopMessageEnabled?: boolean;
    stopMessageExcludeDirect?: boolean;
    stopMessageClientInject?: MetadataCenterStopMessageClientInject;
    streamIntent?: string;
    clientAbort?: boolean;
};
export type MetadataCenterProviderObservation = {
    target?: Record<string, unknown>;
    providerKey?: string;
    assignedModelId?: string;
    modelId?: string;
    clientModelId?: string;
    compatibilityProfile?: string;
    responseSemantics?: Record<string, unknown>;
    finishReason?: string;
};
export type MetadataCenterClientAttachmentScope = {
    daemonId?: string;
    tmuxSessionId?: string;
    tmuxTarget?: string;
    workdir?: string;
};
export type MetadataCenterDebugSnapshot = {
    snapshotId?: string;
    bridgeHistory?: unknown[];
    traceMarkers?: unknown[];
};
export type MetadataCenterState = {
    requestTruth: Partial<Record<keyof MetadataCenterRequestTruth, MetadataCenterSlot>>;
    continuationContext: Partial<Record<keyof MetadataCenterContinuationContext, MetadataCenterSlot>>;
    runtimeControl: Partial<Record<keyof MetadataCenterRuntimeControl, MetadataCenterSlot>>;
    providerObservation: Partial<Record<keyof MetadataCenterProviderObservation, MetadataCenterSlot>>;
    clientAttachmentScope: Partial<Record<keyof MetadataCenterClientAttachmentScope, MetadataCenterSlot>>;
    debugSnapshot: Partial<Record<keyof MetadataCenterDebugSnapshot, MetadataCenterSlot>>;
};
