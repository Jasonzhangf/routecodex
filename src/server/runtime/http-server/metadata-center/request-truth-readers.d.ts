export type RuntimeRequestTruthIdentifiers = {
    sessionId?: string;
    conversationId?: string;
};
export declare function readRuntimeRequestTruthSessionId(metadata: Record<string, unknown> | undefined): string | undefined;
export type RuntimeProviderObservationProjection = {
    target?: Record<string, unknown>;
    providerKey?: string;
    assignedModelId?: string;
    modelId?: string;
    clientModelId?: string;
    compatibilityProfile?: string;
    finishReason?: string;
    responseSemantics?: Record<string, unknown>;
};
export type RuntimeControlProjection = {
    routeHint?: string;
    routeName?: string;
    routeId?: string;
    providerProtocol?: string;
    retryProviderKey?: string;
    preselectedRoute?: Record<string, unknown>;
    stopless?: {
        flowId?: string;
        repeatCount?: number;
        maxRepeats?: number;
        triggerHint?: string;
        continuationPrompt?: string;
        schemaFeedback?: Record<string, unknown>;
        active?: boolean;
        updatedAt?: number;
    };
    stopMessageCompareContext?: {
        armed?: boolean;
        mode?: string;
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
        decision?: string;
        reason?: string;
        stage?: string;
        bdWorkState?: string;
        observationHash?: string;
        observationStableCount?: number;
        toolSignatureHash?: string;
    };
    stopMessageEnabled?: boolean;
    stopMessageExcludeDirect?: boolean;
    streamIntent?: string;
    clientAbort?: boolean;
};
export type RuntimeServerToolProjection = RuntimeRequestTruthIdentifiers & {
    assignedModelId?: string;
    compatibilityProfile?: string;
    stopless?: RuntimeControlProjection['stopless'];
};
export declare function writeStoplessRuntimeControl(args: {
    metadata: Record<string, unknown>;
    value: NonNullable<RuntimeControlProjection['stopless']>;
    writer: {
        module: string;
        symbol: string;
        stage: string;
    };
    reason?: string;
}): void;
export declare function readRuntimeRequestTruthIdentifiers(metadata: Record<string, unknown> | undefined): RuntimeRequestTruthIdentifiers;
export declare function readRuntimeProviderObservationProjection(metadata: Record<string, unknown> | undefined): RuntimeProviderObservationProjection;
export declare function readRuntimeControlProjection(metadata: Record<string, unknown> | undefined): RuntimeControlProjection;
export declare function readRuntimeServerToolProjection(metadata: Record<string, unknown> | undefined): RuntimeServerToolProjection;
