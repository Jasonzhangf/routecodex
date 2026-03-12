import { Readable } from 'node:stream';
import type { ChatReasoningMode } from '../../shared/openai-finalizer.js';
import type { SseProtocol } from '../../../sse/registry/sse-codec-registry.js';
import type { AdapterContext } from '../types/chat-envelope.js';
import type { JsonObject } from '../types/json.js';
import type { StageRecorder } from '../format-adapters/index.js';
import { recordStage } from '../pipeline/stages/utils.js';
import { recordHubPolicyObservation } from '../policy/policy-engine.js';
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
import { measureHubStage } from '../pipeline/hub-stage-timing.js';
import { recordResponsesResponse } from '../../shared/responses-conversation-store.js';
import { ProviderProtocolError } from '../../provider-protocol-error.js';
import { readRuntimeMetadata } from '../../runtime-metadata.js';
import type { ProviderInvoker } from '../../../servertool/types.js';
import { commitClockReservation, resolveClockConfig } from '../../../servertool/clock/task-store.js';
import { detectProviderResponseShapeWithNative } from '../../../router/virtual-router/engine-selection/native-chat-process-servertool-orchestration-semantics.js';
import { saveChatProcessSessionActualUsage } from '../process/chat-process-session-usage.js';

type ProviderProtocol = 'openai-chat' | 'openai-responses' | 'anthropic-messages' | 'gemini-chat';
type ClientProtocol = 'openai-chat' | 'openai-responses' | 'anthropic-messages';

type ProviderResponsePlan = {
  createFormatAdapter: () => ChatFormatAdapter | ResponsesFormatAdapter | AnthropicFormatAdapter | GeminiFormatAdapter;
  createMapper: () => ResponseMapper;
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
    body: JsonObject;
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

function isServerToolFollowup(context: AdapterContext): boolean {
  const rt = readRuntimeMetadata(context as unknown as Record<string, unknown>);
  const raw = (rt as any)?.serverToolFollowup;
  if (raw === true) {
    return true;
  }
  if (typeof raw === 'string') {
    const v = raw.trim().toLowerCase();
    return v === '1' || v === 'true';
  }
  return false;
}

function resolveClientProtocol(entryEndpoint: string): ClientProtocol {
  const lowered = (entryEndpoint || '').toLowerCase();
  if (lowered.includes('/v1/responses')) return 'openai-responses';
  if (lowered.includes('/v1/messages')) return 'anthropic-messages';
  return 'openai-chat';
}

function isToolSurfaceShadowEnabled(): boolean {
  const raw = String(process.env.ROUTECODEX_HUB_TOOL_SURFACE_MODE || '').trim().toLowerCase();
  if (!raw) return false;
  if (raw === 'off' || raw === '0' || raw === 'false') return false;
  return raw === 'observe' || raw === 'shadow' || raw === 'enforce';
}

function isJsonRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

type ClockReservationLike = {
  reservationId?: unknown;
  sessionId?: unknown;
  taskIds?: unknown;
  reservedAtMs?: unknown;
};

function coerceClockReservation(value: unknown): {
  reservationId: string;
  sessionId: string;
  taskIds: string[];
  reservedAtMs: number;
} | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }
  const rec = value as ClockReservationLike;
  const reservationId = typeof rec.reservationId === 'string' ? rec.reservationId.trim() : '';
  const sessionId = typeof rec.sessionId === 'string' ? rec.sessionId.trim() : '';
  const taskIdsRaw = Array.isArray(rec.taskIds) ? rec.taskIds : [];
  const taskIds = taskIdsRaw
    .filter((t) => typeof t === 'string' && t.trim().length)
    .map((t) => String(t).trim());
  const reservedAtMs =
    typeof rec.reservedAtMs === 'number' && Number.isFinite(rec.reservedAtMs)
      ? Math.floor(rec.reservedAtMs)
      : Date.now();
  if (!reservationId || !sessionId || taskIds.length === 0) {
    return null;
  }
  return { reservationId, sessionId, taskIds, reservedAtMs };
}

