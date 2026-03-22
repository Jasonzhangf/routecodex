import { Readable } from 'node:stream';
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
import { applyResponseBlacklistWithNative } from '../../../router/virtual-router/engine-selection/native-compat-action-semantics.js';
import { measureHubStage } from '../pipeline/hub-stage-timing.js';
import { recordResponsesResponse } from '../../shared/responses-conversation-store.js';
import type { ProviderInvoker } from '../../../servertool/types.js';
import { saveChatProcessSessionActualUsage } from '../process/chat-process-session-usage.js';
import {
  coerceClientPayloadToCanonicalChatCompletionOrThrow,
  maybeCommitClockReservationFromContext,
  resolveProviderResponseContextSignals,
  type ClientProtocol,
  type ProviderProtocol
} from './provider-response-helpers.js';
import {
  recordPolicyObservationSafely,
  recordToolSurfaceShadowMismatch
} from './provider-response-observation.js';

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

export async function convertProviderResponse(
  options: ProviderResponseConversionOptions
): Promise<ProviderResponseConversionResult> {
  const requestId = options.context.requestId || 'unknown';
  const contextSignals = resolveProviderResponseContextSignals(options.context, options.entryEndpoint);
  const isFollowup = contextSignals.isFollowup;
  // ServerTool followups are internal hops. They must return canonical OpenAI-chat-like payloads
  // to re-enter the hub chat process deterministically (tools harvesting, governance, etc.).
  // Client protocol remapping happens only on the outermost request.
  const clientProtocol: ClientProtocol = contextSignals.clientProtocol;
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
  effectiveChatResponse = await coerceClientPayloadToCanonicalChatCompletionOrThrow({
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
      originalPayload: effectiveChatResponse as JsonObject,
      skipServerToolStrip: isFollowup,
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
        response: clientPayload
      });
    } catch {
      // ignore conversation capture errors
    }
  }

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
