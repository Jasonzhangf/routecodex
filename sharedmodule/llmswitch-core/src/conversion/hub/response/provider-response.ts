import type { Readable } from 'node:stream';
import type { AdapterContext } from '../types/chat-envelope.js';
import type { JsonObject } from '../types/json.js';
// StageRecorder inline: record(stage: string, payload: object): void
type StageRecorder = { record(stage: string, payload: object): void };
import { recordStage } from '../pipeline/stages/utils.js';
import {
  executeHubPipelineWithNative,
  buildProviderResponseMetadataSnapshotWithNative,
  normalizeProviderResponseEffectPlanWithNative,
  resolveProviderProtocolWithNative,
  type ProviderResponseRuntimeEffectPlan,
} from '../../../native/router-hotpath/native-hub-pipeline-orchestration-semantics-protocol.js';

// feature_id: hub.response_post_servertool_client_projection
// canonical_builder: normalize_provider_response_effect_plan
import {
  publishResponsesRecordPlanWithNative,
  type PublishResponsesRecordPlan,
} from '../../../native/router-hotpath/native-shared-conversion-semantics.js';
import { logHubStageTiming } from '../pipeline/hub-stage-timing.js';
import { ensureRuntimeMetadata } from '../../runtime-metadata.js';
import {
  recordResponsesResponse,
  finalizeResponsesConversationRequestRetention,
} from '../../shared/responses-conversation-store.js';
import { planChatProcessSessionUsage } from '../../../native/router-hotpath/native-virtual-router-routing-state.js';
import {
  buildReadableFromSseFrames,
  buildSseFramesFromJsonWithNative,
  type NativeSseRuntimeProtocol,
} from '../../../native/router-hotpath/native-sse-runtime.js';
import {
  resolveProviderResponseContextSignals,
  type ProviderProtocol
} from './provider-response-helpers.js';
import {
  buildProviderSseStreamReadErrorDescriptorWithNative,
  materializeProviderResponseSsePayloadWithNative,
} from '../../../native/router-hotpath/native-hub-pipeline-resp-semantics.js';
import {
  applyNativeRuntimeControlWritePlan,
  projectNativeMetadataWritePlanToRuntimeControlWritePlan
} from '../metadata-center-runtime-control-writer.js';

import {
  readBoundMetadataCenter,
  readContinuationContextFromBoundMetadataCenter,
  readRequestTruthFromBoundMetadataCenter,
  readRuntimeControlFromBoundMetadataCenter,
} from '../metadata-center-runtime-control-writer.js';

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return isRecord(value) ? (value as Record<string, unknown>) : undefined;
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function readProviderResponseRequestId(context: AdapterContext): string {
  const requestId = readString((context as Record<string, unknown>).requestId);
  if (!requestId) {
    throw new Error('Provider response conversion requires context.requestId');
  }
  return requestId;
}

function readMetadataCenterSnapshotForRust(context: AdapterContext): Record<string, unknown> | null {
  const contextRecord = context as unknown as Record<string, unknown>;
  const direct = asRecord(contextRecord.metadataCenterSnapshot);
  const nestedMetadata = asRecord(contextRecord.metadata);
  const snapshotPlan = buildProviderResponseMetadataSnapshotWithNative({
    hasBoundMetadataCenter: Boolean(readBoundMetadataCenter(contextRecord)),
    requestTruth: readRequestTruthFromBoundMetadataCenter(contextRecord),
    continuationContext: readContinuationContextFromBoundMetadataCenter(contextRecord),
    runtimeControl: readRuntimeControlFromBoundMetadataCenter(contextRecord),
    directMetadataCenterSnapshot: direct ?? null,
    nestedMetadataCenterSnapshot: nestedMetadata ? asRecord(nestedMetadata.metadataCenterSnapshot) ?? null : null,
  });
  return snapshotPlan.metadataCenterSnapshot ?? null;
}



