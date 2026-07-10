type AnyRecord = Record<string, unknown>;
type ResponsesContinuationEntryKind = 'responses' | 'chat' | 'messages';
interface CaptureContextArgs {
    requestId?: string;
    payload: AnyRecord;
    context: AnyRecord;
    sessionId?: string;
    conversationId?: string;
    providerKey?: string;
    entryKind?: ResponsesContinuationEntryKind;
    matchedPort?: number;
    routingPolicyGroup?: string;
    routeHint?: string;
}
interface RecordResponseArgs {
    requestId?: string;
    response: AnyRecord;
    sessionId?: string;
    conversationId?: string;
    providerKey?: string;
    entryKind?: ResponsesContinuationEntryKind;
    continuationOwner?: 'direct' | 'relay';
    matchedPort?: number;
    routingPolicyGroup?: string;
    allowScopeContinuation?: boolean;
    routeHint?: string;
}
interface ResumeOptions {
    requestId?: string;
    entryKind?: ResponsesContinuationEntryKind;
    continuationOwner?: 'direct' | 'relay';
    matchedPort?: number;
    routingPolicyGroup?: string;
}
interface RestoreByScopeArgs {
    payload: AnyRecord;
    sessionId?: string;
    conversationId?: string;
    requestId?: string;
    entryKind?: ResponsesContinuationEntryKind;
    continuationOwner?: 'direct' | 'relay';
    matchedPort?: number;
    routingPolicyGroup?: string;
}
interface ResumeResult {
    payload: AnyRecord;
    meta: AnyRecord;
}
interface ContinuationLookupOptions {
    entryKind?: ResponsesContinuationEntryKind;
    continuationOwner?: 'direct' | 'relay';
    matchedPort?: number;
    routingPolicyGroup?: string;
}
interface ResponsesStoreLookupResult {
    responseId: string;
    providerKey?: string;
    continuationOwner?: 'direct' | 'relay';
    entryKind?: ResponsesContinuationEntryKind;
    requestId?: string;
}
declare class ResponsesConversationStore {
    private requestMap;
    private responseIndex;
    private scopeIndex;
    private pruneTimer;
    private lastPruneAt;
    private persistenceLoaded;
    private ensurePersistenceLoaded;
    private flushPersistence;
    getDebugStats(): {
        requestMapSize: number;
        responseIndexSize: number;
        scopeIndexSize: number;
        requestEntriesWithoutLastResponseId: number;
        retainedInputItems: number;
    };
    rebindRequestId(oldId: string | undefined, newId: string | undefined): void;
    captureRequestContext(args: CaptureContextArgs): void;
    recordResponse(args: RecordResponseArgs): void;
    resumeConversation(responseId: string, submitPayload: AnyRecord, options?: ResumeOptions): ResumeResult;
    lookupContinuationByResponseId(responseId: string, options?: ContinuationLookupOptions): ResponsesStoreLookupResult | null;
    clearRequest(requestId?: string): void;
    clearUnresolvedRequests(): number;
    releaseRequestPayload(requestId?: string): void;
    finalizeResponsesConversationRequestRetention(requestId?: string, options?: {
        keepForSubmitToolOutputs?: boolean;
    }): void;
    resumeLatestContinuationByScope(args: RestoreByScopeArgs): ResumeResult | null;
    materializeLatestContinuationByScope(args: RestoreByScopeArgs): ResumeResult | null;
    private cleanupEntry;
    private attachEntryScopes;
    private detachEntry;
    private prune;
    private pruneIndexes;
    startPruneTimer(): void;
    private stopPruneTimer;
    clearAll(): void;
    clearAllAndPersist(): void;
    getLastPruneAt(): number;
}
declare const store: ResponsesConversationStore;
export declare function captureResponsesRequestContext(args: CaptureContextArgs): void;
export declare function recordResponsesResponse(args: RecordResponseArgs): void;
export declare function resumeResponsesConversation(responseId: string, submitPayload: AnyRecord, options?: ResumeOptions): ResumeResult;
export declare function lookupResponsesContinuationByResponseId(responseId: string, options?: ContinuationLookupOptions): ResponsesStoreLookupResult | null;
export declare function clearResponsesConversationByRequestId(requestId?: string): void;
export declare function finalizeResponsesConversationRequestRetention(requestId?: string, options?: {
    keepForSubmitToolOutputs?: boolean;
}): void;
export declare function rebindResponsesConversationRequestId(oldId?: string, newId?: string): void;
export declare function resumeLatestResponsesContinuationByScope(args: RestoreByScopeArgs): ResumeResult | null;
export declare function materializeLatestResponsesContinuationByScope(args: RestoreByScopeArgs): ResumeResult | null;
export declare function clearAllResponsesConversationState(): void;
export declare function resetResponsesConversationStateForRestartSimulation(): void;
export declare function clearUnresolvedResponsesConversationRequests(): number;
