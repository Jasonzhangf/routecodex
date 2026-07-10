declare module 'rcc-llmswitch-core' {
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
  export function getStatsCenter(): {
    recordProviderUsage(ev: ProviderUsageEvent): void;
  };
}
// V1 conversion exports removed
declare module 'rcc-llmswitch-core/conversion/shared/snapshot-hooks' {
  export function writeSnapshotViaHooks(options: {
    endpoint: string;
    stage: string;
    requestId: string;
    data: any;
    verbosity?: 'verbose' | 'normal' | 'silent';
  }): Promise<void>;
}

declare module 'rcc-llmswitch-core/conversion/hub/format-adapters/index' {
  export interface StageRecorder {
    record(stage: string, payload: unknown): void;
  }
}
