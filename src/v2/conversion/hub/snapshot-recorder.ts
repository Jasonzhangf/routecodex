import type { StageRecorder } from '@jsonstudio/llms/conversion/hub/format-adapters/index';
import { writeSnapshotViaHooks } from '@jsonstudio/llms/conversion/shared/snapshot-hooks';
import type { AdapterContext } from '@jsonstudio/llms/conversion/hub/types/chat-envelope';

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
