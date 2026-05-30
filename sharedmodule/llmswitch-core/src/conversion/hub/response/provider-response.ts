import { Readable } from 'node:stream';
import { defaultSseCodecRegistry, type SseProtocol } from '../../../sse/index.js';
import type { AdapterContext } from '../types/chat-envelope.js';
import type { JsonObject } from '../types/json.js';
import type { StageRecorder } from '../format-adapters/index.js';
import { recordStage } from '../pipeline/stages/utils.js';
import { ProviderProtocolError } from '../../provider-protocol-error.js';
import { executeHubPipelineWithNative } from '../../../router/virtual-router/engine-selection/native-hub-pipeline-orchestration-semantics-protocol.js';
import {
  logHubStageTiming,
  peekHubStageTopSummary
} from '../pipeline/hub-stage-timing.js';
import {
  finalizeResponsesConversationRequestRetention,
  recordResponsesResponse,
} from '../../shared/responses-conversation-store.js';
import type { ProviderInvoker } from '../../../servertool/types.js';
import { saveChatProcessSessionActualUsage } from '../process/chat-process-session-usage.js';
import {
  maybeCommitClockReservationFromContext,
  resolveProviderResponseContextSignals,
  type ProviderProtocol
} from './provider-response-helpers.js';

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
    diagnostics: nativeResponsePlan.diagnostics
  };
}

function readNativeStreamPipeEffect(effectPlan: { effects: Array<Record<string, unknown>> }): {
  codec: SseProtocol;
  requestId: string;
  payload: JsonObject;
} | null {
  const streamEffects = effectPlan.effects.filter((effect) => effect?.kind === 'streamPipe');
  if (streamEffects.length === 0) return null;
  if (streamEffects.length !== 1) throw new Error('Rust HubPipeline response effect plan returned duplicate streamPipe effects');
  const effect = streamEffects[0];
  const payload = effect.payload;
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new Error('Rust HubPipeline streamPipe effect missing payload');
  }
  const record = payload as Record<string, unknown>;
  const codec = record.codec;
  const requestId = record.requestId;
  const streamPayload = record.payload;
  if (
    codec !== 'openai-chat'
    && codec !== 'openai-responses'
    && codec !== 'anthropic-messages'
    && codec !== 'gemini-chat'
  ) {
    throw new Error('Rust HubPipeline streamPipe effect returned unsupported codec');
  }
  if (typeof requestId !== 'string' || !requestId.trim()) {
    throw new Error('Rust HubPipeline streamPipe effect missing requestId');
  }
  if (!streamPayload || typeof streamPayload !== 'object' || Array.isArray(streamPayload)) {
    throw new Error('Rust HubPipeline streamPipe effect missing stream payload');
  }
  return {
    codec,
    requestId,
    payload: streamPayload as JsonObject
  };
}

function assertKnownNativeResponseEffectKinds(effectPlan: { effects: Array<Record<string, unknown>> }): void {
  for (const effect of effectPlan.effects) {
    if (effect?.kind === 'streamPipe' || effect?.kind === 'runtimeStateWrite' || effect?.kind === 'servertoolRuntimeAction') continue;
    throw new Error('Rust HubPipeline response effect plan returned unsupported effect kind');
  }
}

function readNativeServertoolRuntimeActionEffects(effectPlan: { effects: Array<Record<string, unknown>> }): Array<Record<string, unknown>> {
  return effectPlan.effects
    .filter((effect) => effect?.kind === 'servertoolRuntimeAction')
    .map((effect) => {
      const payload = effect.payload;
      if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
        throw new Error('Rust HubPipeline servertoolRuntimeAction effect missing payload');
      }
      return payload as Record<string, unknown>;
    });
}

async function executeProviderResponseNativeServertoolEffects(args: {
  effectPlan: { effects: Array<Record<string, unknown>> };
}): Promise<void> {
  for (const effect of readNativeServertoolRuntimeActionEffects(args.effectPlan)) {
    if (effect.action === 'requireReenterPipeline') {
      throw new ProviderProtocolError('[servertool] followup requires reenter pipeline', {
        code: 'SERVERTOOL_FOLLOWUP_FAILED',
        category: 'INTERNAL_ERROR',
        details: {
          requestId: typeof effect.requestId === 'string' ? effect.requestId : undefined,
          reason: typeof effect.reason === 'string' ? effect.reason : 'unknown'
        }
      });
    }
    if (effect.action === 'requireRuntimeExecutor') {
      throw new ProviderProtocolError('Rust HubPipeline servertoolRuntimeAction requires runtime executor', {
        code: 'SERVERTOOL_HANDLER_FAILED',
        category: 'INTERNAL_ERROR',
        details: {
          requestId: typeof effect.requestId === 'string' ? effect.requestId : undefined,
          reason: typeof effect.reason === 'string' ? effect.reason : 'unknown'
        }
      });
    }
    throw new Error('Rust HubPipeline servertoolRuntimeAction returned unsupported action');
  }
}

