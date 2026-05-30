import { Readable } from 'node:stream';
import { defaultSseCodecRegistry, type SseProtocol } from '../../../sse/index.js';
import type { AdapterContext } from '../types/chat-envelope.js';
import type { JsonObject } from '../types/json.js';
import type { StageRecorder } from '../format-adapters/index.js';
import { recordStage } from '../pipeline/stages/utils.js';
import { ChatFormatAdapter } from '../format-adapters/chat-format-adapter.js';
import { ResponsesFormatAdapter } from '../format-adapters/responses-format-adapter.js';
import { AnthropicFormatAdapter } from '../format-adapters/anthropic-format-adapter.js';
import { GeminiFormatAdapter } from '../format-adapters/gemini-format-adapter.js';
import {
  OpenAIChatResponseMapper,
  ResponsesResponseMapper,
  AnthropicResponseMapper,
  GeminiResponseMapper
} from './response-mappers.js';
import type { ResponseMapper, ChatCompletionLike } from './response-mappers.js';
import { ProviderProtocolError } from '../../provider-protocol-error.js';
import {
  runRespInboundStage1SseDecode
} from '../pipeline/stages/resp_inbound/resp_inbound_stage1_sse_decode/index.js';
import {
  runRespInboundStage2FormatParse
} from '../pipeline/stages/resp_inbound/resp_inbound_stage2_format_parse/index.js';
import {
  runRespInboundStage3SemanticMap
} from '../pipeline/stages/resp_inbound/resp_inbound_stage3_semantic_map/index.js';
import {
  runRespInboundStageCompatResponse
} from '../pipeline/stages/req_outbound/req_outbound_stage3_compat/index.js';
import {
  runRespProcessStage1ToolGovernance
} from '../pipeline/stages/resp_process/resp_process_stage1_tool_governance/index.js';
import {
  runRespProcessStage2Finalize
} from '../pipeline/stages/resp_process/resp_process_stage2_finalize/index.js';
import {
  runRespProcessStage3ServerToolOrchestration
} from '../pipeline/stages/resp_process/resp_process_stage3_servertool_orchestration/index.js';
import {
  runRespOutboundStage1ClientRemap
} from '../pipeline/stages/resp_outbound/resp_outbound_stage1_client_remap/index.js';
import {
  runRespOutboundStage2SseStream
} from '../pipeline/stages/resp_outbound/resp_outbound_stage2_sse_stream/index.js';
import { executeHubPipelineWithNative } from '../../../router/virtual-router/engine-selection/native-hub-pipeline-orchestration-semantics-protocol.js';
import { applyResponseBlacklistWithNative } from '../../../router/virtual-router/engine-selection/native-compat-action-semantics.js';
import {
  hasNewGovernedServerToolCallsWithNative,
  responsesPayloadRequiresSubmitToolOutputsWithNative
} from '../../../router/virtual-router/engine-selection/native-hub-pipeline-semantic-mappers.js';
import {
  measureHubStage,
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
  normalizeClientPayloadToCanonicalChatCompletionOrThrow,
  maybeCommitClockReservationFromContext,
  resolveProviderResponseContextSignals,
  type ClientProtocol as ResponseClientProtocol,
  type ProviderProtocol
} from './provider-response-helpers.js';
import {
  recordPolicyObservationSafely,
  recordToolSurfaceShadowMismatch
} from './provider-response-observation.js';
import { isRegisteredServerToolName } from '../../../servertool/registry.js';
import { inspectStopGatewaySignalWithNative } from '../../../router/virtual-router/engine-selection/native-servertool-core-semantics.js';

type ProviderResponsePlan = {
  createFormatAdapter: () => ChatFormatAdapter | ResponsesFormatAdapter | AnthropicFormatAdapter | GeminiFormatAdapter;
  createMapper: () => ResponseMapper;
};

type HubStageTopEntry = {
  stage: string;
  totalMs: number;
  count?: number;
  avgMs?: number;
  maxMs?: number;
};

