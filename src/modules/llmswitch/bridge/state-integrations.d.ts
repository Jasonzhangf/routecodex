/**
 * State Integrations Bridge
 *
 * Routing state, session identifier extraction, stats center, and
 * clock task store compatibility wrappers.
 */
export declare function loadRoutingInstructionStateSync(key: string): unknown | null;
export declare function saveRoutingInstructionStateAsync(key: string, state: unknown | null): void;
export declare function saveRoutingInstructionStateSync(key: string, state: unknown | null): void;
type SessionIdentifiers = {
    sessionId?: string;
    conversationId?: string;
};
export declare function extractSessionIdentifiersFromMetadata(meta: Record<string, unknown> | undefined): SessionIdentifiers;
export declare function extractContinuationContextSessionIdentifiersFromMetadata(meta: Record<string, unknown> | undefined): SessionIdentifiers;
type StatsCenterLike = {
    recordProviderUsage(ev: unknown): void;
};
export declare function getStatsCenterSafe(): StatsCenterLike;
export declare function getLlmsStatsSnapshot(): unknown | null;
export {};
