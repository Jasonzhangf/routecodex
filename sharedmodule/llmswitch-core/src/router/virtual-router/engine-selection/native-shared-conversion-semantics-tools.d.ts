export declare function injectMcpToolsForChatWithNative(tools: unknown[] | undefined, discoveredServers: string[]): unknown[];
export declare function normalizeArgsBySchemaWithNative(input: unknown, schema: unknown): {
    ok: boolean;
    value?: Record<string, unknown>;
    errors?: string[];
};
export declare function normalizeOpenaiChatMessagesWithNative(messages: unknown): unknown[];
export declare function normalizeOpenaiToolCallWithNative(toolCall: unknown, disableShellCoerce: boolean): unknown;
export declare function prepareGeminiToolsForBridgeWithNative(rawTools: unknown, missing: unknown[]): {
    defs?: Array<Record<string, unknown>>;
    missing: Array<Record<string, unknown>>;
};
export declare function buildGeminiToolsFromBridgeWithNative(defs: unknown, mode?: 'antigravity' | 'default'): Array<Record<string, unknown>> | undefined;
export declare function injectMcpToolsForResponsesWithNative(tools: unknown[] | undefined, discoveredServers: string[]): unknown[];
