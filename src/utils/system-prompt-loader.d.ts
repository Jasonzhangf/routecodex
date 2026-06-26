export type Source = 'codex' | 'claude';
type ClaudeSystemEntry = {
    type: string;
    text: string;
};
type PromptAwarePayload = Record<string, unknown> & {
    messages?: unknown[];
    system?: ClaudeSystemEntry[];
    instructions?: string;
};
/**
 * Basic tool guidance (router-style)
 */
export declare function getBasicToolGuidance(): string;
/**
 * Get tool guidance (simplified router-style)
 */
export declare function getDynamicToolGuidance(): string;
/**
 * Check if system prompt replacement should be enabled
 */
export declare function shouldReplaceSystemPrompt(): Source | null;
export declare function getCodexSystemPrompt(): string | null;
export declare function getSystemPromptOverride(): {
    source: Source;
    prompt: string;
} | null;
/**
 * Replace or append system message in OpenAI messages
 */
export declare function replaceSystemInOpenAIMessages(messages: unknown[], systemText: string): unknown[];
export declare function applySystemPromptOverride(entryEndpoint: string, payload: PromptAwarePayload | null | undefined): void;
export {};
