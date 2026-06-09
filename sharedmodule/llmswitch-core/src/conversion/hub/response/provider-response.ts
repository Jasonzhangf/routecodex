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
  logHubStageTiming,
  peekHubStageTopSummary
} from '../pipeline/hub-stage-timing.js';
import {
  finalizeResponsesConversationRequestRetention,
} from '../../shared/responses-conversation-store.js';
import type { ProviderInvoker } from '../../../servertool/types.js';
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

type HubStageTopEntry = {
  stage: string;
  totalMs: number;
  count?: number;
  avgMs?: number;
  maxMs?: number;
};

function normalizeHubStageTopEntries(raw: unknown): HubStageTopEntry[] {
  if (!Array.isArray(raw) || raw.length === 0) {
    return [];
  }
  return raw
    .map((entry) => {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
        return null;
      }
      const record = entry as Record<string, unknown>;
      const stage = typeof record.stage === 'string' ? record.stage.trim() : '';
      const totalMs =
        typeof record.totalMs === 'number' && Number.isFinite(record.totalMs)
          ? Math.max(0, Math.round(record.totalMs))
          : undefined;
      if (!stage || totalMs === undefined) {
        return null;
      }
      const count =
        typeof record.count === 'number' && Number.isFinite(record.count)
          ? Math.max(0, Math.floor(record.count))
          : undefined;
      const avgMs =
        typeof record.avgMs === 'number' && Number.isFinite(record.avgMs)
          ? Math.max(0, Math.round(record.avgMs))
          : undefined;
      const maxMs =
        typeof record.maxMs === 'number' && Number.isFinite(record.maxMs)
          ? Math.max(0, Math.round(record.maxMs))
          : undefined;
      return {
        stage,
        totalMs,
        ...(count !== undefined ? { count } : {}),
        ...(avgMs !== undefined ? { avgMs } : {}),
        ...(maxMs !== undefined ? { maxMs } : {})
      } as HubStageTopEntry;
    })
    .filter((entry): entry is HubStageTopEntry => Boolean(entry));
}

function mergeHubStageTopEntries(
  baseEntries: HubStageTopEntry[],
  appendEntries: HubStageTopEntry[]
): HubStageTopEntry[] {
  if (baseEntries.length === 0) {
    return appendEntries;
  }
  if (appendEntries.length === 0) {
    return baseEntries;
  }
  const merged = new Map<string, HubStageTopEntry>();
  const apply = (entry: HubStageTopEntry): void => {
    const existing = merged.get(entry.stage);
    if (!existing) {
      merged.set(entry.stage, { ...entry });
      return;
    }
    const totalMs = Math.max(0, Math.round((existing.totalMs ?? 0) + (entry.totalMs ?? 0)));
    const count = Math.max(0, Math.round((existing.count ?? 0) + (entry.count ?? 0)));
    const maxMs = Math.max(existing.maxMs ?? 0, entry.maxMs ?? 0, entry.totalMs ?? 0);
    merged.set(entry.stage, {
      stage: entry.stage,
      totalMs,
      ...(count > 0 ? { count } : {}),
      ...(count > 0 ? { avgMs: Math.max(0, Math.round(totalMs / count)) } : {}),
      ...(maxMs > 0 ? { maxMs } : {})
    });
  };
  for (const item of baseEntries) {
    apply(item);
  }
  for (const item of appendEntries) {
    apply(item);
  }
  return Array.from(merged.values()).sort((a, b) => b.totalMs - a.totalMs);
}

function attachHubStageTopToContext(context: AdapterContext, requestId: string): void {
  if (!requestId || requestId === 'unknown') {
    return;
  }
  const latest = normalizeHubStageTopEntries(peekHubStageTopSummary(requestId, { topN: 12, minMs: 1 }));
  if (latest.length === 0) {
    return;
  }
  const contextRecord = context as Record<string, unknown>;
  const rt =
    contextRecord.__rt && typeof contextRecord.__rt === 'object' && !Array.isArray(contextRecord.__rt)
      ? (contextRecord.__rt as Record<string, unknown>)
      : {};
  const existing = normalizeHubStageTopEntries(rt.hubStageTop);
  const merged = mergeHubStageTopEntries(existing, latest);
  contextRecord.__rt = {
    ...rt,
    hubStageTop: merged
  };
}

