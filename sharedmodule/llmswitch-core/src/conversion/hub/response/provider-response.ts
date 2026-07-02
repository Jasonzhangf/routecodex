import type { Readable } from 'node:stream';
import {
  defaultSseCodecRegistry,
  type SseProtocol,
} from '../../../sse/registry/sse-codec-registry.js';
import type { AdapterContext } from '../types/chat-envelope.js';
import type { JsonObject } from '../types/json.js';
import type { StageRecorder } from '../format-adapters/index.js';
import { recordStage } from '../pipeline/stages/utils.js';
import {
  executeHubPipelineWithNative,
  normalizeProviderResponseEffectPlanWithNative,
  planProviderResponseServertoolRuntimeActionsWithNative,
  type ProviderResponseRuntimeEffectPlan,
} from '../../../native/router-hotpath/native-hub-pipeline-orchestration-semantics-protocol.js';
import { logHubStageTiming } from '../pipeline/hub-stage-timing.js';
import { ensureRuntimeMetadata } from '../../runtime-metadata.js';
import {
  recordResponsesResponse,
  finalizeResponsesConversationRequestRetention,
} from '../../shared/responses-conversation-store.js';
import { saveChatProcessSessionActualUsage } from '../process/chat-process-session-usage.js';
import {
  resolveProviderResponseContextSignals,
  type ProviderProtocol
} from './provider-response-helpers.js';
import { runServertoolResponseStageOrchestrationShell } from '../../../servertool/response-stage-orchestration-shell.js';
import {
  buildProviderSseStreamReadErrorDescriptorWithNative,
  materializeProviderResponseSsePayloadWithNative,
  projectPostServertoolHubRespOutbound04ClientSemanticWithNative
} from '../../../native/router-hotpath/native-hub-pipeline-resp-semantics.js';
import {
  applyNativeRuntimeControlWritePlan,
  projectNativeMetadataWritePlanToRuntimeControl
} from '../metadata-center-runtime-control-writer.js';

import {
  type MetadataCenterLike,
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
  if (readBoundMetadataCenter(contextRecord)) {
    return {
      requestTruth: readRequestTruthFromBoundMetadataCenter(contextRecord),
      continuationContext: readContinuationContextFromBoundMetadataCenter(contextRecord),
      runtimeControl: readRuntimeControlFromBoundMetadataCenter(contextRecord),
    };
  }
  const direct = asRecord(contextRecord.metadataCenterSnapshot);
  if (direct) {
    return direct;
  }
  const nestedMetadata = asRecord(contextRecord.metadata);
  return nestedMetadata ? asRecord(nestedMetadata.metadataCenterSnapshot) ?? null : null;
}

function readMetadataCenterRequestTruth(metadata?: Record<string, unknown>): Record<string, unknown> {
  return asRecord(readBoundMetadataCenter(metadata)?.readRequestTruth()) ?? {};
}

