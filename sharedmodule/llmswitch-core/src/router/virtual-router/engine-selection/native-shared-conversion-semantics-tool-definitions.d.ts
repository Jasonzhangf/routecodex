export declare function bridgeToolToChatDefinitionWithNative(tool: Record<string, unknown>, options?: {
    sanitizeMode?: string;
}): Record<string, unknown> | null;
export declare function chatToolToBridgeDefinitionWithNative(tool: Record<string, unknown>, options?: {
    sanitizeMode?: string;
}): Record<string, unknown> | null;
export declare function mapBridgeToolsToChatWithNative(rawTools: unknown, options?: {
    sanitizeMode?: string;
}): Array<Record<string, unknown>>;
export declare function mapChatToolsToBridgeWithNative(rawTools: unknown, options?: {
    sanitizeMode?: string;
}): Array<Record<string, unknown>>;
export declare function collectToolCallsFromResponsesWithNative(response: Record<string, unknown>): Array<Record<string, unknown>>;