function writeRustStopGatewayContextToMetadataCenter(args: {
  metadata: Record<string, unknown>;
  stopGatewayContext: Record<string, unknown>;
  writer: { module: string; symbol: string; stage: string };
  reason: string;
}): void {
  applyNativeRuntimeControlWritePlan({
    metadata: args.metadata,
    runtimeControl: { stopGatewayContext: args.stopGatewayContext },
    writer: args.writer,
    reason: args.reason
  });
  ensureRuntimeMetadata(args.metadata).stopGatewayContext = args.stopGatewayContext as JsonObject;
}

function runProviderResponseRustHubPipeline(nativeOptions: Parameters<typeof executeHubPipelineWithNative>[0]) {
  const nativeResponsePlan = executeHubPipelineWithNative(nativeOptions);
  if (!nativeResponsePlan.success) {
    const code = nativeResponsePlan.error?.code ?? 'hub_pipeline_response_native_failed';
    const message = nativeResponsePlan.error?.message ?? 'Rust HubPipeline response path failed';
    throw new Error(`Rust HubPipeline response path failed: ${code}: ${message}`);
  }
  if (!nativeResponsePlan.payload || typeof nativeResponsePlan.payload !== 'object') {
    throw new Error('Rust HubPipeline response path returned no payload');
  }
  return nativeResponsePlan;
}

function emitNativeHubPipelineDiagnosticAlarms(args: {
  requestId: string;
  diagnostics: Array<Record<string, unknown>>;
}): void {
  for (const diagnostic of args.diagnostics) {
    const details = isRecord(diagnostic.details) ? diagnostic.details : null;
    const alarm = readString(details?.alarm);
    if (!alarm) {
      continue;
    }
    try {
      console.warn(
        `[hub-pipeline][alarm] ${alarm} requestId=${args.requestId} details=${JSON.stringify(details)}`
      );
    } catch {
      console.warn(`[hub-pipeline][alarm] ${alarm} requestId=${args.requestId}`);
    }
  }
}

function executeProviderResponseNativeOutboundEffects(args: {
  context: AdapterContext;
  nativeResponsePlan: ReturnType<typeof executeHubPipelineWithNative>;
}): {
  rawPayload: JsonObject;
  runtimeEffects: ProviderResponseRuntimeEffectPlan;
} {
  const rawPayload = args.nativeResponsePlan.payload as JsonObject;
  const effects = args.nativeResponsePlan.effectPlan.effects;
  if (!Array.isArray(effects)) {
    throw new Error('Rust HubPipeline response path returned malformed effect plan');
  }
  emitNativeHubPipelineDiagnosticAlarms({
    requestId: args.nativeResponsePlan.requestId,
    diagnostics: args.nativeResponsePlan.diagnostics
  });
  const normalizedEffects = normalizeProviderResponseEffectPlanWithNative({ effects });
  const runtimeEffects = normalizedEffects as ProviderResponseRuntimeEffectPlan;
  (args.context as Record<string, unknown>).__nativeResponsePlan = {
    payload: rawPayload,
    effectPlan: { effects },
    runtimeEffects,
    diagnostics: args.nativeResponsePlan.diagnostics
  };
  return { rawPayload, runtimeEffects };
}

async function executeProviderResponseNativeServertoolEffects(args: {
  payload: JsonObject;
  runtimeEffects: ProviderResponseRuntimeEffectPlan;
  context: AdapterContext;
  requestId: string;
  entryEndpoint: string;
  providerProtocol: ProviderProtocol;
  stageRecorder?: StageRecorder;
}): Promise<{ payload: JsonObject; stage: 'HubRespChatProcess03Governed' | 'unchanged' }> {
  if (!Array.isArray(args.runtimeEffects.servertoolRuntimeActions)) {
    throw new Error('Rust HubPipeline response path returned malformed servertool runtime actions');
  }
  const servertoolRuntimeActions = args.runtimeEffects.servertoolRuntimeActions;
  if (servertoolRuntimeActions.length > 0) {
    const firstAction = servertoolRuntimeActions.find(isRecord);
    const stopGateway = isRecord(firstAction?.stopGateway) ? firstAction.stopGateway : undefined;
    if (stopGateway) {
      writeRustStopGatewayContextToMetadataCenter({
        metadata: args.context as unknown as Record<string, unknown>,
        stopGatewayContext: stopGateway,
        writer: { module: 'provider-response.ts', symbol: 'convertProviderResponse', stage: 'HubRespChatProcess03Governed' },
        reason: 'rust stop gateway control signal'
      });
    }
    throw new Error('Rust HubPipeline returned unsupported servertool runtime actions; server-side tool execution has been removed and CLI-owned tools must be projected by Rust');
  }

  return { payload: args.payload, stage: 'unchanged' };
}

