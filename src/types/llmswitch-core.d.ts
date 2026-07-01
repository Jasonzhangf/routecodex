declare module 'rcc-llmswitch-core/dist/native/router-hotpath/native-provider-runtime-ingress.js' {
  export interface ProviderErrorEvent {
    code: string;
    message: string;
    stage: string;
    status?: number;
    recoverable?: boolean;
    affectsHealth?: boolean;
    fatal?: boolean;
    errorClassification?: 'recoverable' | 'unrecoverable' | 'special_400' | string;
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
    routecodexRoutingPolicyGroup?: string;
    pipelineId?: string;
    target?: Record<string, unknown> | null;
    runtimeKey?: string;
  }
  export interface ProviderSuccessRuntimeMetadata {
    requestId: string;
    routeName?: string;
    routecodexRoutingPolicyGroup?: string;
    providerKey?: string;
    providerId?: string;
    providerType?: string;
    providerProtocol?: string;
    pipelineId?: string;
    target?: Record<string, unknown> | null;
    runtimeKey?: string;
  }
  export interface ProviderSuccessEvent {
    runtime: ProviderSuccessRuntimeMetadata;
    timestamp: number;
    metadata?: Record<string, unknown>;
    details?: Record<string, unknown>;
  }
  export function reportProviderErrorToRouterPolicy(event: ProviderErrorEvent): ProviderErrorEvent;
  export function reportProviderSuccessToRouterPolicy(event: ProviderSuccessEvent): ProviderSuccessEvent;
  export function resetProviderRuntimeIngressForTests(): void;
}

declare module 'rcc-llmswitch-core/dist/native/router-hotpath/virtual-router-contracts.js' {
  export interface ProviderErrorRuntimeMetadata {
    requestId: string;
    providerKey?: string;
    providerId?: string;
    providerType?: string;
    providerProtocol?: string;
    routeName?: string;
    routecodexRoutingPolicyGroup?: string;
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

  export interface ProviderSuccessRuntimeMetadata {
    requestId: string;
    routeName?: string;
    routecodexRoutingPolicyGroup?: string;
    providerKey?: string;
    providerId?: string;
    providerType?: string;
    providerProtocol?: string;
    pipelineId?: string;
    target?: Record<string, unknown> | null;
    runtimeKey?: string;
  }

  export interface ProviderSuccessEvent {
    runtime: ProviderSuccessRuntimeMetadata;
    timestamp: number;
    /**
     * Optional request metadata snapshot (e.g. sessionId / conversationId).
     * This must not contain provider-specific payload semantics.
     */
    metadata?: Record<string, unknown>;
    details?: Record<string, unknown>;
  }
}

declare module 'rcc-llmswitch-core/dist/conversion/hub/response/provider-response.js' {
  import type { Readable } from 'stream';
  export type ProviderInvoker = (options: {
    providerKey: string;
    providerType?: string;
    modelId?: string;
    providerProtocol: string;
    payload: Record<string, unknown>;
    entryEndpoint: string;
    requestId: string;
    routeHint?: string;
  }) => Promise<{
    providerResponse: Record<string, unknown>;
  }>;
  export function convertProviderResponse(options: {
    providerProtocol: string;
    providerResponse: Record<string, unknown>;
    context: Record<string, unknown>;
    entryEndpoint: string;
    wantsStream: boolean;
    providerInvoker?: ProviderInvoker;
    /**
     * 可选：由 Host 注入的二次请求入口，用于在 server-side 工具
     * 完成后，通过标准 HubPipeline 重新发起一次内部请求（例如
     * web_search followup），并直接返回最终客户端响应形状。
     */
    reenterPipeline?: (options: {
      entryEndpoint: string;
      requestId: string;
      body: Record<string, unknown>;
      metadata?: Record<string, unknown>;
    }) => Promise<{ body?: Record<string, unknown>; sseStream?: Readable; format?: string }>;
    clientInjectDispatch?: (options: {
      entryEndpoint: string;
      requestId: string;
      body?: Record<string, unknown>;
      metadata?: Record<string, unknown>;
    }) => Promise<{ ok: boolean; reason?: string }>;
  }): Promise<{ body?: Record<string, unknown>; sseStream?: Readable; format?: string }>;
}

declare module 'rcc-llmswitch-core/dist/conversion/shared/responses-instructions.js' {
  export function ensureResponsesInstructions(payload: Record<string, unknown>): void;
}

declare module 'rcc-llmswitch-core/dist/telemetry/stats-center.js' {
  export interface ProviderUsageEvent {
    requestId: string;
    timestamp: number;
    providerKey: string;
    runtimeKey?: string;
    providerType: string;
    modelId?: string;
    routeName?: string;
    entryEndpoint?: string;
    success: boolean;
    latencyMs: number;
    promptTokens?: number;
    completionTokens?: number;
    totalTokens?: number;
  }
  export interface StatsCenter {
    recordProviderUsage(ev: ProviderUsageEvent): void;
  }
  export function getStatsCenter(): StatsCenter;
}
