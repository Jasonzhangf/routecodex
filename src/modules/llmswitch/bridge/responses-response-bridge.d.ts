import { type Readable } from 'node:stream';
/**
 * /v1/responses response-side handler bridge surface.
 *
 * Single projection-facing bridge entry for responses SSE/JSON projection and
 * continuation lifecycle writes on the response path.
 */
import type { AnyRecord } from './module-loader.js';
import { createResponsesJsonToSseConverter } from './index.js';
export type ResponsesRequestContextForHttp = {
    payload: AnyRecord;
    context: AnyRecord;
    sessionId?: string;
    conversationId?: string;
    matchedPort?: number;
    routingPolicyGroup?: string;
};
export declare function resolveResponsesRequestContextForHttp(args: {
    metadata?: unknown;
}): ResponsesRequestContextForHttp | undefined;
type ChatUsageNormalizationResultForHttp = {
    payload: unknown;
    normalized: boolean;
    source?: 'body' | 'usage_log';
};
export declare function buildResponsesRequestLogContextForHttp(args: {
    metadata?: unknown;
    usageLogInfo?: Record<string, unknown> | null;
}): Record<string, unknown>;
export declare function normalizeChatUsagePayloadForHttp(body: unknown, options: {
    entryEndpoint?: string;
    usageFallback?: Record<string, unknown>;
}): ChatUsageNormalizationResultForHttp;
export declare function shouldDispatchResponsesSseToClientForHttp(args: {
    body: unknown;
    forceSSE: boolean;
    metadata?: Record<string, unknown>;
}): boolean;
export declare function buildClientSseKeepaliveFrameForHttp(entryEndpoint?: string): string;
export declare function shouldRequireResponsesTerminalEventForHttp(args: {
    entryEndpoint?: string;
    probe: unknown;
}): boolean;
export declare function resolveResponsesTerminalProbeFinishReasonForHttp(args: {
    finishReason?: string;
    probe: unknown;
}): string | undefined;
export declare function shouldClearResponsesConversationOnClientCloseForHttp(args: {
    entryEndpoint?: string;
    closeBeforeStreamEnd: boolean;
}): boolean;
export declare function shouldClearResponsesConversationOnFailureForHttp(args: {
    entryEndpoint?: string;
    status: number;
    phase: 'sse_stream_error' | 'sse_incomplete' | 'json_empty' | 'json';
}): boolean;
export declare function resolveResponsesConversationClearReasonForHttp(phase: 'sse_stream_error' | 'sse_incomplete' | 'json_empty' | 'json'): 'sse-stream-error' | 'sse-incomplete' | 'json-empty-error' | 'json-error';
export declare function isToolCallContinuationResponseForHttp(body: unknown): boolean;
export declare function inspectResponsesContinuationProbeForHttp(args: {
    entryEndpoint?: string;
    probe: unknown;
}): {
    isToolCallContinuation: boolean;
    hasRequiredAction: boolean;
    hasHarvestableFunctionCallHistory: boolean;
};
export declare function planResponsesContinuationCloseActionForHttp(args: {
    entryEndpoint?: string;
    requestContextPresent: boolean;
    probe: unknown;
}): {
    action: 'persist_continuation' | 'clear_abandoned';
    keepForSubmitToolOutputs: boolean;
};
export declare function rebindResponsesConversationRequestIdForHttp(oldId?: string, newId?: string): Promise<void>;
type PersistResponsesConversationLifecycleForHttpArgs = {
    entryEndpoint?: string;
    requestLabel: string;
    timingRequestIds?: string[];
    providerKey?: string;
    continuationOwner?: 'direct' | 'relay';
    sessionId?: unknown;
    conversationId?: unknown;
    usageLogInfo?: {
        providerKey?: string;
        timingRequestIds?: string[];
        sessionId?: unknown;
        conversationId?: unknown;
    };
    metadata?: Record<string, unknown>;
    requestContext?: ResponsesRequestContextForHttp;
    body: unknown;
    onTrace?: (stage: string, details?: Record<string, unknown>) => void;
    onNonBlockingError?: (operation: string, error: unknown) => void;
};
export type PersistResponsesConversationLifecycleResultForHttp = {
    recorded: true;
    responseId: string;
} | {
    recorded: false;
    reason: 'not_responses_endpoint' | 'not_continuation' | 'missing_response_id' | 'no_recorded_request_context' | 'already_persisted';
};
export declare function attachResponsesConversationLifecycleStreamForHttp(args: {
    stream: Readable;
    entryEndpoint?: string;
    requestLabel: string;
    usageLogInfo?: PersistResponsesConversationLifecycleForHttpArgs['usageLogInfo'];
    metadata?: Record<string, unknown>;
    requestContext?: ResponsesRequestContextForHttp;
    onTrace?: (stage: string, details?: Record<string, unknown>) => void;
    onNonBlockingError?: (operation: string, error: unknown) => void;
}): Readable;
export declare function persistResponsesConversationLifecycleForHttp(args: PersistResponsesConversationLifecycleForHttpArgs): Promise<PersistResponsesConversationLifecycleResultForHttp>;
export declare function clearResponsesConversationRequestIdsForHttp(args: {
    requestLabel: string;
    timingRequestIds?: string[];
    responseId?: string;
    reason: string;
    onNonBlockingError?: (operation: string, error: unknown) => void;
}): Promise<void>;
export declare function createChatJsonToSseConverterForHttp(): Promise<{
    convertResponseToJsonToSse(payload: unknown, options: AnyRecord): Promise<unknown>;
}>;
export declare function shouldReprojectRelayResponsesSseForHttp(args: {
    entryEndpoint?: string;
    continuationOwner?: 'direct' | 'relay';
    hasSseStream: boolean;
}): boolean;
export declare function resolveRelayResponsesClientSseStreamForHttp(args: {
    entryEndpoint?: string;
    continuationOwner?: 'direct' | 'relay';
    sseStream?: unknown;
    body?: Record<string, unknown>;
    requestId: string;
    createConverter?: typeof createResponsesJsonToSseConverter;
}): Promise<import('node:stream').Readable | undefined>;
export declare function buildResponsesSseErrorPayloadForHttp(args: {
    requestLabel: string;
    status: number;
    message: string;
    code: string;
    error?: Record<string, unknown>;
}): Record<string, unknown>;
export declare function buildResponsesStructuredSseErrorPayloadForHttp(args: {
    body: unknown;
    requestLabel: string;
    status: number;
}): Record<string, unknown> | null;
export declare function buildResponsesMissingSseBridgeErrorPayloadForHttp(requestLabel: string, status?: number): Record<string, unknown>;
export declare function buildResponsesStreamIncompleteErrorPayloadForHttp(requestLabel: string): Record<string, unknown>;
export declare function prepareResponsesJsonBodyForSseBridgeForHttp(args: {
    body: unknown;
    entryEndpoint?: string;
    requestLabel?: string;
}): Promise<Record<string, unknown> | null>;
export declare function normalizeResponsesJsonBodyForHttp(args: {
    body: unknown;
    entryEndpoint?: string;
    requestLabel?: string;
    resolveBridge?: typeof importResponsesHandlerCoreDist;
}): Promise<unknown>;
export declare function requireResponsesHandlerCoreDist<TModule extends object>(specifier: string): TModule;
export declare function importResponsesHandlerCoreDist<TModule extends object>(specifier: string): Promise<TModule>;
export declare function buildResponsesPayloadFromChatForHttp(payload: unknown, context?: Record<string, unknown>): Promise<unknown>;
export declare function projectResponsesClientPayloadForClientForHttp(args: {
    payload: unknown;
    toolsRaw: unknown[];
    metadata?: Record<string, unknown>;
}): Promise<Record<string, unknown>>;
export declare function normalizeResponsesClientPayloadForHttp(args: {
    payload: unknown;
    entryEndpoint?: string;
    requestContext?: {
        payload: AnyRecord;
        context: AnyRecord;
        sessionId?: string;
        conversationId?: string;
        matchedPort?: number;
        routingPolicyGroup?: string;
    };
    metadata?: Record<string, unknown>;
}): Promise<unknown>;
export declare function resolveResponsesClientPayloadFinishReasonForHttp(payload: unknown): string | undefined;
export declare function prepareResponsesJsonSseDispatchPlanForHttp(args: {
    responsesPayload: Record<string, unknown>;
    entryEndpoint?: string;
    requestLabel: string;
    metadata?: Record<string, unknown>;
    requestContext?: {
        payload: AnyRecord;
        context: AnyRecord;
        sessionId?: string;
        conversationId?: string;
        matchedPort?: number;
        routingPolicyGroup?: string;
    };
}): Promise<{
    normalizedPayload: Record<string, unknown>;
    sanitizedPayload: Record<string, unknown>;
}>;
export declare function prepareResponsesJsonClientDispatchPlanForHttp(args: {
    body: unknown;
    entryEndpoint?: string;
    requestLabel?: string;
    requestContext?: {
        payload: AnyRecord;
        context: AnyRecord;
        sessionId?: string;
        conversationId?: string;
        matchedPort?: number;
        routingPolicyGroup?: string;
    };
    metadata?: Record<string, unknown>;
    resolveBridge?: typeof importResponsesHandlerCoreDist;
}): Promise<{
    clientBody: unknown;
    sanitizedBody: unknown;
    finishReason?: string;
}>;
export declare function persistResponsesConversationLifecycleAtChatProcessExitForHttp(args: {
    entryEndpoint?: string;
    requestLabel: string;
    usageLogInfo?: Record<string, unknown> | null;
    metadata?: Record<string, unknown>;
    requestContext?: ResponsesRequestContextForHttp;
    body: unknown;
    onTrace?: (stage: string, details?: Record<string, unknown>) => void;
    onNonBlockingError?: (operation: string, error: unknown) => void;
}): Promise<PersistResponsesConversationLifecycleResultForHttp>;
export {};
