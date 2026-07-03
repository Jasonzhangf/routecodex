import type { StageRecorder } from './format-adapters/index.js';
import type { AdapterContext } from './types/chat-envelope.js';
import { buildSnapshotRecorderWriteOptionsWithNative, writeSnapshotViaHooksWithNative, shouldRecordSnapshotsWithNative } from '../../native/router-hotpath/native-snapshot-hooks.js';
import { normalizeSnapshotStagePayloadWithNative } from '../../native/router-hotpath/native-snapshot-hooks.js';

// feature_id: snapshot.stage_contract

import { readRuntimeMetadataSnapshotFromAnyBoundMetadataCenter } from '../../servertool/metadata-center-carrier.js';

interface SnapshotStageRecorderOptions {
  context: AdapterContext;
  endpoint: string;
}

class SnapshotStageRecorder implements StageRecorder {
  private readonly stageRequestId: string;

  constructor(private readonly options: SnapshotStageRecorderOptions) {
    this.stageRequestId = typeof options.context.requestId === 'string' && options.context.requestId.trim()
      ? options.context.requestId.trim()
      : 'unknown_req';
  }

  record(stage: string, payload: object): void {
    if (!shouldRecordSnapshotsWithNative()) {
      return;
    }
    const normalized = normalizeSnapshotStagePayloadWithNative(stage, payload);
    if (!normalized) {
      return;
    }
    try {
      const context = this.options.context as unknown as Record<string, unknown>;
      const writeOptions = buildSnapshotRecorderWriteOptionsWithNative({
        endpoint: this.options.endpoint,
        stage,
        requestId: this.stageRequestId,
        data: normalized as Record<string, unknown>,
        providerKey: typeof this.options.context.providerId === 'string' ? this.options.context.providerId : undefined,
        context,
        metadataCenterSnapshot: readRuntimeMetadataSnapshotFromAnyBoundMetadataCenter(context)?.metadataCenterSnapshot ?? null
      });
      writeSnapshotViaHooksWithNative(writeOptions);
    } catch (err) {
      // Snapshot write failure must not block the pipeline but must be visible.
      console.warn('[snapshot-recorder] write failed (non-blocking):', err instanceof Error ? err.message : String(err));
    }
  }
}

export function createSnapshotRecorder(context: AdapterContext, endpoint: string): StageRecorder {
  return new SnapshotStageRecorder({ context, endpoint });
}
