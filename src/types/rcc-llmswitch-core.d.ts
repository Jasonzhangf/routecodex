declare module '@jsonstudio/llms' {
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
declare module '@jsonstudio/llms/guidance' { const anyModule: any; export = anyModule; }
declare module '@jsonstudio/llms/conversion/shared/snapshot-hooks' {
  export function writeSnapshotViaHooks(options: {
    endpoint: string;
    stage: string;
    requestId: string;
    data: any;
    verbosity?: 'verbose' | 'normal' | 'silent';
  }): Promise<void>;
}

declare module '@jsonstudio/llms/conversion/hub/format-adapters/index' {
  export interface StageRecorder {
    record(stage: string, payload: unknown): void;
  }
}

declare module '@jsonstudio/llms/conversion/hub/types/chat-envelope' {
  export interface AdapterContext {
    requestId: string;
    [key: string]: unknown;
  }
}

declare module '@jsonstudio/llms/dist/conversion/hub/snapshot-recorder.js' {
  import type { StageRecorder } from '@jsonstudio/llms/conversion/hub/format-adapters/index';
  import type { AdapterContext } from '@jsonstudio/llms/conversion/hub/types/chat-envelope';
  export function createSnapshotRecorder(context: AdapterContext, endpoint: string): StageRecorder;
}
