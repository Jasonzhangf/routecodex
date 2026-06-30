/**
 * Native Binding Exports Bridge
 *
 * Thin wrappers around llmswitch-core native bindings.
 */
import { type AnyRecord } from './module-loader.js';
import type { ToolExecutionFailureSignal } from './snapshot-recorder-types.js';
type NativeFailureClassification = unknown;
type NativeRouterHotpathJsonBinding = Record<string, unknown>;
export declare function getRouterHotpathJsonBindingSync(): NativeRouterHotpathJsonBinding;
export declare function mapChatToolsToBridgeJson(rawTools: unknown): Promise<AnyRecord[]>;
export declare function injectMcpToolsForChatJson(tools: unknown[] | undefined, discoveredServers: string[]): Promise<AnyRecord[]>;
export declare function injectMcpToolsForResponsesJson(tools: unknown[] | undefined, discoveredServers: string[]): Promise<AnyRecord[]>;
export declare function normalizeAssistantTextToToolCallsJson(message: Record<string, unknown>, options?: Record<string, unknown>): Promise<AnyRecord>;
export declare function captureReqInboundResponsesContextSnapshotJson(input: {
    rawRequest: Record<string, unknown>;
    requestId?: string;
    toolCallIdStyle?: unknown;
}): AnyRecord;
export declare function captureReqInboundResponsesContextSnapshot(input: {
    rawRequest: Record<string, unknown>;
    requestId?: string;
    toolCallIdStyle?: unknown;
}): Promise<AnyRecord>;
export declare function planResponsesHandlerEntry(payload: unknown, entryEndpoint?: string, responseIdFromPath?: string): Promise<{
    mode: 'none' | 'submit_tool_outputs' | 'scope_materialize';
    responseId?: string;
    payload: AnyRecord;
}>;
export declare function buildAnthropicResponseFromChatJson(chatResponse: unknown, aliasMap?: Record<string, string>): Promise<AnyRecord>;
export declare function sanitizeProviderOutboundPayload(input: {
    protocol?: string;
    compatibilityProfile?: string;
    payload: Record<string, unknown>;
}): Promise<AnyRecord>;
export declare function hasDeclaredApplyPatchToolNative(payload: unknown): boolean;
export declare function evaluateSingletonRoutePoolExhaustionNative(input: {
    pipelineError: unknown;
    initialRoutePoolLen?: number | null;
    explicitSingletonPool?: boolean;
    excludedProviderCount: number;
}): {
    shouldBlock: boolean;
    waitMs?: number;
    candidateProviderCount?: number;
};
export declare function planPrimaryExhaustedToDefaultPoolNative(input: {
    route: string;
    tiers: Array<{
        id: string;
        targets: string[];
        priority: number;
        backup?: boolean;
    }>;
    exhaustedTargets: string[];
    knownTargets: string[];
}): {
    status: 'no_default_pool_needed' | 'default_pool' | 'unknown_target' | 'route_not_configured';
    defaultPoolTargets: string[];
    fromTierId?: string | null;
    fromTierPriority?: number | null;
};
export declare function convertResponsesRequestToChatNative(payload: Record<string, unknown>, options?: Record<string, unknown>): AnyRecord;
export declare function evaluateResponsesDirectRouteDecisionNative(input: {
    payload: Record<string, unknown>;
    metadata?: Record<string, unknown>;
    inboundProtocol: string;
    applyPatchMode?: string;
}): {
    providerWireValid: boolean;
    requiresHubRelay: boolean;
    reason?: string;
    hasDeclaredApplyPatchTool?: boolean;
};
export declare function buildResponsesPayloadFromChatNative(payload: unknown, context?: Record<string, unknown>): Record<string, unknown>;
export declare function projectResponsesClientPayloadForClientNative(args: {
    payload: unknown;
    toolsRaw: unknown[];
    metadata?: Record<string, unknown>;
}): Record<string, unknown>;
export declare function projectResponsesSseFrameForClientNative(args: {
    frame: string;
    eventName?: string;
    data: Record<string, unknown>;
    toolsRaw: unknown[];
    metadata?: Record<string, unknown>;
    state: {
        pendingApplyPatchArgumentDeltas: Record<string, string>;
        applyPatchCallIds: string[];
        emittedApplyPatchDoneCallIds: string[];
    };
}): {
    emit: boolean;
    frame: string;
    state: {
        pendingApplyPatchArgumentDeltas: Record<string, string>;
        applyPatchCallIds: string[];
        emittedApplyPatchDoneCallIds: string[];
    };
};
export declare function projectSseErrorEventPayloadNative(args: {
    requestId: string;
    status: number;
    message: string;
    code: string;
    error?: Record<string, unknown>;
}): {
    type: 'error';
    status: number;
    error: Record<string, unknown>;
};
export declare function describeHubPipelineContractsNative(): AnyRecord;
export declare function describeVirtualRouterContractsNative(): AnyRecord;
export declare function describeMetaCarrierContractsNative(): AnyRecord;
export declare function describePipelineContractNative(nodeId: string): AnyRecord;
export declare function validatePipelineNodeContractBoundaryNative(nodeId: string, before: unknown, after: unknown): AnyRecord;
export declare function classifyProviderFailure(statusCode: number | undefined, errorCode: string | undefined, upstreamCode: string | undefined, isNetworkError: boolean): string;
export declare function deriveFinishReasonNative(body: unknown): string | undefined;
export declare function isToolCallContinuationResponseNative(body: unknown): boolean;
export declare function isEmptyClientResponsePayloadNative(body: unknown): boolean;
export declare function classifyEmptyResponseSignalNative(stage: string, body: unknown): {
    errorType: string;
    matchedText: string;
    responseSummary: Record<string, unknown>;
} | null;
export declare function detectToolExecutionFailuresNative(body: unknown): ToolExecutionFailureSignal[];
export declare function resolveProviderResponseRequestSemanticsNative(processed: Record<string, unknown> | undefined, standardized: Record<string, unknown> | undefined, requestMetadata: Record<string, unknown> | undefined): Record<string, unknown> | undefined;
export declare function updateResponsesContractProbeFromSseChunkNative(chunk: unknown, probe: Record<string, unknown> | undefined): Record<string, unknown>;
export declare function buildResponsesTerminalSseFramesFromProbeNative(probe: Record<string, unknown> | undefined, requestLabel: string): string[];
export declare function extractServertoolCliResultRouteHintFromRequestNative(input: {
    adapterContext?: Record<string, unknown>;
    runtimeMetadata?: Record<string, unknown>;
}): string | undefined;
export declare function resolveProviderRetryExecutionPolicyNative(input: {
    classification: NativeFailureClassification;
    isStreamingRequest?: boolean;
    hostContractFailure?: boolean;
    forceExcludeCurrentProviderOnRetry?: boolean;
    errorCode?: string;
    promptTooLong?: boolean;
    existingExclusion?: boolean;
}): {
    excludeCurrentProvider: boolean;
    reason: string;
};
export declare function getNetworkErrorCodes(): string[];
export {};