async function maybeCommitClockReservationFromContext(context: AdapterContext): Promise<void> {
  try {
    const rt = readRuntimeMetadata(context as unknown as Record<string, unknown>);
    const clockConfig = resolveClockConfig((rt as any)?.clock);
    if (!clockConfig) {
      return;
    }
    const reservation = coerceClockReservation((context as any).__clockReservation);
    if (!reservation) {
      return;
    }
    await commitClockReservation(reservation as any, clockConfig);
  } catch {
    // best-effort: never break response conversion due to clock persistence errors
  }
}

function inferProviderTypeFromProtocol(protocol?: string): string | undefined {
  const p = typeof protocol === 'string' ? protocol.trim().toLowerCase() : '';
  if (!p) return undefined;
  if (p === 'openai-chat') return 'openai';
  if (p === 'openai-responses') return 'responses';
  if (p === 'anthropic-messages') return 'anthropic';
  if (p === 'gemini-chat') return 'gemini';
  return undefined;
}

function isCanonicalChatCompletion(payload: unknown): payload is ChatCompletionLike {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return false;
  }
  const obj = payload as any;
  const choices = Array.isArray(obj.choices) ? obj.choices : [];
  if (!choices.length) return false;
  const first = choices[0] && typeof choices[0] === 'object' && !Array.isArray(choices[0]) ? choices[0] : null;
  if (!first) return false;
  const msg = (first as any).message;
  return Boolean(msg && typeof msg === 'object' && !Array.isArray(msg));
}

async function coerceClientPayloadToCanonicalChatCompletionOrThrow(options: {
  payload: ChatCompletionLike;
  adapterContext: AdapterContext;
  requestSemantics?: JsonObject;
  scope: string;
}): Promise<ChatCompletionLike> {
  if (isCanonicalChatCompletion(options.payload)) {
    return options.payload;
  }
  const detected = detectProviderResponseShapeWithNative(options.payload);
  if (detected === 'unknown') {
    const protocol = options.adapterContext?.providerProtocol;
    throw new ProviderProtocolError(`[hub_response] Non-canonical response payload at ${options.scope}`, {
      code: 'MALFORMED_RESPONSE',
      protocol,
      providerType: inferProviderTypeFromProtocol(protocol),
      details: {
        detected,
        payloadType: typeof (options.payload as any),
        payloadKeys:
          options.payload && typeof options.payload === 'object' && !Array.isArray(options.payload)
            ? Object.keys(options.payload as any).slice(0, 20)
            : undefined
      }
    });
  }
  const plan = PROVIDER_RESPONSE_REGISTRY[detected];
  const mapper = plan.createMapper();
  const coerced = await mapper.toChatCompletion(
    { payload: options.payload } as any,
    options.adapterContext,
    { requestSemantics: options.requestSemantics } as any
  );
  if (isCanonicalChatCompletion(coerced)) {
    return coerced as ChatCompletionLike;
  }
  const protocol = options.adapterContext?.providerProtocol;
  throw new ProviderProtocolError(`[hub_response] Failed to canonicalize response payload at ${options.scope}`, {
    code: 'MALFORMED_RESPONSE',
    protocol,
    providerType: inferProviderTypeFromProtocol(protocol),
    details: { detected }
  });
}

function summarizeToolCallsFromProviderResponse(payload: unknown): { toolCallCount?: number; toolNames?: string[] } {
  try {
    if (!isJsonRecord(payload)) return {};
    const obj: any = payload as any;
    // openai-chat
    if (Array.isArray(obj.choices)) {
      const msg = obj.choices?.[0]?.message;
      const tcs = Array.isArray(msg?.tool_calls) ? msg.tool_calls : [];
      const names = tcs
        .map((tc: any) => String(tc?.function?.name || '').trim())
        .filter((s: string) => s.length)
        .slice(0, 10);
      return { toolCallCount: tcs.length, toolNames: names.length ? names : undefined };
    }
    // openai-responses
    if (Array.isArray(obj.output)) {
      const out = obj.output as any[];
      const fnCalls = out.filter((it) => it && typeof it === 'object' && String(it.type || '').toLowerCase() === 'function_call');
      const names = fnCalls
        .map((it) => String(it?.name || '').trim())
        .filter((s) => s.length)
        .slice(0, 10);
      return { toolCallCount: fnCalls.length, toolNames: names.length ? names : undefined };
    }
    // anthropic-messages
    if (Array.isArray(obj.content)) {
      const blocks = obj.content as any[];
      const uses = blocks.filter((b) => b && typeof b === 'object' && String(b.type || '').toLowerCase() === 'tool_use');
      const names = uses
        .map((b) => String(b?.name || '').trim())
        .filter((s) => s.length)
        .slice(0, 10);
      return { toolCallCount: uses.length, toolNames: names.length ? names : undefined };
    }
    return {};
  } catch {
    return {};
  }
}

