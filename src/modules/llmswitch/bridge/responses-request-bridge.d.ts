/**
 * /v1/responses request-side handler bridge surface.
 *
 * Single handler-facing bridge entry for request preparation and
 * request/response conversation store writes on the handler side.
 */
import type { AnyRecord } from './module-loader.js';
export type ResponsesRequestContextForHttp = {
    payload: AnyRecord;
    context: {
        input: unknown[];
        toolsRaw?: unknown[];
    };
    sessionId?: string;
    conversationId?: string;
    matchedPort?: number;
    routingPolicyGroup?: string;
};
export type PrepareResponsesHandlerEntryForHttpArgs = {
    payload: AnyRecord;
    entryEndpoint: string;
    responseIdFromPath?: string;
    requestId: string;
    sessionId?: string;
    conversationId?: string;
    matchedPort?: number;
    routingPolicyGroup?: string;
};
export type ResponsesConversationPortScopeForHttp = {
    matchedPort?: number;
    routingPolicyGroup?: string;
};
export type ResponsesHandlerStreamPlanForHttp = {
    originalStream: boolean;
    outboundStream: boolean;
    inboundStream: boolean;
    acceptsSse: boolean;
    requestStartMeta: Record<string, unknown>;
};
export type PrepareResponsesHandlerRuntimeForHttpArgs = {
    payload: AnyRecord;
    entryEndpoint: string;
    responseIdFromPath?: string;
    requestId: string;
    requestMetadata?: Record<string, unknown>;
    portScope?: ResponsesConversationPortScopeForHttp;
    forceStream?: boolean;
    acceptsSse: boolean;
    requestTimeoutMs?: number;
};
export type PrepareResponsesHandlerRuntimeForHttpResult = {
    kind: 'ok';
    payload: AnyRecord;
    requestContext: ResponsesRequestContextForHttp;
    pipelineEntryEndpoint: string;
    isSubmitToolOutputs: boolean;
    resumeMeta?: Record<string, unknown>;
    streamPlan: ResponsesHandlerStreamPlanForHttp;
} | {
    kind: 'client_error';
    status: number;
    body: Record<string, unknown>;
    streamPlan: ResponsesHandlerStreamPlanForHttp;
};
export type PreparedResponsesRequestBodyForHttp = {
    requestBodyMetadata?: Record<string, unknown>;
    pipelineBody: AnyRecord;
};
export declare function prepareResponsesRequestBodyForHttp(payload: AnyRecord, _runtimeMetadata?: Record<string, unknown>): PreparedResponsesRequestBodyForHttp;
export declare function buildResponsesPipelineMetadataForHttp(args: {
    streamPlan: ResponsesHandlerStreamPlanForHttp;
    clientRequestId?: string;
    clientHeaders?: Record<string, unknown>;
    clientConnectionState?: unknown;
    resumeMeta?: Record<string, unknown>;
    requestContext: ResponsesRequestContextForHttp;
}): Record<string, unknown>;
export declare function buildResponsesConversationPortScopeForHttp(portContext: {
    matchedPort?: unknown;
    localPort?: unknown;
    routingPolicyGroup?: unknown;
} | null | undefined): ResponsesConversationPortScopeForHttp;
export declare function planResponsesHandlerStreamForHttp(args: {
    payload: AnyRecord;
    forceStream?: boolean;
    acceptsSse: boolean;
    requestTimeoutMs?: number;
}): ResponsesHandlerStreamPlanForHttp;
export declare function readResponsesSessionIdFromHttp(metadata: Record<string, unknown> | undefined): string | undefined;
export declare function readResponsesConversationIdFromHttp(metadata: Record<string, unknown> | undefined): string | undefined;
export declare function readRequestBodyMetadataForHttp(payload: unknown): Record<string, unknown> | undefined;
export declare function stripRequestBodyMetadataForPipelineForHttp<T>(payload: T): T;
export declare function readClientAbortSignalForHttp(clientConnectionState: unknown): AbortSignal | undefined;
export declare function shouldPersistResponsesConversationForHttp(payload: unknown): boolean;
export declare function readResponsesResponseIdFromHttp(body: unknown): string | undefined;
export type PrepareResponsesHandlerEntryForHttpResult = {
    kind: 'ok';
    payload: AnyRecord;
    pipelineEntryEndpoint: string;
    plannedEntryMode: 'none' | 'submit_tool_outputs' | 'scope_materialize';
    isSubmitToolOutputs: boolean;
    resumeMeta?: Record<string, unknown>;
} | {
    kind: 'scope_continuation_expired';
};
export declare function finalizeResponsesHandlerPayloadForHttp(args: {
    payload: AnyRecord;
    entryEndpoint: string;
    isSubmitToolOutputs: boolean;
    outboundStream: boolean;
}): AnyRecord;
export declare function shouldManageResponsesConversationForHttp(entryEndpoint?: string): boolean;
export declare function buildResponsesScopeContinuationExpiredErrorForHttp(): {
    error: {
        message: string;
        type: 'invalid_request_error';
        code: 'responses_continuation_expired';
    };
};
export declare function buildResponsesResumeClientErrorForHttp(args: {
    status?: number;
    code?: string;
    origin?: string;
    message?: string;
}): {
    status: number;
    body: {
        error: {
            message: string;
            type: 'invalid_request_error';
            code: string;
            origin: string;
        };
    };
};
export declare function shouldProjectResponsesResumeClientErrorForHttp(args: {
    origin?: string;
}): boolean;
export declare function buildResponsesRequestContextForHttp(args: {
    payload: AnyRecord;
    requestId?: string;
    metadata?: Record<string, unknown>;
    resumeMeta?: Record<string, unknown>;
    matchedPort?: number;
    routingPolicyGroup?: string;
}): Promise<ResponsesRequestContextForHttp>;
export declare function prepareResponsesHandlerEntryForHttp(args: PrepareResponsesHandlerEntryForHttpArgs): Promise<PrepareResponsesHandlerEntryForHttpResult>;
export declare function prepareResponsesHandlerRuntimeForHttp(args: PrepareResponsesHandlerRuntimeForHttpArgs): Promise<PrepareResponsesHandlerRuntimeForHttpResult>;
export declare function captureResponsesRequestContextForHttp(args: {
    requestId: string;
    payload: AnyRecord;
    context: AnyRecord;
    sessionId?: string;
    conversationId?: string;
    providerKey?: string;
    entryKind?: 'responses' | 'chat' | 'messages';
    matchedPort?: number;
    routingPolicyGroup?: string;
}): Promise<void>;
export declare function attachResponsesRequestContextToResultForHttp(args: {
    entryEndpoint?: string;
    resultMetadata: Record<string, unknown> | undefined;
    requestContext: ResponsesRequestContextForHttp;
}): Record<string, unknown> | undefined;
export declare function recordResponsesResponseForHttp(args: {
    requestId: string;
    response: AnyRecord;
    providerKey?: string;
    matchedPort?: number;
    routingPolicyGroup?: string;
    sessionId?: string;
    conversationId?: string;
    entryKind?: 'responses' | 'chat' | 'messages';
    routeHint?: string;
}): Promise<void>;
export declare function seedResponsesToolCallResponseForHttp(args: {
    body: unknown;
    requestContext?: {
        payload?: Record<string, unknown>;
        context?: Record<string, unknown>;
        sessionId?: string;
        conversationId?: string;
        matchedPort?: number;
        routingPolicyGroup?: string;
    };
    providerKey?: string;
    routeHint?: string;
}): Promise<void>;
export declare function finalizeResponsesPipelineResultForHttp(args: {
    entryEndpoint?: string;
    body: unknown;
    resultMetadata: Record<string, unknown> | undefined;
    requestContext: ResponsesRequestContextForHttp;
    providerKey?: string;
    routeHint?: string;
}): Promise<Record<string, unknown> | undefined>;
export declare function clearResponsesConversationByRequestIdForHttp(requestId?: string): Promise<void>;
export declare function clearResponsesConversationOnHandlerFailureForHttp(args: {
    requestId?: string;
    stage: 'timeout' | 'timeout_started' | 'error';
}): Promise<void>;
export declare function captureResponsesInboundToolHistoryErrorsampleForHttp(args: {
    requestId: string;
    entryEndpoint: string;
    body: unknown;
    error: unknown;
}): Promise<void>;
export declare function finalizeResponsesConversationRequestRetentionForHttp(requestId?: string, options?: {
    keepForSubmitToolOutputs?: boolean;
}): Promise<void>;