function runProviderResponseRustHubPipeline(options: ProviderResponseConversionOptions): {
  payload?: JsonObject;
  effectPlan: { effects: Array<Record<string, unknown>> };
  runtimeEffects: ProviderResponseRuntimeEffectPlan;
  diagnostics: Array<Record<string, unknown>>;
} {
  const nativeResponsePlan = executeHubPipelineWithNative({
    config: {},
    request: {
      requestId: options.context.requestId || 'unknown',
      endpoint: options.entryEndpoint,
      entryEndpoint: options.entryEndpoint,
      providerProtocol: options.providerProtocol,
      payload: options.providerResponse,
      metadata: {
        ...options.context,
        clientProtocol: resolveProviderResponseContextSignals(options.context, options.entryEndpoint).clientProtocol,
        entryEndpoint: options.entryEndpoint,
        stream: options.wantsStream,
        runtimeEffects: {
          providerInvoker: Boolean(options.providerInvoker),
          reenterPipeline: Boolean(options.reenterPipeline),
          clientInjectDispatch: Boolean(options.clientInjectDispatch)
        }
      },
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

function throwServertoolRuntimeErrorDescriptor(descriptor: ProviderResponseServertoolRuntimeErrorDescriptor): never {
  throw new ProviderProtocolError(descriptor.message, {
    code: descriptor.code as ProviderProtocolErrorCode,
    category: descriptor.category,
    details: descriptor.details
  });
}

function attachRustStopGatewayContextToRuntimeMetadata(args: {
  context: AdapterContext;
  stopGateway?: Record<string, unknown> | null;
}): void {
  if (!args.stopGateway || typeof args.stopGateway !== 'object' || Array.isArray(args.stopGateway)) {
    return;
  }
  const contextRecord = args.context as unknown as Record<string, unknown>;
  const rt =
    contextRecord.__rt && typeof contextRecord.__rt === 'object' && !Array.isArray(contextRecord.__rt)
      ? (contextRecord.__rt as Record<string, unknown>)
      : {};
  contextRecord.__rt = {
    ...rt,
    stopGatewayContext: args.stopGateway
  };
}

async function executeProviderResponseNativeServertoolEffects(args: {
  runtimeEffects: ProviderResponseRuntimeEffectPlan;
  payload: JsonObject;
  requestId: string;
  context: AdapterContext;
  entryEndpoint: string;
  providerProtocol: ProviderProtocol;
  stageRecorder?: StageRecorder;
  providerInvoker?: ProviderInvoker;
  reenterPipeline?: ProviderResponseConversionOptions['reenterPipeline'];
  clientInjectDispatch?: ProviderResponseConversionOptions['clientInjectDispatch'];
}): Promise<HubRespProcessEffectResult> {
  let payload = args.payload;
  let stage: HubRespPayloadStage = 'client_semantic';
  const actionPlan = planProviderResponseServertoolRuntimeActionsWithNative({
    servertoolRuntimeActions: readNativeServertoolRuntimeActionEffects(args.runtimeEffects),
    providerInvoker: Boolean(args.providerInvoker),
    reenterPipeline: Boolean(args.reenterPipeline),
    clientInjectDispatch: Boolean(args.clientInjectDispatch)
  });
  if (actionPlan.error) {
    throwServertoolRuntimeErrorDescriptor(actionPlan.error);
  }
  for (const executionPlan of actionPlan.executionPlans) {
    attachRustStopGatewayContextToRuntimeMetadata({
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
      stageRecorder: args.stageRecorder,
      providerInvoker: args.providerInvoker,
      reenterPipeline: args.reenterPipeline as any,
      clientInjectDispatch: args.clientInjectDispatch as any
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

async function executeProviderResponseNativeRuntimeStateEffect(args: {
  runtimeEffects: ProviderResponseRuntimeEffectPlan;
  context: AdapterContext;
}): Promise<void> {
  const runtimeEffect = readNativeRuntimeStateWriteEffect(args.runtimeEffects);
  if (!runtimeEffect) return;
  finalizeResponsesConversationRequestRetention(args.context.requestId, {
    keepForSubmitToolOutputs: runtimeEffect.keepForSubmitToolOutputs === true
  });
  saveChatProcessSessionActualUsage({
    context: args.context,
    usage: runtimeEffect.usage && typeof runtimeEffect.usage === 'object' && !Array.isArray(runtimeEffect.usage)
      ? runtimeEffect.usage as Record<string, unknown>
      : undefined
  });
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
  providerInvoker?: ProviderInvoker;
  reenterPipeline?: ProviderResponseConversionOptions['reenterPipeline'];
  clientInjectDispatch?: ProviderResponseConversionOptions['clientInjectDispatch'];
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
    stageRecorder: args.stageRecorder,
    providerInvoker: args.providerInvoker,
    reenterPipeline: args.reenterPipeline,
    clientInjectDispatch: args.clientInjectDispatch
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
  await executeProviderResponseNativeRuntimeStateEffect({
    runtimeEffects: args.nativeResponsePlan.runtimeEffects,
    context: args.context
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
    __sse_responses: stream,
    body: hubRespOutbound04ClientSemantic,
    format: streamEffect.codec
  };
}

export interface ProviderResponseConversionOptions {
  providerProtocol: ProviderProtocol;
  providerResponse: JsonObject;
  context: AdapterContext;
  entryEndpoint: string;
  wantsStream: boolean;
  /**
   * Canonical chat semantics from the request-side chat_process output.
   * This is the only allowed carrier for mappable cross-protocol semantics
   * (tool alias maps, client tool schemas, responses resume, etc.).
   *
   * Must not be stuffed into metadata/AdapterContext.
   */
  requestSemantics?: JsonObject;
  stageRecorder?: StageRecorder;
  providerInvoker?: ProviderInvoker;
  /**
   * 可选：由 Host 注入的二次请求入口。Server-side 工具在需要发起
   * followup 请求（例如 web_search 二跳）时，可以通过该回调将构造
   * 好的请求体交给 Host，由 Host 走完整 HubPipeline + VirtualRouter
   * 再返回最终客户端响应形状。
   */
  reenterPipeline?: (options: {
    entryEndpoint: string;
    requestId: string;
    body?: JsonObject;
    metadata?: JsonObject;
  }) => Promise<ProviderResponseConversionResult>;
  clientInjectDispatch?: (options: {
    entryEndpoint: string;
    requestId: string;
    body?: JsonObject;
    metadata?: JsonObject;
  }) => Promise<{ ok: boolean; reason?: string }>;
}

export interface ProviderResponseConversionResult {
  body?: JsonObject;
  __sse_responses?: Readable;
  format?: string;
}

export async function materializeProviderResponseSsePayload(
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
  const direct = record.__sse_responses ?? record.__sse_stream;
  if (direct && typeof (direct as { pipe?: unknown }).pipe === 'function') {
    return direct as Readable;
  }
  const data = record.data;
  if (data && typeof data === 'object' && !Array.isArray(data)) {
    const nested = data as Record<string, unknown>;
    const nestedStream = nested.__sse_responses ?? nested.__sse_stream;
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
  const nativeOptions = {
    ...options,
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
    providerProtocol: options.providerProtocol,
    stageRecorder: options.stageRecorder,
    providerInvoker: options.providerInvoker,
    reenterPipeline: options.reenterPipeline,
    clientInjectDispatch: options.clientInjectDispatch
  });
}
