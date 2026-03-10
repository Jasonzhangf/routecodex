export interface SessionIdentifiers {
    sessionId?: string;
    conversationId?: string;
}
export declare function extractSessionIdentifiersFromMetadata(metadata: Record<string, unknown> | undefined): SessionIdentifiers;
export declare function coerceClientHeaders(raw: unknown): Record<string, string> | undefined;
export declare function pickHeader(headers: Record<string, string>, candidates: string[]): string | undefined;
export declare function findHeaderValue(headers: Record<string, string>, target: string): string | undefined;
export declare function normalizeHeaderKey(value: string): string;