const PROVIDER_RESPONSE_REGISTRY: Record<ProviderProtocol, ProviderResponsePlan> = {
  'openai-chat': {
    createFormatAdapter: () => new ChatFormatAdapter(),
    createMapper: () => new OpenAIChatResponseMapper()
  },
  'openai-responses': {
    createFormatAdapter: () => new ResponsesFormatAdapter(),
    createMapper: () => new ResponsesResponseMapper()
  },
  'anthropic-messages': {
    createFormatAdapter: () => new AnthropicFormatAdapter(),
    createMapper: () => new AnthropicResponseMapper()
  },
  'gemini-chat': {
    createFormatAdapter: () => new GeminiFormatAdapter(),
    createMapper: () => new GeminiResponseMapper()
  }
};

const INTERNAL_POLICY_DEBUG_BLACKLIST_PATHS = [
  '_transformed',
  '_originalFormat',
  '_targetFormat',
  '__responses_output_text_meta',
  '__responses_reasoning',
  '__responses_payload_snapshot',
  '__responses_passthrough',
  'anthropicToolNameMap'
] as const;

function readContextString(context: AdapterContext, key: string): string | undefined {
  const value = (context as Record<string, unknown>)[key];
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function readContextNumber(context: AdapterContext, key: string): number | undefined {
  const value = (context as Record<string, unknown>)[key];
  return typeof value === 'number' && Number.isFinite(value) ? Math.floor(value) : undefined;
}

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

function hasNewGovernedServerToolCalls(beforePayload: unknown, afterPayload: unknown): boolean {
  return hasNewGovernedServerToolCallsWithNative(beforePayload, afterPayload);
}

function responsesPayloadRequiresSubmitToolOutputs(payload: unknown): boolean {
  return responsesPayloadRequiresSubmitToolOutputsWithNative(payload);
}

function shouldRunProviderResponseRustHubPipeline(options: ProviderResponseConversionOptions): boolean {
  if (options.providerInvoker || options.reenterPipeline || options.clientInjectDispatch) {
    const stopGateway = inspectStopGatewaySignalWithNative(options.providerResponse);
    if (!stopGateway.observed) {
      return false;
    }
  }
  return true;
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
    throw new Error(`${code}: ${message}`);
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
  const nativeResponsePlan = shouldRunProviderResponseRustHubPipeline(options)
    ? runProviderResponseRustHubPipeline(options)
    : null;
  if (nativeResponsePlan && !Array.isArray(nativeResponsePlan.effectPlan.effects)) {
    throw new Error('Rust HubPipeline response native effect plan unavailable');
  }
  if (nativeResponsePlan) {
    (options.context as Record<string, unknown>).__nativeResponsePlan = nativeResponsePlan;
    return executeProviderResponseNativeOutboundEffects({
      nativeResponsePlan,
      requestId,
      context: options.context,
      stageRecorder: options.stageRecorder
    });
  }
  const contextSignals = resolveProviderResponseContextSignals(options.context, options.entryEndpoint);
  const isFollowup = contextSignals.isFollowup;
  // ServerTool followups are internal hops. They must return canonical OpenAI-chat-like payloads
  // to re-enter the hub chat process deterministically (tools harvesting, governance, etc.).
  // Client protocol remapping happens only on the outermost request.
  const clientProtocol: ResponseClientProtocol = contextSignals.clientProtocol;
  const toolSurfaceShadowEnabled = contextSignals.toolSurfaceShadowEnabled;
  // 对于由 server-side 工具触发的内部跳转（二跳/三跳），统一禁用 SSE 聚合输出，
  // 始终返回完整的 ChatCompletion JSON，便于在 llms 内部直接解析，而不是拿到
  // __sse_responses 可读流。
  const wantsStream = isFollowup ? false : options.wantsStream;

  const displayModel = contextSignals.displayModel;
  const clientFacingRequestId = contextSignals.clientFacingRequestId;
  const plan = PROVIDER_RESPONSE_REGISTRY[options.providerProtocol];
  if (!plan) {
    throw new Error(`Unknown provider protocol: ${options.providerProtocol}`);
  }


  const inboundStage1 = await measureHubStage(
    requestId,
    'resp_inbound.stage1_sse_decode',
    () => runRespInboundStage1SseDecode({
      providerProtocol: options.providerProtocol,
      payload: options.providerResponse,
      adapterContext: options.context,
      wantsStream,
      stageRecorder: options.stageRecorder
    }),
    {
      mapCompletedDetails: (value) => ({
        decodedFromSse: value.decodedFromSse,
        wantsStream,
        providerProtocol: options.providerProtocol
      })
    }
  );

  // Hard order guarantee: provider -> compat -> inbound(parse/map) -> chat_process -> outbound -> client.
  // Transport-level SSE decode stays before compat to materialize a JSON provider payload.
  const compatPayload = await measureHubStage(
    requestId,
    'resp_inbound.stage1_compat',
    () => runRespInboundStageCompatResponse({
      payload: inboundStage1.payload,
      adapterContext: options.context,
      stageRecorder: options.stageRecorder
    }),
    {
      mapCompletedDetails: () => ({
        providerProtocol: options.providerProtocol
      })
    }
  );
  const compatPayloadSanitized = applyResponseBlacklistWithNative(
    compatPayload as Record<string, unknown>,
    {
      paths: [...INTERNAL_POLICY_DEBUG_BLACKLIST_PATHS]
    }
  ) as JsonObject;

  const mapper = plan.createMapper();
  const formatEnvelope = await measureHubStage(
    requestId,
    'resp_inbound.stage2_format_parse',
    () => runRespInboundStage2FormatParse({
      adapterContext: options.context,
      payload: compatPayloadSanitized,
      stageRecorder: options.stageRecorder
    }),
    {
      mapCompletedDetails: (value) => ({
        protocol: value.protocol,
        direction: value.direction,
        providerProtocol: options.providerProtocol
      })
    }
  );

  // Phase 2 (shadow): response tool surface mismatch detection (provider inbound).
  // Only records diffs; does not rewrite payload.
  recordToolSurfaceShadowMismatch({
    enabled: toolSurfaceShadowEnabled,
    stageRecorder: options.stageRecorder,
    stageName: 'hub_toolsurface.shadow.provider_inbound',
    expectedProtocol: options.providerProtocol,
    payload: formatEnvelope.payload as JsonObject
  });

  // Phase 0/1: observe provider inbound payload violations (best-effort; no rewrites here).
  recordPolicyObservationSafely({
    phase: 'provider_inbound',
    providerProtocol: options.providerProtocol,
    payload: formatEnvelope.payload as JsonObject,
    stageRecorder: options.stageRecorder,
    requestId: options.context.requestId
  });

  const chatResponse = await measureHubStage(
    requestId,
    'resp_inbound.stage3_semantic_map',
    () => runRespInboundStage3SemanticMap({
      adapterContext: options.context,
      formatEnvelope,
      mapper,
      requestSemantics: options.requestSemantics,
      stageRecorder: options.stageRecorder
    }),
    {
      mapCompletedDetails: (value) => ({
        hasChoices: Array.isArray((value as any)?.choices),
        providerProtocol: options.providerProtocol
      })
    }
  );
  // 记录语义映射后的 ChatCompletion，便于回放 server-side 工具流程。
  recordStage(options.stageRecorder, 'chat_process.resp.stage4.semantic_map_to_chat.chat', chatResponse);

  // 检查是否需要进行 ServerTool 编排
  // 使用新的 ChatEnvelope 级别的 servertool 实现
  const orchestration = await measureHubStage(
    requestId,
    'resp_process.stage3_servertool_orchestration',
    () => runRespProcessStage3ServerToolOrchestration({
      payload: chatResponse as ChatCompletionLike,
      adapterContext: options.context,
      requestId: options.context.requestId,
      entryEndpoint: options.entryEndpoint,
      providerProtocol: options.providerProtocol,
      stageRecorder: options.stageRecorder,
      providerInvoker: options.providerInvoker,
      reenterPipeline: options.reenterPipeline,
      clientInjectDispatch: options.clientInjectDispatch
    }),
    {
      mapCompletedDetails: (value) => ({
        executed: value.executed,
        flowId: value.flowId,
        skipReason: value.skipReason
      })
    }
  );
  let effectiveChatResponse: ChatCompletionLike = orchestration.payload;

  // Hard gate: response-side chat_process requires an OpenAI-chat-like surface (choices[].message).
  // ServerTool followups must never replace the canonical chat completion with a client-protocol shape.
  effectiveChatResponse = await normalizeClientPayloadToCanonicalChatCompletionOrThrow({
    payload: effectiveChatResponse as ChatCompletionLike,
    scope: 'chat_process.response.entry',
    context: options.context,
    requestSemantics: options.requestSemantics,
    registry: PROVIDER_RESPONSE_REGISTRY
  });

  // 如果没有执行 servertool，继续原来的处理流程
  const governanceResult = await measureHubStage(
    requestId,
    'resp_process.stage1_tool_governance',
    () => runRespProcessStage1ToolGovernance({
      payload: effectiveChatResponse as JsonObject,
      entryEndpoint: options.entryEndpoint,
      requestId: options.context.requestId,
      clientProtocol,
      requestSemantics: options.requestSemantics,
      adapterContext: options.context as unknown as Record<string, unknown>,
      stageRecorder: options.stageRecorder
    }),
    {
      mapCompletedDetails: (value) => ({
        clientProtocol,
        hasPayload: Boolean(value.governedPayload)
      })
    }
  );

  const shouldRunFollowupPostGovernanceServertool =
    isFollowup && hasNewGovernedServerToolCalls(effectiveChatResponse, governanceResult.governedPayload);

  const followupServertoolResult = shouldRunFollowupPostGovernanceServertool
    ? await measureHubStage(
      requestId,
      'resp_process.stage3_servertool_orchestration.post_governance',
      () => runRespProcessStage3ServerToolOrchestration({
        payload: governanceResult.governedPayload as ChatCompletionLike,
        adapterContext: options.context,
        requestId: options.context.requestId,
        entryEndpoint: options.entryEndpoint,
        providerProtocol: options.providerProtocol,
        allowFollowup: true,
        stageRecorder: options.stageRecorder,
        providerInvoker: options.providerInvoker,
        reenterPipeline: options.reenterPipeline,
        clientInjectDispatch: options.clientInjectDispatch
      }),
      {
        mapCompletedDetails: (value) => ({
          executed: value.executed,
          flowId: value.flowId
        })
      }
    )
    : null;
  const finalizedInputPayload =
    followupServertoolResult?.payload && typeof followupServertoolResult.payload === 'object'
      ? (followupServertoolResult.payload as JsonObject)
      : governanceResult.governedPayload;

  const finalizeResult = await measureHubStage(
    requestId,
    'resp_process.stage2_finalize',
    () => runRespProcessStage2Finalize({
      payload: finalizedInputPayload,
      originalPayload: effectiveChatResponse as JsonObject,
      entryEndpoint: options.entryEndpoint,
      requestId: options.context.requestId,
      wantsStream,
      reasoningMode: 'keep',
      stageRecorder: options.stageRecorder
    }),
    {
      mapCompletedDetails: (value) => ({
        wantsStream,
        hasProcessedRequest: Boolean(value.processedRequest),
        model: typeof value.finalizedPayload?.model === 'string' ? value.finalizedPayload.model : undefined
      })
    }
  );
  if (displayModel && finalizeResult.finalizedPayload && typeof finalizeResult.finalizedPayload === 'object') {
    try {
      (finalizeResult.finalizedPayload as Record<string, unknown>).model = displayModel;
    } catch {
      // ignore model override failures
    }
  }

  let clientPayload = await measureHubStage(
    requestId,
    'resp_outbound.stage1_client_remap',
    () => runRespOutboundStage1ClientRemap({
      payload: finalizeResult.finalizedPayload,
      clientProtocol,
      requestId: clientFacingRequestId,
      adapterContext: options.context,
      requestSemantics: options.requestSemantics,
      responseSemantics:
        (finalizeResult.processedRequest as { semantics?: JsonObject } | undefined)?.semantics ??
        ((finalizeResult.finalizedPayload as { semantics?: JsonObject } | undefined)?.semantics),
      stageRecorder: options.stageRecorder
    }),
    {
      mapCompletedDetails: () => ({
        clientProtocol
      })
    }
  );
  if (displayModel && clientPayload && typeof clientPayload === 'object') {
    try {
      (clientPayload as Record<string, unknown>).model = displayModel;
    } catch {
      // ignore model override failures
    }
  }
  clientPayload = applyResponseBlacklistWithNative(
    clientPayload as Record<string, unknown>,
    {
      paths: [...INTERNAL_POLICY_DEBUG_BLACKLIST_PATHS]
    }
  ) as JsonObject;
  if (clientProtocol === 'openai-responses') {
    try {
      recordResponsesResponse({
        requestId: options.context.requestId,
        response: clientPayload,
        sessionId: readContextString(options.context, 'sessionId'),
        conversationId: readContextString(options.context, 'conversationId'),
        providerKey:
          readContextString(options.context, 'providerKey')
          ?? readContextString(options.context, 'targetProviderKey'),
        matchedPort: readContextNumber(options.context, 'matchedPort'),
        routingPolicyGroup: readContextString(options.context, 'routingPolicyGroup'),
      });
    } catch (error) {
      if (error instanceof ProviderProtocolError) {
        throw error;
      }
      // ignore non-contract conversation capture errors
    }
  }

  // Retain only the minimum conversation state required for future followups.
  // - unscoped plain responses: clear immediately
  // - scoped responses: keep slim payload for auto-continuation
  // - submit_tool_outputs flows: preserve responseId path
  finalizeResponsesConversationRequestRetention(options.context.requestId, {
    keepForSubmitToolOutputs: responsesPayloadRequiresSubmitToolOutputs(clientPayload)
  });

  // Phase 2 (shadow): response tool surface mismatch detection (client outbound).
  recordToolSurfaceShadowMismatch({
    enabled: toolSurfaceShadowEnabled,
    stageRecorder: options.stageRecorder,
    stageName: 'hub_toolsurface.shadow.client_outbound',
    expectedProtocol: clientProtocol,
    payload: clientPayload as JsonObject
  });

  // Phase 0/1: observe client outbound payload violations (best-effort; no rewrites here).
  recordPolicyObservationSafely({
    phase: 'client_outbound',
    providerProtocol: clientProtocol,
    payload: clientPayload as JsonObject,
    stageRecorder: options.stageRecorder,
    requestId: options.context.requestId
  });

  const outbound = await measureHubStage(
    requestId,
    'resp_outbound.stage2_sse_stream',
    () => runRespOutboundStage2SseStream({
      clientPayload,
      clientProtocol,
      requestId: clientFacingRequestId,
      wantsStream,
      stageRecorder: options.stageRecorder
    }),
    {
      mapCompletedDetails: (value) => ({
        wantsStream,
        hasStream: Boolean(value.stream),
        hasBody: Boolean(value.body)
      })
    }
  );

  attachHubStageTopToContext(options.context, requestId);

  // Commit scheduled-task delivery only after a successful client payload/stream is prepared.
  await maybeCommitClockReservationFromContext(options.context);
  try {
    const usage =
      clientPayload && typeof clientPayload === 'object' && !Array.isArray(clientPayload)
        ? ((clientPayload as JsonObject).usage as Record<string, unknown> | undefined)
        : undefined;
    saveChatProcessSessionActualUsage({
      context: options.context,
      usage
    });
  } catch {
    // best-effort: usage persistence must not break response delivery
  }

  if (outbound.stream) {
    return {
      __sse_responses: outbound.stream,
      body: clientPayload,
      format: clientProtocol
    };
  }
  return { body: clientPayload, format: clientProtocol };
}
