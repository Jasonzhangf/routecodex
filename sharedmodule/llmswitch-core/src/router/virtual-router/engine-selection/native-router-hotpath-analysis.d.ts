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
export type AntigravitySessionIdPayload = {
    sessionId: string;
};
export type AntigravityPinnedAliasLookupPayload = {
    alias?: string;
};
export type AntigravityPinnedAliasUnpinPayload = {
    changed: boolean;
};
export type AntigravityCacheSignaturePayload = {
    ok: boolean;
};
export type AntigravityRequestSessionMetaPayload = {
    aliasKey?: string;
    sessionId?: string;
    messageCount?: number;
};
export declare function parsePendingToolSyncPayload(raw: string): PendingToolSyncPayload | null;
export declare function parseContinueExecutionInjectionPayload(raw: string): ContinueExecutionInjectionPayload | null;
export declare function parseChatProcessMediaAnalysisPayload(raw: string): ChatProcessMediaAnalysisPayload | null;
export declare function parseChatProcessMediaStripPayload(raw: string): ChatProcessMediaStripPayload | null;
export declare function parseChatWebSearchIntentPayload(raw: string): ChatWebSearchIntentPayload | null;
export declare function parseClockClearDirectivePayload(raw: string): ClockClearDirectivePayload | null;
export declare function parseProviderKeyPayload(raw: string): ProviderKeyParsePayload | null;
export declare function parseAntigravitySessionIdPayload(raw: string): AntigravitySessionIdPayload | null;
export declare function parseAntigravityPinnedAliasLookupPayload(raw: string): AntigravityPinnedAliasLookupPayload | null;
export declare function parseAntigravityPinnedAliasUnpinPayload(raw: string): AntigravityPinnedAliasUnpinPayload | null;
export declare function parseAntigravityCacheSignaturePayload(raw: string): AntigravityCacheSignaturePayload | null;
export declare function parseAntigravityRequestSessionMetaPayload(raw: string): AntigravityRequestSessionMetaPayload | null;
