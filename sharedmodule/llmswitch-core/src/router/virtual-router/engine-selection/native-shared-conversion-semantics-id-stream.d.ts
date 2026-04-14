export declare function normalizeIdValueWithNative(value: unknown, forceGenerate?: boolean): string;
export declare function extractToolCallIdWithNative(obj: unknown): string | undefined;
export declare function createToolCallIdTransformerWithNative(style: string): Record<string, unknown>;
export declare function transformToolCallIdWithNative(state: Record<string, unknown>, id: string): {
    id: string;
    state: Record<string, unknown>;
};
export declare function enforceToolCallIdStyleWithNative(messages: unknown[], state: Record<string, unknown>): {
    messages: unknown[];
    state: Record<string, unknown>;
};
export declare function normalizeResponsesToolCallIdsWithNative(payload: unknown): Record<string, unknown> | null;
export declare function resolveToolCallIdStyleWithNative(metadata: unknown): string;
export declare function stripInternalToolingMetadataWithNative(metadata: unknown): Record<string, unknown> | null;
export declare function buildProviderProtocolErrorWithNative(input: {
    message: string;
    code: string;
    protocol?: string;
    providerType?: string;
    category?: string;
    details?: Record<string, unknown>;
}): Record<string, unknown>;
export declare function isImagePathWithNative(pathValue: unknown): boolean;
export declare function extractStreamingToolCallsWithNative(input: {
    buffer: string;
    text: string;
    idPrefix: string;
    idCounter: number;
    nowMs: number;
}): {
    buffer: string;
    idCounter: number;
    toolCalls: Array<Record<string, unknown>>;
};
export declare function createStreamingToolExtractorStateWithNative(idPrefix?: string): Record<string, unknown>;
export declare function resetStreamingToolExtractorStateWithNative(state: Record<string, unknown>): Record<string, unknown>;
export declare function feedStreamingToolExtractorWithNative(input: {
    state: Record<string, unknown>;
    text: string;
    nowMs?: number;
}): {
    state: Record<string, unknown>;
    toolCalls: Array<Record<string, unknown>>;
};
export declare function isCompactionRequestWithNative(payload: unknown): boolean;