function stripInternalPolicyDebugFields(payload: JsonObject): void {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return;
  }
  const target = payload as unknown as Record<string, unknown>;
  // These are internal debug/transport markers that must not leak across hub boundaries.
  // They also break hub policy allowlists (Phase 0/1 observation) and confuse tool-surface detection.
  delete (target as any)._transformed;
  delete (target as any)._originalFormat;
  delete (target as any)._targetFormat;
  delete (target as any).__responses_output_text_meta;
  delete (target as any).__responses_reasoning;
  delete (target as any).__responses_payload_snapshot;
  delete (target as any).__responses_passthrough;
  delete (target as any).anthropicToolNameMap;
}

function supportsSseProtocol(protocol: ProviderProtocol | ClientProtocol): protocol is SseProtocol {
  return protocol === 'openai-chat' || protocol === 'openai-responses' || protocol === 'anthropic-messages' || protocol === 'gemini-chat';
}

function extractDisplayModel(context: AdapterContext): string | undefined {
  const candidates = [
    context.originalModelId,
    context.clientModelId,
    context.modelId
  ];
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.trim()) {
      return candidate.trim();
    }
  }
  return undefined;
}

function extractClientFacingRequestId(context: AdapterContext): string | undefined {
  const contextAny = context as unknown as Record<string, unknown>;
  const candidates = [contextAny.clientRequestId, contextAny.groupRequestId, context.requestId];
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.trim()) {
      return candidate.trim();
    }
  }
  return undefined;
}

function applyModelOverride(payload: unknown, model?: string): void {
  if (!model || !payload || typeof payload !== 'object') {
    return;
  }
  try {
    (payload as Record<string, unknown>).model = model;
  } catch {
    /* ignore */
  }
}

function resolveChatReasoningMode(entryEndpoint: string): ChatReasoningMode {
  const lowered = (entryEndpoint || '').toLowerCase();
  if (lowered.includes('/v1/chat/completions')) {
    return 'keep';
  }
  return 'keep';
}