function executeProviderResponseNativeRuntimeStateEffect(args: {
  context: AdapterContext;
  entryEndpoint: string;
  requestId: string;
  response: JsonObject;
  runtimeEffects: ProviderResponseRuntimeEffectPlan;
}): void {
  if (args.runtimeEffects.stoplessMetadataCenterWrite) {
    const writePlan = projectNativeMetadataWritePlanToRuntimeControlWritePlan(args.runtimeEffects.stoplessMetadataCenterWrite);
    if (writePlan.runtimeControl) {
      applyNativeRuntimeControlWritePlan({
        metadata: args.context as unknown as Record<string, unknown>,
        runtimeControl: writePlan.runtimeControl,
        writer: { module: 'provider-response.ts', symbol: 'convertProviderResponse', stage: 'HubRespChatProcess03Governed' },
        reason: 'rust response chatprocess runtime control'
      });
    }
  }

  const runtimeStateWrite = isRecord(args.runtimeEffects.runtimeStateWrite) ? args.runtimeEffects.runtimeStateWrite : null;
  const metadataCenterSnapshot = {
    requestTruth: readRequestTruthFromBoundMetadataCenter(args.context as unknown as Record<string, unknown>),
    runtimeControl: readRuntimeControlFromBoundMetadataCenter(args.context as unknown as Record<string, unknown>),
  };
  const plan: PublishResponsesRecordPlan = publishResponsesRecordPlanWithNative({
    requestId: args.requestId,
    response: args.response,
    context: metadataCenterSnapshot,
    runtimeStateWrite: runtimeStateWrite ?? null,
    entryEndpoint: args.entryEndpoint,
  });

  if (plan.recordArgs) {
    recordResponsesResponse({
      requestId: plan.recordArgs.requestId,
      response: plan.recordArgs.response as Parameters<typeof recordResponsesResponse>[0]['response'],
      ...(plan.recordArgs.sessionId ? { sessionId: plan.recordArgs.sessionId } : {}),
      ...(plan.recordArgs.conversationId ? { conversationId: plan.recordArgs.conversationId } : {}),
      ...(plan.recordArgs.providerKey ? { providerKey: plan.recordArgs.providerKey } : {}),
      entryKind: 'responses',
      continuationOwner: 'relay',
      matchedPort: plan.recordArgs.matchedPort,
      ...(plan.recordArgs.routingPolicyGroup ? { routingPolicyGroup: plan.recordArgs.routingPolicyGroup } : {}),
      allowScopeContinuation: true,
      ...(plan.recordArgs.routeHint ? { routeHint: plan.recordArgs.routeHint } : {}),
    });
  }
  if (plan.finalizeArgs) {
    finalizeResponsesConversationRequestRetention(
      plan.finalizeArgs.requestId,
      { keepForSubmitToolOutputs: plan.finalizeArgs.keepForSubmitToolOutputs }
    );
  }
  if (plan.usageArgs) {
    planChatProcessSessionUsage({
      context: args.context as unknown as Record<string, unknown>,
      usage: plan.usageArgs.usage as Record<string, unknown> | undefined
    });
  }
}

