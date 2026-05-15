export type PendingToolSyncPayload = {
    ready: boolean;
    insertAt: number;
};
export type ContinueExecutionInjectionPayload = {
    hasDirective: boolean;
};
export type ChatProcessMediaAnalysisPayload = {
    stripIndices: number[];
    containsCurrentTurnImage: boolean;
};
export type ChatProcessMediaStripPayload = {
    changed: boolean;
    messages: unknown[];
};
export type ChatWebSearchIntentPayload = {
    hasIntent: boolean;
    googlePreferred: boolean;
};
export type ClockClearDirectivePayload = {
    hadClear: boolean;
    next: string;
};
export type ProviderKeyParsePayload = {
    providerId: string | null;
    alias: string | null;
    keyIndex?: number;
};
export type ServertoolResponseStageToolCallPayload = {
    id: string;
    name: string;
    arguments: string;
};
export type ServertoolResponseStagePayload = {
    providerResponseShape: string;
    isCanonicalChatCompletionPayload: boolean;
    payloadContractSignal?: {
        reason: string;
        marker: string;
    } | null;
    normalizedPayload: unknown;
    toolCalls: ServertoolResponseStageToolCallPayload[];
};
export type ServertoolDispatchCandidatePayload = {
    id: string;
    name: string;
    arguments: string;
    executionMode: string;
    stripAfterExecute: boolean;
};
export type ServertoolDispatchSkippedPayload = {
    id: string;
    name: string;
    reason: string;
};
export type ServertoolDispatchPlanPayload = {
    executableToolCalls: ServertoolDispatchCandidatePayload[];
    skippedToolCalls: ServertoolDispatchSkippedPayload[];
};
export type ServertoolOutcomePlanPayload = {
    outcomeMode: string;
    remainingToolCallIds: string[];
    pendingSessionId?: string | null;
    aliasSessionIds: string[];
    pendingInjectionMessageKinds: string[];
    pendingInjectionMessagesResolved: unknown[];
    flowId?: string | null;
    useLastExecutionFollowup: boolean;
    useGenericFollowup: boolean;
    followupStrategy: string;
    requiresPendingInjection: boolean;
    primaryExecutionMode?: string | null;
    followupInjectionOps: string[];
    followupInjectionOpsResolved: unknown[];
};
export type ServertoolAutoHookPlanEntryPayload = {
    id: string;
    phase: string;
    priority: number;
    order: number;
};
export type ServertoolAutoHookQueuesPayload = {
    optionalQueue: ServertoolAutoHookPlanEntryPayload[];
    mandatoryQueue: ServertoolAutoHookPlanEntryPayload[];
};
export type ServertoolGenericFollowupPayload = {
    model: string;
    messages: unknown[];
    tools: unknown[];
    parameters?: Record<string, unknown>;
};
export type ServertoolFollowupFlowProfilePayload = {
    noFollowup?: boolean;
    autoLimit?: boolean;
    flowOnlyLoopLimit?: boolean;
    stickyProvider?: boolean;
    clientInjectOnly?: boolean;
    seedLoopPayload?: boolean;
    retryEmptyFollowupOnce?: boolean;
    clientInjectSource?: string;
    transparentReplayRequestSuffix?: string;
    ignoreRequiresActionFollowup?: boolean;
    contextDecorationMode?: 'continue_execution_summary' | 'web_search_summary';
};
export type ServertoolFollowupRuntimePlanPayload = {
    outcomeMode: 'skip' | 'client_inject_only' | 'reenter';
    noFollowup: boolean;
    autoLimit: boolean;
    flowOnlyLoopLimit: boolean;
    stickyProvider: boolean;
    clientInjectOnly: boolean;
    seedLoopPayload: boolean;
    retryEmptyFollowupOnce: boolean;
    ignoreRequiresActionFollowup: boolean;
    clientInjectSource?: string;
    transparentReplayRequestSuffix?: string;
    contextDecorationMode?: 'continue_execution_summary' | 'web_search_summary';
};
export declare function parsePendingToolSyncPayload(raw: string): PendingToolSyncPayload | null;
export declare function parseContinueExecutionInjectionPayload(raw: string): ContinueExecutionInjectionPayload | null;
export declare function parseChatProcessMediaAnalysisPayload(raw: string): ChatProcessMediaAnalysisPayload | null;
export declare function parseChatProcessMediaStripPayload(raw: string): ChatProcessMediaStripPayload | null;
export declare function parseChatWebSearchIntentPayload(raw: string): ChatWebSearchIntentPayload | null;
export declare function parseClockClearDirectivePayload(raw: string): ClockClearDirectivePayload | null;
export declare function parseProviderKeyPayload(raw: string): ProviderKeyParsePayload | null;
export declare function parseServertoolResponseStagePayload(raw: string): ServertoolResponseStagePayload | null;
export declare function parseServertoolDispatchPlanPayload(raw: string): ServertoolDispatchPlanPayload | null;
export declare function parseServertoolOutcomePlanPayload(raw: string): ServertoolOutcomePlanPayload | null;
export declare function parseServertoolAutoHookQueuesPayload(raw: string): ServertoolAutoHookQueuesPayload | null;
export declare function parseServertoolGenericFollowupPayload(raw: string): ServertoolGenericFollowupPayload | null;
export declare function parseServertoolFollowupFlowProfilePayload(raw: string): ServertoolFollowupFlowProfilePayload | null;
export declare function parseServertoolFollowupRuntimePlanPayload(raw: string): ServertoolFollowupRuntimePlanPayload | null;
