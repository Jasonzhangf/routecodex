import type { StageRecorder } from './format-adapters/index.js';
import type { AdapterContext } from './types/chat-envelope.js';
import { writeSnapshotViaHooksWithNative, shouldRecordSnapshotsWithNative } from '../../native/router-hotpath/native-snapshot-hooks.js';
import { normalizeSnapshotStagePayloadWithNative } from '../../native/router-hotpath/native-snapshot-hooks.js';

// feature_id: snapshot.stage_contract

import { METADATA_CENTER_SYMBOL } from './metadata-center-runtime-control-writer.js';

type MetadataCenterLike = {
  readRequestTruth?: () => Record<string, unknown> | undefined;
};

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
      writeSnapshotViaHooksWithNative({
        endpoint: this.options.endpoint,
        stage,
        requestId: this.stageRequestId,
        data: normalized as Record<string, unknown>,
        verbosity: 'verbose',
        providerKey: typeof this.options.context.providerId === 'string' ? this.options.context.providerId : undefined,
        groupRequestId: (() => {
          const ctx = this.options.context as unknown as Record<string, unknown>;
          if (typeof ctx.clientRequestId === 'string') return ctx.clientRequestId;
          if (typeof ctx.groupRequestId === 'string') return ctx.groupRequestId;
          return undefined;
        })(),
        entryProtocol: resolveEntryProtocol(this.options.endpoint),
        entryPort: resolveEntryPort(this.options.context),
        runtimeMetadata: readSnapshotRuntimeMetadata(this.options.context)
      });
    } catch (err) {
      // Snapshot write failure must not block the pipeline but must be visible.
      console.warn('[snapshot-recorder] write failed (non-blocking):', err instanceof Error ? err.message : String(err));
    }
  }
}

function resolveEntryProtocol(endpoint: string): string {
  const lowered = endpoint.trim().toLowerCase();
  if (lowered.includes('/v1/responses') || lowered.includes('/responses.submit')) {
    return 'openai-responses';
  }
  if (lowered.includes('/v1/messages')) {
    return 'anthropic-messages';
  }
  return 'openai-chat';
}

function resolveEntryPort(context: AdapterContext): number | undefined {
  const target = context as unknown as Record<string, unknown>;
  const directCenter = Reflect.get(target, METADATA_CENTER_SYMBOL) as MetadataCenterLike | undefined;
  const metadata = target.metadata && typeof target.metadata === 'object' && !Array.isArray(target.metadata)
    ? target.metadata as Record<string, unknown>
    : undefined;
  const nestedCenter = metadata
    ? (Reflect.get(metadata, METADATA_CENTER_SYMBOL) as MetadataCenterLike | undefined)
    : undefined;
  const center = directCenter && typeof directCenter.readRequestTruth === 'function'
    ? directCenter
    : nestedCenter;
  const portScope = center?.readRequestTruth?.()?.portScope;
  if (typeof portScope === 'string') {
    const parsed = Number.parseInt(portScope, 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
  }
  return undefined;
}

function readSnapshotRuntimeMetadata(context: AdapterContext): Record<string, unknown> | undefined {
  const metadata = context.metadata;
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) {
    return undefined;
  }
  return metadata as Record<string, unknown>;
}

export function createSnapshotRecorder(context: AdapterContext, endpoint: string): StageRecorder {
  return new SnapshotStageRecorder({ context, endpoint });
}