function readProviderResponseNativeStreamPipe(args: {
  runtimeEffects: ProviderResponseRuntimeEffectPlan;
}): { codec: NativeSseRuntimeProtocol | string; requestId: string; payload: JsonObject } | null {
  const streamPipe = isRecord(args.runtimeEffects.streamPipe)
    ? args.runtimeEffects.streamPipe
    : null;
  if (!streamPipe) {
    return null;
  }
  const codec = readString(streamPipe.codec);
  const requestId = readString(streamPipe.requestId);
  const payload = isRecord(streamPipe.payload) ? streamPipe.payload as JsonObject : null;
  if (!codec || !requestId || !payload) {
    throw new Error('Rust HubPipeline response path returned malformed stream pipe effect');
  }
  return { codec: codec as NativeSseRuntimeProtocol | string, requestId, payload };
}

async function materializeProviderResponseSsePayload(
  payload: unknown
): Promise<Record<string, unknown>> {
  const stream = extractProviderResponseSseStream(payload);
  let streamBodyText: string | undefined;
  if (stream) {
    try {
      streamBodyText = await readProviderResponseSseStreamText(stream);
    } catch (error) {
      const source = error as Record<string, unknown> | undefined;
      const descriptor = buildProviderSseStreamReadErrorDescriptorWithNative({
        message: error instanceof Error ? error.message : String(error ?? 'unknown'),
        ...(typeof source?.code === 'string' ? { code: source.code } : {}),
        ...(typeof source?.upstreamCode === 'string' ? { upstreamCode: source.upstreamCode } : {})
      });
      const wrapped = new Error(descriptor.message) as Error & {
        code?: string;
        upstreamCode?: string;
        statusCode?: number;
        retryable?: boolean;
        requestExecutorProviderErrorStage?: string;
      };
      wrapped.code = descriptor.code;
      wrapped.upstreamCode = descriptor.upstreamCode;
      wrapped.statusCode = descriptor.statusCode;
      wrapped.retryable = descriptor.retryable;
      wrapped.requestExecutorProviderErrorStage = descriptor.requestExecutorProviderErrorStage;
      throw wrapped;
    }
  }
  return materializeProviderResponseSsePayloadWithNative({
    payload,
    ...(streamBodyText !== undefined ? { streamBodyText } : {})
  });
}

function extractProviderResponseSseStream(payload: unknown): Readable | undefined {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return undefined;
  }
  const record = payload as Record<string, unknown>;
  const direct = record.sseStream;
  if (direct && typeof (direct as { pipe?: unknown }).pipe === 'function') {
    return direct as Readable;
  }
  const data = record.data;
  if (data && typeof data === 'object' && !Array.isArray(data)) {
    const nested = data as Record<string, unknown>;
    const nestedStream = nested.sseStream;
    if (nestedStream && typeof (nestedStream as { pipe?: unknown }).pipe === 'function') {
      return nestedStream as Readable;
    }
  }
  return undefined;
}

async function readProviderResponseSseStreamText(stream: Readable): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream as AsyncIterable<Buffer | string | Uint8Array>) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString('utf8');
}

