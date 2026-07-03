/**
 * Runtime Integrations Bridge
 *
 * Snapshot hooks, responses conversation helpers, SSE converter, and
 * provider runtime ingress hooks.
 */
import type { ProviderErrorEvent, ProviderSuccessEvent } from "../../../types/llmswitch-local-types.js";
import type { AnyRecord } from "./module-loader.js";
export declare function writeSnapshotViaHooks(channelOrOptions: string | AnyRecord, payload?: AnyRecord): Promise<void>;
export declare function captureResponsesRequestContextForRequest(args: {
    requestId: string;
    payload: AnyRecord;
    context: AnyRecord;
    sessionId?: string;
    conversationId?: string;
    routeHint?: string;
    providerKey?: string;
    entryKind?: 'responses' | 'chat' | 'messages';
    matchedPort?: number;
    routingPolicyGroup?: string;
}): Promise<void>;
export declare function recordResponsesResponseForRequest(args: {
    requestId: string;
    response: AnyRecord;
    routeHint?: string;
    sessionId?: string;
    conversationId?: string;
    providerKey?: string;
    entryKind?: 'responses' | 'chat' | 'messages';
    continuationOwner?: 'direct' | 'relay';
    matchedPort?: number;
    routingPolicyGroup?: string;
    allowScopeContinuation?: boolean;
}): Promise<void>;
export declare function resumeResponsesConversation(responseId: string, submitPayload: AnyRecord, options?: {
    requestId?: string;
    entryKind?: 'responses' | 'chat' | 'messages';
    continuationOwner?: 'direct' | 'relay';
    matchedPort?: number;
    routingPolicyGroup?: string;
}): Promise<{
    payload: AnyRecord;
    meta: AnyRecord;
}>;
export declare function lookupResponsesContinuationByResponseId(responseId: string, options?: {
    entryKind?: 'responses' | 'chat' | 'messages';
    continuationOwner?: 'direct' | 'relay';
    matchedPort?: number;
    routingPolicyGroup?: string;
}): Promise<{
    responseId: string;
    providerKey?: string;
    continuationOwner?: 'direct' | 'relay';
    entryKind?: 'responses' | 'chat' | 'messages';
    requestId?: string;
} | null>;
export declare function rebindResponsesConversationRequestId(oldId?: string, newId?: string): Promise<void>;
export declare function clearResponsesConversationByRequestId(requestId?: string): Promise<void>;
export declare function finalizeResponsesConversationRequestRetention(requestId?: string, options?: {
    keepForSubmitToolOutputs?: boolean;
}): Promise<void>;
export declare function resumeLatestResponsesContinuationByScope(args: {
    payload: AnyRecord;
    sessionId?: string;
    conversationId?: string;
    requestId?: string;
    entryKind?: 'responses' | 'chat' | 'messages';
    continuationOwner?: 'direct' | 'relay';
    matchedPort?: number;
    routingPolicyGroup?: string;
}): Promise<{
    payload: AnyRecord;
    meta: AnyRecord;
} | null>;
export declare function materializeLatestResponsesContinuationByScope(args: {
    payload: AnyRecord;
    sessionId?: string;
    conversationId?: string;
    requestId?: string;
    entryKind?: 'responses' | 'chat' | 'messages';
    continuationOwner?: 'direct' | 'relay';
    matchedPort?: number;
    routingPolicyGroup?: string;
}): Promise<{
    payload: AnyRecord;
    meta: AnyRecord;
} | null>;
export declare function clearAllResponsesConversationState(): Promise<void>;
export declare function clearUnresolvedResponsesConversationRequests(): Promise<number>;
export declare function resetResponsesConversationStateForRestartSimulation(): Promise<void>;
export declare function buildResponsesJsonFromSseStreamWithNative(input: {
    stream: AsyncIterable<string | Buffer>;
    requestId: string;
    model: string;
    config?: AnyRecord;
}): Promise<unknown>;
export declare function preloadCriticalBridgeRuntimeModules(): Promise<{
    loaded: string[];
}>;
export declare function reportProviderErrorToRouterPolicy(event: ProviderErrorEvent): Promise<ProviderErrorEvent>;
export declare function reportProviderSuccessToRouterPolicy(event: ProviderSuccessEvent): Promise<ProviderSuccessEvent>;
