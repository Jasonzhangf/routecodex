import type { StageRecorder } from './format-adapters/index.js';
import type { AdapterContext } from './types/chat-envelope.js';
import { createSnapshotWriter, type SnapshotWriter } from '../snapshot-utils.js';
import { normalizeSnapshotStagePayloadWithNative } from '../../router/virtual-router/engine-selection/native-snapshot-hooks.js';

export interface SnapshotStageRecorderOptions {
  context: AdapterContext;
  endpoint: string;
}

export class SnapshotStageRecorder implements StageRecorder {
  private readonly writer?: SnapshotWriter;

  constructor(private readonly options: SnapshotStageRecorderOptions) {
    const contextAny = options.context as unknown as Record<string, unknown>;
    this.writer = createSnapshotWriter({
      requestId: options.context.requestId,
      endpoint: options.endpoint,
      providerKey: typeof options.context.providerId === 'string' ? options.context.providerId : undefined,
      groupRequestId:
        typeof contextAny.clientRequestId === 'string'
          ? (contextAny.clientRequestId as string)
          : typeof contextAny.groupRequestId === 'string'
            ? (contextAny.groupRequestId as string)
            : undefined
    });
  }

  record(stage: string, payload: object): void {
    if (!this.writer) {
      return;
    }
    const normalized = normalizeSnapshotStagePayloadWithNative(stage, payload as unknown);
    if (!normalized) {
      return;
    }
    try {
      this.writer(stage, normalized as object);
    } catch {
      // ignore snapshot write errors
    }
  }
}

export function createSnapshotRecorder(context: AdapterContext, endpoint: string): StageRecorder {
  return new SnapshotStageRecorder({ context, endpoint });
}