function readMetadataCenterRuntimeControl(metadata?: Record<string, unknown>): Record<string, unknown> {
  return asRecord(readBoundMetadataCenter(metadata)?.readRuntimeControl()) ?? {};
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

function readProviderProtocolWithinCore(args: {
  metadata?: Record<string, unknown>;
}): ProviderProtocol {
  const runtimeControl = readMetadataCenterRuntimeControl(args.metadata);
  const providerProtocol =
    typeof runtimeControl.providerProtocol === 'string' && runtimeControl.providerProtocol.trim()
      ? runtimeControl.providerProtocol.trim()
      : undefined;
  if (!providerProtocol) {
    throw new Error('Provider response conversion requires metadata center runtime_control.providerProtocol');
  }
  return providerProtocol as ProviderProtocol;
}

interface ProviderResponseConversionOptions {
  providerProtocol: ProviderProtocol;
  providerResponse: JsonObject;
  context: AdapterContext;
  entryEndpoint: string;
  wantsStream: boolean;
  stageRecorder?: StageRecorder;
}

interface ProviderResponseConversionResult {
  body?: JsonObject;
  sseStream?: Readable;
  format?: string;
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
  const actionPlan = planProviderResponseServertoolRuntimeActionsWithNative({
    servertoolRuntimeActions
  });
  if (actionPlan.error) {
    throw new Error(actionPlan.error.message);
  }

  let payload: JsonObject = args.payload;
  let stage: 'HubRespChatProcess03Governed' | 'unchanged' = 'unchanged';
  if (actionPlan.executionPlans.length > 0) {
    for (const executionPlan of actionPlan.executionPlans) {
      const stopGateway = isRecord(executionPlan.stopGateway) ? executionPlan.stopGateway : undefined;
      if (stopGateway) {
        writeRustStopGatewayContextToMetadataCenter({
          metadata: args.context as unknown as Record<string, unknown>,
          stopGatewayContext: stopGateway,
          writer: { module: 'provider-response.ts', symbol: 'convertProviderResponse', stage: 'HubRespChatProcess03Governed' },
          reason: 'rust stop gateway control signal'
        });
      }
      const allowFollowup = executionPlan.allowFollowup === true;
      const orchestration = await runServertoolResponseStageOrchestrationShell({
        payload: executionPlan.payload as JsonObject,
        adapterContext: args.context,
        requestId: args.requestId,
        entryEndpoint: args.entryEndpoint,
        ...(allowFollowup ? { allowFollowup: true } : {}),
        stageRecorder: args.stageRecorder
      });
      if (orchestration.executed) {
        payload = orchestration.payload;
        stage = 'HubRespChatProcess03Governed';
      }
    }
    if (stage === 'HubRespChatProcess03Governed' && actionPlan.executionPlans.some((plan) => plan.projectionStage === 'HubRespChatProcess03Governed')) {
      payload = projectPostServertoolHubRespOutbound04ClientSemanticWithNative({
        payload,
        entryEndpoint: args.entryEndpoint,
        requestId: args.requestId,
        responseSemantics: args.context as unknown as Record<string, unknown>
      }) as JsonObject;
      stage = 'HubRespChatProcess03Governed';
    }
  }

  return { payload, stage };
}

function executeProviderResponseNativeRuntimeStateEffect(args: {
  context: AdapterContext;
  entryEndpoint: string;
  requestId: string;
  response: JsonObject;
  runtimeEffects: ProviderResponseRuntimeEffectPlan;
}): void {
  if (args.runtimeEffects.stoplessMetadataCenterWrite) {
    const runtimeControlProjected = projectNativeMetadataWritePlanToRuntimeControl(args.runtimeEffects.stoplessMetadataCenterWrite);
    if (Object.keys(runtimeControlProjected).length > 0) {
      applyNativeRuntimeControlWritePlan({
        metadata: args.context as unknown as Record<string, unknown>,
        runtimeControl: runtimeControlProjected,
        writer: { module: 'provider-response.ts', symbol: 'convertProviderResponse', stage: 'HubRespChatProcess03Governed' },
        reason: 'rust response chatprocess runtime control'
      });
    }
  }

  const runtimeStateWrite = isRecord(args.runtimeEffects.runtimeStateWrite) ? args.runtimeEffects.runtimeStateWrite : null;
  const usage = isRecord(runtimeStateWrite?.usage) ? runtimeStateWrite.usage : null;
  if (args.entryEndpoint === '/v1/responses' || args.entryEndpoint === '/v1/responses.submit_tool_outputs') {
    const requestTruth = readMetadataCenterRequestTruth(args.context as unknown as Record<string, unknown>);
    const rc = readMetadataCenterRuntimeControl(args.context as unknown as Record<string, unknown>);
    const matchedPort = typeof requestTruth.matchedPort === 'number' && Number.isFinite(requestTruth.matchedPort) ? Math.floor(requestTruth.matchedPort) : undefined;
    const routingPolicyGroup = readString(requestTruth.routingPolicyGroup);
    const sessionId = readString(requestTruth.sessionId);
    const conversationId = readString(requestTruth.conversationId);
    if (sessionId || conversationId) {
      recordResponsesResponse({
        requestId: args.requestId,
        response: args.response,
        ...(sessionId ? { sessionId } : {}),
        ...(conversationId ? { conversationId } : {}),
        ...(usage && typeof usage.providerKey === 'string' ? { providerKey: usage.providerKey } : {}),
        entryKind: 'responses',
        continuationOwner: 'relay',
        ...(matchedPort !== undefined ? { matchedPort } : {}),
        ...(routingPolicyGroup ? { routingPolicyGroup } : {}),
        allowScopeContinuation: true,
        ...(typeof rc.routeHint === 'string' && rc.routeHint.trim() ? { routeHint: rc.routeHint.trim() } : {}),
      });
      finalizeResponsesConversationRequestRetention(
        args.requestId,
        { keepForSubmitToolOutputs: runtimeStateWrite?.keepForSubmitToolOutputs === true }
      );
    }
  }
  if (usage) {
    saveChatProcessSessionActualUsage({
      context: args.context,
      usage
    });
  }
}

function readProviderResponseNativeStreamPipe(args: {
  runtimeEffects: ProviderResponseRuntimeEffectPlan;
}): { codec: SseProtocol; requestId: string; payload: JsonObject } | null {
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
  return { codec: codec as SseProtocol, requestId, payload };
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
  options: ProviderResponseConversionOptions
): Promise<ProviderResponseConversionResult> {
  const requestId = readProviderResponseRequestId(options.context);
  const providerProtocol = readProviderProtocolWithinCore({
    metadata: options.context as Record<string, unknown> | undefined
  });

  // Step 1: Materialize provider SSE payload via canonical Rust owner.
  const providerResponseMaterialized = await materializeProviderResponseSsePayload(options.providerResponse);

  // Step 2: Run Rust HubPipeline response path (normalize, govern, outbound)
  const metadataCenterSnapshot = readMetadataCenterSnapshotForRust(options.context);
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

  // Step 4: Apply servertool runtime actions via existing TS IO shell.
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
  const codec = defaultSseCodecRegistry.get(streamPipe.codec);
  logHubStageTiming(requestId, 'resp_outbound.stage2_codec_stream', 'start', { clientProtocol: streamPipe.codec });
  const stream = await codec.convertJsonToSse(hubRespOutbound04ClientSemantic, { requestId: streamPipe.requestId });
  logHubStageTiming(requestId, 'resp_outbound.stage2_codec_stream', 'completed', { clientProtocol: streamPipe.codec });
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
