export declare function normalizeContentPartWithNative(part: unknown, reasoningCollector: string[]): {
    normalized: Record<string, unknown> | null;
    reasoningCollector: string[];
};
export declare function normalizeMessageContentPartsWithNative(parts: unknown, reasoningCollector: string[]): {
    normalizedParts: Array<Record<string, unknown>>;
    reasoningChunks: string[];
};
export declare function normalizeChatMessageContentWithNative(content: unknown): {
    contentText?: string;
    reasoningText?: string;
};
export declare function normalizeOpenaiMessageWithNative(message: unknown, disableShellCoerce: boolean): unknown;
export declare function normalizeOpenaiToolWithNative(tool: unknown): unknown;
