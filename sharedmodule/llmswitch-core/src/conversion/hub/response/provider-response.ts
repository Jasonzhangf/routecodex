import type { Readable } from 'node:stream';
import { defaultSseCodecRegistry, type SseProtocol } from '../../../sse/index.js';
import type { AdapterContext } from '../types/chat-envelope.js';
import type { JsonObject } from '../types/json.js';
import type { StageRecorder } from '../format-adapters/index.js';
import { recordStage } from '../pipeline/stages/utils.js';
import { ProviderProtocolError, type ProviderProtocolErrorCode } from '../../provider-protocol-error.js';
import {
  executeHubPipelineWithNative,
  normalizeProviderResponseEffectPlanWithNative,
  planProviderResponseServertoolRuntimeActionsWithNative,
  type ProviderResponseServertoolRuntimeErrorDescriptor,
  type ProviderResponseRuntimeEffectPlan,
} from '../../../native/router-hotpath/native-hub-pipeline-orchestration-semantics-protocol.js';
import {
  logHubStageTiming
} from '../pipeline/hub-stage-timing.js';
import {
  recordResponsesResponse,
  finalizeResponsesConversationRequestRetention,
  responsesConversationStore,
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

function runProviderResponseRustHubPipeline(options: ProviderResponseConversionOptions): {
  payload?: JsonObject;
  effectPlan: { effects: Array<Record<string, unknown>> };
  runtimeEffects: ProviderResponseRuntimeEffectPlan;
  diagnostics: Array<Record<string, unknown>>;
} {
  const providerProtocol = readProviderProtocolWithinCore({
    metadata: options.context as Record<string, unknown> | undefined
  });
  const metadataCenterSnapshot = readMetadataCenterSnapshotForRust(options.context);
  const nativeResponsePlan = executeHubPipelineWithNative({
    config: {},
    request: {
      requestId: options.context.requestId || 'unknown',
      endpoint: options.entryEndpoint,
      entryEndpoint: options.entryEndpoint,
      providerProtocol,
      payload: options.providerResponse,
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
  });
  if (!nativeResponsePlan.success) {
    const code = nativeResponsePlan.error?.code ?? 'hub_pipeline_response_native_failed';
    const message = nativeResponsePlan.error?.message ?? 'Rust HubPipeline response path failed';
    throw new Error(`Rust HubPipeline response path failed: ${code}: ${message}`);
  }
  if (!nativeResponsePlan.payload || typeof nativeResponsePlan.payload !== 'object') {
    throw new Error('Rust HubPipeline response path returned no payload');
  }
  const effects = nativeResponsePlan.effectPlan.effects;
  if (!Array.isArray(effects)) {
    throw new Error('Rust HubPipeline response path returned invalid effect plan');
  }
  return {
    payload: nativeResponsePlan.payload as JsonObject,
    effectPlan: { effects },
    runtimeEffects: normalizeProviderResponseEffectPlanWithNative({ effects }),
    diagnostics: nativeResponsePlan.diagnostics
  };
}

function readMetadataCenterSnapshotForRust(context: AdapterContext): Record<string, unknown> | null {
  const contextRecord = context as unknown as Record<string, unknown>;
  const boundCenter = readBoundMetadataCenter(contextRecord);
  if (boundCenter) {
    return {
      requestTruth: boundCenter.readRequestTruth() ?? {},
      continuationContext: boundCenter.readContinuationContext() ?? {},
      runtimeControl: boundCenter.readRuntimeControl() ?? {},
    };
  }
  const direct = asRecord(contextRecord.metadataCenterSnapshot);
  if (direct) {
    return direct;
  }
  const nestedMetadata = asRecord(contextRecord.metadata);
  return nestedMetadata ? asRecord(nestedMetadata.metadataCenterSnapshot) ?? null : null;
}

function readNativeStreamPipeEffect(runtimeEffects: ProviderResponseRuntimeEffectPlan): {
  codec: SseProtocol;
  requestId: string;
} | null {
  if (!runtimeEffects.streamPipe) return null;
  const codec = runtimeEffects.streamPipe.codec;
  const requestId = runtimeEffects.streamPipe.requestId;
  return {
    codec: codec as SseProtocol,
    requestId
  };
}

function readNativeServertoolRuntimeActionEffects(runtimeEffects: ProviderResponseRuntimeEffectPlan): Array<Record<string, unknown>> {
  return runtimeEffects.servertoolRuntimeActions;
}

type HubRespPayloadStage = 'client_semantic' | 'HubRespChatProcess03Governed';

type HubRespProcessEffectResult = {
  payload: JsonObject;
  stage: HubRespPayloadStage;
};

function asFlatRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function throwServertoolRuntimeErrorDescriptor(descriptor: ProviderResponseServertoolRuntimeErrorDescriptor): never {
  throw new ProviderProtocolError(descriptor.message, {
    code: descriptor.code as ProviderProtocolErrorCode,
    category: descriptor.category,
    details: descriptor.details
  });
}

function writeRustStopGatewayContextToMetadataCenter(args: {
  context: AdapterContext;
  stopGateway?: Record<string, unknown> | null;
}): void {
  if (!args.stopGateway || typeof args.stopGateway !== 'object' || Array.isArray(args.stopGateway)) {
    return;
  }
  applyNativeRuntimeControlWritePlan({
    metadata: args.context as unknown as Record<string, unknown>,
    runtimeControl: {
      stopGatewayContext: args.stopGateway
    },
    writer: {
      module: 'sharedmodule/llmswitch-core/src/conversion/hub/response/provider-response.ts',
      symbol: 'writeRustStopGatewayContextToMetadataCenter',
      stage: 'HubRespChatProcess03Governed'
    },
    reason: 'rust stop gateway control signal'
  });
}

async function executeProviderResponseNativeServertoolEffects(args: {
  runtimeEffects: ProviderResponseRuntimeEffectPlan;
  payload: JsonObject;
  requestId: string;
  context: AdapterContext;
  entryEndpoint: string;
  providerProtocol: ProviderProtocol;
  stageRecorder?: StageRecorder;
}): Promise<HubRespProcessEffectResult> {
  let payload = args.payload;
  let stage: HubRespPayloadStage = 'client_semantic';
  const actionPlan = planProviderResponseServertoolRuntimeActionsWithNative({
    servertoolRuntimeActions: readNativeServertoolRuntimeActionEffects(args.runtimeEffects)
  });
  if (actionPlan.error) {
    throwServertoolRuntimeErrorDescriptor(actionPlan.error);
  }
  for (const executionPlan of actionPlan.executionPlans) {
    writeRustStopGatewayContextToMetadataCenter({
      context: args.context,
      stopGateway: executionPlan.stopGateway
    });
    const orchestration = await runServertoolResponseStageOrchestrationShell({
      payload: executionPlan.payload as JsonObject,
      adapterContext: args.context,
      requestId: args.requestId,
      entryEndpoint: args.entryEndpoint,
      providerProtocol: args.providerProtocol,
      ...(executionPlan.allowFollowup ? { allowFollowup: true } : {}),
      stageRecorder: args.stageRecorder
    });
    if (orchestration.executed) {
      payload = orchestration.payload;
      stage = executionPlan.projectionStage;
    }
  }
  return { payload, stage };
}

function readNativeRuntimeStateWriteEffect(runtimeEffects: ProviderResponseRuntimeEffectPlan): Record<string, unknown> | null {
  return runtimeEffects.runtimeStateWrite ?? null;
}

function readNativeMetadataCenterWriteEffect(runtimeEffects: ProviderResponseRuntimeEffectPlan): Record<string, unknown> | null {
  return runtimeEffects.stoplessMetadataCenterWrite ?? null;
}

async function executeProviderResponseNativeRuntimeStateEffect(args: {
  runtimeEffects: ProviderResponseRuntimeEffectPlan;
  context: AdapterContext;
  requestId: string;
  entryEndpoint: string;
  body: JsonObject;
}): Promise<void> {
  const runtimeEffect = readNativeRuntimeStateWriteEffect(args.runtimeEffects);
  const usage = runtimeEffect?.usage && typeof runtimeEffect.usage === 'object' && !Array.isArray(runtimeEffect.usage)
    ? runtimeEffect.usage as Record<string, unknown>
    : undefined;
  await persistResponsesConversationLifecycleAtChatProcessExitWithinCore({
    entryEndpoint: args.entryEndpoint,
    requestLabel: args.requestId,
    usageLogInfo: usage ?? null,
    metadata: args.context as Record<string, unknown>,
    body: args.body,
  });
  if (runtimeEffect) {
    finalizeResponsesConversationRequestRetention(
      resolveResponsesConversationRequestLabelWithinCore({
        metadata: args.context as Record<string, unknown>,
        requestLabel: args.requestId,
      }),
      {
        keepForSubmitToolOutputs: runtimeEffect.keepForSubmitToolOutputs === true
      }
    );
  }
  saveChatProcessSessionActualUsage({
    context: args.context,
    usage,
  });
}

const RESPONSE_STAGE_RUNTIME_CONTROL_WRITER = {
  module: 'sharedmodule/llmswitch-core/src/conversion/hub/response/provider-response.ts',
  symbol: 'executeProviderResponseNativeMetadataEffect',
  stage: 'HubRespChatProcess03Governed',
} as const;

function executeProviderResponseNativeMetadataEffect(args: {
  runtimeEffects: ProviderResponseRuntimeEffectPlan;
  context: AdapterContext;
}): void {
  const plan = readNativeMetadataCenterWriteEffect(args.runtimeEffects);
  if (!plan) {
    return;
  }
  const runtimeControl = projectNativeMetadataWritePlanToRuntimeControl(plan);
  if (Object.keys(runtimeControl).length === 0) {
    return;
  }
  applyNativeRuntimeControlWritePlan({
    metadata: args.context as Record<string, unknown>,
    runtimeControl,
    writer: RESPONSE_STAGE_RUNTIME_CONTROL_WRITER,
    reason: 'rust response chatprocess runtime control'
  });
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

const METADATA_CENTER_SYMBOL = Symbol.for('routecodex.metadataCenter');

type MetadataCenterLike = {
  readRequestTruth: () => Record<string, unknown> | undefined;
  readContinuationContext: () => Record<string, unknown> | undefined;
  readRuntimeControl: () => Record<string, unknown> | undefined;
  writeRuntimeControl?: (
    key: string,
    value: unknown,
    writtenBy: { module: string; symbol: string; stage: string },
    reason?: string
  ) => void;
};

function isMetadataCenterLike(value: unknown): value is MetadataCenterLike {
  return Boolean(
    value
    && typeof value === 'object'
    && !Array.isArray(value)
    && typeof (value as { readRequestTruth?: unknown }).readRequestTruth === 'function'
    && typeof (value as { readContinuationContext?: unknown }).readContinuationContext === 'function'
    && typeof (value as { readRuntimeControl?: unknown }).readRuntimeControl === 'function'
  );
}

function readBoundMetadataCenter(metadata?: Record<string, unknown>): MetadataCenterLike | undefined {
  if (!metadata) {
    return undefined;
  }
  const candidate = Reflect.get(metadata, METADATA_CENTER_SYMBOL);
  return isMetadataCenterLike(candidate) ? candidate : undefined;
}

function readMetadataCenterRequestTruth(metadata?: Record<string, unknown>): Record<string, unknown> {
  return asRecord(readBoundMetadataCenter(metadata)?.readRequestTruth()) ?? {};
}

function readMetadataCenterRuntimeControl(metadata?: Record<string, unknown>): Record<string, unknown> {
  return asRecord(readBoundMetadataCenter(metadata)?.readRuntimeControl()) ?? {};
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

function markResponsesContinuationSavedWithinCore(metadata?: Record<string, unknown>): void {
  const center = readBoundMetadataCenter(metadata);
  if (!center || typeof center.writeRuntimeControl !== 'function') {
    return;
  }
  center.writeRuntimeControl(
    'responsesContinuationSavedAtChatProcessExit',
    true,
    {
      module: 'sharedmodule/llmswitch-core/src/conversion/hub/response/provider-response.ts',
      symbol: 'markResponsesContinuationSavedWithinCore',
      stage: 'ChatProcRespContinuation07CanonicalSaved',
    },
    'responses continuation saved at chat process exit',
  );
}

function readResponsesContinuationSavedWithinCore(metadata?: Record<string, unknown>): boolean {
  return readMetadataCenterRuntimeControl(metadata).responsesContinuationSavedAtChatProcessExit === true;
}

function resolveResponsesConversationRequestLabelWithinCore(args: {
  metadata?: Record<string, unknown>;
  requestLabel: string;
}): string {
  const requestTruth = readMetadataCenterRequestTruth(args.metadata);
  const canonicalRequestId =
    typeof requestTruth.requestId === 'string' && requestTruth.requestId.trim()
      ? requestTruth.requestId.trim()
      : undefined;
  return canonicalRequestId ?? args.requestLabel;
}

async function persistResponsesConversationLifecycleAtChatProcessExitWithinCore(args: {
  entryEndpoint?: string;
  requestLabel: string;
  usageLogInfo?: Record<string, unknown> | null;
  metadata?: Record<string, unknown>;
  body: JsonObject;
}): Promise<void> {
  if (
    args.entryEndpoint !== '/v1/responses'
    && args.entryEndpoint !== '/v1/responses.submit_tool_outputs'
  ) {
    return;
  }
  if (readResponsesContinuationSavedWithinCore(args.metadata)) {
    return;
  }
  const requestTruth = readMetadataCenterRequestTruth(args.metadata);
  const runtimeControl = readMetadataCenterRuntimeControl(args.metadata);
  const matchedPort =
    typeof requestTruth.matchedPort === 'number' && Number.isFinite(requestTruth.matchedPort)
      ? requestTruth.matchedPort
      : undefined;
  const routingPolicyGroup =
    typeof requestTruth.routingPolicyGroup === 'string' && requestTruth.routingPolicyGroup.trim()
      ? requestTruth.routingPolicyGroup.trim()
      : undefined;
  if (process.env.RESPONSES_DEBUG === '1') {
    console.log('[provider-response] record core store before', {
      requestLabel: args.requestLabel,
      canonicalRequestId: resolveResponsesConversationRequestLabelWithinCore({
        metadata: args.metadata,
        requestLabel: args.requestLabel,
      }),
      stats: responsesConversationStore.getDebugStats(),
    });
  }
  recordResponsesResponse({
    requestId: resolveResponsesConversationRequestLabelWithinCore({
      metadata: args.metadata,
      requestLabel: args.requestLabel,
    }),
    response: args.body,
    ...(typeof requestTruth.sessionId === 'string' && requestTruth.sessionId.trim()
      ? { sessionId: requestTruth.sessionId.trim() }
      : {}),
    ...(typeof requestTruth.conversationId === 'string' && requestTruth.conversationId.trim()
      ? { conversationId: requestTruth.conversationId.trim() }
      : {}),
    ...(args.usageLogInfo?.providerKey && typeof args.usageLogInfo.providerKey === 'string'
      ? { providerKey: args.usageLogInfo.providerKey }
      : {}),
    entryKind: 'responses',
    continuationOwner: 'relay',
    ...(matchedPort !== undefined ? { matchedPort } : {}),
    ...(routingPolicyGroup ? { routingPolicyGroup } : {}),
    allowScopeContinuation: true,
    ...(typeof runtimeControl.routeHint === 'string' && runtimeControl.routeHint.trim()
      ? { routeHint: runtimeControl.routeHint.trim() }
      : {}),
  });
  markResponsesContinuationSavedWithinCore(args.metadata);
}

async function executeProviderResponseNativeOutboundEffects(args: {
  nativeResponsePlan: {
    payload?: JsonObject;
    effectPlan: { effects: Array<Record<string, unknown>> };
    runtimeEffects: ProviderResponseRuntimeEffectPlan;
  };
  requestId: string;
  context: AdapterContext;
  entryEndpoint: string;
  providerProtocol: ProviderProtocol;
  stageRecorder?: StageRecorder;
}): Promise<ProviderResponseConversionResult> {
  let hubRespOutbound04ClientSemantic = args.nativeResponsePlan.payload;
  if (!hubRespOutbound04ClientSemantic || typeof hubRespOutbound04ClientSemantic !== 'object') {
    throw new Error('Rust HubPipeline native response payload unavailable');
  }
  const respProcessEffect = await executeProviderResponseNativeServertoolEffects({
    runtimeEffects: args.nativeResponsePlan.runtimeEffects,
    payload: hubRespOutbound04ClientSemantic,
    requestId: args.requestId,
    context: args.context,
    entryEndpoint: args.entryEndpoint,
    providerProtocol: args.providerProtocol,
    stageRecorder: args.stageRecorder
  });
  hubRespOutbound04ClientSemantic = respProcessEffect.stage === 'HubRespChatProcess03Governed'
    ? projectPostServertoolHubRespOutbound04ClientSemanticWithNative({
      payload: respProcessEffect.payload,
      entryEndpoint: args.entryEndpoint,
      requestId: args.requestId,
      responseSemantics: args.context as Record<string, unknown>
    }) as JsonObject
    : respProcessEffect.payload;
  const streamEffect = readNativeStreamPipeEffect(args.nativeResponsePlan.runtimeEffects);
  executeProviderResponseNativeMetadataEffect({
    runtimeEffects: args.nativeResponsePlan.runtimeEffects,
    context: args.context
  });
  await executeProviderResponseNativeRuntimeStateEffect({
    runtimeEffects: args.nativeResponsePlan.runtimeEffects,
    context: args.context,
    requestId: args.requestId,
    entryEndpoint: args.entryEndpoint,
    body: hubRespOutbound04ClientSemantic,
  });
  if (!streamEffect) {
    recordStage(args.stageRecorder, 'chat_process.resp.stage9.client_remap', hubRespOutbound04ClientSemantic);
    recordStage(args.stageRecorder, 'chat_process.resp.stage10.sse_stream', {
      passthrough: false,
      protocol: 'native-effect-plan',
      payload: hubRespOutbound04ClientSemantic
    });
    return { body: hubRespOutbound04ClientSemantic };
  }
  const codec = defaultSseCodecRegistry.get(streamEffect.codec);
  logHubStageTiming(args.requestId, 'resp_outbound.stage2_codec_stream', 'start', {
    clientProtocol: streamEffect.codec
  });
  const codecStart = Date.now();
  const stream = await codec.convertJsonToSse(hubRespOutbound04ClientSemantic, {
    requestId: streamEffect.requestId
  });
  logHubStageTiming(args.requestId, 'resp_outbound.stage2_codec_stream', 'completed', {
    elapsedMs: Date.now() - codecStart,
    clientProtocol: streamEffect.codec
  });
  recordStage(args.stageRecorder, 'chat_process.resp.stage9.client_remap', hubRespOutbound04ClientSemantic);
  recordStage(args.stageRecorder, 'chat_process.resp.stage10.sse_stream', {
    passthrough: false,
    protocol: streamEffect.codec,
    payload: hubRespOutbound04ClientSemantic
  });
  return {
    sseStream: stream as Readable,
    body: hubRespOutbound04ClientSemantic,
    format: streamEffect.codec
  };
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

async function materializeProviderResponseSsePayload(
  payload: unknown
): Promise<Record<string, unknown>> {
  const stream = extractProviderResponseSseStream(payload);
  const streamBodyText = stream ? await readProviderResponseSseStreamText(stream) : undefined;
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
  try {
    for await (const chunk of stream as AsyncIterable<Buffer | string | Uint8Array>) {
      if (typeof chunk === 'string') {
        chunks.push(Buffer.from(chunk));
        continue;
      }
      chunks.push(Buffer.from(chunk));
    }
  } catch (error) {
    throw buildProviderSseStreamReadError(error);
  }
  return Buffer.concat(chunks).toString('utf8');
}

function buildProviderSseStreamReadError(error: unknown): Error {
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
  return wrapped;
}

export async function convertProviderResponse(
  options: ProviderResponseConversionOptions
): Promise<ProviderResponseConversionResult> {
  const requestId = options.context.requestId || 'unknown';
  const providerProtocol = readProviderProtocolWithinCore({
    metadata: options.context as Record<string, unknown> | undefined
  });
  const nativeOptions = {
    ...options,
    providerProtocol,
    providerResponse: await materializeProviderResponseSsePayload(options.providerResponse) as JsonObject
  };
  const nativeResponsePlan = runProviderResponseRustHubPipeline(nativeOptions);
  if (!Array.isArray(nativeResponsePlan.effectPlan.effects)) {
    throw new Error('Rust HubPipeline response native effect plan unavailable');
  }
  (options.context as Record<string, unknown>).__nativeResponsePlan = nativeResponsePlan;
  return executeProviderResponseNativeOutboundEffects({
    nativeResponsePlan,
    requestId,
    context: options.context,
    entryEndpoint: options.entryEndpoint,
    providerProtocol,
    stageRecorder: options.stageRecorder
  });
}
