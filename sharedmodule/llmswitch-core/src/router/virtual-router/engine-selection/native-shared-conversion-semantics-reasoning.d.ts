export declare function extractToolCallsFromReasoningTextWithNative(text: string, idPrefix?: string): {
    cleanedText: string;
    toolCalls: Array<Record<string, unknown>>;
};
export declare function extractReasoningSegmentsWithNative(text: string): {
    text: string;
    segments: string[];
};
export declare function normalizeAssistantTextToToolCallsWithNative(message: Record<string, unknown>, options?: Record<string, unknown>): Record<string, unknown>;
export declare function normalizeReasoningInChatPayloadWithNative(payload: unknown): unknown;
export declare function normalizeReasoningInResponsesPayloadWithNative(payload: unknown, options?: Record<string, unknown>): unknown;
export declare function normalizeReasoningInGeminiPayloadWithNative(payload: unknown): unknown;
export declare function normalizeReasoningInAnthropicPayloadWithNative(payload: unknown): unknown;
export declare function normalizeReasoningInOpenAIPayloadWithNative(payload: unknown): unknown;
export declare function sanitizeReasoningTaggedTextWithNative(text: string): string;
