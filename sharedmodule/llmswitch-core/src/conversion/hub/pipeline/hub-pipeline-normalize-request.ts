import { Readable } from 'node:stream';
import type { SseProtocol } from '../../../sse/index.js';
import { defaultSseCodecRegistry } from '../../../sse/index.js';
import {
  extractModelHintFromMetadataWithNative,
  resolveSseProtocolWithNative,
} from '../../../router/virtual-router/engine-selection/native-hub-pipeline-orchestration-semantics.js';
import { runHubPipelineStageWithNative } from '../../../router/virtual-router/engine-selection/native-hub-pipeline-lib.js';
import type { HubPipelineRequest, NormalizedRequest, ProviderProtocol } from './hub-pipeline.js';
import type { StageRecorder } from '../format-adapters/index.js';
import { isRecord } from '../../../shared/common-utils.js';

type HubPipelineProviderProtocol =
  | 'openai-chat'
  | 'openai-responses'
  | 'anthropic-messages'
  | 'gemini-chat';

function readString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function readProviderProtocol(metadata: Record<string, unknown>): HubPipelineProviderProtocol {
  return (readString(metadata.providerProtocol) ?? 'openai-chat') as HubPipelineProviderProtocol;
}

function readStageRecorder(metadata: Record<string, unknown>): StageRecorder | undefined {
  const recorder = metadata.__hubStageRecorder;
  delete metadata.__hubStageRecorder;
  return recorder && typeof (recorder as StageRecorder).record === 'function'
    ? recorder as StageRecorder
    : undefined;
}

function readJsonPayload(payload: HubPipelineRequest['payload']): Record<string, unknown> | null {
  if (!payload) return null;
  if (payload instanceof Readable) return null;
  if (isRecord(payload) && payload.readable instanceof Readable) return null;
  return isRecord(payload) ? payload : null;
}

function readStreamCandidate(payload: HubPipelineRequest['payload']): Readable | null {
  if (!payload) return null;
  if (payload instanceof Readable) return payload;
  if (isRecord(payload) && payload.readable instanceof Readable) return payload.readable;
  return null;
}

async function convertSsePayloadToJson(
  stream: Readable,
  context: {
    requestId: string;
    providerProtocol: HubPipelineProviderProtocol;
    metadata: Record<string, unknown>;
  },
): Promise<Record<string, unknown>> {
  const protocol = resolveSseProtocolWithNative(
    context.metadata,
    context.providerProtocol,
  ) as SseProtocol;
  const codec = defaultSseCodecRegistry.get(protocol);
  const result = await codec.convertSseToJson(stream, {
    requestId: context.requestId,
    model: extractModelHintFromMetadataWithNative(context.metadata),
    direction: 'request',
  });
  if (!isRecord(result)) {
    throw new Error('SSE conversion returned empty payload');
  }
  return result;
}

function buildNormalizedRequestFromRust(args: {
  id: string;
  payload: Record<string, unknown>;
  metadata: Record<string, unknown>;
  externalStageRecorder?: StageRecorder;
}): NormalizedRequest {
  const endpoint = readString(args.metadata.endpoint) ?? '/v1/chat/completions';
  const entryEndpoint = readString(args.metadata.entryEndpoint) ?? endpoint;
  const providerProtocol = (readString(args.metadata.providerProtocol) ?? 'openai-chat') as ProviderProtocol;
  const direction = args.metadata.direction === 'response' ? 'response' : 'request';
  const stage = args.metadata.stage === 'outbound' ? 'outbound' : 'inbound';
  const processMode = 'chat';
  const routeHint = readString(args.metadata.routeHint);
  const hubEntryRaw = readString(args.metadata.__hubEntry);
  const hubEntryMode = hubEntryRaw && ['chat_process', 'chat-process', 'chatprocess'].includes(hubEntryRaw.toLowerCase())
    ? 'chat_process' as const
    : undefined;
  const policyOverride = isRecord(args.metadata.__hubPolicyOverride)
    ? args.metadata.__hubPolicyOverride
    : undefined;
  const shadowCompare = isRecord(args.metadata.__hubShadowCompare)
    ? args.metadata.__hubShadowCompare
    : undefined;
  const disableSnapshots = args.metadata.__disableHubSnapshots === true;
  const metadata = { ...args.metadata };
  delete metadata.__hubEntry;
  delete metadata.__hubPolicyOverride;
  delete metadata.__hubShadowCompare;
  delete metadata.__disableHubSnapshots;
  return {
    id: args.id,
    endpoint,
    entryEndpoint,
    providerProtocol,
    payload: args.payload,
    metadata,
    ...(policyOverride ? { policyOverride: policyOverride as NormalizedRequest['policyOverride'] } : {}),
    ...(shadowCompare ? { shadowCompare: shadowCompare as NormalizedRequest['shadowCompare'] } : {}),
    disableSnapshots,
    ...(args.externalStageRecorder ? { externalStageRecorder: args.externalStageRecorder } : {}),
    processMode,
    direction,
    stage,
    stream: args.metadata.stream === true,
    ...(routeHint ? { routeHint } : {}),
    ...(hubEntryMode ? { hubEntryMode } : {}),
  };
}

export async function normalizeHubPipelineRequest(
  request: HubPipelineRequest,
): Promise<NormalizedRequest> {
  if (!request || typeof request !== 'object') {
    throw new Error('HubPipeline requires request payload');
  }
  const id = request.id || `req_${Date.now()}`;
  const metadataRecord: Record<string, unknown> = { ...(request.metadata ?? {}) };
  const externalStageRecorder = readStageRecorder(metadataRecord);
  const providerProtocol = readProviderProtocol(metadataRecord);
  const streamCandidate = readStreamCandidate(request.payload);
  const payload = streamCandidate
    ? await convertSsePayloadToJson(streamCandidate, { requestId: id, providerProtocol, metadata: metadataRecord })
    : readJsonPayload(request.payload);
  if (!payload) {
    throw new Error('HubPipeline requires JSON object payload');
  }
  const stream = Boolean(metadataRecord.stream === true || payload.stream === true || streamCandidate);
  const stageResult = runHubPipelineStageWithNative({
    requestId: id,
    endpoint: request.endpoint,
    entryEndpoint: readString(metadataRecord.entryEndpoint) ?? request.endpoint,
    providerProtocol,
    payload,
    metadata: metadataRecord,
    stream,
    processMode: 'chat',
    direction: metadataRecord.direction === 'response' ? 'response' : 'request',
    stage: 'normalizeRequest',
  });
  if (stageResult.success !== true) {
    throw new Error(stageResult.error?.message ?? 'Rust normalizeRequest stage failed');
  }
  if (!isRecord(stageResult.payload) || !isRecord(stageResult.metadata)) {
    throw new Error('Rust normalizeRequest stage returned invalid envelope');
  }
  return buildNormalizedRequestFromRust({
    id: stageResult.requestId || id,
    payload: stageResult.payload,
    metadata: stageResult.metadata,
    externalStageRecorder,
  });
}
