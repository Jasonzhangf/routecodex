// Ambient module declarations to satisfy external packages missing types
// Keep the surface minimal and permissive to allow compilation.

declare module 'rcc-basemodule' {
  export type ModuleInfo = {
    id: string;
    name: string;
    version?: string;
    description?: string;
    type?: string;
  };
  export class BaseModule {
    constructor(info: ModuleInfo);
    getInfo(): ModuleInfo;
    isRunning(): boolean;
  }
}

// debugcenter 已移除：不再声明 'rcc-debugcenter'

declare module 'rcc-errorhandling' {
  export type ErrorContext = {
    error: string | Error;
    source: string;
    severity: 'low' | 'medium' | 'high' | 'critical' | string;
    timestamp: number;
    moduleId?: string;
    context?: Record<string, unknown>;
  };
  export class ErrorHandlingCenter {
    initialize(): Promise<void>;
    handleError(_context: UnknownObject): Promise<void>;
    destroy(): Promise<void>;
  }
}

// Core bridge optional modules without typings
declare module 'rcc-llmswitch-core/v2/utils/token-counter' {
  export const estimateTextTokens: (text: string, model?: string) => Promise<number>;
  export class TokenCounter {
    static calculateRequestTokensStrict(req: Record<string, unknown>, model?: string): Promise<{ inputTokens: number; toolTokens?: number }>
  }
}

// Core conversion for Responses↔Chat (shadow conversion)
declare module 'rcc-llmswitch-core/v2/conversion/responses/responses-openai-bridge' {
  export function buildChatRequestFromResponses(payload: Record<string, unknown>, context?: Record<string, unknown>): { request: Record<string, unknown> };
  export function captureResponsesContext(payload: Record<string, unknown>, dto?: { route?: { requestId?: string } }): Record<string, unknown>;
}
