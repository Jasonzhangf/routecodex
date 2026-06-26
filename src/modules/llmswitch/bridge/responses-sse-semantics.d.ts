import type { AnyRecord } from './module-loader.js';
import type { ResponsesRequestContextForHttp } from './responses-response-bridge.js';
export declare function buildClientSseKeepaliveFrameForHttp(_entryEndpoint?: string): string;
export declare function shouldDropClientSseFrameForHttp(frame: string, entryEndpoint?: string): boolean;
type ResponsesSseFrameSummaryForHttp = {
    event?: string;
    type?: string;
    status?: string;
    finishReason?: string;
    hasRequiredAction?: boolean;
    requiredToolCalls?: number;
    outputFunctionCalls?: number;
    dataParse?: 'non_json';
};
export declare function summarizeResponsesSseFrameForLogForHttp(frame: string): ResponsesSseFrameSummaryForHttp | null;
export declare function resolveResponsesProviderProtocolHintFromSseFrameForHttp(frame: string): string | undefined;
export declare function createResponsesJsonToSseConverterForHttp(): Promise<{
    convertResponseToJsonToSse(payload: unknown, options: AnyRecord): Promise<unknown>;
}>;
export declare function projectResponsesSseFrameForClientForHttp(args: {
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
}): Promise<{
    emit: boolean;
    frame: string;
    state: {
        pendingApplyPatchArgumentDeltas: Record<string, string>;
        applyPatchCallIds: string[];
        emittedApplyPatchDoneCallIds: string[];
    };
}>;
export declare function normalizeResponsesSseFrameForClientForHttp(args: {
    frame: string;
    entryEndpoint?: string;
    requestContext?: ResponsesRequestContextForHttp;
    metadata?: Record<string, unknown>;
    projectionState?: {
        pendingApplyPatchArgumentDeltas: Record<string, string>;
        applyPatchCallIds: string[];
        emittedApplyPatchDoneCallIds: string[];
    };
    requestLabel?: string;
}): Promise<string>;
export {};
