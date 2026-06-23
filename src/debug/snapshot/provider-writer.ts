// feature_id: snapshot.stage_contract — orchestrator only
// Strategy split: provider-queue, provider-429, provider-sse, provider-errorsample
import { runtimeFlags } from '../../runtime/runtime-flags.js';
import { shouldCaptureSnapshotStage } from '../../utils/snapshot-stage-policy.js';
import { coerceSnapshotPayloadForWrite } from '../../utils/snapshot-payload-guard.js';
import { writeUnifiedSnapshot } from './writer.js';
import {
  resetProviderSnapshotErrorBufferForTests,
} from './buffer.js';
import type { ProviderSnapshotPersistInput } from './buffer.js';
import {
  buildSnapshotPayload,
  resolveEndpoint,
  normalizeRequestId,
  normalizeProviderToken,
  logSnapshotNonBlockingError,
} from './provider-utils.js';
import {
  enqueueSnapshotPersist,
  __flushProviderSnapshotQueueForTests as flushProviderSnapshotQueueForTests,
  __resetProviderSnapshotQueueForTests as resetProviderSnapshotQueueForTests,
} from './provider-queue.js';
import {
  shouldSuppressSnapshotFor429,
  schedule429ProviderSnapshotPurge,
  purge429ProviderSnapshotArtifacts,
} from './provider-429.js';
import {
  setWriteProviderSnapshot,
  shouldCaptureProviderStreamSnapshots,
  attachProviderSseSnapshotStream,
} from './provider-sse.js';
import {
  writeProviderErrorsample,
  writeProviderRetrySnapshot,
  writeRepairFeedbackSnapshot,
} from './provider-errorsample.js';

export type Phase =
  | 'provider-request'
  | 'provider-request-contract'
  | 'provider-response'
  | 'provider-response-contract'
  | 'provider-error'
  | 'provider-preprocess-debug'
  | 'provider-body-debug';
export type ClientPhase = 'client-request';

export type ProviderSnapshotWriteOptions = {
  phase: Phase;
  requestId: string;
  data: unknown;
  headers?: Record<string, unknown>;
  url?: string;
  entryEndpoint?: string;
  clientRequestId?: string;
  providerKey?: string;
  providerId?: string;
  metadata?: Record<string, unknown>;
  forceLocalDiskWriteWhenDisabled?: boolean;
};

export function __resetProviderSnapshotErrorBufferForTests(): void {
  resetProviderSnapshotErrorBufferForTests();
}

export async function __flushProviderSnapshotQueueForTests(): Promise<void> {
  await flushProviderSnapshotQueueForTests();
}

export function __resetProviderSnapshotQueueForTests(): void {
  resetProviderSnapshotQueueForTests();
}

function isErrorPhase(phase: string): boolean {
  return String(phase || '').trim().toLowerCase().includes('error');
}

function resolveProviderSnapshotEntryPort(metadata?: Record<string, unknown>): number | undefined {
  if (!metadata || typeof metadata !== 'object') {
    return undefined;
  }
  const portContext = metadata.portContext && typeof metadata.portContext === 'object'
    ? metadata.portContext as Record<string, unknown>
    : undefined;
  const candidates = [
    metadata.entryPort,
    metadata.matchedPort,
    metadata.localPort,
    metadata.routecodexLocalPort,
    portContext?.matchedPort,
    portContext?.localPort
  ];
  for (const value of candidates) {
    const numeric = typeof value === 'number' ? value : Number.parseInt(String(value ?? ''), 10);
    if (Number.isFinite(numeric) && numeric > 0) {
      return Math.floor(numeric);
    }
  }
  return undefined;
}

function buildProviderSnapshotPersistInput(options: ProviderSnapshotWriteOptions): ProviderSnapshotPersistInput {
  const { endpoint, folder } = resolveEndpoint(options.entryEndpoint);
  const stage = options.phase;
  const requestId = normalizeRequestId(options.requestId);
  const groupRequestId = normalizeRequestId(options.clientRequestId || options.requestId);
  const providerToken = normalizeProviderToken(options.providerKey || options.providerId || '');
  const entryPort = resolveProviderSnapshotEntryPort(options.metadata);
  const payload = coerceSnapshotPayloadForWrite(stage, buildSnapshotPayload({
    stage,
    data: options.data,
    headers: options.headers,
    url: options.url,
    extraMeta: {
      ...(options.entryEndpoint ? { entryEndpoint: options.entryEndpoint } : {}),
      ...(options.clientRequestId ? { clientRequestId: options.clientRequestId } : {}),
      ...(options.providerKey ? { providerKey: options.providerKey } : {}),
      ...(options.providerId ? { providerId: options.providerId } : {}),
      ...(typeof entryPort === 'number' ? { entryPort, matchedPort: entryPort } : {})
    }
  }));

  return { endpoint, folder, stage, requestId, groupRequestId, providerToken, payload, entryPort };
}

