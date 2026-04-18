export declare function pickResponsesPersistedFieldsWithNative(payload: unknown): Record<string, unknown>;
export declare function convertResponsesOutputToInputItemsWithNative(response: unknown): Array<Record<string, unknown>>;
export declare function prepareResponsesConversationEntryWithNative(payload: unknown, context: unknown): {
    basePayload: Record<string, unknown>;
    input: Array<Record<string, unknown>>;
    tools?: Array<Record<string, unknown>>;
};
export declare function resumeResponsesConversationPayloadWithNative(entry: unknown, responseId: string, submitPayload: unknown, requestId?: string): {
    payload: Record<string, unknown>;
    meta: Record<string, unknown>;
};
export declare function restoreResponsesContinuationPayloadWithNative(entry: unknown, incomingPayload: unknown, requestId?: string, scopeKey?: string): {
    payload: Record<string, unknown>;
    meta: Record<string, unknown>;
} | null;
export declare function materializeResponsesContinuationPayloadWithNative(entry: unknown, incomingPayload: unknown, requestId?: string, scopeKey?: string): {
    payload: Record<string, unknown>;
    meta: Record<string, unknown>;
} | null;
export declare function enforceChatBudgetWithNative(chat: unknown, allowedBytes: number, systemTextLimit: number): unknown;
export declare function resolveBudgetForModelWithNative(modelId: string, fallback: {
    maxBytes: number;
    safetyRatio: number;
    allowedBytes: number;
    source: string;
} | null | undefined): {
    maxBytes: number;
    safetyRatio: number;
    allowedBytes: number;
    source: string;
};
