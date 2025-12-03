declare module '@jsonstudio/llms/dist/router/virtual-router/error-center.js' {
  export interface ProviderErrorEvent {
    code: string;
    message: string;
    stage: string;
    status?: number;
    recoverable?: boolean;
    runtime: ProviderErrorRuntimeMetadata;
    timestamp: number;
    details?: Record<string, unknown>;
  }
  export interface ProviderErrorRuntimeMetadata {
    requestId: string;
    providerKey?: string;
    providerId?: string;
    providerType?: string;
    providerProtocol?: string;
    routeName?: string;
    pipelineId?: string;
    target?: Record<string, unknown> | null;
    runtimeKey?: string;
  }
  export const providerErrorCenter: {
    emit(event: ProviderErrorEvent): void;
    subscribe?(handler: (event: ProviderErrorEvent) => void): () => void;
  };
}

declare module '@jsonstudio/llms/dist/router/virtual-router/types.js' {
  export interface ProviderErrorRuntimeMetadata {
    requestId: string;
    providerKey?: string;
    providerId?: string;
    providerType?: string;
    providerProtocol?: string;
    routeName?: string;
    pipelineId?: string;
    target?: Record<string, unknown> | null;
    runtimeKey?: string;
  }
  export interface ProviderErrorEvent {
    code: string;
    message: string;
    stage: string;
    status?: number;
    recoverable?: boolean;
    runtime: ProviderErrorRuntimeMetadata;
    timestamp: number;
    details?: Record<string, unknown>;
  }
}

declare module '@jsonstudio/llms/dist/conversion/hub/response/provider-response.js' {
  import type { Readable } from 'stream';
  export function convertProviderResponse(options: {
    providerProtocol: string;
    providerResponse: Record<string, unknown>;
    context: Record<string, unknown>;
    entryEndpoint: string;
    wantsStream: boolean;
  }): Promise<{ body?: Record<string, unknown>; __sse_responses?: Readable; format?: string }>;
}

declare module '@jsonstudio/llms/dist/conversion/shared/responses-instructions.js' {
  export function ensureResponsesInstructions(payload: Record<string, unknown>): void;
}