export async function convertProviderResponse(
  options: {
    providerProtocol: ProviderProtocol;
    providerResponse: JsonObject;
    context: AdapterContext;
    entryEndpoint: string;
    wantsStream: boolean;
    stageRecorder?: StageRecorder;
  }
): Promise<{
  body?: JsonObject;
  sseStream?: Readable;
  format?: string;
}> {
  const requestId = readProviderResponseRequestId(options.context);
  const metadataCenterSnapshot = readMetadataCenterSnapshotForRust(options.context);
  const providerProtocol = resolveProviderProtocolWithNative({
    metadataCenterSnapshot
  }).providerProtocol as ProviderProtocol;

  // Step 1: Materialize provider SSE payload via canonical Rust owner.
  const providerResponseMaterialized = await materializeProviderResponseSsePayload(options.providerResponse);

  // Step 2: Run Rust HubPipeline response path (normalize, govern, outbound)
  const nativeOptions: Parameters<typeof executeHubPipelineWithNative>[0] = {
    config: {},
    request: {
      requestId,
      endpoint: options.entryEndpoint,
      entryEndpoint: options.entryEndpoint,
      providerProtocol,
      payload: providerResponseMaterialized,
      metadata: {
        ...options.context,
        clientProtocol: resolveProviderResponseContextSignals(options.context, options.entryEndpoint).clientProtocol,
        entryEndpoint: options.entryEndpoint,
        stream: options.wantsStream
      },
      ...(metadataCenterSnapshot ? { metadataCenterSnapshot } : {}),
      stream: options.wantsStream,
      processMode: 'chat',
      direction: 'response',
      stage: 'outbound'
    }
  };
  const nativeResponsePlan = runProviderResponseRustHubPipeline(nativeOptions);

  // Step 3: Plan orchestration v2 — SSE materialize, usage, servertool plan, stream pipe, metadata write
  const outboundEffect = executeProviderResponseNativeOutboundEffects({
    context: options.context,
    nativeResponsePlan,
  });

  // Step 4: Reject retired server-side tool runtime actions.
  const respProcessEffect = await executeProviderResponseNativeServertoolEffects({
    payload: outboundEffect.rawPayload,
    runtimeEffects: outboundEffect.runtimeEffects,
    context: options.context,
    requestId,
    entryEndpoint: options.entryEndpoint,
    providerProtocol,
    stageRecorder: options.stageRecorder
  });
  let hubRespOutbound04ClientSemantic: JsonObject;
  hubRespOutbound04ClientSemantic = respProcessEffect.stage === 'HubRespChatProcess03Governed'
    ? respProcessEffect.payload
    : outboundEffect.rawPayload;

  // Step 5: Apply metadata write plan
  executeProviderResponseNativeRuntimeStateEffect({
    context: options.context,
    entryEndpoint: options.entryEndpoint,
    requestId,
    response: hubRespOutbound04ClientSemantic,
    runtimeEffects: outboundEffect.runtimeEffects,
  });

  // Step 7: Stream or body-only response
  const streamPipe = readProviderResponseNativeStreamPipe({
    runtimeEffects: outboundEffect.runtimeEffects
  });
  if (!streamPipe) {
    recordStage(options.stageRecorder, 'chat_process.resp.stage9.client_remap', hubRespOutbound04ClientSemantic);
    recordStage(options.stageRecorder, 'chat_process.resp.stage10.sse_stream', {
      passthrough: false,
      protocol: 'native-effect-plan',
      payload: hubRespOutbound04ClientSemantic
    });
    return { body: hubRespOutbound04ClientSemantic };
  }
  const streamClientSemantic =
    respProcessEffect.stage === 'HubRespChatProcess03Governed'
      ? hubRespOutbound04ClientSemantic
      : streamPipe.payload;
  hubRespOutbound04ClientSemantic = streamClientSemantic;
  const sseCodec = streamPipe.codec as NativeSseRuntimeProtocol | string;
  logHubStageTiming(requestId, 'resp_outbound.stage2_codec_stream', 'start', { clientProtocol: sseCodec });
  const frameResult = buildSseFramesFromJsonWithNative({
    protocol: sseCodec,
    response: hubRespOutbound04ClientSemantic,
    requestId,
    model: "",
  });
  const stream = buildReadableFromSseFrames(frameResult.frames);
  logHubStageTiming(requestId, 'resp_outbound.stage2_codec_stream', 'completed', { clientProtocol: sseCodec });
  recordStage(options.stageRecorder, 'chat_process.resp.stage9.client_remap', hubRespOutbound04ClientSemantic);
  recordStage(options.stageRecorder, 'chat_process.resp.stage10.sse_stream', {
    passthrough: false,
    protocol: streamPipe.codec,
    payload: hubRespOutbound04ClientSemantic
  });
  return {
    sseStream: stream as Readable,
    body: hubRespOutbound04ClientSemantic,
    format: streamPipe.codec
  };
}