export async function convertProviderResponse(
  options: ProviderResponseConversionOptions
): Promise<ProviderResponseConversionResult> {
  const requestId = options.context.requestId || 'unknown';
  const isFollowup = isServerToolFollowup(options.context);
  // ServerTool followups are internal hops. They must return canonical OpenAI-chat-like payloads
  // to re-enter the hub chat process deterministically (tools harvesting, governance, etc.).
  // Client protocol remapping happens only on the outermost request.
  const clientProtocol: ClientProtocol = isFollowup ? 'openai-chat' : resolveClientProtocol(options.entryEndpoint);
  // 对于由 server-side 工具触发的内部跳转（二跳/三跳），统一禁用 SSE 聚合输出，
  // 始终返回完整的 ChatCompletion JSON，便于在 llms 内部直接解析，而不是拿到
  // __sse_responses 可读流。
  const wantsStream = isFollowup ? false : options.wantsStream;

  const displayModel = extractDisplayModel(options.context);
  const clientFacingRequestId = extractClientFacingRequestId(options.context) ?? options.context.requestId;
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
  stripInternalPolicyDebugFields(compatPayload as JsonObject);

  const mapper = plan.createMapper();
  const formatEnvelope = await measureHubStage(
    requestId,
    'resp_inbound.stage2_format_parse',
    () => runRespInboundStage2FormatParse({
      adapterContext: options.context,
      payload: compatPayload,
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
  try {
    if (options.stageRecorder && isToolSurfaceShadowEnabled()) {
      const detected = detectProviderResponseShapeWithNative(formatEnvelope.payload);
      if (detected !== 'unknown' && detected !== options.providerProtocol) {
        const summary = summarizeToolCallsFromProviderResponse(formatEnvelope.payload);
        options.stageRecorder.record('hub_toolsurface.shadow.provider_inbound', {
          kind: 'provider_inbound',
          expectedProtocol: options.providerProtocol,
          detectedProtocol: detected,
          ...(summary.toolCallCount !== undefined ? { toolCallCount: summary.toolCallCount } : {}),
          ...(summary.toolNames ? { toolNames: summary.toolNames } : {})
        });
      }
    }
  } catch {
    // never break response conversion
  }

  // Phase 0/1: observe provider inbound payload violations (best-effort; no rewrites here).
  try {
    if (formatEnvelope.payload && typeof formatEnvelope.payload === 'object' && !Array.isArray(formatEnvelope.payload)) {
      recordHubPolicyObservation({
        phase: 'provider_inbound',
        providerProtocol: options.providerProtocol,
        payload: formatEnvelope.payload as JsonObject,
        stageRecorder: options.stageRecorder,
        requestId: options.context.requestId
      });
    }
  } catch {
    // never break response conversion
  }

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
  effectiveChatResponse = await coerceClientPayloadToCanonicalChatCompletionOrThrow({
    payload: effectiveChatResponse as ChatCompletionLike,
    adapterContext: options.context,
    requestSemantics: options.requestSemantics,
    scope: 'chat_process.response.entry'
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
      stageRecorder: options.stageRecorder
    }),
    {
      mapCompletedDetails: (value) => ({
        clientProtocol,
        hasPayload: Boolean(value.governedPayload)
      })
    }
  );

  const finalizeResult = await measureHubStage(
    requestId,
    'resp_process.stage2_finalize',
    () => runRespProcessStage2Finalize({
      payload: governanceResult.governedPayload,
      entryEndpoint: options.entryEndpoint,
      requestId: options.context.requestId,
      wantsStream,
      reasoningMode: resolveChatReasoningMode(options.entryEndpoint),
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
  applyModelOverride(finalizeResult.finalizedPayload, displayModel);

  const clientPayload = await measureHubStage(
    requestId,
    'resp_outbound.stage1_client_remap',
    () => runRespOutboundStage1ClientRemap({
      payload: finalizeResult.finalizedPayload,
      clientProtocol,
      requestId: clientFacingRequestId,
      adapterContext: options.context,
      requestSemantics: options.requestSemantics,
      stageRecorder: options.stageRecorder
    }),
    {
      mapCompletedDetails: () => ({
        clientProtocol
      })
    }
  );
  applyModelOverride(clientPayload, displayModel);
  stripInternalPolicyDebugFields(clientPayload as JsonObject);
  if (clientProtocol === 'openai-responses') {
    try {
      recordResponsesResponse({
        requestId: options.context.requestId,
        response: clientPayload
      });
    } catch {
      // ignore conversation capture errors
    }
  }

  // Phase 2 (shadow): response tool surface mismatch detection (client outbound).
  try {
    if (options.stageRecorder && isToolSurfaceShadowEnabled()) {
      const detected = detectProviderResponseShapeWithNative(clientPayload);
      if (detected !== 'unknown' && detected !== clientProtocol) {
        const summary = summarizeToolCallsFromProviderResponse(clientPayload);
        options.stageRecorder.record('hub_toolsurface.shadow.client_outbound', {
          kind: 'client_outbound',
          expectedProtocol: clientProtocol,
          detectedProtocol: detected,
          ...(summary.toolCallCount !== undefined ? { toolCallCount: summary.toolCallCount } : {}),
          ...(summary.toolNames ? { toolNames: summary.toolNames } : {})
        });
      }
    }
  } catch {
    // never break response conversion
  }

  // Phase 0/1: observe client outbound payload violations (best-effort; no rewrites here).
  try {
    if (clientPayload && typeof clientPayload === 'object' && !Array.isArray(clientPayload)) {
      recordHubPolicyObservation({
        phase: 'client_outbound',
        providerProtocol: clientProtocol,
        payload: clientPayload as JsonObject,
        stageRecorder: options.stageRecorder,
        requestId: options.context.requestId
      });
    }
  } catch {
    // never break response conversion
  }

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
    const usage = clientPayload && typeof clientPayload === 'object' && !Array.isArray(clientPayload)
      ? (clientPayload as JsonObject).usage
      : undefined;
    const body =
      usage !== undefined
        ? ({ usage } as JsonObject)
        : undefined;
    return { __sse_responses: outbound.stream, body, format: clientProtocol };
  }
  return { body: clientPayload, format: clientProtocol };
}
