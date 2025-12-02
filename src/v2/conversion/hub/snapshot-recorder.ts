import type { StageRecorder } from 'rcc-llmswitch-core/conversion/hub/format-adapters/index';
import { writeSnapshotViaHooks } from 'rcc-llmswitch-core/conversion/shared/snapshot-hooks';
import type { AdapterContext } from 'rcc-llmswitch-core/conversion/hub/types/chat-envelope';

export interface SnapshotStageRecorderOptions {
  context: AdapterContext;
  endpoint: string;
}

export class SnapshotStageRecorder implements StageRecorder {
  constructor(private readonly options: SnapshotStageRecorderOptions) {}

  record(stage: string, payload: unknown): void {
    void writeSnapshotViaHooks({
      endpoint: this.options.endpoint,
      stage,
      requestId: this.options.context.requestId,
      data: payload,
      verbosity: 'verbose'
    }).catch(() => {
      /* ignore snapshot errors */
    });
  }
}

export function createSnapshotRecorder(context: AdapterContext, endpoint: string): StageRecorder {
  return new SnapshotStageRecorder({ context, endpoint });
}
