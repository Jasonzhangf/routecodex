declare module 'rcc-llmswitch-core' { const anyModule: any; export = anyModule; }
// V1 conversion exports removed
declare module 'rcc-llmswitch-core/guidance' { const anyModule: any; export = anyModule; }
declare module 'rcc-llmswitch-core/hooks/hooks-integration' {
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

declare module 'rcc-llmswitch-core/conversion/hub/types/chat-envelope' {
  export interface AdapterContext {
    requestId: string;
    [key: string]: unknown;
  }
}

declare module '../../../../sharedmodule/llmswitch-core/dist/conversion/hub/snapshot-recorder.js' {
  import type { StageRecorder } from 'rcc-llmswitch-core/conversion/hub/format-adapters/index';
  import type { AdapterContext } from 'rcc-llmswitch-core/conversion/hub/types/chat-envelope';
  export function createSnapshotRecorder(context: AdapterContext, endpoint: string): StageRecorder;
}
