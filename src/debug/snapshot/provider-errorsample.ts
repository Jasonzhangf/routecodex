// Error sample spill, retry snapshot, repair feedback snapshot
// feature_id: snapshot.stage_contract

import { writeUnifiedSnapshot } from './writer.js';
import { buildInfo } from '../../build-info.js';
import { writeErrorsampleJson } from '../../utils/errorsamples.js';
import { coerceSnapshotPayloadForWrite } from '../../utils/snapshot-payload-guard.js';
import { shouldCaptureSnapshotStage } from '../../utils/snapshot-stage-policy.js';
import { runtimeFlags } from '../../runtime/runtime-flags.js';
import { logSnapshotNonBlockingError } from './provider-utils.js';
import { shouldSuppressSnapshotFor429, schedule429ProviderSnapshotPurge, purge429ProviderSnapshotArtifacts } from './provider-429.js';
import { buildSnapshotPayload, resolveEndpoint, normalizeRequestId, normalizeProviderToken } from './provider-utils.js';
import type { ProviderSnapshotPersistInput } from './buffer.js';

export async function writeProviderErrorsample(snapshot: ProviderSnapshotPersistInput): Promise<void> {
  await writeErrorsampleJson({
    group: 'provider-error',
    kind: snapshot.stage,
    ...(typeof snapshot.entryPort === 'number' ? { entryPort: snapshot.entryPort } : {}),
    payload: {
      kind: 'provider_runtime_error',
      timestamp: new Date().toISOString(),
      endpoint: snapshot.endpoint,
      stage: snapshot.stage,
      requestId: snapshot.requestId,
      groupRequestId: snapshot.groupRequestId,
      providerKey: snapshot.providerToken || undefined,
      versions: {
        routecodex: buildInfo.version,
        node: process.version
      },
      observation: snapshot.payload
    }
  });
}

export async function writeProviderRetrySnapshot(options: {
  type: 'request' | 'response';
  requestId: string;
  data: unknown;
  headers?: Record<string, unknown>;
  url?: string;
  clientRequestId?: string;
  entryEndpoint?: string;
  entryPort?: number;
  providerKey?: string;
  providerId?: string;
}): Promise<void> {
  if (shouldSuppressSnapshotFor429(options.type === 'request' ? 'provider-request.retry' : 'provider-response.retry', options.data)) {
    const purgeInput = {
      entryEndpoint: options.entryEndpoint,
      requestId: options.requestId,
      clientRequestId: options.clientRequestId,
      entryPort: options.entryPort,
      providerKey: options.providerKey,
      providerId: options.providerId
    };
    await purge429ProviderSnapshotArtifacts(purgeInput);
    schedule429ProviderSnapshotPurge(purgeInput);
    return;
  }
  if (!runtimeFlags.snapshotsEnabled) {
    return;
  }
  const { endpoint } = resolveEndpoint(options.entryEndpoint);
  const stage = options.type === 'request' ? 'provider-request.retry' : 'provider-response.retry';
  if (!shouldCaptureSnapshotStage(stage)) {
    return;
  }
  const requestId = normalizeRequestId(options.requestId);
  const groupRequestId = normalizeRequestId(options.clientRequestId || options.requestId);
  const providerToken = normalizeProviderToken(options.providerKey || options.providerId || '');
  const payload = coerceSnapshotPayloadForWrite(stage, buildSnapshotPayload({
    stage,
    data: options.data,
    headers: options.headers,
    url: options.url,
    extraMeta: options.clientRequestId ? { clientRequestId: options.clientRequestId } : undefined
  }));

  await writeUnifiedSnapshot({
    scope: 'provider',
    stage,
    requestId,
    groupRequestId,
    providerKey: providerToken || undefined,
    entryEndpoint: options.entryEndpoint,
    entryPort: options.entryPort,
    data: payload,
    rawPayload: payload,
    verbosity: 'verbose'
  });
}

export async function writeRepairFeedbackSnapshot(options: {
  requestId: string;
  feedback: unknown;
  entryEndpoint?: string;
  providerKey?: string;
  providerId?: string;
  groupRequestId?: string;
}): Promise<void> {
  if (!runtimeFlags.snapshotsEnabled) {
    return;
  }
  if (!shouldCaptureSnapshotStage('repair-feedback')) {
    return;
  }
  try {
    const { endpoint } = resolveEndpoint(options.entryEndpoint);
    const groupRequestId = normalizeRequestId(options.groupRequestId || options.requestId);
    const payload = coerceSnapshotPayloadForWrite('repair-feedback', {
      meta: {
        stage: 'repair-feedback',
        version: String(process.env.ROUTECODEX_VERSION || 'dev'),
        buildTime: String(process.env.ROUTECODEX_BUILD_TIME || new Date().toISOString())
      },
      feedback: options.feedback
    });
    await writeUnifiedSnapshot({
      scope: 'provider',
      stage: 'repair-feedback',
      requestId: options.requestId,
      groupRequestId,
      providerKey: options.providerKey || options.providerId || undefined,
      entryEndpoint: options.entryEndpoint || endpoint,
      data: payload,
      rawPayload: payload,
      verbosity: 'verbose'
    });
  } catch (error) {
    logSnapshotNonBlockingError('writeRepairFeedbackSnapshot', error);
  }
}