function readNativeRuntimeStateWriteEffect(effectPlan: { effects: Array<Record<string, unknown>> }): Record<string, unknown> | null {
  const runtimeEffects = effectPlan.effects.filter((effect) => effect?.kind === 'runtimeStateWrite');
  if (runtimeEffects.length === 0) return null;
  if (runtimeEffects.length !== 1) throw new Error('Rust HubPipeline response effect plan returned duplicate runtimeStateWrite effects');
  const payload = runtimeEffects[0]?.payload;
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new Error('Rust HubPipeline runtimeStateWrite effect missing payload');
  }
  return payload as Record<string, unknown>;
}

async function executeProviderResponseNativeRuntimeStateEffect(args: {
  effectPlan: { effects: Array<Record<string, unknown>> };
  context: AdapterContext;
}): Promise<void> {
  const runtimeEffect = readNativeRuntimeStateWriteEffect(args.effectPlan);
  if (!runtimeEffect) return;
  const responseRecord = runtimeEffect.responseRecord;
  if (responseRecord && typeof responseRecord === 'object' && !Array.isArray(responseRecord)) {
    recordResponsesResponse(responseRecord as Parameters<typeof recordResponsesResponse>[0]);
  }
  finalizeResponsesConversationRequestRetention(args.context.requestId, {
    keepForSubmitToolOutputs: runtimeEffect.keepForSubmitToolOutputs === true
  });
  await maybeCommitClockReservationFromContext(args.context);
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
  };
  requestId: string;
  context: AdapterContext;
  stageRecorder?: StageRecorder;
}): Promise<ProviderResponseConversionResult> {
  const clientPayload = args.nativeResponsePlan.payload;
  if (!clientPayload || typeof clientPayload !== 'object') {
    throw new Error('Rust HubPipeline native response payload unavailable');
  }
  assertKnownNativeResponseEffectKinds(args.nativeResponsePlan.effectPlan);
  await executeProviderResponseNativeServertoolEffects({
    effectPlan: args.nativeResponsePlan.effectPlan
  });
  const streamEffect = readNativeStreamPipeEffect(args.nativeResponsePlan.effectPlan);
  await executeProviderResponseNativeRuntimeStateEffect({
    effectPlan: args.nativeResponsePlan.effectPlan,
    context: args.context
  });
  if (!streamEffect) {
    recordStage(args.stageRecorder, 'chat_process.resp.stage9.client_remap', clientPayload);
    recordStage(args.stageRecorder, 'chat_process.resp.stage10.sse_stream', {
      passthrough: false,
      protocol: 'native-effect-plan',
      payload: clientPayload
    });
    return { body: clientPayload };
  }
  const codec = defaultSseCodecRegistry.get(streamEffect.codec);
  logHubStageTiming(args.requestId, 'resp_outbound.stage2_codec_stream', 'start', {
    clientProtocol: streamEffect.codec
  });
  const codecStart = Date.now();
  const stream = await codec.convertJsonToSse(streamEffect.payload, {
    requestId: streamEffect.requestId
  });
  logHubStageTiming(args.requestId, 'resp_outbound.stage2_codec_stream', 'completed', {
    elapsedMs: Date.now() - codecStart,
    clientProtocol: streamEffect.codec
  });
  recordStage(args.stageRecorder, 'chat_process.resp.stage9.client_remap', clientPayload);
  recordStage(args.stageRecorder, 'chat_process.resp.stage10.sse_stream', {
    passthrough: false,
    protocol: streamEffect.codec,
    payload: streamEffect.payload
  });
  return {
    __sse_responses: stream,
    body: clientPayload,
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

export async function convertProviderResponse(
  options: ProviderResponseConversionOptions
): Promise<ProviderResponseConversionResult> {
  const requestId = options.context.requestId || 'unknown';
  const nativeResponsePlan = runProviderResponseRustHubPipeline(options);
  if (!Array.isArray(nativeResponsePlan.effectPlan.effects)) {
    throw new Error('Rust HubPipeline response native effect plan unavailable');
  }
  (options.context as Record<string, unknown>).__nativeResponsePlan = nativeResponsePlan;
  return executeProviderResponseNativeOutboundEffects({
    nativeResponsePlan,
    requestId,
    context: options.context,
    stageRecorder: options.stageRecorder
  });
}