async function persistProviderSnapshot(input: ProviderSnapshotPersistInput, forceLocalDiskWriteWhenDisabled = false): Promise<void> {
  await writeUnifiedSnapshot({
    scope: 'provider',
    stage: input.stage,
    requestId: input.requestId,
    groupRequestId: input.groupRequestId,
    providerKey: input.providerToken || undefined,
    entryEndpoint: input.endpoint,
    entryPort: input.entryPort,
    data: input.payload,
    rawPayload: input.payload,
    verbosity: 'verbose',
    forceLocalDiskWriteWhenDisabled,
  });
}

export async function writeProviderSnapshot(options: ProviderSnapshotWriteOptions): Promise<void> {
  const stage = String(options.phase || '').trim();
  if (shouldSuppressSnapshotFor429(stage, options.data)) {
    const purgeInput = {
      entryEndpoint: options.entryEndpoint,
      requestId: options.requestId,
      clientRequestId: options.clientRequestId,
      entryPort: resolveProviderSnapshotEntryPort(options.metadata)
    };
    await purge429ProviderSnapshotArtifacts(purgeInput);
    schedule429ProviderSnapshotPurge(purgeInput);
    return;
  }
  if (!shouldCaptureSnapshotStage(stage)) {
    return;
  }
  const snapshot = buildProviderSnapshotPersistInput(options);

  if (!runtimeFlags.snapshotsEnabled) {
    if (options.forceLocalDiskWriteWhenDisabled) {
      try {
        await persistProviderSnapshot(snapshot, true);
      } catch (error) {
        logSnapshotNonBlockingError(`forceLocalDiskWrite:${snapshot.stage}`, error);
      }
      return;
    }
    if (isErrorPhase(snapshot.stage)) {
      try {
        await writeProviderErrorsample(snapshot);
      } catch (error) {
        logSnapshotNonBlockingError(`writeProviderErrorsample:${snapshot.stage}`, error);
      }
    }
    return;
  }

  enqueueSnapshotPersist(snapshot);
}

export {
  shouldCaptureProviderStreamSnapshots,
  attachProviderSseSnapshotStream,
  writeProviderRetrySnapshot,
  writeRepairFeedbackSnapshot,
};

export async function writeClientSnapshot(options: {
  entryEndpoint: string;
  requestId: string;
  headers?: Record<string, unknown>;
  body: unknown;
  rawBodyText?: string;
  metadata?: Record<string, unknown>;
  providerKey?: string;
}): Promise<void> {
  if (!runtimeFlags.snapshotsEnabled) {
    return;
  }
  if (!shouldCaptureSnapshotStage('client-request')) {
    return;
  }
  try {
    const stage: ClientPhase = 'client-request';
    const { endpoint } = resolveEndpoint(options.entryEndpoint);
    const requestId = normalizeRequestId(options.requestId);
    const groupRequestIdCandidate =
      options.metadata && typeof options.metadata === 'object' && typeof options.metadata.clientRequestId === 'string'
        ? (options.metadata.clientRequestId as string)
        : undefined;
    const groupRequestId = normalizeRequestId(groupRequestIdCandidate || requestId);
    const providerToken = normalizeProviderToken(options.providerKey || '');
    const metadataSnapshot =
      options.metadata && typeof options.metadata === 'object'
        ? options.metadata
        : undefined;
    const entryPort = resolveProviderSnapshotEntryPort(metadataSnapshot);
    const snapshotPayload =
      typeof options.rawBodyText === 'string'
        ? options.rawBodyText
        : {
            body: options.body,
            metadata: metadataSnapshot || {}
          };
    const payload = coerceSnapshotPayloadForWrite(stage, buildSnapshotPayload({
      stage,
      data: snapshotPayload,
      headers: options.headers,
      url: endpoint,
      extraMeta: {
        entryEndpoint: endpoint,
        ...(typeof entryPort === 'number' ? { entryPort, matchedPort: entryPort } : {}),
        stream: options.metadata?.stream,
        userAgent: options.metadata?.userAgent
      }
    }));
    await writeUnifiedSnapshot({
      scope: 'client',
      stage,
      requestId,
      groupRequestId,
      providerKey: providerToken || undefined,
      entryEndpoint: options.entryEndpoint,
      entryPort,
      data: payload,
      rawPayload: payload,
      verbosity: 'verbose',
    });
  } catch (error) {
    logSnapshotNonBlockingError('writeClientSnapshot', error);
  }
}

// Wire SSE module to use writeProviderSnapshot
setWriteProviderSnapshot(writeProviderSnapshot);
