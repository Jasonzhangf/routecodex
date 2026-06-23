import type { StageRecorder } from './format-adapters/index.js';
import type { AdapterContext } from './types/chat-envelope.js';
import { createSnapshotWriter, type SnapshotWriter } from '../snapshot-utils.js';
import { normalizeSnapshotStagePayloadWithNative } from '../../native/router-hotpath/native-snapshot-hooks.js';

// feature_id: snapshot.stage_contract

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
  const record = context as unknown as Record<string, unknown>;
  const candidates = [
    record.entryPort,
    record.matchedPort,
    (record.portContext as Record<string, unknown> | undefined)?.matchedPort,
    (record.portContext as Record<string, unknown> | undefined)?.localPort,
    (record.metadata as Record<string, unknown> | undefined)?.matchedPort
  ];
  for (const value of candidates) {
    const numeric = typeof value === 'number' ? value : Number.parseInt(String(value ?? ''), 10);
    if (Number.isFinite(numeric) && numeric > 0) {
      return Math.floor(numeric);
    }
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
