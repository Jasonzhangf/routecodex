import type { StageRecorder } from './format-adapters/index.js';
import type { AdapterContext } from './types/chat-envelope.js';
import { createSnapshotWriter, type SnapshotWriter } from '../snapshot-utils.js';
import { normalizeSnapshotStagePayloadWithNative } from '../../native/router-hotpath/native-snapshot-hooks.js';

// feature_id: snapshot.stage_contract

const METADATA_CENTER_SYMBOL = Symbol.for('routecodex.metadataCenter');

type MetadataCenterLike = {
  readRequestTruth?: () => Record<string, unknown> | undefined;
};

interface SnapshotStageRecorderOptions {
  context: AdapterContext;
  endpoint: string;
}

class SnapshotStageRecorder implements StageRecorder {
  private readonly writer?: SnapshotWriter;

  constructor(private readonly options: SnapshotStageRecorderOptions) {
    const contextAny = options.context as unknown as Record<string, unknown>;
    this.writer = createSnapshotWriter({
      requestId: options.context.requestId,
      endpoint: options.endpoint,
      providerKey: typeof options.context.providerId === 'string' ? options.context.providerId : undefined,
      entryProtocol: resolveEntryProtocol(options.endpoint),
      entryPort: resolveEntryPort(options.context),
      runtimeMetadata: readSnapshotRuntimeMetadata(options.context),
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
    const normalized = normalizeSnapshotStagePayloadWithNative(stage, payload);
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
