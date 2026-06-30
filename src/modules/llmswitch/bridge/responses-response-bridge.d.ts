/**
 * /v1/responses response-side handler bridge surface.
 *
 * Single projection-facing bridge entry for Responses JSON projection and
 * direct-continuation closeout IO.
 */
import type { AnyRecord } from './module-loader.js';
export type ResponsesRequestContextForHttp = {
    payload: AnyRecord;
    context: AnyRecord;
    sessionId?: string;
    conversationId?: string;
    matchedPort?: number;
    routingPolicyGroup?: string;
};
export declare function buildResponsesRequestLogContextForHttp(args: {
    metadata?: unknown;
    usageLogInfo?: Record<string, unknown> | null;
}): Record<string, unknown>;
export declare function rebindResponsesConversationRequestIdForHttp(oldId?: string, newId?: string): Promise<void>;
export declare function requireResponsesHandlerCoreDist<TModule extends object>(specifier: string): TModule;
export declare function importResponsesHandlerCoreDist<TModule extends object>(specifier: string): Promise<TModule>;
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
}>;
export {};
